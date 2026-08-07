import * as cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { runBw, getBwStatus, unlockVault, getSessionKey } from './bitwardenService';
import { notifyRun } from './notifyService';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.BW_ARCHIVE_CONFIG_PATH ??
  path.join(process.cwd(), 'config', 'bw-archive-config.json');

const RUNS_PATH =
  process.env.BW_ARCHIVE_RUNS_PATH ??
  path.join(process.cwd(), 'config', 'bw-archive-runs.json');

const MAX_RUNS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BwArchiveFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface BwArchiveConfig {
  baseDir: string;
  frequency: BwArchiveFrequency;
  retentionDays: number;
  enabled: boolean;
  /** AES-256-GCM encrypted master password (base64). Empty string = not set. */
  encryptedPassword: string;
  /** Bitwarden account email — required for offline PBKDF2 key derivation. Auto-populated from bw status. */
  accountEmail: string;
}

export interface BwArchiveRun {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'ok' | 'skipped' | 'error';
  message: string;
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Password encryption (AES-256-GCM keyed from AUTH_SECRET)
// ---------------------------------------------------------------------------

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET ?? 'change-me-in-production';
  // SHA-256(secret + domain separator) → 32-byte AES key
  return crypto.createHash('sha256').update(secret).update('bw-archive-v1').digest();
}

export function encryptPassword(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptPassword(encrypted: string): string {
  const key = deriveKey();
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const data = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: BwArchiveConfig = {
  baseDir: '',
  frequency: 'daily',
  retentionDays: 30,
  enabled: false,
  encryptedPassword: '',
  accountEmail: '',
};

export function loadBwArchiveConfig(): BwArchiveConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<BwArchiveConfig> };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

export function saveBwArchiveConfig(config: BwArchiveConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Return config safe for API responses (password field masked). */
export function maskedBwArchiveConfig(config: BwArchiveConfig): BwArchiveConfig & { passwordSet: boolean } {
  return { ...config, encryptedPassword: '', passwordSet: config.encryptedPassword !== '' };
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export function loadBwArchiveRuns(): BwArchiveRun[] {
  try {
    if (fs.existsSync(RUNS_PATH)) {
      return JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8')) as BwArchiveRun[];
    }
  } catch { /* fall through */ }
  return [];
}

function saveBwArchiveRun(run: BwArchiveRun): void {
  const dir = path.dirname(RUNS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const runs = loadBwArchiveRuns();
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2));

  void notifyRun('Bitwarden Archive', {
    status: run.status,
    message: run.message,
    durationMs: run.durationMs,
  });
}

// ---------------------------------------------------------------------------
// Retention pruning
// ---------------------------------------------------------------------------

function pruneOldExports(baseDir: string, retentionDays: number): void {
  if (!baseDir || !fs.existsSync(baseDir)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(baseDir)) {
      if (!entry.startsWith('bw-export-')) continue;
      const fullPath = path.join(baseDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        try { fs.unlinkSync(fullPath); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Export logic
// ---------------------------------------------------------------------------

function frequencyToCron(freq: BwArchiveFrequency): string {
  switch (freq) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return '0 2 * * *';
    case 'weekly':  return '0 2 * * 0';
    case 'monthly': return '0 2 1 * *';
  }
}

function makeExportPath(baseDir: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return path.join(baseDir, `bw-export-${ts}.json`);
}

/**
 * Run a Bitwarden vault export.
 * If the vault is locked and an encrypted password is stored, auto-unlocks first.
 */
export async function runBwExport(): Promise<BwArchiveRun> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const config = loadBwArchiveConfig();

  if (!config.baseDir) {
    const run: BwArchiveRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'error', message: 'baseDir is not configured',
    };
    saveBwArchiveRun(run);
    return run;
  }

  try {
    // Ensure vault is unlocked
    const statusResult = await getBwStatus();

    if (statusResult.status === 'not_installed') {
      const run: BwArchiveRun = {
        id: crypto.randomUUID(), startedAt,
        completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
        status: 'error', message: 'bw CLI is not installed',
      };
      saveBwArchiveRun(run);
      return run;
    }

    if (statusResult.status === 'unauthenticated') {
      const run: BwArchiveRun = {
        id: crypto.randomUUID(), startedAt,
        completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
        status: 'skipped', message: 'Vault is not logged in — log in via the web UI first',
      };
      saveBwArchiveRun(run);
      return run;
    }

    if (!statusResult.sessionActive) {
      // Vault is locked — attempt auto-unlock with stored password
      if (!config.encryptedPassword) {
        const run: BwArchiveRun = {
          id: crypto.randomUUID(), startedAt,
          completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
          status: 'skipped', message: 'Vault is locked and no master password is stored for auto-unlock',
        };
        saveBwArchiveRun(run);
        return run;
      }

      const masterPassword = decryptPassword(config.encryptedPassword);
      await unlockVault(masterPassword);
    }

    // Export
    if (!fs.existsSync(config.baseDir)) fs.mkdirSync(config.baseDir, { recursive: true });
    const outputPath = makeExportPath(config.baseDir);

    const sessionKey = getSessionKey();
    if (!sessionKey) throw new Error('No active session after unlock — export aborted');
    await runBw(['export', '--format', 'encrypted_json', '--output', outputPath], { BW_SESSION: sessionKey });

    pruneOldExports(config.baseDir, config.retentionDays);

    // Persist account email for offline decryption key derivation
    try {
      const latestStatus = await getBwStatus();
      if (latestStatus.userEmail && latestStatus.userEmail !== config.accountEmail) {
        config.accountEmail = latestStatus.userEmail;
        saveBwArchiveConfig(config);
      }
    } catch { /* best-effort; email will be populated on next run */ }

    const run: BwArchiveRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'ok', message: path.basename(outputPath),
      filePath: outputPath,
    };
    saveBwArchiveRun(run);
    return run;

  } catch (err) {
    const run: BwArchiveRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'error', message: err instanceof Error ? err.message : String(err),
    };
    saveBwArchiveRun(run);
    return run;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let _task: cron.ScheduledTask | null = null;

export function startBwArchiveScheduler(config: BwArchiveConfig): void {
  _task?.stop();
  _task = null;
  if (!config.enabled || !config.baseDir) return;
  const expr = frequencyToCron(config.frequency);
  _task = cron.schedule(expr, () => {
    const latest = loadBwArchiveConfig();
    if (!latest.enabled) return;
    void runBwExport();
  });
}

export function stopBwArchiveScheduler(): void {
  _task?.stop();
  _task = null;
}

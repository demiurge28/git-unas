import * as cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  getFlyApps,
  getFlyMachines,
  getFlySecrets,
  getFlyVolumes,
  type FlyArchiveSnapshot,
} from './flyService';
import { notifyRun } from './notifyService';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.FLY_ARCHIVE_CONFIG_PATH ??
  path.join(process.cwd(), 'config', 'fly-archive-config.json');

const RUNS_PATH =
  process.env.FLY_ARCHIVE_RUNS_PATH ??
  path.join(process.cwd(), 'config', 'fly-archive-runs.json');

const MAX_RUNS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlyArchiveFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface FlyArchiveConfig {
  baseDir: string;
  orgSlug: string;
  frequency: FlyArchiveFrequency;
  retentionDays: number;
  enabled: boolean;
  /** AES-256-GCM encrypted API token (base64). Empty string = not set. */
  encryptedToken: string;
}

export interface FlyAppDiff {
  name: string;
  machinesAdded: string[];
  machinesRemoved: string[];
  machinesChanged: string[];
  volumesAdded: string[];
  volumesRemoved: string[];
  volumesChanged: string[];
  secretsAdded: string[];
  secretsRemoved: string[];
  secretsChanged: string[];
}

export interface FlyArchiveDiff {
  appsAdded: string[];
  appsRemoved: string[];
  appsChanged: FlyAppDiff[];
}

export interface FlyArchiveRun {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'ok' | 'error' | 'no-change';
  message: string;
  filePath?: string;
  appCount?: number;
  diff?: FlyArchiveDiff;
}

// ---------------------------------------------------------------------------
// Token encryption (AES-256-GCM keyed from AUTH_SECRET)
// ---------------------------------------------------------------------------

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET ?? 'change-me-in-production';
  return crypto.createHash('sha256').update(secret).update('fly-archive-v1').digest();
}

export function encryptFlyToken(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptFlyToken(encrypted: string): string {
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

const DEFAULT_CONFIG: FlyArchiveConfig = {
  baseDir: '',
  orgSlug: '',
  frequency: 'daily',
  retentionDays: 30,
  enabled: false,
  encryptedToken: '',
};

export function loadFlyArchiveConfig(): FlyArchiveConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<FlyArchiveConfig> };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

export function saveFlyArchiveConfig(config: FlyArchiveConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Return config safe for API responses (token redacted). */
export function maskedFlyArchiveConfig(
  config: FlyArchiveConfig,
): FlyArchiveConfig & { tokenSet: boolean } {
  return { ...config, encryptedToken: '', tokenSet: config.encryptedToken !== '' };
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export function loadFlyArchiveRuns(): FlyArchiveRun[] {
  try {
    if (fs.existsSync(RUNS_PATH)) {
      return JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8')) as FlyArchiveRun[];
    }
  } catch { /* fall through */ }
  return [];
}

function saveFlyArchiveRun(run: FlyArchiveRun): void {
  const dir = path.dirname(RUNS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const runs = loadFlyArchiveRuns();
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2));

  void notifyRun('Fly Archive', {
    status: run.status,
    message: run.message,
    durationMs: run.durationMs,
  });
}

// ---------------------------------------------------------------------------
// Retention pruning
// ---------------------------------------------------------------------------

function pruneOldArchives(baseDir: string, retentionDays: number): void {
  if (!baseDir || !fs.existsSync(baseDir)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(baseDir)) {
      if (!entry.startsWith('fly-archive-')) continue;
      const fullPath = path.join(baseDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        try { fs.unlinkSync(fullPath); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Archive logic
// ---------------------------------------------------------------------------

function frequencyToCron(freq: FlyArchiveFrequency): string {
  switch (freq) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return '0 3 * * *';
    case 'weekly':  return '0 3 * * 0';
    case 'monthly': return '0 3 1 * *';
  }
}

function makeArchivePath(baseDir: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return path.join(baseDir, `fly-archive-${ts}.json`);
}

function loadPreviousSnapshot(baseDir: string): FlyArchiveSnapshot | null {
  if (!baseDir || !fs.existsSync(baseDir)) return null;
  try {
    const files = fs.readdirSync(baseDir)
      .filter(name => /^fly-archive-.*\.json$/.test(name))
      .map(name => path.join(baseDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const filePath of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as FlyArchiveSnapshot;
        if (Array.isArray(parsed.apps)) return parsed;
      } catch { /* try next candidate */ }
    }
  } catch { /* fall through */ }
  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function machineSignature(machine: unknown): string {
  const m = machine as Record<string, unknown>;
  const copy = { ...m };
  delete copy.updated_at;
  delete copy.instance_id;
  delete copy.private_ip;
  return stableJson(copy);
}

function volumeSignature(volume: unknown): string {
  return stableJson(volume);
}

function secretSignature(secret: unknown): string {
  const s = secret as Record<string, unknown>;
  return stableJson({
    digest: s.digest,
    label: s.label,
    version: s.version,
    created_at: s.created_at,
  });
}

function diffById<T>(
  before: T[],
  after: T[],
  idOf: (item: T) => string,
  signatureOf: (item: T) => string,
): { added: string[]; removed: string[]; changed: string[] } {
  const beforeMap = new Map(before.map(item => [idOf(item), signatureOf(item)]));
  const afterMap = new Map(after.map(item => [idOf(item), signatureOf(item)]));
  const added = [...afterMap.keys()].filter(id => !beforeMap.has(id)).sort();
  const removed = [...beforeMap.keys()].filter(id => !afterMap.has(id)).sort();
  const changed = [...afterMap.keys()]
    .filter(id => beforeMap.has(id) && beforeMap.get(id) !== afterMap.get(id))
    .sort();
  return { added, removed, changed };
}

function diffAppSnapshots(before: FlyArchiveSnapshot['apps'][number], after: FlyArchiveSnapshot['apps'][number]): FlyAppDiff | null {
  const machines = diffById(before.machines, after.machines, item => item.id, machineSignature);
  const volumes = diffById(before.volumes, after.volumes, item => item.id, volumeSignature);
  const secrets = diffById(before.secrets, after.secrets, item => item.name, secretSignature);
  const diff: FlyAppDiff = {
    name: after.name,
    machinesAdded: machines.added,
    machinesRemoved: machines.removed,
    machinesChanged: machines.changed,
    volumesAdded: volumes.added,
    volumesRemoved: volumes.removed,
    volumesChanged: volumes.changed,
    secretsAdded: secrets.added,
    secretsRemoved: secrets.removed,
    secretsChanged: secrets.changed,
  };
  const changed = Object.entries(diff)
    .some(([key, value]) => key !== 'name' && Array.isArray(value) && value.length > 0);
  return changed ? diff : null;
}

function computeSnapshotDiff(before: FlyArchiveSnapshot | null, after: FlyArchiveSnapshot): FlyArchiveDiff {
  if (!before) {
    return {
      appsAdded: after.apps.map(app => app.name).sort(),
      appsRemoved: [],
      appsChanged: [],
    };
  }
  const beforeApps = new Map(before.apps.map(app => [app.name, app]));
  const afterApps = new Map(after.apps.map(app => [app.name, app]));
  const appsAdded = [...afterApps.keys()].filter(name => !beforeApps.has(name)).sort();
  const appsRemoved = [...beforeApps.keys()].filter(name => !afterApps.has(name)).sort();
  const appsChanged = [...afterApps.values()]
    .map(app => {
      const prev = beforeApps.get(app.name);
      return prev ? diffAppSnapshots(prev, app) : null;
    })
    .filter((diff): diff is FlyAppDiff => diff !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { appsAdded, appsRemoved, appsChanged };
}

function isDiffEmpty(diff: FlyArchiveDiff): boolean {
  return diff.appsAdded.length === 0 && diff.appsRemoved.length === 0 && diff.appsChanged.length === 0;
}

function diffChangeCount(diff: FlyArchiveDiff): number {
  return diff.appsAdded.length + diff.appsRemoved.length + diff.appsChanged.reduce((total, app) => total
    + app.machinesAdded.length + app.machinesRemoved.length + app.machinesChanged.length
    + app.volumesAdded.length + app.volumesRemoved.length + app.volumesChanged.length
    + app.secretsAdded.length + app.secretsRemoved.length + app.secretsChanged.length, 0);
}

/** Small delay to avoid hitting Fly.io rate limits between per-app requests. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a Fly.io archive: fetch all apps in the org plus per-app
 * machines, secrets (names only), and volumes, then write to disk.
 */
export async function runFlyArchive(): Promise<FlyArchiveRun> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const config = loadFlyArchiveConfig();

  const fail = (message: string): FlyArchiveRun => {
    const run: FlyArchiveRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'error', message,
    };
    saveFlyArchiveRun(run);
    return run;
  };

  if (!config.baseDir) return fail('baseDir is not configured');
  if (!config.orgSlug) return fail('orgSlug is not configured');
  if (!config.encryptedToken) return fail('API token is not configured');

  let token: string;
  try {
    token = decryptFlyToken(config.encryptedToken);
  } catch {
    return fail('Failed to decrypt stored API token');
  }

  try {
    const apps = await getFlyApps(token, config.orgSlug);

    _progress = { running: true, currentApp: '', done: 0, total: apps.length };

    const appSnapshots = [];
    for (const app of apps) {
      _progress.currentApp = app.name;
      await sleep(200); // 200ms between apps to stay within rate limits
      const [machines, secrets, volumes] = await Promise.all([
        getFlyMachines(token, app.name),
        getFlySecrets(token, app.name),
        getFlyVolumes(token, app.name),
      ]);
      _progress.done += 1;
      appSnapshots.push({
        name: app.name,
        status: app.status,
        machineCount: machines.length,
        volumeCount: volumes.length,
        machines,
        secrets,
        volumes,
      });
    }

    const snapshot: FlyArchiveSnapshot = {
      timestamp: new Date().toISOString(),
      orgSlug: config.orgSlug,
      appCount: apps.length,
      apps: appSnapshots,
    };

    if (!fs.existsSync(config.baseDir)) fs.mkdirSync(config.baseDir, { recursive: true });

    const previousSnapshot = loadPreviousSnapshot(config.baseDir);
    const diff = computeSnapshotDiff(previousSnapshot, snapshot);
    const changeCount = diffChangeCount(diff);

    // Skip writing when nothing changed (first-run diff counts all apps as "added"
    // so isDiffEmpty is false on first run — that's intentional, we always write first snapshot).
    if (previousSnapshot && isDiffEmpty(diff)) {
      const run: FlyArchiveRun = {
        id: crypto.randomUUID(), startedAt,
        completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
        status: 'no-change',
        message: 'No changes since last snapshot',
        appCount: apps.length,
        diff,
      };
      saveFlyArchiveRun(run);
      _progress = { running: false, currentApp: '', done: apps.length, total: apps.length };
      return run;
    }

    const outputPath = makeArchivePath(config.baseDir);
    fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));

    pruneOldArchives(config.baseDir, config.retentionDays);

    const run: FlyArchiveRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'ok',
      message: previousSnapshot
        ? `${changeCount} change${changeCount !== 1 ? 's' : ''} — ${path.basename(outputPath)}`
        : path.basename(outputPath),
      filePath: outputPath,
      appCount: apps.length,
      diff,
    };
    saveFlyArchiveRun(run);
    _progress = { running: false, currentApp: '', done: apps.length, total: apps.length };
    return run;

  } catch (err) {
    _progress = { running: false, currentApp: '', done: _progress.done, total: _progress.total };
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Progress tracking (in-memory, reset on each run)
// ---------------------------------------------------------------------------

interface FlyArchiveProgress {
  running: boolean;
  currentApp: string;
  done: number;
  total: number;
}

let _progress: FlyArchiveProgress = { running: false, currentApp: '', done: 0, total: 0 };

export function getFlyArchiveProgress(): FlyArchiveProgress {
  return { ..._progress };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let _task: cron.ScheduledTask | null = null;

export function startFlyArchiveScheduler(config: FlyArchiveConfig): void {
  _task?.stop();
  _task = null;
  if (!config.enabled || !config.baseDir || !config.orgSlug || !config.encryptedToken) return;
  const expr = frequencyToCron(config.frequency);
  _task = cron.schedule(expr, () => {
    const latest = loadFlyArchiveConfig();
    if (!latest.enabled) return;
    void runFlyArchive();
  });
}

export function stopFlyArchiveScheduler(): void {
  _task?.stop();
  _task = null;
}

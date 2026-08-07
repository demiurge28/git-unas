import * as cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  getFlyApps,
  getFlyMachines,
  getFlyVolumes,
  execOnMachine,
  type FlyVolume,
  type FlyMachine,
} from './flyService';
import {
  decryptFlyToken,
  loadFlyArchiveConfig,
  type FlyArchiveFrequency,
} from './flyArchiveService';
import { notifyRun } from './notifyService';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.FLY_VOL_BACKUP_CONFIG_PATH ??
  path.join(process.cwd(), 'config', 'fly-vol-backup-config.json');

const RUNS_PATH =
  process.env.FLY_VOL_BACKUP_RUNS_PATH ??
  path.join(process.cwd(), 'config', 'fly-vol-backup-runs.json');

const MAX_RUNS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlyVolBackupConfig {
  baseDir: string;
  /** Org slug — if empty, inherited from the Fly archive config. */
  orgSlug: string;
  frequency: FlyArchiveFrequency;
  retentionDays: number;
  /** Skip machines whose estimated used volume data exceeds this (MB). 0 = no limit. */
  maxVolumeMb: number;
  /** Exec API timeout in seconds. Fly caps at 300 s. */
  execTimeoutSec: number;
  enabled: boolean;
}

export interface FlyVolBackupResult {
  appName: string;
  machineId: string;
  machineName: string;
  volumeId: string;
  volumeName: string;
  mountPath: string;
  usedMb: number;
  status: 'ok' | 'error' | 'skipped';
  filePath?: string;
  fileSizeBytes?: number;
  exitCode?: number;
  error?: string;
}

export interface FlyVolBackupRun {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'ok' | 'error' | 'partial';
  message: string;
  machinesAttempted: number;
  machinesSucceeded: number;
  machinesFailed: number;
  machinesSkipped: number;
  results: FlyVolBackupResult[];
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FlyVolBackupConfig = {
  baseDir: '',
  orgSlug: '',
  frequency: 'daily',
  retentionDays: 14,
  maxVolumeMb: 500,
  execTimeoutSec: 180,
  enabled: false,
};

export function loadFlyVolBackupConfig(): FlyVolBackupConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<FlyVolBackupConfig> };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

export function saveFlyVolBackupConfig(config: FlyVolBackupConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export function loadFlyVolBackupRuns(): FlyVolBackupRun[] {
  try {
    if (fs.existsSync(RUNS_PATH)) {
      return JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8')) as FlyVolBackupRun[];
    }
  } catch { /* fall through */ }
  return [];
}

function saveFlyVolBackupRun(run: FlyVolBackupRun): void {
  const dir = path.dirname(RUNS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const runs = loadFlyVolBackupRuns();
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2));

  void notifyRun('Fly Volume Backup', {
    status: run.status,
    message: run.message,
    durationMs: run.durationMs,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function frequencyToCron(freq: FlyArchiveFrequency): string {
  switch (freq) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return '0 4 * * *';
    case 'weekly':  return '0 4 * * 0';
    case 'monthly': return '0 4 1 * *';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRunDir(baseDir: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const dir = path.join(baseDir, `fly-vol-backup-${ts}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeBackupPath(runDir: string, appName: string, machineId: string): string {
  const safeName = appName.replace(/[^a-zA-Z0-9-]/g, '_');
  return path.join(runDir, `${safeName}-${machineId}.tar.gz`);
}

function estimateUsedMb(volume: FlyVolume): number {
  const blocks = volume.blocks ?? 0;
  const blocksFree = volume.blocks_free ?? 0;
  const blockSize = volume.block_size ?? 4096;
  if (blocks === 0) return 0;
  return Math.max(0, (blocks - blocksFree) * blockSize) / (1024 * 1024);
}

function pruneOldBackups(baseDir: string, retentionDays: number): void {
  if (!baseDir || !fs.existsSync(baseDir)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(baseDir)) {
      if (!entry.startsWith('fly-vol-backup-')) continue;
      const fullPath = path.join(baseDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Core backup function
// ---------------------------------------------------------------------------

export async function runFlyVolBackup(): Promise<FlyVolBackupRun> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const config = loadFlyVolBackupConfig();

  // Resolve orgSlug — fall back to the archive config if not set locally
  const orgSlug = config.orgSlug || loadFlyArchiveConfig().orgSlug;

  const fail = (message: string): FlyVolBackupRun => {
    const run: FlyVolBackupRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'error', message,
      machinesAttempted: 0, machinesSucceeded: 0, machinesFailed: 0, machinesSkipped: 0,
      results: [],
    };
    saveFlyVolBackupRun(run);
    return run;
  };

  if (!config.baseDir) return fail('baseDir is not configured');
  if (!orgSlug) return fail('orgSlug is not configured (set here or in the Fly archive config)');

  // Resolve token from archive config (shared)
  const archiveConfig = loadFlyArchiveConfig();
  if (!archiveConfig.encryptedToken) return fail('API token is not configured (set in Fly Archive config)');

  let token: string;
  try {
    token = decryptFlyToken(archiveConfig.encryptedToken);
  } catch {
    return fail('Failed to decrypt stored API token');
  }

    if (!fs.existsSync(config.baseDir)) {
      try { fs.mkdirSync(config.baseDir, { recursive: true }); } catch { /* fall through */ }
    }

    // Create a timestamped folder for this run
    const runDir = makeRunDir(config.baseDir);

  const results: FlyVolBackupResult[] = [];
  let machinesAttempted = 0;
  let machinesSucceeded = 0;
  let machinesFailed = 0;
  let machinesSkipped = 0;

  try {
    // Always fetch apps fresh — discovers new apps on every run
    const apps = await getFlyApps(token, orgSlug);

    // Collect all (machine, volume) pairs across the org
    const eligible: Array<{ app: string; machine: FlyMachine; volume: FlyVolume; mountPath: string }> = [];

    for (const app of apps) {
      await sleep(200);
      const [machines, volumes] = await Promise.all([
        getFlyMachines(token, app.name),
        getFlyVolumes(token, app.name),
      ]);
      const volById = new Map(volumes.map(v => [v.id, v]));

      for (const machine of machines) {
        // Find the volume attached to this machine
        const mountEntry = machine.config?.mounts?.[0];
        const volumeId = mountEntry?.volume ?? machine.config?.['volume'] as string | undefined;
        const vol = volumeId ? volById.get(volumeId) : undefined;
        // Also check by attached_machine_id on volumes
        const attachedVol = vol ?? volumes.find(v => v.attached_machine_id === machine.id);
        if (!attachedVol) continue;

        const mountPath = mountEntry?.path ?? '/data';
        eligible.push({ app: app.name, machine, volume: attachedVol, mountPath });
      }
    }

    _progress = { running: true, currentMachine: '', done: 0, total: eligible.length };

    for (const { app, machine, volume, mountPath } of eligible) {
      _progress.currentMachine = `${app}/${machine.name}`;
      const usedMb = estimateUsedMb(volume);

      // Skip non-started machines
      if (machine.state !== 'started') {
        machinesSkipped++;
        results.push({
          appName: app, machineId: machine.id, machineName: machine.name,
          volumeId: volume.id, volumeName: volume.name,
          mountPath, usedMb,
          status: 'skipped',
          error: `Machine state is '${machine.state}' (must be 'started')`,
        });
        _progress.done++;
        continue;
      }

      // Skip oversized volumes (0 = unlimited)
      if (config.maxVolumeMb > 0 && usedMb > config.maxVolumeMb) {
        machinesSkipped++;
        results.push({
          appName: app, machineId: machine.id, machineName: machine.name,
          volumeId: volume.id, volumeName: volume.name,
          mountPath, usedMb,
          status: 'skipped',
          error: `Volume used ${Math.round(usedMb)} MB exceeds limit of ${config.maxVolumeMb} MB`,
        });
        _progress.done++;
        continue;
      }

      machinesAttempted++;

      try {
        // tar the mount path, pipe through base64 so stdout is ASCII-safe
        const cmd = `bash -c 'tar czf - "${mountPath}" 2>/dev/null | base64 -w 0'`;
        const execResult = await execOnMachine(token, app, machine.id, cmd, config.execTimeoutSec);

        if (execResult.exit_code !== 0) {
          machinesFailed++;
          results.push({
            appName: app, machineId: machine.id, machineName: machine.name,
            volumeId: volume.id, volumeName: volume.name,
            mountPath, usedMb,
            status: 'error',
            exitCode: execResult.exit_code,
            error: execResult.stderr.slice(0, 300) || `exit code ${execResult.exit_code}`,
          });
        } else {
          const raw = Buffer.from(execResult.stdout.trim(), 'base64');
          const outPath = makeBackupPath(runDir, app, machine.id);
          fs.writeFileSync(outPath, raw);
          machinesSucceeded++;
          results.push({
            appName: app, machineId: machine.id, machineName: machine.name,
            volumeId: volume.id, volumeName: volume.name,
            mountPath, usedMb,
            status: 'ok',
            filePath: outPath,
            fileSizeBytes: raw.length,
            exitCode: 0,
          });
        }
      } catch (err) {
        machinesFailed++;
        results.push({
          appName: app, machineId: machine.id, machineName: machine.name,
          volumeId: volume.id, volumeName: volume.name,
          mountPath, usedMb,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }

      _progress.done++;
    }

    pruneOldBackups(config.baseDir, config.retentionDays);

    const overallStatus =
      machinesAttempted === 0 && machinesSkipped > 0 ? 'error'
      : machinesFailed === 0 ? 'ok'
      : machinesSucceeded === 0 ? 'error'
      : 'partial';

    const message =
      machinesAttempted === 0
        ? `No eligible machines found (${machinesSkipped} skipped)`
        : `${machinesSucceeded}/${machinesAttempted} machines backed up` +
          (machinesSkipped > 0 ? `, ${machinesSkipped} skipped` : '');

    const run: FlyVolBackupRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: overallStatus, message,
      machinesAttempted, machinesSucceeded, machinesFailed, machinesSkipped,
      results,
    };
    saveFlyVolBackupRun(run);
    _progress = { running: false, currentMachine: '', done: eligible.length, total: eligible.length };
    return run;

  } catch (err) {
    _progress = { running: false, currentMachine: '', done: _progress.done, total: _progress.total };
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

interface FlyVolBackupProgress {
  running: boolean;
  currentMachine: string;
  done: number;
  total: number;
}

let _progress: FlyVolBackupProgress = { running: false, currentMachine: '', done: 0, total: 0 };

export function getFlyVolBackupProgress(): FlyVolBackupProgress {
  return { ..._progress };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let _task: cron.ScheduledTask | null = null;

export function startFlyVolBackupScheduler(config: FlyVolBackupConfig): void {
  _task?.stop();
  _task = null;
  if (!config.enabled || !config.baseDir) return;
  const expr = frequencyToCron(config.frequency);
  _task = cron.schedule(expr, () => {
    const latest = loadFlyVolBackupConfig();
    if (!latest.enabled) return;
    void runFlyVolBackup();
  });
}

export function stopFlyVolBackupScheduler(): void {
  _task?.stop();
  _task = null;
}

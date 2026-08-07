import * as cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { createArchive } from './tarService';
import { notifyRun } from './notifyService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ScheduleConfig {
  enabled: boolean;
  /** 0–23 */
  hour: number;
  /** 0–59 */
  minute: number;
  /** Which days to run; empty array = every day */
  days: DayOfWeek[];
  /** Path to tar (source directory or file) */
  source: string;
  /** Directory where backup archives are written */
  backupDir: string;
  /** Number of backup files to retain (oldest are deleted) */
  keepCount: number;
}

export interface BackupRun {
  file: string;
  timestamp: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.SCHEDULE_CONFIG_PATH ?? path.join(process.cwd(), 'config', 'schedule.json');

const DEFAULT_CONFIG: ScheduleConfig = {
  enabled: false,
  hour: 6,
  minute: 0,
  days: [],
  source: '',
  backupDir: '',
  keepCount: 7,
};

const BACKUP_RE = /^backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/;

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export function loadConfig(): ScheduleConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<ScheduleConfig>) };
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: ScheduleConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Backup list + rotation
// ---------------------------------------------------------------------------

export function listBackups(backupDir: string): BackupRun[] {
  if (!backupDir || !fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => BACKUP_RE.test(f))
    .map((f) => {
      const full = path.join(backupDir, f);
      const stat = fs.statSync(full);
      return {
        file: f,
        timestamp: f
          .replace('backup-', '')
          .replace('.tar.gz', '')
          .replace('_', 'T')
          .replace(/-(\d{2})-(\d{2})$/, ':$1:$2'),
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => b.file.localeCompare(a.file)); // newest first
}

function rotateBackups(backupDir: string, keepCount: number): void {
  const all = listBackups(backupDir);
  const toDelete = all.slice(keepCount); // oldest entries beyond the limit
  for (const entry of toDelete) {
    try {
      fs.unlinkSync(path.join(backupDir, entry.file));
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Backup job
// ---------------------------------------------------------------------------

export async function runBackup(config: ScheduleConfig): Promise<string> {
  if (!config.source || !config.backupDir) {
    throw new Error('source and backupDir must be configured before running a backup');
  }

  if (!fs.existsSync(config.backupDir)) {
    fs.mkdirSync(config.backupDir, { recursive: true });
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const dest = path.join(config.backupDir, `backup-${stamp}.tar.gz`);

  await createArchive({ source: config.source, destination: dest, compress: true });
  rotateBackups(config.backupDir, config.keepCount);

  return dest;
}

// ---------------------------------------------------------------------------
// Cron expression builder
// ---------------------------------------------------------------------------

/** Convert config to a node-cron expression: "minute hour * * day,day,…" */
function buildCronExpr(config: ScheduleConfig): string {
  const dayMap: Record<DayOfWeek, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };

  const dayPart =
    config.days.length === 0 || config.days.length === 7
      ? '*'
      : config.days.map((d) => dayMap[d]).join(',');

  return `${config.minute} ${config.hour} * * ${dayPart}`;
}

/** Compute the next Date on which the cron expression would fire. */
export function nextRunDate(config: ScheduleConfig): Date | null {
  if (!config.enabled) return null;

  const dayNums =
    config.days.length === 0 || config.days.length === 7
      ? [0, 1, 2, 3, 4, 5, 6]
      : (() => {
          const m: Record<DayOfWeek, number> = {
            sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
          };
          return config.days.map((d) => m[d]);
        })();

  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + i);
    candidate.setHours(config.hour, config.minute, 0, 0);

    if (candidate <= now) continue;
    if (dayNums.includes(candidate.getDay())) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scheduler singleton
// ---------------------------------------------------------------------------

let _task: cron.ScheduledTask | null = null;
let _lastRun: { timestamp: string; status: 'ok' | 'error'; message: string } | null = null;

/** Record a backup run outcome (updates lastRun) and emit a Slack notification. */
export function recordScheduleOutcome(status: 'ok' | 'error', message: string): void {
  _lastRun = { timestamp: new Date().toISOString(), status, message };
  void notifyRun('Scheduled Backup', { status, message });
}

export function startScheduler(config: ScheduleConfig): void {
  stopScheduler();
  if (!config.enabled || !config.source || !config.backupDir) return;

  const expr = buildCronExpr(config);
  _task = cron.schedule(expr, async () => {
    try {
      const dest = await runBackup(config);
      recordScheduleOutcome('ok', `Backup written to ${dest}`);
    } catch (err) {
      recordScheduleOutcome('error', err instanceof Error ? err.message : String(err));
    }
  });
}

export function stopScheduler(): void {
  if (_task) {
    _task.stop();
    _task = null;
  }
}

export function getLastRun() {
  return _lastRun;
}

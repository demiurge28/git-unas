import * as cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { listOrgRepos } from './githubService';
import { encryptFile } from './encryptService';
import { notifyRun } from './notifyService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface ArchiveEntry {
  id: string;
  type: 'repo' | 'org';
  /** GitHub owner (user or org name) — used for type=repo */
  owner: string;
  /** Repo name — only for type=repo */
  repo?: string;
  /** Only for type=org: ["*"] means all repos */
  includeRepos: string[];
  /** Only for type=org: repos to skip */
  excludeRepos: string[];
  /** null → use config.defaultFrequency */
  frequency: Frequency | null;
  /** null → use config.retentionDays */
  retentionDays: number | null;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastMessage: string | null;
}

export interface ArchiveConfig {
  githubToken: string;
  baseDir: string;
  defaultFrequency: Frequency;
  /** How many days to retain archive files. 1–180. */
  retentionDays: number;
  encrypt: boolean;
  passphrase: string;
  entries: ArchiveEntry[];
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.ARCHIVE_CONFIG_PATH ??
  path.join(process.cwd(), 'config', 'archive-config.json');

const DEFAULT_CONFIG: ArchiveConfig = {
  githubToken: '',
  baseDir: '',
  defaultFrequency: 'daily',
  retentionDays: 30,
  encrypt: false,
  passphrase: '',
  entries: [],
};

export function loadArchiveConfig(): ArchiveConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<ArchiveConfig>) };
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_CONFIG };
}

export function saveArchiveConfig(config: ArchiveConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Return config with token masked for API responses. */
export function maskedConfig(config: ArchiveConfig): ArchiveConfig {
  return {
    ...config,
    githubToken: config.githubToken ? '***' : '',
    passphrase: config.passphrase ? '***' : '',
  };
}

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

export function frequencyToCron(freq: Frequency): string {
  switch (freq) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return '0 2 * * *';
    case 'weekly':  return '0 2 * * 0';
    case 'monthly': return '0 2 1 * *';
  }
}

/** Next fire time for a cron expression (within the next 7 days). */
export function nextRunDate(freq: Frequency): Date | null {
  const now = new Date();
  const candidate = new Date(now);

  switch (freq) {
    case 'hourly': {
      candidate.setMinutes(0, 0, 0);
      candidate.setHours(candidate.getHours() + 1);
      return candidate;
    }
    case 'daily': {
      candidate.setHours(2, 0, 0, 0);
      if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate;
    }
    case 'weekly': {
      candidate.setHours(2, 0, 0, 0);
      const daysUntilSunday = (7 - candidate.getDay()) % 7 || 7;
      candidate.setDate(candidate.getDate() + daysUntilSunday);
      return candidate;
    }
    case 'monthly': {
      candidate.setHours(2, 0, 0, 0);
      candidate.setDate(1);
      if (candidate <= now) {
        candidate.setMonth(candidate.getMonth() + 1);
        candidate.setDate(1);
      }
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Archive cache — tracks last pushed_at per repo to enable symlink shortcuts
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** pushed_at value when this repo was last fully archived. */
  pushedAt: string;
  /** Absolute path of the real archive file (not a symlink). */
  archivePath: string;
}

type ArchiveCache = Record<string, CacheEntry>; // key: "owner/repo"

const CACHE_PATH =
  process.env.ARCHIVE_CACHE_PATH ??
  path.join(process.cwd(), 'config', 'archive-cache.json');

export function loadArchiveCache(): ArchiveCache {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as ArchiveCache;
    }
  } catch { /* fall through */ }
  return {};
}

function saveArchiveCache(cache: ArchiveCache): void {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Invalidate cache entries whose archivePath lives inside deletedDir.
 * Called after pruning so the next run re-archives those repos rather
 * than trying to symlink to a deleted file.
 */
function invalidateCacheForDir(deletedDir: string, cache: ArchiveCache): boolean {
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (cache[key].archivePath.startsWith(deletedDir + path.sep)) {
      delete cache[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Create a relative symlink in runDir pointing to prevArchivePath.
 * Returns the symlink path.
 */
export function symlinkRepo(
  prevArchivePath: string,
  runDir: string,
  filename: string,
): string {
  const linkPath = path.join(runDir, filename);
  const relTarget = path.relative(runDir, prevArchivePath);
  try {
    fs.symlinkSync(relTarget, linkPath);
  } catch (err: unknown) {
    // If symlink fails (e.g. cross-filesystem), fall through — caller will do full archive.
    throw err;
  }
  return linkPath;
}

// ---------------------------------------------------------------------------
// Retention / pruning
// ---------------------------------------------------------------------------

// Matches a run folder name: [prefix_]YYYY-MM-DD_HH-MM-SS
// The date component always appears at the end.
const RUN_DIR_RE = /(?:^|_)(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}$/;

// Legacy: matches old flat archive filenames (owner__repo__YYYY-MM-DD_HH-MM-SS.tar.gz)
const ARCHIVE_FILE_RE = /^(.+)__(.+)__(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.tar\.gz(\.unas)?$/;

/**
 * Parse the date embedded in an archive filename (legacy flat format).
 * Returns null if the filename doesn’t match.
 */
export function parseDateFromFilename(filename: string): Date | null {
  const m = ARCHIVE_FILE_RE.exec(filename);
  if (!m) return null;
  const [, , , dateStr] = m;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse the date from a run folder name (YYYY-MM-DD_HH-MM-SS). */
export function parseDateFromRunDir(name: string): Date | null {
  const m = RUN_DIR_RE.exec(name);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Delete run folders inside baseDir that are older than retentionDays.
 * Also cleans up legacy flat archive files for the given owner/repo.
 * Best-effort: failures are silently ignored.
 */
export function pruneOldRunDirs(baseDir: string, retentionDays: number): void {
  if (!baseDir || !fs.existsSync(baseDir)) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cache = loadArchiveCache();
  let cacheChanged = false;

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const d = parseDateFromRunDir(entry.name);
    if (d && d.getTime() < cutoff) {
      const dirPath = path.join(baseDir, entry.name);
      // Invalidate any cache entries pointing into this folder so the next
      // run re-archives instead of symlinking to a deleted file.
      if (invalidateCacheForDir(dirPath, cache)) cacheChanged = true;
      try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  if (cacheChanged) saveArchiveCache(cache);
}

// Keep the old function for backward compat / tests.
export function pruneOldArchives(
  owner: string,
  repo: string,
  baseDir: string,
  retentionDays: number,
): void {
  pruneOldRunDirs(baseDir, retentionDays);
}

/** Build the timestamped run directory path and create it.
 *  prefix: org name (for org runs) or repo name (for single-repo runs).
 */
export function makeRunDir(baseDir: string, prefix?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const name = prefix ? `${prefix}_${timestamp}` : timestamp;
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Archive operations
// ---------------------------------------------------------------------------

function runCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    const out: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => out.push(d.toString()));
    proc.on('close', (code) => {
      const text = out.join('');
      if (code === 0) resolve(text);
      else reject(new Error(`${cmd} exited ${code}: ${text}`));
    });
    proc.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
  });
}

/**
 * Archive a single repository into a run directory.
 * Process: git clone --mirror → tar.gz (in runDir) → optional encrypt → rm clone dir
 * Archive filename inside runDir: <owner>__<repo>.tar.gz[.unas]
 */
export async function archiveRepo(
  owner: string,
  repo: string,
  config: ArchiveConfig,
  retentionOverride?: number,
  runDir?: string,
): Promise<string> {
  if (!config.baseDir) throw new Error('baseDir is not configured');

  // When no shared runDir is given (standalone single-repo call), use the repo name as prefix.
  const destDir = runDir ?? makeRunDir(config.baseDir, repo);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-archive-'));
  const cloneDir = path.join(tmpDir, `${repo}.git`);

  try {
    const repoUrl = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
    await runCommand('git', ['clone', '--mirror', '--', repoUrl, cloneDir]);

    const tarName = `${owner}__${repo}.tar.gz`;
    const tarPath = path.join(destDir, tarName);

    await runCommand('tar', ['-czf', tarPath, '-C', tmpDir, `${repo}.git`]);

    if (config.encrypt && config.passphrase) {
      const encPath = `${tarPath}.unas`;
      await encryptFile({ source: tarPath, destination: encPath, passphrase: config.passphrase });
      fs.unlinkSync(tarPath);
      return encPath;
    }

    return tarPath;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Archive all repos for an org entry, respecting includeRepos / excludeRepos.
 */
export async function archiveOrgEntry(
  entry: ArchiveEntry,
  config: ArchiveConfig,
): Promise<{ repo: string; status: 'ok' | 'error' | 'skipped'; message: string }[]> {
  if (entry.type !== 'org') throw new Error('entry is not type=org');

  const allRepos = await listOrgRepos(config.githubToken, entry.owner);
  const includeAll =
    entry.includeRepos.length === 0 || entry.includeRepos.includes('*');

  const repos = allRepos
    .filter((r) => !r.archived)
    .filter((r) => includeAll || entry.includeRepos.includes(r.name))
    .filter((r) => !entry.excludeRepos.includes(r.name));

  const results: { repo: string; status: 'ok' | 'error' | 'skipped'; message: string }[] = [];
  startProgress(entry.id, `${entry.owner} (org)`, repos.length);

  // All repos in this org run share one timestamped folder prefixed with the org name.
  if (!fs.existsSync(config.baseDir)) fs.mkdirSync(config.baseDir, { recursive: true });
  const runDir = makeRunDir(config.baseDir, entry.owner);
  const retention = entry.retentionDays ?? config.retentionDays;
  const cache = loadArchiveCache();
  let cacheChanged = false;

  for (const r of repos) {
    if (_progress) _progress.currentRepo = r.name;
    const cacheKey = `${entry.owner}/${r.name}`;
    const cached = cache[cacheKey];
    const archiveFilename = `${entry.owner}__${r.name}${config.encrypt ? '.tar.gz.unas' : '.tar.gz'}`;

    // --- Symlink shortcut: repo hasn't changed since last archive ---
    if (
      cached &&
      cached.pushedAt === r.pushed_at &&
      fs.existsSync(cached.archivePath)
    ) {
      try {
        const linkPath = symlinkRepo(cached.archivePath, runDir, archiveFilename);
        skipProgress(r.name);
        results.push({ repo: r.name, status: 'skipped', message: linkPath });
        continue;
      } catch {
        // Symlink failed (cross-filesystem, etc.) — fall through to full archive.
      }
    }

    // --- Full archive ---
    try {
      const dest = await archiveRepo(entry.owner, r.name, config, retention, runDir);
      cache[cacheKey] = { pushedAt: r.pushed_at, archivePath: dest };
      cacheChanged = true;
      advanceProgress(r.name, false);
      results.push({ repo: r.name, status: 'ok', message: dest });
    } catch (err) {
      advanceProgress(r.name, true);
      results.push({
        repo: r.name,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (cacheChanged) saveArchiveCache(cache);

  // Prune run folders beyond retention (also invalidates stale cache entries).
  pruneOldRunDirs(config.baseDir, retention);
  const errorRepos = results.filter((r) => r.status === 'error').map((r) => r.repo);
  completeProgress(runDir, errorRepos);

  return results;
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  entryId: string;
  label: string;
  runDir: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  total: number;
  succeeded: number;
  skipped: number;
  errors: number;
  errorRepos: string[];
  status: 'ok' | 'partial' | 'failed';
}

const RUNS_PATH =
  process.env.ARCHIVE_RUNS_PATH ??
  path.join(process.cwd(), 'config', 'archive-runs.json');

const MAX_RUNS = 200;

export function loadRunHistory(): RunRecord[] {
  try {
    if (fs.existsSync(RUNS_PATH)) {
      return JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8')) as RunRecord[];
    }
  } catch { /* fall through */ }
  return [];
}

function saveRunRecord(record: RunRecord): void {
  const dir = path.dirname(RUNS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadRunHistory();
  existing.unshift(record); // newest first
  if (existing.length > MAX_RUNS) existing.length = MAX_RUNS;
  fs.writeFileSync(RUNS_PATH, JSON.stringify(existing, null, 2));

  const errNote = record.errors ? `, ${record.errors} errors` : '';
  void notifyRun('GitHub Archive', {
    status: record.status,
    message: `${record.label} — ${record.succeeded}/${record.total} archived${errNote}`,
    durationMs: record.durationMs,
  });
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

export interface ArchiveProgress {
  entryId: string;
  label: string;       // e.g. "myorg (org)" or "myorg/myrepo"
  current: number;
  total: number;
  currentRepo: string;
  errors: number;
  skipped: number;
  done: boolean;
  startedAt: string;
}

let _progress: ArchiveProgress | null = null;

export function getArchiveProgress(): ArchiveProgress | null {
  return _progress;
}

function startProgress(entryId: string, label: string, total: number): void {
  _progress = { entryId, label, current: 0, total, currentRepo: '', errors: 0, skipped: 0, done: false, startedAt: new Date().toISOString() };
}

function advanceProgress(repo: string, isError: boolean): void {
  if (!_progress) return;
  _progress.current += 1;
  _progress.currentRepo = repo;
  if (isError) _progress.errors += 1;
}

function skipProgress(repo: string): void {
  if (!_progress) return;
  _progress.skipped += 1;
  _progress.currentRepo = repo;
}

function completeProgress(runDir?: string, errorRepos?: string[]): void {
  if (!_progress) return;
  _progress.done = true;
  // Persist the completed run to history.
  const now = new Date().toISOString();
  const startMs = new Date(_progress.startedAt).getTime();
  const errors = _progress.errors;
  const skipped = _progress.skipped;
  const total = _progress.total;
  const succeeded = total - errors - skipped;
  const record: RunRecord = {
    id: crypto.randomUUID(),
    entryId: _progress.entryId,
    label: _progress.label,
    runDir: runDir ?? '',
    startedAt: _progress.startedAt,
    completedAt: now,
    durationMs: Date.now() - startMs,
    total,
    succeeded,
    skipped,
    errors,
    errorRepos: errorRepos ?? [],
    status: errors === 0 ? 'ok' : succeeded === 0 ? 'failed' : 'partial',
  };
  saveRunRecord(record);
}

// ---------------------------------------------------------------------------
// Scheduler singleton
// ---------------------------------------------------------------------------

const _tasks = new Map<string, cron.ScheduledTask>();

function updateEntryStatus(
  id: string,
  status: 'ok' | 'error',
  message: string,
): void {
  const cfg = loadArchiveConfig();
  const entry = cfg.entries.find((e) => e.id === id);
  if (entry) {
    entry.lastRun = new Date().toISOString();
    entry.lastStatus = status;
    entry.lastMessage = message;
    saveArchiveConfig(cfg);
  }
}

async function runEntry(entry: ArchiveEntry, config: ArchiveConfig): Promise<void> {
  try {
    if (entry.type === 'repo') {
      startProgress(entry.id, `${entry.owner}/${entry.repo}`, 1);
      const retention = entry.retentionDays ?? config.retentionDays;
      if (!fs.existsSync(config.baseDir)) fs.mkdirSync(config.baseDir, { recursive: true });
      const runDir = makeRunDir(config.baseDir, entry.repo);  // prefix = repo name
      const dest = await archiveRepo(entry.owner, entry.repo!, config, retention, runDir);
      pruneOldRunDirs(config.baseDir, retention);
      advanceProgress(entry.repo!, false);
      completeProgress(runDir, []);
      updateEntryStatus(entry.id, 'ok', dest);
    } else {
      const results = await archiveOrgEntry(entry, config);
      const errors = results.filter((r) => r.status === 'error');
      if (errors.length === 0) {
        updateEntryStatus(entry.id, 'ok', `${results.length} repos archived`);
      } else {
        updateEntryStatus(
          entry.id,
          'error',
          `${errors.length} errors: ${errors.map((e) => e.repo).join(', ')}`,
        );
      }
    }
  } catch (err) {
    updateEntryStatus(
      entry.id,
      'error',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function startArchiveScheduler(config: ArchiveConfig): void {
  // Stop all existing tasks.
  for (const task of _tasks.values()) task.stop();
  _tasks.clear();

  if (!config.githubToken || !config.baseDir) return;

  for (const entry of config.entries) {
    if (!entry.enabled) continue;
    const freq = entry.frequency ?? config.defaultFrequency;
    const expr = frequencyToCron(freq);
    const task = cron.schedule(expr, () => {
      const latest = loadArchiveConfig();
      const latestEntry = latest.entries.find((e) => e.id === entry.id);
      if (!latestEntry?.enabled) return;
      void runEntry(latestEntry, latest);
    });
    _tasks.set(entry.id, task);
  }
}

export function stopArchiveScheduler(): void {
  for (const task of _tasks.values()) task.stop();
  _tasks.clear();
}

/** Run one entry immediately outside the scheduler (for manual trigger). */
export async function runEntryNow(id: string): Promise<void> {
  const config = loadArchiveConfig();
  const entry = config.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`No archive entry with id=${id}`);
  await runEntry(entry, config);
}

/** Run all enabled entries immediately. */
export async function runAllNow(): Promise<void> {
  const config = loadArchiveConfig();
  for (const entry of config.entries.filter((e) => e.enabled)) {
    await runEntry(entry, config);
  }
}

/** Generate a new entry ID. */
export function newEntryId(): string {
  return crypto.randomUUID();
}

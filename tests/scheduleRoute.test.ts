import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// requireAuth gates every /api route; stub it so these route unit tests reach the handlers.
jest.mock('../src/middleware/requireAuth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void): void => next(),
}));

// Mock tarService to avoid shelling out to tar.
jest.mock('../src/services/tarService', () => ({
  createArchive: jest.fn().mockResolvedValue({ path: 'mocked', output: '' }),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-route-test-'));
  process.env.SCHEDULE_CONFIG_PATH = path.join(tmpDir, 'schedule.json');
  jest.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SCHEDULE_CONFIG_PATH;
  jest.resetModules();
});

async function getApp() {
  const { app } = await import('../src/server');
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/schedule
// ---------------------------------------------------------------------------

describe('GET /api/schedule', () => {
  it('returns 200 with default config when no schedule file exists', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/schedule');
    expect(res.status).toBe(200);
    expect(res.body.config.enabled).toBe(false);
    expect(res.body.config.hour).toBe(6);
    expect(res.body.config.keepCount).toBe(7);
    expect(Array.isArray(res.body.backups)).toBe(true);
    expect(res.body.nextRun).toBeNull();
    expect(res.body.lastRun).toBeNull();
  });

  it('returns nextRun when schedule is enabled', async () => {
    fs.writeFileSync(
      process.env.SCHEDULE_CONFIG_PATH!,
      JSON.stringify({ enabled: true, hour: 6, minute: 0, days: [], source: '/data', backupDir: tmpDir, keepCount: 7 }),
    );
    jest.resetModules();
    const app = await getApp();
    const res = await request(app).get('/api/schedule');
    expect(res.status).toBe(200);
    expect(res.body.nextRun).not.toBeNull();
    expect(new Date(res.body.nextRun).getTime()).toBeGreaterThan(Date.now());
  });

  it('lists existing backup files', async () => {
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, 'backup-2026-05-28_06-00-00.tar.gz'), 'x'.repeat(512));
    fs.writeFileSync(
      process.env.SCHEDULE_CONFIG_PATH!,
      JSON.stringify({ enabled: false, hour: 6, minute: 0, days: [], source: '/data', backupDir, keepCount: 7 }),
    );
    jest.resetModules();
    const app = await getApp();
    const res = await request(app).get('/api/schedule');
    expect(res.status).toBe(200);
    expect(res.body.backups).toHaveLength(1);
    expect(res.body.backups[0].file).toBe('backup-2026-05-28_06-00-00.tar.gz');
    expect(res.body.backups[0].sizeBytes).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedule
// ---------------------------------------------------------------------------

describe('POST /api/schedule', () => {
  it('returns 400 when hour is out of range', async () => {
    const app = await getApp();
    const res = await request(app)
      .post('/api/schedule')
      .send({ hour: 25, minute: 0, keepCount: 7, source: '/data', backupDir: tmpDir });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hour/i);
  });

  it('returns 400 when minute is out of range', async () => {
    const app = await getApp();
    const res = await request(app)
      .post('/api/schedule')
      .send({ hour: 6, minute: 60, keepCount: 7, source: '/data', backupDir: tmpDir });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/minute/i);
  });

  it('returns 400 when keepCount is zero', async () => {
    const app = await getApp();
    const res = await request(app)
      .post('/api/schedule')
      .send({ hour: 6, minute: 0, keepCount: 0, source: '/data', backupDir: tmpDir });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keepCount/i);
  });

  it('saves a valid schedule and returns the new config', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/schedule').send({
      enabled: false,
      hour: 3,
      minute: 30,
      days: ['mon', 'wed', 'fri'],
      source: '/mnt/data',
      backupDir: tmpDir,
      keepCount: 14,
    });
    expect(res.status).toBe(200);
    expect(res.body.config.hour).toBe(3);
    expect(res.body.config.minute).toBe(30);
    expect(res.body.config.days).toEqual(['mon', 'wed', 'fri']);
    expect(res.body.config.keepCount).toBe(14);
    expect(res.body.config.source).toBe('/mnt/data');
    // Config should now be persisted.
    const saved = JSON.parse(fs.readFileSync(process.env.SCHEDULE_CONFIG_PATH!, 'utf8'));
    expect(saved.hour).toBe(3);
    expect(saved.keepCount).toBe(14);
  });

  it('returns nextRun as null when enabled is false', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/schedule').send({
      enabled: false, hour: 6, minute: 0, days: [],
      source: '/data', backupDir: tmpDir, keepCount: 7,
    });
    expect(res.status).toBe(200);
    expect(res.body.nextRun).toBeNull();
  });

  it('returns a nextRun timestamp when enabled is true', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/schedule').send({
      enabled: true, hour: 6, minute: 0, days: [],
      source: '/data', backupDir: tmpDir, keepCount: 7,
    });
    expect(res.status).toBe(200);
    expect(res.body.nextRun).not.toBeNull();
  });

  it('strips unknown day values from the days array', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/schedule').send({
      enabled: false, hour: 6, minute: 0,
      days: ['mon', 'badday', 'fri'],
      source: '/data', backupDir: tmpDir, keepCount: 7,
    });
    expect(res.status).toBe(200);
    expect(res.body.config.days).toEqual(['mon', 'fri']);
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedule/run
// ---------------------------------------------------------------------------

describe('POST /api/schedule/run', () => {
  it('returns 500 when source or backupDir is not configured', async () => {
    // Default config has empty source/backupDir.
    const app = await getApp();
    const res = await request(app).post('/api/schedule/run').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/source and backupDir must be configured/);
  });

  it('returns 200 with destination and backup list on success', async () => {
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(backupDir);
    fs.writeFileSync(
      process.env.SCHEDULE_CONFIG_PATH!,
      JSON.stringify({ enabled: false, hour: 6, minute: 0, days: [], source: '/data', backupDir, keepCount: 7 }),
    );
    jest.resetModules();
    const app = await getApp();
    const res = await request(app).post('/api/schedule/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.destination).toBe('string');
    expect(res.body.destination).toMatch(/backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/);
    expect(Array.isArray(res.body.backups)).toBe(true);
  });
});

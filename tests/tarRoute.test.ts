import request from 'supertest';

// requireAuth gates every /api route; stub it so these route unit tests reach the handlers.
jest.mock('../src/middleware/requireAuth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void): void => next(),
}));

jest.mock('../src/services/tarService', () => ({
  createArchive: jest.fn(),
  extractArchive: jest.fn(),
}));

jest.mock('../src/services/scheduleService', () => ({
  loadConfig: jest.fn().mockReturnValue({ enabled: false, hour: 6, minute: 0, days: [], source: '', backupDir: '', keepCount: 7 }),
  startScheduler: jest.fn(),
}));

import { createArchive, extractArchive } from '../src/services/tarService';
const mockCreate = createArchive as jest.MockedFunction<typeof createArchive>;
const mockExtract = extractArchive as jest.MockedFunction<typeof extractArchive>;

async function getApp() {
  const { app } = await import('../src/server');
  return app;
}

beforeEach(() => {
  mockCreate.mockReset();
  mockExtract.mockReset();
});

// ---------------------------------------------------------------------------
// POST /api/tar/create
// ---------------------------------------------------------------------------

describe('POST /api/tar/create', () => {
  it('returns 400 when source is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/tar/create').send({ destination: '/out/archive.tar.gz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source and destination are required/);
  });

  it('returns 400 when destination is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/tar/create').send({ source: '/data/files' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source and destination are required/);
  });

  it('returns 200 with path and output on success', async () => {
    mockCreate.mockResolvedValue({ path: '/out/archive.tar.gz', output: '' });
    const app = await getApp();
    const res = await request(app).post('/api/tar/create').send({
      source: '/data/files',
      destination: '/out/archive.tar.gz',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.path).toBe('/out/archive.tar.gz');
  });

  it('defaults compress to true when not supplied', async () => {
    mockCreate.mockResolvedValue({ path: '/out/archive.tar.gz', output: '' });
    const app = await getApp();
    await request(app).post('/api/tar/create').send({
      source: '/data/files',
      destination: '/out/archive.tar.gz',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ compress: true }),
    );
  });

  it('forwards compress=false when specified', async () => {
    mockCreate.mockResolvedValue({ path: '/out/archive.tar', output: '' });
    const app = await getApp();
    await request(app).post('/api/tar/create').send({
      source: '/data/files',
      destination: '/out/archive.tar',
      compress: false,
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ compress: false }),
    );
  });

  it('returns 500 when createArchive rejects', async () => {
    mockCreate.mockRejectedValue(new Error('tar create failed (exit 1): no space left'));
    const app = await getApp();
    const res = await request(app).post('/api/tar/create').send({
      source: '/data/files',
      destination: '/out/archive.tar.gz',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/tar create failed/);
  });

  it('handles non-Error rejections gracefully', async () => {
    mockCreate.mockRejectedValue(42);
    const app = await getApp();
    const res = await request(app).post('/api/tar/create').send({
      source: '/data',
      destination: '/out/a.tar.gz',
    });
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// POST /api/tar/extract
// ---------------------------------------------------------------------------

describe('POST /api/tar/extract', () => {
  it('returns 400 when archive is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/tar/extract').send({ destination: '/out' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/archive and destination are required/);
  });

  it('returns 400 when destination is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/tar/extract').send({ archive: '/data/archive.tar.gz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/archive and destination are required/);
  });

  it('returns 200 with path on success', async () => {
    mockExtract.mockResolvedValue({ path: '/out', output: '' });
    const app = await getApp();
    const res = await request(app).post('/api/tar/extract').send({
      archive: '/data/archive.tar.gz',
      destination: '/out',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.path).toBe('/out');
  });

  it('returns 500 when extractArchive rejects', async () => {
    mockExtract.mockRejectedValue(new Error('tar extract failed (exit 2): corrupt archive'));
    const app = await getApp();
    const res = await request(app).post('/api/tar/extract').send({
      archive: '/data/archive.tar.gz',
      destination: '/out',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/tar extract failed/);
  });
});

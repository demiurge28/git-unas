import request from 'supertest';

// requireAuth gates every /api route; stub it so these route unit tests reach the handlers.
jest.mock('../src/middleware/requireAuth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void): void => next(),
}));

jest.mock('../src/services/encryptService', () => ({
  encryptFile: jest.fn(),
  decryptFile: jest.fn(),
}));

jest.mock('../src/services/scheduleService', () => ({
  loadConfig: jest.fn().mockReturnValue({ enabled: false, hour: 6, minute: 0, days: [], source: '', backupDir: '', keepCount: 7 }),
  startScheduler: jest.fn(),
}));

import { encryptFile, decryptFile } from '../src/services/encryptService';
const mockEncrypt = encryptFile as jest.MockedFunction<typeof encryptFile>;
const mockDecrypt = decryptFile as jest.MockedFunction<typeof decryptFile>;

async function getApp() {
  const { app } = await import('../src/server');
  return app;
}

beforeEach(() => {
  mockEncrypt.mockReset();
  mockDecrypt.mockReset();
});

// ---------------------------------------------------------------------------
// POST /api/encrypt/encrypt
// ---------------------------------------------------------------------------

describe('POST /api/encrypt/encrypt', () => {
  it('returns 400 when source is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/encrypt').send({
      destination: '/out/file.unas', passphrase: 'secret',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source, destination, and passphrase are required/);
  });

  it('returns 400 when destination is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/encrypt').send({
      source: '/data/file.tar.gz', passphrase: 'secret',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when passphrase is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/encrypt').send({
      source: '/data/file.tar.gz', destination: '/out/file.unas',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/passphrase/);
  });

  it('returns 200 with destination and bytesWritten on success', async () => {
    mockEncrypt.mockResolvedValue({ destination: '/out/file.unas', bytesWritten: 1234 });
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/encrypt').send({
      source: '/data/file.tar.gz',
      destination: '/out/file.unas',
      passphrase: 'hunter2',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.destination).toBe('/out/file.unas');
    expect(res.body.bytesWritten).toBe(1234);
  });

  it('forwards all three params to encryptFile', async () => {
    mockEncrypt.mockResolvedValue({ destination: '/out/file.unas', bytesWritten: 100 });
    const app = await getApp();
    await request(app).post('/api/encrypt/encrypt').send({
      source: '/data/file.tar.gz',
      destination: '/out/file.unas',
      passphrase: 'p@$$w0rd',
    });
    expect(mockEncrypt).toHaveBeenCalledWith({
      source: '/data/file.tar.gz',
      destination: '/out/file.unas',
      passphrase: 'p@$$w0rd',
    });
  });

  it('returns 500 when encryptFile rejects', async () => {
    mockEncrypt.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/encrypt').send({
      source: '/nonexistent',
      destination: '/out/file.unas',
      passphrase: 'secret',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ENOENT/);
  });

  it('handles non-Error rejections', async () => {
    mockEncrypt.mockRejectedValue({ code: 'ENOENT' });
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/encrypt').send({
      source: '/x', destination: '/y', passphrase: 's',
    });
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// POST /api/encrypt/decrypt
// ---------------------------------------------------------------------------

describe('POST /api/encrypt/decrypt', () => {
  it('returns 400 when any required field is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/decrypt').send({
      source: '/out/file.unas',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/passphrase/);
  });

  it('returns 200 with destination and bytesWritten on success', async () => {
    mockDecrypt.mockResolvedValue({ destination: '/out/file.tar.gz', bytesWritten: 800 });
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/decrypt').send({
      source: '/out/file.unas',
      destination: '/out/file.tar.gz',
      passphrase: 'hunter2',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.bytesWritten).toBe(800);
  });

  it('returns 500 when decryptFile rejects', async () => {
    mockDecrypt.mockRejectedValue(new Error('Not a git-unas encrypted file (bad magic bytes)'));
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/decrypt').send({
      source: '/out/bad.unas',
      destination: '/out/file.tar.gz',
      passphrase: 'secret',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/bad magic bytes/);
  });

  it('returns 500 with auth-tag error for wrong passphrase hint', async () => {
    mockDecrypt.mockRejectedValue(new Error('Unsupported state or unable to authenticate data'));
    const app = await getApp();
    const res = await request(app).post('/api/encrypt/decrypt').send({
      source: '/out/file.unas',
      destination: '/out/file.tar.gz',
      passphrase: 'wrongpass',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/authenticate/);
  });
});

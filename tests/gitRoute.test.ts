import request from 'supertest';

// requireAuth gates every /api route; stub it so these route unit tests reach the handlers.
jest.mock('../src/middleware/requireAuth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void): void => next(),
}));

jest.mock('../src/services/gitService', () => ({
  cloneRepository: jest.fn(),
}));

// Also mock scheduleService so server.ts can import without a real config file.
jest.mock('../src/services/scheduleService', () => ({
  loadConfig: jest.fn().mockReturnValue({ enabled: false, hour: 6, minute: 0, days: [], source: '', backupDir: '', keepCount: 7 }),
  startScheduler: jest.fn(),
}));

import { cloneRepository } from '../src/services/gitService';
const mockClone = cloneRepository as jest.MockedFunction<typeof cloneRepository>;

async function getApp() {
  const { app } = await import('../src/server');
  return app;
}

beforeEach(() => {
  mockClone.mockReset();
});

describe('POST /api/git/clone', () => {
  it('returns 400 when url is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/git/clone').send({ destination: '/mnt/nas/repo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url and destination are required/);
  });

  it('returns 400 when destination is missing', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/git/clone').send({ url: 'https://github.com/x/y.git' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url and destination are required/);
  });

  it('returns 400 when body is empty', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/git/clone').send({});
    expect(res.status).toBe(400);
  });

  it('returns 200 with result on success', async () => {
    mockClone.mockResolvedValue({ destination: '/mnt/nas/repo', output: 'Cloning into repo...' });
    const app = await getApp();
    const res = await request(app).post('/api/git/clone').send({
      url: 'https://github.com/x/y.git',
      destination: '/mnt/nas/repo',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.destination).toBe('/mnt/nas/repo');
    expect(res.body.output).toBe('Cloning into repo...');
  });

  it('passes the branch parameter to cloneRepository', async () => {
    mockClone.mockResolvedValue({ destination: '/mnt/nas/repo', output: '' });
    const app = await getApp();
    await request(app).post('/api/git/clone').send({
      url: 'https://github.com/x/y.git',
      destination: '/mnt/nas/repo',
      branch: 'main',
    });
    expect(mockClone).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'main' }),
    );
  });

  it('returns 500 with error message when cloneRepository rejects', async () => {
    mockClone.mockRejectedValue(new Error('git clone failed (exit 128): not found'));
    const app = await getApp();
    const res = await request(app).post('/api/git/clone').send({
      url: 'https://github.com/x/y.git',
      destination: '/mnt/nas/repo',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/git clone failed/);
  });

  it('handles non-Error rejections gracefully', async () => {
    mockClone.mockRejectedValue('string error');
    const app = await getApp();
    const res = await request(app).post('/api/git/clone').send({
      url: 'https://github.com/x/y.git',
      destination: '/mnt/nas/repo',
    });
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
  });
});

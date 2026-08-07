import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// requireAuth gates every /api route; stub it so these route unit tests reach the handlers.
jest.mock('../src/middleware/requireAuth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void): void => next(),
}));

jest.mock('../src/services/archiveService', () => ({
  loadArchiveConfig: jest.fn().mockReturnValue({
    githubToken: 'tok', baseDir: '/arc', defaultFrequency: 'daily',
    retentionDays: 30, encrypt: false, passphrase: '', entries: [],
  }),
  saveArchiveConfig: jest.fn(),
  maskedConfig: jest.fn((c) => ({ ...c, githubToken: c.githubToken ? '***' : '', passphrase: c.passphrase ? '***' : '' })),
  startArchiveScheduler: jest.fn(),
  stopArchiveScheduler: jest.fn(),
  runEntryNow: jest.fn().mockResolvedValue(undefined),
  runAllNow: jest.fn().mockResolvedValue(undefined),
  newEntryId: jest.fn().mockReturnValue('uuid-1234'),
  nextRunDate: jest.fn().mockReturnValue(new Date('2026-12-01T02:00:00Z')),
}));

jest.mock('../src/services/githubService', () => ({
  listUserOrgs: jest.fn().mockResolvedValue([{ id: 1, login: 'myorg', description: null }]),
  listOrgRepos: jest.fn().mockResolvedValue([{ name: 'repo-x', private: false, archived: false, description: null }]),
  listUserRepos: jest.fn().mockResolvedValue([{ name: 'my-repo', private: true, archived: false, description: null }]),
  validateToken: jest.fn().mockResolvedValue('demiurge28'),
}));

jest.mock('../src/services/scheduleService', () => ({
  loadConfig: jest.fn().mockReturnValue({ enabled: false, hour: 6, minute: 0, days: [], source: '', backupDir: '', keepCount: 7 }),
  startScheduler: jest.fn(),
}));

import {
  loadArchiveConfig,
  saveArchiveConfig,
  startArchiveScheduler,
  runEntryNow,
  runAllNow,
  newEntryId,
} from '../src/services/archiveService';

const mockLoadArchiveConfig = loadArchiveConfig as jest.MockedFunction<typeof loadArchiveConfig>;
const mockSaveArchiveConfig = saveArchiveConfig as jest.MockedFunction<typeof saveArchiveConfig>;
const mockRunEntryNow = runEntryNow as jest.MockedFunction<typeof runEntryNow>;
const mockRunAllNow = runAllNow as jest.MockedFunction<typeof runAllNow>;
const mockNewEntryId = newEntryId as jest.MockedFunction<typeof newEntryId>;

async function getApp() {
  const { app } = await import('../src/server');
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadArchiveConfig.mockReturnValue({
    githubToken: 'tok', baseDir: '/arc', defaultFrequency: 'daily',
    retentionDays: 30, encrypt: false, passphrase: '', entries: [],
  });
  mockNewEntryId.mockReturnValue('uuid-1234');
});

// ---------------------------------------------------------------------------
// GET /api/archive/config
// ---------------------------------------------------------------------------
describe('GET /api/archive/config', () => {
  it('returns 200 with masked config', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/archive/config');
    expect(res.status).toBe(200);
    expect(res.body.githubToken).toBe('***');
    expect(res.body.defaultFrequency).toBe('daily');
  });
});

// ---------------------------------------------------------------------------
// POST /api/archive/config
// ---------------------------------------------------------------------------
describe('POST /api/archive/config', () => {
  it('returns 400 for invalid defaultFrequency', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/config').send({ defaultFrequency: 'yearly' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/defaultFrequency/);
  });

  it('saves and returns masked config on success', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/config').send({
      githubToken: 'newtoken', baseDir: '/mnt/archives', defaultFrequency: 'weekly',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSaveArchiveConfig).toHaveBeenCalledTimes(1);
    expect(startArchiveScheduler).toHaveBeenCalledTimes(1);
  });

  it('preserves existing token when *** is sent', async () => {
    const app = await getApp();
    await request(app).post('/api/archive/config').send({ githubToken: '***' });
    const saved = mockSaveArchiveConfig.mock.calls[0]?.[0];
    expect(saved?.githubToken).toBe('tok'); // preserved from mock
  });
});

// ---------------------------------------------------------------------------
// POST /api/archive/config/validate-token
// ---------------------------------------------------------------------------
describe('POST /api/archive/config/validate-token', () => {
  it('returns valid=true with login on success', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/config/validate-token').send({ token: 'ghp_abc' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.login).toBe('demiurge28');
  });

  it('returns 400 when no token is available', async () => {
    mockLoadArchiveConfig.mockReturnValue({ ...mockLoadArchiveConfig(), githubToken: '' } as any);
    const app = await getApp();
    const res = await request(app).post('/api/archive/config/validate-token').send({});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/archive/orgs
// ---------------------------------------------------------------------------
describe('GET /api/archive/orgs', () => {
  it('returns 200 with orgs list', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/archive/orgs');
    expect(res.status).toBe(200);
    expect(res.body.orgs[0].login).toBe('myorg');
  });

  it('returns 400 when token is not configured', async () => {
    mockLoadArchiveConfig.mockReturnValueOnce({ ...mockLoadArchiveConfig(), githubToken: '' } as any);
    const app = await getApp();
    const res = await request(app).get('/api/archive/orgs');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/archive/repos
// ---------------------------------------------------------------------------
describe('GET /api/archive/repos', () => {
  it('returns org repos when ?org= is supplied', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/archive/repos?org=myorg');
    expect(res.status).toBe(200);
    expect(res.body.repos[0].name).toBe('repo-x');
  });

  it('returns user repos when no ?org is supplied', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/archive/repos');
    expect(res.status).toBe(200);
    expect(res.body.repos[0].name).toBe('my-repo');
  });
});

// ---------------------------------------------------------------------------
// GET /api/archive/status
// ---------------------------------------------------------------------------
describe('GET /api/archive/status', () => {
  it('returns entries with nextRun', async () => {
    mockLoadArchiveConfig.mockReturnValue({
      githubToken: 'tok', baseDir: '/arc', defaultFrequency: 'daily',
      encrypt: false, passphrase: '', retentionDays: 30,
      entries: [{ id: 'e1', type: 'repo', owner: 'acme', repo: 'api', includeRepos: [], excludeRepos: [], frequency: null, retentionDays: null, enabled: true, lastRun: null, lastStatus: null, lastMessage: null }],
    });
    const app = await getApp();
    const res = await request(app).get('/api/archive/status');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].nextRun).not.toBeNull();
    expect(res.body.defaultFrequency).toBe('daily');
  });
});

// ---------------------------------------------------------------------------
// POST /api/archive/entries
// ---------------------------------------------------------------------------
describe('POST /api/archive/entries', () => {
  it('returns 400 for invalid type', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/entries').send({ type: 'bad', owner: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when repo is missing for type=repo', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/entries').send({ type: 'repo', owner: 'x' });
    expect(res.status).toBe(400);
  });

  it('creates a repo entry with generated id', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/entries').send({
      type: 'repo', owner: 'acme', repo: 'api', frequency: 'weekly',
    });
    expect(res.status).toBe(201);
    expect(res.body.entry.id).toBe('uuid-1234');
    expect(res.body.entry.type).toBe('repo');
    expect(res.body.entry.owner).toBe('acme');
    expect(res.body.entry.frequency).toBe('weekly');
  });

  it('creates an org entry with includeRepos=["*"] by default', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/entries').send({
      type: 'org', owner: 'myorg',
    });
    expect(res.status).toBe(201);
    expect(res.body.entry.includeRepos).toEqual(['*']);
  });

  it('returns 400 for invalid frequency', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/entries').send({
      type: 'repo', owner: 'x', repo: 'y', frequency: 'annually',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/archive/entries/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/archive/entries/:id', () => {
  it('returns 404 for unknown id', async () => {
    mockLoadArchiveConfig.mockReturnValue({ ...mockLoadArchiveConfig(), entries: [] } as any);
    const app = await getApp();
    const res = await request(app).patch('/api/archive/entries/no-such').send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('updates the entry and restarts scheduler', async () => {
    const entry = { id: 'e1', type: 'repo', owner: 'x', repo: 'y', includeRepos: [], excludeRepos: [], frequency: null, retentionDays: null, enabled: true, lastRun: null, lastStatus: null, lastMessage: null };
    const cfg = { ...mockLoadArchiveConfig(), entries: [entry] };
    mockLoadArchiveConfig.mockReturnValue(cfg as any);
    const app = await getApp();
    const res = await request(app).patch('/api/archive/entries/e1').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.entry.enabled).toBe(false);
    expect(mockSaveArchiveConfig).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/archive/entries/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/archive/entries/:id', () => {
  it('returns 404 for unknown id', async () => {
    mockLoadArchiveConfig.mockReturnValue({ ...mockLoadArchiveConfig(), entries: [] } as any);
    const app = await getApp();
    const res = await request(app).delete('/api/archive/entries/no-such');
    expect(res.status).toBe(404);
  });

  it('removes entry and saves config', async () => {
    const entry = { id: 'e1', type: 'repo', owner: 'x', repo: 'y', includeRepos: [], excludeRepos: [], frequency: null, retentionDays: null, enabled: true, lastRun: null, lastStatus: null, lastMessage: null };
    const cfg = { ...mockLoadArchiveConfig(), entries: [entry] };
    mockLoadArchiveConfig.mockReturnValue(cfg as any);
    const app = await getApp();
    const res = await request(app).delete('/api/archive/entries/e1');
    expect(res.status).toBe(200);
    expect(mockSaveArchiveConfig).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/archive/run
// ---------------------------------------------------------------------------
describe('POST /api/archive/run', () => {
  it('calls runAllNow and returns success', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/archive/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRunAllNow).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/archive/run/:id
// ---------------------------------------------------------------------------
describe('POST /api/archive/run/:id', () => {
  it('calls runEntryNow with the correct id', async () => {
    mockLoadArchiveConfig.mockReturnValue({
      ...mockLoadArchiveConfig(),
      entries: [{ id: 'e1', type: 'repo', owner: 'x', repo: 'y', includeRepos: [], excludeRepos: [], frequency: null, retentionDays: null, enabled: true, lastRun: null, lastStatus: null, lastMessage: null }],
    } as any);
    const app = await getApp();
    const res = await request(app).post('/api/archive/run/e1').send({});
    expect(res.status).toBe(200);
    expect(mockRunEntryNow).toHaveBeenCalledWith('e1');
  });

  it('returns 500 when runEntryNow throws', async () => {
    mockRunEntryNow.mockRejectedValueOnce(new Error('no entry'));
    const app = await getApp();
    const res = await request(app).post('/api/archive/run/bad-id').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/no entry/);
  });
});

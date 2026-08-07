import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// requireAuth gates every /api route; stub it so these route unit tests reach the handlers.
jest.mock('../src/middleware/requireAuth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void): void => next(),
}));

let tmpDir: string;
let cfgPath: string;
let mockFetch: jest.Mock;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-slack-route-'));
  cfgPath = path.join(tmpDir, 'slack.json');
  process.env.SLACK_CONFIG_PATH = cfgPath;
  jest.resetModules();
  mockFetch = jest.fn();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SLACK_CONFIG_PATH;
  jest.resetModules();
});

async function getApp() {
  const { app } = await import('../src/server');
  return app;
}

const WEBHOOK = 'https://hooks.slack.com/services/T/B/xyz';

function writeConfig(cfg: unknown) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
}

describe('GET /api/slack', () => {
  it('returns masked config with defaults', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/slack');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      notifyOnSuccess: true,
      notifyOnFailure: true,
      webhookSet: false,
    });
    expect(res.body).not.toHaveProperty('webhookUrl');
  });
});

describe('POST /api/slack', () => {
  it('saves config and reports webhookSet', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/slack').send({
      enabled: true,
      webhookUrl: WEBHOOK,
      notifyOnSuccess: true,
      notifyOnFailure: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.config.webhookSet).toBe(true);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(saved.webhookUrl).toBe(WEBHOOK);
    expect(saved.notifyOnFailure).toBe(false);
  });

  it('preserves the stored webhook when a blank one is submitted', async () => {
    writeConfig({ enabled: true, webhookUrl: WEBHOOK, notifyOnSuccess: true, notifyOnFailure: true });
    const app = await getApp();
    const res = await request(app).post('/api/slack').send({ enabled: false });
    expect(res.status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(saved.webhookUrl).toBe(WEBHOOK);
    expect(saved.enabled).toBe(false);
  });

  it('rejects enabling without any webhook', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/slack').send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it('rejects a non-Slack webhook URL', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/slack').send({ webhookUrl: 'https://evil.example.com/x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/slack/test', () => {
  it('sends a test message using the stored webhook', async () => {
    writeConfig({ enabled: true, webhookUrl: WEBHOOK, notifyOnSuccess: true, notifyOnFailure: true });
    mockFetch.mockResolvedValue({ ok: true });
    const app = await getApp();
    const res = await request(app).post('/api/slack/test').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when no webhook is configured', async () => {
    const app = await getApp();
    const res = await request(app).post('/api/slack/test').send({});
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 502 when Slack rejects the message', async () => {
    writeConfig({ enabled: true, webhookUrl: WEBHOOK, notifyOnSuccess: true, notifyOnFailure: true });
    mockFetch.mockResolvedValue({ ok: false });
    const app = await getApp();
    const res = await request(app).post('/api/slack/test').send({});
    expect(res.status).toBe(502);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let cfgPath: string;
let mockFetch: jest.Mock;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-slack-'));
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

async function load() {
  return import('../src/services/notifyService');
}

function writeConfig(cfg: unknown) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
}

describe('config persistence', () => {
  it('returns defaults when no file exists', async () => {
    const n = await load();
    expect(n.loadSlackConfig()).toEqual({
      enabled: false,
      webhookUrl: '',
      notifyOnSuccess: true,
      notifyOnFailure: true,
    });
  });

  it('saves and reloads config', async () => {
    const n = await load();
    n.saveSlackConfig({
      enabled: true,
      webhookUrl: 'https://hooks.slack.com/services/abc',
      notifyOnSuccess: false,
      notifyOnFailure: true,
    });
    expect(n.loadSlackConfig()).toEqual({
      enabled: true,
      webhookUrl: 'https://hooks.slack.com/services/abc',
      notifyOnSuccess: false,
      notifyOnFailure: true,
    });
  });

  it('masks the webhook URL to a boolean', async () => {
    const n = await load();
    const masked = n.maskedSlackConfig({
      enabled: true,
      webhookUrl: 'https://hooks.slack.com/services/abc',
      notifyOnSuccess: true,
      notifyOnFailure: true,
    });
    expect(masked).toEqual({
      enabled: true,
      notifyOnSuccess: true,
      notifyOnFailure: true,
      webhookSet: true,
    });
    expect(masked).not.toHaveProperty('webhookUrl');
    expect(
      n.maskedSlackConfig({ enabled: false, webhookUrl: '', notifyOnSuccess: true, notifyOnFailure: true })
        .webhookSet,
    ).toBe(false);
  });
});

describe('classifyStatus', () => {
  it('maps statuses onto categories', async () => {
    const n = await load();
    expect(n.classifyStatus('ok')).toBe('success');
    expect(n.classifyStatus('success')).toBe('success');
    expect(n.classifyStatus('error')).toBe('failure');
    expect(n.classifyStatus('failed')).toBe('failure');
    expect(n.classifyStatus('partial')).toBe('failure');
    expect(n.classifyStatus('skipped')).toBe('ignored');
    expect(n.classifyStatus('no-change')).toBe('ignored');
    expect(n.classifyStatus('whatever')).toBe('ignored');
  });
});

describe('notifyRun gating', () => {
  it('does nothing when disabled', async () => {
    writeConfig({ enabled: false, webhookUrl: 'https://hooks.slack.com/services/x', notifyOnSuccess: true, notifyOnFailure: true });
    const n = await load();
    await n.notifyRun('GitHub Archive', { status: 'ok' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts a success message when enabled and notifyOnSuccess', async () => {
    writeConfig({ enabled: true, webhookUrl: 'https://hooks.slack.com/services/x', notifyOnSuccess: true, notifyOnFailure: true });
    mockFetch.mockResolvedValue({ ok: true });
    const n = await load();
    await n.notifyRun('GitHub Archive', { status: 'ok', message: 'done', durationMs: 1500 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/x');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.text).toContain('GitHub Archive');
    expect(body.text).toContain('succeeded');
    expect(body.text).toContain('done');
  });

  it('suppresses success when notifyOnSuccess is false', async () => {
    writeConfig({ enabled: true, webhookUrl: 'https://hooks.slack.com/services/x', notifyOnSuccess: false, notifyOnFailure: true });
    const n = await load();
    await n.notifyRun('GitHub Archive', { status: 'ok' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts a failure message when notifyOnFailure', async () => {
    writeConfig({ enabled: true, webhookUrl: 'https://hooks.slack.com/services/x', notifyOnSuccess: false, notifyOnFailure: true });
    mockFetch.mockResolvedValue({ ok: true });
    const n = await load();
    await n.notifyRun('Fly Volume Backup', { status: 'partial', message: '1 failed' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.text).toContain('failed');
  });

  it('ignores skipped/no-change statuses', async () => {
    writeConfig({ enabled: true, webhookUrl: 'https://hooks.slack.com/services/x', notifyOnSuccess: true, notifyOnFailure: true });
    const n = await load();
    await n.notifyRun('Bitwarden Archive', { status: 'skipped' });
    await n.notifyRun('Fly Archive', { status: 'no-change' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never throws when the webhook post fails', async () => {
    writeConfig({ enabled: true, webhookUrl: 'https://hooks.slack.com/services/x', notifyOnSuccess: true, notifyOnFailure: true });
    mockFetch.mockRejectedValue(new Error('network down'));
    const n = await load();
    await expect(n.notifyRun('GitHub Archive', { status: 'ok' })).resolves.toBeUndefined();
  });
});

describe('postSlack', () => {
  it('returns false and does not fetch when no URL', async () => {
    const n = await load();
    await expect(n.postSlack('hi', '')).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns true on a 2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const n = await load();
    await expect(n.postSlack('hi', 'https://hooks.slack.com/services/x')).resolves.toBe(true);
  });

  it('returns false when fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    const n = await load();
    await expect(n.postSlack('hi', 'https://hooks.slack.com/services/x')).resolves.toBe(false);
  });
});

describe('sendTestMessage', () => {
  it('posts a test message to the given webhook', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const n = await load();
    await expect(n.sendTestMessage('https://hooks.slack.com/services/x')).resolves.toBe(true);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.text).toContain('test notification');
  });
});

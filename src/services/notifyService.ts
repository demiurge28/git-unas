import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackConfig {
  enabled: boolean;
  /** Slack Incoming Webhook URL. Empty string = not configured. */
  webhookUrl: string;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

/** Normalized outcome category derived from a service's status enum. */
export type RunOutcomeCategory = 'success' | 'failure' | 'ignored';

export interface RunOutcomeInput {
  status: string;
  message?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.SLACK_CONFIG_PATH ?? path.join(process.cwd(), 'config', 'slack-config.json');

const DEFAULT_CONFIG: SlackConfig = {
  enabled: false,
  webhookUrl: '',
  notifyOnSuccess: true,
  notifyOnFailure: true,
};

export function loadSlackConfig(): SlackConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return {
        ...DEFAULT_CONFIG,
        ...(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<SlackConfig>),
      };
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_CONFIG };
}

export function saveSlackConfig(config: SlackConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Config safe for API responses — the webhook URL is redacted to a boolean. */
export function maskedSlackConfig(
  config: SlackConfig,
): Omit<SlackConfig, 'webhookUrl'> & { webhookSet: boolean } {
  return {
    enabled: config.enabled,
    notifyOnSuccess: config.notifyOnSuccess,
    notifyOnFailure: config.notifyOnFailure,
    webhookSet: config.webhookUrl !== '',
  };
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

const SUCCESS_STATUSES = new Set(['ok', 'success']);
const FAILURE_STATUSES = new Set(['error', 'failed', 'partial']);

/** Map a service run status onto a notification category. */
export function classifyStatus(status: string): RunOutcomeCategory {
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (FAILURE_STATUSES.has(status)) return 'failure';
  return 'ignored'; // skipped, no-change, unknown → no notification
}

// ---------------------------------------------------------------------------
// Slack posting
// ---------------------------------------------------------------------------

const POST_TIMEOUT_MS = 8000;

/**
 * POST a plain-text message to a Slack Incoming Webhook.
 * Best-effort: returns false (never throws) on any error or timeout.
 */
export async function postSlack(text: string, webhookUrl?: string): Promise<boolean> {
  const url = webhookUrl ?? loadSlackConfig().webhookUrl;
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * Emit a Slack notification for a completed job run, honoring the enable flag
 * and the success/failure toggles. Fully best-effort and swallowed — safe to
 * call (fire-and-forget) from any job path without affecting it.
 */
export async function notifyRun(service: string, outcome: RunOutcomeInput): Promise<void> {
  try {
    const config = loadSlackConfig();
    if (!config.enabled || !config.webhookUrl) return;

    const category = classifyStatus(outcome.status);
    if (category === 'ignored') return;
    if (category === 'success' && !config.notifyOnSuccess) return;
    if (category === 'failure' && !config.notifyOnFailure) return;

    const icon = category === 'success' ? ':white_check_mark:' : ':x:';
    const verb = category === 'success' ? 'succeeded' : 'failed';
    const dur = fmtDuration(outcome.durationMs);

    const parts = [`${icon} *git-unas* (${os.hostname()}) — ${service} ${verb}`];
    if (outcome.message) parts.push(`— ${outcome.message}`);
    if (dur) parts.push(`(${dur})`);

    await postSlack(parts.join(' '), config.webhookUrl);
  } catch {
    // Never let a notification failure affect the calling job.
  }
}

/** Send a fixed test message using the current (or a provided) webhook URL. */
export async function sendTestMessage(webhookUrl?: string): Promise<boolean> {
  return postSlack(`:bell: *git-unas* (${os.hostname()}) — test notification`, webhookUrl);
}

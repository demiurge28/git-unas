import { Router, Request, Response } from 'express';
import {
  loadSlackConfig,
  saveSlackConfig,
  maskedSlackConfig,
  sendTestMessage,
  type SlackConfig,
} from '../services/notifyService';

export const slackRouter = Router();

function isSlackWebhook(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\//.test(url);
}

// GET /api/slack — masked config (webhook URL redacted to a boolean)
slackRouter.get('/', (_req: Request, res: Response) => {
  res.json(maskedSlackConfig(loadSlackConfig()));
});

// POST /api/slack — save config; the stored webhook is preserved unless a new
// non-empty value is supplied (the UI sends blank when it hasn't changed).
slackRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as Partial<SlackConfig>;
  const current = loadSlackConfig();

  let webhookUrl = current.webhookUrl;
  if (typeof body.webhookUrl === 'string' && body.webhookUrl.trim() !== '') {
    webhookUrl = body.webhookUrl.trim();
  }

  if (webhookUrl && !isSlackWebhook(webhookUrl)) {
    res.status(400).json({
      error: 'webhookUrl must be a Slack Incoming Webhook (https://hooks.slack.com/...)',
    });
    return;
  }

  const updated: SlackConfig = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    webhookUrl,
    notifyOnSuccess:
      typeof body.notifyOnSuccess === 'boolean' ? body.notifyOnSuccess : current.notifyOnSuccess,
    notifyOnFailure:
      typeof body.notifyOnFailure === 'boolean' ? body.notifyOnFailure : current.notifyOnFailure,
  };

  if (updated.enabled && !updated.webhookUrl) {
    res.status(400).json({ error: 'A webhook URL is required to enable notifications' });
    return;
  }

  saveSlackConfig(updated);
  res.json({ success: true, config: maskedSlackConfig(updated) });
});

// POST /api/slack/test — send a test message using the supplied or stored webhook
slackRouter.post('/test', async (req: Request, res: Response) => {
  const body = req.body as { webhookUrl?: string };
  const override =
    typeof body.webhookUrl === 'string' && body.webhookUrl.trim() !== ''
      ? body.webhookUrl.trim()
      : undefined;
  const webhookUrl = override ?? loadSlackConfig().webhookUrl;

  if (!webhookUrl) {
    res.status(400).json({ error: 'No webhook URL configured' });
    return;
  }
  if (!isSlackWebhook(webhookUrl)) {
    res.status(400).json({ error: 'webhookUrl must be a Slack Incoming Webhook URL' });
    return;
  }

  const ok = await sendTestMessage(webhookUrl);
  if (ok) {
    res.json({ success: true });
  } else {
    res.status(502).json({ error: 'Slack did not accept the message (check the webhook URL)' });
  }
});

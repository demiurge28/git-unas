import { Router, Request, Response } from 'express';
import {
  loadConfig,
  saveConfig,
  startScheduler,
  listBackups,
  getLastRun,
  nextRunDate,
  runBackup,
  recordScheduleOutcome,
  type ScheduleConfig,
  type DayOfWeek,
} from '../services/scheduleService';

export const scheduleRouter = Router();

const VALID_DAYS: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// GET /api/schedule
scheduleRouter.get('/', (_req: Request, res: Response) => {
  const config = loadConfig();
  const next = nextRunDate(config);
  const backups = listBackups(config.backupDir);
  const lastRun = getLastRun();

  res.json({
    config,
    nextRun: next ? next.toISOString() : null,
    lastRun,
    backups,
  });
});

// POST /api/schedule  — update config and restart scheduler
scheduleRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as Partial<ScheduleConfig> & { enabled?: boolean };

  const current = loadConfig();

  const hour = Number(body.hour ?? current.hour);
  const minute = Number(body.minute ?? current.minute);

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    res.status(400).json({ error: 'hour must be 0–23' });
    return;
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    res.status(400).json({ error: 'minute must be 0–59' });
    return;
  }

  const days: DayOfWeek[] = Array.isArray(body.days)
    ? body.days.filter((d): d is DayOfWeek => VALID_DAYS.includes(d as DayOfWeek))
    : current.days;

  const keepCount = Number(body.keepCount ?? current.keepCount);
  if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > 365) {
    res.status(400).json({ error: 'keepCount must be 1–365' });
    return;
  }

  const updated: ScheduleConfig = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    hour,
    minute,
    days,
    source: typeof body.source === 'string' ? body.source : current.source,
    backupDir: typeof body.backupDir === 'string' ? body.backupDir : current.backupDir,
    keepCount,
  };

  saveConfig(updated);
  startScheduler(updated);

  const next = nextRunDate(updated);
  res.json({
    success: true,
    config: updated,
    nextRun: next ? next.toISOString() : null,
  });
});

// POST /api/schedule/run  — trigger an immediate backup
scheduleRouter.post('/run', async (_req: Request, res: Response) => {
  const config = loadConfig();
  try {
    const dest = await runBackup(config);
    const backups = listBackups(config.backupDir);
    recordScheduleOutcome('ok', `Backup written to ${dest}`);
    res.json({ success: true, destination: dest, backups });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordScheduleOutcome('error', message);
    res.status(500).json({ error: message });
  }
});

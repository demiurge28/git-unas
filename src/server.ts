import express from 'express';
import path from 'path';
import session from 'express-session';
import { gitRouter } from './routes/git';
import { tarRouter } from './routes/tar';
import { encryptRouter } from './routes/encrypt';
import { scheduleRouter } from './routes/schedule';
import { archiveRouter } from './routes/archive';
import { bitwardenRouter } from './routes/bitwarden';
import { flyRouter } from './routes/fly';
import { browseRouter } from './routes/browse';
import { authRouter } from './routes/auth';
import { slackRouter } from './routes/slack';
import { requireAuth } from './middleware/requireAuth';
import { loadConfig, startScheduler } from './services/scheduleService';
import { loadArchiveConfig, startArchiveScheduler } from './services/archiveService';
import { loadBwArchiveConfig, startBwArchiveScheduler } from './services/bitwardenArchiveService';
import { loadFlyArchiveConfig, startFlyArchiveScheduler } from './services/flyArchiveService';
import { loadFlyVolBackupConfig, startFlyVolBackupScheduler } from './services/flyVolBackupService';
import pkgJson from '../package.json';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 7892;
const AUTH_SECRET = process.env.AUTH_SECRET ?? 'change-me-in-production';

app.use(express.json());

// Session middleware
app.use(session({
  secret: AUTH_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// Auth routes (unprotected — login/setup/me)
app.use('/api/auth', authRouter);

// All other /api/* routes require authentication
app.use('/api', requireAuth);

// API routes
app.use('/api/git', gitRouter);
app.use('/api/tar', tarRouter);
app.use('/api/encrypt', encryptRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/archive', archiveRouter);

// Health check
app.get('/api/status', (_req, res) => {
  res.json({ status: 'ok', version: pkgJson.version });
});

app.use('/api/bitwarden', bitwardenRouter);
app.use('/api/fly', flyRouter);
app.use('/api/browse', browseRouter);
app.use('/api/slack', slackRouter);

// Serve admin UI
// PUBLIC_DIR env var overrides the default (set in /etc/default/git-unas when installed as .deb)
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

export { app };

if (require.main === module) {
  // Auto-start schedulers from persisted config
  startScheduler(loadConfig());
  startArchiveScheduler(loadArchiveConfig());
  startBwArchiveScheduler(loadBwArchiveConfig());
  startFlyArchiveScheduler(loadFlyArchiveConfig());
  startFlyVolBackupScheduler(loadFlyVolBackupConfig());

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`git-unas admin server listening on http://127.0.0.1:${PORT}`);
  });
}

/**
 * Entry point — boots the HTTP server (ingest + graph viewer) and cron jobs.
 */
import 'dotenv/config';

process.on('uncaughtException', (err) => console.error('[FATAL] Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL] Unhandled rejection:', reason));

const PORT = process.env.PORT || 3000;

const { createServer } = await import('./src/server.js');
const { startCron } = await import('./src/cron.js');

const recommended = ['DATABASE_URL', 'VOYAGE_API_KEY', 'VIEWER_TOKEN', 'THOUGHTS_INGEST_SECRET'];
const missing = recommended.filter(k => !process.env[k]);
if (missing.length) console.warn(`[Startup] Missing env vars: ${missing.join(', ')} — some features may be limited`);

const app = createServer();
app.listen(PORT, () => {
  console.log(`🧠 Thoughts running on port ${PORT}`);
  console.log(`   Viewer:  http://localhost:${PORT}/?token=YOUR_VIEWER_TOKEN`);
  console.log(`   Ingest:  POST http://localhost:${PORT}/api/ingest  (x-ingest-secret)`);
  startCron();
});

async function shutdown(signal) {
  console.log(`[Shutdown] ${signal} — cleaning up...`);
  try { const { closePool } = await import('./src/db.js'); await closePool(); }
  catch (e) { console.error('[Shutdown]', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * HTTP server: ingest endpoint (shared-secret), graph API + static viewer
 * (token-gated, since it's personal data), and a health probe.
 */
import express from 'express';
import crypto from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { ingestIdea } from './ingest.js';
import { getGraph } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

/** Constant-time string compare; false if either side is empty. */
function safeEqual(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function viewerToken(req) {
  return req.query.token || req.headers['x-viewer-token'] || req.cookies?.viewer_token;
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: CONFIG.MAX_INGEST_BODY }));

  // --- Health ---
  // Shallow (default) stays open + fast for probes; ?deep=1 exposes personal
  // metadata (counts, timestamps) so it requires the viewer token.
  app.get('/health', async (req, res) => {
    if (req.query.deep !== '1') return res.json({ status: 'ok', uptime: process.uptime() });
    if (process.env.VIEWER_TOKEN && !safeEqual(viewerToken(req), process.env.VIEWER_TOKEN)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const { collectDeepHealth, summarizeHealth } = await import('./health.js');
      const checks = await collectDeepHealth();
      res.json({ status: summarizeHealth(checks), uptime: process.uptime(), checks });
    } catch (e) {
      res.status(500).json({ status: 'down', error: e.message });
    }
  });

  // --- Ingest (reminder-bot -> here). Shared-secret, NOT the viewer token. ---
  app.post('/api/ingest', async (req, res) => {
    const secret = req.headers['x-ingest-secret'];
    if (!safeEqual(secret, process.env.THOUGHTS_INGEST_SECRET)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    try {
      const result = await ingestIdea(req.body || {});
      res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      console.error('[Ingest] error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- Token gate for the viewer + graph data ---
  const gate = (req, res, next) => {
    if (!process.env.VIEWER_TOKEN) return next(); // unset = open (local dev)
    if (safeEqual(viewerToken(req), process.env.VIEWER_TOKEN)) return next();
    res.status(403).send('Forbidden — append ?token=YOUR_VIEWER_TOKEN to the URL.');
  };

  // On-demand recompute of clusters + heat (token-gated). The viewer's refresh
  // button hits this so hot spots can be regenerated immediately. Pass ?label=1
  // to also (re)label clusters via Claude (slower, makes extra API calls).
  app.post('/api/recompute', gate, async (req, res) => {
    try {
      const { recomputeAllClusters } = await import('./clustering.js');
      await recomputeAllClusters();
      if (req.query.label === '1' && process.env.ANTHROPIC_API_KEY) {
        const { labelAllClusters } = await import('./labeler.js');
        await labelAllClusters();
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[Recompute] error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // On-demand entity + typed-relationship enrichment (token-gated). No-op without
  // an ANTHROPIC_API_KEY. Returns once the pending batch is processed.
  app.post('/api/enrich', gate, async (req, res) => {
    try {
      const { enrichAll } = await import('./enrich.js');
      await enrichAll(req.query.limit ? parseInt(req.query.limit) : 50);
      res.json({ ok: true });
    } catch (e) {
      console.error('[Enrich] error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Aggregated system status for the viewer's "full green light" pill. Probes
  // the reminder-bot server-side (no browser CORS) and caches briefly so viewer
  // polling stays cheap.
  let statusCache = { at: 0, payload: null };
  app.get('/api/status', gate, async (req, res) => {
    try {
      if (statusCache.payload && Date.now() - statusCache.at < 20000) {
        return res.json(statusCache.payload);
      }
      const { collectDeepHealth, statusFromChecks, probeBotHealth } = await import('./health.js');
      const [checks, bot] = await Promise.all([
        collectDeepHealth(),
        probeBotHealth(process.env.BOT_HEALTH_URL),
      ]);
      const payload = { generatedAt: new Date().toISOString(), ...statusFromChecks(checks, bot) };
      statusCache = { at: Date.now(), payload };
      res.json(payload);
    } catch (e) {
      console.error('[Status] error:', e.message);
      res.status(500).json({ overall: 'unknown', error: e.message });
    }
  });

  // Delete all data for a chat thread (token-gated owner maintenance).
  app.post('/api/forget', gate, async (req, res) => {
    const chat = req.query.chat;
    if (!chat) return res.status(400).json({ ok: false, error: 'missing ?chat=' });
    try {
      const { forgetChat } = await import('./db.js');
      res.json({ ok: true, ...(await forgetChat(chat)) });
    } catch (e) {
      console.error('[Forget] error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/graph', gate, async (req, res) => {
    try {
      const data = await getGraph({
        chatId: req.query.chat || null,
        limit: req.query.limit ? parseInt(req.query.limit) : CONFIG.GRAPH_DEFAULT_LIMIT,
        minWeight: req.query.minWeight ? parseFloat(req.query.minWeight) : 0,
        since: req.query.since || null,
      });
      res.json(data);
    } catch (e) {
      console.error('[Graph] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Static assets (JS/CSS contain no data) are public; index is gated.
  app.get('/', gate, (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  return app;
}

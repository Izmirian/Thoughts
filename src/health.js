/**
 * Health checks — the data behind the viewer's "full green light" status.
 * collectDeepHealth() gathers raw signals (IO); summarizeHealth() and
 * statusFromChecks() are pure so the severity rules are unit-testable;
 * probeBotHealth() asks the reminder-bot how it's doing (server-side, so the
 * browser never needs a cross-origin call).
 */
import { pingDb, getFreshness, hasPgvector } from './db.js';
import { EMBEDDING_PROVIDER, EMBEDDING_MODEL } from './embeddings.js';

export const STALE_DAYS = 7; // no ideas for this long -> "degraded" freshness

/** Gather raw health signals. Never throws; failures land in the check payloads. */
export async function collectDeepHealth() {
  const checks = {};

  const t0 = Date.now();
  try {
    await pingDb();
    checks.db = { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    checks.db = { ok: false, error: e.message };
  }

  checks.pgvector = checks.db.ok ? await hasPgvector() : { ok: false, skipped: 'db down' };

  const keyForProvider = EMBEDDING_PROVIDER === 'openai' ? process.env.OPENAI_API_KEY
    : EMBEDDING_PROVIDER === 'local' ? 'local'
    : process.env.VOYAGE_API_KEY;
  checks.embeddings = { configured: !!keyForProvider, provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL };
  checks.anthropic = { configured: !!process.env.ANTHROPIC_API_KEY };

  if (checks.db.ok) {
    try {
      const f = await getFreshness();
      checks.ideas = { count: f.ideaCount, lastIngestAt: f.lastIngestAt };
      checks.clusters = { count: f.clusterCount, lastRecomputeAt: f.lastRecomputeAt };
    } catch (e) {
      checks.ideas = { count: null, error: e.message };
      checks.clusters = { count: null };
    }
  } else {
    checks.ideas = { count: null, skipped: 'db down' };
    checks.clusters = { count: null, skipped: 'db down' };
  }

  return checks;
}

/** Pure: overall service status from the deep checks. */
export function summarizeHealth(checks, now = Date.now()) {
  if (!checks?.db?.ok) return 'down';
  if (checks.pgvector && checks.pgvector.ok === false) return 'down';
  if (!checks.embeddings?.configured || !checks.anthropic?.configured) return 'degraded';
  const last = checks.ideas?.lastIngestAt ? Date.parse(checks.ideas.lastIngestAt) : null;
  // Staleness only counts once the graph has content: an empty brand-new
  // instance is healthy, a graph that stopped receiving ideas may be broken.
  if (checks.ideas?.count > 0 && last && (now - last) > STALE_DAYS * 86400000) return 'degraded';
  return 'ok';
}

/**
 * Pure: build the viewer's /api/status services map from the deep checks + the
 * bot probe. Statuses: ok | warn | down | unknown.
 */
export function statusFromChecks(checks, bot, now = Date.now()) {
  const services = {};

  services.graph = { status: 'ok', detail: `up ${Math.floor(process.uptime() / 3600)}h` };

  services.db = checks.db.ok
    ? { status: 'ok', detail: `${checks.db.latencyMs}ms${checks.pgvector?.ok ? ' · pgvector' : ''}` }
    : { status: 'down', detail: checks.db.error || 'unreachable' };
  if (checks.db.ok && checks.pgvector && checks.pgvector.ok === false) {
    services.db = { status: 'down', detail: 'pgvector extension missing' };
  }

  services.embeddings = checks.embeddings.configured
    ? { status: 'ok', detail: `${checks.embeddings.provider} · ${checks.embeddings.model}` }
    : { status: 'warn', detail: `${checks.embeddings.provider}: no API key — ideas won't link` };

  services.ai = checks.anthropic.configured
    ? { status: 'ok', detail: 'Anthropic configured' }
    : { status: 'warn', detail: 'no key — labels/enrichment off' };

  const last = checks.ideas?.lastIngestAt ? Date.parse(checks.ideas.lastIngestAt) : null;
  if (checks.ideas?.count === 0) {
    services.freshness = { status: 'ok', detail: 'no ideas yet — send one!' };
  } else if (last && (now - last) > STALE_DAYS * 86400000) {
    services.freshness = { status: 'warn', detail: `last idea ${Math.floor((now - last) / 86400000)}d ago · ${checks.ideas.count} ideas`, lastIngestAt: checks.ideas.lastIngestAt };
  } else {
    services.freshness = { status: 'ok', detail: `${checks.ideas?.count ?? '?'} ideas`, lastIngestAt: checks.ideas?.lastIngestAt || null };
  }

  services.bot = bot;

  // Overall = worst row, with `unknown` capped at warn (local dev shouldn't look broken).
  const rank = { ok: 0, unknown: 1, warn: 1, down: 2 };
  let worst = 0;
  for (const s of Object.values(services)) worst = Math.max(worst, rank[s.status] ?? 1);
  const overall = worst === 2 ? 'down' : worst === 1 ? 'warn' : 'ok';

  return { overall, services };
}

/** Probe the reminder-bot's health endpoint (server-side; no browser CORS). */
export async function probeBotHealth(url) {
  if (!url) return { status: 'unknown', detail: 'BOT_HEALTH_URL not set' };
  const base = url.replace(/\/$/, '');
  for (const path of ['/health', '/']) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      const parts = [];
      if (typeof body.uptime === 'number') parts.push(`up ${Math.floor(body.uptime / 3600)}h`);
      if (body.checks?.db) parts.push(body.checks.db.ok ? 'db ok' : 'db DOWN');
      if (body.checks?.thoughts?.lastForwardOk) parts.push('forwarding ok');
      const botDegraded = body.status && body.status !== 'ok';
      const dbDown = body.checks?.db && !body.checks.db.ok;
      return {
        status: dbDown || botDegraded ? 'warn' : 'ok',
        detail: parts.join(' · ') || 'reachable',
        uptime: body.uptime,
      };
    } catch { /* try next path / fall through */ }
  }
  return { status: 'down', detail: 'unreachable' };
}

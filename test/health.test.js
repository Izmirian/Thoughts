/** Severity rules for the health layer — pure functions, no IO. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.EMBEDDING_PROVIDER = 'local';
process.env.SQLITE_PATH = `/tmp/health-test-${process.pid}.db`;
delete process.env.DATABASE_URL;

let H;
before(async () => { H = await import('../src/health.js'); });

const NOW = Date.parse('2026-07-15T12:00:00Z');
const FRESH = '2026-07-15T09:00:00Z';   // 3h old
const STALE = '2026-07-01T00:00:00Z';   // 14d old

function baseChecks(over = {}) {
  return {
    db: { ok: true, latencyMs: 10 },
    pgvector: { ok: true },
    embeddings: { configured: true, provider: 'voyage', model: 'voyage-3-lite' },
    anthropic: { configured: true },
    ideas: { count: 12, lastIngestAt: FRESH },
    clusters: { count: 3, lastRecomputeAt: FRESH },
    ...over,
  };
}

test('summarizeHealth: all good -> ok', () => {
  assert.equal(H.summarizeHealth(baseChecks(), NOW), 'ok');
});

test('summarizeHealth: db down -> down; pgvector missing -> down', () => {
  assert.equal(H.summarizeHealth(baseChecks({ db: { ok: false } }), NOW), 'down');
  assert.equal(H.summarizeHealth(baseChecks({ pgvector: { ok: false } }), NOW), 'down');
});

test('summarizeHealth: missing keys or staleness -> degraded', () => {
  assert.equal(H.summarizeHealth(baseChecks({ embeddings: { configured: false, provider: 'voyage' } }), NOW), 'degraded');
  assert.equal(H.summarizeHealth(baseChecks({ anthropic: { configured: false } }), NOW), 'degraded');
  assert.equal(H.summarizeHealth(baseChecks({ ideas: { count: 12, lastIngestAt: STALE } }), NOW), 'degraded');
});

test('summarizeHealth: empty graph is NOT stale', () => {
  assert.equal(H.summarizeHealth(baseChecks({ ideas: { count: 0, lastIngestAt: null } }), NOW), 'ok');
});

test('statusFromChecks: shape + all-green', () => {
  const s = H.statusFromChecks(baseChecks(), { status: 'ok', detail: 'reachable' }, NOW);
  assert.equal(s.overall, 'ok');
  for (const key of ['bot', 'graph', 'db', 'embeddings', 'ai', 'freshness']) {
    assert.ok(s.services[key], `has ${key}`);
    assert.ok(['ok', 'warn', 'down', 'unknown'].includes(s.services[key].status));
    assert.equal(typeof s.services[key].detail, 'string');
  }
  assert.match(s.services.db.detail, /pgvector/);
});

test('statusFromChecks: severity — worst row wins, unknown caps at warn', () => {
  assert.equal(H.statusFromChecks(baseChecks({ db: { ok: false, error: 'x' } }), { status: 'ok', detail: '' }, NOW).overall, 'down');
  assert.equal(H.statusFromChecks(baseChecks(), { status: 'down', detail: 'unreachable' }, NOW).overall, 'down');
  assert.equal(H.statusFromChecks(baseChecks({ anthropic: { configured: false } }), { status: 'ok', detail: '' }, NOW).overall, 'warn');
  assert.equal(H.statusFromChecks(baseChecks(), { status: 'unknown', detail: 'BOT_HEALTH_URL not set' }, NOW).overall, 'warn');
});

test('statusFromChecks: freshness messaging', () => {
  const empty = H.statusFromChecks(baseChecks({ ideas: { count: 0 } }), { status: 'ok', detail: '' }, NOW);
  assert.equal(empty.services.freshness.status, 'ok');
  const stale = H.statusFromChecks(baseChecks({ ideas: { count: 5, lastIngestAt: STALE } }), { status: 'ok', detail: '' }, NOW);
  assert.equal(stale.services.freshness.status, 'warn');
  assert.match(stale.services.freshness.detail, /14d ago/);
});

test('probeBotHealth: unknown when unconfigured', async () => {
  const r = await H.probeBotHealth('');
  assert.equal(r.status, 'unknown');
});

test('collectDeepHealth returns a complete check set on SQLite', async () => {
  const checks = await H.collectDeepHealth();
  assert.equal(checks.db.ok, true);
  assert.ok(checks.db.latencyMs >= 0);
  assert.deepEqual(checks.pgvector, { ok: true, skipped: 'sqlite' });
  assert.equal(checks.embeddings.provider, 'local');
  assert.equal(checks.embeddings.configured, true, 'local provider needs no key');
  assert.equal(typeof checks.ideas.count, 'number');
});

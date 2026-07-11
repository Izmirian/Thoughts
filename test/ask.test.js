/**
 * "Ask my brain" + digest + entity-seed + capture-echo tests, keyless (local
 * embedding provider on SQLite). Claude synthesis is skipped without a key —
 * askBrain then returns the matching sources with answer:null, which is the
 * degraded contract the bot handles.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `thoughts-ask-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDING_PROVIDER = 'local';
process.env.SIM_THRESHOLD = '0.25';
process.env.SQLITE_PATH = DB_PATH;
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;

let db, ingest, ask;
before(async () => {
  db = await import('../src/db.js');
  ingest = await import('../src/ingest.js');
  ask = await import('../src/ask.js');
  // Overlapping vocabulary so the lexical local provider retrieves reliably.
  const seed = [
    'giveaway ideas for the store: free polishing with every giveaway entry',
    'giveaways should target repeat customers not new ones',
    'the diamond inventory app should sort by cut carat and clarity',
    'quarterly tax filing deadline reminders',
  ];
  for (let i = 0; i < seed.length; i++) {
    await ingest.ingestIdea({ chatId: 'ask', text: seed[i], source: 'seed', sourceRef: String(i) });
  }
});
after(async () => {
  try { await db.closePool(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB_PATH + ext); } catch {} }
});

test('askBrain retrieves relevant notes as sources (no key -> answer null)', async () => {
  const r = await ask.askBrain('ask', 'what were my giveaway ideas?');
  assert.equal(r.ok, true);
  assert.equal(r.answer, null, 'no ANTHROPIC_API_KEY -> raw sources only');
  assert.ok(r.sources.length >= 1, 'found giveaway notes');
  assert.match(r.sources[0].content, /giveaway/i);
  for (const s of r.sources) {
    assert.ok(s.id && typeof s.content === 'string');
    assert.ok(s.similarity >= ask.MIN_SIMILARITY);
  }
});

test('askBrain is honest when nothing matches', async () => {
  const r = await ask.askBrain('ask', 'zebra migration patterns in botswana');
  assert.equal(r.ok, true);
  assert.equal(r.answer, null);
  assert.equal(r.sources.length, 0);
});

test('askBrain validates input', async () => {
  assert.equal((await ask.askBrain('', 'q')).ok, false);
  assert.equal((await ask.askBrain('ask', '')).ok, false);
});

test('buildAskPrompt numbers and dates the sources; selectSources filters by floor', () => {
  const sources = [{ id: 1, similarity: 0.8, content: 'note A', createdAt: '2026-05-03T10:00:00Z' }];
  const p = ask.buildAskPrompt('why?', sources);
  assert.match(p, /\[1\] \(2026-05-03\) note A/);
  assert.match(p, /ONLY these notes/);
  const picked = ask.selectSources(
    [{ id: 1, similarity: 0.9 }, { id: 2, similarity: 0.1 }],
    { 1: { content: 'keep', created_at: 'x' }, 2: { content: 'drop', created_at: 'y' } });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].content, 'keep');
});

test('ingest echoes the top related older idea (topNeighbor)', async () => {
  const r = await ingest.ingestIdea({ chatId: 'ask', text: 'more giveaway ideas: giveaway entries for referrals', source: 'seed', sourceRef: 'echo' });
  assert.equal(r.ok, true);
  assert.ok(r.linkedCount >= 1, 'linked to earlier giveaway notes');
  assert.ok(r.topNeighbor, 'echo present');
  assert.match(r.topNeighbor.content, /giveaway/i);
  assert.ok(r.topNeighbor.id);
});

test('getDigestData returns the full digest shape', async () => {
  const d = await db.getDigestData('ask');
  assert.ok(d.ideaCount >= 5);
  assert.equal(typeof d.newThisWeek, 'number');
  // hottest/resurface/bridge may be null on a young graph — shape only
  assert.ok('hottestCluster' in d && 'resurface' in d && 'bridge' in d);
});

test('entity seed upserts idempotently', async () => {
  const a = await db.upsertEntity('ask', 'Sara', 'person');
  const b = await db.upsertEntity('ask', 'sara', 'person'); // case-insensitive norm
  assert.equal(a, b);
});

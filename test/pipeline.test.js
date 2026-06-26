/**
 * End-to-end pipeline tests on SQLite using the deterministic `local` embedding
 * provider (no network, no key): ingest -> embed -> autonomous edges -> cluster.
 * Env is set before any dynamic import so the modules pick it up at load time.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `thoughts-pipeline-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDING_PROVIDER = 'local';
process.env.SIM_THRESHOLD = '0.25';        // local provider is lexical → lower bar
process.env.SQLITE_PATH = DB_PATH;
delete process.env.DATABASE_URL;           // force SQLite

let db, ingest, clustering, embeddings;
before(async () => {
  embeddings = await import('../src/embeddings.js');
  db = await import('../src/db.js');
  ingest = await import('../src/ingest.js');
  clustering = await import('../src/clustering.js');
});
after(async () => {
  try { await db.closePool(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB_PATH + ext); } catch {} }
});

test('local embeddings are deterministic, unit-normalized, correct dim', async () => {
  const a = await embeddings.embed('cats are wonderful pets');
  const b = await embeddings.embed('cats are wonderful pets');
  assert.equal(a.length, embeddings.EMBEDDING_DIM);
  assert.deepEqual(a, b, 'same text -> same vector');
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, 'unit normalized');
});

test('ingest stores an idea and reports it', async () => {
  const r = await ingest.ingestIdea({ chatId: 'pipe', text: 'cats are wonderful pets', source: 'seed', sourceRef: 'a' });
  assert.equal(r.ok, true);
  assert.ok(r.id > 0);
  assert.equal(r.created, true);
  const idea = await db.getIdea(r.id);
  assert.equal(idea.content, 'cats are wonderful pets');
});

test('re-ingesting the same source_ref is idempotent (no duplicate, no relink)', async () => {
  const first = await ingest.ingestIdea({ chatId: 'pipe', text: 'cats are wonderful pets', source: 'seed', sourceRef: 'a' });
  assert.equal(first.created, false);
});

test('semantically-overlapping ideas get autonomously linked', async () => {
  // Heavy shared vocabulary so the lexical local provider links them.
  await ingest.ingestIdea({ chatId: 'pipe', text: 'my cat loves cats and other cats', source: 'seed', sourceRef: 'b' });
  await ingest.ingestIdea({ chatId: 'pipe', text: 'kittens are baby cats and cats are pets', source: 'seed', sourceRef: 'c' });
  const edges = await db.getEdgesForChat('pipe');
  assert.ok(edges.length >= 1, `expected at least one edge, got ${edges.length}`);
});

test('an unrelated idea does not link to the cat cluster', async () => {
  const r = await ingest.ingestIdea({ chatId: 'pipe', text: 'quarterly invoice automation for client billing', source: 'seed', sourceRef: 'd' });
  const edges = await db.getEdgesForChat('pipe');
  const touchesNew = edges.some(e => e.src === r.id || e.dst === r.id);
  assert.equal(touchesNew, false, 'unrelated idea should be isolated');
});

test('clustering assigns clusters and heat, getGraph returns the expected shape', async () => {
  await clustering.recomputeClustersForChat('pipe');
  const g = await db.getGraph({ chatId: 'pipe' });
  assert.ok(g.nodes.length >= 4);
  // shape
  const n = g.nodes[0];
  for (const k of ['id', 'label', 'content', 'cluster', 'heat', 'degree']) assert.ok(k in n, `node has ${k}`);
  assert.ok(Array.isArray(g.edges) && Array.isArray(g.clusters));
  // the linked cat ideas should share a cluster
  const cat = g.nodes.filter(x => /cat/i.test(x.content));
  const clusters = new Set(cat.map(x => x.cluster));
  assert.equal(clusters.size, 1, 'the cat ideas land in one cluster');
});

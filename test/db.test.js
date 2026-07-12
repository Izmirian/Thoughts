/**
 * DB smoke tests. The vector/ANN path needs a real Postgres with pgvector, so
 * these only run when DATABASE_URL is set (mirrors reminder-bot). CI should use a
 * pgvector-enabled Postgres image so the ANN path is exercised, not just SQLite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HAS_DB = !!process.env.DATABASE_URL;

test('DB: idea insert is idempotent + ANN + edge dedupe', { skip: !HAS_DB }, async () => {
  const db = await import('../src/db.js');
  const { EMBEDDING_DIM } = await import('../src/embeddings.js');
  const chat = 'test-' + Date.now();
  const vecA = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0));
  const vecB = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 0.99 : 0.01));

  const a = await db.createIdea({ chatId: chat, content: 'alpha', source: 'seed', sourceRef: '1' });
  const b = await db.createIdea({ chatId: chat, content: 'beta', source: 'seed', sourceRef: '2' });
  assert.ok(a.id && b.id);

  // Idempotent on (chat, source, source_ref)
  const aAgain = await db.createIdea({ chatId: chat, content: 'alpha2', source: 'seed', sourceRef: '1' });
  assert.equal(aAgain.id, a.id);
  assert.equal(aAgain.created, false);

  await db.storeEmbedding(a.id, vecA, 'test');
  await db.storeEmbedding(b.id, vecB, 'test');

  const nn = await db.nearestNeighbors(chat, vecA, 5, a.id);
  assert.ok(nn.length >= 1);
  assert.equal(nn[0].id, b.id, 'nearest neighbour of A should be B');

  // Edge upsert dedupes on (src,dst)
  await db.insertEdge(chat, a.id, b.id, 0.99, 0.99);
  await db.insertEdge(chat, a.id, b.id, 0.99, 0.99);
  const edge = await db.getEdge(a.id, b.id);
  assert.ok(edge, 'edge exists');
});

test('DB: deleteIdea removes the row, its edges, and refreshes neighbour degree', { skip: !HAS_DB }, async () => {
  const db = await import('../src/db.js');
  const chat = 'test-del-' + Date.now();

  const a = await db.createIdea({ chatId: chat, content: 'dup one', source: 'seed', sourceRef: 'd1' });
  const b = await db.createIdea({ chatId: chat, content: 'dup two', source: 'seed', sourceRef: 'd2' });
  await db.insertEdge(chat, a.id, b.id, 0.9, 0.9);
  await db.recomputeDegree(a.id);
  await db.recomputeDegree(b.id);

  const result = await db.deleteIdea(a.id);
  assert.equal(result.ok, true);

  assert.equal(await db.getIdea(a.id), null);
  assert.equal(await db.getEdge(a.id, b.id), null);

  const bAfter = await db.getIdea(b.id);
  assert.equal(bAfter.degree, 0, 'neighbour degree recomputed after edge removal');

  const missing = await db.deleteIdea(a.id);
  assert.equal(missing.ok, false, 'deleting an already-gone idea reports not found');
});

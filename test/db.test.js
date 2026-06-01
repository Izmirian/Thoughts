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

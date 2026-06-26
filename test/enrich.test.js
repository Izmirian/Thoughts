/**
 * Enrichment tests — the entity + typed-relationship layer. The Claude call is
 * not exercised (no key in CI); instead we feed a known extraction result into
 * the pure `applyEnrichment` and assert the DB + graph reflect it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `thoughts-enrich-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDING_PROVIDER = 'local';
process.env.SIM_THRESHOLD = '0.2';
process.env.SQLITE_PATH = DB_PATH;
delete process.env.DATABASE_URL;

let db, ingest, enrich;
let id1, id2;
before(async () => {
  db = await import('../src/db.js');
  ingest = await import('../src/ingest.js');
  enrich = await import('../src/enrich.js');
  // Two ideas that link (shared vocabulary) so a similarity edge exists.
  id1 = (await ingest.ingestIdea({ chatId: 'enr', text: 'planning the Amman trip with Sara next month', source: 'seed', sourceRef: '1' })).id;
  id2 = (await ingest.ingestIdea({ chatId: 'enr', text: 'booking flights for the Amman trip and texting Sara', source: 'seed', sourceRef: '2' })).id;
});
after(async () => {
  try { await db.closePool(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB_PATH + ext); } catch {} }
});

test('applyEnrichment stores entities, links ideas to them, and types the edge', async () => {
  await enrich.applyEnrichment('enr', id1, {
    entities: [{ name: 'Amman', type: 'place' }, { name: 'Sara', type: 'person' }],
    links: [{ id: id2, relation: 'elaborates', why: 'same trip' }],
  });
  await enrich.applyEnrichment('enr', id2, {
    entities: [{ name: 'amman', type: 'place' }, { name: 'Sara', type: 'person' }], // case-insensitive dedupe
    links: [],
  });

  const g = await db.getGraph({ chatId: 'enr' });

  // Entities mentioned by >=2 ideas surface as hub-nodes.
  const entityNodes = g.nodes.filter(n => n.kind === 'entity');
  const names = entityNodes.map(n => n.label.toLowerCase()).sort();
  assert.deepEqual(names, ['amman', 'sara'], 'both shared entities surface, deduped case-insensitively');

  // Idea→entity mention links exist (both ideas mention both entities = 4).
  assert.equal(g.mentions.length, 4);

  // The similarity edge between the two ideas is now typed.
  const typed = g.edges.find(e => e.relation === 'elaborates');
  assert.ok(typed, 'the idea-idea edge carries the typed relation');
  assert.equal(typed.reason, 'same trip');
});

test('entities mentioned by only one idea are not surfaced as connectors', async () => {
  await ingest.ingestIdea({ chatId: 'enr', text: 'random unrelated note about a movie', source: 'seed', sourceRef: '3' });
  const lonely = (await db.getGraph({ chatId: 'enr' })).nodes.filter(n => n.kind === 'entity');
  // Add an entity to a single idea — it must NOT appear (needs >=2 mentions).
  const eid = await db.upsertEntity('enr', 'SolaceCorp', 'org');
  await db.linkIdeaEntity(id1, eid);
  const after = (await db.getGraph({ chatId: 'enr' })).nodes.filter(n => n.kind === 'entity');
  assert.equal(after.length, lonely.length, 'a single-mention entity stays hidden');
});

test('unenriched tracking: markEnriched advances the queue', async () => {
  const before = await db.countUnenriched('enr');
  assert.ok(before > 0);
  const pending = await db.getUnenrichedIdeas('enr', 1);
  await db.markEnriched(pending[0].id);
  assert.equal(await db.countUnenriched('enr'), before - 1);
});

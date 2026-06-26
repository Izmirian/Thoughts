/**
 * Zero-setup VISUAL demo — no API keys, no database. Populates the local SQLite
 * graph with themed ideas using synthetic, theme-clustered embeddings so the
 * viewer shows clean, colourful hot spots immediately. This is a *fixture* for
 * seeing the end product; it bypasses the real embedding provider on purpose.
 * For the real pipeline (real semantic links) use `npm run seed` with a key.
 *
 *   npm run demo
 *   npm start            # then open http://localhost:3000/?token=YOUR_VIEWER_TOKEN
 */
import 'dotenv/config';
import {
  createIdea, storeEmbedding, nearestNeighbors, getEdge, insertEdge,
  recomputeDegree, getGraph, closePool,
  upsertEntity, linkIdeaEntity, setEdgeRelation,
} from '../src/db.js';
import { canonical, edgeWeight } from '../src/graph.js';
import { recomputeClustersForChat } from '../src/clustering.js';
import { EMBEDDING_DIM } from '../src/embeddings.js';

const CHAT = process.env.DEMO_CHAT || 'demo-user';

// Deterministic PRNG for reproducible noise/layout.
let s = 1337; const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;

// A theme = a base axis in embedding space; members = axis + bounded noise so
// intra-theme cosine lands ~0.85-0.95 (well above the 0.78 default threshold).
function themeVec(axis) {
  const eps = 0.25 + rand() * 0.17;
  const noise = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < 16; i++) noise[(axis + 1 + Math.floor(rand() * 100)) % EMBEDDING_DIM] += rand() - 0.5;
  const nn = Math.sqrt(noise.reduce((a, x) => a + x * x, 0)) || 1;
  const v = noise.map(x => x / nn * eps);
  v[axis] += 1;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map(x => x / n);
}

const THEMES = [
  { axis: 0, ideas: [
    'An app that turns scattered notes into a knowledge graph',
    'A WhatsApp bot that captures every idea instantly',
    'People would pay for a tool that finds hidden patterns in their thoughts',
    'MVP: capture, auto-link by meaning, visualize the clusters',
    'Hot spots reveal what I keep coming back to',
    'Free personal tier, paid for teams and bigger graphs',
    'The graph should only ever grow, never forget',
    'Pitch it as a second brain that organizes itself',
  ]},
  { axis: 40, ideas: [
    'Wake at 6am and meditate before any screens',
    'Cold showers give me hours of energy',
    'A morning sunlight walk fixes my sleep',
    'Journaling first thing clears my head',
    'Put the alarm across the room to stop snoozing',
    'Same breakfast every day removes a decision',
  ]},
  { axis: 80, ideas: [
    'Run three times a week, alternate strength days',
    'Cut the afternoon sugar snacks',
    'Track protein, target 120g a day',
    'Evening stretches for the lower back',
    'Sign up for the spring 10k as a forcing function',
  ]},
  { axis: 120, ideas: [
    'Read 20 pages of non-fiction nightly',
    'Notes in my own words beat highlighting',
    'Spaced repetition for Spanish vocabulary',
    'Teach what I learn to remember it',
  ]},
  { axis: 160, ideas: [
    'Automate invoices before hiring anyone',
    'Batch client calls on Tuesday and Thursday',
    'Raise rates for new projects next quarter',
  ]},
];
const OUTLIERS = [['Fix the leaking kitchen faucet', 300], ['Great espresso at the new place on 5th', 340], ['Neighbor mentioned a block party', 380]];

async function main() {
  const items = [];
  let ref = 0;
  for (const t of THEMES) for (const text of t.ideas) items.push({ text, vec: themeVec(t.axis), ref: ref++ });
  for (const [text, axis] of OUTLIERS) items.push({ text, vec: themeVec(axis), ref: ref++ });

  console.log(`[Demo] Inserting ${items.length} themed ideas as ${CHAT} (synthetic embeddings)...`);
  const ids = [];
  for (const it of items) {
    const { id } = await createIdea({ chatId: CHAT, content: it.text, source: 'demo', sourceRef: String(it.ref) });
    await storeEmbedding(id, it.vec, 'synthetic-demo');
    ids.push({ id, vec: it.vec });
  }

  let edges = 0;
  for (const me of ids) {
    const nbrs = await nearestNeighbors(CHAT, me.vec, 15, me.id);
    for (const n of nbrs) {
      if (n.similarity < 0.78) continue;
      const [a, b] = canonical(me.id, n.id);
      if (!await getEdge(a, b)) { await insertEdge(CHAT, a, b, n.similarity, edgeWeight(n.similarity, Math.floor(rand() * 4), 0)); edges++; }
    }
    await recomputeDegree(me.id);
  }
  // Simulate the Claude enrichment layer: entity hub-nodes (some bridging two
  // hot spots) and a couple of typed relationships, so the demo shows the feature
  // without an API key.
  const idByText = {};
  items.forEach((it, k) => { idByText[it.text] = ids[k].id; });
  async function entity(name, type, texts) {
    const eid = await upsertEntity(CHAT, name, type);
    for (const t of texts) { const id = idByText[t]; if (id) await linkIdeaEntity(id, eid); }
  }
  async function relate(textA, textB, relation, why) {
    const a = idByText[textA], b = idByText[textB];
    if (!a || !b) return;
    const [s, d] = canonical(a, b);
    await setEdgeRelation(s, d, relation, why);
  }
  await entity('knowledge graph', 'topic', [
    'An app that turns scattered notes into a knowledge graph',
    'MVP: capture, auto-link by meaning, visualize the clusters',
    'Pitch it as a second brain that organizes itself',
  ]);
  await entity('notes', 'topic', [               // bridges the app idea + reading clusters
    'An app that turns scattered notes into a knowledge graph',
    'Notes in my own words beat highlighting',
  ]);
  await entity('habits', 'topic', [              // bridges morning + fitness clusters
    'Same breakfast every day removes a decision',
    'Sign up for the spring 10k as a forcing function',
  ]);
  await relate('An app that turns scattered notes into a knowledge graph', 'MVP: capture, auto-link by meaning, visualize the clusters', 'elaborates', 'spells out the how');
  await relate('MVP: capture, auto-link by meaning, visualize the clusters', 'Free personal tier, paid for teams and bigger graphs', 'builds-on', 'adds the business model');

  await recomputeClustersForChat(CHAT);

  const g = await getGraph({ chatId: CHAT });
  const ideas = g.nodes.filter(n => n.kind === 'idea').length;
  const entities = g.nodes.filter(n => n.kind === 'entity').length;
  console.log(`[Demo] ${ideas} ideas, ${entities} entities, ${g.edges.length} links, ${g.mentions.length} mentions, ${g.clusters.length} clusters.`);
  console.log(`[Demo] Start the server (npm start) and open:`);
  console.log(`       http://localhost:${process.env.PORT || 3000}/?token=${process.env.VIEWER_TOKEN || 'YOUR_VIEWER_TOKEN'}`);
  await closePool();
  process.exit(0);
}

main().catch(e => { console.error('[Demo] fatal:', e); process.exit(1); });

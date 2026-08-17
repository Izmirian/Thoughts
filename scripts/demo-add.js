/**
 * Live-update fixture: drop 1-3 more synthetic ideas into the LOCAL demo graph
 * (chat "demo-user", SQLite) while `npm start` is running, to watch the viewer's
 * live poll pick them up — the new nodes should tween in near their cluster
 * within one poll interval (~35s), no reload.
 *
 *   npm run demo        # once, to build the base graph
 *   npm start           # keep running
 *   node scripts/demo-add.js            # adds 1 idea to the "morning" theme
 *   node scripts/demo-add.js 3          # adds up to 3 (cycles themes)
 *
 * Same synthetic-embedding technique as scripts/demo.js (no API keys).
 */
import 'dotenv/config';
import {
  createIdea, storeEmbedding, nearestNeighbors, getEdge, insertEdge,
  recomputeDegree, closePool,
} from '../src/db.js';
import { canonical, edgeWeight } from '../src/graph.js';
import { recomputeClustersForChat } from '../src/clustering.js';
import { EMBEDDING_DIM } from '../src/embeddings.js';

const CHAT = process.env.DEMO_CHAT || 'demo-user';
const COUNT = Math.max(1, Math.min(3, parseInt(process.argv[2] || '1', 10) || 1));

// Different PRNG seed than demo.js so repeated runs vary; same vector recipe so
// new ideas land near their theme's axis and link into the existing cluster.
let s = Date.now() % 4294967296;
const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;

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

// One fresh idea per theme used by demo.js (axis must match for clustering).
const FRESH = [
  { axis: 0, text: 'Live graph updates make the second brain feel alive' },
  { axis: 40, text: 'No phone for the first hour keeps the morning mine' },
  { axis: 80, text: 'A rest day is training too — recovery is the gain' },
];

async function main() {
  const picks = FRESH.slice(0, COUNT);
  for (const p of picks) {
    const ref = `add-${Date.now()}-${Math.floor(rand() * 1e6)}`;
    const vec = themeVec(p.axis);
    const { id } = await createIdea({ chatId: CHAT, content: p.text, source: 'demo', sourceRef: ref });
    await storeEmbedding(id, vec, 'synthetic-demo');
    let links = 0;
    const nbrs = await nearestNeighbors(CHAT, vec, 15, id);
    for (const n of nbrs) {
      if (n.similarity < 0.78) continue;
      const [a, b] = canonical(id, n.id);
      if (!await getEdge(a, b)) { await insertEdge(CHAT, a, b, n.similarity, edgeWeight(n.similarity, 0, 0)); links++; }
    }
    await recomputeDegree(id);
    console.log(`[DemoAdd] +"${p.text}" (id ${id}, ${links} links) — watch it appear live.`);
  }
  await recomputeClustersForChat(CHAT);
  await closePool();
  process.exit(0);
}

main().catch(e => { console.error('[DemoAdd] fatal:', e); process.exit(1); });

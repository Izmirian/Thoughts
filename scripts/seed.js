/**
 * Seed the graph with themed sample ideas so you can verify the pipeline offline
 * (capture -> embed -> autonomous edges -> clustering) without WhatsApp.
 *
 *   node scripts/seed.js
 *
 * Requires an embeddings key (VOYAGE_API_KEY by default). Idempotent: re-running
 * won't duplicate ideas (source='seed', stable source_ref).
 */
import 'dotenv/config';
import { ingestIdea } from '../src/ingest.js';
import { recomputeAllClusters } from '../src/clustering.js';
import { closePool } from '../src/db.js';

const CHAT = 'seed-user';

// Several deliberate themes + a few random outliers.
const IDEAS = [
  // morning routine
  'Wake up at 6am and meditate for ten minutes before checking my phone',
  'Cold shower in the morning gives me energy for hours',
  'Journaling first thing in the morning clears my head',
  'Stop hitting snooze — put the alarm across the room',
  'Morning sunlight walk helps me sleep better at night',
  // startup idea
  'An app that turns my scattered notes into a knowledge graph',
  'What if a WhatsApp bot could capture every idea I have instantly',
  'People would pay for a tool that finds hidden patterns in their thoughts',
  'MVP: capture ideas, auto-link them by meaning, visualize the clusters',
  'Pricing: free tier for personal use, paid for teams and bigger graphs',
  // health / fitness
  'Run three times a week, alternate with strength training',
  'Cut down on sugar, especially the afternoon snacks',
  'Track protein intake to hit 120g a day',
  'Stretch every evening to fix my lower back pain',
  // reading / learning
  'Read 20 pages of a non-fiction book every night',
  'Take notes in my own words instead of highlighting',
  'Learn enough Spanish to hold a basic conversation by summer',
  'Spaced repetition really works for vocabulary',
  // random outliers
  'Need to fix the leaking kitchen faucet this weekend',
  'The new coffee place on 5th street has great espresso',
  'Remember the neighbor mentioned a block party next month',
];

async function main() {
  console.log(`[Seed] Inserting ${IDEAS.length} ideas as ${CHAT}...`);
  let linked = 0;
  for (let i = 0; i < IDEAS.length; i++) {
    const r = await ingestIdea({
      chatId: CHAT, text: IDEAS[i], source: 'seed', sourceType: 'text', sourceRef: String(i),
    });
    if (!r.ok) { console.error(`  [${i}] failed: ${r.reason}`); continue; }
    linked += r.linkedCount;
    console.log(`  [${i}] id=${r.id} linked=${r.linkedCount} top=${r.topSimilarity.toFixed(3)}`);
  }
  console.log(`[Seed] Done. ${linked} total links. Computing clusters...`);
  await recomputeAllClusters();
  console.log('[Seed] Open the viewer: http://localhost:' + (process.env.PORT || 3000) + '/?token=' + (process.env.VIEWER_TOKEN || ''));
  await closePool();
  process.exit(0);
}

main().catch(e => { console.error('[Seed] fatal:', e); process.exit(1); });

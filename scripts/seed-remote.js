/**
 * Seed a DEPLOYED Thoughts service with a full-looking, cleanly deletable test
 * graph — ~50 themed ideas across 8 clusters, ingested through the real
 * pipeline (POST /api/ingest → server-side embedding → edges → clusters).
 *
 * Everything lands under chatId "seed-user" (source "seed"), which the ingest
 * pipeline keeps fully isolated from real chats (neighbour search is
 * chat-scoped). Remove it all later with ONE call:
 *
 *   curl -X POST "$THOUGHTS_URL/api/forget?chat=seed-user&token=$VIEWER_TOKEN"
 *   curl -X POST "$THOUGHTS_URL/api/recompute?token=$VIEWER_TOKEN"
 *
 * Usage (all three env vars required; nothing is hardcoded):
 *   THOUGHTS_URL=https://... THOUGHTS_INGEST_SECRET=... VIEWER_TOKEN=... \
 *     node scripts/seed-remote.js
 *
 * Idempotent: sourceRef is stable per idea (UNIQUE(chat_id, source, source_ref)),
 * so re-runs update rather than duplicate.
 */

const URL_BASE = (process.env.THOUGHTS_URL || '').replace(/\/+$/, '');
const SECRET = process.env.THOUGHTS_INGEST_SECRET || '';
const TOKEN = process.env.VIEWER_TOKEN || '';

if (!URL_BASE || !SECRET || !TOKEN) {
  console.error('Missing env: THOUGHTS_URL, THOUGHTS_INGEST_SECRET and VIEWER_TOKEN are all required.');
  process.exit(1);
}

const CHAT = 'seed-user';

// 8 themes ≈ 8 hot spots + a few outliers. sourceRef starts at 100 so this set
// coexists idempotently with scripts/seed.js (refs 0-20) on the same chat.
const THEMES = [
  ['Morning routine', [
    'Wake at 6am and meditate for ten minutes before any screens',
    'Cold showers in the morning give me hours of clean energy',
    'A sunlight walk before 9am fixed my sleep schedule',
    'Journaling three pages first thing clears my head for the day',
    'Move the alarm across the room so snoozing means standing up',
    'Same breakfast every weekday removes one more decision',
  ]],
  ['Startup ideas', [
    'An app that turns scattered notes into a self-organizing knowledge graph',
    'A WhatsApp bot that captures every idea the second it strikes',
    'People would pay for a tool that finds hidden patterns in their own thinking',
    'MVP: capture anywhere, auto-link by meaning, visualize the clusters',
    'Pitch it as a second brain that organizes itself while you live your life',
    'Free personal tier, paid tier for teams and bigger graphs',
    'The moat is the accumulated graph — switching cost grows with every idea',
  ]],
  ['Fitness', [
    'Run three mornings a week, strength train on the days between',
    'Cut the afternoon sugar snacks and the 4pm crash disappears',
    'Track protein properly — target 120 grams a day',
    'Ten minutes of evening stretches keeps the lower back quiet',
    'Sign up for the spring 10k as a forcing function to stay consistent',
    'Deload week every eighth week prevents the overuse niggles',
  ]],
  ['Reading & learning', [
    'Read 20 pages of non-fiction every night before sleep',
    'Notes in my own words beat highlighting every time',
    'Spaced repetition daily for Spanish vocabulary',
    'Teaching what I just learned is the fastest way to keep it',
    'One deep book beats five skimmed ones',
  ]],
  ['Travel planning', [
    'Shoulder-season trips: fewer crowds, better prices, same light',
    'Pack one carry-on no matter the trip length — it forces clarity',
    'Book the first two nights only, decide the rest on the ground',
    'A food market on day one teaches you a city faster than any museum',
    'Keep a running list of places friends rave about',
  ]],
  ['Cooking', [
    'Batch-cook grains and proteins on Sunday, assemble all week',
    'A sharp knife changed how much I enjoy cooking',
    'Salt earlier than feels right — season in layers',
    'One new recipe a week keeps the rotation from going stale',
    'Homemade stock from scraps costs nothing and upgrades everything',
  ]],
  ['Home office', [
    'Monitor at eye height ended the neck aches',
    'A hard stop at 6pm makes the work hours denser',
    'Separate desk for deep work, kitchen table for calls',
    'Warm desk lamp instead of overhead light after sunset',
    'Noise-cancelling headphones are the cheapest focus upgrade',
  ]],
  ['Personal finance', [
    'Automate savings the day salary lands — pay yourself first',
    'Track subscriptions quarterly and cancel two every time',
    'Index funds, monthly, no timing — boring wins',
    'A 24-hour rule before any purchase over 100',
    'Emergency fund first, then investing — sequence matters',
  ]],
];
const OUTLIERS = [
  'Fix the squeaky hinge on the balcony door',
  'The corner café does a surprisingly great espresso',
  'Look up who composed the theme from that film last night',
  'Water the plants before the weekend trip',
];

async function post(path, body, headers) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const items = [];
  let ref = 100;
  for (const [, ideas] of THEMES) for (const text of ideas) items.push({ text, ref: ref++ });
  for (const text of OUTLIERS) items.push({ text, ref: ref++ });

  console.log(`[SeedRemote] ${items.length} ideas → ${URL_BASE} as ${CHAT}`);
  let linked = 0;
  for (const [i, it] of items.entries()) {
    const r = await post('/api/ingest', {
      chatId: CHAT, text: it.text, source: 'seed', sourceType: 'text', sourceRef: String(it.ref),
    }, { 'x-ingest-secret': SECRET });
    if (r.linkedCount) linked += r.linkedCount;
    console.log(`  ${String(i + 1).padStart(2)}/${items.length} "${it.text.slice(0, 48)}…" links=${r.linkedCount ?? 0}`);
    await sleep(300); // be gentle with the embedding provider
  }

  console.log('[SeedRemote] Recomputing clusters + heat…');
  await post(`/api/recompute?label=1&token=${encodeURIComponent(TOKEN)}`);
  console.log('[SeedRemote] Requesting entity/relation enrichment…');
  await post(`/api/enrich?token=${encodeURIComponent(TOKEN)}`).catch(e =>
    console.warn('  enrich skipped:', e.message));

  console.log(`[SeedRemote] Done — ${linked} links created during ingest.`);
  console.log('[SeedRemote] Cleanup later with:');
  console.log(`  curl -X POST "${URL_BASE}/api/forget?chat=${CHAT}&token=$VIEWER_TOKEN"`);
}

main().catch(e => { console.error('[SeedRemote] fatal:', e.message); process.exit(1); });

/**
 * Enrichment — the layer that makes the graph mean something beyond "these two
 * ideas feel similar". For each not-yet-enriched idea, Claude:
 *   1. extracts entities (people, projects, places, orgs, topics) → hub-nodes that
 *      tie together otherwise-dissimilar ideas mentioning the same thing, and
 *   2. types the relationship to each of its existing neighbours
 *      (builds-on | contradicts | elaborates | example-of | relates-to).
 *
 * Runs entirely off the capture path (cron + debounced trigger), Haiku-first with
 * a Sonnet fallback, and is a complete no-op when ANTHROPIC_API_KEY is unset — so
 * the demo/local/offline paths keep working without it.
 */
import { CONFIG } from './config.js';
import {
  getChatIds, getIdea, getNeighborIdeas, getUnenrichedIdeas, countUnenriched,
  markEnriched, upsertEntity, linkIdeaEntity, setEdgeRelation,
} from './db.js';
import { canonical } from './graph.js';

const RELATIONS = ['builds-on', 'contradicts', 'elaborates', 'example-of', 'relates-to'];
const ENTITY_TYPES = ['person', 'project', 'place', 'org', 'topic'];
const MAX_NEIGHBORS = 8;

function parseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function callClaude(model, prompt) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const res = await client.messages.create({ model, max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
  return res.content[0]?.text;
}

function buildPrompt(ideaText, neighbors) {
  const list = neighbors.map(n => `  #${n.id}: ${n.content}`).join('\n') || '  (none)';
  return `You are building a personal idea graph. Analyse THIS idea:\n\n"${ideaText}"\n\n`
    + `Its currently-linked neighbours:\n${list}\n\n`
    + `Return ONLY JSON:\n`
    + `{\n`
    + `  "entities": [{"name": "<canonical name>", "type": "${ENTITY_TYPES.join('|')}"}],\n`
    + `  "links": [{"id": <neighbour id>, "relation": "${RELATIONS.join('|')}", "why": "<=8 words"}]\n`
    + `}\n`
    + `Rules: entities = concrete people/projects/places/orgs or a strong recurring topic (max 5, omit vague ones). `
    + `links: only for neighbours with a real directed relationship from THIS idea; pick the single best relation; omit weak ones.`;
}

/** Pure DB application of an extraction result — unit-testable without Claude. */
export async function applyEnrichment(chatId, ideaId, result) {
  if (!result || typeof result !== 'object') return { entities: 0, links: 0 };
  let entities = 0, links = 0;

  for (const e of (result.entities || []).slice(0, 8)) {
    if (!e?.name) continue;
    const type = ENTITY_TYPES.includes(e.type) ? e.type : 'topic';
    const id = await upsertEntity(chatId, String(e.name), type);
    if (id) { await linkIdeaEntity(ideaId, id); entities++; }
  }

  for (const l of (result.links || [])) {
    const nid = Number(l?.id);
    if (!nid || nid === ideaId || !RELATIONS.includes(l.relation)) continue;
    const [s, d] = canonical(ideaId, nid);
    await setEdgeRelation(s, d, l.relation, (l.why || '').slice(0, 120)); // only annotates if the edge exists
    links++;
  }
  return { entities, links };
}

/** Enrich a single idea (one Claude call). No-op if no API key. */
export async function enrichIdea(chatId, ideaId) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const idea = await getIdea(ideaId);
  if (!idea) return null;
  const neighbors = await getNeighborIdeas(ideaId, MAX_NEIGHBORS);
  const prompt = buildPrompt(idea.content, neighbors);

  let result = parseJson(await callClaude('claude-haiku-4-5-20251001', prompt).catch(() => null));
  if (!result) result = parseJson(await callClaude('claude-sonnet-4-20250514', prompt).catch(() => null));
  const applied = result ? await applyEnrichment(chatId, ideaId, result) : { entities: 0, links: 0 };
  await markEnriched(ideaId); // mark even on failure so we don't loop forever on a bad row
  return applied;
}

/** Enrich up to `limit` pending ideas for a chat. */
export async function enrichPending(chatId, limit = 25) {
  if (!process.env.ANTHROPIC_API_KEY) return 0;
  const pending = await getUnenrichedIdeas(chatId, limit);
  let done = 0;
  for (const idea of pending) {
    try { await enrichIdea(chatId, idea.id); done++; }
    catch (e) { console.error(`[Enrich] idea ${idea.id} failed:`, e.message); }
  }
  if (done) console.log(`[Enrich] ${chatId}: enriched ${done} ideas (${await countUnenriched(chatId)} remaining)`);
  return done;
}

/** Enrich pending ideas across all chats (cron). */
export async function enrichAll(limit = 25) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  for (const chatId of await getChatIds()) {
    try { await enrichPending(chatId, limit); } catch (e) { console.error(`[Enrich] ${chatId}:`, e.message); }
  }
}

// --- Debounced trigger after captures (mirrors recompute) --------------------
const timers = new Map();
export function scheduleEnrich(chatId) {
  if (!chatId || !process.env.ANTHROPIC_API_KEY) return;
  if (timers.has(chatId)) clearTimeout(timers.get(chatId));
  const t = setTimeout(async () => {
    timers.delete(chatId);
    try { await enrichPending(chatId); } catch (e) { console.error('[Enrich] scheduled:', e.message); }
  }, CONFIG.ENRICH_DEBOUNCE_MS);
  if (t.unref) t.unref();
  timers.set(chatId, t);
}

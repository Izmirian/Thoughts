/**
 * Autonomous edge engine. When a new idea is embedded, we find its nearest
 * semantic neighbours and draw weighted edges — no manual linking. Edges
 * strengthen over time through reinforcement (recurring/bridging ideas) and a
 * recency boost, so dense recurring themes become visible "hot spots".
 *
 * The weight math is kept pure here so it can be unit-tested in isolation.
 */
import { CONFIG } from './config.js';
import { embed } from './embeddings.js';
import { EMBEDDING_MODEL } from './embeddings.js';
import {
  storeEmbedding, nearestNeighbors, getEdge, insertEdge, updateEdge,
  bumpEdgeReinforce, recomputeDegree, pruneWeakestEdges,
} from './db.js';

/** Canonical undirected ordering so (a,b) and (b,a) map to one row. */
export function canonical(a, b) {
  return a < b ? [a, b] : [b, a];
}

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Multiplicative recency bump that decays with edge age (days). */
export function recencyBoost(ageDays) {
  const safe = Math.max(0, ageDays);
  return 1 + CONFIG.RECENCY_W * Math.exp(-safe / CONFIG.HALFLIFE_DAYS);
}

/**
 * Edge weight = clamp01( sim * (1 + GAIN*ln(1+reinforced)) * recencyBoost(age) ).
 * Monotonic in similarity and in reinforced_count; freshly-touched edges (age 0)
 * get the largest recency bump.
 */
export function edgeWeight(similarity, reinforcedCount = 0, ageDays = 0) {
  const reinforce = 1 + CONFIG.REINFORCE_GAIN * Math.log1p(Math.max(0, reinforcedCount));
  return clamp01(similarity * reinforce * recencyBoost(ageDays));
}

/**
 * Process a freshly-created idea: embed it, link it to similar ideas, and
 * reinforce existing relationships it sits between. Returns a small summary
 * used for the WhatsApp reply.
 */
export async function processNewIdea(chatId, ideaId, text) {
  const vec = await embed(text, 'document');
  await storeEmbedding(ideaId, vec, EMBEDDING_MODEL);

  const neighbors = await nearestNeighbors(chatId, vec, CONFIG.TOP_K, ideaId);
  const linked = neighbors.filter(n => n.similarity >= CONFIG.SIM_THRESHOLD);

  // 1) Create or reinforce direct edges to each similar neighbour.
  for (const n of linked) {
    const [s, d] = canonical(ideaId, n.id);
    const existing = await getEdge(s, d);
    if (!existing) {
      await insertEdge(chatId, s, d, n.similarity, edgeWeight(n.similarity, 0, 0));
    } else {
      const sim = Math.max(existing.similarity, n.similarity);
      const reinforced = (existing.reinforced_count || 0) + 1;
      await updateEdge(existing.id, { similarity: sim, weight: edgeWeight(sim, reinforced, 0), reinforcedCount: reinforced });
    }
  }

  // 2) Triangle/bridge reinforcement: if the new idea connects two neighbours
  //    that are ALREADY linked to each other, that pair just got re-confirmed.
  for (let i = 0; i < linked.length; i++) {
    for (let j = i + 1; j < linked.length; j++) {
      const [s, d] = canonical(linked[i].id, linked[j].id);
      const pair = await getEdge(s, d);
      if (pair) {
        const reinforced = (pair.reinforced_count || 0) + 1;
        await bumpEdgeReinforce(pair.id, edgeWeight(pair.similarity, reinforced, 0));
      }
    }
  }

  // 3) Keep the graph sparse: cap fan-out, then refresh degree caches.
  await pruneWeakestEdges(ideaId, CONFIG.MAX_EDGES_PER_NODE);
  await recomputeDegree(ideaId);
  for (const n of linked) await recomputeDegree(n.id);

  return {
    linkedCount: linked.length,
    topSimilarity: linked.length ? linked[0].similarity : 0,
    neighborIds: linked.map(n => n.id),
  };
}

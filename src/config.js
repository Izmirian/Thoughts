/**
 * Centralized configuration — all tunables in one place.
 * Override via environment variables where noted.
 */

export const CONFIG = {
  // --- Graph / edge algorithm ---
  TOP_K: parseInt(process.env.TOP_K || '15'),              // nearest neighbours considered per new idea
  SIM_THRESHOLD: parseFloat(process.env.SIM_THRESHOLD || '0.78'), // min cosine similarity to draw an edge
  MAX_EDGES_PER_NODE: parseInt(process.env.MAX_EDGES_PER_NODE || '12'), // cap fan-out to keep graph sparse

  // Edge weight: weight = clamp01( sim * (1 + REINFORCE_GAIN*log1p(reinforced)) * recencyBoost )
  REINFORCE_GAIN: parseFloat(process.env.REINFORCE_GAIN || '0.35'),
  RECENCY_W: parseFloat(process.env.RECENCY_W || '0.25'),   // size of the recency bump
  HALFLIFE_DAYS: parseFloat(process.env.HALFLIFE_DAYS || '30'), // how fast the recency bump decays

  // --- Heat scoring (0..1 blend) ---
  HEAT_W_DEGREE: 0.4,        // weight of normalized degree
  HEAT_W_DENSITY: 0.3,       // weight of the node's cluster density
  HEAT_W_RECENCY: 0.3,       // weight of recent inflow into the node's cluster
  HEAT_RECENT_DAYS: 14,      // window counted as "recent inflow"

  // --- Cleanup ---
  EDGE_PRUNE_WEIGHT: 0.15,   // edges weaker than this AND older than EDGE_PRUNE_DAYS may be pruned
  EDGE_PRUNE_DAYS: 120,

  // --- Limits / timeouts ---
  FETCH_TIMEOUT: 20000,              // default outbound HTTP timeout (ms)
  EMBED_MAX_CHARS: 8000,             // truncate text before embedding
  MAX_INGEST_BODY: '25mb',           // ingest may carry base64 media
  DB_POOL_MAX: 10,
  DB_STATEMENT_TIMEOUT: 30000,
  GRAPH_DEFAULT_LIMIT: 2000,         // default node cap returned by /api/graph
};

# Thoughts — WhatsApp Idea Graph

Capture ideas by messaging a WhatsApp bot; they're stored, **autonomously connected**
by meaning, clustered into **hot spots**, and rendered as a zoomable WebGL graph in the
browser. The graph only ever grows, and connections strengthen as themes recur — so
scattered notes reveal themselves as a strong recurring thought.

This is the "brain" service. It doesn't own a WhatsApp number — the sibling
[`reminder-bot`](../reminder-bot) receives messages on the shared number and forwards
idea-captures (and journal/memory notes) to `POST /api/ingest`.

## See it in 30 seconds (no keys, no database)

```bash
npm install
npm run demo                 # seeds a themed graph using local SQLite + synthetic embeddings
VIEWER_TOKEN=dev npm start   # then open:
#   http://localhost:3000/?token=dev
```

Scroll to zoom, drag to pan, **click a node** to focus its neighbourhood, **click a
cluster** in the legend to isolate that hot spot, and search to spotlight matches.

## How it works

```
WhatsApp ─► reminder-bot ─(POST /api/ingest, shared secret)─► Thoughts
                                                              ├─ store idea (Postgres + pgvector)
                                                              ├─ embed (Voyage) → nearest-neighbour → weighted edges
                                                              ├─ debounced + cron: Louvain clusters + heat + Claude labels
                                                              └─ token-gated Sigma.js viewer + GET /api/graph
```

- **Autonomous edges** (`src/graph.js`): each new idea is embedded, then linked to its
  top-K nearest neighbours above a similarity threshold.
  `weight = clamp01(sim · (1 + GAIN·ln(1+reinforced)) · recencyBoost(age))` — recurring
  and bridging ideas reinforce edges; recency decays so dormant clusters cool.
- **Hot spots** (`src/clustering.js`): Louvain communities + per-node heat (degree +
  cluster density + recent inflow), recomputed shortly after captures (debounced) and
  on a 6h cron, persisted so `/api/graph` is a pure read.
- **Meaningful edges** (`src/enrich.js`): beyond raw similarity, Claude extracts
  **entities** (people, projects, places, orgs, topics) as hub-nodes that tie together
  otherwise-dissimilar ideas, and **types each relationship** (builds-on, contradicts,
  elaborates, example-of, relates-to). Runs off the capture path; no-op without a key.
- **Media**: images → Claude Vision, PDFs → Claude summary, voice → Whisper; the derived
  text is embedded so media become first-class nodes.

## Embedding providers

Claude has no embeddings API, so similarity comes from a third party, selected by
`EMBEDDING_PROVIDER`:

| Provider | Quality | Needs | Use for |
|----------|---------|-------|---------|
| `voyage` (default) | semantic | `VOYAGE_API_KEY` | production |
| `openai` | semantic | `OPENAI_API_KEY` | production alt |
| `local` | lexical only | nothing | offline dev, tests, CI |

The embedding dimension is baked into the `VECTOR(n)` column — fix the provider/model
before accumulating data (each row stores `embedding_model` for a safe future re-embed).

## Endpoints

- `POST /api/ingest` — shared-secret (`THOUGHTS_INGEST_SECRET`); stores + links an idea.
- `GET /api/graph` — token-gated (`VIEWER_TOKEN`); `{ nodes, edges, clusters }`.
- `POST /api/recompute` — token-gated; regenerate clusters/heat now (`?label=1` to label).
- `POST /api/enrich` — token-gated; run entity + relationship extraction now (needs a key).
- `GET /health` — liveness.

## Env vars

See `.env.example`. Essentials: `DATABASE_URL` (unset = local SQLite), `VOYAGE_API_KEY`,
`ANTHROPIC_API_KEY`, `VIEWER_TOKEN`, `THOUGHTS_INGEST_SECRET`. Full deploy steps in
[`SETUP.md`](./SETUP.md).

## Develop & test

```bash
npm test                     # graph math + full pipeline (local provider) on SQLite;
                             # db.test.js runs only when DATABASE_URL is set
npm run seed                 # real ingest pipeline (needs an embedding provider/key)
```

CI (`.github/workflows/ci.yml`) runs the suite against a pgvector-enabled Postgres so
the real ANN path is exercised, not just the SQLite fallback.

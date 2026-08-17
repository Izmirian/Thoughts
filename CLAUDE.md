# Thoughts — WhatsApp Idea Graph

Capture ideas/notes by messaging a WhatsApp bot; they're stored, **autonomously
connected** by semantic similarity, clustered into **hot spots**, and rendered as a
zoomable WebGL graph in the browser.

This is the "brain" service. It does **not** own a WhatsApp number — the sibling
`reminder-bot` project receives messages on the shared number and forwards
idea-captures (and journal/memory notes) to `POST /api/ingest`.

## Architecture

```
WhatsApp ─► reminder-bot ─(POST /api/ingest, shared secret)─► Thoughts
                                                               ├─ store idea (Postgres + pgvector)
                                                               ├─ embed (Voyage) → nearest-neighbor → weighted edges
                                                               ├─ cron: Louvain clusters + heat + Claude labels
                                                               ├─ enrich: Claude entities (hub-nodes) + typed relations
                                                               └─ token-gated Sigma.js viewer + GET /api/graph
```

- **Runtime:** Node 20, ES modules.
- **DB:** Postgres + pgvector (`DATABASE_URL`); SQLite fallback for local dev (cosine in JS).
- **Embeddings:** Voyage AI default (`voyage-3-lite`, 512-dim), OpenAI swappable. Claude has no embeddings API.
- **AI:** Claude (`@anthropic-ai/sdk`) for image/PDF analysis and cluster labeling.
- **Viewer:** Sigma.js + graphology (WebGL), served static; nodes sized by heat, colored by cluster.
- **Deploy:** Railway (`Procfile: web: node start.js`).

## Key files

| File | Purpose |
|------|---------|
| `start.js` | Entry — boots server + cron, crash/shutdown handlers |
| `src/server.js` | Express: `/api/ingest` (secret), `/api/graph` + `/api/status` (token), static viewer, `/health` (shallow open; `?deep=1` token-gated) |
| `src/health.js` | Deep health checks + status aggregation (probes reminder-bot via `BOT_HEALTH_URL`) |
| `src/ingest.js` | Normalize payload (text/image/audio/pdf) → store → embed → connect |
| `src/embeddings.js` | Provider-abstracted embeddings (`embed`/`embedBatch`, `EMBEDDING_DIM`) |
| `src/graph.js` | Autonomous edge engine + weight math (pure, unit-tested) |
| `src/clustering.js` | Louvain communities + heat scoring (cron) |
| `src/enrich.js` | Claude entity extraction + typed relationships (cron + debounced; Haiku-first) |
| `src/labeler.js` | Claude cluster names/summaries (cron, Haiku-first) |
| `src/analyze.js` | Claude Vision for images/PDFs |
| `src/transcribe.js` | Voice → text (Whisper) |
| `src/db.js` | Postgres(pgvector)/SQLite layer, ideas/edges/clusters CRUD |
| `src/cron.js` | Schedules: clustering (6h), labeling (daily), edge cleanup (daily) |
| `public/` | Sigma.js viewer (no build step; libs vendored in `public/vendor/`) — **live**: polls `/api/graph` every 35s, diffs, preserves layout, animates arrivals |
| `scripts/seed.js` | Insert themed sample ideas to verify the pipeline offline |
| `scripts/demo.js` / `demo-add.js` | Zero-key local fixture (synthetic embeddings, SQLite); `demo-add` drops extra ideas in while the server runs to exercise the live-update path |
| `scripts/seed-remote.js` | Seed a deployed instance with ~50 themed test ideas via `/api/ingest` (needs `THOUGHTS_URL` + `THOUGHTS_INGEST_SECRET` + `VIEWER_TOKEN`); all under chat `seed-user` — bulk-delete with `POST /api/forget?chat=seed-user` then `/api/recompute` |
| `PRODUCT.md` / `DESIGN.md` | Product truth + recorded design system (Impeccable); run `npx impeccable detect public/` after viewer changes — keep it clean |

## How connections work

On each new idea: embed → top-K nearest neighbours (pgvector `<=>`) → for those above
`SIM_THRESHOLD`, create/reinforce weighted edges. Edges **strengthen over time**:
`weight = clamp01(sim · (1 + GAIN·ln(1+reinforced)) · recencyBoost(age))`. Recurring
ideas reinforce nearby edges; an idea bridging two already-linked ideas re-confirms
that pair (triangle reinforcement); recency decays so dormant clusters cool. Fan-out
is capped (`MAX_EDGES_PER_NODE`) to keep the graph sparse. Hot spots = dense + recently
active Louvain communities (computed by cron, persisted as `heat`).

## Env vars

See `.env.example`. Essentials: `DATABASE_URL`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`,
`VIEWER_TOKEN` (gates viewer + graph), `THOUGHTS_INGEST_SECRET` (gates ingest, shared
with reminder-bot). Leave `DATABASE_URL` unset to use local SQLite.

## Local dev / verification

```
npm install
# .env with VOYAGE_API_KEY (+ ANTHROPIC_API_KEY for media/labels), VIEWER_TOKEN
npm run seed          # SQLite by default; populates a themed graph
npm start             # then open http://localhost:3000/?token=YOUR_VIEWER_TOKEN
npm test              # graph logic always; db.test.js only when DATABASE_URL set
```

## Notes / gotchas

- **Embedding dim is baked into the `VECTOR(n)` column.** Fix the provider/model before
  accumulating data; each row stores `embedding_model` to make a future re-embed safe.
- **pgvector required in prod.** On Railway use a pgvector-enabled Postgres image.
- **SQLite path** has no ANN index — it scans + cosines in JS (fine for seed/local sizes).
- Graph computation is cron-only (never on the capture path) so ingest stays fast and scales.

# Setup & Deployment

The Thoughts service is the idea-graph "brain". It receives captures from
`reminder-bot` and serves the web viewer. Here's how to take it live.

## 1. Get a Voyage API key (embeddings)

Sign up at https://www.voyageai.com → create an API key. Embeddings are what let
ideas connect by meaning. (You can switch to OpenAI later via `EMBEDDING_PROVIDER=openai`.)

## 2. Deploy on Railway (second service)

1. New Railway project (or a new service in your existing one) from this repo.
2. Add a **Postgres with pgvector**. The stock Railway Postgres plugin may not have
   the `vector` extension — use a pgvector-enabled image (e.g. deploy `pgvector/pgvector:pg16`
   as a service, or a template that includes it). On boot the app runs
   `CREATE EXTENSION IF NOT EXISTS vector` and will log a clear error if it's missing.
3. Set environment variables (see `.env.example`):
   - `DATABASE_URL` — reference the pgvector Postgres
   - `VOYAGE_API_KEY` — from step 1
   - `ANTHROPIC_API_KEY` — for image/PDF analysis + cluster labels
   - `VIEWER_TOKEN` — any long random string (gates the web viewer)
   - `THOUGHTS_INGEST_SECRET` — any long random string (gates `/api/ingest`)
   - `OPENAI_API_KEY` — optional, only for voice-note transcription
4. Deploy. The start command is `node start.js` (Procfile).

## 3. Point reminder-bot at it

In the **reminder-bot** service's env, set:
- `THOUGHTS_INGEST_URL` = your Thoughts service URL (e.g. `https://thoughts-xxxx.up.railway.app`)
- `THOUGHTS_INGEST_SECRET` = the **same** secret as step 2

Redeploy reminder-bot. Now anything you send that's an idea — an `idea:`/`thought:`/`#`
prefix, or a note the AI classifies as an idea — plus new journal/memory entries, flows
into the graph automatically.

## 4. Backfill existing notes (optional, one-time)

From the reminder-bot service (it has `DATABASE_URL`):

```
node scripts/backfill-thoughts.js
```

Idempotent — safe to re-run; already-sent rows are skipped.

## 5. Open the graph

```
https://thoughts-xxxx.up.railway.app/?token=YOUR_VIEWER_TOKEN
```

Scroll to zoom, drag to pan. Nodes grow and brighten as themes recur; clusters are
your hot spots. Clustering + labels refresh on a schedule (every 6h / daily), so a
brand-new graph fills in its structure over the first day.

## Local trial (no cloud)

```
npm install
# .env with VOYAGE_API_KEY, ANTHROPIC_API_KEY, VIEWER_TOKEN
npm run seed     # uses local SQLite; inserts themed sample ideas
npm start        # open http://localhost:3000/?token=YOUR_VIEWER_TOKEN
```

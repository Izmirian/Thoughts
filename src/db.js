/**
 * Database layer — Postgres (with the pgvector extension) when DATABASE_URL is
 * set, otherwise SQLite for local dev. All exported functions are async and work
 * with both. Vector similarity uses pgvector in production; SQLite stores the
 * embedding as JSON and computes cosine in JS (fine for local / seed-sized sets).
 *
 * Structure & helpers mirror the sibling reminder-bot project.
 */
import pg from 'pg';
import { EMBEDDING_DIM } from './embeddings.js';
import { CONFIG } from './config.js';

const { Pool } = pg;

let pool;
let isPostgres = false;
let sqliteDb = null;

export function isPg() { return isPostgres; }

/** Format a JS number array as a pgvector literal: [1,2,3] */
function toVectorLiteral(arr) {
  return '[' + Array.from(arr).join(',') + ']';
}

async function initPostgres() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
    max: CONFIG.DB_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: CONFIG.DB_STATEMENT_TIMEOUT,
  });
  pool.on('error', (err) => console.error('[DB] Pool error (will be retried):', err.message));

  // pgvector extension — required for similarity search.
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch (e) {
    console.error('[DB] Could not enable pgvector extension:', e.message,
      '\n      Install it on your Postgres (Railway: use a pgvector-enabled image).');
    throw e;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ideas (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_text TEXT,
      source TEXT DEFAULT 'whatsapp',
      source_type TEXT DEFAULT 'text',
      source_ref TEXT,
      media_ref TEXT,
      media_data BYTEA,
      embedding VECTOR(${EMBEDDING_DIM}),
      embedding_model TEXT,
      cluster_id INTEGER,
      heat REAL DEFAULT 0,
      degree INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (chat_id, source, source_ref)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS idea_edges (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      src INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      dst INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      similarity REAL NOT NULL,
      weight REAL NOT NULL,
      reinforced_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (src, dst)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clusters (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      cluster_key INTEGER NOT NULL,
      label TEXT,
      summary TEXT,
      size INTEGER DEFAULT 0,
      density REAL DEFAULT 0,
      heat REAL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (chat_id, cluster_key)
    )
  `);

  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ideas_chat ON ideas(chat_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ideas_cluster ON ideas(chat_id, cluster_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_edges_chat ON idea_edges(chat_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_edges_src ON idea_edges(src)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_edges_dst ON idea_edges(dst)`);
  } catch (e) { console.error('[DB] Index creation:', e.message); }

  // HNSW ANN index for cosine similarity (best-effort — needs pgvector >= 0.5).
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ideas_embedding ON ideas USING hnsw (embedding vector_cosine_ops)`);
  } catch (e) {
    console.warn('[DB] HNSW index unavailable (falling back to exact scan):', e.message);
  }

  isPostgres = true;
  console.log('[DB] Connected to Postgres (pgvector, dim=' + EMBEDDING_DIM + ')');
}

async function initSqlite() {
  const { default: Database } = await import('better-sqlite3');
  const { mkdirSync } = await import('fs');
  const { dirname, join } = await import('path');
  const { fileURLToPath } = await import('url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dataDir = join(__dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });

  sqliteDb = new Database(join(dataDir, 'thoughts.db'));
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_text TEXT,
      source TEXT DEFAULT 'whatsapp',
      source_type TEXT DEFAULT 'text',
      source_ref TEXT,
      media_ref TEXT,
      media_data BLOB,
      embedding TEXT,
      embedding_model TEXT,
      cluster_id INTEGER,
      heat REAL DEFAULT 0,
      degree INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (chat_id, source, source_ref)
    );
    CREATE TABLE IF NOT EXISTS idea_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      src INTEGER NOT NULL,
      dst INTEGER NOT NULL,
      similarity REAL NOT NULL,
      weight REAL NOT NULL,
      reinforced_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (src, dst)
    );
    CREATE TABLE IF NOT EXISTS clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      cluster_key INTEGER NOT NULL,
      label TEXT, summary TEXT,
      size INTEGER DEFAULT 0, density REAL DEFAULT 0, heat REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (chat_id, cluster_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ideas_chat ON ideas(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_edges_chat ON idea_edges(chat_id);
  `);
  console.log('[DB] Using SQLite (local, cosine in JS)');
}

// Initialize on import.
if (process.env.DATABASE_URL) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await initPostgres(); break; }
    catch (err) {
      console.error(`[DB] Connection attempt ${attempt}/5 failed:`, err.message);
      if (attempt === 5) console.error('[DB] All attempts failed — starting without DB.');
      else { const d = attempt * 3000; console.log(`[DB] Retrying in ${d / 1000}s...`); await new Promise(r => setTimeout(r, d)); }
    }
  }
} else {
  await initSqlite();
}

export async function closePool() { if (pool) { await pool.end(); console.log('[DB] Pool closed'); } }
export async function pingDb() {
  if (!isPostgres && !sqliteDb) throw new Error('DB not initialized');
  if (isPostgres) await pool.query('SELECT 1'); else sqliteDb.prepare('SELECT 1').get();
  return true;
}

// --- query helpers (? -> $n translation), mirrors reminder-bot ---
async function query(sql, params = []) {
  if (isPostgres) {
    let idx = 0; const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    return pool.query(pgSql, params);
  }
  return { rows: sqliteDb.prepare(sql).all(...params), rowCount: 0 };
}
async function queryOne(sql, params = []) { return (await query(sql, params)).rows[0] || null; }
async function run(sql, params = []) {
  if (isPostgres) {
    let idx = 0; const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    const r = await pool.query(pgSql, params);
    return { changes: r.rowCount };
  }
  const r = sqliteDb.prepare(sql).run(...params);
  return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
}

// =====================================================================
// Ideas
// =====================================================================

/**
 * Insert an idea. Idempotent on (chat_id, source, source_ref): if a row with the
 * same source_ref already exists, returns its id instead of creating a duplicate
 * (so journal/memory backfill is safe to re-run). Returns { id, created }.
 */
export async function createIdea({ chatId, content, rawText = null, source = 'whatsapp',
  sourceType = 'text', sourceRef = null, mediaRef = null, mediaData = null }) {
  if (isPostgres) {
    const r = await pool.query(
      `INSERT INTO ideas (chat_id, content, raw_text, source, source_type, source_ref, media_ref, media_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chat_id, source, source_ref) DO NOTHING
       RETURNING id`,
      [chatId, content, rawText, source, sourceType, sourceRef, mediaRef, mediaData]
    );
    if (r.rows[0]) return { id: r.rows[0].id, created: true };
    const existing = await pool.query(
      `SELECT id FROM ideas WHERE chat_id=$1 AND source=$2 AND source_ref=$3`,
      [chatId, source, sourceRef]
    );
    return { id: existing.rows[0]?.id, created: false };
  }
  const res = sqliteDb.prepare(
    `INSERT OR IGNORE INTO ideas (chat_id, content, raw_text, source, source_type, source_ref, media_ref, media_data)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(chatId, content, rawText, source, sourceType, sourceRef, mediaRef, mediaData);
  if (res.changes > 0) return { id: res.lastInsertRowid, created: true };
  const existing = sqliteDb.prepare(
    `SELECT id FROM ideas WHERE chat_id=? AND source=? AND source_ref IS ?`
  ).get(chatId, source, sourceRef);
  return { id: existing?.id, created: false };
}

export async function getIdea(id) { return queryOne('SELECT * FROM ideas WHERE id = ?', [id]); }

export async function storeEmbedding(id, vec, model) {
  if (isPostgres) {
    await pool.query('UPDATE ideas SET embedding = $1::vector, embedding_model = $2 WHERE id = $3',
      [toVectorLiteral(vec), model, id]);
  } else {
    await run('UPDATE ideas SET embedding = ?, embedding_model = ? WHERE id = ?',
      [JSON.stringify(Array.from(vec)), model, id]);
  }
}

/** Top-K nearest neighbours by cosine similarity within a chat (excludes self). */
export async function nearestNeighbors(chatId, vec, k, excludeId = -1) {
  if (isPostgres) {
    const r = await pool.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
       FROM ideas
       WHERE chat_id = $2 AND id <> $3 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [toVectorLiteral(vec), chatId, excludeId, k]
    );
    return r.rows.map(row => ({ id: row.id, similarity: Number(row.similarity) }));
  }
  // SQLite: cosine in JS over the chat's embedded rows.
  const rows = sqliteDb.prepare(
    'SELECT id, embedding FROM ideas WHERE chat_id = ? AND id <> ? AND embedding IS NOT NULL'
  ).all(chatId, excludeId);
  const target = Array.from(vec);
  const scored = rows.map(row => {
    const e = JSON.parse(row.embedding);
    let dot = 0;
    for (let i = 0; i < target.length; i++) dot += target[i] * (e[i] || 0);
    return { id: row.id, similarity: dot }; // both vectors are unit-normalized
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

// =====================================================================
// Edges
// =====================================================================

export async function getEdge(src, dst) {
  return queryOne('SELECT * FROM idea_edges WHERE src = ? AND dst = ?', [src, dst]);
}

export async function insertEdge(chatId, src, dst, similarity, weight) {
  if (isPostgres) {
    await pool.query(
      `INSERT INTO idea_edges (chat_id, src, dst, similarity, weight)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (src, dst) DO NOTHING`,
      [chatId, src, dst, similarity, weight]
    );
  } else {
    await run(`INSERT OR IGNORE INTO idea_edges (chat_id, src, dst, similarity, weight)
               VALUES (?,?,?,?,?)`, [chatId, src, dst, similarity, weight]);
  }
}

/** Update an existing edge: bump reinforced_count, refresh similarity/weight/updated_at. */
export async function updateEdge(id, { similarity, weight, reinforcedCount }) {
  const ts = isPostgres ? 'NOW()' : "datetime('now')";
  await run(
    `UPDATE idea_edges SET similarity = ?, weight = ?, reinforced_count = ?, updated_at = ${ts} WHERE id = ?`,
    [similarity, weight, reinforcedCount, id]
  );
}

/** Bump only the reinforcement of an existing edge (used by triangle reinforcement). */
export async function bumpEdgeReinforce(id, weight) {
  const ts = isPostgres ? 'NOW()' : "datetime('now')";
  await run(
    `UPDATE idea_edges SET reinforced_count = reinforced_count + 1, weight = ?, updated_at = ${ts} WHERE id = ?`,
    [weight, id]
  );
}

export async function recomputeDegree(id) {
  await run(
    `UPDATE ideas SET degree = (SELECT COUNT(*) FROM idea_edges WHERE src = ? OR dst = ?) WHERE id = ?`,
    [id, id, id]
  );
}

/** Weakest edges of a node beyond the fan-out cap, returned strongest-first excluded. */
export async function pruneWeakestEdges(nodeId, keep) {
  const edges = (await query(
    `SELECT id, weight FROM idea_edges WHERE src = ? OR dst = ? ORDER BY weight DESC`,
    [nodeId, nodeId]
  )).rows;
  if (edges.length <= keep) return 0;
  const toDrop = edges.slice(keep).map(e => e.id);
  for (const id of toDrop) await run('DELETE FROM idea_edges WHERE id = ?', [id]);
  return toDrop.length;
}

// =====================================================================
// Graph read (for /api/graph) and clustering writes
// =====================================================================

export async function getGraph({ chatId = null, limit = CONFIG.GRAPH_DEFAULT_LIMIT, minWeight = 0, since = null } = {}) {
  const where = [];
  const params = [];
  if (chatId) { where.push('chat_id = ?'); params.push(chatId); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const nodes = (await query(
    `SELECT id, content, source_type, cluster_id, heat, degree, created_at
     FROM ideas ${whereSql} ORDER BY heat DESC, id DESC LIMIT ?`,
    [...params, limit]
  )).rows;

  const idSet = new Set(nodes.map(n => n.id));
  const edgeRows = (await query(
    `SELECT src, dst, weight FROM idea_edges ${chatId ? 'WHERE chat_id = ?' : ''} ${minWeight ? (chatId ? 'AND' : 'WHERE') + ' weight >= ?' : ''}`,
    [...(chatId ? [chatId] : []), ...(minWeight ? [minWeight] : [])]
  )).rows;
  const edges = edgeRows.filter(e => idSet.has(e.src) && idSet.has(e.dst));

  const clusters = (await query(
    `SELECT cluster_key AS id, label, summary, size, density, heat FROM clusters ${chatId ? 'WHERE chat_id = ?' : ''} ORDER BY heat DESC`,
    chatId ? [chatId] : []
  )).rows;

  return {
    nodes: nodes.map(n => ({
      id: n.id,
      label: (n.content || '').slice(0, 80),
      content: n.content,
      sourceType: n.source_type,
      cluster: n.cluster_id,
      heat: Number(n.heat) || 0,
      degree: n.degree || 0,
      createdAt: n.created_at,
    })),
    edges: edges.map(e => ({ source: e.src, target: e.dst, weight: Number(e.weight) || 0 })),
    clusters: clusters.map(c => ({
      id: c.id, label: c.label, summary: c.summary,
      size: c.size, density: Number(c.density) || 0, heat: Number(c.heat) || 0,
    })),
  };
}

/** Distinct chat_ids that have at least one idea (used by cron jobs). */
export async function getChatIds() {
  return (await query('SELECT DISTINCT chat_id FROM ideas', [])).rows.map(r => r.chat_id);
}

export async function getNodesForChat(chatId) {
  return (await query('SELECT id, cluster_id, created_at FROM ideas WHERE chat_id = ?', [chatId])).rows;
}
export async function getEdgesForChat(chatId) {
  return (await query('SELECT src, dst, weight FROM idea_edges WHERE chat_id = ?', [chatId])).rows;
}

export async function setClusterId(ideaId, clusterKey) {
  await run('UPDATE ideas SET cluster_id = ? WHERE id = ?', [clusterKey, ideaId]);
}
export async function setIdeaHeat(ideaId, heat) {
  await run('UPDATE ideas SET heat = ? WHERE id = ?', [heat, ideaId]);
}

export async function upsertCluster(chatId, clusterKey, { label = null, summary = null, size = 0, density = 0, heat = 0 }) {
  if (isPostgres) {
    await pool.query(
      `INSERT INTO clusters (chat_id, cluster_key, label, summary, size, density, heat, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
       ON CONFLICT (chat_id, cluster_key) DO UPDATE SET
         size = EXCLUDED.size, density = EXCLUDED.density, heat = EXCLUDED.heat,
         label = COALESCE(EXCLUDED.label, clusters.label),
         summary = COALESCE(EXCLUDED.summary, clusters.summary),
         updated_at = NOW()`,
      [chatId, clusterKey, label, summary, size, density, heat]
    );
  } else {
    const existing = sqliteDb.prepare('SELECT id, label, summary FROM clusters WHERE chat_id=? AND cluster_key=?').get(chatId, clusterKey);
    if (existing) {
      sqliteDb.prepare(`UPDATE clusters SET size=?, density=?, heat=?, label=COALESCE(?,label), summary=COALESCE(?,summary), updated_at=datetime('now') WHERE id=?`)
        .run(size, density, heat, label, summary, existing.id);
    } else {
      sqliteDb.prepare(`INSERT INTO clusters (chat_id, cluster_key, label, summary, size, density, heat) VALUES (?,?,?,?,?,?,?)`)
        .run(chatId, clusterKey, label, summary, size, density, heat);
    }
  }
}

/** Remove cluster rows that no longer correspond to a live community. */
export async function deleteClustersExcept(chatId, keepKeys) {
  if (!keepKeys.length) {
    await run('DELETE FROM clusters WHERE chat_id = ?', [chatId]);
    return;
  }
  const placeholders = keepKeys.map(() => '?').join(',');
  await run(`DELETE FROM clusters WHERE chat_id = ? AND cluster_key NOT IN (${placeholders})`, [chatId, ...keepKeys]);
}

export async function setClusterLabel(chatId, clusterKey, label, summary) {
  await run("UPDATE clusters SET label = ?, summary = ?, updated_at = " + (isPostgres ? 'NOW()' : "datetime('now')") + " WHERE chat_id = ? AND cluster_key = ?",
    [label, summary, chatId, clusterKey]);
}

/** Clusters that need a label (no label yet, size above threshold). */
export async function getUnlabeledClusters(chatId, minSize) {
  return (await query(
    'SELECT cluster_key, size FROM clusters WHERE chat_id = ? AND (label IS NULL OR label = ?) AND size >= ? ORDER BY heat DESC',
    [chatId, '', minSize]
  )).rows;
}

/** Sample idea texts for a cluster (highest-degree first) — for labeling. */
export async function sampleClusterContents(chatId, clusterKey, limit) {
  return (await query(
    'SELECT content FROM ideas WHERE chat_id = ? AND cluster_id = ? ORDER BY degree DESC, id DESC LIMIT ?',
    [chatId, clusterKey, limit]
  )).rows.map(r => r.content);
}

/** Prune weak + stale edges. Never removes nodes. Returns count removed. */
export async function pruneStaleEdges() {
  const cutoff = isPostgres
    ? `NOW() - INTERVAL '${CONFIG.EDGE_PRUNE_DAYS} days'`
    : `datetime('now','-${CONFIG.EDGE_PRUNE_DAYS} days')`;
  const r = await run(`DELETE FROM idea_edges WHERE weight < ? AND updated_at < ${cutoff}`, [CONFIG.EDGE_PRUNE_WEIGHT]);
  return r.changes || 0;
}

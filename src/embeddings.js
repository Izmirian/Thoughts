/**
 * Embeddings — provider-abstracted so the rest of the app never knows which
 * vendor is active. Claude has no embeddings API, so we use Voyage AI (default)
 * or OpenAI for real semantic quality. A deterministic, dependency-free `local`
 * provider is also available for offline dev and tests (lexical, not semantic —
 * good enough to exercise the whole pipeline without any API key).
 *
 * The vector dimension is baked into the DB column, so the provider/model must be
 * fixed before production data accumulates; each idea row also stores its
 * `embedding_model` so a future switch can be detected + re-embedded.
 */
import { CONFIG } from './config.js';

export const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER || 'voyage').toLowerCase();

// Known model dimensions. If you point at a model not listed here, set the
// dimension explicitly via EMBEDDING_DIM.
const MODEL_DIMS = {
  'voyage-3-lite': 512,
  'voyage-3': 1024,
  'voyage-3.5-lite': 1024,
  'voyage-3.5': 1024,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'local-hash-v1': 512,
};

export const EMBEDDING_MODEL =
  EMBEDDING_PROVIDER === 'openai' ? (process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small')
  : EMBEDDING_PROVIDER === 'local' ? 'local-hash-v1'
  : (process.env.VOYAGE_MODEL || 'voyage-3-lite');

export const EMBEDDING_DIM = parseInt(
  process.env.EMBEDDING_DIM || MODEL_DIMS[EMBEDDING_MODEL] || '512'
);

// Cosine threshold above which an edge is drawn. The semantic providers warrant a
// high bar; the lexical `local` provider produces lower absolute similarities, so
// it gets a lower default. An explicit SIM_THRESHOLD env always wins (see graph.js).
// Tuned for voyage-3-lite: related ideas land ~0.65-0.80, unrelated ~0.45-0.55,
// so 0.62 surfaces real connections without spurious edges. `local` is lexical
// (lower absolute scores) so it gets a lower bar. Override via SIM_THRESHOLD.
export const DEFAULT_SIM_THRESHOLD = EMBEDDING_PROVIDER === 'local' ? 0.30 : 0.62;

function truncate(text) {
  const t = (text || '').toString().trim();
  return t.length > CONFIG.EMBED_MAX_CHARS ? t.slice(0, CONFIG.EMBED_MAX_CHARS) : t;
}

/** Unit-normalize so cosine similarity == dot product downstream. */
function normalize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (!norm || !isFinite(norm)) return vec;
  return vec.map(v => v / norm);
}

async function fetchEmbeddings(url, headers, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT),
      });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && i < retries - 1) {
        const delay = Math.pow(2, i) * 1000;
        console.warn(`[Embed] ${res.status} — retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const errText = await res.text().catch(() => '');
      throw new Error(`Embedding API ${res.status}: ${errText}`);
    } catch (err) {
      if (i < retries - 1 && (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ECONNRESET')) {
        const delay = Math.pow(2, i) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function embedVoyage(texts, inputType) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set');
  const data = await fetchEmbeddings(
    'https://api.voyageai.com/v1/embeddings',
    { Authorization: `Bearer ${key}` },
    { model: EMBEDDING_MODEL, input: texts, input_type: inputType }
  );
  return data.data.map(d => d.embedding);
}

async function embedOpenAI(texts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const data = await fetchEmbeddings(
    'https://api.openai.com/v1/embeddings',
    { Authorization: `Bearer ${key}` },
    { model: EMBEDDING_MODEL, input: texts }
  );
  return data.data.map(d => d.embedding);
}

// --- Local deterministic provider (no network, no key) -----------------------
// Signed feature hashing over word tokens + character trigrams. Captures lexical
// overlap (shared words / morphology) so the full pipeline runs offline. NOT a
// substitute for real semantic embeddings — use Voyage/OpenAI in production.
const STOPWORDS = new Set(('a an the to of in on at for and or but if is are was were be been being '
  + 'i me my we our you your he she it they them this that these those with as by from about into '
  + 'so do does did just have has had not no yes can could would should will my mine').split(/\s+/));

function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function addFeature(vec, token, weight) {
  const h = hash32(token);
  const idx = h % vec.length;
  const sign = (h & 0x80000000) ? -1 : 1; // signed hashing limits collision bias
  vec[idx] += weight * sign;
}

// Crude stemmer so plurals/verb forms collide (cats->cat, running->run, loves->love).
function stem(w) {
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ly')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function embedLocal(text) {
  const vec = new Array(EMBEDDING_DIM).fill(0);
  const words = (text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w)).map(stem);
  for (const w of words) {
    addFeature(vec, 'w:' + w, 1.0);
    const padded = '#' + w + '#';
    for (let i = 0; i + 3 <= padded.length; i++) addFeature(vec, 'g:' + padded.slice(i, i + 3), 0.3);
  }
  return vec;
}

/**
 * Embed a batch of texts. `inputType` ('document' | 'query') only affects Voyage.
 * Returns an array of unit-normalized vectors aligned with the input order.
 */
export async function embedBatch(texts, inputType = 'document') {
  const clean = texts.map(truncate);
  let raw;
  if (EMBEDDING_PROVIDER === 'local') raw = clean.map(embedLocal);
  else if (EMBEDDING_PROVIDER === 'openai') raw = await embedOpenAI(clean);
  else raw = await embedVoyage(clean, inputType);
  return raw.map(normalize);
}

/** Embed a single text. */
export async function embed(text, inputType = 'document') {
  const [vec] = await embedBatch([text], inputType);
  return vec;
}

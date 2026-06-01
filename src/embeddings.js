/**
 * Embeddings — provider-abstracted so the rest of the app never knows which
 * vendor is active. Claude has no embeddings API, so we use Voyage AI (default)
 * or OpenAI. The vector dimension is baked into the DB column, so the provider/
 * model must be fixed before production data accumulates; each idea row also
 * stores its `embedding_model` so a future switch can be detected + re-embedded.
 */
import { CONFIG } from './config.js';

const PROVIDER = (process.env.EMBEDDING_PROVIDER || 'voyage').toLowerCase();

// Known model dimensions. If you point at a model not listed here, set the
// dimension explicitly via EMBEDDING_DIM.
const MODEL_DIMS = {
  'voyage-3-lite': 512,
  'voyage-3': 1024,
  'voyage-3.5-lite': 1024,
  'voyage-3.5': 1024,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

export const EMBEDDING_MODEL = PROVIDER === 'openai'
  ? (process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small')
  : (process.env.VOYAGE_MODEL || 'voyage-3-lite');

export const EMBEDDING_DIM = parseInt(
  process.env.EMBEDDING_DIM || MODEL_DIMS[EMBEDDING_MODEL] || '512'
);

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
      // Retry on rate-limit / server errors
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
  // OpenAI preserves input order
  return data.data.map(d => d.embedding);
}

/**
 * Embed a batch of texts. `inputType` ('document' | 'query') only affects Voyage.
 * Returns an array of unit-normalized vectors aligned with the input order.
 */
export async function embedBatch(texts, inputType = 'document') {
  const clean = texts.map(truncate);
  const raw = PROVIDER === 'openai' ? await embedOpenAI(clean) : await embedVoyage(clean, inputType);
  return raw.map(normalize);
}

/** Embed a single text. */
export async function embed(text, inputType = 'document') {
  const [vec] = await embedBatch([text], inputType);
  return vec;
}

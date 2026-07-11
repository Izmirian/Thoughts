/**
 * "Ask my brain" — semantic Q&A over everything the user has captured.
 * Embeds the question (query-side), retrieves the nearest ideas with pgvector,
 * and has Claude answer grounded ONLY in those notes. Honest when the notes
 * contain nothing relevant. Haiku-first with a Sonnet fallback (labeler pattern).
 */
import { embed } from './embeddings.js';
import { nearestNeighbors, getIdea } from './db.js';

export const MIN_SIMILARITY = 0.45; // below this, a note isn't really about the question
export const MAX_SOURCES = 8;

/** Pure: pick and shape the retrieved notes that are similar enough to use. */
export function selectSources(neighbors, ideasById) {
  return neighbors
    .filter(n => n.similarity >= MIN_SIMILARITY)
    .slice(0, MAX_SOURCES)
    .map(n => {
      const idea = ideasById[n.id];
      if (!idea) return null;
      return {
        id: n.id,
        similarity: Number(n.similarity.toFixed(3)),
        content: idea.content,
        createdAt: idea.created_at || null,
      };
    })
    .filter(Boolean);
}

/** Pure: build the grounded-answer prompt. */
export function buildAskPrompt(question, sources) {
  const notes = sources
    .map((s, i) => `  [${i + 1}] (${String(s.createdAt || '').slice(0, 10) || 'undated'}) ${s.content}`)
    .join('\n');
  return `These are the user's own captured notes/ideas:\n\n${notes}\n\n`
    + `Question: "${question}"\n\n`
    + `Answer the question using ONLY these notes. Be concise (2-4 sentences), reference `
    + `notes by their [n] number where relevant, and if the notes only partially answer `
    + `it, say what's missing. Do not invent anything that isn't in the notes.`;
}

async function callClaude(model, prompt) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const res = await client.messages.create({
    model, max_tokens: 400, messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0]?.text?.trim();
}

/**
 * Answer a question from the user's own notes.
 * Returns { ok, answer, sources } — sources may be empty (honest miss).
 */
export async function askBrain(chatId, question) {
  const q = (question || '').trim();
  if (!chatId || !q) return { ok: false, error: 'missing chatId or question' };

  const vec = await embed(q, 'query');
  const neighbors = await nearestNeighbors(chatId, vec, MAX_SOURCES, -1);

  const ideasById = {};
  for (const n of neighbors) {
    if (n.similarity >= MIN_SIMILARITY) ideasById[n.id] = await getIdea(n.id);
  }
  const sources = selectSources(neighbors, ideasById);

  if (!sources.length) {
    return { ok: true, answer: null, sources: [] }; // caller phrases the honest miss
  }

  let answer = null;
  if (process.env.ANTHROPIC_API_KEY) {
    const prompt = buildAskPrompt(q, sources);
    answer = await callClaude('claude-haiku-4-5-20251001', prompt).catch(() => null);
    if (!answer) answer = await callClaude('claude-sonnet-4-20250514', prompt).catch(() => null);
  }
  // Without a key (or on failure) we still return the raw matching notes.
  return { ok: true, answer, sources };
}

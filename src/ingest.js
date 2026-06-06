/**
 * Ingest pipeline: normalize an incoming payload to text, store it as an idea,
 * then embed + autonomously connect it. Images/voice become first-class nodes
 * by deriving a text description that gets embedded.
 *
 * Payload shape (from reminder-bot's forwarder or the seed script):
 *   { chatId, text?, mediaBase64?, mediaMime?, source?, sourceType?, sourceRef? }
 */
import { createIdea } from './db.js';
import { processNewIdea } from './graph.js';
import { analyzeImage, analyzePdfBuffer } from './analyze.js';
import { transcribeAudio } from './transcribe.js';
import { scheduleRecompute } from './recompute.js';

/** Derive the text to embed from whatever was sent. Returns { content, rawText, mediaBuffer }. */
async function deriveContent({ text, mediaBase64, mediaMime, sourceType }) {
  if (sourceType === 'text' || !mediaBase64) {
    return { content: (text || '').trim(), rawText: text || null, mediaBuffer: null };
  }
  const mediaBuffer = Buffer.from(mediaBase64, 'base64');

  if (sourceType === 'image') {
    const desc = await analyzeImage(mediaBuffer, mediaMime, null);
    const caption = text ? `${text}\n` : '';
    return { content: `${caption}${desc || ''}`.trim() || '(image)', rawText: text || null, mediaBuffer };
  }
  if (sourceType === 'document') {
    const desc = await analyzePdfBuffer(mediaBuffer, null);
    return { content: (desc || text || '(document)').trim(), rawText: text || null, mediaBuffer };
  }
  if (sourceType === 'audio') {
    const transcript = await transcribeAudio(mediaBuffer, mediaMime);
    return { content: (transcript || text || '').trim(), rawText: transcript || null, mediaBuffer };
  }
  return { content: (text || '').trim(), rawText: text || null, mediaBuffer: null };
}

/**
 * Ingest one item end-to-end. Returns
 *   { ok, id, created, linkedCount, topSimilarity } or { ok:false, reason }.
 */
export async function ingestIdea(payload) {
  const {
    chatId, source = 'whatsapp', sourceType = 'text', sourceRef = null, mediaRef = null,
  } = payload;
  if (!chatId) return { ok: false, reason: 'missing chatId' };

  const { content, rawText, mediaBuffer } = await deriveContent(payload);
  if (!content) return { ok: false, reason: 'no content to capture' };

  const { id, created } = await createIdea({
    chatId, content, rawText, source, sourceType, sourceRef, mediaRef,
    mediaData: mediaBuffer,
  });
  if (!id) return { ok: false, reason: 'insert failed' };

  // Already captured before (idempotent re-send) — don't re-link.
  if (!created) return { ok: true, id, created: false, linkedCount: 0, topSimilarity: 0 };

  let link = { linkedCount: 0, topSimilarity: 0 };
  try {
    link = await processNewIdea(chatId, id, content);
  } catch (e) {
    console.error('[Ingest] embedding/linking failed (idea still stored):', e.message);
  }

  // Refresh clusters/heat soon (debounced, off the response path) so hot spots
  // appear without waiting for the 6-hourly cron.
  scheduleRecompute(chatId);

  return { ok: true, id, created: true, linkedCount: link.linkedCount, topSimilarity: link.topSimilarity };
}

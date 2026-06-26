/**
 * Optional Claude pass that names clusters and explains why their ideas connect.
 * Purely additive — the graph works without labels; they just make hot spots
 * human-readable in the viewer. Haiku-first with a Sonnet fallback on bad JSON.
 */
import {
  getChatIds, getUnlabeledClusters, sampleClusterContents, setClusterLabel,
} from './db.js';

const MIN_CLUSTER_SIZE = 3;     // don't bother labeling tiny clusters
const MAX_SAMPLES = 12;         // representative ideas sent to Claude per cluster
const MAX_CLUSTERS_PER_RUN = 25;

function parseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function callClaude(model, prompt) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const res = await client.messages.create({
    model,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0]?.text;
}

async function labelOne(contents) {
  const prompt = `These are short personal notes/ideas that clustered together in a knowledge graph:\n\n`
    + contents.map((c, i) => `${i + 1}. ${c}`).join('\n')
    + `\n\nReturn ONLY JSON: { "label": "<2-4 word theme name>", "summary": "<one sentence on what connects them>" }`;

  let out = parseJson(await callClaude('claude-haiku-4-5-20251001', prompt).catch(() => null));
  if (!out?.label) out = parseJson(await callClaude('claude-sonnet-4-20250514', prompt).catch(() => null));
  return out?.label ? out : null;
}

export async function labelAllClusters() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const chatIds = await getChatIds();
  for (const chatId of chatIds) {
    const clusters = await getUnlabeledClusters(chatId, MIN_CLUSTER_SIZE);
    for (const c of clusters.slice(0, MAX_CLUSTERS_PER_RUN)) {
      try {
        const contents = await sampleClusterContents(chatId, c.cluster_key, MAX_SAMPLES);
        if (contents.length < MIN_CLUSTER_SIZE) continue;
        const result = await labelOne(contents);
        if (result) {
          await setClusterLabel(chatId, c.cluster_key, result.label, result.summary || null);
          console.log(`[Label] ${chatId} cluster ${c.cluster_key} -> "${result.label}"`);
        }
      } catch (e) { console.error('[Label] cluster failed:', e.message); }
    }
  }
}

/**
 * Keeps hot spots fresh without waiting for the 6-hourly cron: after new captures
 * we schedule a per-chat cluster/heat recompute, debounced so a burst of ideas
 * coalesces into a single pass (with a max wait so long bursts still refresh).
 * Runs off the response path — ingest never blocks on it.
 */
import { CONFIG } from './config.js';
import { recomputeClustersForChat } from './clustering.js';

const state = new Map(); // chatId -> { timer, firstAt }

async function run(chatId) {
  state.delete(chatId);
  try { await recomputeClustersForChat(chatId); }
  catch (e) { console.error(`[Recompute] ${chatId} failed:`, e.message); }
}

/** Schedule a debounced recompute for a chat. Safe to call on every capture. */
export function scheduleRecompute(chatId) {
  if (!chatId) return;
  const now = Date.now();
  const s = state.get(chatId) || { timer: null, firstAt: now };
  if (s.timer) clearTimeout(s.timer);

  const elapsed = now - s.firstAt;
  const delay = Math.min(CONFIG.RECOMPUTE_DEBOUNCE_MS, Math.max(0, CONFIG.RECOMPUTE_MAX_WAIT_MS - elapsed));
  s.timer = setTimeout(() => run(chatId), delay);
  if (s.timer.unref) s.timer.unref(); // don't keep the process alive for this
  state.set(chatId, s);

  // Bound the map in the unlikely event of many distinct chats.
  if (state.size > 500) { const k = state.keys().next().value; const old = state.get(k); if (old?.timer) clearTimeout(old.timer); state.delete(k); }
}

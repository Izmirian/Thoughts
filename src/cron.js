/**
 * Background jobs. Graph-wide computation runs here (never on the capture path)
 * so ingest stays fast and the design scales as the graph grows.
 */
import cron from 'node-cron';
import { recomputeAllClusters } from './clustering.js';
import { labelAllClusters } from './labeler.js';
import { pruneStaleEdges } from './db.js';

export function startCron() {
  // Clusters + heat — every 6 hours.
  cron.schedule('0 */6 * * *', async () => {
    console.log('[Cron] Recomputing clusters + heat...');
    try { await recomputeAllClusters(); } catch (e) { console.error('[Cron] cluster:', e.message); }
  });

  // Cluster labels via Claude — daily at 4am.
  cron.schedule('0 4 * * *', async () => {
    console.log('[Cron] Labeling clusters...');
    try { await labelAllClusters(); } catch (e) { console.error('[Cron] label:', e.message); }
  });

  // Prune weak + stale edges (never nodes) — daily at 3am.
  cron.schedule('0 3 * * *', async () => {
    try { const n = await pruneStaleEdges(); if (n) console.log(`[Cron] Pruned ${n} stale edges`); }
    catch (e) { console.error('[Cron] prune:', e.message); }
  });

  console.log('[Cron] Scheduled: clustering (6h), labeling (daily 4am), edge cleanup (daily 3am)');
}

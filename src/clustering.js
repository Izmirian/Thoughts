/**
 * Hot-spot detection. Runs off the hot path (cron): loads a chat's weighted graph
 * into graphology, runs Louvain community detection to find clusters, then scores
 * each node's "heat" (how much it belongs to a dense, recently-active cluster).
 * Results are persisted on ideas/clusters so /api/graph is a pure read.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { CONFIG } from './config.js';
import {
  getChatIds, getNodesForChat, getEdgesForChat,
  setClusterId, setIdeaHeat, upsertCluster,
} from './db.js';

function ageDays(createdAt) {
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

/** Recompute clusters + heat for every chat. */
export async function recomputeAllClusters() {
  const chatIds = await getChatIds();
  for (const chatId of chatIds) {
    try { await recomputeClustersForChat(chatId); }
    catch (e) { console.error(`[Cluster] ${chatId} failed:`, e.message); }
  }
}

export async function recomputeClustersForChat(chatId) {
  const nodes = await getNodesForChat(chatId);
  const edges = await getEdgesForChat(chatId);
  if (nodes.length === 0) return;

  const graph = new Graph({ type: 'undirected' });
  for (const n of nodes) graph.addNode(String(n.id));
  for (const e of edges) {
    const a = String(e.src), b = String(e.dst);
    if (graph.hasNode(a) && graph.hasNode(b) && !graph.hasEdge(a, b)) {
      graph.addEdge(a, b, { weight: Number(e.weight) || 0.0001 });
    }
  }

  // Communities. Isolated nodes get their own singleton community.
  let communities = {};
  if (graph.size > 0) {
    communities = louvain(graph, { getEdgeWeight: 'weight' });
  }
  let nextSolo = 1000000;
  for (const n of nodes) {
    const id = String(n.id);
    if (communities[id] === undefined) communities[id] = nextSolo++;
  }

  // Remap arbitrary community ids -> stable 0..k-1 cluster keys.
  const keyMap = new Map();
  let nextKey = 0;
  const clusterMembers = new Map(); // key -> [nodeId]
  for (const n of nodes) {
    const comm = communities[String(n.id)];
    if (!keyMap.has(comm)) keyMap.set(comm, nextKey++);
    const key = keyMap.get(comm);
    if (!clusterMembers.has(key)) clusterMembers.set(key, []);
    clusterMembers.get(key).push(n.id);
  }

  // Degree per node (from the in-memory graph).
  const degree = new Map();
  let maxDegree = 1;
  for (const n of nodes) {
    const d = graph.hasNode(String(n.id)) ? graph.degree(String(n.id)) : 0;
    degree.set(n.id, d);
    if (d > maxDegree) maxDegree = d;
  }

  // Per-cluster density + recent inflow.
  const idToCreated = new Map(nodes.map(n => [n.id, n.created_at]));
  const clusterDensity = new Map();
  const clusterRecent = new Map();
  let maxRecent = 1;
  for (const [key, members] of clusterMembers) {
    const memberSet = new Set(members.map(String));
    let internalEdges = 0;
    for (const e of edges) {
      if (memberSet.has(String(e.src)) && memberSet.has(String(e.dst))) internalEdges++;
    }
    const possible = members.length * (members.length - 1) / 2;
    clusterDensity.set(key, possible > 0 ? internalEdges / possible : 0);

    const recent = members.filter(id => ageDays(idToCreated.get(id)) <= CONFIG.HEAT_RECENT_DAYS).length;
    clusterRecent.set(key, recent);
    if (recent > maxRecent) maxRecent = recent;
  }

  // Assign cluster ids + heat, and persist.
  for (const [key, members] of clusterMembers) {
    const density = clusterDensity.get(key);
    const recentNorm = clusterRecent.get(key) / maxRecent;
    let clusterHeatSum = 0;
    for (const id of members) {
      const normDeg = degree.get(id) / maxDegree;
      const heat = CONFIG.HEAT_W_DEGREE * normDeg
        + CONFIG.HEAT_W_DENSITY * density
        + CONFIG.HEAT_W_RECENCY * recentNorm;
      await setClusterId(id, key);
      await setIdeaHeat(id, heat);
      clusterHeatSum += heat;
    }
    await upsertCluster(chatId, key, {
      size: members.length,
      density,
      heat: members.length ? clusterHeatSum / members.length : 0,
    });
  }

  console.log(`[Cluster] ${chatId}: ${nodes.length} ideas -> ${clusterMembers.size} clusters`);
}

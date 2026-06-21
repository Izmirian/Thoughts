/* Thoughts viewer — loads the graph JSON and renders it with Sigma (WebGL).
   Nodes are sized by heat and colored by cluster, so dense recurring themes show
   up as big, brightly-colored hot spots. Click a node to focus its neighbourhood;
   click a cluster in the legend to isolate it; search to spotlight matches. */

const Graph = graphology.Graph || graphology;
// `forceAtlas2` comes from vendor/forceatlas2.min.js (IIFE global)

const token = new URLSearchParams(location.search).get('token') || '';
const DIM_COLOR = '#2a3142';

// View state shared by the Sigma reducers; mutate then call refresh().
const state = { focusNode: null, neighbors: new Set(), filterCluster: null, search: '' };
let renderer = null;
let graph = null;

function clusterColor(clusterId) {
  if (clusterId === null || clusterId === undefined) return '#5d6675';
  // Golden-angle hashing -> well-spread, stable hues. Hex because Sigma's WebGL
  // color parser doesn't accept hsl()/rgba() for nodes.
  return hslToHex((clusterId * 137.508) % 360, 70, 58);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function nodeSize(heat, degree) {
  return Math.min(28, 3 + (degree || 0) * 0.4 + (heat || 0) * 18);
}

async function load() {
  const res = await fetch(`/api/graph?token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    document.getElementById('stats').textContent =
      res.status === 403 ? 'Forbidden — add ?token=… to the URL.' : `Error ${res.status}`;
    return;
  }
  render(await res.json());
}

function render(data) {
  graph = new Graph();
  const clusterLabels = {};
  for (const c of data.clusters) clusterLabels[c.id] = c.label;

  for (const n of data.nodes) {
    graph.addNode(n.id, {
      label: n.label || `#${n.id}`,
      content: n.content,
      cluster: n.cluster,
      clusterName: clusterLabels[n.cluster] || null,
      heat: n.heat,
      degree: n.degree,
      sourceType: n.sourceType,
      createdAt: n.createdAt,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: nodeSize(n.heat, n.degree),
      baseColor: clusterColor(n.cluster),
      color: clusterColor(n.cluster),
    });
  }
  for (const e of data.edges) {
    if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
      graph.addEdge(e.source, e.target, { weight: e.weight, size: Math.max(0.3, e.weight * 2.5) });
    }
  }

  if (graph.order > 1) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, { iterations: 320, settings: { ...settings, gravity: 1, scalingRatio: 12 } });
  }

  document.getElementById('stats').textContent =
    `${data.nodes.length} ideas · ${data.edges.length} links · ${data.clusters.length} clusters`;

  const notice = document.getElementById('notice');
  const heatReady = data.nodes.some(n => n.heat > 0);
  if (data.nodes.length > 1 && data.edges.length > 0 && (data.clusters.length === 0 || !heatReady)) {
    notice.textContent = 'Hot spots are still computing — click ↻ Recompute to generate them now.';
    notice.classList.remove('hidden');
  } else notice.classList.add('hidden');

  buildLegend(data.clusters);

  renderer = new Sigma(graph, document.getElementById('graph'), {
    minCameraRatio: 0.05,
    maxCameraRatio: 12,
    labelRenderedSizeThreshold: 8,
    labelColor: { color: '#cdd4e0' },
    nodeReducer,
    edgeReducer,
  });

  setupInteractions();
  setupSearch();
}

// --- Reducers: derive per-render appearance from `state` -----------------------

function isDimmed(node, attr) {
  if (state.search && !(attr.content || '').toLowerCase().includes(state.search)) return true;
  if (state.filterCluster !== null && attr.cluster !== state.filterCluster) return true;
  if (state.focusNode && node !== state.focusNode && !state.neighbors.has(node)) return true;
  return false;
}

function nodeReducer(node, attr) {
  if (isDimmed(node, attr)) return { ...attr, color: DIM_COLOR, label: '', zIndex: 0 };
  return { ...attr, color: attr.baseColor, highlighted: node === state.focusNode, zIndex: 1 };
}

function edgeReducer(edge, attr) {
  const [s, t] = graph.extremities(edge);
  if (state.focusNode && s !== state.focusNode && t !== state.focusNode) return { ...attr, hidden: true };
  if (state.filterCluster !== null) {
    if (graph.getNodeAttribute(s, 'cluster') !== state.filterCluster || graph.getNodeAttribute(t, 'cluster') !== state.filterCluster) {
      return { ...attr, hidden: true };
    }
  }
  const focused = state.focusNode && (s === state.focusNode || t === state.focusNode);
  return { ...attr, color: focused ? 'rgba(160,190,255,0.55)' : 'rgba(120,140,180,0.22)' };
}

function refresh() { renderer.refresh(); }

// --- Details panel -------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent — never innerHTML (untrusted data)
  return node;
}

function showDetails(node) {
  const a = graph.getNodeAttributes(node);
  const box = document.getElementById('details');
  const header = el('div', 'details-head');
  const dot = el('span', 'legend-dot'); dot.style.background = a.baseColor;
  header.append(dot, el('span', 'details-cluster', a.clusterName || (a.cluster != null ? 'cluster ' + a.cluster : 'unclustered')));
  const clear = el('span', 'details-clear', '✕'); clear.title = 'clear selection';
  clear.addEventListener('click', clearFocus);
  header.append(clear);

  const meta = `${a.degree} links · heat ${(a.heat || 0).toFixed(2)}`
    + (a.sourceType && a.sourceType !== 'text' ? ` · ${a.sourceType}` : '')
    + (a.createdAt ? ` · ${String(a.createdAt).slice(0, 10)}` : '');

  box.replaceChildren(header, el('div', 'details-body', a.content || a.label), el('div', 'meta', meta));
  box.classList.remove('hidden');
}

function clearFocus() {
  state.focusNode = null;
  state.neighbors = new Set();
  document.getElementById('details').classList.add('hidden');
  refresh();
}

// --- Legend (clickable cluster filter) -----------------------------------------

function buildLegend(clusters) {
  const container = document.getElementById('legend');
  container.replaceChildren();
  const top = [...clusters].filter(c => c.size > 1).sort((a, b) => b.heat - a.heat).slice(0, 12);
  for (const c of top) {
    const item = el('div', 'legend-item');
    item.dataset.cluster = c.id;
    const dot = el('span', 'legend-dot'); dot.style.background = clusterColor(c.id);
    item.append(dot, el('span', 'legend-label', c.label || 'cluster ' + c.id), el('span', 'legend-heat', `${c.size}·${c.heat.toFixed(2)}`));
    item.title = c.summary || '';
    item.addEventListener('click', () => toggleCluster(c.id, item));
    container.appendChild(item);
  }
  if (!top.length) container.appendChild(el('div', 'hint', 'No clusters yet — add more ideas.'));
}

function toggleCluster(clusterId, item) {
  const active = state.filterCluster === clusterId;
  state.filterCluster = active ? null : clusterId;
  for (const li of document.querySelectorAll('.legend-item')) li.classList.remove('active');
  if (!active) item.classList.add('active');
  // Clearing a cluster filter also drops any node focus for a clean reset.
  if (active) clearFocus(); else refresh();
}

// --- Interactions --------------------------------------------------------------

function setupInteractions() {
  const tooltip = document.getElementById('tooltip');

  renderer.on('enterNode', ({ node }) => {
    const a = graph.getNodeAttributes(node);
    const meta = (a.clusterName ? `🔥 ${a.clusterName} · ` : '') + `${a.degree} links · heat ${(a.heat || 0).toFixed(2)}`;
    tooltip.replaceChildren(el('div', null, a.content || a.label), el('div', 'meta', meta));
    tooltip.classList.remove('hidden');
  });
  renderer.on('leaveNode', () => tooltip.classList.add('hidden'));
  renderer.getMouseCaptor().on('mousemovebody', (e) => {
    tooltip.style.left = (e.x + 16) + 'px';
    tooltip.style.top = (e.y + 16) + 'px';
  });

  renderer.on('clickNode', ({ node }) => {
    state.focusNode = node;
    state.neighbors = new Set(graph.neighbors(node));
    showDetails(node);
    refresh();
  });
  renderer.on('clickStage', () => { if (state.focusNode) clearFocus(); });
}

function setupSearch() {
  document.getElementById('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    refresh();
  });
}

function setupRecompute() {
  const btn = document.getElementById('recompute');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Recomputing…';
    try {
      const res = await fetch(`/api/recompute?token=${encodeURIComponent(token)}`, { method: 'POST' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      location.reload();
    } catch {
      btn.textContent = 'Failed — retry';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = original; }, 2500);
    }
  });
}

setupRecompute();
load();

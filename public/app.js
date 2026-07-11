/* Thoughts viewer — loads the graph JSON and renders it with Sigma (WebGL).
   Connection quality (edge weight) is encoded as width + brightness; hot nodes
   glow; hover highlights a node's neighbourhood; click focuses with a smooth
   camera move. A status pill reports system health ("full green light"). */

const Graph = graphology.Graph || graphology;
const V = globalThis.ThoughtsViz; // vendor-free pure mapping fns (viz.js)

const token = new URLSearchParams(location.search).get('token') || '';
const DIM_COLOR = '#252c3c';
const BG_COLOR = '#0b0e14';
const HEAT_GLOW_MIN = 0.5;   // nodes at/above this heat get glow treatment
const MAX_HALOS = 40;
const IS_TOUCH = matchMedia('(hover: none)').matches;

// View state shared by the Sigma reducers; mutate then refresh().
const state = {
  focusNode: null, neighbors: new Set(),
  hoverNode: null, hoverNeighbors: new Set(),
  filterCluster: null, search: '',
};
let renderer = null;
let graph = null;

function interactionActive() {
  return !!(state.focusNode || state.hoverNode || state.filterCluster !== null || state.search);
}

// --- Data load -----------------------------------------------------------------

async function load() {
  showOverlay('loading');
  let res;
  try {
    res = await fetch(`/api/graph?token=${encodeURIComponent(token)}`);
  } catch {
    return showOverlay('error', 'Network error — is the service reachable?');
  }
  if (!res.ok) {
    return showOverlay('error', res.status === 403
      ? 'Forbidden — add ?token=YOUR_VIEWER_TOKEN to the URL.'
      : `Error ${res.status} loading the graph.`);
  }
  const data = await res.json();
  document.getElementById('stats').textContent =
    `${data.nodes.filter(n => n.kind !== 'entity').length} ideas · ${data.edges.length} links · ${data.clusters.length} clusters`;
  if (!data.nodes.length) {
    return showOverlay('empty');
  }
  hideOverlay();
  buildGraph(data);
  if (!renderer) mountRenderer(); else renderer.refresh();
  updateNotice(data);
  buildLegend(data.clusters);
}

// --- Graph construction ----------------------------------------------------------

function buildGraph(data, previousPositions = null) {
  if (!graph) graph = new Graph();
  else graph.clear();

  const clusterLabels = {};
  for (const c of data.clusters) clusterLabels[c.id] = c.label;

  for (const n of data.nodes) {
    const entity = n.kind === 'entity';
    const base = entity ? '#c9d2e3' : V.clusterColor(n.cluster);
    const hot = !entity && (n.heat || 0) >= HEAT_GLOW_MIN;
    const prev = previousPositions?.get(String(n.id));
    graph.addNode(n.id, {
      kind: n.kind || 'idea',
      label: entity ? `◇ ${n.label}` : (n.label || `#${n.id}`),
      content: n.content,
      entityType: n.entityType || null,
      cluster: n.cluster,
      clusterName: clusterLabels[n.cluster] || null,
      heat: n.heat, degree: n.degree,
      sourceType: n.sourceType, createdAt: n.createdAt,
      x: prev ? prev.x : Math.random() * 100,
      y: prev ? prev.y : Math.random() * 100,
      size: (entity ? Math.min(22, 5 + (n.degree || 0) * 2.5) : V.nodeSize(n.heat, n.degree)) + (hot ? 1.5 : 0),
      baseColor: hot ? V.heatColor(base, n.heat) : base,
      color: hot ? V.heatColor(base, n.heat) : base,
    });
  }
  for (const e of data.edges) {
    if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
      const kind = e.relation ? 'relation' : 'similarity';
      graph.addEdge(e.source, e.target, {
        kind, weight: e.weight, relation: e.relation || null, reason: e.reason || null,
        size: V.edgeWidth(kind, e.weight),
      });
    }
  }
  for (const m of (data.mentions || [])) {
    if (graph.hasNode(m.source) && graph.hasNode(m.target) && !graph.hasEdge(m.source, m.target)) {
      graph.addEdge(m.source, m.target, { kind: 'mention', weight: 0.5, size: V.edgeWidth('mention', 0.5) });
    }
  }

  if (graph.order > 1) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, { iterations: 320, settings: { ...settings, gravity: 1, scalingRatio: 12 } });
  }

  addHeatHalos();
}

// Soft glow behind the hottest ideas: synthetic oversized nodes pre-blended
// toward the background (WebGL nodes can't be translucent, so we fake it).
function addHeatHalos() {
  const hot = [];
  graph.forEachNode((id, a) => {
    if (a.kind === 'idea' && (a.heat || 0) >= HEAT_GLOW_MIN) hot.push({ id, heat: a.heat });
  });
  hot.sort((a, b) => b.heat - a.heat);
  for (const { id } of hot.slice(0, MAX_HALOS)) {
    const a = graph.getNodeAttributes(id);
    graph.addNode(`halo:${id}`, {
      kind: 'halo',
      label: '',
      x: a.x, y: a.y,
      size: a.size * 2.1,
      color: V.mixHex(a.baseColor, BG_COLOR, 0.78),
      baseColor: V.mixHex(a.baseColor, BG_COLOR, 0.78),
      zIndex: 0,
    });
  }
}

function mountRenderer() {
  renderer = new Sigma(graph, document.getElementById('graph'), {
    minCameraRatio: 0.05,
    maxCameraRatio: 12,
    zIndex: true,
    labelRenderedSizeThreshold: 9,
    labelColor: { color: '#dbe2ee' },
    labelFont: 'system-ui, -apple-system, sans-serif',
    labelWeight: '500',
    labelDensity: 0.07,
    labelGridCellSize: 60,
    nodeReducer,
    edgeReducer,
  });
  setupInteractions();
  setupSearch();
  window.__thoughts = { renderer, graph }; // debug handle (token-gated page)
}

// --- Reducers: derive per-render appearance from `state` -------------------------

function isDimmed(node, attr) {
  if (state.search && !(attr.content || '').toLowerCase().includes(state.search)) return true;
  if (state.filterCluster !== null && attr.cluster !== state.filterCluster) return true;
  if (state.focusNode) return node !== state.focusNode && !state.neighbors.has(node);
  if (state.hoverNode) return node !== state.hoverNode && !state.hoverNeighbors.has(node);
  return false;
}

function nodeReducer(node, attr) {
  if (attr.kind === 'halo') {
    // Halos vanish during any interaction so highlighting stays crisp.
    return interactionActive() ? { ...attr, hidden: true } : { ...attr, zIndex: 0, label: '' };
  }
  if (isDimmed(node, attr)) return { ...attr, color: DIM_COLOR, label: '', zIndex: 1 };
  const active = node === state.focusNode || node === state.hoverNode;
  return { ...attr, color: attr.baseColor, highlighted: node === state.focusNode, zIndex: active ? 3 : 2 };
}

function edgeReducer(edge, attr) {
  const [s, t] = graph.extremities(edge);
  const anchor = state.focusNode || state.hoverNode;
  if (anchor && s !== anchor && t !== anchor) return { ...attr, hidden: true };
  if (state.filterCluster !== null) {
    const sc = graph.getNodeAttribute(s, 'cluster'), tc = graph.getNodeAttribute(t, 'cluster');
    if (attr.kind === 'mention') { if (sc !== state.filterCluster && tc !== state.filterCluster) return { ...attr, hidden: true }; }
    else if (sc !== state.filterCluster || tc !== state.filterCluster) return { ...attr, hidden: true };
  }
  const emphasized = !!(anchor && (s === anchor || t === anchor));
  return { ...attr, color: V.edgeColor(attr.kind, attr.weight, emphasized), zIndex: emphasized ? 2 : 1 };
}

function refresh() { renderer.refresh(); }

// --- Overlay (loading / empty / error) -------------------------------------------

function showOverlay(mode, message) {
  const ov = document.getElementById('overlay');
  ov.replaceChildren();
  if (mode === 'loading') {
    ov.append(el('div', 'spinner'), el('div', 'overlay-text', 'Loading your thoughts…'));
  } else if (mode === 'empty') {
    ov.append(
      el('div', 'overlay-emoji', '🧠'),
      el('div', 'overlay-title', 'No ideas yet'),
      el('div', 'overlay-text', 'Text your bot "idea: …" and watch your graph grow.'),
    );
  } else {
    const btn = el('button', 'overlay-btn', 'Retry');
    btn.addEventListener('click', load);
    ov.append(el('div', 'overlay-emoji', '⚠️'), el('div', 'overlay-text', message || 'Something went wrong.'), btn);
  }
  ov.classList.remove('hidden');
}
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }

function updateNotice(data) {
  const notice = document.getElementById('notice');
  const heatReady = data.nodes.some(n => n.heat > 0);
  if (data.nodes.length > 1 && data.edges.length > 0 && (data.clusters.length === 0 || !heatReady)) {
    notice.textContent = 'Hot spots are still computing — click ↻ Recompute to generate them now.';
    notice.classList.remove('hidden');
  } else notice.classList.add('hidden');
}

// --- Details panel ----------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent — never innerHTML (untrusted data)
  return node;
}

function showDetails(node) {
  const a = graph.getNodeAttributes(node);
  const box = document.getElementById('details');
  const isEntity = a.kind === 'entity';

  const header = el('div', 'details-head');
  const dot = el('span', 'legend-dot'); dot.style.background = a.baseColor;
  const heading = isEntity ? (a.entityType || 'entity')
    : (a.clusterName || (a.cluster != null ? 'cluster ' + a.cluster : 'unclustered'));
  header.append(dot, el('span', 'details-cluster', heading));
  const clear = el('span', 'details-clear', '✕'); clear.title = 'clear selection';
  clear.addEventListener('click', clearFocus);
  header.append(clear);

  const children = [header, el('div', 'details-body', a.content || a.label)];

  if (isEntity) {
    children.push(el('div', 'meta', `${a.degree} ideas mention this`));
  } else {
    const meta = `${a.degree} links · heat ${(a.heat || 0).toFixed(2)}`
      + (a.sourceType && a.sourceType !== 'text' ? ` · ${a.sourceType}` : '')
      + (a.createdAt ? ` · ${String(a.createdAt).slice(0, 10)}` : '');
    children.push(el('div', 'meta', meta));

    const rels = [];
    const ents = [];
    graph.forEachEdge(node, (edge, attr, s, t) => {
      const other = s === node ? t : s;
      const oa = graph.getNodeAttributes(other);
      if (attr.kind === 'mention' && oa.kind === 'entity') ents.push(oa.label.replace(/^◇ /, ''));
      else if (attr.relation) rels.push({ text: `${attr.relation} → ${(oa.content || oa.label || '').slice(0, 40)}`, reason: attr.reason });
    });
    if (rels.length) {
      children.push(el('div', 'details-sub', 'relationships'));
      for (const r of rels.slice(0, 6)) {
        children.push(el('div', 'details-rel', r.text));
        if (r.reason) children.push(el('div', 'details-reason', r.reason));
      }
    }
    if (ents.length) {
      children.push(el('div', 'details-sub', 'entities'));
      children.push(el('div', 'details-ents', ents.join(' · ')));
    }
  }

  box.replaceChildren(...children);
  box.classList.remove('hidden');
}

function clearFocus() {
  state.focusNode = null;
  state.neighbors = new Set();
  document.getElementById('details').classList.add('hidden');
  refresh();
}

// --- Legend (clickable cluster filter) --------------------------------------------

function buildLegend(clusters) {
  const container = document.getElementById('legend');
  container.replaceChildren();
  const top = [...clusters].filter(c => c.size > 1).sort((a, b) => b.heat - a.heat).slice(0, 12);
  for (const c of top) {
    const item = el('div', 'legend-item');
    item.dataset.cluster = c.id;
    const dot = el('span', 'legend-dot'); dot.style.background = V.clusterColor(c.id);
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
  if (active) clearFocus(); else refresh();
}

// --- Interactions ------------------------------------------------------------------

// A halo is a visual aura, not a target: route its events to the idea it wraps.
function resolveNode(node) {
  return String(node).startsWith('halo:') ? String(node).slice(5) : node;
}

function setupInteractions() {
  const tooltip = document.getElementById('tooltip');

  renderer.on('enterNode', ({ node }) => {
    node = resolveNode(node);
    state.hoverNode = node;
    state.hoverNeighbors = new Set(graph.neighbors(node));
    refresh();
    if (IS_TOUCH) return;
    const a = graph.getNodeAttributes(node);
    const meta = (a.clusterName ? `🔥 ${a.clusterName} · ` : '') + `${a.degree} links · heat ${(a.heat || 0).toFixed(2)}`;
    tooltip.replaceChildren(el('div', null, a.content || a.label), el('div', 'meta', meta));
    tooltip.classList.remove('hidden');
  });
  renderer.on('leaveNode', () => {
    state.hoverNode = null;
    state.hoverNeighbors = new Set();
    refresh();
    tooltip.classList.add('hidden');
  });
  if (!IS_TOUCH) {
    renderer.getMouseCaptor().on('mousemovebody', (e) => {
      tooltip.style.left = (e.x + 16) + 'px';
      tooltip.style.top = (e.y + 16) + 'px';
    });
  }

  renderer.on('clickNode', ({ node }) => {
    node = resolveNode(node);
    state.focusNode = node;
    state.neighbors = new Set(graph.neighbors(node));
    showDetails(node);
    refresh();
    // Smooth camera: center the node, zoom in a bit (never zoom OUT to it).
    const pos = renderer.getNodeDisplayData(node);
    const cam = renderer.getCamera();
    if (pos) cam.animate({ x: pos.x, y: pos.y, ratio: Math.min(cam.ratio, 0.35) }, { duration: 450 });
  });
  renderer.on('clickStage', () => { if (state.focusNode) clearFocus(); });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearFocus(); });

  document.getElementById('fit').addEventListener('click', () => {
    clearFocus();
    renderer.getCamera().animatedReset({ duration: 300 });
  });
}

function setupSearch() {
  document.getElementById('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    refresh();
  });
}

// Recompute without losing the camera: rebuild the graph in place, seeding the
// layout with the previous positions so the picture stays stable.
function setupRecompute() {
  const btn = document.getElementById('recompute');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Recomputing…';
    try {
      const res = await fetch(`/api/recompute?token=${encodeURIComponent(token)}`, { method: 'POST' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const dataRes = await fetch(`/api/graph?token=${encodeURIComponent(token)}`);
      if (!dataRes.ok) throw new Error(`graph ${dataRes.status}`);
      const data = await dataRes.json();
      const prev = new Map();
      graph?.forEachNode((id, a) => { if (a.kind !== 'halo') prev.set(String(id), { x: a.x, y: a.y }); });
      clearFocus();
      state.hoverNode = null; state.hoverNeighbors = new Set();
      buildGraph(data, prev);
      document.getElementById('stats').textContent =
        `${data.nodes.filter(n => n.kind !== 'entity').length} ideas · ${data.edges.length} links · ${data.clusters.length} clusters`;
      buildLegend(data.clusters);
      updateNotice(data);
      refresh();
      btn.textContent = original;
      btn.disabled = false;
    } catch {
      btn.textContent = 'Failed — retry';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = original; }, 2500);
    }
  });
}

// --- System status ("full green light") --------------------------------------------

const STATUS_GLYPH = { ok: '✓', warn: '!', down: '✕', unknown: '?' };
const STATUS_LABEL = { ok: 'All systems go', warn: 'Degraded', down: 'Attention needed', unknown: 'Status unknown' };
const SERVICE_NAMES = { bot: 'WhatsApp bot', graph: 'Graph service', db: 'Database', embeddings: 'Embeddings', ai: 'AI enrichment', freshness: 'Last idea' };

async function fetchStatus() {
  const pill = document.getElementById('status-pill');
  try {
    const res = await fetch(`/api/status?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(String(res.status));
    renderStatus(await res.json());
  } catch {
    pill.className = 'status-pill unknown';
    pill.replaceChildren(el('span', 'status-dot unknown'), el('span', null, 'Status unavailable'));
  }
}

function renderStatus(data) {
  const pill = document.getElementById('status-pill');
  const overall = data.overall || 'unknown';
  pill.className = `status-pill ${overall}`;
  pill.replaceChildren(el('span', `status-dot ${overall}`), el('span', null, STATUS_LABEL[overall] || overall));

  const grid = document.getElementById('status-detail');
  grid.replaceChildren();
  for (const key of ['bot', 'graph', 'db', 'embeddings', 'ai', 'freshness']) {
    const svc = data.services?.[key];
    if (!svc) continue;
    const st = svc.status || 'unknown';
    const row = el('div', 'status-row');
    row.append(
      el('span', `status-dot ${st}`),
      el('span', 'status-glyph', STATUS_GLYPH[st] || '?'),
      el('span', 'status-name', SERVICE_NAMES[key] || key),
      el('span', 'status-detail-text', svc.detail || ''),
    );
    grid.appendChild(row);
  }
}

function setupStatus() {
  const pill = document.getElementById('status-pill');
  const grid = document.getElementById('status-detail');
  pill.addEventListener('click', () => grid.classList.toggle('hidden'));
  fetchStatus();
  setInterval(() => { if (!document.hidden) fetchStatus(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchStatus(); });
}

setupRecompute();
setupStatus();
load();

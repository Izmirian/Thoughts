/* Thoughts viewer — loads the graph JSON and renders it with Sigma (WebGL).
   Connection quality (edge weight) is encoded as width + brightness; hot nodes
   glow; hover highlights a node's neighbourhood; click focuses with a smooth
   camera move. The graph is LIVE: it polls /api/graph and new ideas grow out of
   their cluster with an entrance tween. A status pill reports system health. */

const Graph = graphology.Graph || graphology;
const V = globalThis.ThoughtsViz; // vendor-free pure mapping fns (viz.js)

const token = new URLSearchParams(location.search).get('token') || '';
const DIM_COLOR = '#252c3c';
const BG_COLOR = '#0b0e14';
const HEAT_GLOW_MIN = 0.5;   // nodes at/above this heat get glow treatment
const MAX_HALOS = 40;
const IS_TOUCH = matchMedia('(hover: none)').matches;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const POLL_MS = 35000;       // live graph poll (status poll stays at 60s)
const ENTER_MS = 900;        // entrance tween length for newly arrived nodes

// View state shared by the Sigma reducers; mutate then refresh().
const state = {
  focusNode: null, neighbors: new Set(),
  hoverNode: null, hoverNeighbors: new Set(),
  filterCluster: null, search: '',
  newNodes: new Map(), // id -> performance.now() when it arrived via live poll
};
let renderer = null;
let graph = null;

function interactionActive() {
  return !!(state.focusNode || state.hoverNode || state.filterCluster !== null || state.search);
}

// --- Data pipeline ---------------------------------------------------------------
// One fetch, one capture, one apply — shared by initial load, live poll,
// delete, and recompute so every path preserves layout the same way.

async function fetchGraphData() {
  const res = await fetch(`/api/graph?token=${encodeURIComponent(token)}`);
  if (!res.ok) throw Object.assign(new Error(`graph ${res.status}`), { status: res.status });
  return res.json();
}

function capturePositions() {
  const prev = new Map();
  graph?.forEachNode((id, a) => {
    if (a.kind !== 'halo') prev.set(String(id), { x: a.x, y: a.y });
  });
  return prev;
}

function updateStats(data) {
  document.getElementById('stats').textContent =
    `${data.nodes.filter(n => n.kind !== 'entity').length} ideas · ${data.edges.length} links · ${data.clusters.length} clusters`;
}

function applyData(data, prev = null) {
  buildGraph(data, prev);
  updateStats(data);
  buildLegend(data.clusters);
  updateNotice(data);
  if (!renderer) mountRenderer(); else refresh();
}

async function load() {
  showOverlay('loading');
  let data;
  try {
    data = await fetchGraphData();
  } catch (e) {
    if (e.status === 403) return showOverlay('error', 'Forbidden — add ?token=YOUR_VIEWER_TOKEN to the URL.');
    if (e.status) return showOverlay('error', `Error ${e.status} loading the graph.`);
    return showOverlay('error', 'Network error — is the service reachable?');
  }
  setLive('ok', Date.now());
  if (!data.nodes.length) return showOverlay('empty');
  hideOverlay();
  applyData(data);
  syncBaseline(data);
  introFit();
}

// --- Live poll: diff, apply in place, animate arrivals ----------------------------

let baselineKey = '';
let pollInFlight = false;

// Cheap change signature: node count is diffed separately; edges/mentions by
// count and clusters by content (labels + heat feed the legend).
function graphKey(data) {
  return `${data.edges.length + (data.mentions || []).length}|${JSON.stringify(data.clusters)}`;
}
function syncBaseline(data) { baselineKey = graphKey(data); }

function diffNodes(data) {
  const incoming = new Set(data.nodes.map(n => String(n.id)));
  const current = new Set();
  graph?.forEachNode((id, a) => { if (a.kind !== 'halo') current.add(String(id)); });
  return {
    added: [...incoming].filter(id => !current.has(id)),
    removed: [...current].filter(id => !incoming.has(id)),
  };
}

async function pollGraph() {
  if (document.hidden || pollInFlight) return;
  pollInFlight = true;
  try {
    let data;
    try {
      data = await fetchGraphData();
    } catch {
      setLive('offline');
      return;
    }
    setLive('ok', Date.now());
    if (!renderer) {
      // First ideas arrived while we sat on the empty state.
      if (data.nodes.length) { hideOverlay(); applyData(data); syncBaseline(data); introFit(); }
      return;
    }
    const { added, removed } = diffNodes(data);
    if (!added.length && !removed.length && graphKey(data) === baselineKey) return;
    if (interactionActive()) return; // never yank the graph mid-exploration; next tick catches up
    applyData(data, capturePositions());
    syncBaseline(data);
    if (added.length) {
      if (!REDUCED_MOTION) {
        const now = performance.now();
        for (const id of added) if (graph.hasNode(id)) state.newNodes.set(String(id), now);
        runEntranceLoop();
      }
      pulseLive();
    }
  } finally {
    pollInFlight = false;
  }
}

// Drives renderer.refresh() only while an entrance tween is active, then stops —
// no standing rAF loop burning battery.
let entranceRaf = 0;
function runEntranceLoop() {
  if (entranceRaf) return;
  const tick = () => {
    const now = performance.now();
    for (const [id, born] of state.newNodes) {
      if (now - born >= ENTER_MS) state.newNodes.delete(id);
    }
    refresh();
    entranceRaf = state.newNodes.size ? requestAnimationFrame(tick) : 0;
  };
  entranceRaf = requestAnimationFrame(tick);
}

// --- Live indicator ----------------------------------------------------------------

function setLive(mode, ts) {
  const box = document.getElementById('live');
  const text = box.querySelector('.live-text');
  if (mode === 'ok') {
    box.className = 'live ok';
    text.textContent = 'Live';
    if (ts) box.title = `Graph updated ${V.relativeTime(ts)} · refreshes every ${Math.round(POLL_MS / 1000)}s`;
  } else {
    box.className = 'live offline';
    text.textContent = 'Reconnecting…';
    box.title = 'Lost contact with the graph service — retrying automatically.';
  }
}

function pulseLive() {
  const dot = document.querySelector('#live .live-dot');
  if (!dot) return;
  dot.classList.remove('arrived');
  void dot.offsetWidth; // restart the one-shot animation
  dot.classList.add('arrived');
}

// --- Graph construction ----------------------------------------------------------

function buildGraph(data, previousPositions = null) {
  if (!graph) graph = new Graph();
  else graph.clear();

  const clusterLabels = {};
  for (const c of data.clusters) clusterLabels[c.id] = c.label;

  // Adjacency from the incoming payload so brand-new nodes can be born at their
  // neighbours' centroid (they visibly grow out of their cluster).
  let adjacency = null;
  if (previousPositions) {
    adjacency = new Map();
    const link = (a, b) => {
      const ka = String(a), kb = String(b);
      if (!adjacency.has(ka)) adjacency.set(ka, []);
      adjacency.get(ka).push(kb);
    };
    for (const e of data.edges) { link(e.source, e.target); link(e.target, e.source); }
    for (const m of (data.mentions || [])) { link(m.source, m.target); link(m.target, m.source); }
  }

  for (const n of data.nodes) {
    const entity = n.kind === 'entity';
    const base = entity ? '#c9d2e3' : V.clusterColor(n.cluster);
    const hot = !entity && (n.heat || 0) >= HEAT_GLOW_MIN;
    const prev = previousPositions?.get(String(n.id));
    let x, y;
    if (prev) {
      ({ x, y } = prev);
    } else if (adjacency) {
      const anchors = (adjacency.get(String(n.id)) || [])
        .map(id => previousPositions.get(id)).filter(Boolean);
      const spawn = V.spawnPosition(anchors);
      x = spawn ? spawn.x + (Math.random() - 0.5) * 8 : Math.random() * 100;
      y = spawn ? spawn.y + (Math.random() - 0.5) * 8 : Math.random() * 100;
    } else {
      x = Math.random() * 100;
      y = Math.random() * 100;
    }
    graph.addNode(n.id, {
      kind: n.kind || 'idea',
      label: entity ? `◇ ${n.label}` : (n.label || `#${n.id}`),
      content: n.content,
      entityType: n.entityType || null,
      cluster: n.cluster,
      clusterName: clusterLabels[n.cluster] || null,
      heat: n.heat, degree: n.degree,
      sourceType: n.sourceType, createdAt: n.createdAt,
      x, y,
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
    // Seeded relayouts start from good positions — fewer iterations, less jitter.
    const iterations = previousPositions ? 90 : 320;
    forceAtlas2.assign(graph, { iterations, settings: { ...settings, gravity: 1, scalingRatio: 12 } });
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
    stagePadding: 84, // breathing room: clear of the 68px-deep topbar, composition centered
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

// Gentle settle-in on first paint: start a touch zoomed out, ease to the
// centered fit. Skipped under prefers-reduced-motion.
function introFit() {
  if (!renderer || REDUCED_MOTION) return;
  const cam = renderer.getCamera();
  cam.setState({ ratio: 1.18 });
  cam.animate({ ratio: 1, x: 0.5, y: 0.5 }, { duration: 600 });
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
  const born = state.newNodes.get(String(node));
  if (born != null) {
    const t = V.clamp01((performance.now() - born) / ENTER_MS);
    return {
      ...attr,
      color: V.heatColor(attr.baseColor, 1 - t), // arrives bright, cools to base
      size: attr.size * V.entranceScale(t),
      label: '',
      zIndex: 4,
    };
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

function art(templateId) {
  return document.getElementById(templateId).content.cloneNode(true);
}

function showOverlay(mode, message) {
  const ov = document.getElementById('overlay');
  ov.replaceChildren();
  if (mode === 'loading') {
    ov.append(el('div', 'spinner'), el('div', 'overlay-text', 'Loading your thoughts…'));
  } else if (mode === 'empty') {
    ov.append(
      art('tpl-empty-art'),
      el('div', 'overlay-title', 'No ideas yet'),
      el('div', 'overlay-text', 'Text your bot "idea: …" and watch your graph grow — this page updates itself.'),
    );
  } else {
    const btn = el('button', 'overlay-btn', 'Retry');
    btn.addEventListener('click', load);
    ov.append(art('tpl-warn-art'), el('div', 'overlay-text', message || 'Something went wrong.'), btn);
  }
  ov.classList.remove('hidden');
}
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }

function updateNotice(data) {
  const notice = document.getElementById('notice');
  const heatReady = data.nodes.some(n => n.heat > 0);
  if (data.nodes.length > 1 && data.edges.length > 0 && (data.clusters.length === 0 || !heatReady)) {
    notice.textContent = 'Hot spots are still computing — "Recompute hot spots" below generates them now.';
    notice.classList.remove('hidden');
  } else notice.classList.add('hidden');
}

// --- Details card (floating, bottom-left) -----------------------------------------

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
  const clear = el('button', 'details-clear');
  clear.append(art('tpl-icon-x'));
  clear.title = 'Clear selection';
  clear.setAttribute('aria-label', 'Clear selection');
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

    const del = el('button', 'details-delete', 'Delete this idea');
    del.addEventListener('click', () => deleteIdea(node));
    children.push(del);
  }

  box.replaceChildren(...children);
  box.classList.remove('hidden');
}

// Delete a single idea (e.g. a duplicate capture), then refresh in place —
// layout is preserved through the shared pipeline.
async function deleteIdea(node) {
  if (!confirm('Delete this idea? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/idea/${encodeURIComponent(node)}?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    alert('Delete failed: ' + e.message);
    return;
  }
  let data;
  try { data = await fetchGraphData(); } catch { return; }
  const prev = capturePositions();
  clearFocus();
  state.hoverNode = null; state.hoverNeighbors = new Set();
  applyData(data, prev);
  syncBaseline(data);
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
    const item = el('button', 'legend-item');
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

// --- Drawer (controls, legends, hints) --------------------------------------------

function setDrawerOpen(open) {
  const drawer = document.getElementById('drawer');
  const toggle = document.getElementById('menu-toggle');
  drawer.classList.toggle('hidden', !open);
  toggle.classList.toggle('active', open);
  toggle.setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('thoughts.drawer', open ? '1' : '0'); } catch { /* private mode */ }
}

function setupDrawer() {
  const toggle = document.getElementById('menu-toggle');
  toggle.addEventListener('click', () => {
    setDrawerOpen(document.getElementById('drawer').classList.contains('hidden'));
  });
  let open = false;
  try { open = localStorage.getItem('thoughts.drawer') === '1'; } catch { /* private mode */ }
  if (open) setDrawerOpen(true);
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
    const meta = (a.clusterName ? `${a.clusterName} · ` : '') + `${a.degree} links · heat ${(a.heat || 0).toFixed(2)}`;
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
    if (pos) cam.animate({ x: pos.x, y: pos.y, ratio: Math.min(cam.ratio, 0.35) }, { duration: REDUCED_MOTION ? 0 : 450 });
  });
  renderer.on('clickStage', () => { if (state.focusNode) clearFocus(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearFocus();
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });

  document.getElementById('fit').addEventListener('click', () => {
    clearFocus();
    renderer.getCamera().animatedReset({ duration: REDUCED_MOTION ? 0 : 300 });
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
  const label = btn.querySelector('.btn-label');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = label.textContent;
    label.textContent = 'Recomputing…';
    try {
      const res = await fetch(`/api/recompute?token=${encodeURIComponent(token)}`, { method: 'POST' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await fetchGraphData();
      const prev = capturePositions();
      clearFocus();
      state.hoverNode = null; state.hoverNeighbors = new Set();
      applyData(data, prev);
      syncBaseline(data);
      label.textContent = original;
      btn.disabled = false;
    } catch {
      label.textContent = 'Failed — retry';
      btn.disabled = false;
      setTimeout(() => { label.textContent = original; }, 2500);
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
    pill.replaceChildren(el('span', 'status-dot unknown'), el('span', 'status-text', 'Status unavailable'));
  }
}

function renderStatus(data) {
  const pill = document.getElementById('status-pill');
  const overall = data.overall || 'unknown';
  pill.className = `status-pill ${overall}`;
  pill.replaceChildren(el('span', `status-dot ${overall}`), el('span', 'status-text', STATUS_LABEL[overall] || overall));

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
  // The pill lives in the topbar; its detail grid lives in the drawer — clicking
  // the pill opens the drawer (if needed) and reveals the grid.
  pill.addEventListener('click', () => {
    const drawerHidden = document.getElementById('drawer').classList.contains('hidden');
    if (drawerHidden) {
      setDrawerOpen(true);
      grid.classList.remove('hidden');
    } else {
      grid.classList.toggle('hidden');
    }
    pill.setAttribute('aria-expanded', String(!grid.classList.contains('hidden')));
  });
  fetchStatus();
  setInterval(() => { if (!document.hidden) fetchStatus(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchStatus(); });
}

// --- Boot --------------------------------------------------------------------------

setupDrawer();
setupRecompute();
setupStatus();
load();
setInterval(pollGraph, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollGraph(); });

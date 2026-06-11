/* Thoughts viewer — loads the graph JSON and renders it with Sigma (WebGL).
   Nodes are sized by heat and colored by cluster, so dense recurring themes
   show up as big, brightly-colored hot spots. */

const Graph = graphology.Graph || graphology;
// `forceAtlas2` comes from vendor/forceatlas2.min.js (IIFE global)

const token = new URLSearchParams(location.search).get('token') || '';

function clusterColor(clusterId) {
  if (clusterId === null || clusterId === undefined) return '#5d6675';
  // Golden-angle hashing -> well-spread, stable hues per cluster.
  // Emitted as hex because Sigma's WebGL color parser doesn't accept hsl().
  const hue = (clusterId * 137.508) % 360;
  return hslToHex(hue, 70, 58);
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
  const base = 3 + (degree || 0) * 0.4;
  return Math.min(28, base + (heat || 0) * 18);
}

async function load() {
  const res = await fetch(`/api/graph?token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    document.getElementById('stats').textContent =
      res.status === 403 ? 'Forbidden — add ?token=… to the URL.' : `Error ${res.status}`;
    return;
  }
  const data = await res.json();
  render(data);
}

function render(data) {
  const graph = new Graph();
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
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: nodeSize(n.heat, n.degree),
      color: clusterColor(n.cluster),
    });
  }
  for (const e of data.edges) {
    if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
      graph.addEdge(e.source, e.target, {
        weight: e.weight,
        size: Math.max(0.3, e.weight * 2.5),
        color: 'rgba(120,140,180,0.25)',
      });
    }
  }

  // Spread clusters apart so hot spots separate spatially.
  if (graph.order > 1) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, { iterations: 320, settings: { ...settings, gravity: 1, scalingRatio: 12 } });
  }

  document.getElementById('stats').textContent =
    `${data.nodes.length} ideas · ${data.edges.length} links · ${data.clusters.length} clusters`;

  // Hot spots are computed in the background (debounced after captures, plus a
  // 6h cron). If links exist but clusters/heat haven't landed yet, nudge a refresh.
  const notice = document.getElementById('notice');
  const heatReady = data.nodes.some(n => n.heat > 0);
  if (data.nodes.length > 1 && data.edges.length > 0 && (data.clusters.length === 0 || !heatReady)) {
    notice.textContent = 'Hot spots are still computing — click ↻ Recompute to generate them now.';
    notice.classList.remove('hidden');
  } else {
    notice.classList.add('hidden');
  }

  buildLegend(data.clusters);

  const renderer = new Sigma(graph, document.getElementById('graph'), {
    minCameraRatio: 0.05,
    maxCameraRatio: 12,
    labelRenderedSizeThreshold: 8,
    labelColor: { color: '#cdd4e0' },
  });

  setupInteractions(renderer, graph);
  setupSearch(graph, renderer);
}

// Build an element from a tag + class + plain text. Using textContent (never
// innerHTML) for any DB-derived value is what keeps captured ideas/labels — which
// originate from arbitrary inbound messages — from executing as HTML in the viewer.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildLegend(clusters) {
  const container = document.getElementById('legend');
  container.replaceChildren();
  const top = [...clusters].filter(c => c.size > 1).sort((a, b) => b.heat - a.heat).slice(0, 12);
  for (const c of top) {
    const item = el('div', 'legend-item');
    const dot = el('span', 'legend-dot');
    dot.style.background = clusterColor(c.id);
    item.append(
      dot,
      el('span', 'legend-label', c.label || 'cluster ' + c.id),
      el('span', 'legend-heat', `${c.size}·${c.heat.toFixed(2)}`),
    );
    item.title = c.summary || '';
    container.appendChild(item);
  }
  if (!top.length) container.appendChild(el('div', 'hint', 'No clusters yet — add more ideas.'));
}

function setupInteractions(renderer, graph) {
  const tooltip = document.getElementById('tooltip');
  renderer.on('enterNode', ({ node }) => {
    const a = graph.getNodeAttributes(node);
    const meta = (a.clusterName ? `🔥 ${a.clusterName} · ` : '')
      + `${a.degree} links · heat ${(a.heat || 0).toFixed(2)}`
      + (a.sourceType && a.sourceType !== 'text' ? ` · ${a.sourceType}` : '');
    tooltip.replaceChildren(
      el('div', null, a.content || a.label),   // textContent — never innerHTML
      el('div', 'meta', meta),
    );
    tooltip.classList.remove('hidden');
  });
  renderer.on('moveBody', () => {});
  renderer.getMouseCaptor().on('mousemovebody', (e) => {
    tooltip.style.left = (e.x + 16) + 'px';
    tooltip.style.top = (e.y + 16) + 'px';
  });
  renderer.on('leaveNode', () => tooltip.classList.add('hidden'));
}

function setupSearch(graph, renderer) {
  const input = document.getElementById('search');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    graph.forEachNode((node, attr) => {
      const match = !q || (attr.content || '').toLowerCase().includes(q);
      graph.setNodeAttribute(node, 'color', match ? clusterColor(attr.cluster) : 'rgba(80,90,110,0.15)');
    });
    renderer.refresh();
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
    } catch (e) {
      btn.textContent = 'Failed — retry';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = original; }, 2500);
    }
  });
}

setupRecompute();
load();

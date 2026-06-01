/* Thoughts viewer — loads the graph JSON and renders it with Sigma (WebGL).
   Nodes are sized by heat and colored by cluster, so dense recurring themes
   show up as big, brightly-colored hot spots. */

const Graph = graphology.Graph || graphology;
const forceAtlas2 = graphologyLibrary.layoutForceAtlas2;

const token = new URLSearchParams(location.search).get('token') || '';

function clusterColor(clusterId) {
  if (clusterId === null || clusterId === undefined) return '#5d6675';
  // Golden-angle hashing -> well-spread, stable hues per cluster.
  const hue = (clusterId * 137.508) % 360;
  return `hsl(${hue}, 70%, 58%)`;
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

function buildLegend(clusters) {
  const el = document.getElementById('legend');
  el.innerHTML = '';
  const top = [...clusters].filter(c => c.size > 1).sort((a, b) => b.heat - a.heat).slice(0, 12);
  for (const c of top) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <span class="legend-dot" style="background:${clusterColor(c.id)}"></span>
      <span class="legend-label">${c.label || 'cluster ' + c.id}</span>
      <span class="legend-heat">${c.size}·${c.heat.toFixed(2)}</span>`;
    item.title = c.summary || '';
    el.appendChild(item);
  }
  if (!top.length) el.innerHTML = '<div class="hint">No clusters yet — add more ideas.</div>';
}

function setupInteractions(renderer, graph) {
  const tooltip = document.getElementById('tooltip');
  renderer.on('enterNode', ({ node }) => {
    const a = graph.getNodeAttributes(node);
    tooltip.innerHTML = `<div>${a.content || a.label}</div>
      <div class="meta">${a.clusterName ? '🔥 ' + a.clusterName + ' · ' : ''}${a.degree} links · heat ${(a.heat || 0).toFixed(2)}${a.sourceType && a.sourceType !== 'text' ? ' · ' + a.sourceType : ''}</div>`;
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

load();

/* ThoughtsViz — pure visual-mapping functions for the graph viewer.
   Classic script (no modules) so it works both as a <script> tag and via
   side-effect import from node:test. All functions are pure; colors returned as
   hex for nodes (Sigma's WebGL node parser accepts only hex) and rgba strings
   for edges (accepted there). */
(function () {
  'use strict';

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  // Golden-angle hashing -> well-spread, stable hues per cluster.
  function clusterColor(clusterId) {
    if (clusterId === null || clusterId === undefined) return '#5d6675';
    return hslToHex((clusterId * 137.508) % 360, 70, 58);
  }

  function nodeSize(heat, degree) {
    return Math.min(28, 3 + (degree || 0) * 0.4 + (heat || 0) * 18);
  }

  /** Blend two hex colors; t=0 -> a, t=1 -> b. Returns hex. */
  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = (sh) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
    return '#' + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, '0')).join('');
  }

  /** Hot nodes glow brighter: blend the cluster color toward white by heat. */
  function heatColor(baseHex, heat) {
    return mixHex(baseHex, '#ffffff', clamp01(heat) * 0.18);
  }

  // --- Edge QoS encoding: connection strength -> width + brightness ----------
  // Three kinds keep their hue identity (similarity blue, typed relation green,
  // entity mention amber); weight drives width and alpha; weight >= 0.8 steps to
  // a brighter rgb tier so the strongest links visibly "light up".

  const EDGE_RGB = {
    similarity: { base: [120, 140, 180], strong: [150, 195, 255] },
    relation: { base: [130, 200, 150], strong: [160, 235, 175] },
    mention: { base: [210, 180, 120], strong: [230, 195, 130] },
  };
  const STRONG_W = 0.8;

  function edgeWidth(kind, weight) {
    const w = clamp01(weight || 0);
    if (kind === 'relation') return 0.8 + 3.2 * w;
    if (kind === 'mention') return 0.7;
    return 0.4 + 3.1 * Math.pow(w, 1.5); // similarity
  }

  function edgeColor(kind, weight, emphasized) {
    const w = clamp01(weight || 0);
    const spec = EDGE_RGB[kind] || EDGE_RGB.similarity;
    const rgb = w >= STRONG_W ? spec.strong : spec.base;
    let alpha;
    if (kind === 'relation') alpha = 0.30 + 0.55 * w;
    else if (kind === 'mention') alpha = 0.30;
    else alpha = 0.10 + 0.55 * Math.pow(w, 1.5);
    if (emphasized) alpha = Math.min(0.95, alpha + 0.35);
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
  }

  /** "2h ago" / "3d ago" for status rows. Returns '—' for falsy input. */
  function relativeTime(iso) {
    if (!iso) return '—';
    const t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (isNaN(t)) return '—';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  globalThis.ThoughtsViz = {
    clamp01, hslToHex, clusterColor, nodeSize, mixHex, heatColor,
    edgeWidth, edgeColor, relativeTime, STRONG_W,
  };
})();

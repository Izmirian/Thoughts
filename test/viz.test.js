/** Tests for the pure visual-mapping functions in public/viz.js. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let V;
before(async () => {
  await import('../public/viz.js'); // side-effect: assigns globalThis.ThoughtsViz
  V = globalThis.ThoughtsViz;
});

test('edgeWidth is monotonic in weight and bounded', () => {
  for (const kind of ['similarity', 'relation']) {
    let prev = -1;
    for (let w = 0; w <= 1.001; w += 0.1) {
      const width = V.edgeWidth(kind, w);
      assert.ok(width >= prev, `${kind} width monotonic`);
      assert.ok(width > 0 && width <= 4.2, `${kind} width bounded, got ${width}`);
      prev = width;
    }
  }
  assert.equal(V.edgeWidth('mention', 0.9), 0.7, 'mention width fixed');
});

test('edgeColor returns valid rgba with alpha ramping by weight', () => {
  const re = /^rgba\(\d+,\d+,\d+,(0(\.\d+)?|1(\.0+)?)\)$/;
  const alphaOf = (c) => parseFloat(c.match(re)[1]);
  for (const kind of ['similarity', 'relation', 'mention']) {
    const c = V.edgeColor(kind, 0.5, false);
    assert.match(c, re, `${kind} valid rgba`);
  }
  assert.ok(alphaOf(V.edgeColor('similarity', 0.9, false)) > alphaOf(V.edgeColor('similarity', 0.3, false)),
    'similarity alpha increases with weight');
  assert.ok(alphaOf(V.edgeColor('relation', 1, false)) <= 0.95);
});

test('strong tier (w >= 0.8) uses the brighter rgb step', () => {
  const rgbOf = (c) => c.match(/^rgba\((\d+),(\d+),(\d+),/).slice(1, 4).map(Number);
  const weak = rgbOf(V.edgeColor('similarity', 0.7, false));
  const strong = rgbOf(V.edgeColor('similarity', 0.85, false));
  assert.notDeepEqual(weak, strong, 'rgb steps up at the strong threshold');
  assert.ok(strong[2] > weak[2], 'strong similarity is brighter (more blue)');
});

test('emphasis raises alpha, capped at 0.95', () => {
  const alphaOf = (c) => parseFloat(c.match(/,([\d.]+)\)$/)[1]);
  assert.ok(alphaOf(V.edgeColor('relation', 0.5, true)) > alphaOf(V.edgeColor('relation', 0.5, false)));
  assert.ok(alphaOf(V.edgeColor('relation', 1, true)) <= 0.95);
});

test('mixHex / heatColor / clusterColor return 7-char hex', () => {
  const hex = /^#[0-9a-f]{6}$/;
  assert.match(V.mixHex('#000000', '#ffffff', 0.5), hex);
  assert.equal(V.mixHex('#102030', '#102030', 0.7), '#102030', 'identity blend');
  assert.match(V.heatColor('#3388ff', 0.9), hex);
  assert.match(V.clusterColor(4), hex);
  assert.equal(V.clusterColor(null), '#5d6675');
  // heat brightens: each channel >= base
  const base = '#3388ff', hot = V.heatColor(base, 1);
  for (const sh of [1, 3, 5]) {
    assert.ok(parseInt(hot.slice(sh, sh + 2), 16) >= parseInt(base.slice(sh, sh + 2), 16));
  }
});

test('relativeTime formats ages and tolerates junk', () => {
  assert.equal(V.relativeTime(null), '—');
  assert.equal(V.relativeTime('not-a-date'), '—');
  assert.equal(V.relativeTime(Date.now() - 5000), 'just now');
  assert.match(V.relativeTime(Date.now() - 3 * 60000), /^3m ago$/);
  assert.match(V.relativeTime(Date.now() - 2 * 3600000), /^2h ago$/);
  assert.match(V.relativeTime(Date.now() - 3 * 86400000), /^3d ago$/);
});

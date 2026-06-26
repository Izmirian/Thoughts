import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, clamp01, recencyBoost, edgeWeight } from '../src/graph.js';

test('canonical orders an undirected pair consistently', () => {
  assert.deepEqual(canonical(2, 5), [2, 5]);
  assert.deepEqual(canonical(5, 2), [2, 5]);
  assert.deepEqual(canonical(7, 7), [7, 7]);
});

test('clamp01 bounds to [0,1]', () => {
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(0.4), 0.4);
});

test('recencyBoost is >1 and decays with age', () => {
  assert.ok(recencyBoost(0) > recencyBoost(30));
  assert.ok(recencyBoost(30) > recencyBoost(365));
  assert.ok(recencyBoost(100000) >= 1); // never below 1
});

test('edgeWeight increases with similarity', () => {
  assert.ok(edgeWeight(0.9, 0, 0) > edgeWeight(0.6, 0, 0));
});

test('edgeWeight increases (never decreases) with reinforcement', () => {
  const base = edgeWeight(0.7, 0, 0);
  const reinforced = edgeWeight(0.7, 5, 0);
  assert.ok(reinforced >= base);
});

test('edgeWeight is capped at 1', () => {
  assert.ok(edgeWeight(0.99, 100, 0) <= 1);
});

test('fresh edges weigh more than stale ones (recency)', () => {
  assert.ok(edgeWeight(0.7, 2, 0) > edgeWeight(0.7, 2, 365));
});

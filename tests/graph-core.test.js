'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/graph-core');

function clique(prefix, count, weight = 2) {
  const edges = [];
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      edges.push([`${prefix}${i}`, `${prefix}${j}`, weight]);
    }
  }
  return edges;
}

test('detects strongly connected communities separated by weak bridges', () => {
  const edges = [
    ...clique('a', 5),
    ...clique('b', 5),
    ...clique('c', 5),
    ['a0', 'b0', 0.2],
    ['b0', 'c0', 0.2],
  ];
  const graph = core.buildWeightedGraph(edges);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 6,
    minCommunitySize: 2,
    resolution: 1,
  });

  assert.equal(analysis.clusters.length, 3);
  assert.equal(analysis.assignments.get('a1'), analysis.assignments.get('a4'));
  assert.equal(analysis.assignments.get('b1'), analysis.assignments.get('b4'));
  assert.equal(analysis.assignments.get('c1'), analysis.assignments.get('c4'));
  assert.notEqual(analysis.assignments.get('a1'), analysis.assignments.get('b1'));
  assert.notEqual(analysis.assignments.get('b1'), analysis.assignments.get('c1'));
});

test('chooses high-degree nodes as community hubs', () => {
  const graph = core.buildWeightedGraph([
    ['hub', 'a', 4],
    ['hub', 'b', 4],
    ['hub', 'c', 4],
    ['a', 'b', 1],
    ['b', 'c', 1],
  ]);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 2,
    minCommunitySize: 1,
  });
  assert.equal(analysis.clusters[0].hub, 'hub');
});

test('keeps related nodes closer in color than separate community hubs', () => {
  const graph = core.buildWeightedGraph([
    ...clique('left', 5),
    ...clique('right', 5),
    ['left0', 'right0', 0.1],
  ]);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 4,
    minCommunitySize: 2,
    propagationSteps: 4,
    propagationStrength: 0.55,
  });
  const within = core.colorDistance(
    analysis.colors.get('left1'),
    analysis.colors.get('left2')
  );
  const across = core.colorDistance(
    analysis.colors.get('left1'),
    analysis.colors.get('right1')
  );
  assert.ok(within < across, `within=${within}, across=${across}`);
});

test('blends a boundary node between neighboring communities', () => {
  const graph = core.buildWeightedGraph([
    ...clique('red', 5),
    ...clique('blue', 5),
    ['bridge', 'red0', 2],
    ['bridge', 'blue0', 2],
  ]);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 4,
    minCommunitySize: 2,
    propagationSteps: 6,
    propagationStrength: 0.7,
  });
  const vector = analysis.affinities.get('bridge');
  const nonZero = vector.filter((value) => value > 0.05);
  assert.ok(nonZero.length >= 2, `expected mixed affinity, received ${vector}`);
});

test('is deterministic for the same graph and settings', () => {
  const graph = core.buildWeightedGraph([
    ...clique('x', 4),
    ...clique('y', 4),
    ['x0', 'y0', 0.5],
  ]);
  const first = core.analyzeGraph(graph, { maxCommunities: 5 });
  const second = core.analyzeGraph(graph, { maxCommunities: 5 });
  assert.deepEqual([...first.assignments.entries()], [...second.assignments.entries()]);
  assert.deepEqual([...first.colors.entries()], [...second.colors.entries()]);
});

test('builds an undirected weighted graph from Obsidian resolved links', () => {
  const graph = core.graphFromResolvedLinks({
    'A.md': { 'B.md': 2 },
    'B.md': { 'A.md': 1, 'C.md': 1 },
  }, ['D.md']);
  assert.equal(graph.get('A.md').get('B.md'), 3);
  assert.equal(graph.get('B.md').get('A.md'), 3);
  assert.equal(graph.get('B.md').get('C.md'), 1);
  assert.ok(graph.has('D.md'));
});

test('honors zero blending distance instead of replacing it with the default', () => {
  const graph = core.buildWeightedGraph([['left', 'right', 1]]);
  const assignments = new Map([['left', 0], ['right', 1]]);
  const hubs = new Map([[0, 'left'], [1, 'right']]);
  const affinities = core.propagateAffinities(graph, assignments, hubs, 2, {
    propagationSteps: 0,
    propagationStrength: 0.9,
  });
  assert.deepEqual(affinities.get('left'), [1, 0]);
  assert.deepEqual(affinities.get('right'), [0, 1]);
});

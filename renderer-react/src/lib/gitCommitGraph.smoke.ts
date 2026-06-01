import { buildCommitGraph, GRAPH_COL_WIDTH, GRAPH_PADDING_X } from './gitCommitGraph.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeCommit(hash: string, parents: string[]) {
  return { hash, parents };
}

function laneX(lane: number) {
  return GRAPH_PADDING_X + lane * GRAPH_COL_WIDTH;
}

// Main: A <- B, branch: A <- C, merge: M = merge(B, C)
const commits = [
  makeCommit('merge-hash', ['main-tip-hash', 'branch-tip-hash']),
  makeCommit('main-tip-hash', ['root-hash']),
  makeCommit('branch-tip-hash', ['root-hash']),
  makeCommit('root-hash', []),
];

const layout = buildCommitGraph(commits);

assert(layout.nodes.length === 4, 'expected four graph nodes');
assert(layout.nodes[0]!.lane === 0, 'merge commit should render on lane 0');
assert(layout.nodes[1]!.lane === 0, 'main-line commit should render on lane 0');
assert(layout.nodes[2]!.lane === 1, 'branch commit should render on lane 1');
assert(layout.nodes[2]!.x === laneX(1), 'branch commit x position should match lane 1');
assert(layout.nodes[0]!.x !== layout.nodes[2]!.x, 'merge and branch commits should not share lane x');

const repeatedMergeHistory = [
  makeCommit('merge-2', ['merge-1-hash', 'branch-2-hash']),
  makeCommit('merge-1-hash', ['main-1-hash', 'branch-1-hash']),
  makeCommit('main-1-hash', ['root-hash']),
  makeCommit('branch-1-hash', ['root-hash']),
  makeCommit('branch-2-hash', ['root-hash']),
  makeCommit('root-hash', []),
];

const repeatedLayout = buildCommitGraph(repeatedMergeHistory);
const branchLanes = new Set(
  repeatedLayout.nodes
    .filter((_, index) => index === 2 || index === 4)
    .map((node) => node.lane),
);

assert(branchLanes.size > 1 || [...branchLanes][0] !== 0, 'branch-only commits should not all collapse to lane 0');

console.log('gitCommitGraph smoke test passed');

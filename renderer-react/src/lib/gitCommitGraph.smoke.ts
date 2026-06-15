import { buildCommitGraph, GRAPH_COL_WIDTH, GRAPH_PADDING_X } from './gitCommitGraph.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeCommit(hash: string, parents: string[], branch = 'refs/heads/main', refs = '') {
  return { hash, parents, branch, refs };
}

function laneX(lane: number) {
  return GRAPH_PADDING_X + lane * GRAPH_COL_WIDTH;
}

function edgeFrom(layout: ReturnType<typeof buildCommitGraph>, startRow: number, startLane: number, endLane: number) {
  return layout.edges.find((edge) => edge.startRow === startRow && edge.startLane === startLane && edge.endLane === endLane);
}

function hasPassThrough(layout: ReturnType<typeof buildCommitGraph>, row: number, lane: number) {
  return Boolean(edgeFrom(layout, row, lane, lane));
}

function assertOneNodePerCommit(layout: ReturnType<typeof buildCommitGraph>, commits: ReturnType<typeof makeCommit>[], label: string) {
  assert(layout.nodes.length === commits.length, `${label}: expected exactly one node per commit`);
}

// Main: R <- A, feature: R <- B, merge: M = merge(A, B)
const simpleMerge = [
  makeCommit('merge-hash', ['main-tip-hash', 'branch-tip-hash'], 'refs/heads/main', 'HEAD -> main'),
  makeCommit('main-tip-hash', ['root-hash'], 'refs/heads/main'),
  makeCommit('branch-tip-hash', ['root-hash'], 'refs/heads/feature', 'feature'),
  makeCommit('root-hash', []),
];

const simpleLayout = buildCommitGraph(simpleMerge);
assertOneNodePerCommit(simpleLayout, simpleMerge, 'simple merge');
assert(simpleLayout.nodes[0]!.lane === 0, 'merge commit should render on the target lane');
assert(simpleLayout.nodes[1]!.lane === 0, 'first parent should continue on the target lane');
assert(simpleLayout.nodes[2]!.lane === 1, 'merged branch commit should render on its active parent lane');
assert(simpleLayout.nodes[2]!.x === laneX(1), 'merged branch commit x position should match lane 1');
assert(Boolean(edgeFrom(simpleLayout, 0, 0, 1)), 'merge commit should connect to the merged branch lane');
assert(hasPassThrough(simpleLayout, 1, 1), 'merged branch lane should stay alive until its commit row');
assert(Boolean(edgeFrom(simpleLayout, 2, 1, 0)), 'merged branch should connect back to the shared ancestor lane');

const delayedBranch = [
  makeCommit('merge-hash', ['main-3', 'branch-tip'], 'refs/heads/main'),
  makeCommit('main-3', ['main-2'], 'refs/heads/main'),
  makeCommit('main-2', ['main-1'], 'refs/heads/main'),
  makeCommit('main-1', ['root-hash'], 'refs/heads/main'),
  makeCommit('branch-tip', ['root-hash'], 'refs/heads/feature'),
  makeCommit('root-hash', []),
];

const delayedLayout = buildCommitGraph(delayedBranch);
assertOneNodePerCommit(delayedLayout, delayedBranch, 'delayed branch');
assert(delayedLayout.nodes[4]!.lane === 1, 'delayed branch commit should keep its merge-parent lane');
[1, 2, 3].forEach((row) => {
  assert(hasPassThrough(delayedLayout, row, 1), `delayed branch lane should pass through row ${row}`);
});

const repeatedMergeHistory = [
  makeCommit('merge-2', ['merge-1', 'branch-2'], 'refs/heads/main'),
  makeCommit('merge-1', ['main-1', 'branch-1'], 'refs/heads/main'),
  makeCommit('main-1', ['root-hash'], 'refs/heads/main'),
  makeCommit('branch-1', ['root-hash'], 'refs/heads/feature'),
  makeCommit('branch-2', ['root-hash'], 'refs/heads/feature'),
  makeCommit('root-hash', []),
];

const repeatedLayout = buildCommitGraph(repeatedMergeHistory);
assertOneNodePerCommit(repeatedLayout, repeatedMergeHistory, 'repeated merge');
assert(repeatedLayout.nodes[0]!.lane === 0, 'newest repeated merge should stay on main lane');
assert(repeatedLayout.nodes[1]!.lane === 0, 'older repeated merge should stay on main lane');
assert(repeatedLayout.nodes[3]!.lane !== 0, 'first branch merge parent should not collapse onto main');
assert(repeatedLayout.nodes[4]!.lane !== 0, 'second branch merge parent should not collapse onto main');

const nestedMergeHistory = [
  makeCommit('tip', ['outer-merge'], 'refs/heads/main'),
  makeCommit('outer-merge', ['main-work', 'inner-merge'], 'refs/heads/main'),
  makeCommit('main-work', ['root-hash'], 'refs/heads/main'),
  makeCommit('inner-merge', ['feature-a', 'feature-b'], 'refs/heads/development'),
  makeCommit('feature-a', ['root-hash'], 'refs/heads/development'),
  makeCommit('feature-b', ['root-hash'], 'refs/heads/topic'),
  makeCommit('root-hash', []),
];

const nestedLayout = buildCommitGraph(nestedMergeHistory);
assertOneNodePerCommit(nestedLayout, nestedMergeHistory, 'nested merge');
assert(nestedLayout.nodes[1]!.lane === 0, 'outer merge should stay on the target lane');
assert(nestedLayout.nodes[3]!.lane === 1, 'nested merge should render on its carried branch lane');
assert(nestedLayout.nodes[5]!.lane === 2, 'nested second parent should render on its own active lane');
assert(Boolean(edgeFrom(nestedLayout, 1, 0, 1)), 'outer merge should connect to nested merge lane');
assert(Boolean(edgeFrom(nestedLayout, 3, 1, 2)), 'nested merge should connect to its second parent lane');

const truncatedHistory = [
  makeCommit('visible-tip', ['outside-visible-parent'], 'refs/heads/main'),
];

const truncatedLayout = buildCommitGraph(truncatedHistory);
assertOneNodePerCommit(truncatedLayout, truncatedHistory, 'truncated history');
assert(truncatedLayout.nodes[0]!.lane === 0, 'visible tip should render on lane 0');
assert(Boolean(edgeFrom(truncatedLayout, 0, 0, 0)), 'outside visible parent should draw a continuation edge');

const repoShapedHistory = [
  makeCommit('d02e43e', ['159e3fb'], 'refs/heads/main', 'HEAD -> main, origin/main, origin/HEAD'),
  makeCommit('159e3fb', ['b477eed'], 'refs/heads/main'),
  makeCommit('b477eed', ['15bb7e1'], 'refs/heads/main'),
  makeCommit('15bb7e1', ['785db64'], 'refs/heads/main'),
  makeCommit('785db64', ['ffe7b39'], 'refs/heads/main'),
  makeCommit('ffe7b39', ['e703302'], 'refs/heads/main'),
  makeCommit('e703302', ['2f6c2ba'], 'refs/heads/main'),
  makeCommit('2f6c2ba', ['4d09daa'], 'refs/heads/main'),
  makeCommit('4d09daa', ['2f9be4a'], 'refs/heads/main'),
  makeCommit('2f9be4a', ['ca99d33'], 'refs/heads/main'),
  makeCommit('ca99d33', ['5d21ee2'], 'refs/heads/main'),
  makeCommit('5d21ee2', ['0379836'], 'refs/heads/main'),
  makeCommit('0379836', ['60982ea'], 'refs/heads/main'),
  makeCommit('60982ea', ['a9b1641'], 'refs/heads/main'),
  makeCommit('a9b1641', ['7a589fa'], 'refs/heads/main'),
  makeCommit('7a589fa', ['311d46d'], 'refs/heads/open-code', 'origin/open-code, open-code'),
  makeCommit('311d46d', ['0af3155'], 'refs/heads/open-code'),
  makeCommit('0af3155', ['12215ff'], 'refs/heads/open-code'),
  makeCommit('12215ff', ['d480fcb'], 'refs/heads/open-code'),
  makeCommit('d480fcb', ['5234ff6'], 'refs/heads/open-code'),
  makeCommit('5234ff6', ['953000f'], 'refs/heads/open-code'),
  makeCommit('953000f', ['69ccfa1'], 'refs/heads/open-code'),
  makeCommit('69ccfa1', ['53db39e'], 'refs/heads/open-code'),
  makeCommit('53db39e', ['1ac64fc'], 'refs/heads/open-code'),
  makeCommit('1ac64fc', ['08074fd'], 'refs/heads/open-code'),
  makeCommit('08074fd', ['8f1f5c1'], 'refs/heads/open-code'),
  makeCommit('8f1f5c1', ['130045e', 'e1118c6'], 'refs/heads/open-code'),
  makeCommit('b2b1eba', ['e1118c6'], 'refs/remotes/origin/update', 'origin/update'),
  makeCommit('e1118c6', ['130045e'], 'refs/remotes/origin/update'),
  makeCommit('130045e', ['414f41e'], 'refs/heads/open-code'),
  makeCommit('414f41e', [], 'refs/heads/open-code'),
];

const repoLayout = buildCommitGraph(repoShapedHistory);
assertOneNodePerCommit(repoLayout, repoShapedHistory, 'repo-shaped history');
assert(repoLayout.nodes[0]!.lane === 0, 'main tip should start on lane 0');
assert(repoLayout.nodes[15]!.lane === 0, 'open-code should share lane 0 where topology is linear first-parent history');
assert(repoLayout.nodes[26]!.lane === 0, 'open-code merge commit should stay on its target lane');
assert(repoLayout.nodes[27]!.lane === 2, 'origin/update tip should render as an independent side tip lane');
assert(repoLayout.nodes[28]!.lane === 1, 'origin/update merge parent should render on the carried merge-parent lane');
assert(Boolean(edgeFrom(repoLayout, 26, 0, 1)), 'open-code merge should connect to the origin/update parent lane');
assert(Boolean(edgeFrom(repoLayout, 27, 2, 1)), 'origin/update tip should connect back to its parent lane');
assert(Boolean(edgeFrom(repoLayout, 28, 1, 0)), 'origin/update parent should connect back to the shared open-code lane');

console.log('gitCommitGraph smoke test passed');

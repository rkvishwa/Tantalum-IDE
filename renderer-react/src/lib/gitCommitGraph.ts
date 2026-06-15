import type { GitCommit } from '@/types/electron';

export const GRAPH_COLORS = [
  'var(--git-tree-main-branch-color)',
  '#3fb950',
  '#e3b341',
  '#f85149',
  '#bc8cff',
  '#db6d28',
];

export const GRAPH_ROW_HEIGHT = 26;
export const GRAPH_COL_WIDTH = 10;
export const GRAPH_PADDING_X = 16;
export const GRAPH_NODE_RADIUS = 4.5;
export const GRAPH_TEXT_GAP = 4;
export const GRAPH_MAX_WIDTH = 104;

type GraphLane = {
  hash: string;
  color: string;
  sourceKey: string | null;
};

type GraphCommitInput = Pick<GitCommit, 'hash' | 'parents'> & Partial<Pick<GitCommit, 'branch' | 'refs'>>;

export type GraphEdge = {
  key: string;
  startLane: number;
  startRow: number;
  endLane: number;
  endRow: number;
  color: string;
};

export type GraphNode = {
  x: number;
  y: number;
  color: string;
  lane: number;
};

export type CommitGraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  rowTextStarts: number[];
  rowHeight: number;
};

function normalizeHash(hash: string) {
  return hash.trim().toLowerCase();
}

function normalizeSourceRef(ref: string | null | undefined) {
  let normalized = String(ref ?? '').trim().replace(/^HEAD ->\s*/, '');
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('tag: ')) {
    return null;
  }

  normalized = normalized.replace(/^refs\/heads\//, '');

  const fullRemoteMatch = normalized.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (fullRemoteMatch) {
    normalized = fullRemoteMatch[2] ?? '';
  } else {
    const shortRemoteMatch = normalized.match(/^(?:remotes\/)?(?:origin|upstream)\/(.+)$/);
    if (shortRemoteMatch) {
      normalized = shortRemoteMatch[1] ?? '';
    }
  }

  if (!normalized || normalized === 'HEAD' || normalized.endsWith('/HEAD')) {
    return null;
  }

  return normalized.toLowerCase();
}

function getFirstBranchRefSourceKey(refs: string | null | undefined) {
  return String(refs ?? '')
    .split(',')
    .map((ref) => normalizeSourceRef(ref))
    .find((ref): ref is string => Boolean(ref)) ?? null;
}

function getCommitSourceKey(commit: GraphCommitInput) {
  return normalizeSourceRef(commit.branch) ?? getFirstBranchRefSourceKey(commit.refs);
}

function getLaneColor(lane: number) {
  return GRAPH_COLORS[lane % GRAPH_COLORS.length] ?? GRAPH_COLORS[0];
}

function findLaneByHash(lanes: Array<GraphLane | null>, hash: string) {
  const normalized = normalizeHash(hash);
  return lanes.findIndex((entry) => entry?.hash === normalized);
}

function findFreeLane(lanes: Array<GraphLane | null>, startLane = 0) {
  for (let index = Math.max(0, startLane); index < lanes.length; index += 1) {
    if (lanes[index] === null) {
      return index;
    }
  }

  return lanes.length;
}

function ensureLaneCapacity(lanes: Array<GraphLane | null>, lane: number) {
  while (lanes.length <= lane) {
    lanes.push(null);
  }
}

function clearHashFromOtherLanes(lanes: Array<GraphLane | null>, hash: string, keepLane: number) {
  const normalized = normalizeHash(hash);

  lanes.forEach((entry, laneIndex) => {
    if (laneIndex !== keepLane && entry?.hash === normalized) {
      lanes[laneIndex] = null;
    }
  });
}

function buildRowTextStarts(nodes: GraphNode[], edges: GraphEdge[]) {
  return nodes.map((node, row) => {
    const nodeLane = Math.max(0, Math.round((node.x - GRAPH_PADDING_X) / GRAPH_COL_WIDTH));
    const rowMaxLane = edges.reduce((maxLane, edge) => {
      if (edge.startRow !== row && edge.endRow !== row) {
        return maxLane;
      }

      return Math.max(maxLane, edge.startLane, edge.endLane);
    }, nodeLane);

    return GRAPH_PADDING_X + rowMaxLane * GRAPH_COL_WIDTH + GRAPH_NODE_RADIUS + GRAPH_TEXT_GAP;
  });
}

export function buildCommitGraph(commits: GraphCommitInput[]): CommitGraphLayout {
  let lanes: Array<GraphLane | null> = [];
  const sourceLanes = new Map<string, number>();
  const sourceKeysByHash = new Map<string, string | null>();
  const rowsByHash = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const nodes: GraphNode[] = [];
  let maxLaneCount = 1;

  const noteLane = (lane: number) => {
    maxLaneCount = Math.max(maxLaneCount, lane + 1);
  };

  const rememberSourceLane = (sourceKey: string | null, lane: number) => {
    if (!sourceKey || sourceLanes.has(sourceKey)) {
      return;
    }

    sourceLanes.set(sourceKey, lane);
  };

  const getReusableSourceLane = (sourceKey: string | null, activeLanes: Array<GraphLane | null>, minimumLane = 0) => {
    if (!sourceKey) {
      return -1;
    }

    const lane = sourceLanes.get(sourceKey);
    if (lane === undefined || lane < minimumLane || (lane < activeLanes.length && activeLanes[lane] !== null)) {
      return -1;
    }

    return lane;
  };

  const chooseCommitLane = (activeLanes: Array<GraphLane | null>, sourceKey: string | null) => {
    const sourceLane = getReusableSourceLane(sourceKey, activeLanes);
    return sourceLane === -1 ? findFreeLane(activeLanes) : sourceLane;
  };

  const chooseMergeParentLane = (activeLanes: Array<GraphLane | null>, startLane: number, sourceKey: string | null) => {
    const rightSourceLane = getReusableSourceLane(sourceKey, activeLanes, startLane);
    if (rightSourceLane !== -1) {
      return rightSourceLane;
    }

    const rightLane = findFreeLane(activeLanes, startLane);
    if (rightLane < activeLanes.length || !sourceKey) {
      return rightLane;
    }

    const anySourceLane = getReusableSourceLane(sourceKey, activeLanes);
    return anySourceLane === -1 ? rightLane : anySourceLane;
  };

  const setActiveLane = (
    activeLanes: Array<GraphLane | null>,
    lane: number,
    hash: string,
    color: string,
    sourceKey: string | null,
  ) => {
    const normalized = normalizeHash(hash);
    ensureLaneCapacity(activeLanes, lane);
    activeLanes[lane] = { hash: normalized, color, sourceKey };
    rememberSourceLane(sourceKey, lane);
    clearHashFromOtherLanes(activeLanes, normalized, lane);
    noteLane(lane);
    return lane;
  };

  const pushEdge = (edge: GraphEdge) => {
    edges.push(edge);
    noteLane(edge.startLane);
    noteLane(edge.endLane);
  };

  commits.forEach((commit, row) => {
    const commitHash = normalizeHash(commit.hash);
    sourceKeysByHash.set(commitHash, getCommitSourceKey(commit));
    rowsByHash.set(commitHash, row);
  });

  commits.forEach((commit, row) => {
    const commitHash = normalizeHash(commit.hash);
    const commitSourceKey = sourceKeysByHash.get(commitHash) ?? null;
    const previousLanes = lanes;
    const nextLanes: Array<GraphLane | null> = [...lanes];

    let lane = findLaneByHash(previousLanes, commitHash);
    if (lane === -1) {
      lane = row === 0 ? 0 : chooseCommitLane(previousLanes, commitSourceKey);
    }

    ensureLaneCapacity(nextLanes, lane);
    noteLane(lane);
    rememberSourceLane(commitSourceKey, lane);

    const currentColor = previousLanes[lane]?.hash === commitHash
      ? previousLanes[lane]!.color
      : getLaneColor(lane);

    nodes.push({
      x: GRAPH_PADDING_X + lane * GRAPH_COL_WIDTH,
      y: row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2,
      color: currentColor,
      lane,
    });

    nextLanes[lane] = null;
    clearHashFromOtherLanes(nextLanes, commitHash, lane);

    commit.parents.forEach((parentHash, parentIndex) => {
      const normalizedParent = normalizeHash(parentHash);
      const parentRow = rowsByHash.get(normalizedParent);
      const parentSourceKey = sourceKeysByHash.get(normalizedParent) ?? null;
      const existingParentLane = findLaneByHash(nextLanes, normalizedParent);
      const existingParentColor = existingParentLane === -1 ? null : nextLanes[existingParentLane]?.color ?? null;

      let targetLane = existingParentLane;
      if (targetLane === -1) {
        targetLane = parentIndex === 0
          ? lane
          : chooseMergeParentLane(nextLanes, lane + 1, parentSourceKey);
      }

      const parentColor = parentIndex === 0
        ? currentColor
        : existingParentColor ?? getLaneColor(targetLane);

      if (existingParentLane === -1) {
        setActiveLane(nextLanes, targetLane, normalizedParent, parentColor, parentSourceKey);
      } else {
        rememberSourceLane(parentSourceKey, existingParentLane);
        noteLane(existingParentLane);
      }

      pushEdge({
        key: `edge-${commitHash}-${normalizedParent}-${row}-${parentIndex}-${parentRow ?? 'tail'}`,
        startLane: lane,
        startRow: row,
        endLane: targetLane,
        endRow: row + 1,
        color: parentIndex === 0
          ? currentColor
          : parentColor,
      });
    });

    previousLanes.forEach((entry, laneIndex) => {
      if (!entry || laneIndex === lane) {
        return;
      }

      const targetLane = findLaneByHash(nextLanes, entry.hash);
      if (targetLane !== -1) {
        pushEdge({
          key: `pass-${entry.hash}-${row}-${laneIndex}`,
          startLane: laneIndex,
          startRow: row,
          endLane: targetLane,
          endRow: row + 1,
          color: entry.color,
        });
      }
    });

    lanes = nextLanes;
  });

  const rowTextStarts = buildRowTextStarts(nodes, edges);

  return {
    nodes,
    edges,
    width: Math.max(GRAPH_PADDING_X * 2, GRAPH_PADDING_X * 2 + (maxLaneCount - 1) * GRAPH_COL_WIDTH),
    height: Math.max(GRAPH_ROW_HEIGHT, commits.length * GRAPH_ROW_HEIGHT),
    rowTextStarts,
    rowHeight: GRAPH_ROW_HEIGHT,
  };
}

export function buildOrthogonalEdgePath(startX: number, startY: number, endX: number, endY: number) {
  if (startX === endX) {
    return `M ${startX} ${startY} L ${endX} ${endY}`;
  }

  const bendY = (startY + endY) / 2;
  const laneDistance = Math.abs(endX - startX);
  const rowDistance = Math.max(Math.abs(endY - startY), 1);
  const radius = Math.min(laneDistance * 0.48, rowDistance * 0.42, GRAPH_ROW_HEIGHT * 0.38);
  const cornerRadius = Math.max(4, radius);

  if (endX > startX) {
    return [
      `M ${startX} ${startY}`,
      `L ${startX} ${bendY - cornerRadius}`,
      `Q ${startX} ${bendY} ${startX + cornerRadius} ${bendY}`,
      `L ${endX - cornerRadius} ${bendY}`,
      `Q ${endX} ${bendY} ${endX} ${bendY + cornerRadius}`,
      `L ${endX} ${endY}`,
    ].join(' ');
  }

  return [
    `M ${startX} ${startY}`,
    `L ${startX} ${bendY - cornerRadius}`,
    `Q ${startX} ${bendY} ${startX - cornerRadius} ${bendY}`,
    `L ${endX + cornerRadius} ${bendY}`,
    `Q ${endX} ${bendY} ${endX} ${bendY + cornerRadius}`,
    `L ${endX} ${endY}`,
  ].join(' ');
}

export function getGitTreeGraphWidth(width: number) {
  return Math.max(36, Math.min(width, GRAPH_MAX_WIDTH));
}

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
};

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

function findLaneByHash(lanes: Array<GraphLane | null>, hash: string) {
  const normalized = normalizeHash(hash);
  return lanes.findIndex((entry) => entry?.hash === normalized);
}

function ensureLaneCapacity(lanes: Array<GraphLane | null>, lane: number) {
  while (lanes.length <= lane) {
    lanes.push(null);
  }
}

function allocateRightmostLane(lanes: Array<GraphLane | null>) {
  for (let index = lanes.length - 1; index >= 0; index -= 1) {
    if (lanes[index] === null) {
      return index;
    }
  }

  return lanes.length;
}

function clearHashFromOtherLanes(lanes: Array<GraphLane | null>, hash: string, keepLane: number) {
  const normalized = normalizeHash(hash);

  lanes.forEach((entry, laneIndex) => {
    if (laneIndex !== keepLane && entry?.hash === normalized) {
      lanes[laneIndex] = null;
    }
  });
}

function reserveLane(
  lanes: Array<GraphLane | null>,
  preferredLane: number,
  hash: string,
  color: string,
) {
  const normalized = normalizeHash(hash);
  const existingLane = findLaneByHash(lanes, normalized);
  if (existingLane !== -1) {
    return existingLane;
  }

  ensureLaneCapacity(lanes, preferredLane);

  if (lanes[preferredLane] === null) {
    lanes[preferredLane] = { hash: normalized, color };
    return preferredLane;
  }

  if (lanes[preferredLane]?.hash === normalized) {
    return preferredLane;
  }

  const allocatedLane = allocateRightmostLane(lanes);
  ensureLaneCapacity(lanes, allocatedLane);
  lanes[allocatedLane] = { hash: normalized, color };
  return allocatedLane;
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

export function buildCommitGraph(commits: Pick<GitCommit, 'hash' | 'parents'>[]): CommitGraphLayout {
  let lanes: Array<GraphLane | null> = [];
  let colorIdx = 0;
  const getColor = () => GRAPH_COLORS[colorIdx++ % GRAPH_COLORS.length];
  const edges: GraphEdge[] = [];
  const nodes: GraphNode[] = [];
  let maxLaneCount = 1;

  commits.forEach((commit, row) => {
    const commitHash = normalizeHash(commit.hash);
    const previousLanes = lanes;
    const nextLanes: Array<GraphLane | null> = [...lanes];

    let lane = findLaneByHash(previousLanes, commitHash);
    if (lane === -1) {
      lane = row === 0 ? 0 : previousLanes.length;
    }

    ensureLaneCapacity(nextLanes, lane);

    const currentColor = previousLanes[lane]?.color ?? getColor();

    nodes.push({
      x: GRAPH_PADDING_X + lane * GRAPH_COL_WIDTH,
      y: row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2,
      color: currentColor,
      lane,
    });

    nextLanes[lane] = null;

    commit.parents.forEach((parentHash, parentIndex) => {
      const normalizedParent = normalizeHash(parentHash);

      if (parentIndex === 0) {
        const targetLane = lane;
        const parentColor = currentColor;
        reserveLane(nextLanes, targetLane, normalizedParent, parentColor);
        clearHashFromOtherLanes(nextLanes, normalizedParent, targetLane);

        edges.push({
          key: `edge-${commitHash}-${normalizedParent}-${row}`,
          startLane: lane,
          startRow: row,
          endLane: targetLane,
          endRow: row + 1,
          color: parentColor,
        });
        return;
      }

      let targetLane = findLaneByHash(nextLanes, normalizedParent);
      let parentColor = currentColor;

      if (targetLane === -1) {
        targetLane = allocateRightmostLane(nextLanes);
        parentColor = getColor();
        reserveLane(nextLanes, targetLane, normalizedParent, parentColor);
      } else {
        parentColor = nextLanes[targetLane]?.color ?? getColor();
      }

      clearHashFromOtherLanes(nextLanes, normalizedParent, targetLane);

      edges.push({
        key: `edge-${commitHash}-${normalizedParent}-${row}`,
        startLane: lane,
        startRow: row,
        endLane: targetLane,
        endRow: row + 1,
        color: parentColor,
      });
    });

    previousLanes.forEach((entry, laneIndex) => {
      if (!entry || laneIndex === lane) {
        return;
      }

      if (nextLanes[laneIndex]?.hash === entry.hash) {
        edges.push({
          key: `pass-${entry.hash}-${row}-${laneIndex}`,
          startLane: laneIndex,
          startRow: row,
          endLane: laneIndex,
          endRow: row + 1,
          color: entry.color,
        });
      }
    });

    lanes = nextLanes;
    maxLaneCount = Math.max(maxLaneCount, lanes.length);
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

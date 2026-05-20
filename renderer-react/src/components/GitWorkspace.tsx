import { DiffEditor } from '@monaco-editor/react';

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';

import { fileNameFromPath } from '@/lib/utils';
import { getMaterialFileIconSvg } from '@/lib/materialFileIcons';
import type { GitCommit, GitFileChange, GitStatus } from '@/types/electron';
import { Modal } from './Modal';
import type { GitChangeGroupId, GitWorkspaceController } from './useGitWorkspaceController';



function getChangeKey(change: GitFileChange, groupId?: string) {
  return `${groupId ?? 'change'}:${change.path}:${change.oldPath ?? ''}:${change.status}`;
}

function getChangeLabel(change: GitFileChange) {
  if (change.untracked) {
    return 'U';
  }

  if (change.conflicted) {
    return '!';
  }

  const status = change.status.replace(/\./g, '').trim();
  return status || 'M';
}

function getChangeTitle(change: GitFileChange) {
  if (change.oldPath && change.oldPath !== change.path) {
    return `${change.oldPath} -> ${change.path}`;
  }

  return change.path;
}

function getDirectoryLabel(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

function GitFileIcon({ filePath }: { filePath: string }) {
  const iconSvg = getMaterialFileIconSvg(filePath);

  if (!iconSvg) {
    return <FileCode2 size={16} strokeWidth={1.8} />;
  }

  return <span className="material-file-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg }} />;
}

function formatCommitFullDate(value: string) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatCommitRelativeDate(value: string) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds) {
      return formatter.format(Math.round(seconds / unitSeconds), unit);
    }
  }

  return formatter.format(seconds, 'second');
}

function hasCommitStats(commit: GitCommit) {
  const stats = commit.stats;
  return Boolean(stats && (stats.filesChanged > 0 || stats.insertions > 0 || stats.deletions > 0));
}

function getCommitAuthor(commit: GitCommit) {
  return commit.author || commit.authorEmail || 'Unknown author';
}

function getCommitInitials(author: string) {
  const words = author.split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join('');
  return initials || author[0]?.toUpperCase() || '?';
}

function statusMessage(status: GitStatus) {
  if (status.operation) {
    return `Repository is in ${status.operation} mode. Resolve pending Git state before normal sync operations.`;
  }

  if (status.message) {
    return status.message;
  }

  if (status.state === 'repository' && !status.hasChanges) {
    return 'Working tree clean.';
  }

  return '';
}

function shouldShowHealthBanner(status: GitStatus) {
  return status.state !== 'repository' || Boolean(status.operation) || status.conflictedFiles.length > 0;
}

function shortBranchName(branch: string | null | undefined) {
  if (!branch) {
    return '';
  }

  return branch.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '').replace(/^origin\//, '');
}

function cleanRefs(refs: string) {
  return refs
    .split(',')
    .map((ref) => ref.trim().replace(/^HEAD -> /, ''))
    .filter(Boolean);
}

type GitCommitPointer = {
  id: string;
  kind: 'local' | 'remote';
  label: string;
  title: string;
};

function getCommitPointers(commit: GitCommit, refs: string[], status: GitStatus, currentRemoteName: string | null): GitCommitPointer[] {
  const branchName = status.detached ? '' : status.branch || '';
  const upstreamName = status.upstream || (currentRemoteName && branchName ? `${currentRemoteName}/${branchName}` : '');
  const pointers: GitCommitPointer[] = [];

  if (branchName && refs.includes(branchName)) {
    pointers.push({
      id: `${commit.hash}:local:${branchName}`,
      kind: 'local',
      label: branchName,
      title: `Local branch ${branchName}`,
    });
  }

  if (upstreamName && refs.includes(upstreamName)) {
    pointers.push({
      id: `${commit.hash}:remote:${upstreamName}`,
      kind: 'remote',
      label: upstreamName,
      title: `Remote branch ${upstreamName}`,
    });
  }

  return pointers;
}

function GitHealthBanner({ controller }: { controller: GitWorkspaceController }) {
  const { status, busyAction, handleTrustRepository } = controller;
  if (!shouldShowHealthBanner(status)) {
    return null;
  }

  const message = statusMessage(status);
  const bannerTone = status.state === 'repository' && status.conflictedFiles.length === 0 ? 'info' : 'warning';

  return (
    <div className={`git-health-banner git-health-${bannerTone}`}>
      <span className="git-health-icon" aria-hidden="true">
        {status.safeDirectoryRequired ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
      </span>
      <span className="git-health-message">{message || 'Git could not inspect this workspace.'}</span>
      {status.safeDirectoryRequired ? (
        <button className="secondary-button compact" type="button" onClick={handleTrustRepository} disabled={busyAction === 'trust-repo'}>
          Trust
        </button>
      ) : null}
    </div>
  );
}

function GitPublishModal({ controller }: { controller: GitWorkspaceController }) {
  const { publishModalOpen, setPublishModalOpen, publishForm, setPublishForm, handlePublishRepository } = controller;

  return (
    <Modal open={publishModalOpen} title="Publish repository" subtitle="Create a remote repository and push the active branch." onClose={() => setPublishModalOpen(false)}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          handlePublishRepository();
        }}
      >
        <label>
          Provider
          <select value={publishForm.provider} onChange={(event) => setPublishForm((current) => ({ ...current, provider: event.target.value as 'github' | 'gitlab' }))}>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
        <label>
          Repository name
          <input value={publishForm.repositoryName} onChange={(event) => setPublishForm((current) => ({ ...current, repositoryName: event.target.value }))} placeholder="my-project" />
        </label>
        <label>
          Owner or namespace
          <input value={publishForm.owner} onChange={(event) => setPublishForm((current) => ({ ...current, owner: event.target.value }))} placeholder="optional org, group, or username" />
        </label>
        <label>
          Visibility
          <select value={publishForm.visibility} onChange={(event) => setPublishForm((current) => ({ ...current, visibility: event.target.value as 'private' | 'public' }))}>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </label>
        <label>
          Initial commit message
          <input
            value={publishForm.initialCommitMessage}
            onChange={(event) => setPublishForm((current) => ({ ...current, initialCommitMessage: event.target.value }))}
            placeholder="Initial commit"
          />
        </label>
        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={() => setPublishModalOpen(false)}>
            Cancel
          </button>
          <button className="primary-button" type="submit">
            Publish
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GitChangeActions({ controller, change, groupId }: { controller: GitWorkspaceController; change: GitFileChange; groupId: GitChangeGroupId }) {
  const { isBusy, workspacePath, handleOpenChangeFile, handleStage, handleUnstage, handleDiscard } = controller;

  return (
    <span className="git-change-actions">
      <button
        className="icon-button"
        type="button"
        title="Open File"
        onClick={(event) => {
          event.stopPropagation();
          handleOpenChangeFile(change);
        }}
        disabled={!workspacePath}
      >
        <ExternalLink size={12} />
      </button>
      <button
        className="icon-button"
        type="button"
        title="Discard"
        onClick={(event) => {
          event.stopPropagation();
          handleDiscard(change, groupId);
        }}
        disabled={isBusy}
      >
        <Undo2 size={12} />
      </button>
      {groupId !== 'staged' ? (
        <button
          className="icon-button"
          type="button"
          title="Stage"
          onClick={(event) => {
            event.stopPropagation();
            handleStage(change);
          }}
          disabled={isBusy}
        >
          <Plus size={12} />
        </button>
      ) : (
        <button
          className="icon-button"
          type="button"
          title="Unstage"
          onClick={(event) => {
            event.stopPropagation();
            handleUnstage(change);
          }}
          disabled={isBusy}
        >
          <RotateCcw size={12} />
        </button>
      )}
    </span>
  );
}

export function GitSourceControlPanel({ controller }: { controller: GitWorkspaceController }) {
  const {
    status,
    groups,
    selectedChange,
    selectedGroup,
    hasRepository,
    hasStagedChanges,
    isBusy,
    isDetectingRepository,
    totalChanges,
    commitMessage,
    busyAction,
    setCommitMessage,
    setPublishModalOpen,
    selectChange,
    refreshGit,
    handleStageAll,
    handleUnstageAll,
    handleCommit,
    handleFetch,
    handlePull,
    handlePush,
    handleInitializeRepository,
  } = controller;
  
  const visibleGroups = groups.filter((group) => group.changes.length > 0);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    staged: true,
    unstaged: true,
    untracked: true,
    conflicted: true,
  });

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <section className="git-source-panel vscode-git-panel">
      <header className="git-source-header">
        <span>SOURCE CONTROL</span>
        <div className="git-source-toolbar">
          {hasRepository ? (
            <>
              <button className="icon-button" type="button" title="Fetch" onClick={handleFetch} disabled={isBusy}>
                <RefreshCcw size={14} />
              </button>
              <button className="icon-button" type="button" title="Pull" onClick={handlePull} disabled={isBusy}>
                <ArrowDown size={14} />
              </button>
              <button className="icon-button" type="button" title="Push" onClick={handlePush} disabled={isBusy}>
                <ArrowUp size={14} />
              </button>
            </>
          ) : null}
          <button className="icon-button" type="button" title="Refresh Git" onClick={() => void refreshGit()} disabled={busyAction === 'refresh'}>
            {busyAction === 'refresh' ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}
          </button>
        </div>
      </header>

      {isDetectingRepository ? null : <GitHealthBanner controller={controller} />}

      {isDetectingRepository ? (
        <div className="git-empty-state compact git-loading-state">
          <LoaderCircle size={18} className="spin" />
          <p>Detecting Git repository.</p>
        </div>
      ) : hasRepository ? (
        <div className="git-source-content scrollable">
          <div className="git-source-commit-box">
            <textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  handleCommit();
                }
              }}
              placeholder={`Message (Ctrl+Enter to commit on "${shortBranchName(status.branch) || 'HEAD'}")`}
            />
            <button className="git-commit-button" type="button" onClick={handleCommit} disabled={isBusy || !commitMessage.trim() || !hasStagedChanges}>
              {busyAction === 'commit' ? <LoaderCircle size={14} className="spin" /> : null}
              <span>Commit</span>
            </button>
          </div>

          <div className="git-change-groups">
            {visibleGroups.length === 0 ? (
              <div className="git-empty-state compact">
                <Check size={18} />
                <p>No changes.</p>
              </div>
            ) : (
              visibleGroups.map((group) => {
                const isExpanded = expandedGroups[group.id] ?? true;
                return (
                  <section key={group.id} className="git-change-group vscode-group">
                    <header onClick={() => toggleGroup(group.id)}>
                      <div className="vscode-group-header-left">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span>{group.title}</span>
                      </div>
                      <div className="vscode-group-trailing" onClick={e => e.stopPropagation()}>
                        <div className="vscode-group-actions">
                          {group.id === 'staged' ? (
                            <button className="icon-button" title="Unstage All" onClick={handleUnstageAll} disabled={isBusy}>
                              <RotateCcw size={14} />
                            </button>
                          ) : (
                            <button className="icon-button" title="Stage All" onClick={handleStageAll} disabled={isBusy}>
                              <Plus size={14} />
                            </button>
                          )}
                        </div>
                        <span className="vscode-group-badge">{group.id === 'unstaged' && totalChanges > 0 ? totalChanges : group.changes.length}</span>
                      </div>
                    </header>
                    {isExpanded && (
                      <div className="git-change-list vscode-change-list">
                        {group.changes.map((change) => {
                          const selected = selectedChange?.path === change.path && selectedGroup === group.id;
                          const directory = getDirectoryLabel(change.path);
                          return (
                            <div
                              key={getChangeKey(change, group.id)}
                              className={`git-change-row vscode-change-row ${selected ? 'active' : ''} ${change.conflicted ? 'conflicted' : ''}`}
                              onClick={() => selectChange(change, group.id)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  selectChange(change, group.id);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              title={getChangeTitle(change)}
                            >
                              <span className="git-file-badge">
                                <GitFileIcon filePath={change.path} />
                              </span>
                              <span className="git-change-name">
                                <strong>{fileNameFromPath(change.path)}</strong>
                                {directory ? <small>{directory}</small> : null}
                              </span>
                              <GitChangeActions controller={controller} change={change} groupId={group.id} />
                              <span className="git-change-code vscode-change-code">{getChangeLabel(change)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </div>
      ) : status.state === 'not-repository' ? (
        <div className="git-start-panel">
          <button className="primary-button" type="button" onClick={handleInitializeRepository} disabled={isBusy}>
            Initialize repository
          </button>
          <button className="secondary-button" type="button" onClick={() => setPublishModalOpen(true)} disabled={isBusy}>
            Publish to GitHub or GitLab
          </button>
        </div>
      ) : null}

      <GitPublishModal controller={controller} />
    </section>
  );
}

export function GitWorkspace({ controller }: { controller: GitWorkspaceController }) {
  const { status, selectedChange, diff, selectedLanguage, resolvedTheme, uiPreferences, isDetectingRepository, handleOpenSelectedFile, workspacePath } = controller;
  const hasRepository = status.state === 'repository';

  return (
    <section className="tool-workspace git-workspace git-diff-workspace">
      <header className="git-diff-header">
        <div>
          <h2>{selectedChange ? getChangeTitle(selectedChange) : hasRepository ? 'Select a changed file' : 'Git'}</h2>
        </div>
        {selectedChange ? (
          <button className="secondary-button compact" type="button" onClick={handleOpenSelectedFile} disabled={!workspacePath}>
            Open file
          </button>
        ) : null}
      </header>

      <div className="git-diff-stage">
        {isDetectingRepository ? (
          <div className="git-empty-state">
            <LoaderCircle size={22} className="spin" />
            <p>Detecting Git repository.</p>
          </div>
        ) : !hasRepository ? (
          <div className="git-empty-state">
            <GitBranch size={24} />
            <p>{statusMessage(status) || 'Open a Git repository to view changes.'}</p>
          </div>
        ) : selectedChange && diff ? (
          <DiffEditor
            height="100%"
            language={selectedLanguage}
            original={diff.oldContent}
            modified={diff.newContent}
            theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
            options={{
              automaticLayout: true,
              fontFamily: uiPreferences.editorFontFamily,
              fontSize: uiPreferences.editorFontSize,
              minimap: { enabled: false },
              readOnly: true,
              renderSideBySide: true,
              scrollBeyondLastLine: false,
              wordWrap: uiPreferences.editorWordWrap,
            }}
          />
        ) : selectedChange ? (
          <div className="git-empty-state">
            <LoaderCircle size={22} className="spin" />
            <p>Loading diff.</p>
          </div>
        ) : (
          <div className="git-empty-state">
            <FileCode2 size={24} />
            <p>Select a changed file to view its diff.</p>
          </div>
        )}
      </div>
    </section>
  );
}

const GRAPH_COLORS = ['#3fb950', '#2f81f7', '#d29922', '#f85149', '#a371f7', '#1f6feb'];
const GRAPH_ROW_HEIGHT = 24;
const GRAPH_COL_WIDTH = 11;
const GRAPH_PADDING_X = 8;
const GRAPH_NODE_RADIUS = 4;
const GRAPH_TEXT_GAP = 10;

type WorkingTreeGraphCommit = {
  hash: string;
  isWorkingTree: true;
  parents: string[];
};

type GraphCommit = GitCommit | WorkingTreeGraphCommit;

function isWorkingTreeGraphCommit(commit: GraphCommit): commit is WorkingTreeGraphCommit {
  return 'isWorkingTree' in commit && commit.isWorkingTree;
}

type GraphLane = {
  hash: string;
  color: string;
};

type GraphEdge = {
  key: string;
  startLane: number;
  startRow: number;
  endLane: number;
  endRow: number;
  color: string;
};

function useCommitGraph(commits: GitCommit[], totalChanges: number) {
  return useMemo(() => {
    let lanes: Array<GraphLane | null> = [];
    let colorIdx = 0;
    const getColor = () => GRAPH_COLORS[colorIdx++ % GRAPH_COLORS.length];
    const edges: GraphEdge[] = [];
    const nodes: { x: number; y: number; color: string }[] = [];
    let maxLaneCount = 1;

    const renderData: GraphCommit[] = totalChanges > 0
      ? [{ hash: 'WORKING_TREE', isWorkingTree: true, parents: [commits[0]?.hash].filter(Boolean) }, ...commits]
      : commits;

    renderData.forEach((commit, row) => {
      const nextLanes = [...lanes];
      let lane = lanes.findIndex((entry) => entry?.hash === commit.hash);

      if (lane === -1) {
        lane = lanes.findIndex((entry) => entry === null);
        if (lane === -1) {
          lane = lanes.length;
        }
      }

      const currentColor = lanes[lane]?.color ?? getColor();

      nodes.push({
        x: GRAPH_PADDING_X + lane * GRAPH_COL_WIDTH,
        y: row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2,
        color: currentColor,
      });

      nextLanes[lane] = null;

      commit.parents.forEach((parentHash, parentIndex) => {
        let targetLane = nextLanes.findIndex((entry) => entry?.hash === parentHash);

        if (targetLane !== -1) {
          edges.push({
            key: `edge-${commit.hash}-${parentHash}-${row}`,
            startLane: lane,
            startRow: row,
            endLane: targetLane,
            endRow: row + 1,
            color: nextLanes[targetLane]?.color ?? currentColor,
          });
          return;
        }

        if (parentIndex === 0 && nextLanes[lane] === null) {
          targetLane = lane;
        } else {
          targetLane = nextLanes.findIndex((entry) => entry === null);
          if (targetLane === -1) {
            targetLane = nextLanes.length;
          }
        }

        const parentColor = parentIndex === 0 ? currentColor : getColor();
        nextLanes[targetLane] = { hash: parentHash, color: parentColor };

        edges.push({
          key: `edge-${commit.hash}-${parentHash}-${row}`,
          startLane: lane,
          startRow: row,
          endLane: targetLane,
          endRow: row + 1,
          color: parentColor,
        });
      });

      lanes.forEach((entry, laneIndex) => {
        if (entry && laneIndex !== lane) {
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

    const elements = edges.map((edge) => {
      const startX = GRAPH_PADDING_X + edge.startLane * GRAPH_COL_WIDTH;
      const startY = edge.startRow * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
      const endX = GRAPH_PADDING_X + edge.endLane * GRAPH_COL_WIDTH;
      const endY = edge.endRow * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;

      const path =
        startX === endX
          ? `M ${startX} ${startY} L ${endX} ${endY}`
          : [
              `M ${startX} ${startY}`,
              `C ${startX} ${startY + GRAPH_ROW_HEIGHT * 0.42}`,
              `${endX} ${endY - GRAPH_ROW_HEIGHT * 0.42}`,
              `${endX} ${endY}`,
            ].join(' ');

      return (
        <path
          key={edge.key}
          d={path}
          stroke={edge.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          fill="none"
        />
      );
    });
    const rowTextStarts = renderData.map((_, row) => {
      const nodeLane = nodes[row] ? Math.max(0, Math.round((nodes[row].x - GRAPH_PADDING_X) / GRAPH_COL_WIDTH)) : 0;
      const rowMaxLane = edges.reduce((maxLane, edge) => {
        if (edge.startRow !== row && edge.endRow !== row) {
          return maxLane;
        }

        return Math.max(maxLane, edge.startLane, edge.endLane);
      }, nodeLane);

      return GRAPH_PADDING_X + rowMaxLane * GRAPH_COL_WIDTH + GRAPH_NODE_RADIUS + GRAPH_TEXT_GAP;
    });

    return {
      elements,
      nodes,
      width: Math.max(GRAPH_PADDING_X * 2, GRAPH_PADDING_X * 2 + (maxLaneCount - 1) * GRAPH_COL_WIDTH),
      height: Math.max(GRAPH_ROW_HEIGHT, renderData.length * GRAPH_ROW_HEIGHT),
      renderData,
      rowHeight: GRAPH_ROW_HEIGHT,
      rowTextStarts,
    };
  }, [commits, totalChanges]);
}

function getGitHistoryRowStyle(rowHeight: number, textStart: number): CSSProperties {
  return {
    height: `${rowHeight}px`,
    paddingLeft: `${textStart}px`,
    '--commit-card-left': `${Math.max(8, textStart)}px`,
  } as CSSProperties;
}

function GitCommitHoverCard({ commit, refs }: { commit: GitCommit; refs: string[] }) {
  const author = getCommitAuthor(commit);
  const fullDate = formatCommitFullDate(commit.date);
  const relativeDate = formatCommitRelativeDate(commit.date);
  const stats = commit.stats;

  return (
    <div className="github-commit-card" role="tooltip">
      <div className="github-commit-card-header">
        <span className="github-commit-avatar" aria-hidden="true">
          {getCommitInitials(author)}
        </span>
        <div>
          <strong>{author}</strong>
          {fullDate ? (
            <span>
              {relativeDate || 'Committed'} ({fullDate})
            </span>
          ) : null}
        </div>
      </div>
      <p>{commit.subject}</p>
      {stats && hasCommitStats(commit) ? (
        <div className="github-commit-stats">
          <span>{stats.filesChanged} file{stats.filesChanged === 1 ? '' : 's'} changed</span>
          <span className="github-commit-insertions">{stats.insertions} line{stats.insertions === 1 ? '' : 's'} added(+)</span>
          <span className="github-commit-deletions">{stats.deletions} line{stats.deletions === 1 ? '' : 's'} deleted(-)</span>
        </div>
      ) : null}
      <div className="github-commit-card-footer">
        <span className="github-commit-hash">{commit.shortHash || commit.hash.slice(0, 7)}</span>
        {refs.length > 0 ? <span className="github-commit-footer-separator" aria-hidden="true" /> : null}
        {refs.length > 0 ? <span className="github-commit-ref-count">{refs.length} ref{refs.length === 1 ? '' : 's'}</span> : null}
      </div>
    </div>
  );
}

function GitRefBadge({ pointer }: { pointer: GitCommitPointer }) {
  return (
    <span className={`github-ref-badge github-ref-${pointer.kind}`} title={pointer.title}>
      {pointer.kind === 'local' ? <span className="github-ref-at" aria-hidden="true">@</span> : <Cloud size={12} strokeWidth={2} aria-hidden="true" />}
      <span>{pointer.label}</span>
    </span>
  );
}

export function GitHistoryPanel({ controller }: { controller: GitWorkspaceController }) {
  const { status, commits, currentRemoteName, totalChanges, isDetectingRepository, refreshGit, busyAction } = controller;
  
  const { elements, nodes, width, height, renderData, rowHeight, rowTextStarts } = useCommitGraph(commits, totalChanges);

  return (
    <section className="git-history-right-panel github-history-panel">
      <header className="git-history-right-header">
        <div>
          <h2>Git Tree</h2>
        </div>
        <button className="icon-button" type="button" title="Refresh graph" onClick={() => void refreshGit()} disabled={busyAction === 'refresh'}>
          {busyAction === 'refresh' ? <LoaderCircle size={15} className="spin" /> : <RefreshCcw size={15} />}
        </button>
      </header>

      {isDetectingRepository ? (
        <div className="git-empty-state compact">
          <LoaderCircle size={18} className="spin" />
          <p>Detecting Git repository.</p>
        </div>
      ) : status.state !== 'repository' ? (
        <div className="git-empty-state compact">
          <GitCommitHorizontal size={18} />
          <p>No Git history.</p>
        </div>
      ) : commits.length === 0 && totalChanges === 0 ? (
        <div className="git-empty-state compact">
          <GitCommitHorizontal size={18} />
          <p>No commits found.</p>
        </div>
      ) : (
        <div className="github-history-body">
          <div className="github-history-graph" style={{ width: `${width}px` }}>
            <svg width={width} height={height} className="github-svg-graph">
              {elements}
              {nodes.map((node, index) => (
                <circle
                  key={`node-${index}`}
                  cx={node.x}
                  cy={node.y}
                  r={GRAPH_NODE_RADIUS}
                  fill={node.color}
                  stroke="var(--bg-editor)"
                  strokeWidth="2"
                />
              ))}
            </svg>
          </div>
          <div className="github-history-rows">
            {renderData.map((item, index) => {
              if (isWorkingTreeGraphCommit(item)) {
                return (
                  <article
                    key="working-tree"
                    className="git-history-row git-history-row-index github-row"
                    style={getGitHistoryRowStyle(rowHeight, rowTextStarts[index] ?? GRAPH_PADDING_X)}
                  >
                    <div className="github-row-left">
                      <strong>Working tree changes</strong>
                      <span>{totalChanges} changed</span>
                    </div>
                  </article>
                );
              }

              const commit = item;
              const refs = cleanRefs(commit.refs || '');
              const author = getCommitAuthor(commit);
              const pointers = getCommitPointers(commit, refs, status, currentRemoteName);
              return (
                <article
                  key={commit.hash}
                  aria-label={commit.subject}
                  className="git-history-row github-row"
                  style={getGitHistoryRowStyle(rowHeight, rowTextStarts[index] ?? GRAPH_PADDING_X)}
                >
                  <div className="github-row-left">
                    <strong>{commit.subject}</strong>
                    <span>{author}</span>
                  </div>
                  {pointers.length > 0 ? (
                    <div className="git-history-refs github-refs">
                      {pointers.map((pointer) => (
                        <GitRefBadge key={pointer.id} pointer={pointer} />
                      ))}
                    </div>
                  ) : null}
                  <GitCommitHoverCard commit={commit} refs={refs} />
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

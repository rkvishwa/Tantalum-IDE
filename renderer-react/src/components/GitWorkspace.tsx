import { DiffEditor } from '@monaco-editor/react';

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fileNameFromPath } from '@/lib/utils';
import { getMaterialFileIconSvg } from '@/lib/materialFileIcons';
import {
  buildCommitGraph,
  buildOrthogonalEdgePath,
  getGitTreeGraphWidth,
  GRAPH_COL_WIDTH,
  GRAPH_NODE_RADIUS,
  GRAPH_PADDING_X,
  GRAPH_ROW_HEIGHT,
} from '@/lib/gitCommitGraph';
import type { GitCommit, GitFileChange, GitStatus } from '@/types/electron';
import { Modal } from './Modal';
import { GitFetchIcon, GitPullIcon, GitPushIcon, GitRefreshIcon } from './GitCodicons';
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

function getChangeCodeClass(change: GitFileChange) {
  const label = getChangeLabel(change);

  if (label === 'U') {
    return 'git-change-code-untracked';
  }

  if (label === 'D') {
    return 'git-change-code-deleted';
  }

  if (label === '!') {
    return 'git-change-code-conflict';
  }

  return 'git-change-code-modified';
}

function isDeletedChange(change: GitFileChange) {
  const label = getChangeLabel(change);
  return label === 'D' || change.status.toLowerCase().includes('delete');
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

function getGitHubUsernameFromEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const match = normalized.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  return match?.[1] ?? null;
}

function looksLikeGitHubUsername(value: string) {
  const candidate = value.trim();
  if (!candidate || /\s/.test(candidate)) {
    return false;
  }

  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(candidate);
}

function buildGitHubAvatarUrl(username: string) {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?s=44&v=4`;
}

function getCommitAvatarUrl(commit: GitCommit) {
  if (commit.authorAvatarUrl) {
    return commit.authorAvatarUrl;
  }

  const email = commit.authorEmail?.trim();
  const author = commit.author?.trim() ?? '';
  const usernameFromEmail = email ? getGitHubUsernameFromEmail(email) : null;
  if (usernameFromEmail) {
    return buildGitHubAvatarUrl(usernameFromEmail);
  }

  if (looksLikeGitHubUsername(author)) {
    return buildGitHubAvatarUrl(author);
  }

  return null;
}

function GitCommitAvatar({ commit }: { commit: GitCommit }) {
  const author = getCommitAuthor(commit);
  const initials = getCommitInitials(author);
  const avatarUrl = useMemo(
    () => getCommitAvatarUrl(commit),
    [commit.authorAvatarUrl, commit.authorEmail, commit.author],
  );
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setImageSrc(null);

    if (!avatarUrl) {
      return () => {
        canceled = true;
      };
    }

    const resolvedAvatarUrl = avatarUrl;

    async function loadAvatar() {
      const result = await window.tantalum.git.getAvatarDataUrl({ url: resolvedAvatarUrl });
      if (canceled) {
        return;
      }

      if (result.success && result.dataUrl) {
        setImageSrc(result.dataUrl);
        return;
      }

      setImageSrc(resolvedAvatarUrl);
    }

    void loadAvatar();

    return () => {
      canceled = true;
    };
  }, [avatarUrl]);

  const showImage = Boolean(imageSrc);

  return (
    <span className={`github-commit-avatar${showImage ? ' github-commit-avatar--photo' : ''}`} aria-hidden="true">
      {showImage ? (
        <img
          src={imageSrc!}
          alt=""
          width={22}
          height={22}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageSrc(null)}
        />
      ) : (
        initials
      )}
    </span>
  );
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

function isRemoteRef(ref: string, currentRemoteName: string | null) {
  return (
    ref.startsWith('refs/remotes/') ||
    (currentRemoteName ? ref.startsWith(`${currentRemoteName}/`) : false) ||
    ref.startsWith('origin/') ||
    ref.startsWith('upstream/')
  );
}

function getRefLabel(ref: string) {
  return ref
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '');
}

function isVisibleBranchRef(ref: string) {
  const normalized = ref.trim();
  if (!normalized || normalized === 'HEAD' || normalized.endsWith('/HEAD')) {
    return false;
  }

  return !normalized.startsWith('tag: ');
}

function getCommitPointers(commit: GitCommit, refs: string[], currentRemoteName: string | null): GitCommitPointer[] {
  const pointers: GitCommitPointer[] = [];
  const seen = new Set<string>();

  refs.forEach((ref) => {
    if (!isVisibleBranchRef(ref)) {
      return;
    }

    const label = getRefLabel(ref);
    const kind = isRemoteRef(ref, currentRemoteName) ? 'remote' : 'local';
    const key = `${kind}:${label}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    pointers.push({
      id: `${commit.hash}:${key}`,
      kind,
      label,
      title: `${kind === 'remote' ? 'Remote' : 'Local'} branch ${label}`,
    });
  });

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
      <span className="git-health-message">{message || 'Git could not inspect this Project Space.'}</span>
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
          <Minus size={12} />
        </button>
      )}
    </span>
  );
}

function getGitHubSubtitle(status: GitStatus, totalChanges: number) {
  if (status.state !== 'repository') {
    return statusMessage(status) || 'Open a Git repository to view changes.';
  }

  const branch = shortBranchName(status.branch) || (status.detached ? 'Detached HEAD' : 'HEAD');
  const upstream = status.upstream ? shortBranchName(status.upstream) : null;
  const branchLine = upstream ? `${branch} · tracking ${upstream}` : branch;

  if (totalChanges > 0) {
    return `${branchLine} · ${totalChanges} changed file${totalChanges === 1 ? '' : 's'}`;
  }

  return `${branchLine} · ${statusMessage(status) || 'Working tree clean.'}`;
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
    commitMessage,
    busyAction,
    setCommitMessage,
    setPublishModalOpen,
    selectChange,
    refreshGit,
    handleStageAll,
    handleUnstageAll,
    handleDiscardAllChanges,
    handleCommit,
    handleCommitAndPush,
    handleInitializeRepository,
  } = controller;

  const visibleGroups = groups.filter((group) => group.changes.length > 0);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    staged: true,
    unstaged: true,
    conflicts: true,
  });
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const commitMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!commitMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (commitMenuRef.current && !commitMenuRef.current.contains(event.target as Node)) {
        setCommitMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [commitMenuOpen]);

  const canCommit = Boolean(commitMessage.trim()) && hasStagedChanges && !isBusy;
  const commitBusy = busyAction === 'commit' || busyAction === 'commit-push';

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const branchLabel = shortBranchName(status.branch) || (status.detached ? 'Detached HEAD' : 'HEAD');

  if (isDetectingRepository) {
    return (
      <section className="git-source-panel vscode-git-panel">
        <div className="git-empty-state compact git-loading-state">
          <LoaderCircle size={18} className="spin" />
          <p>Detecting Git repository.</p>
        </div>
      </section>
    );
  }

  if (!hasRepository && status.state === 'not-repository') {
    return (
      <section className="git-source-panel vscode-git-panel">
        <header className="git-source-header">
          <span>CHANGES</span>
        </header>
        <div className="git-start-panel">
          <button className="primary-button" type="button" onClick={handleInitializeRepository} disabled={isBusy}>
            Initialize repository
          </button>
          <button className="secondary-button" type="button" onClick={() => setPublishModalOpen(true)} disabled={isBusy}>
            Publish to GitHub or GitLab
          </button>
        </div>
        <GitPublishModal controller={controller} />
      </section>
    );
  }

  return (
    <section className="git-source-panel vscode-git-panel" aria-label="Source control">
      <header className="git-source-header">
        <span>CHANGES</span>
        <div className="git-source-toolbar">
          <button className="icon-button" type="button" title="Refresh" onClick={() => void refreshGit()} disabled={busyAction === 'refresh'}>
            {busyAction === 'refresh' ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}
          </button>
        </div>
      </header>

      <GitHealthBanner controller={controller} />

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
            placeholder={`Message (Ctrl+Enter to commit on "${branchLabel}")`}
          />
          <div className="git-commit-split-wrap" ref={commitMenuRef}>
            <div className="git-commit-split">
              <button
                className="git-commit-button git-commit-button-main"
                type="button"
                onClick={handleCommit}
                disabled={!canCommit}
              >
                {commitBusy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                <span>Commit</span>
              </button>
              <button
                className="git-commit-button git-commit-button-menu"
                type="button"
                title="Commit options"
                aria-label="Commit options"
                aria-expanded={commitMenuOpen}
                aria-haspopup="menu"
                onClick={() => setCommitMenuOpen((open) => !open)}
                disabled={isBusy || !hasStagedChanges}
              >
                <ChevronDown size={14} />
              </button>
            </div>
            {commitMenuOpen ? (
              <div className="boards-hub-select-menu git-commit-menu" role="menu">
                <button
                  className="boards-hub-select-item git-commit-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={!canCommit}
                  onClick={() => {
                    setCommitMenuOpen(false);
                    handleCommit();
                  }}
                >
                  Commit
                </button>
                <button
                  className="boards-hub-select-item git-commit-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={!canCommit}
                  onClick={() => {
                    setCommitMenuOpen(false);
                    handleCommitAndPush();
                  }}
                >
                  Commit &amp; Push
                </button>
              </div>
            ) : null}
          </div>
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
                      {isExpanded ? <ChevronDown size={16} strokeWidth={2} /> : <ChevronRight size={16} strokeWidth={2} />}
                      <span>{group.title}</span>
                    </div>
                    <div className="vscode-group-trailing" onClick={(event) => event.stopPropagation()}>
                      <div className="vscode-group-actions">
                        {group.id === 'staged' ? (
                          <button className="icon-button" title="Unstage All" type="button" onClick={handleUnstageAll} disabled={isBusy}>
                            <Minus size={15} />
                          </button>
                        ) : group.id === 'unstaged' ? (
                          <>
                            <button
                              className="icon-button"
                              title="Discard All Changes"
                              type="button"
                              onClick={() => void handleDiscardAllChanges()}
                              disabled={isBusy}
                            >
                              <Undo2 size={15} />
                            </button>
                            <button className="icon-button" title="Stage All" type="button" onClick={handleStageAll} disabled={isBusy}>
                              <Plus size={15} />
                            </button>
                          </>
                        ) : (
                          <button className="icon-button" title="Stage All" type="button" onClick={handleStageAll} disabled={isBusy}>
                            <Plus size={15} />
                          </button>
                        )}
                      </div>
                      <span className="vscode-group-badge">{group.changes.length}</span>
                    </div>
                  </header>
                  {isExpanded ? (
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
                              <strong className={isDeletedChange(change) ? 'git-change-deleted' : undefined}>{fileNameFromPath(change.path)}</strong>
                              {directory ? <small>{directory}</small> : null}
                            </span>
                            <GitChangeActions controller={controller} change={change} groupId={group.id} />
                            <span className={`git-change-code vscode-change-code ${getChangeCodeClass(change)}`}>{getChangeLabel(change)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              );
            })
          )}
        </div>
      </div>

      <GitPublishModal controller={controller} />
    </section>
  );
}

export function GitWorkspace({ controller }: { controller: GitWorkspaceController }) {
  const {
    status,
    selectedChange,
    diff,
    selectedLanguage,
    resolvedTheme,
    uiPreferences,
    isDetectingRepository,
    handleOpenSelectedFile,
    workspacePath,
    totalChanges,
    hasRepository,
    hoveredCommit,
  } = controller;

  return (
    <section className="tool-workspace git-hub">
      <header className="git-hub-header">
        <div className="git-hub-header-copy">
          <h1>Git</h1>
          <span className="git-hub-header-meta">{getGitHubSubtitle(status, totalChanges)}</span>
        </div>
        <div className="git-hub-header-actions">
          {selectedChange ? (
            <>
              <span className="git-hub-header-file" title={getChangeTitle(selectedChange)}>
                {getChangeTitle(selectedChange)}
              </span>
              <button className="boards-hub-btn" type="button" onClick={handleOpenSelectedFile} disabled={!workspacePath}>
                <ExternalLink size={14} />
                Open file
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div className="git-hub-diff-pane">
        <div className="git-hub-diff-stage">
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
                lineNumbers: uiPreferences.editorLineNumbers,
                lineNumbersMinChars: 3,
                minimap: { enabled: false },
                renderOverviewRuler: false,
                overviewRulerLanes: 0,
                overviewRulerBorder: false,
                hideCursorInOverviewRuler: true,
                readOnly: true,
                renderSideBySide: false,
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

        {hoveredCommit ? (
          <div className="git-hub-commit-overlay" aria-live="polite">
            <GitCommitHoverCard commit={hoveredCommit} refs={cleanRefs(hoveredCommit.refs || '')} pinned />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function isCurrentCommitPoint(commit: GitCommit, rowIndex: number, status: GitStatus) {
  const refs = cleanRefs(commit.refs || '');
  const branchName = status.detached ? '' : status.branch || '';

  if (branchName && refs.includes(branchName)) {
    return true;
  }

  return rowIndex === 0;
}

function useCommitGraph(commits: GitCommit[]) {
  return useMemo(() => {
    const layout = buildCommitGraph(commits);
    const renderData = commits;

    const elements = layout.edges.map((edge) => {
      const startX = GRAPH_PADDING_X + edge.startLane * GRAPH_COL_WIDTH;
      const startY = edge.startRow * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
      const endX = GRAPH_PADDING_X + edge.endLane * GRAPH_COL_WIDTH;
      const endY = edge.endRow * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
      const path = buildOrthogonalEdgePath(startX, startY, endX, endY);

      return (
        <path
          key={edge.key}
          d={path}
          className="git-tree-graph-edge"
          stroke={edge.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.25"
          fill="none"
        />
      );
    });

    return {
      elements,
      nodes: layout.nodes,
      width: layout.width,
      height: layout.height,
      renderData,
      rowHeight: layout.rowHeight,
      rowTextStarts: layout.rowTextStarts,
    };
  }, [commits]);
}

function getGitHistoryRowStyle(rowHeight: number, textStart: number): CSSProperties {
  return {
    height: `${rowHeight}px`,
    paddingLeft: `${textStart}px`,
  };
}

function GitCommitHoverCard({ commit, refs, pinned = false }: { commit: GitCommit; refs: string[]; pinned?: boolean }) {
  const author = getCommitAuthor(commit);
  const fullDate = formatCommitFullDate(commit.date);
  const relativeDate = formatCommitRelativeDate(commit.date);
  const stats = commit.stats;

  return (
    <div className={`github-commit-card${pinned ? ' github-commit-card--pinned' : ''}`} role="tooltip">
      <div className="github-commit-card-header">
        <GitCommitAvatar commit={commit} />
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
      {pointer.kind === 'local' ? <GitBranch size={11} strokeWidth={2} aria-hidden="true" /> : <Cloud size={11} strokeWidth={2} aria-hidden="true" />}
      <span>{pointer.label}</span>
    </span>
  );
}

function GitTreeRowRefs({ pointers }: { pointers: GitCommitPointer[] }) {
  if (pointers.length === 0) {
    return null;
  }

  return (
    <div className="git-tree-row-refs">
      {pointers.map((pointer) => (
        <GitRefBadge key={pointer.id} pointer={pointer} />
      ))}
    </div>
  );
}

export function GitHistoryPanel({ controller }: { controller: GitWorkspaceController }) {
  const {
    status,
    commits,
    currentRemoteName,
    isDetectingRepository,
    hasRepository,
    isBusy,
    refreshGit,
    busyAction,
    handleFetch,
    handlePull,
    handlePush,
    setHoveredCommit,
  } = controller;

  const { elements, nodes, width, height, renderData, rowHeight, rowTextStarts } = useCommitGraph(commits);
  const graphWidth = getGitTreeGraphWidth(width);

  return (
    <section className="git-tree-panel">
      <header className="git-tree-header">
        <span>Graph</span>
        <div className="git-tree-toolbar">
          {hasRepository ? (
            <>
              <button className="icon-button" type="button" title="Fetch" onClick={handleFetch} disabled={isBusy}>
                {busyAction === 'fetch' ? <LoaderCircle size={16} className="spin" /> : <GitFetchIcon />}
              </button>
              <button className="icon-button" type="button" title="Pull" onClick={handlePull} disabled={isBusy}>
                {busyAction === 'pull' ? <LoaderCircle size={16} className="spin" /> : <GitPullIcon />}
              </button>
              <button className="icon-button" type="button" title="Push" onClick={handlePush} disabled={isBusy}>
                {busyAction === 'push' ? <LoaderCircle size={16} className="spin" /> : <GitPushIcon />}
              </button>
            </>
          ) : null}
          <button
            className="icon-button"
            type="button"
            title="Refresh"
            onClick={() => void refreshGit()}
            disabled={busyAction === 'refresh'}
          >
            {busyAction === 'refresh' ? <LoaderCircle size={16} className="spin" /> : <GitRefreshIcon />}
          </button>
        </div>
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
      ) : commits.length === 0 ? (
        <div className="git-empty-state compact">
          <GitCommitHorizontal size={18} />
          <p>No commits found.</p>
        </div>
      ) : (
        <div className="git-tree-scroll" onMouseLeave={() => setHoveredCommit(null)}>
          <div className="github-history-body git-tree-history-body" style={{ '--git-tree-graph-width': `${graphWidth}px` } as CSSProperties}>
            <div className="github-history-graph git-tree-graph" style={{ width: `${graphWidth}px` }}>
              <svg width={graphWidth} height={height} className="github-svg-graph git-tree-svg">
                {elements}
                {nodes.map((node, index) => {
                  const commit = renderData[index];
                  if (!commit) {
                    return null;
                  }

                  const isHead = isCurrentCommitPoint(commit, index, status);

                  return (
                    <circle
                      key={`node-${index}`}
                      className={`git-tree-graph-node${isHead ? ' git-tree-graph-node-head' : ''}`}
                      cx={node.x}
                      cy={node.y}
                      r={GRAPH_NODE_RADIUS}
                      fill={isHead ? 'var(--git-tree-node-ring, var(--bg-editor))' : node.color}
                      stroke={isHead ? node.color : 'var(--git-tree-node-ring, var(--bg-editor))'}
                      strokeWidth={isHead ? 5 : 2}
                    />
                  );
                })}
              </svg>
            </div>
            <div className="github-history-rows git-tree-rows">
              {renderData.map((commit, index) => {
                const rowStyle = getGitHistoryRowStyle(rowHeight, rowTextStarts[index] ?? GRAPH_PADDING_X);
                const refs = cleanRefs(commit.refs || '');
                const author = getCommitAuthor(commit);
                const pointers = getCommitPointers(commit, refs, currentRemoteName);

                return (
                  <article
                    key={commit.hash}
                    aria-label={commit.subject}
                    className="git-history-row git-tree-row"
                    style={rowStyle}
                    onMouseEnter={() => setHoveredCommit(commit)}
                    onFocus={() => setHoveredCommit(commit)}
                  >
                    <div className="git-tree-row-line">
                      <div className="git-tree-row-copy">
                        <p className="git-tree-subject" title={commit.subject}>
                          {commit.subject}
                        </p>
                        <span className="git-tree-author" title={author}>
                          {author}
                        </span>
                      </div>
                      <GitTreeRowRefs pointers={pointers} />
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

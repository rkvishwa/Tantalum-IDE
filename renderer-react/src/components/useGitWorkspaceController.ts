import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fileNameFromPath, joinPath, normalizeOutput } from '@/lib/utils';
import type { UiPreferences } from '@/lib/uiPreferences';
import type { GitBranch as GitBranchInfo, GitCommit, GitDiff, GitDiffMode, GitFileChange, GitRemote, GitStatus } from '@/types/electron';

import { useConfirm } from './ConfirmProvider';

type GitControllerProps = {
  workspacePath: string | null;
  active: boolean;
  uiPreferences: UiPreferences;
  resolvedTheme: 'dark' | 'light';
  onOpenFile: (filePath: string) => void;
  onRefreshWorkspace: () => void;
  onStatusChange?: (status: GitStatus) => void;
  pushConsole: (message: string, level?: 'info' | 'success' | 'error') => void;
  pushToast: (
    message: string,
    tone?: 'info' | 'success' | 'error',
    actions?: Array<{ label: string; onSelect: () => void }>,
  ) => void;
};

export type GitChangeGroupId = 'conflicts' | 'staged' | 'unstaged';

type GitChangeGroup = {
  id: GitChangeGroupId;
  title: string;
  changes: GitFileChange[];
};

const EMPTY_STATUS: GitStatus = {
  state: 'no-workspace',
  available: true,
  isRepository: false,
  root: null,
  gitDir: null,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  operation: null,
  stagedFiles: [],
  unstagedFiles: [],
  untrackedFiles: [],
  conflictedFiles: [],
  hasChanges: false,
  safeDirectoryRequired: false,
  message: 'Open a Project Space to use Git.',
};

function inferEditorLanguage(filePath: string | null) {
  if (!filePath) {
    return 'plaintext';
  }

  const extension = filePath.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'c':
    case 'h':
    case 'hpp':
    case 'ino':
    case 'cpp':
    case 'cc':
    case 'cxx':
      return 'cpp';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'xml':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

export function useGitWorkspaceController({
  workspacePath,
  active,
  uiPreferences,
  resolvedTheme,
  onOpenFile,
  onRefreshWorkspace,
  onStatusChange,
  pushConsole,
  pushToast,
}: GitControllerProps) {
  const { confirm } = useConfirm();
  const [status, setStatus] = useState<GitStatus>(EMPTY_STATUS);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [selectedChange, setSelectedChange] = useState<GitFileChange | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<GitChangeGroupId>('unstaged');
  const [selectedDiffMode, setSelectedDiffMode] = useState<GitDiffMode>('working-tree');
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [hasStatusLoaded, setHasStatusLoaded] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishForm, setPublishForm] = useState({
    provider: 'github' as 'github' | 'gitlab',
    repositoryName: '',
    owner: '',
    visibility: 'private' as 'private' | 'public',
    initialCommitMessage: 'Initial commit',
  });
  const [hoveredCommit, setHoveredCommit] = useState<GitCommit | null>(null);
  const selectedGroupRef = useRef<GitChangeGroupId>('unstaged');
  const callbacksRef = useRef({ onOpenFile, onRefreshWorkspace, onStatusChange, pushConsole, pushToast });
  const refreshRunRef = useRef(0);

  useEffect(() => {
    callbacksRef.current = { onOpenFile, onRefreshWorkspace, onStatusChange, pushConsole, pushToast };
  }, [onOpenFile, onRefreshWorkspace, onStatusChange, pushConsole, pushToast]);

  const groups = useMemo<GitChangeGroup[]>(
    () => [
      { id: 'conflicts', title: 'Conflicts', changes: status.conflictedFiles },
      { id: 'staged', title: 'Staged Changes', changes: status.stagedFiles },
      { id: 'unstaged', title: 'Changes', changes: [...status.unstagedFiles, ...status.untrackedFiles] },
    ],
    [status.conflictedFiles, status.stagedFiles, status.unstagedFiles, status.untrackedFiles],
  );

  const localBranches = useMemo(() => branches.filter((branch) => !branch.remote), [branches]);
  const selectedLanguage = useMemo(() => inferEditorLanguage(selectedChange?.path ?? null), [selectedChange]);
  const currentBranchName = status.detached ? 'Detached HEAD' : status.branch || 'No branch';
  const syncSummary = [status.ahead > 0 ? `${status.ahead} ahead` : '', status.behind > 0 ? `${status.behind} behind` : ''].filter(Boolean).join(', ');
  const hasRepository = status.state === 'repository';
  const hasStagedChanges = status.stagedFiles.length > 0;
  const isBusy = Boolean(busyAction);
  const isDetectingRepository = !hasStatusLoaded;
  const totalChanges = status.stagedFiles.length + status.unstagedFiles.length + status.untrackedFiles.length + status.conflictedFiles.length;
  const currentRemoteName = remotes[0]?.name ?? null;

  useEffect(() => {
    refreshRunRef.current += 1;
    setHasStatusLoaded(false);
    setStatus({ ...EMPTY_STATUS, root: workspacePath });
    setBranches([]);
    setCommits([]);
    setRemotes([]);
    setSelectedChange(null);
    setDiff(null);
    setHoveredCommit(null);
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath || publishForm.repositoryName) {
      return;
    }

    setPublishForm((current) => ({
      ...current,
      repositoryName: fileNameFromPath(workspacePath).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository',
    }));
  }, [publishForm.repositoryName, workspacePath]);

  const selectChange = useCallback((change: GitFileChange, groupId: GitChangeGroupId) => {
    selectedGroupRef.current = groupId;
    setSelectedChange(change);
    setSelectedGroup(groupId);
    setSelectedDiffMode(groupId === 'staged' ? 'staged' : 'working-tree');
  }, []);

  const refreshGit = useCallback(async () => {
    if (!active) {
      return;
    }

    const refreshRunId = refreshRunRef.current + 1;
    refreshRunRef.current = refreshRunId;
    const isStaleRefresh = () => refreshRunRef.current !== refreshRunId;
    const finishRefresh = () => setBusyAction((current) => (current === 'refresh' ? null : current));

    setBusyAction((current) => current ?? 'refresh');
    if (workspacePath) {
      const workspaceResult = await window.tantalum.fs.setWorkspace(workspacePath);
      if (isStaleRefresh()) {
        return;
      }

      if (!workspaceResult.success) {
        const nextStatus = { ...EMPTY_STATUS, message: workspaceResult.error };
        setStatus(nextStatus);
        setHasStatusLoaded(true);
        callbacksRef.current.onStatusChange?.(nextStatus);
        callbacksRef.current.pushToast(workspaceResult.error, 'error');
        finishRefresh();
        return;
      }
    }

    const statusResult = await window.tantalum.git.getStatus();
    if (isStaleRefresh()) {
      return;
    }

    if (!statusResult.success) {
      const nextStatus = { ...EMPTY_STATUS, message: statusResult.error };
      setStatus(nextStatus);
      setHasStatusLoaded(true);
      callbacksRef.current.onStatusChange?.(nextStatus);
      setBranches([]);
      setCommits([]);
      setRemotes([]);
      callbacksRef.current.pushToast(statusResult.error, 'error');
      finishRefresh();
      return;
    }

    const nextStatus = statusResult.status;
    setStatus(nextStatus);
    setHasStatusLoaded(true);
    callbacksRef.current.onStatusChange?.(nextStatus);

    if (nextStatus.state !== 'repository') {
      setBranches([]);
      setCommits([]);
      setRemotes([]);
      setSelectedChange(null);
      setDiff(null);
      finishRefresh();
      return;
    }

    const nextGroups: Array<{ groupId: GitChangeGroupId; change: GitFileChange }> = [
      ...nextStatus.conflictedFiles.map((change) => ({ groupId: 'conflicts' as const, change })),
      ...nextStatus.stagedFiles.map((change) => ({ groupId: 'staged' as const, change })),
      ...nextStatus.unstagedFiles.map((change) => ({ groupId: 'unstaged' as const, change })),
      ...nextStatus.untrackedFiles.map((change) => ({ groupId: 'unstaged' as const, change })),
    ];

    setSelectedChange((current) => {
      const retained = current
        ? nextGroups.find((entry) => entry.change.path === current.path && entry.groupId === selectedGroupRef.current) ??
          nextGroups.find((entry) => entry.change.path === current.path)
        : null;
      const nextSelection = retained ?? nextGroups[0] ?? null;
      if (nextSelection) {
        selectedGroupRef.current = nextSelection.groupId;
        setSelectedGroup(nextSelection.groupId);
        setSelectedDiffMode(nextSelection.groupId === 'staged' ? 'staged' : 'working-tree');
      }
      return nextSelection?.change ?? null;
    });

    const [branchResult, logResult, remoteResult] = await Promise.all([
      window.tantalum.git.listBranches(),
      window.tantalum.git.getLog({ limit: 120 }),
      window.tantalum.git.getRemotes(),
    ]);
    if (isStaleRefresh()) {
      return;
    }

    if (branchResult.success) {
      setBranches(branchResult.branches);
    }

    if (logResult.success) {
      setCommits(logResult.commits);
    }

    if (remoteResult.success) {
      setRemotes(remoteResult.remotes);
    }

    finishRefresh();
  }, [active, workspacePath]);

  useEffect(() => {
    if (!active) {
      return;
    }

    void refreshGit();
  }, [active, refreshGit, workspacePath]);

  useEffect(() => {
    let canceled = false;

    async function loadDiff() {
      if (!active || !selectedChange || status.state !== 'repository') {
        setDiff(null);
        return;
      }

      const result = await window.tantalum.git.getDiff({
        path: selectedChange.path,
        oldPath: selectedChange.oldPath,
        mode: selectedDiffMode,
      });

      if (canceled) {
        return;
      }

      if (result.success) {
        setDiff(result.diff);
      } else {
        setDiff(null);
        callbacksRef.current.pushToast(result.error, 'error');
      }
    }

    void loadDiff();

    return () => {
      canceled = true;
    };
  }, [active, selectedChange, selectedDiffMode, status.state]);

  async function runMutation(actionId: string, action: () => Promise<{ success: true; output?: string } | { success: false; error: string }>, successMessage: string) {
    setBusyAction(actionId);
    const result = await action();
    if (result.success) {
      if (result.output?.trim()) {
        callbacksRef.current.pushConsole(normalizeOutput(result.output), 'success');
      }
      callbacksRef.current.pushToast(successMessage, 'success');
      callbacksRef.current.onRefreshWorkspace();
      await refreshGit();
    } else {
      callbacksRef.current.pushToast(result.error, 'error');
      callbacksRef.current.pushConsole(result.error, 'error');
    }
    setBusyAction(null);
  }

  function stageablePaths() {
    return [...status.conflictedFiles, ...status.unstagedFiles, ...status.untrackedFiles].map((change) => change.path);
  }

  function handleStage(change: GitFileChange) {
    void runMutation(`stage:${change.path}`, () => window.tantalum.git.stage({ path: change.path }), `Staged ${fileNameFromPath(change.path)}`);
  }

  function handleUnstage(change: GitFileChange) {
    void runMutation(`unstage:${change.path}`, () => window.tantalum.git.unstage({ path: change.path }), `Unstaged ${fileNameFromPath(change.path)}`);
  }

  async function handleDiscard(change: GitFileChange, groupId: GitChangeGroupId) {
    const confirmed = await confirm({
      message: `Discard changes in ${change.path}?`,
      detail: 'This cannot be undone.',
      tone: 'danger',
      confirmLabel: 'Discard',
    });
    if (!confirmed) {
      return;
    }

    void runMutation(
      `discard:${change.path}`,
      () => window.tantalum.git.discard({ path: change.path, staged: groupId === 'staged', untracked: change.untracked }),
      `Discarded ${fileNameFromPath(change.path)}`,
    );
  }

  function handleStageAll() {
    const paths = stageablePaths();
    if (paths.length === 0) {
      return;
    }

    void runMutation('stage-all', () => window.tantalum.git.stage({ paths }), 'Staged all changes');
  }

  function handleUnstageAll() {
    if (status.stagedFiles.length === 0) {
      return;
    }

    void runMutation('unstage-all', () => window.tantalum.git.unstage({ paths: status.stagedFiles.map((change) => change.path) }), 'Unstaged all changes');
  }

  async function handleDiscardAllChanges() {
    const unstagedPaths = status.unstagedFiles.map((change) => change.path);
    const untrackedPaths = status.untrackedFiles.map((change) => change.path);
    if (unstagedPaths.length === 0 && untrackedPaths.length === 0) {
      return;
    }

    const confirmed = await confirm({
      message: 'Discard all changes?',
      detail: 'This will revert modified files and delete untracked files. This cannot be undone.',
      tone: 'danger',
      confirmLabel: 'Discard All',
    });
    if (!confirmed) {
      return;
    }

    void runMutation(
      'discard-all',
      async () => {
        if (unstagedPaths.length > 0) {
          const result = await window.tantalum.git.discard({ paths: unstagedPaths, staged: false, untracked: false });
          if (!result.success) {
            return result;
          }
        }

        if (untrackedPaths.length > 0) {
          const result = await window.tantalum.git.discard({ paths: untrackedPaths, untracked: true });
          if (!result.success) {
            return result;
          }
        }

        return { success: true as const, output: 'Discarded all changes.' };
      },
      'Discarded all changes',
    );
  }

  function handleCommit() {
    const message = commitMessage.trim();
    if (!message) {
      callbacksRef.current.pushToast('Write a commit message before committing.', 'info');
      return;
    }

    void runMutation(
      'commit',
      async () => {
        const result = await window.tantalum.git.commit({ message });
        if (result.success) {
          setCommitMessage('');
        }
        return result;
      },
      'Commit created',
    );
  }

  function handleCommitAndPush() {
    const message = commitMessage.trim();
    if (!message) {
      callbacksRef.current.pushToast('Write a commit message before committing.', 'info');
      return;
    }

    void runMutation(
      'commit-push',
      async () => {
        const commitResult = await window.tantalum.git.commit({ message });
        if (!commitResult.success) {
          return commitResult;
        }

        setCommitMessage('');
        return window.tantalum.git.push();
      },
      'Committed and pushed',
    );
  }

  function handleFetch() {
    void runMutation('fetch', () => window.tantalum.git.fetch(), 'Fetched remotes');
  }

  function handlePull() {
    void runMutation('pull', () => window.tantalum.git.pull(), 'Pulled latest changes');
  }

  function handlePush() {
    void runMutation('push', () => window.tantalum.git.push(), 'Pushed branch');
  }

  function handleCheckoutBranch(branchName: string) {
    if (!branchName || branchName === status.branch) {
      return;
    }

    void runMutation(`checkout:${branchName}`, () => window.tantalum.git.checkoutBranch({ branch: branchName }), `Checked out ${branchName}`);
  }

  function handleCreateBranch() {
    const branch = newBranchName.trim();
    if (!branch) {
      callbacksRef.current.pushToast('Enter a branch name.', 'info');
      return;
    }

    void runMutation(
      `create-branch:${branch}`,
      async () => {
        const result = await window.tantalum.git.createBranch({ branch });
        if (result.success) {
          setNewBranchName('');
        }
        return result;
      },
      `Created ${branch}`,
    );
  }

  async function handleTrustRepository() {
    const confirmed = await confirm({
      message: 'Trust this repository for Git by adding it to your global safe.directory list?',
      tone: 'warning',
      confirmLabel: 'Trust repository',
    });
    if (!confirmed) {
      return;
    }

    void runMutation('trust-repo', () => window.tantalum.git.repairSafeDirectory(), 'Repository trusted for Git');
  }

  function handleInitializeRepository() {
    void runMutation('init-repo', () => window.tantalum.git.initRepository({ defaultBranch: 'main' }), 'Repository initialized');
  }

  function handlePublishRepository() {
    const repositoryName = publishForm.repositoryName.trim();
    if (!repositoryName) {
      callbacksRef.current.pushToast('Enter a repository name.', 'info');
      return;
    }

    void runMutation(
      'publish',
      async () => {
        const result = await window.tantalum.git.publishRepository({
          provider: publishForm.provider,
          repositoryName,
          owner: publishForm.owner.trim() || undefined,
          visibility: publishForm.visibility,
          initialCommitMessage: publishForm.initialCommitMessage.trim() || 'Initial commit',
        });
        if (result.success) {
          setPublishModalOpen(false);
        }
        return result;
      },
      'Repository published',
    );
  }

  function handleOpenSelectedFile() {
    if (!selectedChange) {
      return;
    }

    handleOpenChangeFile(selectedChange);
  }

  function handleOpenChangeFile(change: GitFileChange) {
    if (!workspacePath) {
      return;
    }

    callbacksRef.current.onOpenFile(joinPath(workspacePath, change.path));
  }

  return {
    workspacePath,
    uiPreferences,
    resolvedTheme,
    status,
    branches,
    commits,
    remotes,
    selectedChange,
    selectedGroup,
    selectedDiffMode,
    diff,
    commitMessage,
    newBranchName,
    busyAction,
    publishModalOpen,
    publishForm,
    groups,
    localBranches,
    selectedLanguage,
    currentBranchName,
    syncSummary,
    hasRepository,
    hasStagedChanges,
    isBusy,
    isDetectingRepository,
    totalChanges,
    currentRemoteName,
    hoveredCommit,
    setHoveredCommit,
    setCommitMessage,
    setNewBranchName,
    setPublishModalOpen,
    setPublishForm,
    selectChange,
    refreshGit,
    stageablePaths,
    handleStage,
    handleUnstage,
    handleDiscard,
    handleStageAll,
    handleUnstageAll,
    handleDiscardAllChanges,
    handleCommit,
    handleCommitAndPush,
    handleFetch,
    handlePull,
    handlePush,
    handleCheckoutBranch,
    handleCreateBranch,
    handleTrustRepository,
    handleInitializeRepository,
    handlePublishRepository,
    handleOpenSelectedFile,
    handleOpenChangeFile,
  };
}

export type GitWorkspaceController = ReturnType<typeof useGitWorkspaceController>;

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Models } from 'appwrite';
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  Code,
  FileText,
  History,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  SendHorizontal,
  Settings,
  Settings2,
  Shield,
  Sliders,
  Sparkles,
  SquareStop,
  Trash2,
  X,
} from 'lucide-react';

import {
  createAgentThread,
  createAgentThreadMessage,
  createCustomCredential,
  createDefaultAgentSettings,
  deleteAgentThread,
  deleteCustomCredential,
  loadAgentSettings,
  loadAgentThreadMessages,
  listAgentThreads,
  normalizeModelList,
  renameAgentThread,
  saveAgentPreferences,
  testCustomCredential,
  updateCustomCredential,
  type AgentCredentialInput,
  type AgentCustomCredential,
  type AgentPreferences,
  type AgentSettingsState,
  type AgentThreadMessage,
  type AgentThreadSummary,
  type AgentUiMessage,
} from '@/lib/agent';
import { hasAgentCloudConfiguration } from '@/lib/config';
import type {
  AgentChangePreview,
  AgentProgressEvent,
  AgentRunPayload,
  AgentTaskList,
  AgentTaskStatus,
  PendingAgentAction,
  PendingAgentActionStatus,
} from '@/types/electron';

import { MarkdownRenderer } from './MarkdownRenderer';

export type AgentPendingReview = {
  id: string;
  threadId: string;
  files: AgentChangePreview[];
  output: string;
  createdAt: string;
};

export type AgentPreparedReview = Omit<AgentPendingReview, 'id' | 'createdAt'>;

export type AgentReviewResolutionNotice = {
  id: string;
  threadId: string;
  content: string;
  tone: AgentUiMessage['tone'];
  createdAt: string;
};

type AgentPanelProps = {
  user: Models.User<Models.Preferences>;
  workspacePath: string | null;
  activeTab: {
    path: string;
    name: string;
    content: string;
    isDirty: boolean;
  } | null;
  pushConsole: (message: string, level?: 'info' | 'success' | 'error') => void;
  pushToast: (message: string, tone?: 'info' | 'success' | 'error') => void;
  pendingReview?: AgentPendingReview | null;
  resolvingReview?: boolean;
  reviewResolutionNotice?: AgentReviewResolutionNotice | null;
  onAgentChangesPrepared?: (review: AgentPreparedReview) => void;
  onPreviewAgentFile?: (relativePath: string) => void;
  onResolveAgentChanges?: (approved: boolean) => void | Promise<void>;
  defaultView?: AgentView;
  hideChat?: boolean;
  chatOnly?: boolean;
  onOpenSettings?: () => void;
  onClosePanel?: () => void;
  onSignedOut?: () => void;
};

type AgentView = 'chat' | 'settings' | 'usage';
type AgentComposeTarget = 'new' | 'thread';
type AgentIntent = 'agent' | 'ask';

type CredentialFormState = {
  credentialId: string | null;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  modelNames: string;
  enabled: boolean;
};

const EMPTY_CREDENTIAL_FORM: CredentialFormState = {
  credentialId: null,
  displayName: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelNames: '',
  enabled: true,
};

function formatDate(value: string | null | undefined) {
  if (!value) {
    return 'Never';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) {
    return 'Never';
  }

  const date = new Date(value);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    if (date.getDate() === now.getDate()) {
      return 'Today';
    }
    return 'Yesterday';
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }

  const weeks = Math.floor(diffDays / 7);
  if (diffDays < 30) {
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatCredits(value: number) {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

function firstEnabledCredential(settings: AgentSettingsState) {
  return settings.customCredentials.find((credential) => credential.enabled) ?? null;
}

function basenameFromPath(value: string | null) {
  if (!value) {
    return null;
  }

  return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? value;
}

function titleFromPrompt(value: string) {
  const title = value.replace(/\s+/g, ' ').trim().slice(0, 64);
  return title || 'New thread';
}

function toThreadContext(messages: AgentThreadMessage[]) {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function clampAgentMessageContent(value: string, maxLength = 24000) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n[Output truncated for thread history.]`;
}

function createLocalThreadMessage(
  role: AgentThreadMessage['role'],
  content: string,
  tone?: AgentThreadMessage['tone'],
  metadata?: Record<string, unknown>,
): AgentThreadMessage {
  return {
    id: `local-${role}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    threadId: 'local',
    role,
    content,
    tone,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asPendingAgentAction(value: unknown): PendingAgentAction | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const originalPrompt = typeof value.originalPrompt === 'string' ? value.originalPrompt.trim() : '';
  if (!id || !originalPrompt) {
    return null;
  }

  return {
    id,
    threadId: typeof value.threadId === 'string' ? value.threadId : null,
    kind: typeof value.kind === 'string' ? value.kind : 'edit',
    originalPrompt,
    normalizedPrompt: typeof value.normalizedPrompt === 'string' ? value.normalizedPrompt : originalPrompt.toLowerCase(),
    riskLevel: typeof value.riskLevel === 'string' ? value.riskLevel : 'medium',
    reason: typeof value.reason === 'string' ? value.reason : 'pending_action',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    status: isPendingAgentActionStatus(value.status) ? value.status : 'pending',
  };
}

function isPendingAgentActionStatus(value: unknown): value is PendingAgentActionStatus {
  return value === 'pending' || value === 'approved' || value === 'running' || value === 'blocked' || value === 'skipped' || value === 'executed' || value === 'expired';
}

function isResumablePendingStatus(value: PendingAgentActionStatus) {
  return value === 'pending' || value === 'blocked';
}

function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
  return value === 'pending' || value === 'running' || value === 'completed' || value === 'blocked' || value === 'skipped';
}

function asAgentTaskList(value: unknown): AgentTaskList | null {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.id !== 'string') {
    return null;
  }

  const items = value.items
    .filter(isRecord)
    .map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : `task-${index + 1}`,
      title: typeof item.title === 'string' ? item.title : 'Run workspace task',
      status: isAgentTaskStatus(item.status) ? item.status : 'pending',
      kind: typeof item.kind === 'string' ? item.kind : 'aider_edit',
      targetPath: typeof item.targetPath === 'string' ? item.targetPath : undefined,
      result: typeof item.result === 'string' ? item.result : undefined,
      error: typeof item.error === 'string' ? item.error : undefined,
    }));

  if (items.length === 0) {
    return null;
  }

  return {
    id: value.id,
    actionId: typeof value.actionId === 'string' ? value.actionId : null,
    items,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

function taskListWithStatus(taskList: AgentTaskList, status: AgentTaskStatus): AgentTaskList {
  return {
    ...taskList,
    updatedAt: new Date().toISOString(),
    items: taskList.items.map((item) => ({
      ...item,
      status: item.status === 'completed' ? item.status : status,
    })),
  };
}

function getPendingActionStatusUpdates(messages: AgentThreadMessage[]) {
  const statuses = new Map<string, PendingAgentActionStatus>();
  for (const message of messages) {
    const statusRecord = isRecord(message.metadata?.pendingActionStatus) ? message.metadata.pendingActionStatus : null;
    const actionId = typeof statusRecord?.actionId === 'string' ? statusRecord.actionId : '';
    if (actionId && isPendingAgentActionStatus(statusRecord?.status)) {
      statuses.set(actionId, statusRecord.status);
    }
  }
  return statuses;
}

function getPendingActionStatus(action: PendingAgentAction, messages: AgentThreadMessage[]): PendingAgentActionStatus {
  return getPendingActionStatusUpdates(messages).get(action.id) ?? action.status;
}

function findLatestPendingAction(messages: AgentThreadMessage[]) {
  const statuses = getPendingActionStatusUpdates(messages);
  for (const message of [...messages].reverse()) {
    const action = asPendingAgentAction(message.metadata?.pendingAction);
    if (!action) {
      continue;
    }

    if (isResumablePendingStatus(statuses.get(action.id) ?? action.status)) {
      return action;
    }
  }

  return null;
}

function findLatestTaskList(messages: AgentThreadMessage[], actionId?: string | null) {
  for (const message of [...messages].reverse()) {
    const taskList = asAgentTaskList(message.metadata?.taskList);
    if (!taskList) {
      continue;
    }

    if (!actionId || taskList.actionId === actionId) {
      return taskList;
    }
  }

  return null;
}

function findPendingActionById(messages: AgentThreadMessage[], actionId: string) {
  const statuses = getPendingActionStatusUpdates(messages);
  for (const message of [...messages].reverse()) {
    const action = asPendingAgentAction(message.metadata?.pendingAction);
    if (action?.id === actionId) {
      return {
        ...action,
        status: statuses.get(action.id) ?? action.status,
      };
    }
  }

  return null;
}

function CustomDropdown({
  value,
  options,
  onChange,
  className = '',
  placement = 'bottom',
}: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (val: string) => void;
  className?: string;
  placement?: 'top' | 'bottom';
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const selectedOption = options.find((o) => o.value === value) || options[0];

  return (
    <div
      ref={containerRef}
      className={`custom-dropdown-container ${className}`}
      style={{ position: 'relative', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
      onClick={() => setIsOpen(!isOpen)}
    >
      <div className="custom-dropdown-trigger" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <span style={{ fontSize: '11px', color: 'inherit' }}>{selectedOption?.label}</span>
      </div>
      {isOpen && (
        <div
          className="custom-dropdown-menu"
          style={{
            position: 'absolute',
            ...(placement === 'top' ? { bottom: '100%', marginBottom: '6px' } : { top: '100%', marginTop: '6px' }),
            left: 0,
            background: '#1e2023',
            border: '1px solid #33363d',
            borderRadius: '4px',
            padding: '4px',
            zIndex: 100,
            minWidth: '110px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {options.map((opt) => (
            <div
              key={opt.value}
              className="custom-dropdown-item"
              style={{
                padding: '6px 8px',
                fontSize: '11px',
                borderRadius: '3px',
                color: opt.value === value ? '#ffffff' : '#cccccc',
                background: opt.value === value ? '#2d3139' : 'transparent',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                if (opt.value !== value) e.currentTarget.style.background = '#25282e';
              }}
              onMouseLeave={(e) => {
                if (opt.value !== value) e.currentTarget.style.background = 'transparent';
              }}
              onClick={(e) => {
                e.stopPropagation();
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentPanel({
  user,
  workspacePath,
  activeTab,
  pushConsole,
  pushToast,
  pendingReview = null,
  resolvingReview = false,
  reviewResolutionNotice = null,
  onAgentChangesPrepared,
  onPreviewAgentFile,
  onResolveAgentChanges,
  defaultView = 'chat',
  hideChat = false,
  chatOnly = false,
  onOpenSettings,
  onClosePanel,
}: AgentPanelProps) {
  const [view, setView] = useState<AgentView>(defaultView);
  const [threadSummaries, setThreadSummaries] = useState<AgentThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentThreadMessage[]>([]);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [settings, setSettings] = useState<AgentSettingsState>(() => createDefaultAgentSettings());
  const [isViewingHistory, setIsViewingHistory] = useState(activeThreadId === null);
  const [hideActiveTabContext, setHideActiveTabContext] = useState(false);
  const [composeTarget, setComposeTarget] = useState<AgentComposeTarget>('new');
  const [agentIntent, setAgentIntent] = useState<AgentIntent>('agent');
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [newSessionMenuOpen, setNewSessionMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [agentIntentMenuOpen, setAgentIntentMenuOpen] = useState(false);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);

  useEffect(() => {
    setHideActiveTabContext(false);
  }, [activeTab?.path]);

  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [unreadCompletedThreadIds, setUnreadCompletedThreadIds] = useState<Set<string>>(() => new Set());
  const [liveTaskLists, setLiveTaskLists] = useState<Map<string, AgentTaskList>>(() => new Map());
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(EMPTY_CREDENTIAL_FORM);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const reviewNoticeIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(activeThreadId);
  const isViewingHistoryRef = useRef(isViewingHistory);
  const deferredPrompt = useDeferredValue(draftPrompt);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    isViewingHistoryRef.current = isViewingHistory;
  }, [isViewingHistory]);

  useEffect(() => {
    const offProgress = window.tantalum.agent.onProgress((event: AgentProgressEvent) => {
      const taskList = asAgentTaskList(event.taskList);
      if (!taskList) {
        return;
      }

      setLiveTaskLists((current) => {
        const next = new Map(current);
        next.set(taskList.id, taskList);
        if (taskList.actionId) {
          next.set(`action:${taskList.actionId}`, taskList);
        }
        return next;
      });
    });

    return offProgress;
  }, []);
  const hasCloudAgent = hasAgentCloudConfiguration();
  const preferences = settings.preferences;
  const metadata = settings.managedModelMetadata;
  const enabledCustomCredentials = useMemo(
    () => settings.customCredentials.filter((credential) => credential.enabled),
    [settings.customCredentials],
  );
  const selectedCredential = useMemo(() => {
    if (!preferences.selectedCustomCredentialId) {
      return firstEnabledCredential(settings);
    }

    return settings.customCredentials.find((credential) => credential.id === preferences.selectedCustomCredentialId) ?? firstEnabledCredential(settings);
  }, [preferences.selectedCustomCredentialId, settings]);
  const selectedModel =
    preferences.selectedCustomModelName && selectedCredential?.modelNames.includes(preferences.selectedCustomModelName)
      ? preferences.selectedCustomModelName
      : selectedCredential?.modelNames[0] ?? null;
  const activeThread = useMemo(
    () => threadSummaries.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threadSummaries],
  );

  const canUseManaged = settings.managedAvailable && settings.creditAccount.remainingCredits > 0;
  const canUseCustom = Boolean(selectedCredential && selectedModel);
  const canSend =
    Boolean(workspacePath) &&
    hasCloudAgent &&
    !busy &&
    deferredPrompt.trim().length > 0 &&
    (preferences.selectedSource === 'managed' ? canUseManaged : canUseCustom);
  const isReplyingToThread = composeTarget === 'thread' && Boolean(activeThreadId);
  const activeThreadIsRunning = Boolean(activeThreadId && runningThreadId === activeThreadId);
  const isStoppingActiveThread = Boolean(activeThreadId && stoppingThreadId === activeThreadId);
  const agentIntentLabel = agentIntent === 'ask' ? 'Ask' : 'Agent';
  const agentIntentDescription = agentIntent === 'ask' ? 'Ask mode answers without changing files.' : 'Agent mode can apply workspace edits with revert available.';
  const threadSearchQuery = sessionSearchQuery.trim().toLowerCase();
  const visibleThreadSummaries = useMemo(
    () =>
      threadSummaries.filter((thread) => {
        if (!threadSearchQuery) {
          return true;
        }

        return [thread.title, thread.lastMessagePreview, thread.workspaceName]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(threadSearchQuery));
      }),
    [threadSearchQuery, threadSummaries],
  );

  const closeAgentMenus = useCallback(() => {
    setNewSessionMenuOpen(false);
    setMoreMenuOpen(false);
    setAgentIntentMenuOpen(false);
    setApprovalMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!newSessionMenuOpen && !moreMenuOpen && !agentIntentMenuOpen && !approvalMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.agent-menu-root')) {
        return;
      }
      closeAgentMenus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [agentIntentMenuOpen, approvalMenuOpen, closeAgentMenus, moreMenuOpen, newSessionMenuOpen]);

  const refreshThreads = useCallback(async () => {
    if (!hasCloudAgent) {
      setThreadSummaries([]);
      return;
    }

    setLoadingThreads(true);
    try {
      setThreadSummaries(await listAgentThreads(null));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to load Tantalum AI threads.', 'error');
    } finally {
      setLoadingThreads(false);
    }
  }, [hasCloudAgent, pushToast]);

  const refreshAgentSettings = useCallback(async (showErrors = true) => {
    if (!hasCloudAgent) {
      setSettings(createDefaultAgentSettings());
      setThreadSummaries([]);
      setLoadingSettings(false);
      return;
    }

    setLoadingSettings(true);
    try {
      const nextSettings = await loadAgentSettings();
      setSettings(nextSettings);
      setThreadSummaries(nextSettings.recentThreads);
      if (activeThreadId && !nextSettings.recentThreads.some((thread) => thread.id === activeThreadId)) {
        setActiveThreadId(null);
        setMessages([]);
        setComposeTarget('new');
        setIsViewingHistory(true);
      }
    } catch (error) {
      if (showErrors) {
        pushToast(error instanceof Error ? error.message : 'Unable to load agent settings.', 'error');
      }
    } finally {
      setLoadingSettings(false);
    }
  }, [activeThreadId, hasCloudAgent, pushToast]);

  async function persistPreferences(nextPreferences: AgentPreferences) {
    const sanitizedPreferences: AgentPreferences =
      nextPreferences.selectedSource === 'custom'
        ? nextPreferences
        : {
            ...nextPreferences,
            selectedCustomCredentialId: null,
            selectedCustomModelName: null,
          };

    setSettings((current) => ({ ...current, preferences: sanitizedPreferences }));

    if (!hasCloudAgent) {
      return;
    }

    try {
      const saved = await saveAgentPreferences(sanitizedPreferences);
      setSettings((current) => ({ ...current, preferences: saved }));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to save agent preferences.', 'error');
    }
  }

  function openAgentSettingsView() {
    closeAgentMenus();
    if (onOpenSettings) {
      onOpenSettings();
      return;
    }

    setView('settings');
  }

  function selectAgentIntent(nextIntent: AgentIntent) {
    setAgentIntent(nextIntent);
    setAgentIntentMenuOpen(false);
    setApprovalMenuOpen(false);
  }

  function handleAddContextClick() {
    if (!activeTab) {
      pushToast('Open a file to add it as agent context.', 'info');
      return;
    }

    setHideActiveTabContext(false);
    pushToast(`Included ${activeTab.name} as agent context.`, 'success');
  }

  async function openThread(threadId: string) {
    setActiveThreadId(threadId);
    setComposeTarget('thread');
    setIsViewingHistory(false);
    setUnreadCompletedThreadIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
    setView('chat');
    setLoadingMessages(true);

    try {
      setMessages(await loadAgentThreadMessages(threadId));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to load this thread.', 'error');
      setActiveThreadId(null);
      setComposeTarget('new');
      setMessages([]);
      setIsViewingHistory(true);
    } finally {
      setLoadingMessages(false);
    }
  }

  function startBlankThread() {
    setActiveThreadId(null);
    setComposeTarget('new');
    setMessages([]);
    setIsViewingHistory(false);
    setView('chat');
    closeAgentMenus();
  }

  async function appendAgentStatusMessage(
    threadId: string,
    content: string,
    tone: AgentThreadMessage['tone'] = 'default',
    metadata?: Record<string, unknown>,
  ) {
    try {
      const statusMessage = await createAgentThreadMessage({
        threadId,
        role: 'status',
        content,
        tone,
        metadata,
      });
      setMessages((current) => [...current, statusMessage]);
      return statusMessage;
    } catch {
      const localMessage = createLocalThreadMessage('status', content, tone, metadata);
      setMessages((current) => [...current, { ...localMessage, threadId }]);
      return localMessage;
    }
  }

  async function executeAgentRun({
    threadId,
    prompt,
    priorMessages,
    activeTabContext,
    approvedAction = null,
    taskList = null,
  }: {
    threadId: string;
    prompt: string;
    priorMessages: AgentThreadMessage[];
    activeTabContext: AgentRunPayload['activeTab'];
    approvedAction?: PendingAgentAction | null;
    taskList?: AgentTaskList | null;
  }) {
    let wasStopped = false;

    setBusy(true);
    setView('chat');
    setRunningThreadId(threadId);
    setStoppingThreadId(null);
    setUnreadCompletedThreadIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(threadId);
      return next;
    });

    try {
      if (approvedAction) {
        await appendAgentStatusMessage(threadId, 'Running approved action.', 'default', {
          pendingActionStatus: {
            actionId: approvedAction.id,
            status: 'running',
          },
          ...(taskList ? { taskList: taskListWithStatus(taskList, 'running') } : {}),
        });
      }

      const result = await window.tantalum.agent.run({
        prompt,
        source: preferences.selectedSource,
        mode: preferences.defaultMode,
        intent: agentIntent,
        threadId,
        customCredentialId: preferences.selectedSource === 'custom' ? selectedCredential?.id : null,
        customModelName: preferences.selectedSource === 'custom' ? selectedModel : null,
        fastContextWindow: metadata.fastContextWindow,
        planContextWindow: metadata.planContextWindow,
        threadMessages: toThreadContext(priorMessages),
        activeTab: activeTabContext,
        pendingAction: approvedAction,
        taskList,
        approvedActionId: approvedAction?.id ?? null,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      pushConsole(result.output, 'info');
      const resultTaskList = asAgentTaskList(result.taskList) ?? taskList;
      if (resultTaskList) {
        setLiveTaskLists((current) => {
          const next = new Map(current);
          next.set(resultTaskList.id, resultTaskList);
          if (resultTaskList.actionId) {
            next.set(`action:${resultTaskList.actionId}`, resultTaskList);
          }
          return next;
        });
      }
      const actionStatus = result.actionStatus ?? (approvedAction ? (Array.isArray(result.diff) && result.diff.length > 0 ? 'executed' : 'blocked') : undefined);

      const assistantMessage = await createAgentThreadMessage({
        threadId,
        role: 'assistant',
        content: clampAgentMessageContent(result.output),
        metadata: approvedAction
          ? {
              pendingActionStatus: {
                actionId: approvedAction.id,
                status: actionStatus,
              },
              ...(resultTaskList ? { taskList: resultTaskList } : {}),
            }
          : resultTaskList
            ? { taskList: resultTaskList }
          : undefined,
      });
      setMessages((current) => [...current, assistantMessage]);

      const skippedFiles = Array.isArray(result.skippedFiles) ? result.skippedFiles : [];
      if (skippedFiles.length > 0) {
        pushConsole(
          `Agent preparation skipped ${skippedFiles.length} non-reviewable workspace ${skippedFiles.length === 1 ? 'file' : 'files'}.`,
          'info',
        );
      }

      const reviewFiles = Array.isArray(result.diff) ? result.diff : [];
      if (reviewFiles.length > 0) {
        if (!onAgentChangesPrepared) {
          throw new Error('Live change controls are unavailable in this view.');
        }

        onAgentChangesPrepared({
          threadId,
          files: reviewFiles,
          output: result.output,
        });

        await appendAgentStatusMessage(
          threadId,
          `Applied ${reviewFiles.length} workspace ${reviewFiles.length === 1 ? 'change' : 'changes'}. Keep or revert them from the editor review bar.`,
          'warning',
          {
            action: 'aider_live_applied',
            fileCount: reviewFiles.length,
            ...(resultTaskList ? { taskList: resultTaskList } : {}),
          },
        );
      }

      await refreshAgentSettings(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The agent run failed.';
      wasStopped = message === 'Agent run stopped.';
      await appendAgentStatusMessage(threadId, message, wasStopped ? 'warning' : 'error', approvedAction
        ? {
            pendingActionStatus: {
              actionId: approvedAction.id,
              status: 'blocked',
            },
            ...(taskList ? { taskList: taskListWithStatus(taskList, 'blocked') } : {}),
          }
        : undefined);
      if (!wasStopped) {
        pushToast(message, 'error');
      }
    } finally {
      setBusy(false);
      setRunningThreadId((current) => (current === threadId ? null : current));
      setStoppingThreadId((current) => (current === threadId ? null : current));
      if (!wasStopped && (activeThreadIdRef.current !== threadId || isViewingHistoryRef.current)) {
        setUnreadCompletedThreadIds((current) => {
          if (current.has(threadId)) {
            return current;
          }

          const next = new Set(current);
          next.add(threadId);
          return next;
        });
      }
      await refreshThreads();
    }
  }

  async function handleSendPrompt() {
    const prompt = draftPrompt.trim();
    if (!prompt) {
      return;
    }

    if (!workspacePath) {
      pushToast('Open a workspace before starting Tantalum AI.', 'info');
      return;
    }

    if (preferences.selectedSource === 'custom' && (!selectedCredential || !selectedModel)) {
      pushToast('Choose an enabled custom credential and model first.', 'info');
      openAgentSettingsView();
      return;
    }

    let threadId = isReplyingToThread ? activeThreadId : null;
    const priorMessages = isReplyingToThread ? messages : [];
    const latestPendingAction = findLatestPendingAction(priorMessages);
    const latestTaskList = latestPendingAction
      ? liveTaskLists.get(`action:${latestPendingAction.id}`) ?? findLatestTaskList(priorMessages, latestPendingAction.id)
      : findLatestTaskList(priorMessages);
    const activeTabContext = hideActiveTabContext ? null : activeTab;
    const baseRunPayload: AgentRunPayload = {
      prompt,
      source: preferences.selectedSource,
      mode: preferences.defaultMode,
      intent: agentIntent,
      threadId,
      customCredentialId: preferences.selectedSource === 'custom' ? selectedCredential?.id : null,
      customModelName: preferences.selectedSource === 'custom' ? selectedModel : null,
      fastContextWindow: metadata.fastContextWindow,
      planContextWindow: metadata.planContextWindow,
      threadMessages: toThreadContext(priorMessages),
      activeTab: activeTabContext,
      pendingAction: latestPendingAction,
      taskList: latestTaskList,
    };

    setDraftPrompt('');
    setBusy(true);

    try {
      const routed = await window.tantalum.agent.route(baseRunPayload);
      if (!routed.success) {
        throw new Error(routed.error);
      }

      if (!routed.persistThread) {
        if (threadId) {
          const userMessage = await createAgentThreadMessage({ threadId, role: 'user', content: prompt });
          const assistantMessage = await createAgentThreadMessage({
            threadId,
            role: 'assistant',
            content: routed.userMessage || 'Tell me what you want to inspect, explain, or change.',
          });
          setMessages([...priorMessages, userMessage, assistantMessage]);
          setView('chat');
          await refreshThreads();
        } else {
          setActiveThreadId(null);
          setComposeTarget('new');
          setIsViewingHistory(false);
          setMessages([
            createLocalThreadMessage('user', prompt),
            createLocalThreadMessage('assistant', routed.userMessage || 'Tell me what you want to inspect, explain, or change.'),
          ]);
        }
        return;
      }

      if (!threadId) {
        const createdThread = await createAgentThread({
          title: routed.titleSuggestion || titleFromPrompt(prompt),
          workspaceKey: workspacePath,
          workspaceName: basenameFromPath(workspacePath),
        });
        threadId = createdThread.id;
        setActiveThreadId(threadId);
        setComposeTarget('thread');
        setThreadSummaries((current) => [createdThread, ...current.filter((thread) => thread.id !== createdThread.id)]);
        setMessages([]);
        setIsViewingHistory(false);
      }

      const runThreadId = threadId;
      if (!runThreadId) {
        throw new Error('Unable to attach this agent run to a thread.');
      }

      const userMessage = await createAgentThreadMessage({ threadId: runThreadId, role: 'user', content: prompt });
      setMessages([...priorMessages, userMessage]);
      setView('chat');
      const routedTaskList = asAgentTaskList(routed.taskList);

      if (routed.decisionKind === 'clarify') {
        const assistantMessage = await createAgentThreadMessage({
          threadId: runThreadId,
          role: 'assistant',
          content: routed.userMessage || 'I need a clearer target before changing the workspace.',
          tone: 'warning',
          metadata: routedTaskList ? { taskList: routedTaskList } : undefined,
        });
        setMessages((current) => [...current, assistantMessage]);
        await refreshThreads();
        return;
      }

      if (routed.requiresUserDecision && routed.pendingAction) {
        const pendingAction: PendingAgentAction = {
          ...routed.pendingAction,
          threadId: runThreadId,
          status: 'pending',
        };
        const pendingTaskList = routedTaskList ? { ...routedTaskList, actionId: pendingAction.id } : null;
        const assistantMessage = await createAgentThreadMessage({
          threadId: runThreadId,
          role: 'assistant',
          content: routed.userMessage || 'Approve this workspace action to run it, or skip it.',
          metadata: {
            pendingAction,
            ...(pendingTaskList ? { taskList: pendingTaskList } : {}),
          },
        });
        setMessages((current) => [...current, assistantMessage]);
        pushConsole('Waiting for approval before running workspace changes.', 'info');
        await refreshThreads();
        return;
      }

      const approvedAction = routed.reason === 'approved_pending_action'
        ? asPendingAgentAction(routed.pendingAction) ?? latestPendingAction
        : null;
      const runTaskList = approvedAction
        ? routedTaskList ?? latestTaskList
        : routedTaskList;
      let runPriorMessages = [...priorMessages, userMessage];

      if (!approvedAction && runTaskList) {
        const taskMessage = await createAgentThreadMessage({
          threadId: runThreadId,
          role: 'assistant',
          content: 'I will work through this todo list and update it as tasks finish.',
          metadata: {
            taskList: runTaskList,
          },
        });
        setMessages((current) => [...current, taskMessage]);
        runPriorMessages = [...runPriorMessages, taskMessage];
      }

      await executeAgentRun({
        threadId: runThreadId,
        prompt: approvedAction?.originalPrompt ?? prompt,
        priorMessages: runPriorMessages,
        activeTabContext,
        approvedAction,
        taskList: runTaskList,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The agent run failed.';
      if (threadId) {
        try {
          const errorMessage = await createAgentThreadMessage({
            threadId,
            role: 'status',
            content: message,
            tone: 'error',
          });
          setMessages((current) => [...current, errorMessage]);
        } catch {
          pushToast(message, 'error');
        }
      } else {
        pushToast(message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleStopRunningThread() {
    if (!activeThreadId || runningThreadId !== activeThreadId || stoppingThreadId === activeThreadId) {
      return;
    }

    setStoppingThreadId(activeThreadId);
    try {
      const result = await window.tantalum.agent.stop({ threadId: activeThreadId });
      if (!result.success) {
        throw new Error(result.error);
      }

      if (!result.stopped) {
        setStoppingThreadId(null);
      }
    } catch (error) {
      setStoppingThreadId(null);
      pushToast(error instanceof Error ? error.message : 'Unable to stop the agent run.', 'error');
    }
  }

  async function approvePendingAgentAction(actionId: string) {
    if (busy || activeThreadIsRunning) {
      return;
    }

    if (agentIntent === 'ask') {
      pushToast('Switch to Agent mode to approve workspace changes.', 'info');
      return;
    }

    if (!workspacePath) {
      pushToast('Open a workspace before running this action.', 'info');
      return;
    }

    if (preferences.selectedSource === 'custom' && (!selectedCredential || !selectedModel)) {
      pushToast('Choose an enabled custom credential and model first.', 'info');
      openAgentSettingsView();
      return;
    }

    const action = findPendingActionById(messages, actionId);
    if (!action || !isResumablePendingStatus(action.status)) {
      pushToast('That pending action is no longer available.', 'info');
      return;
    }

    const threadId = action.threadId || activeThreadId;
    if (!threadId) {
      pushToast('Unable to attach this pending action to a thread.', 'error');
      return;
    }

    const taskList = liveTaskLists.get(`action:${action.id}`) ?? findLatestTaskList(messages, action.id);
    await executeAgentRun({
      threadId,
      prompt: action.originalPrompt,
      priorMessages: messages,
      activeTabContext: hideActiveTabContext ? null : activeTab,
      approvedAction: action,
      taskList,
    });
  }

  async function skipPendingAgentAction(actionId: string) {
    if (busy || activeThreadIsRunning) {
      return;
    }

    const action = findPendingActionById(messages, actionId);
    if (!action || !isResumablePendingStatus(action.status)) {
      pushToast('That pending action is no longer available.', 'info');
      return;
    }

    const threadId = action.threadId || activeThreadId;
    if (!threadId) {
      pushToast('Unable to update this pending action.', 'error');
      return;
    }

    const taskList = liveTaskLists.get(`action:${action.id}`) ?? findLatestTaskList(messages, action.id);
    await appendAgentStatusMessage(threadId, 'Skipped pending action.', 'warning', {
      pendingActionStatus: {
        actionId,
        status: 'skipped',
      },
      ...(taskList ? { taskList: taskListWithStatus(taskList, 'skipped') } : {}),
    });
    await refreshThreads();
  }

  async function handleRenameThread(thread: AgentThreadSummary) {
    const title = window.prompt('Thread title', thread.title)?.trim();
    if (!title || title === thread.title) {
      return;
    }

    try {
      const updated = await renameAgentThread(thread.id, title);
      setThreadSummaries((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to rename thread.', 'error');
    }
  }

  async function handleDeleteThread(thread: AgentThreadSummary) {
    if (!window.confirm(`Delete "${thread.title}"?`)) {
      return;
    }

    try {
      await deleteAgentThread(thread.id);
      setThreadSummaries((current) => current.filter((entry) => entry.id !== thread.id));
      setUnreadCompletedThreadIds((current) => {
        if (!current.has(thread.id)) {
          return current;
        }

        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
      if (activeThreadId === thread.id) {
        startBlankThread();
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to delete thread.', 'error');
    }
  }

  function startEditingCredential(credential: AgentCustomCredential) {
    setCredentialForm({
      credentialId: credential.id,
      displayName: credential.displayName,
      baseUrl: credential.baseUrl,
      apiKey: '',
      modelNames: credential.modelNames.join('\n'),
      enabled: credential.enabled,
    });
  }

  async function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const modelNames = normalizeModelList(credentialForm.modelNames);
    const input: AgentCredentialInput = {
      displayName: credentialForm.displayName.trim(),
      baseUrl: credentialForm.baseUrl.trim(),
      apiKey: credentialForm.apiKey.trim(),
      modelNames,
      enabled: credentialForm.enabled,
    };

    setSavingSettings(true);
    try {
      if (credentialForm.credentialId) {
        const updateInput = {
          credentialId: credentialForm.credentialId,
          displayName: input.displayName,
          baseUrl: input.baseUrl,
          modelNames: input.modelNames,
          enabled: input.enabled,
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        };
        await updateCustomCredential(updateInput);
        pushToast('Custom credential updated.', 'success');
      } else {
        await createCustomCredential(input);
        pushToast('Custom credential added.', 'success');
      }

      setCredentialForm(EMPTY_CREDENTIAL_FORM);
      await refreshAgentSettings(false);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to save custom credential.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleToggleCredential(credential: AgentCustomCredential) {
    setSavingSettings(true);
    try {
      await updateCustomCredential({ credentialId: credential.id, enabled: !credential.enabled });
      await refreshAgentSettings(false);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to update credential.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleDeleteCredential(credential: AgentCustomCredential) {
    setSavingSettings(true);
    try {
      await deleteCustomCredential(credential.id);
      if (preferences.selectedCustomCredentialId === credential.id) {
        await persistPreferences({
          ...preferences,
          selectedCustomCredentialId: null,
          selectedCustomModelName: null,
          selectedSource: 'managed',
        });
      }
      await refreshAgentSettings(false);
      pushToast('Custom credential deleted.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to delete credential.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestCredential(credential: AgentCustomCredential) {
    setSavingSettings(true);
    try {
      await testCustomCredential(credential.id);
      pushToast('Provider accepted the custom credential.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Credential test failed.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  useEffect(() => {
    void refreshAgentSettings();
  }, [refreshAgentSettings, user.$id]);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages, runningThreadId]);

  useEffect(() => {
    if (!reviewResolutionNotice || reviewNoticeIdRef.current === reviewResolutionNotice.id) {
      return;
    }

    reviewNoticeIdRef.current = reviewResolutionNotice.id;
    if (reviewResolutionNotice.threadId !== activeThreadId) {
      void refreshThreads();
      return;
    }

    setMessages((current) => [
      ...current,
      {
        id: reviewResolutionNotice.id,
        threadId: reviewResolutionNotice.threadId,
        role: 'status',
        content: reviewResolutionNotice.content,
        tone: reviewResolutionNotice.tone,
        createdAt: reviewResolutionNotice.createdAt,
      },
    ]);
    void refreshThreads();
  }, [activeThreadId, refreshThreads, reviewResolutionNotice]);

  async function resolveAgentReviewFromChat(approved: boolean) {
    if (!onResolveAgentChanges) {
      return;
    }

    try {
      await onResolveAgentChanges(approved);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to resolve agent changes.', 'error');
    }
  }

  function renderHeader() {
    return (
      <div className="copilot-header">
        <div className="copilot-header-title">
          {!isViewingHistory && activeThreadId && (
            <button
              className="ghost-button compact icon-only copilot-back-btn"
              type="button"
              title="View Sessions"
              onClick={() => setIsViewingHistory(true)}
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <span className="copilot-tab-title">CHAT</span>
        </div>
        <div className="copilot-header-actions">
          <div className="agent-menu-root">
            <button
              className="ghost-button compact icon-only copilot-plus-dropdown-btn"
              type="button"
              title="New Session"
              aria-haspopup="menu"
              aria-expanded={newSessionMenuOpen}
              onClick={() => setNewSessionMenuOpen((current) => !current)}
            >
              <Plus size={16} />
              <ChevronDown size={10} style={{ marginLeft: '1px' }} />
            </button>
            {newSessionMenuOpen ? (
              <div className="agent-popup-menu agent-popup-menu-right" role="menu">
                <button type="button" role="menuitem" onClick={startBlankThread}>
                  <Plus size={13} />
                  <span>New session</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsViewingHistory(true);
                    setView('chat');
                    setNewSessionMenuOpen(false);
                  }}
                >
                  <History size={13} />
                  <span>Sessions</span>
                </button>
              </div>
            ) : null}
          </div>
          <button className="ghost-button compact icon-only" type="button" title="Agent Settings" onClick={openAgentSettingsView}>
            <Settings size={16} />
          </button>
          <div className="agent-menu-root">
            <button
              className="ghost-button compact icon-only"
              type="button"
              title="More Actions"
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              onClick={() => setMoreMenuOpen((current) => !current)}
            >
              <MoreHorizontal size={16} />
            </button>
            {moreMenuOpen ? (
              <div className="agent-popup-menu agent-popup-menu-right" role="menu">
                <button type="button" role="menuitem" onClick={() => void refreshThreads()}>
                  <RefreshCw size={13} />
                  <span>Refresh sessions</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setView('usage');
                    closeAgentMenus();
                  }}
                >
                  <Bot size={13} />
                  <span>Usage</span>
                </button>
                <button type="button" role="menuitem" onClick={openAgentSettingsView}>
                  <Settings2 size={13} />
                  <span>Agent settings</span>
                </button>
              </div>
            ) : null}
          </div>
          <span className="copilot-header-divider"></span>
          {onClosePanel ? (
            <button className="ghost-button compact icon-only" type="button" title="Close Panel" onClick={onClosePanel}>
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  function renderTabs() {
    if (chatOnly) {
      return null;
    }

    return (
      <div className="agent-tabs copilot-tabs">
        {!hideChat ? (
          <button className={view === 'chat' ? 'active' : ''} type="button" onClick={() => setView('chat')}>
            <MessageSquare size={14} />
            Chat
          </button>
        ) : null}
        <button className={view === 'settings' ? 'active' : ''} type="button" onClick={() => setView('settings')}>
          <Settings2 size={14} />
          Settings
        </button>
        <button className={view === 'usage' ? 'active' : ''} type="button" onClick={() => setView('usage')}>
          <Bot size={14} />
          Usage
        </button>
      </div>
    );
  }

  function renderBottomStatusBar() {
    const remainingCredits = settings.creditAccount.remainingCredits;
    const monthlyAllowance = settings.creditAccount.monthlyAllowance;
    const creditPercent = monthlyAllowance > 0 ? Math.max(0, Math.min(100, (remainingCredits / monthlyAllowance) * 100)) : 100;
    const radius = 5.5;
    const strokeWidth = 1.6;
    const circ = 2 * Math.PI * radius; // ~34.55
    const strokeDashoffset = circ - (creditPercent / 100) * circ;

    return (
      <div className="copilot-bottom-status-bar">
        <div className="status-bar-left">
          <div className="status-item-dropdown copilot-status-mode-wrapper" title="Agent Mode">
            <Sparkles size={12} />
            <CustomDropdown
              className="status-mode-dropdown"
              value={preferences.defaultMode}
              options={[
                { label: 'Fast', value: 'fast' },
                { label: 'Plan', value: 'plan' }
              ]}
              placement="top"
              onChange={(val) => {
                void persistPreferences({
                  ...preferences,
                  defaultMode: val as 'fast' | 'plan'
                });
              }}
            />
            <ChevronDown size={8} style={{ marginLeft: '-4px' }} />
          </div>
          <div className="agent-menu-root">
            <button
              className="status-item-dropdown agent-status-menu-button"
              type="button"
              title="Agent behavior"
              aria-haspopup="menu"
              aria-expanded={approvalMenuOpen}
              onClick={() => setApprovalMenuOpen((current) => !current)}
            >
              <Shield size={12} />
              <span>{agentIntent === 'ask' ? 'Ask Only' : 'Live Changes'}</span>
              <ChevronDown size={8} />
            </button>
            {approvalMenuOpen ? (
              <div className="agent-popup-menu agent-popup-menu-left agent-popup-menu-up" role="menu">
                <button className={agentIntent === 'agent' ? 'active' : ''} type="button" role="menuitem" onClick={() => selectAgentIntent('agent')}>
                  <Code size={13} />
                  <span>Agent mode</span>
                </button>
                <button className={agentIntent === 'ask' ? 'active' : ''} type="button" role="menuitem" onClick={() => selectAgentIntent('ask')}>
                  <MessageSquare size={13} />
                  <span>Ask mode</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="status-bar-right">
          <div
            className="copilot-credit-badge"
            title={`Remaining credits: ${formatCredits(remainingCredits)} / ${formatCredits(monthlyAllowance)} (${creditPercent.toFixed(0)}% left)`}
          >
            <svg className="copilot-svg-loader" width="14" height="14" viewBox="0 0 14 14">
              <circle
                className="bg-ring"
                cx="7"
                cy="7"
                r={radius}
                stroke="var(--line)"
                strokeWidth={strokeWidth}
                fill="none"
              />
              <circle
                className="fg-ring"
                cx="7"
                cy="7"
                r={radius}
                stroke={creditPercent > 20 ? "var(--accent)" : "var(--error, #e51c23)"}
                strokeWidth={strokeWidth}
                fill="none"
                strokeDasharray={circ}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(-90 7 7)"
              />
            </svg>
            <span className="credits-amount">{formatCredits(remainingCredits)}</span>
          </div>
        </div>
      </div>
    );
  }

  function renderComposer() {
    return (
      <div className="copilot-composer-container">
        {activeTab && !hideActiveTabContext && (
          <div className="copilot-composer-chip">
            <span className="chip-plus-accent">+</span>
            <FileText size={12} className="chip-icon text-green" />
            <span className="chip-filename">{activeTab.name}</span>
            <button
              className="chip-close-btn"
              type="button"
              onClick={() => setHideActiveTabContext(true)}
              title="Exclude file context"
            >
              <X size={10} />
            </button>
          </div>
        )}

        <textarea
          className="copilot-composer-textarea"
          value={draftPrompt}
          disabled={!workspacePath || busy}
          onChange={(event) => setDraftPrompt(event.target.value)}
          placeholder={
            workspacePath
              ? isReplyingToThread && activeThread
                ? `Reply to ${activeThread.title}`
                : agentIntent === 'ask'
                  ? 'Ask about this workspace'
                  : 'Start a new agent session'
              : 'Open a workspace to start coding'
          }
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) {
                void handleSendPrompt();
              }
            }
          }}
        />

        <div className="copilot-composer-bottom">
          <div className="bottom-left-actions">
            <button className="composer-action-btn" type="button" title="Add Context" onClick={handleAddContextClick}>
              <Plus size={12} />
            </button>
            <div className="agent-menu-root composer-participant-menu">
              <button
                className={`composer-participant-pill composer-participant-button ${agentIntent === 'ask' ? 'active' : ''}`}
                type="button"
                title={agentIntentDescription}
                aria-haspopup="menu"
                aria-expanded={agentIntentMenuOpen}
                onClick={() => setAgentIntentMenuOpen((current) => !current)}
              >
                {agentIntent === 'ask' ? <MessageSquare size={10} /> : <Code size={10} />}
                <span>{agentIntentLabel}</span>
                <ChevronDown size={9} />
              </button>
              {agentIntentMenuOpen ? (
                <div className="agent-popup-menu agent-popup-menu-left agent-popup-menu-up" role="menu">
                  <button className={agentIntent === 'agent' ? 'active' : ''} type="button" role="menuitem" onClick={() => selectAgentIntent('agent')}>
                    <Code size={13} />
                    <span>Agent mode</span>
                  </button>
                  <button className={agentIntent === 'ask' ? 'active' : ''} type="button" role="menuitem" onClick={() => selectAgentIntent('ask')}>
                    <MessageSquare size={13} />
                    <span>Ask mode</span>
                  </button>
                </div>
              ) : null}
            </div>
            <span className="composer-action-divider">|</span>
            <button className="composer-action-btn" type="button" title="Model configuration details" onClick={openAgentSettingsView}>
              <Sliders size={12} />
            </button>
          </div>

          <div className="bottom-right-actions">
            <button
              className={`copilot-send-btn ${activeThreadIsRunning ? 'copilot-stop-btn' : ''}`}
              type="button"
              title={activeThreadIsRunning ? 'Stop agent run' : 'Send message'}
              disabled={activeThreadIsRunning ? isStoppingActiveThread : !canSend}
              onClick={() => {
                if (activeThreadIsRunning) {
                  void handleStopRunningThread();
                  return;
                }

                void handleSendPrompt();
              }}
            >
              {activeThreadIsRunning ? (
                isStoppingActiveThread ? <LoaderCircle size={12} className="spin" /> : <SquareStop size={14} />
              ) : busy ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <SendHorizontal size={14} />
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderThreadList() {
    return (
      <div className="copilot-sessions-view">
        <div className="copilot-sessions-toolbar">
          <span className="sessions-title">SESSIONS</span>
          <div className="sessions-toolbar-buttons">
            <button className="ghost-button compact icon-only" type="button" title="Refresh" onClick={() => void refreshThreads()}>
              <RefreshCw size={14} />
            </button>
            <button
              className={`ghost-button compact icon-only ${sessionSearchOpen ? 'active' : ''}`}
              type="button"
              title="Search Sessions"
              aria-pressed={sessionSearchOpen}
              onClick={() => setSessionSearchOpen((current) => !current)}
            >
              <Search size={14} />
            </button>
          </div>
        </div>

        {sessionSearchOpen ? (
          <div className="copilot-session-search">
            <Search size={13} />
            <input
              value={sessionSearchQuery}
              onChange={(event) => setSessionSearchQuery(event.target.value)}
              placeholder="Search sessions"
              autoFocus
            />
            {sessionSearchQuery ? (
              <button type="button" title="Clear search" onClick={() => setSessionSearchQuery('')}>
                <X size={12} />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="copilot-threads-container">
          {loadingThreads ? (
            <div className="agent-empty-state">
              <LoaderCircle size={16} className="spin" />
              <span>Loading sessions...</span>
            </div>
          ) : null}

          {!loadingThreads && threadSummaries.length === 0 ? (
            <div className="agent-empty-state tantalum-empty-state">
              <MessageSquare size={16} />
              <span>No active sessions.</span>
            </div>
          ) : null}

          {!loadingThreads && threadSummaries.length > 0 && visibleThreadSummaries.length === 0 ? (
            <div className="agent-empty-state tantalum-empty-state">
              <Search size={16} />
              <span>No matching sessions.</span>
            </div>
          ) : null}

          {visibleThreadSummaries.map((thread) => {
            const isRunning = thread.id === runningThreadId;
            const hasUnreadCompletion = unreadCompletedThreadIds.has(thread.id);
            return (
              <article
                key={thread.id}
                className={`copilot-thread-item ${isRunning ? 'running' : ''} ${hasUnreadCompletion ? 'unread-complete' : ''}`}
              >
                <button type="button" className="copilot-thread-main-btn" onClick={() => void openThread(thread.id)}>
                  <div className="copilot-thread-bullet-row">
                    {isRunning ? (
                      <span className="copilot-thread-activity" title="Agent is running" aria-label="Agent is running">
                        <span />
                        <span />
                        <span />
                      </span>
                    ) : hasUnreadCompletion ? (
                      <span className="copilot-thread-complete-dot" title="New agent response" aria-label="New agent response" />
                    ) : null}
                    <span className="copilot-thread-title-text">{thread.title}</span>
                  </div>
                  <span className="copilot-thread-time-sub">
                    {formatRelativeTime(thread.lastMessageAt)}
                  </span>
                </button>
                <div className="copilot-thread-item-actions">
                  <button type="button" title="Rename" onClick={() => void handleRenameThread(thread)}>
                    <PencilLine size={14} />
                  </button>
                  <button type="button" title="Delete" onClick={() => void handleDeleteThread(thread)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  function renderPendingActionCard(message: AgentThreadMessage) {
    const action = asPendingAgentAction(message.metadata?.pendingAction);
    if (!action) {
      return null;
    }

    const latestPendingAction = findLatestPendingAction(messages);
    const actionStatus = getPendingActionStatus(action, messages);
    const effectiveStatus: PendingAgentActionStatus =
      actionStatus === 'pending' && latestPendingAction && latestPendingAction.id !== action.id ? 'expired' : actionStatus;
    const taskList = liveTaskLists.get(`action:${action.id}`) ?? asAgentTaskList(message.metadata?.taskList) ?? findLatestTaskList(messages, action.id);
    const isWaiting = effectiveStatus === 'pending' || effectiveStatus === 'blocked';
    const statusLabel =
      effectiveStatus === 'pending'
        ? 'Waiting for approval'
        : effectiveStatus === 'running' || effectiveStatus === 'approved'
          ? 'Running'
          : effectiveStatus === 'blocked'
            ? 'Blocked'
          : effectiveStatus === 'executed'
            ? 'Applied changes'
            : effectiveStatus === 'skipped'
              ? 'Skipped'
              : 'Unavailable';
    const buttonsDisabled = !isWaiting || busy || activeThreadIsRunning;

    return (
      <div className={`pending-agent-action-card pending-agent-action-card-${effectiveStatus}`}>
        <div className="pending-agent-action-head">
          <div>
            <p className="eyebrow">{statusLabel}</p>
            <h4>{action.riskLevel === 'high' ? 'Workspace change needs approval' : 'Confirm workspace change'}</h4>
          </div>
          <Shield size={15} />
        </div>
        <pre>{action.originalPrompt}</pre>
        {taskList ? (
          <div className="pending-agent-task-list" aria-label="Agent todo list">
            {taskList.items.map((item) => (
              <div key={item.id} className={`pending-agent-task pending-agent-task-${item.status}`}>
                <span className="pending-agent-task-status">{item.status}</span>
                <span className="pending-agent-task-title">{item.title}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="action-row">
          <button
            className="danger-button compact"
            type="button"
            disabled={buttonsDisabled}
            onClick={() => void skipPendingAgentAction(action.id)}
          >
            <X size={14} />
            Skip
          </button>
          <button
            className="primary-button compact"
            type="button"
            disabled={buttonsDisabled}
            onClick={() => void approvePendingAgentAction(action.id)}
          >
            <Play size={14} />
            {effectiveStatus === 'blocked' ? 'Retry' : 'Approve'}
          </button>
        </div>
      </div>
    );
  }

  function renderTaskListCard(message: AgentThreadMessage) {
    const baseTaskList = asAgentTaskList(message.metadata?.taskList);
    if (!baseTaskList || message.metadata?.pendingAction) {
      return null;
    }

    const taskList = liveTaskLists.get(baseTaskList.id) ?? (baseTaskList.actionId ? liveTaskLists.get(`action:${baseTaskList.actionId}`) : null) ?? baseTaskList;

    return (
      <div className="pending-agent-action-card pending-agent-action-card-tasks">
        <div className="pending-agent-action-head">
          <div>
            <p className="eyebrow">Todo list</p>
            <h4>Workspace tasks</h4>
          </div>
          <FileText size={15} />
        </div>
        <div className="pending-agent-task-list" aria-label="Agent todo list">
          {taskList.items.map((item) => (
            <div key={item.id} className={`pending-agent-task pending-agent-task-${item.status}`}>
              <span className="pending-agent-task-status">{item.status}</span>
              <span className="pending-agent-task-title">{item.title}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderPendingReviewCard() {
    if (!pendingReview) {
      return null;
    }

    return (
      <article className="agent-approval-card tantalum-approval-card copilot-approval-card">
        <div className="agent-approval-head">
          <div>
            <p className="eyebrow">Live changes</p>
            <h3>{pendingReview.files.length} applied workspace {pendingReview.files.length === 1 ? 'change' : 'changes'}</h3>
          </div>
          {resolvingReview ? <LoaderCircle size={16} className="spin" /> : null}
        </div>
        <div className="agent-change-list">
          {pendingReview.files.map((file) => (
            <button key={file.path} type="button" onClick={() => onPreviewAgentFile?.(file.path)}>
              <span>{file.changeType}</span>
              <code>{file.path}</code>
            </button>
          ))}
        </div>
        <div className="action-row">
          <button className="danger-button compact" type="button" disabled={resolvingReview} onClick={() => void resolveAgentReviewFromChat(false)}>
            <X size={14} />
            Revert
          </button>
          <button className="primary-button compact" type="button" disabled={resolvingReview} onClick={() => void resolveAgentReviewFromChat(true)}>
            <Save size={14} />
            Keep
          </button>
        </div>
      </article>
    );
  }

  function renderThinkingIndicator() {
    if (!activeThreadIsRunning) {
      return null;
    }

    return (
      <article className="agent-message agent-message-assistant copilot-chat-bubble copilot-thinking-message">
        <div className="agent-message-meta copilot-bubble-meta">
          <span className="author-tag">
            <Sparkles size={11} className="sparkle-icon" />
            Tantalum AI
          </span>
        </div>
        <div className="agent-message-body copilot-bubble-content agent-thinking-body" aria-live="polite">
          <span>Thinking</span>
          <span className="agent-thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      </article>
    );
  }

  function renderConversation() {
    if (messages.length === 0) {
      return (
        <div className="copilot-welcome-screen">
          <div className="copilot-welcome-logo">
            <Sparkles size={32} className="text-accent" />
          </div>
          <h3>Tantalum AI</h3>
          <p className="welcome-desc">
            Your AI-powered coding assistant, connected to your workspace files and runtime.
          </p>
          <div className="welcome-shortcuts">
            <div className="shortcut-card" onClick={startBlankThread}>
              <Plus size={14} />
              <span>Start a blank session</span>
            </div>
            <div className="shortcut-card" onClick={openAgentSettingsView}>
              <Settings2 size={14} />
              <span>Configure custom APIs</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="copilot-conversation-container">
        <div className="copilot-conversation-header">
          <div className="header-meta">
            <span className="session-indicator-pill">ACTIVE SESSION</span>
            <h3>{activeThread?.title ?? 'Active thread'}</h3>
          </div>
          <button className="ghost-button compact" type="button" onClick={() => setIsViewingHistory(true)}>
            <History size={13} style={{ marginRight: '4px' }} />
            History
          </button>
        </div>

        <div ref={messageListRef} className="agent-message-list tantalum-message-list copilot-message-list">
          {loadingMessages ? (
            <div className="agent-empty-state">
              <LoaderCircle size={18} className="spin" />
              <span>Loading messages...</span>
            </div>
          ) : null}

          {messages.map((message) => (
            <article key={message.id} className={`agent-message agent-message-${message.role} ${message.tone ? `agent-message-${message.tone}` : ''} copilot-chat-bubble`}>
              <div className="agent-message-meta copilot-bubble-meta">
                <span className="author-tag">
                  {message.role === 'assistant' ? (
                    <>
                      <Sparkles size={11} className="sparkle-icon" />
                      Tantalum AI
                    </>
                  ) : message.role === 'user' ? (
                    'You'
                  ) : (
                    'Status'
                  )}
                </span>
                {message.createdAt ? <span className="time-tag">{formatDate(message.createdAt)}</span> : null}
              </div>
              <div className="agent-message-body copilot-bubble-content">
                {message.role === 'assistant' ? (
                  <>
                    <MarkdownRenderer content={message.content} />
                    {renderPendingActionCard(message)}
                    {renderTaskListCard(message)}
                  </>
                ) : message.role === 'user' ? (
                  <pre>{message.content}</pre>
                ) : (
                  <div className="status-alert-body">{message.content}</div>
                )}
              </div>
            </article>
          ))}
          {renderThinkingIndicator()}
          {renderPendingReviewCard()}
        </div>
      </div>
    );
  }

  function renderChatView() {
    if (hideChat) {
      return null;
    }

    return (
      <div className="copilot-chat-layout">
        {!hasCloudAgent ? (
          <div className="inline-banner inline-banner-warning agent-inline-banner">
            Push the Tantalum AI Appwrite tables and functions before using managed models, custom credentials, or synced threads.
          </div>
        ) : null}

        {preferences.selectedSource === 'managed' && !canUseManaged ? (
          <div className="inline-banner inline-banner-warning agent-inline-banner">
            Managed agent access is unavailable until a pool key is assigned and credits remain.
          </div>
        ) : null}

        <div className="copilot-chat-content">
          {isViewingHistory ? renderThreadList() : renderConversation()}
        </div>

        {renderComposer()}
        {renderBottomStatusBar()}
      </div>
    );
  }

  function renderSettingsView() {
    return (
      <div className="agent-settings-view copilot-settings-layout">
        {/* Relocated Core Configuration Card */}
        <div className="copilot-settings-card core-config-card">
          <div className="card-header">
            <Sliders size={14} className="text-accent" />
            <h3>Agent Configuration</h3>
          </div>
          <div className="card-body">
            <div className="settings-field">
              <label className="field-label">Model Source</label>
              <div className="segmented-control font-sans" style={{ display: 'inline-flex', width: 'auto', marginBottom: '8px' }}>
                <button
                  className={preferences.selectedSource === 'managed' ? 'active' : ''}
                  type="button"
                  disabled={loadingSettings}
                  onClick={() => void persistPreferences({ ...preferences, selectedSource: 'managed' })}
                >
                  Managed Pool
                </button>
                <button
                  className={preferences.selectedSource === 'custom' ? 'active' : ''}
                  type="button"
                  disabled={loadingSettings || enabledCustomCredentials.length === 0}
                  onClick={() =>
                    void persistPreferences({
                      ...preferences,
                      selectedSource: 'custom',
                      selectedCustomCredentialId: selectedCredential?.id ?? null,
                      selectedCustomModelName: selectedModel,
                    })
                  }
                >
                  Custom Keys
                </button>
              </div>
              <p className="field-help text-muted">
                Managed Pool uses fast cloud credits. Custom Keys lets you plug in OpenAI, Anthropic, or other providers directly.
              </p>
            </div>

            {preferences.selectedSource === 'custom' && (
              <div className="custom-api-selectors animate-fade-in">
                <div className="selectors-grid">
                  <div className="settings-field">
                    <label className="field-label">Active Provider Key</label>
                    <CustomDropdown
                      className="copilot-settings-select"
                      value={selectedCredential?.id ?? ''}
                      options={enabledCustomCredentials.length === 0
                        ? [{ label: 'No custom keys enabled', value: '' }]
                        : enabledCustomCredentials.map(c => ({ label: c.displayName, value: c.id }))
                      }
                      onChange={(val) => {
                        const credential = settings.customCredentials.find((entry) => entry.id === val) ?? null;
                        void persistPreferences({
                          ...preferences,
                          selectedSource: 'custom',
                          selectedCustomCredentialId: credential?.id ?? null,
                          selectedCustomModelName: credential?.modelNames[0] ?? null,
                        });
                      }}
                    />
                  </div>
                  <div className="settings-field">
                    <label className="field-label">Active Custom Model</label>
                    <CustomDropdown
                      className="copilot-settings-select"
                      value={selectedModel ?? ''}
                      options={selectedCredential
                        ? selectedCredential.modelNames.map(m => ({ label: m, value: m }))
                        : [{ label: 'Select custom key first', value: '' }]
                      }
                      onChange={(val) => void persistPreferences({ ...preferences, selectedCustomModelName: val })}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Existing credential creation/edit form */}
        <form className="agent-settings-card" onSubmit={(event) => void handleCredentialSubmit(event)}>
          <div className="card-header">
            <KeyRound size={14} className="text-accent" />
            <h3>{credentialForm.credentialId ? 'Edit Custom Credential' : 'Add Custom Credential'}</h3>
          </div>
          <div className="agent-settings-grid">
            <label>
              Display name
              <input
                value={credentialForm.displayName}
                disabled={savingSettings}
                onChange={(event) => setCredentialForm((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="Azure AI Foundry"
              />
            </label>
            <label>
              Base URL
              <input
                value={credentialForm.baseUrl}
                disabled={savingSettings}
                onChange={(event) => setCredentialForm((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://resource.openai.azure.com/openai/v1"
              />
            </label>
            <label>
              API key
              <input
                type="password"
                value={credentialForm.apiKey}
                disabled={savingSettings}
                onChange={(event) => setCredentialForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={credentialForm.credentialId ? 'Leave blank to keep current key' : 'sk-...'}
              />
            </label>
            <label>
              Enabled
              <CustomDropdown
                className="copilot-settings-select"
                value={credentialForm.enabled ? 'yes' : 'no'}
                options={[
                  { label: 'Enabled', value: 'yes' },
                  { label: 'Disabled', value: 'no' }
                ]}
                onChange={(val) => setCredentialForm((current) => ({ ...current, enabled: val === 'yes' }))}
              />
            </label>
            <label className="agent-settings-span">
              Model names
              <textarea
                value={credentialForm.modelNames}
                disabled={savingSettings}
                onChange={(event) => setCredentialForm((current) => ({ ...current, modelNames: event.target.value }))}
                placeholder={'gpt-4.1\ngpt-5.5'}
                rows={3}
              />
            </label>
          </div>
          <div className="form-actions">
            {credentialForm.credentialId ? (
              <button className="ghost-button compact" type="button" onClick={() => setCredentialForm(EMPTY_CREDENTIAL_FORM)}>
                <X size={14} />
                Cancel
              </button>
            ) : null}
            <button className="primary-button compact" type="submit" disabled={savingSettings}>
              {savingSettings ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
              {credentialForm.credentialId ? 'Save changes' : 'Add key'}
            </button>
          </div>
        </form>

        {/* Existing credential list */}
        <div className="agent-credential-list">
          <div className="card-header">
            <h3>Registered Keys</h3>
          </div>
          {settings.customCredentials.length === 0 ? (
            <div className="agent-empty-state">
              <KeyRound size={18} />
              <span>No custom keys yet.</span>
            </div>
          ) : null}
          {settings.customCredentials.map((credential) => (
            <article key={credential.id} className="agent-credential-row">
              <div>
                <strong>{credential.displayName}</strong>
                <span>
                  {credential.enabled ? 'Enabled' : 'Disabled'} / {credential.apiKeyPreview} / {credential.modelNames.join(', ')}
                </span>
                <code>{credential.baseUrl}</code>
              </div>
              <div className="action-row">
                <button className="ghost-button compact" type="button" onClick={() => startEditingCredential(credential)}>
                  <Settings2 size={14} />
                  Edit
                </button>
                <button className="ghost-button compact" type="button" disabled={savingSettings} onClick={() => void handleTestCredential(credential)}>
                  <Play size={14} />
                  Test
                </button>
                <button className="ghost-button compact" type="button" disabled={savingSettings} onClick={() => void handleToggleCredential(credential)}>
                  {credential.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="danger-button compact" type="button" disabled={savingSettings} onClick={() => void handleDeleteCredential(credential)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    );
  }

  function renderUsageView() {
    return (
      <div className="agent-usage-view">
        <div className="agent-usage-summary">
          <div>
            <span>Allowance</span>
            <strong>{formatCredits(settings.creditAccount.monthlyAllowance)}</strong>
          </div>
          <div>
            <span>Used</span>
            <strong>{formatCredits(settings.creditAccount.usedCredits)}</strong>
          </div>
          <div>
            <span>Remaining</span>
            <strong>{formatCredits(settings.creditAccount.remainingCredits)}</strong>
          </div>
          <div>
            <span>Resets</span>
            <strong>{formatDate(settings.creditAccount.resetAt)}</strong>
          </div>
        </div>

        <div className="agent-usage-list">
          {settings.recentUsage.length === 0 ? (
            <div className="agent-empty-state">
              <Bot size={18} />
              <span>No agent runs recorded yet.</span>
            </div>
          ) : null}
          {settings.recentUsage.map((event) => (
            <article key={event.id} className="agent-usage-row">
              <div>
                <strong>{event.source === 'managed' ? (event.mode === 'plan' ? 'Plan' : 'Fast') : event.modelAlias || 'Custom'}</strong>
                <span>
                  {event.status} / {formatDate(event.createdAt)}
                </span>
                {event.errorMessage ? <code>{event.errorMessage}</code> : null}
              </div>
              <div>
                <span>{event.totalTokens.toLocaleString()} tokens</span>
                <strong>{event.chargedCredits.toLocaleString()} credits</strong>
              </div>
            </article>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <section className={`agent-panel tantalum-ai-panel ${chatOnly ? 'tantalum-ai-panel-compact' : ''}`}>
        {renderHeader()}
        {renderTabs()}

        {view === 'chat' ? renderChatView() : null}
        {view === 'settings' ? renderSettingsView() : null}
        {view === 'usage' ? renderUsageView() : null}
      </section>
    </>
  );
}

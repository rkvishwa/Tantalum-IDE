import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { Models } from 'appwrite';
import {
  Box,
  ArrowLeft,
  AtSign,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code,
  Cloud,
  Cpu,
  FileText,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  SendHorizontal,
  Settings,
  Settings2,
  ShieldCheck,
  Sliders,
  Sparkles,
  CircleStop,
  Terminal,
  Trash2,
  TriangleAlert,
  Undo2,
  Wrench,
  X,
  Zap,
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
  type AgentCreditAccount,
  type AgentCustomCredential,
  type AgentPreferences,
  type AgentSettingsState,
  type AgentThreadMessage,
  type AgentThreadSummary,
  type AgentUiMessage,
} from '@/lib/agent';
import { hasAgentCloudConfiguration } from '@/lib/config';
import { getMaterialFileIconSvg } from '@/lib/materialFileIcons';
import type {
  AgentActivityEntry,
  AgentChangePreview,
  AgentCompletedTaskReference,
  AgentContextFileSuggestion,
  AgentContextItem,
  AgentPermissionMode,
  AgentProgressEvent,
  AgentRestorePointSummary,
  AgentRunPayload,
  AgentTaskItem,
  AgentTaskList,
  AgentTaskStatus,
  AgentThreadFileReference,
  AgentThreadMemory,
  AgentToolDescriptor,
  AgentToolRequest,
  AgentToolSettingsResponse,
  PendingAgentAction,
  PendingAgentActionStatus,
} from '@/types/electron';

import { MarkdownRenderer } from './MarkdownRenderer';
import { Modal } from './Modal';

export type AgentPendingReview = {
  id: string;
  threadId: string;
  files: AgentChangePreview[];
  output: string;
  createdAt: string;
};

export type AgentPreparedReview = Omit<AgentPendingReview, 'id' | 'createdAt'> & {
  userMessageId?: string | null;
  userMessageCreatedAt?: string | null;
};

export type AgentRestoreResult = {
  messages: AgentThreadMessage[];
  restorePoints: AgentRestorePointSummary[];
};

export type AgentReviewResolutionNotice = {
  id: string;
  threadId: string;
  content: string;
  tone: AgentUiMessage['tone'];
  createdAt: string;
};

export type AgentEditorSelectionContext = {
  path: string;
  name: string;
  content: string;
  lineStart: number;
  lineEnd: number;
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
  activeSelection?: AgentEditorSelectionContext | null;
  boardContext?: {
    id?: string;
    name: string;
    fqbn: string;
  } | null;
  localBoardContext?: {
    profileId?: string;
    name: string;
    fqbn: string;
    port: string;
    boardLabel?: string;
    connected?: boolean;
  } | null;
  arduinoPreferences?: {
    verifyBeforeUpload: boolean;
    nextReleaseVersion?: string;
  } | null;
  pushConsole: (message: string, level?: 'info' | 'success' | 'error') => void;
  pushToast: (
    message: string,
    tone?: 'info' | 'success' | 'error',
    actions?: Array<{ label: string; onSelect: () => void }>,
  ) => void;
  pendingReview?: AgentPendingReview | null;
  resolvingReview?: boolean;
  reviewResolutionNotice?: AgentReviewResolutionNotice | null;
  onAgentChangesPrepared?: (review: AgentPreparedReview) => void;
  onPreviewAgentFile?: (relativePath: string) => void;
  onOpenContextFile?: (filePath: string) => void;
  onResolveAgentChanges?: (approved: boolean) => void | Promise<void>;
  restorePoints?: AgentRestorePointSummary[];
  onRestoreToMessage?: (message: AgentThreadMessage, messages: AgentThreadMessage[]) => Promise<AgentRestoreResult | null>;
  defaultView?: AgentView;
  hideChat?: boolean;
  chatOnly?: boolean;
  onOpenSettings?: () => void;
  onClosePanel?: () => void;
  onSignedOut?: () => void;
};

type AgentView = 'chat' | 'settings';
type AgentComposeTarget = 'new' | 'thread';
type AgentCloudLoadScope = 'settings' | 'threads';
type AgentIntent = 'agent' | 'ask';
type PersistPreferencesOptions = {
  includeCustomModelName?: boolean;
  suppressCustomModelSchemaError?: boolean;
};

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
const AGENT_RUN_STOPPED_MESSAGE = 'Agent run stopped.';

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

function normalizeCreditNumber(value: number | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function getCreditBalance(account: AgentCreditAccount) {
  const monthlyAllowance = Math.max(0, normalizeCreditNumber(account.monthlyAllowance));
  const usedCredits = Math.max(0, normalizeCreditNumber(account.usedCredits));
  const remainingCredits = Math.max(0, monthlyAllowance - usedCredits);

  return {
    monthlyAllowance,
    usedCredits,
    remainingCredits,
  };
}

function formatCreditBalance(remainingCredits: number, monthlyAllowance: number) {
  return `${formatCredits(remainingCredits)}/${formatCredits(monthlyAllowance)}`;
}

function formatDetailedDate(value: string | null | undefined) {
  if (!value) {
    return 'Not set';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatUsagePercent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function firstEnabledCredential(settings: AgentSettingsState) {
  return settings.customCredentials.find((credential) => credential.enabled) ?? null;
}

function isUnknownSelectedCustomModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('Unknown attribute') && message.includes('selectedCustomModelName');
}

function basenameFromPath(value: string | null) {
  if (!value) {
    return null;
  }

  return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? value;
}

function dirnameFromPath(value: string | null) {
  if (!value) {
    return '';
  }

  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function ContextSuggestionFileIcon({ filePath, className = '' }: { filePath: string; className?: string }) {
  const iconSvg = getMaterialFileIconSvg(filePath);
  const iconClassName = ['context-suggestion-file-icon', className].filter(Boolean).join(' ');

  if (!iconSvg) {
    return <FileText size={12} className={iconClassName} />;
  }

  return <span className={iconClassName} aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg }} />;
}

function ContextItemIcon({ item }: { item: Pick<AgentContextItem, 'kind' | 'path'> }) {
  if (item.kind === 'image') {
    return <ImageIcon size={12} className="context-suggestion-file-icon" aria-hidden="true" />;
  }

  return <ContextSuggestionFileIcon filePath={item.path} />;
}

function threadsForWorkspace(threads: AgentThreadSummary[], workspaceKey: string | null) {
  if (!workspaceKey) {
    return [];
  }

  return threads.filter((thread) => thread.workspaceKey === workspaceKey);
}

type AgentPanelDisplayCache = {
  version: 1;
  settings: AgentSettingsState;
  threads: AgentThreadSummary[];
  savedAt: string;
};

const AGENT_PANEL_DISPLAY_CACHE_PREFIX = 'tantalum-agent-panel-display-cache';

function agentPanelDisplayCacheKey(userId: string, workspaceKey: string | null) {
  return `${AGENT_PANEL_DISPLAY_CACHE_PREFIX}:${userId}:${workspaceKey || 'no-workspace'}`;
}

function isAgentPanelDisplayCache(value: unknown): value is AgentPanelDisplayCache {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AgentPanelDisplayCache>;
  return (
    candidate.version === 1 &&
    Boolean(candidate.settings) &&
    typeof candidate.settings === 'object' &&
    Array.isArray(candidate.settings.recentThreads) &&
    Array.isArray(candidate.threads)
  );
}

function readAgentPanelDisplayCache(userId: string, workspaceKey: string | null) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(agentPanelDisplayCacheKey(userId, workspaceKey));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return isAgentPanelDisplayCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeAgentPanelDisplayCache(
  userId: string,
  workspaceKey: string | null,
  settings: AgentSettingsState,
  threads: AgentThreadSummary[],
) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      agentPanelDisplayCacheKey(userId, workspaceKey),
      JSON.stringify({
        version: 1,
        settings: { ...settings, recentThreads: threads },
        threads,
        savedAt: new Date().toISOString(),
      } satisfies AgentPanelDisplayCache),
    );
  } catch {
    // Best-effort display cache only; Appwrite remains authoritative.
  }
}

function titleFromPrompt(value: string) {
  const title = value.replace(/\s+/g, ' ').trim().slice(0, 64);
  return formatThreadTitle(title || 'New thread');
}

function formatThreadTitle(value: string) {
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) {
    return 'New thread';
  }

  let offset = 0;
  for (const character of title) {
    if (character.toLocaleLowerCase() !== character.toLocaleUpperCase()) {
      return `${title.slice(0, offset)}${character.toLocaleUpperCase()}${title.slice(offset + character.length)}`;
    }
    offset += character.length;
  }

  return title;
}

function promptReferencesCompletedTask(value: string) {
  const normalized = value.trim().toLowerCase();
  return /\b(do|make|apply|repeat|use)\s+(?:it|that|this|the same|same)\s+(?:again|like|to|for|here)?\b/.test(normalized) ||
    /\b(?:same as before|same thing|like before|like that|like this|similar to before|similar to that|previous task|last task)\b/.test(normalized) ||
    /^(?:again|same again|repeat that|repeat it|do that again|do it again)$/.test(normalized);
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

const FALLBACK_FAST_CONTEXT_WINDOW = 64000;
const FALLBACK_POWER_CONTEXT_WINDOW = 128000;
const AGENT_CONTEXT_RESERVED_TOKENS = 12000;
const AGENT_CONTEXT_TOKEN_CHARS = 3.5;
const AGENT_ATTACHMENT_MAX_TEXT_BYTES = 1_500_000;
const AGENT_ATTACHMENT_MAX_IMAGE_BYTES = 2_000_000;
const AGENT_ATTACHMENT_MAX_DROPPED_FILES = 10;
const AGENT_ATTACHMENT_MAX_IMAGE_DATA_URL_CHARS = 6_000_000;
const AGENT_MESSAGE_CONTEXT_CHIP_LIMIT = 12;
const AGENT_MESSAGE_CONTEXT_STRING_LIMIT = 180;
const AGENT_MESSAGE_CONTEXT_PATH_LIMIT = 500;
const THREAD_HISTORY_PREVIEW_LIMIT = 4;
const THREAD_MEMORY_FILE_LIMIT = 50;
const THREAD_MEMORY_ALIAS_LIMIT = 18;
const THREAD_MEMORY_ALIAS_STRING_LIMIT = 180;
const AGENT_ATTACHMENT_TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hh',
  '.hpp',
  '.html',
  '.ini',
  '.ino',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.py',
  '.rs',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const AGENT_ATTACHMENT_IMAGE_MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const AGENT_ATTACHMENT_SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^id_rsa(?:\..*)?$/i,
  /^id_ed25519(?:\..*)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /credentials/i,
  /secret/i,
];

type ContextMentionRange = {
  start: number;
  end: number;
  query: string;
};

type AgentMessageContextChip = {
  id: string;
  kind: AgentContextItem['kind'];
  name: string;
  path?: string;
  relativePath?: string;
  source?: AgentContextItem['source'];
  lineStart?: number;
  lineEnd?: number;
  mimeType?: string;
  sizeBytes?: number;
};

type AgentImagePreview = {
  id: string;
  name: string;
  dataUrl: string;
  source: 'composer' | 'message';
  contextItem?: AgentContextItem;
};

type ShrunkRunContext = {
  contextItems: AgentContextItem[];
  threadMessages: NonNullable<AgentRunPayload['threadMessages']>;
};

function estimateAgentTokens(value: string) {
  if (!value) {
    return 0;
  }

  return Math.max(1, Math.ceil(value.length / AGENT_CONTEXT_TOKEN_CHARS));
}

function estimateContextItemTokens(item: Pick<AgentContextItem, 'content' | 'tokenEstimate'>) {
  return item.tokenEstimate ?? estimateAgentTokens(item.content || '');
}

function formatCompactTokens(value: number) {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }

  return `${Math.max(0, Math.round(value))}`;
}

function normalizeContextPathKey(value: string) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sanitizeAttachmentName(value: string) {
  const name = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || '<>:"/\\|?*'.includes(character) ? '_' : character;
    })
    .join('')
    .trim();
  return (name || 'attachment').slice(0, 180);
}

function extensionFromFileName(value: string) {
  const cleanName = sanitizeAttachmentName(value).toLowerCase();
  const dotIndex = cleanName.lastIndexOf('.');
  return dotIndex >= 0 ? cleanName.slice(dotIndex) : '';
}

function isSensitiveAttachmentName(value: string) {
  const name = sanitizeAttachmentName(value);
  return AGENT_ATTACHMENT_SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function getImageMimeFromBytes(fileName: string, bytes: Uint8Array) {
  const extensionMime = AGENT_ATTACHMENT_IMAGE_MIME_BY_EXTENSION.get(extensionFromFileName(fileName));
  if (!extensionMime) {
    return null;
  }

  if (
    extensionMime === 'image/png' &&
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return extensionMime;
  }

  if (extensionMime === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return extensionMime;
  }

  if (
    extensionMime === 'image/webp' &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return extensionMime;
  }

  return null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }

  return window.btoa(binary);
}

function createDroppedAttachmentPath(kind: AgentContextItem['kind'], name: string) {
  const id = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `attachment://${kind}/${id}/${encodeURIComponent(name)}`;
}

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function contextItemId(kind: AgentContextItem['kind'], path: string, lineStart?: number, lineEnd?: number) {
  const normalizedPath = normalizeContextPathKey(path);
  return kind === 'selection' ? `selection:${normalizedPath}:${lineStart ?? 1}-${lineEnd ?? lineStart ?? 1}` : `${kind}:${normalizedPath}`;
}

function contextItemLabel(item: Pick<AgentContextItem, 'kind' | 'name' | 'lineStart' | 'lineEnd'>) {
  if (item.kind === 'selection' && item.lineStart && item.lineEnd) {
    const lineRange = item.lineStart === item.lineEnd ? `${item.lineStart}` : `${item.lineStart}-${item.lineEnd}`;
    return `${item.name}:${lineRange}`;
  }

  return item.name;
}

function clampMessageContextString(value: string, maxLength = AGENT_MESSAGE_CONTEXT_STRING_LIMIT) {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim()
    .slice(0, maxLength);
}

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isAgentContextItemKind(value: unknown): value is AgentContextItem['kind'] {
  return value === 'file' || value === 'selection' || value === 'image';
}

function isAgentContextItemSource(value: unknown): value is NonNullable<AgentContextItem['source']> {
  return value === 'active-editor' || value === 'workspace' || value === 'attachment';
}

function createMessageContextChips(items: AgentContextItem[]): AgentMessageContextChip[] {
  return items.slice(0, AGENT_MESSAGE_CONTEXT_CHIP_LIMIT).map((item) => {
    const chip: AgentMessageContextChip = {
      id: clampMessageContextString(item.id || contextItemId(item.kind, item.path, item.lineStart, item.lineEnd), 240),
      kind: item.kind,
      name: clampMessageContextString(item.name),
      source: item.source,
    };

    if (item.source !== 'attachment') {
      chip.path = clampMessageContextString(item.path, AGENT_MESSAGE_CONTEXT_PATH_LIMIT);
      if (item.relativePath) {
        chip.relativePath = clampMessageContextString(item.relativePath, AGENT_MESSAGE_CONTEXT_PATH_LIMIT);
      }
    }

    if (item.kind === 'selection') {
      chip.lineStart = positiveInteger(item.lineStart);
      chip.lineEnd = positiveInteger(item.lineEnd);
    }

    if (item.kind === 'image') {
      if (item.mimeType) {
        chip.mimeType = clampMessageContextString(item.mimeType, 80);
      }
      if (typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0) {
        chip.sizeBytes = Math.floor(item.sizeBytes);
      }
    }

    return chip;
  });
}

function asAgentMessageContextChip(value: unknown, index: number): AgentMessageContextChip | null {
  if (!isRecord(value) || !isAgentContextItemKind(value.kind)) {
    return null;
  }

  const rawName = typeof value.name === 'string' ? value.name : '';
  const name = clampMessageContextString(rawName || 'Context');
  if (!name) {
    return null;
  }

  const id = typeof value.id === 'string' && value.id.trim()
    ? clampMessageContextString(value.id, 240)
    : `context-chip-${index}-${value.kind}-${name}`;
  const chip: AgentMessageContextChip = {
    id,
    kind: value.kind,
    name,
  };

  if (typeof value.path === 'string' && value.path.trim()) {
    chip.path = clampMessageContextString(value.path, AGENT_MESSAGE_CONTEXT_PATH_LIMIT);
  }
  if (typeof value.relativePath === 'string' && value.relativePath.trim()) {
    chip.relativePath = clampMessageContextString(value.relativePath, AGENT_MESSAGE_CONTEXT_PATH_LIMIT);
  }
  if (isAgentContextItemSource(value.source)) {
    chip.source = value.source;
  }

  const lineStart = positiveInteger(value.lineStart);
  const lineEnd = positiveInteger(value.lineEnd);
  if (chip.kind === 'selection' && lineStart) {
    chip.lineStart = lineStart;
    chip.lineEnd = lineEnd ?? lineStart;
  }

  if (chip.kind === 'image') {
    if (typeof value.mimeType === 'string' && value.mimeType.trim()) {
      chip.mimeType = clampMessageContextString(value.mimeType, 80);
    }
    if (typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) && value.sizeBytes >= 0) {
      chip.sizeBytes = Math.floor(value.sizeBytes);
    }
  }

  return chip;
}

function messageContextChipsFromMetadata(metadata: AgentThreadMessage['metadata']): AgentMessageContextChip[] {
  const rawChips = isRecord(metadata) && Array.isArray(metadata.contextChips) ? metadata.contextChips : [];
  return rawChips
    .slice(0, AGENT_MESSAGE_CONTEXT_CHIP_LIMIT)
    .map((entry, index) => asAgentMessageContextChip(entry, index))
    .filter((entry): entry is AgentMessageContextChip => Boolean(entry));
}

function contextChipLabel(chip: Pick<AgentMessageContextChip, 'kind' | 'name' | 'lineStart' | 'lineEnd'>) {
  if (chip.kind === 'selection' && chip.lineStart && chip.lineEnd) {
    const lineRange = chip.lineStart === chip.lineEnd ? `${chip.lineStart}` : `${chip.lineStart}-${chip.lineEnd}`;
    return `${chip.name}:${lineRange}`;
  }

  return chip.name;
}

function normalizeWorkspacePath(value: string) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function hasUnsafeWindowsPathColon(value: string) {
  const normalized = value.replace(/\\/g, '/');
  const withoutDrive = /^[a-zA-Z]:\//.test(normalized) ? normalized.slice(2) : normalized;
  return withoutDrive.includes(':');
}

function isWorkspaceRelativePathSafe(value: string) {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.includes('\0') || hasUnsafeWindowsPathColon(normalized)) {
    return false;
  }

  return normalized.split('/').every((part) => part && part !== '.' && part !== '..');
}

function isPathInsideWorkspacePath(filePath: string, workspacePath: string) {
  if (filePath.includes('\0') || hasUnsafeWindowsPathColon(filePath)) {
    return false;
  }

  const root = normalizeWorkspacePath(workspacePath).toLowerCase();
  const candidate = normalizeWorkspacePath(filePath).toLowerCase();
  return candidate === root || candidate.startsWith(`${root}/`);
}

function joinWorkspaceRelativePath(workspacePath: string, relativePath: string) {
  const separator = workspacePath.includes('\\') ? '\\' : '/';
  return `${workspacePath.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/[\\/]+/g, separator)}`;
}

function workspacePathForContextChip(chip: AgentMessageContextChip, workspacePath: string | null) {
  if (!workspacePath || chip.kind === 'image' || chip.source === 'attachment') {
    return null;
  }

  if (chip.relativePath && isWorkspaceRelativePathSafe(chip.relativePath)) {
    const candidate = joinWorkspaceRelativePath(workspacePath, chip.relativePath);
    return isPathInsideWorkspacePath(candidate, workspacePath) ? candidate : null;
  }

  if (chip.path && !chip.path.startsWith('attachment://') && isPathInsideWorkspacePath(chip.path, workspacePath)) {
    return chip.path;
  }

  return null;
}

function detectContextMention(value: string, cursorPosition: number): ContextMentionRange | null {
  const safeCursor = Math.max(0, Math.min(value.length, cursorPosition));
  const beforeCursor = value.slice(0, safeCursor);
  const atIndex = beforeCursor.lastIndexOf('@');

  if (atIndex === -1) {
    return null;
  }

  const query = beforeCursor.slice(atIndex + 1);
  if (/\s/.test(query)) {
    return null;
  }

  return {
    start: atIndex,
    end: safeCursor,
    query,
  };
}

function getLineRangeContent(content: string, lineStart: number, lineEnd: number) {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.min(lines.length || 1, lineStart));
  const end = Math.max(start, Math.min(lines.length || start, lineEnd));
  return {
    lineStart: start,
    lineEnd: end,
    content: lines.slice(start - 1, end).join('\n'),
  };
}

function createActiveFileContextItem(activeTab: NonNullable<AgentPanelProps['activeTab']>): AgentContextItem {
  const tokenEstimate = estimateAgentTokens(activeTab.content);
  return {
    id: contextItemId('file', activeTab.path),
    kind: 'file',
    path: activeTab.path,
    name: activeTab.name,
    content: activeTab.content,
    isDirty: activeTab.isDirty,
    tokenEstimate,
    originalTokenEstimate: tokenEstimate,
    source: 'active-editor',
  };
}

function createSelectionContextItem(selection: AgentEditorSelectionContext): AgentContextItem {
  const tokenEstimate = estimateAgentTokens(selection.content);
  return {
    id: contextItemId('selection', selection.path, selection.lineStart, selection.lineEnd),
    kind: 'selection',
    path: selection.path,
    name: selection.name,
    content: selection.content,
    isDirty: true,
    lineStart: selection.lineStart,
    lineEnd: selection.lineEnd,
    tokenEstimate,
    originalTokenEstimate: tokenEstimate,
    source: 'active-editor',
  };
}

function createWorkspaceSuggestionContextItem(suggestion: AgentContextFileSuggestion): AgentContextItem {
  const tokenEstimate = Math.max(1, Math.ceil(Math.max(0, suggestion.sizeBytes) / AGENT_CONTEXT_TOKEN_CHARS));
  return {
    id: contextItemId('file', suggestion.path),
    kind: 'file',
    path: suggestion.path,
    relativePath: suggestion.relativePath,
    name: suggestion.name,
    content: '',
    tokenEstimate,
    originalTokenEstimate: tokenEstimate,
    source: 'workspace',
  };
}

async function createDroppedAttachmentContextItem(file: File, aggregateImageDataUrlChars: number) {
  const name = sanitizeAttachmentName(file.name);
  if (isSensitiveAttachmentName(name)) {
    return { rejected: { name, reason: 'Sensitive filenames cannot be attached as agent context.' } };
  }

  const extension = extensionFromFileName(name);
  const isImageCandidate = AGENT_ATTACHMENT_IMAGE_MIME_BY_EXTENSION.has(extension);
  const isTextCandidate = AGENT_ATTACHMENT_TEXT_EXTENSIONS.has(extension);
  if (!isImageCandidate && !isTextCandidate) {
    return { rejected: { name, reason: 'This file type is not supported for agent context.' } };
  }

  if (isImageCandidate && file.size > AGENT_ATTACHMENT_MAX_IMAGE_BYTES) {
    return { rejected: { name, reason: 'This image is too large for agent context.' } };
  }

  if (isTextCandidate && file.size > AGENT_ATTACHMENT_MAX_TEXT_BYTES) {
    return { rejected: { name, reason: 'This text file is too large for agent context.' } };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isImageCandidate) {
    const mimeType = getImageMimeFromBytes(name, bytes);
    if (!mimeType) {
      return { rejected: { name, reason: 'Image bytes did not match a supported PNG, JPEG, or WebP file.' } };
    }

    const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
    if (aggregateImageDataUrlChars + dataUrl.length > AGENT_ATTACHMENT_MAX_IMAGE_DATA_URL_CHARS) {
      return { rejected: { name, reason: 'Attached images exceed the safe request size limit.' } };
    }

    const tokenEstimate = Math.max(256, Math.ceil(file.size / 2048));
    const attachmentPath = createDroppedAttachmentPath('image', name);
    const item: AgentContextItem = {
      id: contextItemId('image', attachmentPath),
      kind: 'image',
      path: attachmentPath,
      name,
      content: `[Image attachment: ${name}]`,
      mimeType,
      sizeBytes: file.size,
      dataUrl,
      tokenEstimate,
      originalTokenEstimate: tokenEstimate,
      source: 'attachment',
    };
    return { item, imageDataUrlChars: dataUrl.length };
  }

  if (bytes.includes(0)) {
    return { rejected: { name, reason: 'Binary files cannot be attached as text context.' } };
  }

  let content = '';
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { rejected: { name, reason: 'Only UTF-8 text files can be attached as context.' } };
  }

  const tokenEstimate = estimateAgentTokens(content);
  const attachmentPath = createDroppedAttachmentPath('file', name);
  const item: AgentContextItem = {
    id: contextItemId('file', attachmentPath),
    kind: 'file',
    path: attachmentPath,
    name,
    content,
    sizeBytes: file.size,
    tokenEstimate,
    originalTokenEstimate: tokenEstimate,
    source: 'attachment',
  };
  return { item };
}

function isSameContextItem(left: Pick<AgentContextItem, 'kind' | 'path' | 'lineStart' | 'lineEnd'>, right: Pick<AgentContextItem, 'kind' | 'path' | 'lineStart' | 'lineEnd'>) {
  return (
    left.kind === right.kind &&
    normalizeContextPathKey(left.path) === normalizeContextPathKey(right.path) &&
    (left.kind !== 'selection' || (left.lineStart === right.lineStart && left.lineEnd === right.lineEnd))
  );
}

function truncateContextFileContent(item: AgentContextItem, maxTokens: number): AgentContextItem {
  const tokenEstimate = estimateContextItemTokens(item);
  if (tokenEstimate <= maxTokens || item.kind === 'selection' || item.kind === 'image') {
    return {
      ...item,
      tokenEstimate,
      originalTokenEstimate: item.originalTokenEstimate ?? tokenEstimate,
    };
  }

  const maxChars = Math.floor(Math.max(0, maxTokens) * AGENT_CONTEXT_TOKEN_CHARS);
  const marker = `\n\n[Context truncated to fit the ${contextItemLabel(item)} context window budget.]`;
  const content =
    maxChars <= marker.length + 80
      ? `[Context for ${contextItemLabel(item)} omitted because the context window budget is full.]`
      : `${item.content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
  const nextTokenEstimate = estimateAgentTokens(content);

  return {
    ...item,
    content,
    tokenEstimate: nextTokenEstimate,
    originalTokenEstimate: item.originalTokenEstimate ?? tokenEstimate,
    truncated: true,
  };
}

function shrinkAgentRunContext({
  prompt,
  threadMessages,
  contextItems,
  contextWindow,
}: {
  prompt: string;
  threadMessages: NonNullable<AgentRunPayload['threadMessages']>;
  contextItems: AgentContextItem[];
  contextWindow: number;
}): ShrunkRunContext {
  const availableTokens = Math.max(4000, contextWindow - AGENT_CONTEXT_RESERVED_TOKENS);
  const promptTokens = estimateAgentTokens(prompt) + 1000;
  let nextThreadMessages = threadMessages.map((message) => ({
    ...message,
    content: clampAgentMessageContent(message.content, 12000),
  }));
  const nextContextItems = contextItems.map((item) => {
    const tokenEstimate = estimateAgentTokens(item.content || '');
    return {
      ...item,
      tokenEstimate,
      originalTokenEstimate: item.originalTokenEstimate ?? tokenEstimate,
    };
  });

  const estimateTotal = () =>
    promptTokens +
    nextThreadMessages.reduce((total, message) => total + estimateAgentTokens(message.content), 0) +
    nextContextItems.reduce((total, item) => total + estimateContextItemTokens(item) + 80, 0);

  while (nextThreadMessages.length > 0 && estimateTotal() > availableTokens) {
    nextThreadMessages = nextThreadMessages.slice(1);
  }

  if (estimateTotal() <= availableTokens) {
    return {
      contextItems: nextContextItems,
      threadMessages: nextThreadMessages,
    };
  }

  const fixedContextItems = nextContextItems.filter((item) => item.kind !== 'file');
  const fileItems = nextContextItems.filter((item) => item.kind === 'file');
  const fixedTokens = promptTokens + fixedContextItems.reduce((total, item) => total + estimateContextItemTokens(item) + 80, 0);
  let remainingFileTokens = Math.max(0, availableTokens - fixedTokens);
  const shrunkFiles = fileItems.map((item) => {
    const itemTokens = estimateContextItemTokens(item) + 80;
    const allowedTokens = Math.max(0, Math.min(itemTokens, remainingFileTokens));
    remainingFileTokens -= allowedTokens;
    return truncateContextFileContent(item, Math.max(0, allowedTokens - 80));
  });

  return {
    contextItems: nextContextItems.map((item) => shrunkFiles.find((file) => isSameContextItem(file, item)) ?? item),
    threadMessages: nextThreadMessages,
  };
}

function createLocalThreadMessage(
  role: AgentThreadMessage['role'],
  content: string,
  tone?: AgentThreadMessage['tone'],
  metadata?: Record<string, unknown>,
  threadId = 'local',
): AgentThreadMessage {
  return {
    id: `local-${role}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    threadId,
    role,
    content,
    tone,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

function createLocalThreadId() {
  return `local-thread-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function isLocalThreadId(value: string | null | undefined) {
  return Boolean(value?.startsWith('local-thread-'));
}

function agentCloudLoadErrorMessage(error: unknown, scope: AgentCloudLoadScope) {
  const rawMessage = error instanceof Error ? error.message : String(error || '');
  const cleanMessage = rawMessage.replace(/\s+/g, ' ').trim();
  const prefix =
    scope === 'settings'
      ? 'Tantalum AI cloud settings could not be loaded.'
      : 'Synced threads could not be refreshed.';

  if (/function returned an empty response|returned an empty response|unreadable response/i.test(cleanMessage)) {
    return `${prefix} Tantalum AI setup is temporarily unavailable. Retry in a moment.`;
  }

  if (/timed out|timeout/i.test(cleanMessage)) {
    return `${prefix} Tantalum AI took too long to start. Retry in a moment.`;
  }

  if (/jwt|session|unauthorized|missing.*user|401/i.test(cleanMessage)) {
    return `${prefix} Sign in again, then retry.`;
  }

  if (/fetch failed|failed to fetch|network|enotfound|econnrefused|etimedout/i.test(cleanMessage)) {
    return `${prefix} Check the Appwrite connection and try again.`;
  }

  return cleanMessage ? `${prefix} ${cleanMessage}` : `${prefix} Try again from the refresh button.`;
}

function replaceOptimisticMessage(
  current: AgentThreadMessage[],
  optimisticMessageId: string | null,
  persistedMessage: AgentThreadMessage,
  fallbackPrefix: AgentThreadMessage[],
) {
  if (current.some((message) => message.id === persistedMessage.id)) {
    return current;
  }

  if (!optimisticMessageId) {
    return [...fallbackPrefix, persistedMessage];
  }

  let replaced = false;
  const nextMessages = current.map((message) => {
    if (message.id !== optimisticMessageId) {
      return message;
    }

    replaced = true;
    return persistedMessage;
  });

  return replaced ? nextMessages : [...fallbackPrefix, persistedMessage];
}

function createLocalThreadSummary({
  id,
  title,
  workspaceKey,
  workspaceName,
  lastMessagePreview,
}: {
  id: string;
  title: string;
  workspaceKey: string | null;
  workspaceName: string | null;
  lastMessagePreview: string;
}): AgentThreadSummary {
  const now = new Date().toISOString();
  return {
    id,
    title: titleFromPrompt(title),
    workspaceKey,
    workspaceName,
    status: 'active',
    messageCount: 1,
    lastMessagePreview: lastMessagePreview.replace(/\s+/g, ' ').trim().slice(0, 180),
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asAgentToolRequest(value: unknown): AgentToolRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const requestId = typeof value.requestId === 'string' ? value.requestId.trim() : '';
  const toolId = typeof value.toolId === 'string' ? value.toolId.trim() : '';
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!toolId || !summary) {
    return undefined;
  }

  return {
    requestId: requestId || `${toolId}:${Date.now()}`,
    toolId,
    summary,
    risk: typeof value.risk === 'string' ? value.risk : 'medium',
    origin: typeof value.origin === 'string' ? value.origin : 'user',
    arguments: isRecord(value.arguments) ? value.arguments : {},
    approvalReason: typeof value.approvalReason === 'string' && value.approvalReason.trim() ? value.approvalReason.trim() : undefined,
  };
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
    userMessageId: typeof value.userMessageId === 'string' ? value.userMessageId : null,
    userMessageCreatedAt: typeof value.userMessageCreatedAt === 'string' ? value.userMessageCreatedAt : null,
    riskLevel: typeof value.riskLevel === 'string' ? value.riskLevel : 'medium',
    reason: typeof value.reason === 'string' ? value.reason : 'pending_action',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    status: isPendingAgentActionStatus(value.status) ? value.status : 'pending',
    toolRequest: asAgentToolRequest(value.toolRequest),
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

function isAgentActivityStatus(value: unknown): value is AgentActivityEntry['status'] {
  return value === 'running' || value === 'completed' || value === 'blocked' || value === 'error';
}

function asAgentActivityEntry(value: unknown): AgentActivityEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!id || !title) {
    return null;
  }

  return {
    id,
    status: isAgentActivityStatus(value.status) ? value.status : 'running',
    title,
    detail: typeof value.detail === 'string' && value.detail.trim() ? value.detail.trim() : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  };
}

function asAgentActivityEntries(value: unknown): AgentActivityEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(asAgentActivityEntry).filter((entry): entry is AgentActivityEntry => Boolean(entry));
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : undefined;
}

function asAgentTaskList(value: unknown): AgentTaskList | null {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.id !== 'string') {
    return null;
  }

  const items = value.items
    .filter(isRecord)
    .map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : `task-${index + 1}`,
      title: typeof item.title === 'string' ? item.title : 'Run Project task',
      status: isAgentTaskStatus(item.status) ? item.status : 'pending',
      kind: typeof item.kind === 'string' ? item.kind : 'opencode_edit',
      targetPath: typeof item.targetPath === 'string' ? item.targetPath : undefined,
      newPath: typeof item.newPath === 'string' ? item.newPath : undefined,
      sourceExtension: typeof item.sourceExtension === 'string' ? item.sourceExtension : undefined,
      targetExtension: typeof item.targetExtension === 'string' ? item.targetExtension : undefined,
      sourceExtensions: asOptionalStringArray(item.sourceExtensions),
      targetExtensions: asOptionalStringArray(item.targetExtensions),
      sourcePaths: asOptionalStringArray(item.sourcePaths),
      excludePaths: asOptionalStringArray(item.excludePaths),
      deferUntilAfterEdit: item.deferUntilAfterEdit === true,
      requireSingle: item.requireSingle === true,
      lineStart: typeof item.lineStart === 'number' && Number.isFinite(item.lineStart) ? item.lineStart : undefined,
      lineEnd: typeof item.lineEnd === 'number' && Number.isFinite(item.lineEnd) ? item.lineEnd : undefined,
      contextItemId: typeof item.contextItemId === 'string' ? item.contextItemId : undefined,
      instruction: typeof item.instruction === 'string' ? item.instruction : undefined,
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

function formatTaskRange(item: Pick<AgentTaskItem, 'lineStart' | 'lineEnd'>) {
  if (!item.lineStart || !item.lineEnd) {
    return null;
  }

  return item.lineStart === item.lineEnd ? `line ${item.lineStart}` : `lines ${item.lineStart} to ${item.lineEnd}`;
}

function taskTargetPath(item: Pick<AgentTaskItem, 'targetPath' | 'newPath'>) {
  return item.targetPath || item.newPath || '';
}

function normalizeThreadMemoryRelativePath(value: string | null | undefined) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '')
    .trim();

  return isWorkspaceRelativePathSafe(normalized) ? normalized : '';
}

function workspaceRelativePathFromAbsolute(filePath: string | undefined, workspacePath: string | null) {
  if (!filePath || !workspacePath) {
    return '';
  }

  const root = normalizeWorkspacePath(workspacePath);
  const candidate = normalizeWorkspacePath(filePath);
  const rootLower = root.toLowerCase();
  const candidateLower = candidate.toLowerCase();
  if (candidateLower === rootLower || !candidateLower.startsWith(`${rootLower}/`)) {
    return '';
  }

  return normalizeThreadMemoryRelativePath(candidate.slice(root.length + 1));
}

function threadMemoryPathFromContextChip(chip: AgentMessageContextChip, workspacePath: string | null) {
  if (chip.kind === 'image' || chip.source === 'attachment') {
    return '';
  }

  if (chip.relativePath) {
    return normalizeThreadMemoryRelativePath(chip.relativePath);
  }

  const workspaceRelativePath = workspaceRelativePathFromAbsolute(chip.path, workspacePath);
  return workspaceRelativePath || normalizeThreadMemoryRelativePath(chip.path);
}

function cleanThreadMemoryAlias(value: string | null | undefined) {
  return String(value || '')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, THREAD_MEMORY_ALIAS_STRING_LIMIT);
}

function threadMemoryAliasesForPath(relativePath: string) {
  const fileName = basenameFromPath(relativePath) || relativePath;
  const stem = fileName.replace(/\.[^.]+$/g, '');
  const readableStem = stem.replace(/[_-]+/g, ' ');
  const readableName = fileName.replace(/[_-]+/g, ' ');
  return [relativePath, fileName, stem, readableStem, readableName];
}

type ThreadMemoryFileInput = Omit<AgentThreadFileReference, 'aliases'> & {
  aliases?: Array<string | null | undefined>;
};

function mergeThreadMemoryFile(filesByPath: Map<string, AgentThreadFileReference>, input: ThreadMemoryFileInput) {
  const relativePath = normalizeThreadMemoryRelativePath(input.path);
  if (!relativePath) {
    return;
  }

  const key = normalizeContextPathKey(relativePath);
  const existing = filesByPath.get(key);
  const mergedAliases = [
    ...threadMemoryAliasesForPath(relativePath),
    ...(existing?.aliases ?? []),
    ...(input.aliases ?? []),
  ]
    .map(cleanThreadMemoryAlias)
    .filter(Boolean);
  const aliases = [...new Set(mergedAliases)].slice(0, THREAD_MEMORY_ALIAS_LIMIT);
  const existingTime = Date.parse(existing?.updatedAt ?? '') || 0;
  const inputTime = Date.parse(input.updatedAt) || 0;
  const latest = !existing || inputTime >= existingTime;

  filesByPath.set(key, {
    path: relativePath,
    previousPath: latest ? input.previousPath : existing?.previousPath,
    name: latest ? input.name : existing?.name ?? input.name,
    aliases,
    source: latest ? input.source : existing?.source ?? input.source,
    lastAction: latest ? input.lastAction : existing?.lastAction ?? input.lastAction,
    expectedExists: latest ? input.expectedExists : existing?.expectedExists ?? input.expectedExists,
    updatedAt: latest ? input.updatedAt : existing?.updatedAt ?? input.updatedAt,
  });
}

function addThreadMemoryForTask(filesByPath: Map<string, AgentThreadFileReference>, item: AgentTaskItem, updatedAt: string) {
  if (item.status !== 'completed') {
    return;
  }

  const kind = item.kind.toLowerCase();
  const targetPath = normalizeThreadMemoryRelativePath(item.targetPath);
  const newPath = normalizeThreadMemoryRelativePath(item.newPath);
  const baseAliases = [item.title, item.instruction, item.result, targetPath, newPath];

  if ((kind.includes('rename') || kind.includes('move')) && newPath) {
    mergeThreadMemoryFile(filesByPath, {
      path: newPath,
      previousPath: targetPath || undefined,
      name: basenameFromPath(newPath) || newPath,
      aliases: baseAliases,
      source: 'task',
      lastAction: 'renamed',
      expectedExists: true,
      updatedAt,
    });

    if (targetPath && targetPath !== newPath) {
      mergeThreadMemoryFile(filesByPath, {
        path: targetPath,
        name: basenameFromPath(targetPath) || targetPath,
        aliases: baseAliases,
        source: 'task',
        lastAction: 'renamed',
        expectedExists: false,
        updatedAt,
      });
    }
    return;
  }

  const currentPath = newPath || targetPath;
  if (!currentPath) {
    return;
  }

  const lastAction: AgentThreadFileReference['lastAction'] = kind.includes('delete')
    ? 'deleted'
    : kind.includes('create')
      ? 'created'
      : 'edited';

  mergeThreadMemoryFile(filesByPath, {
    path: currentPath,
    name: basenameFromPath(currentPath) || currentPath,
    aliases: baseAliases,
    source: 'task',
    lastAction,
    expectedExists: lastAction !== 'deleted',
    updatedAt,
  });
}

function buildAgentThreadMemory(messages: AgentThreadMessage[], workspacePath: string | null): AgentThreadMemory | null {
  const filesByPath = new Map<string, AgentThreadFileReference>();

  for (const message of messages) {
    const updatedAt = message.createdAt || new Date().toISOString();
    for (const chip of messageContextChipsFromMetadata(message.metadata)) {
      const relativePath = threadMemoryPathFromContextChip(chip, workspacePath);
      if (!relativePath) {
        continue;
      }

      mergeThreadMemoryFile(filesByPath, {
        path: relativePath,
        name: chip.name || basenameFromPath(relativePath) || relativePath,
        aliases: [chip.name, chip.relativePath, chip.path],
        source: 'context',
        lastAction: 'attached',
        expectedExists: true,
        updatedAt,
      });
    }

    const taskList = asAgentTaskList(message.metadata?.taskList);
    if (taskList) {
      const taskUpdatedAt = taskList.updatedAt || updatedAt;
      for (const item of taskList.items) {
        addThreadMemoryForTask(filesByPath, item, taskUpdatedAt);
      }
    }
  }

  const files = [...filesByPath.values()]
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0) || left.path.localeCompare(right.path))
    .slice(0, THREAD_MEMORY_FILE_LIMIT);

  if (files.length === 0) {
    return null;
  }

  return {
    files,
    updatedAt: files[0]?.updatedAt,
  };
}

function taskActionLabel(item: Pick<AgentTaskItem, 'kind' | 'status'>) {
  const kind = item.kind.toLowerCase();
  if (kind.includes('delete')) {
    return 'Deleted';
  }
  if (kind.includes('move')) {
    return 'Moved';
  }
  if (kind.includes('rename')) {
    return 'Renamed';
  }
  if (kind.includes('create')) {
    return 'Created';
  }
  if (kind.includes('edit')) {
    return 'Edited';
  }

  return item.status === 'completed' ? 'Reviewed' : item.status;
}

function pendingTaskActionLabel(item: Pick<AgentTaskItem, 'kind'>) {
  const kind = item.kind.toLowerCase();
  if (kind.includes('delete')) {
    return 'Delete';
  }
  if (kind.includes('move')) {
    return 'Move';
  }
  if (kind.includes('rename')) {
    return 'Rename';
  }
  if (kind.includes('create')) {
    return 'Create';
  }
  if (kind.includes('edit') || kind.includes('update')) {
    return 'Update';
  }

  return 'Change';
}

function displayAgentWorkText(value: string) {
  return value
    .replace(/[A-Za-z]:[\\/][^\r\n]*?[\\/]Temp[\\/]tantalum-opencode-[^\\/\\s]+[\\/]workspace[\\/]?/gi, '')
    .replace(/\/tmp\/tantalum-opencode-[^\s/]+\/workspace\/?/gi, '')
    .replace(/\/var\/folders\/[^\r\n]*?\/T\/tantalum-opencode-[^\s/]+\/workspace\/?/gi, '')
    .replace(/\btantalum-opencode-[^\s/\\]+[\\/](?:workspace[\\/]?)?/gi, '')
    .replace(/\bModel request started\b/gi, 'Generating response')
    .replace(/\bModel request completed\b/gi, 'Response ready')
    .replace(/\bModel request failed\b/gi, 'Response failed')
    .replace(/\bModel response streamed\b/gi, 'Streaming response')
    .replace(/\bRetrying model request\b/gi, 'Retrying response')
    .replace(/\bWaiting for model\b/gi, 'Waiting for response')
    .replace(/\bmanaged gateway\b/gi, 'managed service')
    .replace(/\bTantalum gateway\b/gi, 'Tantalum AI')
    .replace(/\bGateway response\b/gi, 'Response')
    .replace(/\bopen\s*code\b/gi, 'Tantalum AI')
    .replace(/\bopencode\b/gi, 'Tantalum AI')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

type AgentWorkIconKind = 'file' | 'tool' | 'model' | 'workspace' | 'network' | 'runtime';

function AgentWorkIcon({ kind }: { kind: AgentWorkIconKind }) {
  const className = `agent-work-row-icon agent-work-row-icon-${kind}`;

  switch (kind) {
    case 'file':
      return <FileText size={12} className={className} />;
    case 'tool':
      return <Wrench size={12} className={className} />;
    case 'model':
      return <Cpu size={12} className={className} />;
    case 'workspace':
      return <Box size={12} className={className} />;
    case 'network':
      return <Cloud size={12} className={className} />;
    default:
      return <Terminal size={12} className={className} />;
  }
}

function taskWorkIconKind(item: Pick<AgentTaskItem, 'kind' | 'targetPath' | 'newPath'>): AgentWorkIconKind {
  const kind = item.kind.toLowerCase();

  if (item.targetPath || item.newPath || /\b(create|delete|edit|file|move|read|rename|update|write)\b/.test(kind)) {
    return 'file';
  }
  if (/\b(bash|call|command|shell|tool)\b/.test(kind)) {
    return 'tool';
  }
  if (/\b(model|prompt|response)\b/.test(kind)) {
    return 'model';
  }
  if (/\b(baseline|sandbox|snapshot|workspace)\b/.test(kind)) {
    return 'workspace';
  }

  return 'runtime';
}

function activityWorkIconKind(activity: Pick<AgentActivityEntry, 'title' | 'detail'>): AgentWorkIconKind {
  const title = activity.title.toLowerCase();
  const detail = activity.detail?.toLowerCase() ?? '';
  const text = `${title} ${detail}`;

  if (/\b(file|created|deleted|edited|renamed|wrote)\b/.test(text)) {
    return 'file';
  }
  if (/\b(tool|tool-calls?|function|bash|command|shell)\b/.test(text)) {
    return 'tool';
  }
  if (/\b(baseline|changes|copying|copied|sandbox|snapshot|workspace)\b/.test(text)) {
    return 'workspace';
  }
  if (/\b(model|prompt|response)\b/.test(text)) {
    return 'model';
  }
  if (/\b(bridge|gateway|listening|server|sse|stream)\b/.test(text)) {
    return 'network';
  }

  return 'runtime';
}

function liveWorkPhaseLabel({
  activity,
  taskList,
  isPreparing,
}: {
  activity: AgentActivityEntry | null;
  taskList: AgentTaskList | null;
  isPreparing: boolean;
}) {
  const runningTask = taskList?.items.find((item) => item.status === 'running');
  const runningTaskKind = runningTask?.kind.toLowerCase() ?? '';
  const runningTaskText = `${runningTaskKind} ${runningTask?.title ?? ''}`.toLowerCase();
  const hasPlannedTasks = Boolean(taskList?.items.length);

  if (runningTask && /\b(create|delete|edit|file|rename|update|write)\b/.test(runningTaskText)) {
    return 'Editing';
  }

  if (!activity) {
    return isPreparing ? 'Thinking' : 'Working';
  }

  const title = activity.title.toLowerCase();
  const detail = activity.detail?.toLowerCase() ?? '';
  const text = `${title} ${detail}`;

  if (activity.status === 'blocked' || activity.status === 'error') {
    return 'Paused';
  }
  if (/\b(applying changes|changes applied|live-applying|keep|revert)\b/.test(text)) {
    return 'Applying';
  }
  if (/\b(collecting changes|changes collected|review|scanning)\b/.test(text)) {
    return 'Reviewing';
  }
  if (/\b(tool:\s*(?:edit|patch|write)|created|deleted|edited|renamed|wrote|write file|file successfully)\b/.test(text)) {
    return 'Editing';
  }
  if (/\b(tool|tool-calls?|function|bash|command|shell)\b/.test(text)) {
    return 'Using Tools';
  }
  if (/\b(plan|planning|todo|task)\b/.test(text)) {
    return hasPlannedTasks ? 'Planning' : 'Thinking';
  }
  if (/\b(preparing|copying|copied|sandbox|snapshot|baseline|bridge|session|starting|started)\b/.test(text)) {
    return 'Preparing';
  }
  if (/\b(cleaning|cleanup|stopping|stopped|prompt completed|finished)\b/.test(text)) {
    return 'Finishing';
  }
  if (/\b(model|prompt|response|receiving|waiting|gateway|stream)\b/.test(text)) {
    return 'Generating';
  }

  return 'Working';
}

function taskSummaryLabel(taskList: AgentTaskList | null, activities: AgentActivityEntry[]) {
  if (taskList?.items.length) {
    const targetPaths = [...new Set(taskList.items.map(taskTargetPath).filter(Boolean))];
    const primaryTarget = targetPaths[0] ? basenameFromPath(targetPaths[0]) : null;
    const sectionLabel = `${taskList.items.length} ${taskList.items.length === 1 ? 'section' : 'sections'}`;
    return primaryTarget ? `Reviewed ${sectionLabel} of ${primaryTarget}` : `Reviewed ${sectionLabel}`;
  }

  if (activities.length > 0) {
    return `Processed ${activities.length} ${activities.length === 1 ? 'runtime step' : 'runtime steps'}`;
  }

  return null;
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

function threadMessagesNeedApproval(messages: AgentThreadMessage[]) {
  return Boolean(findLatestPendingAction(messages));
}

function threadSummaryLooksWaitingForApproval(thread: AgentThreadSummary) {
  const preview = thread.lastMessagePreview.toLowerCase();
  return (
    preview.includes('approve this workspace action') ||
    preview.includes('approve to run it') ||
    preview.includes('pending approval') ||
    preview.includes('needs approval') ||
    preview.includes('needs permission') ||
    preview.includes('permission before it can make changes')
  );
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

function taskListHasUnresolvedItems(taskList: AgentTaskList) {
  return taskList.items.some((item) => item.status === 'blocked' || item.status === 'pending' || item.status === 'running');
}

function findLatestUnresolvedTaskList(messages: AgentThreadMessage[]) {
  for (const message of [...messages].reverse()) {
    const taskList = asAgentTaskList(message.metadata?.taskList);
    if (taskList && taskListHasUnresolvedItems(taskList)) {
      return taskList;
    }
  }

  return null;
}

function findCompletedTaskReferences(messages: AgentThreadMessage[], prompt: string): AgentCompletedTaskReference[] {
  if (!promptReferencesCompletedTask(prompt)) {
    return [];
  }

  const references: AgentCompletedTaskReference[] = [];
  const seen = new Set<string>();
  for (const message of [...messages].reverse()) {
    const taskList = asAgentTaskList(message.metadata?.taskList);
    if (!taskList || seen.has(taskList.id)) {
      continue;
    }

    if (taskList.items.some((item) => item.status !== 'completed' && item.status !== 'skipped')) {
      continue;
    }

    const completedItems = taskList.items.filter((item) => item.status === 'completed');
    if (completedItems.length === 0) {
      continue;
    }

    seen.add(taskList.id);
    references.push({
      taskListId: taskList.id,
      actionId: taskList.actionId,
      completedAt: taskList.updatedAt,
      items: completedItems.slice(0, 8).map((item) => ({
        kind: item.kind,
        title: item.title,
        targetPath: item.targetPath,
        newPath: item.newPath,
        lineStart: item.lineStart,
        lineEnd: item.lineEnd,
        instruction: item.instruction,
        result: item.result,
      })),
    });

    if (references.length >= 3) {
      break;
    }
  }

  return references;
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
  triggerPrefix,
  triggerSuffix,
}: {
  value: string;
  options: { label: string; value: string; icon?: ReactNode }[];
  onChange: (val: string) => void;
  className?: string;
  placement?: 'top' | 'bottom';
  triggerPrefix?: ReactNode;
  triggerSuffix?: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
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
  const searchable = options.length > 5;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
    : options;
  const hasOptionIcons = options.some((option) => option.icon);

  return (
    <div
      ref={containerRef}
      className={`custom-dropdown-container ${className} ${isOpen ? 'open' : ''}`}
    >
      <button
        className="custom-dropdown-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((current) => !current);
          setQuery('');
        }}
      >
        {triggerPrefix ? <span className="custom-dropdown-trigger-affix" aria-hidden="true">{triggerPrefix}</span> : null}
        <span className="custom-dropdown-trigger-label">{selectedOption?.label}</span>
        {triggerSuffix ? <span className="custom-dropdown-trigger-affix" aria-hidden="true">{triggerSuffix}</span> : null}
      </button>
      {isOpen && (
        <div
          className={`custom-dropdown-menu custom-dropdown-menu-${placement}`}
          role="listbox"
        >
          {searchable ? (
            <div className="custom-dropdown-search">
              <Search size={13} />
              <input
                value={query}
                placeholder="Search"
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setIsOpen(false);
                  }
                }}
              />
              <Settings2 size={13} />
            </div>
          ) : null}
          <div className={`custom-dropdown-list ${hasOptionIcons ? 'has-option-icons' : ''}`}>
          {visibleOptions.map((opt) => (
            <button
              key={opt.value}
              className={`custom-dropdown-item ${hasOptionIcons ? 'has-option-icon' : ''} ${opt.value === value ? 'active' : ''}`}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              onClick={(e) => {
                e.stopPropagation();
                onChange(opt.value);
                setIsOpen(false);
                setQuery('');
              }}
            >
              {hasOptionIcons ? <span className="custom-dropdown-option-icon" aria-hidden="true">{opt.icon}</span> : null}
              <span className="custom-dropdown-label">{opt.label}</span>
            </button>
          ))}
          {visibleOptions.length === 0 ? <div className="custom-dropdown-empty">No matches</div> : null}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentPanel({
  user,
  workspacePath,
  activeTab,
  activeSelection = null,
  boardContext = null,
  localBoardContext = null,
  arduinoPreferences = null,
  pushConsole,
  pushToast,
  pendingReview = null,
  resolvingReview = false,
  reviewResolutionNotice = null,
  onAgentChangesPrepared,
  onPreviewAgentFile,
  onOpenContextFile,
  onResolveAgentChanges,
  restorePoints = [],
  onRestoreToMessage,
  defaultView = 'chat',
  hideChat = false,
  chatOnly = false,
  onOpenSettings,
  onClosePanel,
}: AgentPanelProps) {
  const workspaceKey = workspacePath?.trim() || null;
  const initialDisplayCache = useMemo(
    () => (hasAgentCloudConfiguration() ? readAgentPanelDisplayCache(user.$id, workspaceKey) : null),
    [user.$id, workspaceKey],
  );
  const [view, setView] = useState<AgentView>(defaultView);
  const [threadSummaries, setThreadSummaries] = useState<AgentThreadSummary[]>(() => initialDisplayCache?.threads ?? []);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentThreadMessage[]>([]);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [settings, setSettings] = useState<AgentSettingsState>(() => initialDisplayCache?.settings ?? createDefaultAgentSettings());
  const [hasLastKnownAgentData, setHasLastKnownAgentData] = useState(Boolean(initialDisplayCache));
  const [isViewingHistory, setIsViewingHistory] = useState(activeThreadId === null);
  const [composeTarget, setComposeTarget] = useState<AgentComposeTarget>('new');
  const [agentIntent, setAgentIntent] = useState<AgentIntent>('agent');
  const [agentPermissionMode, setAgentPermissionMode] = useState<AgentPermissionMode>('default');
  const [contextItems, setContextItems] = useState<AgentContextItem[]>([]);
  const [contextMention, setContextMention] = useState<ContextMentionRange | null>(null);
  const [contextFileSuggestions, setContextFileSuggestions] = useState<AgentContextFileSuggestion[]>([]);
  const [contextSuggestionsLoading, setContextSuggestionsLoading] = useState(false);
  const [previewImageContextItem, setPreviewImageContextItem] = useState<AgentImagePreview | null>(null);
  const [messageContextImagePreviews, setMessageContextImagePreviews] = useState<Map<string, string>>(() => new Map());
  const [contextDropActive, setContextDropActive] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [threadListExpanded, setThreadListExpanded] = useState(false);
  const [renameThreadPrompt, setRenameThreadPrompt] = useState<AgentThreadSummary | null>(null);
  const [renameThreadTitle, setRenameThreadTitle] = useState('');
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [agentIntentMenuOpen, setAgentIntentMenuOpen] = useState(false);
  const [contextAttachmentMenuOpen, setContextAttachmentMenuOpen] = useState(false);

  const [loadingSettings, setLoadingSettings] = useState(true);
  const [settingsBootstrapped, setSettingsBootstrapped] = useState(false);
  const [settingsCloudDataLoaded, setSettingsCloudDataLoaded] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparingThreadId, setPreparingThreadId] = useState<string | null>(null);
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [restoringMessageId, setRestoringMessageId] = useState<string | null>(null);
  const [unreadCompletedThreadIds, setUnreadCompletedThreadIds] = useState<Set<string>>(() => new Set());
  const [threadApprovalState, setThreadApprovalState] = useState<Map<string, boolean>>(() => new Map());
  const [liveTaskLists, setLiveTaskLists] = useState<Map<string, AgentTaskList>>(() => new Map());
  const [liveActivities, setLiveActivities] = useState<Map<string, AgentActivityEntry[]>>(() => new Map());
  const [thinkingDetailsOpen, setThinkingDetailsOpen] = useState(false);
  const [expandedWorkSummaryIds, setExpandedWorkSummaryIds] = useState<Set<string>>(() => new Set());
  const [composerReviewOpen, setComposerReviewOpen] = useState(true);
  const [composerTasksOpen, setComposerTasksOpen] = useState(false);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(EMPTY_CREDENTIAL_FORM);
  const [agentToolSettings, setAgentToolSettings] = useState<AgentToolSettingsResponse | null>(null);
  const [savingAgentToolId, setSavingAgentToolId] = useState<string | null>(null);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const contextImagePreviewRef = useRef<HTMLDivElement | null>(null);
  const contextDragDepthRef = useRef(0);
  const reviewNoticeIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(activeThreadId);
  const isViewingHistoryRef = useRef(isViewingHistory);
  const liveActivitiesRef = useRef<Map<string, AgentActivityEntry[]>>(new Map());
  const stopRequestedThreadIdsRef = useRef<Set<string>>(new Set());
  const contextMentionRef = useRef<ContextMentionRange | null>(contextMention);
  const settingsRef = useRef(settings);
  const settingsCloudDataLoadedRef = useRef(settingsCloudDataLoaded);
  const workspaceKeyRef = useRef<string | null>(workspaceKey);
  const previousWorkspaceKeyRef = useRef<string | null>(workspaceKey);
  const previousUserIdRef = useRef(user.$id);
  const threadRefreshRequestRef = useRef(0);
  const settingsRefreshRequestRef = useRef(0);
  const settingsUsageLoadedRef = useRef(false);
  const messageLoadRequestRef = useRef(0);
  const deferredPrompt = useDeferredValue(draftPrompt);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    isViewingHistoryRef.current = isViewingHistory;
  }, [isViewingHistory]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    settingsCloudDataLoadedRef.current = settingsCloudDataLoaded;
  }, [settingsCloudDataLoaded]);

  useEffect(() => {
    if (pendingReview?.id) {
      setComposerReviewOpen(true);
    }
  }, [pendingReview?.id]);

  useEffect(() => {
    contextMentionRef.current = contextMention;
  }, [contextMention]);

  useEffect(() => {
    workspaceKeyRef.current = workspaceKey;
    if (previousWorkspaceKeyRef.current === workspaceKey && previousUserIdRef.current === user.$id) {
      return;
    }

    previousWorkspaceKeyRef.current = workspaceKey;
    previousUserIdRef.current = user.$id;
    threadRefreshRequestRef.current += 1;
    settingsRefreshRequestRef.current += 1;
    settingsUsageLoadedRef.current = false;
    messageLoadRequestRef.current += 1;
    const cachedDisplay = hasAgentCloudConfiguration() ? readAgentPanelDisplayCache(user.$id, workspaceKey) : null;
    if (cachedDisplay) {
      settingsRef.current = cachedDisplay.settings;
      setSettings(cachedDisplay.settings);
      setThreadSummaries(threadsForWorkspace(cachedDisplay.threads, workspaceKey));
      setHasLastKnownAgentData(true);
    } else {
      const defaultSettings = createDefaultAgentSettings();
      settingsRef.current = defaultSettings;
      setSettings(defaultSettings);
      setThreadSummaries([]);
      setHasLastKnownAgentData(false);
    }
    settingsCloudDataLoadedRef.current = false;
    setSettingsCloudDataLoaded(false);
    setSettingsBootstrapped(false);
    setLoadingSettings(true);
    setSettingsLoadError(null);
    setThreadLoadError(null);
    activeThreadIdRef.current = null;
    setActiveThreadId(null);
    setMessages([]);
    setComposeTarget('new');
    setAgentPermissionMode('default');
    setIsViewingHistory(true);
    setSessionSearchQuery('');
    setThreadListExpanded(false);
    setRenameThreadPrompt(null);
    setRenameThreadTitle('');
    setRenamingThreadId(null);
    setContextItems([]);
    setContextMention(null);
    setContextFileSuggestions([]);
    setContextSuggestionsLoading(false);
    setPreviewImageContextItem(null);
    setMessageContextImagePreviews(new Map());
    setContextDropActive(false);
    contextDragDepthRef.current = 0;
    setUnreadCompletedThreadIds(new Set());
    setLiveTaskLists(new Map());
    liveActivitiesRef.current = new Map();
    setLiveActivities(new Map());
    setThinkingDetailsOpen(false);
    setExpandedWorkSummaryIds(new Set());
    setComposerTasksOpen(false);
    setLoadingMessages(false);
    setLoadingThreads(false);
    setThreadApprovalState(new Map());
    setPreparingThreadId(null);
    setRunningThreadId(null);
    setStoppingThreadId(null);
    setRestoringMessageId(null);
    stopRequestedThreadIdsRef.current.clear();
  }, [user.$id, workspaceKey]);

  useEffect(() => {
    if (!activeThreadId || loadingMessages) {
      return;
    }

    const waitingForApproval = threadMessagesNeedApproval(messages);
    setThreadApprovalState((current) => {
      if (current.get(activeThreadId) === waitingForApproval) {
        return current;
      }

      const next = new Map(current);
      next.set(activeThreadId, waitingForApproval);
      return next;
    });
  }, [activeThreadId, loadingMessages, messages]);

  useEffect(() => {
    const offProgress = window.tantalum.agent.onProgress((event: AgentProgressEvent) => {
      const activity = asAgentActivityEntry(event.activity);
      if (activity && event.threadId) {
        setLiveActivities((current) => {
          const next = new Map(current);
          const existing = next.get(event.threadId) ?? [];
          const withoutDuplicate = existing.filter((entry) => entry.id !== activity.id);
          next.set(event.threadId, [...withoutDuplicate, activity]);
          liveActivitiesRef.current = next;
          return next;
        });
      }

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

  useEffect(() => {
    let cancelled = false;

    async function loadToolSettings() {
      const result = await window.tantalum.agent.tools.listSettings();
      if (cancelled) {
        return;
      }

      if (result.success) {
        setAgentToolSettings({
          descriptors: result.descriptors,
          settings: result.settings,
          categories: result.categories,
        });
      } else {
        pushConsole(result.error || 'Unable to load agent tool settings.', 'error');
      }
    }

    void loadToolSettings();
    const offSettings = window.tantalum.agent.tools.onSettingsChanged((settings) => {
      if (!cancelled) {
        setAgentToolSettings(settings);
      }
    });

    return () => {
      cancelled = true;
      offSettings();
    };
  }, [pushConsole]);

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
  const isReplyingToThread = !isViewingHistory && composeTarget === 'thread' && Boolean(activeThreadId);
  const activeThread = useMemo(
    () => threadSummaries.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threadSummaries],
  );
  const activeFileSuggestion = useMemo(() => {
    if (!activeTab || contextItems.some((item) => isSameContextItem(item, { kind: 'file', path: activeTab.path }))) {
      return null;
    }

    return createActiveFileContextItem(activeTab);
  }, [activeTab, contextItems]);
  const activeSelectionSuggestion = useMemo(() => {
    if (!activeSelection) {
      return null;
    }

    const suggestion = createSelectionContextItem(activeSelection);
    if (contextItems.some((item) => isSameContextItem(item, suggestion))) {
      return null;
    }

    return suggestion;
  }, [activeSelection, contextItems]);
  const contextWindow = useMemo(() => {
    const managedWindow = preferences.defaultMode === 'power' ? metadata.powerContextWindow : metadata.fastContextWindow;
    return managedWindow ?? (preferences.defaultMode === 'power' ? FALLBACK_POWER_CONTEXT_WINDOW : FALLBACK_FAST_CONTEXT_WINDOW);
  }, [metadata.fastContextWindow, metadata.powerContextWindow, preferences.defaultMode]);
  const estimatedContextTokens = useMemo(() => {
    const threadMessages = isReplyingToThread ? toThreadContext(messages) : [];
    return (
      estimateAgentTokens(draftPrompt) +
      threadMessages.reduce((total, message) => total + estimateAgentTokens(message.content), 0) +
      contextItems.reduce((total, item) => total + estimateContextItemTokens(item) + 80, 0)
    );
  }, [contextItems, draftPrompt, isReplyingToThread, messages]);
  const contextPercent = contextWindow > 0 ? Math.min(100, (estimatedContextTokens / contextWindow) * 100) : 0;

  const creditBalance = getCreditBalance(settings.creditAccount);
  const managedHasCredits = creditBalance.remainingCredits > 0;
  const canUseManaged = settings.managedAvailable && managedHasCredits;
  const managedUnavailableMessage = !settings.managedAvailable
    ? 'Managed agent access is unavailable until a pool key is assigned.'
    : !managedHasCredits
      ? `Managed agent credit limit reached. ${formatCreditBalance(creditBalance.remainingCredits, creditBalance.monthlyAllowance)} credits remain${
          settings.creditAccount.resetAt ? ` until ${formatDetailedDate(settings.creditAccount.resetAt)}` : ''
        }.`
      : null;
  const canUseCustom = Boolean(selectedCredential && selectedModel);
  const loadingInitialAgentData = loadingSettings && !settingsBootstrapped && !hasLastKnownAgentData;
  const showingCloudConnectionState = hasCloudAgent && loadingSettings && !settingsCloudDataLoaded && !settingsLoadError;
  const showManagedUnavailableMessage = settingsCloudDataLoaded && preferences.selectedSource === 'managed' && managedUnavailableMessage;
  const canSend =
    Boolean(workspacePath) &&
    hasCloudAgent &&
    settingsCloudDataLoaded &&
    !busy &&
    deferredPrompt.trim().length > 0 &&
    (preferences.selectedSource === 'managed' ? canUseManaged : canUseCustom);
  const activeThreadIsRunning = Boolean(activeThreadId && runningThreadId === activeThreadId);
  const activeThreadIsPreparing = Boolean(activeThreadId && preparingThreadId === activeThreadId && !activeThreadIsRunning);
  const activeThreadCanStop = activeThreadIsRunning || activeThreadIsPreparing;
  const isStoppingActiveThread = Boolean(activeThreadId && stoppingThreadId === activeThreadId);
  const userMessageOrder = useMemo(() => {
    const order = new Map<string, number>();
    messages.forEach((message) => {
      if (message.role === 'user') {
        order.set(message.id, order.size);
      }
    });
    return order;
  }, [messages]);
  const activeThreadRestorePoints = useMemo(
    () => restorePoints.filter((point) => !activeThreadId || point.threadId === activeThreadId),
    [activeThreadId, restorePoints],
  );
  const agentIntentLabel = agentIntent === 'ask' ? 'Ask' : 'Agent';
  const agentIntentDescription = agentIntent === 'ask' ? 'Ask mode answers without changing files.' : 'Agent mode can apply Project edits with revert available.';
  const threadSearchQuery = sessionSearchOpen ? sessionSearchQuery.trim().toLowerCase() : '';
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

  useEffect(() => {
    setThreadListExpanded(false);
  }, [threadSearchQuery, workspaceKey]);

  const closeAgentMenus = useCallback(() => {
    setAgentIntentMenuOpen(false);
    setContextAttachmentMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!agentIntentMenuOpen && !contextAttachmentMenuOpen) {
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
  }, [agentIntentMenuOpen, closeAgentMenus, contextAttachmentMenuOpen]);

  useEffect(() => {
    if (!contextMention || !workspacePath) {
      setContextFileSuggestions([]);
      setContextSuggestionsLoading(false);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setContextSuggestionsLoading(true);
      const response = await window.tantalum.workspace.suggestContextFiles({
        query: contextMention.query,
        maxResults: 3,
      });

      if (cancelled) {
        return;
      }

      setContextSuggestionsLoading(false);
      if (!response.success) {
        setContextFileSuggestions([]);
        return;
      }

      setContextFileSuggestions(response.files);
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [contextMention, workspacePath]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    setContextItems((current) => {
      let changed = false;
      const nextItems = current.map((item) => {
        if (normalizeContextPathKey(item.path) !== normalizeContextPathKey(activeTab.path)) {
          return item;
        }

        const content =
          item.kind === 'selection' && item.lineStart && item.lineEnd
            ? getLineRangeContent(activeTab.content, item.lineStart, item.lineEnd).content
            : activeTab.content;
        const tokenEstimate = estimateAgentTokens(content);
        if (item.content === content && item.isDirty === activeTab.isDirty && item.tokenEstimate === tokenEstimate && item.source === 'active-editor') {
          return item;
        }

        changed = true;
        return {
          ...item,
          content,
          isDirty: activeTab.isDirty,
          tokenEstimate,
          originalTokenEstimate: item.originalTokenEstimate ?? tokenEstimate,
          source: 'active-editor' as const,
        };
      });

      return changed ? nextItems : current;
    });
  }, [activeTab]);

  useEffect(() => {
    if (!previewImageContextItem || previewImageContextItem.source !== 'composer' || !previewImageContextItem.contextItem) {
      return;
    }

    if (!contextItems.some((item) => isSameContextItem(item, previewImageContextItem.contextItem as AgentContextItem))) {
      setPreviewImageContextItem(null);
    }
  }, [contextItems, previewImageContextItem]);

  useEffect(() => {
    if (!previewImageContextItem) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (contextImagePreviewRef.current?.contains(target)) {
        return;
      }

      if (target instanceof Element && target.closest('.tantalum-ai-context-attached-chip.image')) {
        return;
      }

      if (target instanceof Element && target.closest('.agent-message-context-chip.image')) {
        return;
      }

      setPreviewImageContextItem(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [previewImageContextItem]);

  const updateContextMentionFromTextarea = useCallback(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      setContextMention(null);
      return;
    }

    setContextMention(detectContextMention(textarea.value, textarea.selectionStart ?? textarea.value.length));
  }, []);

  const consumeContextMention = useCallback((nextPrompt: string, range: ContextMentionRange | null) => {
    if (!range) {
      setDraftPrompt(nextPrompt);
      return;
    }

    const before = nextPrompt.slice(0, range.start);
    const after = nextPrompt.slice(range.end);
    const separator = before && after && !/\s$/.test(before) && !/^\s/.test(after) ? ' ' : '';
    const updatedPrompt = `${before}${separator}${after}`.replace(/[ \t]{2,}/g, ' ');
    setDraftPrompt(updatedPrompt);
    setContextMention(null);

    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) {
        return;
      }

      const cursor = Math.min(updatedPrompt.length, before.length + separator.length);
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }, []);

  const addContextItem = useCallback((item: AgentContextItem, replaceMention = true) => {
    const normalizedItem = {
      ...item,
      id: contextItemId(item.kind, item.path, item.lineStart, item.lineEnd),
      tokenEstimate: item.tokenEstimate ?? estimateAgentTokens(item.content || ''),
      originalTokenEstimate: item.originalTokenEstimate ?? item.tokenEstimate ?? estimateAgentTokens(item.content || ''),
    };

    setContextItems((current) => {
      if (current.some((entry) => isSameContextItem(entry, normalizedItem))) {
        return current;
      }

      return [...current, normalizedItem];
    });

    if (replaceMention) {
      consumeContextMention(draftPrompt, contextMentionRef.current);
    }
  }, [consumeContextMention, draftPrompt]);

  const removeContextItem = useCallback((item: AgentContextItem) => {
    setContextItems((current) => current.filter((entry) => !isSameContextItem(entry, item)));
  }, []);

  const insertAtMention = useCallback(() => {
    const textarea = composerTextareaRef.current;
    const cursor = textarea?.selectionStart ?? draftPrompt.length;
    const nextPrompt = `${draftPrompt.slice(0, cursor)}@${draftPrompt.slice(cursor)}`;
    const nextCursor = cursor + 1;
    setDraftPrompt(nextPrompt);

    window.requestAnimationFrame(() => {
      const nextTextarea = composerTextareaRef.current;
      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextCursor, nextCursor);
      setContextMention(detectContextMention(nextPrompt, nextCursor));
    });
  }, [draftPrompt]);

  const handlePickContextAttachments = useCallback(async () => {
    if (!workspacePath || busy) {
      return;
    }

    setContextAttachmentMenuOpen(false);
    setContextMention(null);
    let response: Awaited<ReturnType<typeof window.tantalum.workspace.pickContextAttachments>>;
    try {
      if (typeof window.tantalum.workspace.pickContextAttachments !== 'function') {
        pushToast('Restart Tantalum IDE to enable file attachments.', 'info');
        return;
      }

      response = await window.tantalum.workspace.pickContextAttachments();
      if (!response.success) {
        pushToast(response.error || 'Unable to attach files as context.', 'error');
        return;
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to open the attachment picker.', 'error');
      return;
    }

    for (const item of response.items) {
      addContextItem(item, false);
    }

    if (response.items.length > 0) {
      pushToast(`Attached ${response.items.length} context ${response.items.length === 1 ? 'item' : 'items'}.`, 'success');
    }

    const rejected = response.rejected ?? [];
    rejected.slice(0, 3).forEach((entry) => {
      pushToast(`${entry.name}: ${entry.reason}`, 'error');
    });
    if (rejected.length > 3) {
      pushToast(`${rejected.length - 3} more selected files were rejected.`, 'error');
    }
  }, [addContextItem, busy, pushToast, workspacePath]);

  const addDroppedContextAttachments = useCallback(async (files: File[]) => {
    if (!workspacePath || busy || files.length === 0) {
      return;
    }

    let aggregateImageDataUrlChars = contextItems.reduce((total, item) => total + (item.kind === 'image' && item.dataUrl ? item.dataUrl.length : 0), 0);
    const rejected: Array<{ name: string; reason: string }> = [];
    let attachedCount = 0;

    for (const file of files.slice(0, AGENT_ATTACHMENT_MAX_DROPPED_FILES)) {
      try {
        const attachment = await createDroppedAttachmentContextItem(file, aggregateImageDataUrlChars);
        if ('rejected' in attachment && attachment.rejected) {
          rejected.push(attachment.rejected);
          continue;
        }

        if ('item' in attachment && attachment.item) {
          addContextItem(attachment.item, false);
          attachedCount += 1;
          aggregateImageDataUrlChars += attachment.imageDataUrlChars || 0;
        }
      } catch (error) {
        rejected.push({
          name: sanitizeAttachmentName(file.name),
          reason: error instanceof Error ? error.message : 'Unable to attach this file.',
        });
      }
    }

    if (files.length > AGENT_ATTACHMENT_MAX_DROPPED_FILES) {
      rejected.push({
        name: 'Additional dropped files',
        reason: `Only ${AGENT_ATTACHMENT_MAX_DROPPED_FILES} files can be attached at once.`,
      });
    }

    if (attachedCount > 0) {
      pushToast(`Attached ${attachedCount} context ${attachedCount === 1 ? 'item' : 'items'}.`, 'success');
    }

    rejected.slice(0, 3).forEach((entry) => {
      pushToast(`${entry.name}: ${entry.reason}`, 'error');
    });
    if (rejected.length > 3) {
      pushToast(`${rejected.length - 3} more dropped files were rejected.`, 'error');
    }
  }, [addContextItem, busy, contextItems, pushToast, workspacePath]);

  const handleContextDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!workspacePath || busy || !hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    contextDragDepthRef.current += 1;
    setContextDropActive(true);
  }, [busy, workspacePath]);

  const handleContextDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!workspacePath || busy || !hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setContextDropActive(true);
  }, [busy, workspacePath]);

  const handleContextDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    contextDragDepthRef.current = Math.max(0, contextDragDepthRef.current - 1);
    if (contextDragDepthRef.current === 0) {
      setContextDropActive(false);
    }
  }, []);

  const handleContextDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!workspacePath || busy || !hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    contextDragDepthRef.current = 0;
    setContextDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    void addDroppedContextAttachments(files);
  }, [addDroppedContextAttachments, busy, workspacePath]);

  const rememberMessageContextImagePreviews = useCallback((items: AgentContextItem[]) => {
    const imageEntries = items
      .filter((item) => item.kind === 'image' && typeof item.dataUrl === 'string' && item.dataUrl.length > 0)
      .map((item) => [item.id || contextItemId(item.kind, item.path, item.lineStart, item.lineEnd), item.dataUrl as string] as const);

    if (imageEntries.length === 0) {
      return;
    }

    setMessageContextImagePreviews((current) => {
      const next = new Map(current);
      imageEntries.forEach(([id, dataUrl]) => next.set(id, dataUrl));
      return next;
    });
  }, []);

  const resolveContextItemsForRun = useCallback(async () => {
    const resolvedItems: AgentContextItem[] = [];
    const rejectedItems: AgentContextItem[] = [];

    for (const item of contextItems) {
      try {
        if (item.source === 'attachment' || item.kind === 'image') {
          const tokenEstimate = estimateContextItemTokens(item);
          resolvedItems.push({
            ...item,
            id: contextItemId(item.kind, item.path, item.lineStart, item.lineEnd),
            tokenEstimate,
            originalTokenEstimate: item.originalTokenEstimate ?? tokenEstimate,
          });
          continue;
        }

        if (activeTab && normalizeContextPathKey(item.path) === normalizeContextPathKey(activeTab.path)) {
          const content =
            item.kind === 'selection' && item.lineStart && item.lineEnd
              ? getLineRangeContent(activeTab.content, item.lineStart, item.lineEnd).content
              : activeTab.content;
          const tokenEstimate = estimateAgentTokens(content);
          resolvedItems.push({
            ...item,
            content,
            isDirty: activeTab.isDirty,
            tokenEstimate,
            originalTokenEstimate: item.originalTokenEstimate ?? tokenEstimate,
            source: 'active-editor',
          });
          continue;
        }

        const response = await window.tantalum.workspace.readContextFile({
          path: item.path,
          lineStart: item.kind === 'selection' ? item.lineStart ?? null : null,
          lineEnd: item.kind === 'selection' ? item.lineEnd ?? null : null,
        });
        if (!response.success) {
          pushToast(`${contextItemLabel(item)} was not added to context: ${response.error}`, 'error');
          rejectedItems.push(item);
          continue;
        }

        const tokenEstimate = estimateAgentTokens(response.content);
        resolvedItems.push({
          ...response,
          id: contextItemId(response.kind, response.path, response.lineStart, response.lineEnd),
          tokenEstimate,
          originalTokenEstimate: item.originalTokenEstimate ?? tokenEstimate,
        });
      } catch (error) {
        pushToast(`${contextItemLabel(item)} was not added to context: ${error instanceof Error ? error.message : 'Unable to read file.'}`, 'error');
        rejectedItems.push(item);
      }
    }

    if (rejectedItems.length > 0) {
      setContextItems((current) => current.filter((entry) => !rejectedItems.some((rejected) => isSameContextItem(entry, rejected))));
    }

    return resolvedItems;
  }, [activeTab, contextItems, pushToast]);

  const refreshThreads = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const targetWorkspaceKey = workspaceKey;
    const requestId = ++threadRefreshRequestRef.current;

    if (!hasCloudAgent || !targetWorkspaceKey) {
      setThreadSummaries([]);
      setLoadingThreads(false);
      setThreadLoadError(null);
      return;
    }

    setLoadingThreads(true);
    try {
      const nextThreads = await listAgentThreads(targetWorkspaceKey, { bypassCache: options.bypassCache });
      if (threadRefreshRequestRef.current !== requestId || workspaceKeyRef.current !== targetWorkspaceKey) {
        return;
      }
      const scopedThreads = threadsForWorkspace(nextThreads, targetWorkspaceKey);
      setThreadSummaries((current) => [
        ...current.filter((thread) => isLocalThreadId(thread.id) && !scopedThreads.some((entry) => entry.id === thread.id)),
        ...scopedThreads,
      ]);
      if (settingsCloudDataLoadedRef.current) {
        writeAgentPanelDisplayCache(user.$id, targetWorkspaceKey, settingsRef.current, scopedThreads);
        setHasLastKnownAgentData(true);
      }
      setThreadLoadError(null);
    } catch (error) {
      if (threadRefreshRequestRef.current === requestId && workspaceKeyRef.current === targetWorkspaceKey) {
        setThreadLoadError(agentCloudLoadErrorMessage(error, 'threads'));
      }
    } finally {
      if (threadRefreshRequestRef.current === requestId && workspaceKeyRef.current === targetWorkspaceKey) {
        setLoadingThreads(false);
      }
    }
  }, [hasCloudAgent, user.$id, workspaceKey]);

  const refreshAgentSettings = useCallback(async (showErrors = true, options: { includeUsage?: boolean; bypassCache?: boolean } = {}) => {
    const targetWorkspaceKey = workspaceKey;
    const requestId = ++settingsRefreshRequestRef.current;
    const includeUsage = options.includeUsage ?? settingsUsageLoadedRef.current;

    if (!hasCloudAgent) {
      setSettings(createDefaultAgentSettings());
      setThreadSummaries([]);
      setLoadingSettings(false);
      setSettingsBootstrapped(true);
      setSettingsCloudDataLoaded(false);
      settingsCloudDataLoadedRef.current = false;
      setHasLastKnownAgentData(false);
      setSettingsLoadError(null);
      setThreadLoadError(null);
      return;
    }

    setLoadingSettings(true);
    try {
      const nextSettings = await loadAgentSettings(targetWorkspaceKey, { includeUsage, bypassCache: options.bypassCache });
      if (settingsRefreshRequestRef.current !== requestId || workspaceKeyRef.current !== targetWorkspaceKey) {
        return;
      }
      if (includeUsage) {
        settingsUsageLoadedRef.current = true;
      }
      const mergedSettings = {
        ...nextSettings,
        recentUsage: includeUsage ? nextSettings.recentUsage : settingsRef.current.recentUsage,
      };
      settingsRef.current = mergedSettings;
      setSettings(mergedSettings);
      const scopedThreads = threadsForWorkspace(nextSettings.recentThreads, targetWorkspaceKey);
      setThreadSummaries((current) => [
        ...current.filter((thread) => isLocalThreadId(thread.id) && !scopedThreads.some((entry) => entry.id === thread.id)),
        ...scopedThreads,
      ]);
      writeAgentPanelDisplayCache(user.$id, targetWorkspaceKey, mergedSettings, scopedThreads);
      setHasLastKnownAgentData(true);
      setSettingsCloudDataLoaded(true);
      settingsCloudDataLoadedRef.current = true;
      setSettingsLoadError(null);
      setThreadLoadError(null);
      const currentActiveThreadId = activeThreadIdRef.current;
      if (currentActiveThreadId && !isLocalThreadId(currentActiveThreadId) && !scopedThreads.some((thread) => thread.id === currentActiveThreadId)) {
        setActiveThreadId(null);
        setMessages([]);
        setComposeTarget('new');
        setIsViewingHistory(true);
      }
    } catch (error) {
      if (showErrors && settingsRefreshRequestRef.current === requestId && workspaceKeyRef.current === targetWorkspaceKey) {
        setSettingsLoadError(agentCloudLoadErrorMessage(error, 'settings'));
      }
    } finally {
      if (settingsRefreshRequestRef.current === requestId && workspaceKeyRef.current === targetWorkspaceKey) {
        setLoadingSettings(false);
        setSettingsBootstrapped(true);
      }
    }
  }, [hasCloudAgent, user.$id, workspaceKey]);

  async function persistPreferences(nextPreferences: AgentPreferences, options: PersistPreferencesOptions = {}) {
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
      const saved = await saveAgentPreferences(sanitizedPreferences, {
        includeCustomModelName: options.includeCustomModelName,
      });
      setSettings((current) => ({ ...current, preferences: saved }));
    } catch (error) {
      if (options.suppressCustomModelSchemaError && isUnknownSelectedCustomModelError(error)) {
        return;
      }

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
  }

  function resetComposerContext() {
    setContextItems([]);
    setContextMention(null);
    setContextFileSuggestions([]);
    setContextSuggestionsLoading(false);
  }

  function setThreadWaitingForApproval(threadId: string | null | undefined, waitingForApproval: boolean) {
    if (!threadId) {
      return;
    }

    setThreadApprovalState((current) => {
      if (current.get(threadId) === waitingForApproval) {
        return current;
      }

      const next = new Map(current);
      next.set(threadId, waitingForApproval);
      return next;
    });
  }

  function threadIsWaitingForApproval(thread: AgentThreadSummary) {
    return threadApprovalState.get(thread.id) ?? threadSummaryLooksWaitingForApproval(thread);
  }

  function showThreadHistory() {
    if (activeThreadIdRef.current) {
      setThreadWaitingForApproval(activeThreadIdRef.current, threadMessagesNeedApproval(messages));
    }
    messageLoadRequestRef.current += 1;
    activeThreadIdRef.current = null;
    setActiveThreadId(null);
    setComposeTarget('new');
    setMessages([]);
    setLoadingMessages(false);
    resetComposerContext();
    setIsViewingHistory(true);
    setView('chat');
    setThinkingDetailsOpen(false);
    setComposerTasksOpen(false);
    closeAgentMenus();
  }

  async function openThread(threadId: string) {
    const requestId = ++messageLoadRequestRef.current;
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
    setComposeTarget('thread');
    setIsViewingHistory(false);
    setMessages([]);
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
      const nextMessages = await loadAgentThreadMessages(threadId);
      if (messageLoadRequestRef.current !== requestId || activeThreadIdRef.current !== threadId) {
        return;
      }
      setThreadWaitingForApproval(threadId, threadMessagesNeedApproval(nextMessages));
      setMessages(nextMessages);
    } catch (error) {
      if (messageLoadRequestRef.current !== requestId || activeThreadIdRef.current !== threadId) {
        return;
      }
      pushToast(error instanceof Error ? error.message : 'Unable to load this thread.', 'error');
      activeThreadIdRef.current = null;
      setActiveThreadId(null);
      setComposeTarget('new');
      setMessages([]);
      setIsViewingHistory(true);
    } finally {
      if (messageLoadRequestRef.current === requestId && activeThreadIdRef.current === threadId) {
        setLoadingMessages(false);
      }
    }
  }

  function startBlankThread() {
    messageLoadRequestRef.current += 1;
    activeThreadIdRef.current = null;
    setActiveThreadId(null);
    setComposeTarget('new');
    setMessages([]);
    setLoadingMessages(false);
    resetComposerContext();
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

  function clearThreadStopRequest(threadId: string | null | undefined) {
    if (!threadId) {
      return;
    }

    stopRequestedThreadIdsRef.current.delete(threadId);
  }

  function transferThreadStopRequest(fromThreadId: string | null | undefined, toThreadId: string | null | undefined) {
    if (!fromThreadId || !toThreadId || !stopRequestedThreadIdsRef.current.has(fromThreadId)) {
      return;
    }

    stopRequestedThreadIdsRef.current.delete(fromThreadId);
    stopRequestedThreadIdsRef.current.add(toThreadId);
    setStoppingThreadId((current) => (current === fromThreadId ? toThreadId : current));
  }

  function throwIfThreadStopRequested(threadId: string | null | undefined) {
    if (threadId && stopRequestedThreadIdsRef.current.has(threadId)) {
      throw new Error(AGENT_RUN_STOPPED_MESSAGE);
    }
  }

  async function executeAgentRun({
    threadId,
    prompt,
    activeTabContext,
    contextItems,
    threadMessages,
    approvedAction = null,
    taskList = null,
    completedTaskReferences = [],
    threadMemory = null,
    userMessageId = null,
    userMessageCreatedAt = null,
  }: {
    threadId: string;
    prompt: string;
    activeTabContext: AgentRunPayload['activeTab'];
    contextItems: AgentContextItem[];
    threadMessages: NonNullable<AgentRunPayload['threadMessages']>;
    approvedAction?: PendingAgentAction | null;
    taskList?: AgentTaskList | null;
    completedTaskReferences?: AgentCompletedTaskReference[];
    threadMemory?: AgentThreadMemory | null;
    userMessageId?: string | null;
    userMessageCreatedAt?: string | null;
  }) {
    let wasStopped = false;
    let refreshedAgentData = false;

    clearThreadStopRequest(threadId);
    setBusy(true);
    setView('chat');
    setPreparingThreadId((current) => (current === threadId ? null : current));
    setRunningThreadId(threadId);
    setStoppingThreadId(null);
    setThinkingDetailsOpen(false);
    setComposerTasksOpen(false);
    setLiveActivities((current) => {
      const next = new Map(current);
      next.delete(threadId);
      liveActivitiesRef.current = next;
      return next;
    });
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

      throwIfThreadStopRequested(threadId);
      const result = await window.tantalum.agent.run({
        prompt,
        source: preferences.selectedSource,
        mode: preferences.defaultMode,
        intent: agentIntent,
        permissionMode: agentPermissionMode,
        threadId,
        customCredentialId: preferences.selectedSource === 'custom' ? selectedCredential?.id : null,
        customModelName: preferences.selectedSource === 'custom' ? selectedModel : null,
        fastContextWindow: metadata.fastContextWindow,
        powerContextWindow: metadata.powerContextWindow,
        threadMessages,
        activeTab: activeTabContext,
        contextItems,
        boardContext,
        localBoardContext,
        arduinoPreferences,
        pendingAction: approvedAction,
        taskList,
        completedTaskReferences,
        threadMemory,
        approvedActionId: approvedAction?.id ?? null,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      pushConsole(result.output, 'info');
      const resultRoute = isRecord(result.route) ? result.route : null;
      const resultTaskList = resultRoute?.decisionKind === 'clarify' ? null : asAgentTaskList(result.taskList) ?? taskList;
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
      if (approvedAction) {
        setThreadWaitingForApproval(threadId, actionStatus === 'blocked');
      }
      const runActivities = liveActivitiesRef.current.get(threadId) ?? [];
      const assistantMetadata = approvedAction
        ? {
            pendingActionStatus: {
              actionId: approvedAction.id,
              status: actionStatus,
            },
            ...(resultTaskList ? { taskList: resultTaskList } : {}),
            ...(runActivities.length > 0 ? { activities: runActivities } : {}),
          }
        : resultTaskList || runActivities.length > 0
          ? {
              ...(resultTaskList ? { taskList: resultTaskList } : {}),
              ...(runActivities.length > 0 ? { activities: runActivities } : {}),
            }
          : undefined;

      const assistantMessage = await createAgentThreadMessage({
        threadId,
        role: 'assistant',
        content: clampAgentMessageContent(result.output),
        metadata: assistantMetadata,
      });
      setMessages((current) => [...current, assistantMetadata ? { ...assistantMessage, metadata: assistantMetadata } : assistantMessage]);

      const recommendedToolAction = Array.isArray(result.meta?.recommendedToolActions)
        ? result.meta.recommendedToolActions.map(asPendingAgentAction).find(Boolean) ?? null
        : null;
      if (recommendedToolAction) {
        const pendingAction: PendingAgentAction = {
          ...recommendedToolAction,
          threadId,
          userMessageId: userMessageId ?? approvedAction?.userMessageId ?? null,
          userMessageCreatedAt: userMessageCreatedAt ?? approvedAction?.userMessageCreatedAt ?? null,
          status: 'pending',
        };
        const toolRequest = pendingAction.toolRequest;
        const permissionMessage = toolRequest?.approvalReason || toolRequest?.summary || 'Approve this IDE tool action to run it, or skip it.';
        const pendingMessage = await createAgentThreadMessage({
          threadId,
          role: 'assistant',
          content: permissionMessage,
          metadata: {
            pendingAction,
          },
        });
        setMessages((current) => [...current, { ...pendingMessage, metadata: { pendingAction } }]);
        setThreadWaitingForApproval(threadId, true);
        pushConsole('Waiting for approval before installing an Arduino dependency suggested from generated code.', 'info');
      }

      const skippedFiles = Array.isArray(result.skippedFiles) ? result.skippedFiles : [];
      if (skippedFiles.length > 0) {
        pushConsole(
          `Agent preparation skipped ${skippedFiles.length} non-reviewable Project ${skippedFiles.length === 1 ? 'file' : 'files'}.`,
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
          userMessageId: userMessageId ?? approvedAction?.userMessageId ?? null,
          userMessageCreatedAt: userMessageCreatedAt ?? approvedAction?.userMessageCreatedAt ?? null,
        });

        await appendAgentStatusMessage(
          threadId,
          `Applied ${reviewFiles.length} Project ${reviewFiles.length === 1 ? 'change' : 'changes'}. Keep or revert them from the editor review bar.`,
          'warning',
          {
            action: 'opencode_live_applied',
            fileCount: reviewFiles.length,
            ...(resultTaskList ? { taskList: resultTaskList } : {}),
          },
        );
      }

      await refreshAgentSettings(false);
      refreshedAgentData = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The agent run failed.';
      wasStopped = message === AGENT_RUN_STOPPED_MESSAGE;
      await appendAgentStatusMessage(threadId, message, wasStopped ? 'warning' : 'error', approvedAction
        ? {
            pendingActionStatus: {
              actionId: approvedAction.id,
              status: 'blocked',
            },
            ...(taskList ? { taskList: taskListWithStatus(taskList, 'blocked') } : {}),
          }
        : undefined);
      if (approvedAction) {
        setThreadWaitingForApproval(threadId, true);
      }
      if (!wasStopped) {
        pushToast(message, 'error');
      }
    } finally {
      setBusy(false);
      setRunningThreadId((current) => (current === threadId ? null : current));
      setPreparingThreadId((current) => (current === threadId ? null : current));
      setStoppingThreadId((current) => (current === threadId ? null : current));
      clearThreadStopRequest(threadId);
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
      if (!refreshedAgentData) {
        await refreshThreads();
      }
    }
  }

  async function handleSendPrompt() {
    const prompt = draftPrompt.trim();
    if (!prompt) {
      return;
    }

    if (!workspacePath) {
      pushToast('Open a Project before starting Tantalum AI.', 'info');
      return;
    }

    if (preferences.selectedSource === 'custom' && (!selectedCredential || !selectedModel)) {
      pushToast('Choose an enabled custom credential and model first.', 'info');
      openAgentSettingsView();
      return;
    }

    let threadId = isReplyingToThread ? activeThreadId : null;
    const optimisticThreadId = threadId ? null : createLocalThreadId();
    const displayThreadId = threadId ?? optimisticThreadId;
    const priorMessages = isReplyingToThread ? messages : [];
    const latestPendingAction = findLatestPendingAction(priorMessages);
    const latestTaskList = latestPendingAction
      ? liveTaskLists.get(`action:${latestPendingAction.id}`) ?? findLatestTaskList(priorMessages, latestPendingAction.id)
      : findLatestUnresolvedTaskList(priorMessages);
    const completedTaskReferences = latestPendingAction ? [] : findCompletedTaskReferences(priorMessages, prompt);
    const threadMemory = buildAgentThreadMemory(priorMessages, workspacePath);
    const activeTabContext = activeTab;
    const messageContextChips = createMessageContextChips(contextItems);
    const userMessageMetadata = messageContextChips.length > 0 ? { contextChips: messageContextChips } : undefined;
    const localUserMessage = displayThreadId ? createLocalThreadMessage('user', prompt, undefined, userMessageMetadata, displayThreadId) : null;
    rememberMessageContextImagePreviews(contextItems);

    messageLoadRequestRef.current += 1;
    setLoadingMessages(false);
    setDraftPrompt('');
    setContextItems([]);
    setContextMention(null);
    setPreviewImageContextItem(null);
    setBusy(true);
    if (displayThreadId) {
      clearThreadStopRequest(displayThreadId);
      setPreparingThreadId(displayThreadId);
      setStoppingThreadId(null);
    }
    setView('chat');
    setThinkingDetailsOpen(false);
    setComposerTasksOpen(false);
    if (displayThreadId) {
      setLiveActivities((current) => {
        if (!current.has(displayThreadId)) {
          liveActivitiesRef.current = current;
          return current;
        }

        const next = new Map(current);
        next.delete(displayThreadId);
        liveActivitiesRef.current = next;
        return next;
      });
    }
    closeAgentMenus();

    if (localUserMessage) {
      setMessages((current) => (isReplyingToThread ? [...current, localUserMessage] : [localUserMessage]));
    }

    if (optimisticThreadId) {
      activeThreadIdRef.current = optimisticThreadId;
      isViewingHistoryRef.current = false;
      setActiveThreadId(optimisticThreadId);
      setComposeTarget('thread');
      setIsViewingHistory(false);
      setThinkingDetailsOpen(false);
      setComposerTasksOpen(false);
      setThreadSummaries((current) => [
        createLocalThreadSummary({
          id: optimisticThreadId,
          title: titleFromPrompt(prompt),
          workspaceKey: workspacePath,
          workspaceName: basenameFromPath(workspacePath),
          lastMessagePreview: prompt,
        }),
        ...current.filter((thread) => thread.id !== optimisticThreadId),
      ]);
    }

    try {
      const resolvedContextItems = await resolveContextItemsForRun();
      throwIfThreadStopRequested(displayThreadId);
      const initialRunContext = shrinkAgentRunContext({
        prompt,
        threadMessages: toThreadContext(priorMessages),
        contextItems: resolvedContextItems,
        contextWindow,
      });
      const baseRunPayload: AgentRunPayload = {
        prompt,
        source: preferences.selectedSource,
        mode: preferences.defaultMode,
        intent: agentIntent,
        permissionMode: agentPermissionMode,
        threadId,
        customCredentialId: preferences.selectedSource === 'custom' ? selectedCredential?.id : null,
        customModelName: preferences.selectedSource === 'custom' ? selectedModel : null,
        fastContextWindow: metadata.fastContextWindow,
        powerContextWindow: metadata.powerContextWindow,
        threadMessages: initialRunContext.threadMessages,
        activeTab: activeTabContext,
        contextItems: initialRunContext.contextItems,
        boardContext,
        localBoardContext,
        arduinoPreferences,
        pendingAction: latestPendingAction,
        taskList: latestTaskList,
        completedTaskReferences,
        threadMemory,
      };

      const routed = await window.tantalum.agent.route(baseRunPayload);
      if (!routed.success) {
        throw new Error(routed.error);
      }
      throwIfThreadStopRequested(displayThreadId);

      if (!routed.persistThread) {
        if (threadId) {
          const userMessage = await createAgentThreadMessage({ threadId, role: 'user', content: prompt, metadata: userMessageMetadata });
          const assistantMessage = await createAgentThreadMessage({
            threadId,
            role: 'assistant',
            content: routed.userMessage || 'Tell me what you want to inspect, explain, or change.',
          });
          setMessages((current) => [
            ...replaceOptimisticMessage(current, localUserMessage?.id ?? null, userMessage, priorMessages),
            assistantMessage,
          ]);
          setView('chat');
          await refreshThreads();
        } else {
          if (optimisticThreadId) {
            setThreadSummaries((current) => current.filter((thread) => thread.id !== optimisticThreadId));
          }
          activeThreadIdRef.current = null;
          isViewingHistoryRef.current = false;
          setActiveThreadId(null);
          setComposeTarget('new');
          setIsViewingHistory(false);
          setMessages([
            createLocalThreadMessage('user', prompt, undefined, userMessageMetadata),
            createLocalThreadMessage('assistant', routed.userMessage || 'Tell me what you want to inspect, explain, or change.'),
          ]);
        }
        return;
      }

      if (!threadId) {
        const createdThread = await createAgentThread({
          title: formatThreadTitle(routed.titleSuggestion || titleFromPrompt(prompt)),
          workspaceKey: workspacePath,
          workspaceName: basenameFromPath(workspacePath),
        });
        threadId = createdThread.id;
        activeThreadIdRef.current = threadId;
        isViewingHistoryRef.current = false;
        setActiveThreadId(threadId);
        setComposeTarget('thread');
        setThreadSummaries((current) => [
          createdThread,
          ...current.filter((thread) => thread.id !== createdThread.id && thread.id !== optimisticThreadId),
        ]);
        transferThreadStopRequest(optimisticThreadId, createdThread.id);
        setPreparingThreadId((current) => (current === optimisticThreadId ? createdThread.id : current));
        setMessages((current) =>
          current.map((message) => (message.threadId === optimisticThreadId ? { ...message, threadId: createdThread.id } : message)),
        );
        setIsViewingHistory(false);
        throwIfThreadStopRequested(threadId);
      }

      const runThreadId = threadId;
      if (!runThreadId) {
        throw new Error('Unable to attach this agent run to a thread.');
      }

      const userMessage = await createAgentThreadMessage({ threadId: runThreadId, role: 'user', content: prompt, metadata: userMessageMetadata });
      setMessages((current) => replaceOptimisticMessage(current, localUserMessage?.id ?? null, userMessage, priorMessages));
      setView('chat');
      throwIfThreadStopRequested(runThreadId);
      const routedTaskList = asAgentTaskList(routed.taskList);

      if (routed.decisionKind === 'clarify') {
        const assistantMessage = await createAgentThreadMessage({
          threadId: runThreadId,
          role: 'assistant',
          content: routed.userMessage || 'I need a clearer target before changing the Project.',
          tone: 'warning',
        });
        setMessages((current) => [...current, assistantMessage]);
        await refreshThreads();
        return;
      }

      if (routed.requiresUserDecision && routed.pendingAction) {
        const pendingAction: PendingAgentAction = {
          ...routed.pendingAction,
          threadId: runThreadId,
          userMessageId: userMessage.id,
          userMessageCreatedAt: userMessage.createdAt ?? null,
          status: 'pending',
        };
        const pendingTaskList = routedTaskList ? { ...routedTaskList, actionId: pendingAction.id } : null;
        const assistantMessage = await createAgentThreadMessage({
          threadId: runThreadId,
          role: 'assistant',
          content: routed.userMessage || 'Approve this Project action to run it, or skip it.',
          metadata: {
            pendingAction,
            ...(pendingTaskList ? { taskList: pendingTaskList } : {}),
          },
        });
        setMessages((current) => [...current, assistantMessage]);
        setThreadWaitingForApproval(runThreadId, true);
        pushConsole('Waiting for approval before running Project changes.', 'info');
        await refreshThreads();
        return;
      }

      const approvedAction = routed.reason === 'approved_pending_action' || routed.reason === 'approved_tool_action'
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
        activeTabContext,
        ...shrinkAgentRunContext({
          prompt: approvedAction?.originalPrompt ?? prompt,
          threadMessages: toThreadContext(runPriorMessages),
          contextItems: resolvedContextItems,
          contextWindow,
        }),
        approvedAction,
        taskList: runTaskList,
        completedTaskReferences: approvedAction ? [] : completedTaskReferences,
        threadMemory,
        userMessageId: userMessage.id,
        userMessageCreatedAt: userMessage.createdAt ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The agent run failed.';
      const wasStopped = message === AGENT_RUN_STOPPED_MESSAGE;
      if (threadId) {
        try {
          const errorMessage = await createAgentThreadMessage({
            threadId,
            role: 'status',
            content: message,
            tone: wasStopped ? 'warning' : 'error',
          });
          setMessages((current) => [...current, errorMessage]);
        } catch {
          if (!wasStopped) {
            pushToast(message, 'error');
          }
        }
      } else if (optimisticThreadId) {
        if (wasStopped) {
          setMessages((current) => [...current, createLocalThreadMessage('status', message, 'warning', undefined, optimisticThreadId)]);
        } else {
          activeThreadIdRef.current = null;
          setActiveThreadId(null);
          setComposeTarget('new');
          setThreadSummaries((current) => current.filter((thread) => thread.id !== optimisticThreadId));
          setMessages((current) => [...current, createLocalThreadMessage('status', message, 'error')]);
          pushToast(message, 'error');
        }
      } else {
        if (!wasStopped) {
          pushToast(message, 'error');
        }
      }
    } finally {
      setBusy(false);
      setPreparingThreadId((current) => (current === threadId || current === optimisticThreadId ? null : current));
      setStoppingThreadId((current) => (current === threadId || current === optimisticThreadId ? null : current));
      clearThreadStopRequest(threadId);
      clearThreadStopRequest(optimisticThreadId);
    }
  }

  async function handleStopRunningThread(threadIdOverride?: string) {
    const targetThreadId = threadIdOverride || activeThreadId;
    const targetIsRunning = Boolean(targetThreadId && runningThreadId === targetThreadId);
    const targetIsPreparing = Boolean(targetThreadId && preparingThreadId === targetThreadId);
    if (!targetThreadId || (!targetIsRunning && !targetIsPreparing) || stoppingThreadId === targetThreadId) {
      return;
    }

    stopRequestedThreadIdsRef.current.add(targetThreadId);
    setStoppingThreadId(targetThreadId);
    if (!targetIsRunning) {
      return;
    }

    try {
      const result = await window.tantalum.agent.stop({ threadId: targetThreadId });
      if (!result.success) {
        throw new Error(result.error);
      }

      if (!result.stopped && !busy) {
        setStoppingThreadId(null);
      }
    } catch (error) {
      setStoppingThreadId(null);
      clearThreadStopRequest(targetThreadId);
      pushToast(error instanceof Error ? error.message : 'Unable to stop the agent run.', 'error');
    }
  }

  function messageHasRestorePoint(message: AgentThreadMessage) {
    if (message.role !== 'user') {
      return false;
    }

    const selectedIndex = userMessageOrder.get(message.id);
    if (selectedIndex === undefined) {
      return false;
    }

    return activeThreadRestorePoints.some((point) => {
      const pointIndex = userMessageOrder.get(point.userMessageId);
      return pointIndex !== undefined && pointIndex >= selectedIndex;
    });
  }

  async function handleRestoreMessage(message: AgentThreadMessage) {
    if (!onRestoreToMessage || message.role !== 'user' || restoringMessageId || busy || activeThreadCanStop) {
      return;
    }

    if (!messageHasRestorePoint(message)) {
      pushToast('No agent file changes are available to restore from this message.', 'info');
      return;
    }

    const confirmed = window.confirm(
      'Restore files touched by Tantalum AI after this message and remove later chat messages from this thread?',
    );
    if (!confirmed) {
      return;
    }

    setRestoringMessageId(message.id);
    try {
      const result = await onRestoreToMessage(message, messages);
      if (result) {
        setMessages(result.messages);
        setThreadWaitingForApproval(message.threadId, threadMessagesNeedApproval(result.messages));
        setLiveTaskLists(new Map());
        setLiveActivities((current) => {
          const next = new Map(current);
          next.delete(message.threadId);
          liveActivitiesRef.current = next;
          return next;
        });
        setUnreadCompletedThreadIds((current) => {
          if (!current.has(message.threadId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(message.threadId);
          return next;
        });
        await refreshThreads();
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to restore this agent point.', 'error');
    } finally {
      setRestoringMessageId((current) => (current === message.id ? null : current));
    }
  }

  async function approvePendingAgentAction(actionId: string) {
    if (busy || activeThreadIsRunning) {
      return;
    }

    if (agentIntent === 'ask') {
      pushToast('Switch to Agent mode to approve Project changes.', 'info');
      return;
    }

    if (!workspacePath) {
      pushToast('Open a Project before running this action.', 'info');
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
    const resolvedContextItems = await resolveContextItemsForRun();
    const threadMemory = buildAgentThreadMemory(messages, workspacePath);
    setThreadWaitingForApproval(threadId, false);
    await executeAgentRun({
      threadId,
      prompt: action.originalPrompt,
      activeTabContext: activeTab,
      ...shrinkAgentRunContext({
        prompt: action.originalPrompt,
        threadMessages: toThreadContext(messages),
        contextItems: resolvedContextItems,
        contextWindow,
      }),
      approvedAction: action,
      taskList,
      threadMemory,
      userMessageId: action.userMessageId ?? null,
      userMessageCreatedAt: action.userMessageCreatedAt ?? null,
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
    setThreadWaitingForApproval(threadId, false);
    await refreshThreads();
  }

  function handleRenameThread(thread: AgentThreadSummary) {
    setRenameThreadPrompt(thread);
    setRenameThreadTitle(thread.title);
  }

  async function submitThreadRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameThreadPrompt) {
      return;
    }

    const title = formatThreadTitle(renameThreadTitle);
    if (!title) {
      pushToast('Thread title is required.', 'info');
      return;
    }

    if (title === renameThreadPrompt.title) {
      setRenameThreadPrompt(null);
      setRenameThreadTitle('');
      return;
    }

    setRenamingThreadId(renameThreadPrompt.id);
    try {
      const updated = await renameAgentThread(renameThreadPrompt.id, title);
      setThreadSummaries((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setRenameThreadPrompt(null);
      setRenameThreadTitle('');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to rename thread.', 'error');
    } finally {
      setRenamingThreadId(null);
    }
  }

  async function handleDeleteThread(thread: AgentThreadSummary) {
    if (!window.confirm(`Delete "${thread.title}"?`)) {
      return;
    }

    try {
      await deleteAgentThread(thread.id);
      setThreadSummaries((current) => current.filter((entry) => entry.id !== thread.id));
      setThreadApprovalState((current) => {
        if (!current.has(thread.id)) {
          return current;
        }

        const next = new Map(current);
        next.delete(thread.id);
        return next;
      });
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
    void refreshAgentSettings(true, { includeUsage: false });
  }, [refreshAgentSettings, user.$id]);

  useEffect(() => {
    if (view !== 'settings' || !settingsBootstrapped || settingsUsageLoadedRef.current) {
      return;
    }

    void refreshAgentSettings(false, { includeUsage: true });
  }, [refreshAgentSettings, settingsBootstrapped, view]);

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
      <div className="tantalum-ai-header">
        <div className="tantalum-ai-header-title">
          <button className="tantalum-ai-tab-title" type="button" title="View Threads" onClick={showThreadHistory}>
            Ask Tantalum AI
          </button>
        </div>
        <div className="tantalum-ai-header-actions">
          <button className="ghost-button compact icon-only" type="button" title="New Thread" onClick={startBlankThread}>
            <Plus size={16} />
          </button>
          <button className="ghost-button compact icon-only" type="button" title="Agent Settings" onClick={openAgentSettingsView}>
            <Settings size={16} />
          </button>
          <span className="tantalum-ai-header-divider"></span>
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
      <div className="agent-tabs tantalum-ai-tabs">
        {!hideChat ? (
          <button className={view === 'chat' ? 'active' : ''} type="button" onClick={showThreadHistory}>
            <MessageSquare size={14} />
            Chat
          </button>
        ) : null}
        <button className={view === 'settings' ? 'active' : ''} type="button" onClick={() => setView('settings')}>
          <Settings2 size={14} />
          Settings
        </button>
      </div>
    );
  }

  function renderBottomStatusBar() {
    const { remainingCredits, monthlyAllowance } = creditBalance;
    const creditPercent = monthlyAllowance > 0 ? Math.max(0, Math.min(100, (remainingCredits / monthlyAllowance) * 100)) : 0;
    const creditsExhausted = remainingCredits <= 0;
    const radius = 5.5;
    const strokeWidth = 1.6;
    const circ = 2 * Math.PI * radius; // ~34.55
    const strokeDashoffset = circ - (creditPercent / 100) * circ;

    return (
      <div className="tantalum-ai-bottom-status-bar">
        <div className="status-bar-left">
          <div
            className="status-item-dropdown tantalum-ai-status-permission-wrapper"
            title={
              agentPermissionMode === 'bypass'
                ? 'Bypass intermediate approval prompts; final Keep/Revert review still applies.'
                : 'Ask for approval before high-risk Project actions.'
            }
          >
            <KeyRound size={12} />
            <CustomDropdown
              className="status-permission-dropdown"
              value={agentPermissionMode}
              options={[
                { label: 'Default Approval', value: 'default', icon: <ShieldCheck size={13} /> },
                { label: 'Bypass Approval', value: 'bypass', icon: <TriangleAlert size={13} /> },
              ]}
              placement="top"
              onChange={(val) => setAgentPermissionMode(val as AgentPermissionMode)}
            />
            <ChevronDown size={11} className="status-permission-chevron" />
          </div>
        </div>
        <div className="status-bar-right">
          <div
            className={`tantalum-ai-context-badge ${contextPercent >= 90 ? 'warning' : ''}`}
            title={`Estimated context: ${formatCompactTokens(estimatedContextTokens)} / ${formatCompactTokens(contextWindow)} tokens`}
          >
            <AtSign size={10} className="tantalum-ai-context-badge-icon" aria-hidden="true" />
            <strong>{formatCompactTokens(estimatedContextTokens)}</strong>
            <em>{formatCompactTokens(contextWindow)}</em>
          </div>
          <div
            className={`tantalum-ai-credit-badge ${creditsExhausted ? 'exhausted' : ''}`}
            title={`Remaining credits: ${formatCreditBalance(remainingCredits, monthlyAllowance)} (${creditPercent.toFixed(0)}% left)`}
          >
            <svg className="tantalum-ai-svg-loader" width="14" height="14" viewBox="0 0 14 14">
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
                stroke={creditPercent > 20 ? "var(--text-muted)" : "var(--error, #e51c23)"}
                strokeWidth={strokeWidth}
                fill="none"
                strokeDasharray={circ}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(-90 7 7)"
              />
            </svg>
            <span className="credits-amount">{formatCreditBalance(remainingCredits, monthlyAllowance)}</span>
          </div>
        </div>
      </div>
    );
  }

  function renderComposerReviewPanel() {
    if (!pendingReview) {
      return null;
    }

    return (
      <section className={`agent-composer-review-panel ${composerReviewOpen ? 'open' : ''}`} aria-label="Files awaiting review">
        <div className="agent-composer-review-head">
          <button
            className="agent-composer-review-toggle"
            type="button"
            aria-expanded={composerReviewOpen}
            onClick={() => setComposerReviewOpen((current) => !current)}
            title={composerReviewOpen ? 'Hide files awaiting review' : 'Show files awaiting review'}
          >
            {composerReviewOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>
              {pendingReview.files.length} {pendingReview.files.length === 1 ? 'file' : 'files'} awaiting review
            </span>
          </button>
          <div className="agent-composer-review-actions">
            <button
              className="agent-composer-review-action accept"
              type="button"
              disabled={resolvingReview}
              onClick={() => void resolveAgentReviewFromChat(true)}
            >
              {resolvingReview ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
              <span>Keep</span>
            </button>
            <button
              className="agent-composer-review-action decline"
              type="button"
              disabled={resolvingReview}
              onClick={() => void resolveAgentReviewFromChat(false)}
            >
              <X size={13} />
              <span>Revert</span>
            </button>
          </div>
        </div>
        {composerReviewOpen ? (
          <div className="agent-composer-review-file-list">
            {pendingReview.files.map((file) => {
              const fileName = basenameFromPath(file.path) ?? file.path;
              const directoryName = dirnameFromPath(file.path);

              return (
                <button
                  key={file.path}
                  className={`agent-composer-review-file agent-composer-review-file-${file.changeType}`}
                  type="button"
                  onClick={() => onPreviewAgentFile?.(file.path)}
                  title={`Preview ${file.path}`}
                >
                  <ContextSuggestionFileIcon filePath={file.path} />
                  <span className="agent-composer-review-file-name">{fileName}</span>
                  {directoryName ? <span className="agent-composer-review-file-dir">{directoryName}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  }

  function renderComposer() {
    const composerTaskList = isViewingHistory ? null : getLatestVisibleTaskList();
    const taskTotal = composerTaskList?.items.length ?? 0;
    const taskCompleted = composerTaskList?.items.filter((item) => item.status === 'completed' || item.status === 'skipped').length ?? 0;
    const taskRunning = composerTaskList?.items.find((item) => item.status === 'running');
    const mentionSuggestionItems = contextFileSuggestions
      .map(createWorkspaceSuggestionContextItem)
      .filter((item) => !contextItems.some((entry) => isSameContextItem(entry, item)))
      .filter((item) => !activeFileSuggestion || !isSameContextItem(item, activeFileSuggestion))
      .slice(0, 3);
    const firstMentionSuggestion = mentionSuggestionItems[0] ?? activeSelectionSuggestion ?? activeFileSuggestion ?? null;
    const hasContextRow = contextItems.length > 0 || Boolean(activeSelectionSuggestion) || Boolean(activeFileSuggestion);
    const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (contextMention) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setContextMention(null);
          return;
        }

        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          if (firstMentionSuggestion) {
            addContextItem(firstMentionSuggestion);
          }
          return;
        }
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (canSend) {
          void handleSendPrompt();
        }
      }
    };

    return (
      <div className="tantalum-ai-composer-container">
        {renderComposerReviewPanel()}

        {composerTaskList ? (
          <div className={`agent-composer-tasks ${composerTasksOpen ? 'open' : ''}`}>
            <button
              className="agent-composer-tasks-toggle"
              type="button"
              aria-expanded={composerTasksOpen}
              onClick={() => setComposerTasksOpen((current) => !current)}
              title={composerTasksOpen ? 'Hide todo list' : 'Show todo list'}
            >
              {composerTasksOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Todos</span>
              <strong>({taskCompleted}/{taskTotal})</strong>
              {taskRunning ? <em>{taskRunning.title}</em> : null}
            </button>
            {composerTasksOpen ? (
              <div className="agent-composer-task-list">
                {composerTaskList.items.map((item) => (
                  <div key={item.id} className={`agent-composer-task agent-composer-task-${item.status}`}>
                    <span className="agent-composer-task-check" aria-hidden="true">
                      {item.status === 'completed' || item.status === 'skipped' ? <Check size={15} /> : null}
                    </span>
                    <div>
                      <strong>{item.title}</strong>
                      {item.result || item.error ? <p>{item.result || item.error}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="tantalum-ai-composer-input-shell">
          {hasContextRow ? (
            <div className="tantalum-ai-context-chip-row">
              {contextItems.map((item) => (
                <span
                  key={item.id}
                  className={`tantalum-ai-context-chip tantalum-ai-context-attached-chip ${item.kind === 'selection' ? 'selection' : ''} ${item.kind === 'image' ? 'image previewable' : ''}`}
                  role={item.kind === 'image' ? 'button' : undefined}
                  tabIndex={item.kind === 'image' ? 0 : undefined}
                  title={item.kind === 'image' ? `Preview ${contextItemLabel(item)}` : undefined}
                  onClick={() => {
                    if (item.kind === 'image') {
                      setPreviewImageContextItem((current) =>
                        current?.source === 'composer' && current.contextItem && isSameContextItem(current.contextItem, item)
                          ? null
                          : {
                              id: item.id,
                              name: contextItemLabel(item),
                              dataUrl: item.dataUrl || '',
                              source: 'composer',
                              contextItem: item,
                            },
                      );
                    }
                  }}
                  onKeyDown={(event) => {
                    if (item.kind !== 'image' || (event.key !== 'Enter' && event.key !== ' ')) {
                      return;
                    }

                    event.preventDefault();
                    setPreviewImageContextItem((current) =>
                      current?.source === 'composer' && current.contextItem && isSameContextItem(current.contextItem, item)
                        ? null
                        : {
                            id: item.id,
                            name: contextItemLabel(item),
                            dataUrl: item.dataUrl || '',
                            source: 'composer',
                            contextItem: item,
                          },
                    );
                  }}
                >
                  <button
                    className="chip-close-btn"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeContextItem(item);
                    }}
                    title={`Remove ${contextItemLabel(item)} from context`}
                  >
                    <X size={10} />
                  </button>
                  <ContextItemIcon item={item} />
                  <span className="chip-filename">{contextItemLabel(item)}</span>
                </span>
              ))}
              {activeSelectionSuggestion ? (
                <button
                  className="tantalum-ai-context-chip tantalum-ai-context-suggestion-chip selection"
                  type="button"
                  title={`Add ${contextItemLabel(activeSelectionSuggestion)} to context`}
                  onClick={() => addContextItem(activeSelectionSuggestion, false)}
                >
                  <span className="chip-plus-accent">+</span>
                  <ContextSuggestionFileIcon filePath={activeSelectionSuggestion.path} />
                  <span className="chip-filename">{contextItemLabel(activeSelectionSuggestion)}</span>
                </button>
              ) : null}
              {activeFileSuggestion ? (
                <button
                  className="tantalum-ai-context-chip tantalum-ai-context-suggestion-chip"
                  type="button"
                  title={`Add ${activeFileSuggestion.name} to context`}
                  onClick={() => addContextItem(activeFileSuggestion, false)}
                >
                  <span className="chip-plus-accent">+</span>
                  <ContextSuggestionFileIcon filePath={activeFileSuggestion.path} />
                  <span className="chip-filename">{activeFileSuggestion.name}</span>
                </button>
              ) : null}
            </div>
          ) : null}

        {previewImageContextItem?.dataUrl ? (
          <div ref={contextImagePreviewRef} className="context-image-preview-popover" role="dialog" aria-label={`Preview ${previewImageContextItem.name}`}>
            <div className="context-image-preview-header">
              <span>{previewImageContextItem.name}</span>
              <button type="button" onClick={() => setPreviewImageContextItem(null)} title="Close preview">
                <X size={12} />
              </button>
            </div>
            <img src={previewImageContextItem.dataUrl} alt={previewImageContextItem.name} />
          </div>
        ) : null}

        {contextMention ? (
          <div className="context-mention-menu" role="listbox" aria-label="Context file suggestions">
            {contextSuggestionsLoading ? <div className="context-mention-empty">Searching...</div> : null}
            {!contextSuggestionsLoading && mentionSuggestionItems.length === 0 ? <div className="context-mention-empty">No matching files</div> : null}
            {!contextSuggestionsLoading
              ? mentionSuggestionItems.map((item, index) => (
                  <button
                    key={item.id}
                    className={`context-mention-item ${index === 0 ? 'active' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={index === 0}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => addContextItem(item)}
                  >
                    <FileText size={13} />
                    <span>{item.relativePath || item.name}</span>
                  </button>
                ))
              : null}
          </div>
        ) : null}

        <textarea
          ref={composerTextareaRef}
          className="tantalum-ai-composer-textarea"
          value={draftPrompt}
          disabled={!workspacePath || busy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraftPrompt(value);
            setContextMention(detectContextMention(value, event.currentTarget.selectionStart ?? value.length));
          }}
          onClick={updateContextMentionFromTextarea}
          onKeyUp={updateContextMentionFromTextarea}
          onSelect={updateContextMentionFromTextarea}
          placeholder={
            loadingInitialAgentData
              ? 'Loading agent...'
              : workspacePath
              ? isReplyingToThread && activeThread
                ? 'Ask for follow-up changes'
                : agentIntent === 'ask'
                  ? 'Ask about this Project'
                  : 'Start a new agent thread'
              : 'Open a Project to start coding'
          }
          rows={2}
          onKeyDown={handleComposerKeyDown}
        />

        <div className="tantalum-ai-composer-bottom">
          <div className="bottom-left-actions">
            <div className="agent-menu-root composer-attachment-menu">
              <button
                className="composer-action-btn composer-attach-btn"
                type="button"
                title="Add context"
                disabled={!workspacePath || busy}
                aria-haspopup="menu"
                aria-expanded={contextAttachmentMenuOpen}
                onClick={() => {
                  setContextMention(null);
                  setContextAttachmentMenuOpen((current) => !current);
                }}
              >
                <Plus size={14} />
              </button>
              {contextAttachmentMenuOpen ? (
                <div className="agent-popup-menu agent-popup-menu-left agent-popup-menu-up composer-attachment-popup" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setContextAttachmentMenuOpen(false);
                      insertAtMention();
                    }}
                  >
                    <AtSign size={13} />
                    <span>Mentions</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void handlePickContextAttachments()}
                  >
                    <Paperclip size={13} />
                    <span>Photos & files</span>
                  </button>
                </div>
              ) : null}
            </div>
            <span className="composer-action-divider">|</span>
            <div className="agent-menu-root composer-participant-menu">
              <button
                className={`composer-participant-pill composer-participant-button ${agentIntent === 'ask' ? 'active' : ''}`}
                type="button"
                title={agentIntentDescription}
                aria-haspopup="menu"
                aria-expanded={agentIntentMenuOpen}
                onClick={() => setAgentIntentMenuOpen((current) => !current)}
              >
                {agentIntent === 'ask' ? (
                  <MessageSquare size={11} className="composer-participant-icon" />
                ) : (
                  <Code size={11} className="composer-participant-icon composer-participant-agent-icon" />
                )}
                <span>{agentIntentLabel}</span>
              </button>
              {agentIntentMenuOpen ? (
                <div className="agent-popup-menu agent-popup-menu-left agent-popup-menu-up" role="menu">
                  <button className={agentIntent === 'agent' ? 'active' : ''} type="button" role="menuitem" onClick={() => selectAgentIntent('agent')}>
                    <Code size={13} className="composer-participant-menu-icon composer-participant-menu-agent-icon" />
                    <span>Agent mode</span>
                  </button>
                  <button className={agentIntent === 'ask' ? 'active' : ''} type="button" role="menuitem" onClick={() => selectAgentIntent('ask')}>
                    <MessageSquare size={13} className="composer-participant-menu-icon" />
                    <span>Ask mode</span>
                  </button>
                </div>
              ) : null}
            </div>
            <span className="composer-action-divider">|</span>
            <div className="composer-mode-picker" title="Run mode">
              <CustomDropdown
                className="composer-mode-dropdown"
                value={preferences.defaultMode}
                triggerPrefix={preferences.defaultMode === 'power' ? <Sparkles size={11} /> : <Zap size={11} />}
                options={[
                  { label: 'Fast', value: 'fast', icon: <Zap size={13} /> },
                  { label: 'Power', value: 'power', icon: <Sparkles size={13} /> },
                ]}
                placement="top"
                onChange={(val) => {
                  void persistPreferences(
                    {
                      ...preferences,
                      defaultMode: val as 'fast' | 'power',
                    },
                    {
                      includeCustomModelName: false,
                      suppressCustomModelSchemaError: true,
                    },
                  );
                }}
              />
            </div>
          </div>

          <div className="bottom-right-actions">
            <button
              className={`tantalum-ai-send-btn ${activeThreadCanStop ? 'tantalum-ai-stop-btn' : ''}`}
              type="button"
              title={
                activeThreadCanStop
                  ? isStoppingActiveThread
                    ? 'Stopping agent run'
                    : 'Stop agent run'
                  : loadingInitialAgentData
                    ? 'Loading agent'
                    : 'Send message'
              }
              disabled={activeThreadCanStop ? isStoppingActiveThread : !canSend}
              onClick={() => {
                if (activeThreadCanStop) {
                  void handleStopRunningThread();
                  return;
                }

                void handleSendPrompt();
              }}
            >
              {activeThreadCanStop ? (
                isStoppingActiveThread ? <LoaderCircle size={12} className="spin" /> : <CircleStop size={14} />
              ) : busy ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <SendHorizontal size={14} />
              )}
            </button>
          </div>
        </div>
        </div>
      </div>
    );
  }

  function renderThreadList() {
    const showFullThreadList = sessionSearchOpen;
    const hasThreadOverflow = !showFullThreadList && visibleThreadSummaries.length > THREAD_HISTORY_PREVIEW_LIMIT;
    const previewThreadSummaries = showFullThreadList ? visibleThreadSummaries : visibleThreadSummaries.slice(0, THREAD_HISTORY_PREVIEW_LIMIT);
    const overflowThreadSummaries = showFullThreadList ? [] : visibleThreadSummaries.slice(THREAD_HISTORY_PREVIEW_LIMIT);
    const hiddenThreadCount = Math.max(0, visibleThreadSummaries.length - THREAD_HISTORY_PREVIEW_LIMIT);
    const showThreadListLoading = (loadingThreads || loadingInitialAgentData) && threadSummaries.length === 0;
    const renderThreadItem = (thread: AgentThreadSummary) => {
      const isRunning = thread.id === runningThreadId;
      const isPreparing = thread.id === preparingThreadId && !isRunning;
      const isInFlight = isRunning || isPreparing;
      const isStopping = thread.id === stoppingThreadId;
      const isReviewPending = pendingReview?.threadId === thread.id;
      const isReviewResolving = isReviewPending && resolvingReview;
      const isWaitingForApproval = !isReviewPending && threadIsWaitingForApproval(thread);
      const hasUnreadCompletion = unreadCompletedThreadIds.has(thread.id);
      const threadTitle = formatThreadTitle(thread.title);
      const stateKind = isPreparing
        ? 'preparing'
        : isRunning
          ? 'running'
          : isReviewResolving
            ? 'review-resolving'
            : isReviewPending
              ? 'review'
              : isWaitingForApproval
                ? 'approval'
                : hasUnreadCompletion
                  ? 'completed'
                  : null;
      const stateLabel = isPreparing
        ? isStopping
          ? 'Stopping'
          : 'Preparing'
        : isRunning
          ? isStopping
            ? 'Stopping'
            : 'Running'
          : isReviewResolving
            ? 'Resolving review'
            : isReviewPending
              ? 'Review changes'
              : isWaitingForApproval
                ? 'Waiting for approval'
                : hasUnreadCompletion
                  ? 'Completed'
                  : null;

      return (
        <article
          key={thread.id}
          className={`tantalum-ai-thread-item ${isInFlight ? 'running' : ''} ${isWaitingForApproval ? 'waiting-approval' : ''} ${isReviewPending ? 'waiting-review' : ''} ${hasUnreadCompletion ? 'unread-complete' : ''}`}
        >
          <span className="tantalum-ai-thread-leading" aria-hidden="true">
            {isInFlight || isReviewResolving ? (
              <LoaderCircle size={12} className="spin tantalum-ai-thread-spinner" />
            ) : isReviewPending ? (
              <ShieldCheck size={12} className="tantalum-ai-thread-review-icon" />
            ) : isWaitingForApproval ? (
              <TriangleAlert size={12} className="tantalum-ai-thread-approval-icon" />
            ) : hasUnreadCompletion ? (
              <span className="tantalum-ai-thread-complete-dot" />
            ) : (
              <span className="tantalum-ai-thread-bullet" />
            )}
          </span>
          <button type="button" className="tantalum-ai-thread-main-btn" onClick={() => void openThread(thread.id)}>
            <span className="tantalum-ai-thread-title-text">{threadTitle}</span>
            <span className="tantalum-ai-thread-meta-row">
              {stateKind && stateLabel ? (
                <span className={`tantalum-ai-thread-state tantalum-ai-thread-state-${stateKind}`}>{stateLabel}</span>
              ) : null}
              <span className="tantalum-ai-thread-time-sub">
                {formatRelativeTime(thread.lastMessageAt)}
              </span>
            </span>
          </button>
          <div className="tantalum-ai-thread-item-actions">
            {isInFlight ? (
              <button
                className="tantalum-ai-thread-stop-btn"
                type="button"
                title={isStopping ? 'Stopping agent run' : 'Stop agent run'}
                disabled={isStopping}
                onClick={() => void handleStopRunningThread(thread.id)}
              >
                {isStopping ? <LoaderCircle size={13} className="spin" /> : <CircleStop size={14} />}
              </button>
            ) : null}
            <button type="button" title="Rename" onClick={() => void handleRenameThread(thread)}>
              <PencilLine size={14} />
            </button>
            <button type="button" title="Delete" onClick={() => void handleDeleteThread(thread)}>
              <Trash2 size={14} />
            </button>
          </div>
        </article>
      );
    };

    return (
      <div className="tantalum-ai-sessions-view">
        <div className="tantalum-ai-sessions-toolbar">
          <span className="sessions-title">THREADS</span>
          <div className="sessions-toolbar-buttons">
            <button
              className={`ghost-button compact icon-only ${sessionSearchOpen ? 'active' : ''}`}
              type="button"
              title="Search Threads"
              aria-pressed={sessionSearchOpen}
              onClick={() => {
                if (sessionSearchOpen) {
                  setSessionSearchQuery('');
                }
                setSessionSearchOpen((current) => !current);
                setThreadListExpanded(false);
              }}
            >
              <Search size={15} />
            </button>
            <button className="ghost-button compact icon-only" type="button" title="Refresh" onClick={() => void refreshThreads({ bypassCache: true })}>
              <RefreshCw size={15} />
            </button>
          </div>
        </div>

        {sessionSearchOpen ? (
          <div className="tantalum-ai-session-search">
            <Search size={13} />
            <input
              value={sessionSearchQuery}
              onChange={(event) => setSessionSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setSessionSearchOpen(false);
                  setSessionSearchQuery('');
                }
              }}
              placeholder="Search threads"
              autoFocus
            />
            {sessionSearchQuery ? (
              <button type="button" title="Clear search" onClick={() => setSessionSearchQuery('')}>
                <X size={12} />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="tantalum-ai-threads-container">
          {!showThreadListLoading && threadLoadError ? (
            <div className="inline-banner inline-banner-warning agent-inline-banner agent-thread-sync-banner agent-cloud-sync-banner">
              <span>{threadLoadError}</span>
              <button type="button" onClick={() => void refreshThreads({ bypassCache: true })} disabled={loadingThreads}>
                {loadingThreads ? 'Retrying...' : 'Retry'}
              </button>
            </div>
          ) : null}

          {showThreadListLoading ? (
            <div className="agent-empty-state">
              <LoaderCircle size={16} className="spin" />
              <span>Loading threads...</span>
            </div>
          ) : null}

          {!showThreadListLoading && !threadLoadError && !settingsLoadError && threadSummaries.length === 0 ? (
            <div className="agent-empty-state tantalum-empty-state sessions-empty-state">
              <MessageSquare size={16} />
              <span>No active threads.</span>
            </div>
          ) : null}

          {!showThreadListLoading && threadSummaries.length > 0 && visibleThreadSummaries.length === 0 ? (
            <div className="agent-empty-state tantalum-empty-state">
              <Search size={16} />
              <span>No matching threads.</span>
            </div>
          ) : null}

          {previewThreadSummaries.map(renderThreadItem)}
          {hasThreadOverflow ? (
            <button
              className="tantalum-ai-thread-show-more"
              type="button"
              onClick={() => setThreadListExpanded((current) => !current)}
            >
              {threadListExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              <span>{threadListExpanded ? 'SHOW LESS' : 'SHOW MORE'}</span>
              <strong className="tantalum-ai-thread-show-count">{threadListExpanded ? overflowThreadSummaries.length : hiddenThreadCount}</strong>
            </button>
          ) : null}
          {threadListExpanded ? overflowThreadSummaries.map(renderThreadItem) : null}
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
    const toolRequest = action.toolRequest;
    const isToolAction = action.kind === 'tool' && Boolean(toolRequest);
    const pendingFileChanges =
      taskList?.items.reduce<Array<{ key: string; action: string; filePath: string; label: string }>>((changes, item) => {
        const filePath = taskTargetPath(item);
        if (!filePath) {
          return changes;
        }

        const actionLabel = pendingTaskActionLabel(item);
        const isMoveTask = item.kind.toLowerCase().includes('move');
        const label =
          item.targetPath && item.newPath && item.targetPath !== item.newPath
            ? isMoveTask
              ? `${item.targetPath} -> ${item.newPath}`
              : `${basenameFromPath(item.targetPath) ?? item.targetPath} -> ${basenameFromPath(item.newPath) ?? item.newPath}`
            : (basenameFromPath(filePath) ?? filePath);
        const key = `${actionLabel}:${item.targetPath || ''}:${item.newPath || ''}`;
        if (changes.some((change) => change.key === key)) {
          return changes;
        }

        return [...changes, { key, action: actionLabel, filePath, label }];
      }, []) ?? [];
    const isWaiting = effectiveStatus === 'pending' || effectiveStatus === 'blocked';
    const isApprovedState = effectiveStatus === 'approved' || effectiveStatus === 'running' || effectiveStatus === 'executed';
    const isSkippedState = effectiveStatus === 'skipped';
    const buttonsDisabled = !isWaiting || busy || activeThreadIsRunning;
    const approvalStateLabel = isSkippedState ? 'skipped' : isApprovedState ? 'approved' : effectiveStatus === 'expired' ? 'unavailable' : 'pending approval';
    const plannedChangeLabel = isToolAction && toolRequest
      ? `${toolRequest.toolId} / ${toolRequest.risk || action.riskLevel || 'medium'} risk / ${approvalStateLabel}`
      : pendingFileChanges.length
        ? `${pendingFileChanges.length} ${pendingFileChanges.length === 1 ? 'file' : 'files'} ${approvalStateLabel}`
        : taskList?.items.length
          ? `${taskList.items.length} planned ${taskList.items.length === 1 ? 'update' : 'updates'} ${approvalStateLabel}`
          : `${action.riskLevel || 'project'} risk Project change`;
    const permissionCopy =
      isToolAction
        ? effectiveStatus === 'executed'
          ? 'This IDE tool action was approved and completed.'
          : effectiveStatus === 'skipped'
            ? 'This IDE tool action was skipped.'
            : effectiveStatus === 'expired'
              ? 'A newer permission request replaced this one.'
              : effectiveStatus === 'blocked'
                ? 'Tantalum AI needs approval again before it can continue.'
                : 'Tantalum AI needs permission before it can run this IDE tool.'
        : effectiveStatus === 'executed'
          ? 'This Project change was approved and applied.'
          : effectiveStatus === 'skipped'
            ? 'This Project change was skipped.'
            : effectiveStatus === 'expired'
              ? 'A newer permission request replaced this one.'
              : effectiveStatus === 'blocked'
                ? 'Tantalum AI needs approval again before it can continue.'
                : 'Tantalum AI needs permission before it can make changes in this Project.';

    return (
      <div className={`pending-agent-action-card pending-agent-action-card-${effectiveStatus}`}>
        <div className="pending-agent-action-main">
          <h4>{isToolAction ? 'IDE Tool Request' : 'Permission Request'}</h4>
          <p>{permissionCopy}</p>
          {isToolAction && toolRequest ? (
            <div className="pending-agent-tool-summary">
              <strong>{toolRequest.summary}</strong>
              {toolRequest.approvalReason ? <span>{toolRequest.approvalReason}</span> : null}
            </div>
          ) : null}
          {pendingFileChanges.length ? (
            <div className="pending-agent-file-list" aria-label="Files pending approval">
              <span className="pending-agent-file-list-title">Files to change</span>
              {pendingFileChanges.map((change) => (
                <div key={change.key} className="pending-agent-file-row">
                  <ContextSuggestionFileIcon filePath={change.filePath} />
                  <span className="pending-agent-file-action">{change.action}</span>
                  <span className="pending-agent-file-name" title={change.filePath}>
                    {change.label}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="action-row pending-agent-action-buttons">
            {!isSkippedState ? (
              <button
                className="primary-button compact"
                type="button"
                disabled={buttonsDisabled || isApprovedState}
                onClick={() => void approvePendingAgentAction(action.id)}
              >
                {isApprovedState ? 'Approved' : effectiveStatus === 'blocked' ? 'Retry' : 'Approve'}
              </button>
            ) : null}
            {!isApprovedState ? (
              <button
                className="danger-button compact"
                type="button"
                disabled={buttonsDisabled || isSkippedState}
                onClick={() => void skipPendingAgentAction(action.id)}
              >
                {isSkippedState ? 'Skipped' : 'Skip'}
              </button>
            ) : null}
          </div>
        </div>
        <div className="pending-agent-action-meta-row">
          {isToolAction ? <Wrench size={13} /> : <FileText size={13} />}
          <span>{plannedChangeLabel}</span>
        </div>
      </div>
    );
  }

  function getLatestVisibleTaskList() {
    const latestPendingAction = findLatestPendingAction(messages);
    const baseTaskList = latestPendingAction ? findLatestTaskList(messages, latestPendingAction.id) : findLatestTaskList(messages);
    return (
      (baseTaskList
        ? liveTaskLists.get(baseTaskList.id) ?? (baseTaskList.actionId ? liveTaskLists.get(`action:${baseTaskList.actionId}`) : null)
        : null) ??
      (latestPendingAction ? liveTaskLists.get(`action:${latestPendingAction.id}`) : null) ??
      baseTaskList
    );
  }

  function renderWorkDetails(taskList: AgentTaskList | null, activities: AgentActivityEntry[]) {
    const visibleActivities = [...activities].reverse();

    return (
      <div className="agent-work-details">
        {taskList?.items.length ? (
          <div className="agent-work-detail-list">
            {taskList.items.map((item) => {
              const target = taskTargetPath(item);
              const range = formatTaskRange(item);
              const note = item.result || item.error ? displayAgentWorkText(item.result || item.error || '') : '';
              return (
                <div key={item.id} className={`agent-work-row agent-work-row-${item.status}`}>
                  <AgentWorkIcon kind={taskWorkIconKind(item)} />
                  <span className="agent-work-action">{taskActionLabel(item)}</span>
                  {target ? (
                    <span className="agent-work-file-pill" title={target}>
                      <ContextSuggestionFileIcon filePath={target} />
                      <span>{basenameFromPath(target) ?? target}</span>
                    </span>
                  ) : (
                    <span className="agent-work-title">{displayAgentWorkText(item.title) || item.title}</span>
                  )}
                  {range ? <span className="agent-work-muted">, {range}</span> : null}
                  {note ? <span className="agent-work-muted">{note}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {visibleActivities.length > 0 ? (
          <div className="agent-work-detail-list">
            {visibleActivities.map((activity) => {
              const title = displayAgentWorkText(activity.title) || activity.title;
              const detail = activity.detail ? displayAgentWorkText(activity.detail) : '';
              const iconKind = activityWorkIconKind(activity);
              return (
                <div key={activity.id} className={`agent-work-row agent-work-runtime-row agent-work-row-${activity.status}`}>
                  <AgentWorkIcon kind={iconKind} />
                  <span className="agent-work-action">{activity.status}</span>
                  <span className="agent-work-title">{title}</span>
                  {detail ? <span className="agent-work-muted">{detail}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  function renderAssistantWorkSummary(message: AgentThreadMessage) {
    const baseTaskList = asAgentTaskList(message.metadata?.taskList);
    const taskList = baseTaskList
      ? liveTaskLists.get(baseTaskList.id) ?? (baseTaskList.actionId ? liveTaskLists.get(`action:${baseTaskList.actionId}`) : null) ?? baseTaskList
      : null;
    const activities = asAgentActivityEntries(message.metadata?.activities);
    const summary = taskSummaryLabel(taskList, activities);
    if (!summary) {
      return null;
    }

    const expanded = expandedWorkSummaryIds.has(message.id);

    return (
      <div className={`agent-work-summary ${expanded ? 'open' : ''}`}>
        <button
          className="agent-work-summary-toggle"
          type="button"
          aria-expanded={expanded}
          title={expanded ? 'Hide thinking details' : 'Show thinking details'}
          onClick={() => {
            setExpandedWorkSummaryIds((current) => {
              const next = new Set(current);
              if (next.has(message.id)) {
                next.delete(message.id);
              } else {
                next.add(message.id);
              }
              return next;
            });
          }}
        >
          <span>{summary}</span>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {expanded ? renderWorkDetails(taskList, activities) : null}
      </div>
    );
  }

  function renderThinkingIndicator() {
    if (!activeThreadIsRunning && !activeThreadIsPreparing) {
      return null;
    }

    const activities = activeThreadId ? liveActivities.get(activeThreadId) ?? [] : [];
    const latestActivity = activities.at(-1) ?? null;
    const taskList = getLatestVisibleTaskList();
    const phaseLabel = liveWorkPhaseLabel({
      activity: latestActivity,
      taskList,
      isPreparing: activeThreadIsPreparing,
    });
    return (
      <article className="agent-message agent-message-assistant tantalum-ai-chat-bubble tantalum-ai-thinking-message">
        <div className="agent-message-meta tantalum-ai-bubble-meta">
          <span className="author-tag">
            <Sparkles size={11} className="sparkle-icon" />
            Tantalum AI
          </span>
        </div>
        <div className="agent-message-body tantalum-ai-bubble-content agent-thinking-body" aria-live="polite">
          <div className="agent-thinking-row">
            <span className="agent-thinking-label">{phaseLabel}</span>
            {latestActivity ? (
              <>
                <span className="agent-thinking-separator" aria-hidden="true">
                  ·
                </span>
                <span className="agent-thinking-current">{displayAgentWorkText(latestActivity.title) || latestActivity.title}</span>
              </>
            ) : null}
            <span className="agent-thinking-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <button
              className="agent-thinking-toggle"
              type="button"
              title={thinkingDetailsOpen ? 'Hide runtime details' : 'Show runtime details'}
              aria-expanded={thinkingDetailsOpen}
              onClick={() => setThinkingDetailsOpen((current) => !current)}
            >
              {thinkingDetailsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          </div>
          {thinkingDetailsOpen ? renderWorkDetails(taskList, activities) : null}
        </div>
      </article>
    );
  }

  function renderConversationHeader() {
    return (
      <div className="tantalum-ai-conversation-header">
        <button className="conversation-back-btn" type="button" title="View Threads" onClick={showThreadHistory}>
          <ArrowLeft size={15} />
        </button>
        <h3>{formatThreadTitle(activeThread?.title ?? 'Untitled')}</h3>
      </div>
    );
  }

  function renderMessageLoadingSkeleton() {
    return (
      <div className="agent-message-skeleton-list" role="status" aria-live="polite">
        <div className="agent-message-skeleton-status">
          <LoaderCircle size={16} className="spin" />
          <span>Loading chat...</span>
        </div>
        {[0, 1, 2].map((index) => (
          <div key={index} className={`agent-message-skeleton ${index === 1 ? 'agent-message-skeleton-user' : ''}`}>
            <span className="agent-message-skeleton-meta" />
            <span className="agent-message-skeleton-line agent-message-skeleton-line-wide" />
            <span className="agent-message-skeleton-line" />
            <span className="agent-message-skeleton-line agent-message-skeleton-line-short" />
          </div>
        ))}
      </div>
    );
  }

  function renderUserMessageContextChips(message: AgentThreadMessage) {
    const chips = messageContextChipsFromMetadata(message.metadata);
    if (chips.length === 0) {
      return null;
    }

    return (
      <div className="agent-message-context-chip-row" aria-label="Message context">
        {chips.map((chip) => {
          const label = contextChipLabel(chip);
          const imageDataUrl = chip.kind === 'image' ? messageContextImagePreviews.get(chip.id) : undefined;
          const filePath = workspacePathForContextChip(chip, workspacePath);
          const chipClassName = `agent-message-context-chip ${chip.kind} ${imageDataUrl || filePath ? 'clickable' : ''}`;
          const icon = <ContextItemIcon item={{ kind: chip.kind, path: chip.path || chip.relativePath || chip.name }} />;
          const content = (
            <>
              {icon}
              <span className="chip-filename">{label}</span>
            </>
          );

          if (imageDataUrl) {
            return (
              <button
                key={chip.id}
                className={chipClassName}
                type="button"
                title={`Preview ${label}`}
                onClick={() =>
                  setPreviewImageContextItem((current) =>
                    current?.source === 'message' && current.id === chip.id
                      ? null
                      : {
                          id: chip.id,
                          name: label,
                          dataUrl: imageDataUrl,
                          source: 'message',
                        },
                  )
                }
              >
                {content}
              </button>
            );
          }

          if (filePath && onOpenContextFile) {
            return (
              <button
                key={chip.id}
                className={chipClassName}
                type="button"
                title={`Open ${label}`}
                onClick={() => onOpenContextFile(filePath)}
              >
                {content}
              </button>
            );
          }

          return (
            <span key={chip.id} className={chipClassName} title={chip.kind === 'image' ? 'Image preview is only available in the current session.' : label}>
              {content}
            </span>
          );
        })}
      </div>
    );
  }

  function renderConversation() {
    const loadingExistingThread = loadingMessages && composeTarget === 'thread' && Boolean(activeThreadId) && messages.length === 0;

    if (loadingExistingThread) {
      return (
        <div className="tantalum-ai-conversation-container">
          {renderConversationHeader()}
          <div ref={messageListRef} className="agent-message-list tantalum-message-list tantalum-ai-message-list">
            {renderMessageLoadingSkeleton()}
          </div>
        </div>
      );
    }

    if (messages.length === 0) {
      return (
        <div className="tantalum-ai-conversation-container">
          {renderConversationHeader()}
          <div className="tantalum-ai-empty-thread">
            <p>Tell me what you want me to work on.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="tantalum-ai-conversation-container">
        {renderConversationHeader()}

        <div ref={messageListRef} className="agent-message-list tantalum-message-list tantalum-ai-message-list">
          {loadingMessages ? (
            <div className="agent-empty-state">
              <LoaderCircle size={18} className="spin" />
              <span>Loading messages...</span>
            </div>
          ) : null}

          {messages.map((message) => (
            <article key={message.id} className={`agent-message agent-message-${message.role} ${message.tone ? `agent-message-${message.tone}` : ''} tantalum-ai-chat-bubble`}>
              <div className="agent-message-meta tantalum-ai-bubble-meta">
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
              <div className="agent-message-body tantalum-ai-bubble-content">
                {message.role === 'assistant' ? (
                  <>
                    {renderAssistantWorkSummary(message)}
                    <MarkdownRenderer content={message.content} />
                    {renderPendingActionCard(message)}
                  </>
                ) : message.role === 'user' ? (
                  <>
                    <div className="agent-user-message-toolbar">
                      <button
                        className="agent-message-restore-btn"
                        type="button"
                        title={
                          messageHasRestorePoint(message)
                            ? 'Restore files and clean this thread from this message'
                            : 'No agent file changes to restore from this message'
                        }
                        disabled={!messageHasRestorePoint(message) || Boolean(restoringMessageId) || busy || activeThreadCanStop}
                        onClick={() => void handleRestoreMessage(message)}
                      >
                        {restoringMessageId === message.id ? <LoaderCircle size={12} className="spin" /> : <Undo2 size={12} />}
                      </button>
                    </div>
                    <pre>{message.content}</pre>
                    {renderUserMessageContextChips(message)}
                  </>
                ) : (
                  <>
                    {renderAssistantWorkSummary(message)}
                    <div className="status-alert-body">{message.content}</div>
                  </>
                )}
              </div>
            </article>
          ))}
          {renderThinkingIndicator()}
        </div>
      </div>
    );
  }

  function renderChatView() {
    if (hideChat) {
      return null;
    }

    const retryCloudSettings = () => {
      void refreshAgentSettings(true, { includeUsage: false, bypassCache: true });
    };

    return (
      <div
        className={`tantalum-ai-chat-layout ${contextDropActive ? 'context-drop-active' : ''}`}
        onDragEnter={handleContextDragEnter}
        onDragOver={handleContextDragOver}
        onDragLeave={handleContextDragLeave}
        onDrop={handleContextDrop}
      >
        {!loadingInitialAgentData && !hasCloudAgent ? (
          <div className="inline-banner inline-banner-warning agent-inline-banner">
            Push the Tantalum AI Appwrite tables and functions before using managed models, custom credentials, or synced threads.
          </div>
        ) : null}

        {showingCloudConnectionState ? (
          <div className="inline-banner inline-banner-info agent-inline-banner agent-cloud-sync-banner">
            <span>Connecting to Tantalum AI...</span>
          </div>
        ) : null}

        {!loadingInitialAgentData && hasCloudAgent && settingsLoadError ? (
          <div className="inline-banner inline-banner-warning agent-inline-banner agent-cloud-sync-banner">
            <span>{settingsLoadError}</span>
            <button type="button" onClick={retryCloudSettings} disabled={loadingSettings}>
              {loadingSettings ? 'Retrying...' : 'Retry'}
            </button>
          </div>
        ) : null}

        {!loadingInitialAgentData && showManagedUnavailableMessage ? (
          <div className="inline-banner inline-banner-warning agent-inline-banner">
            {managedUnavailableMessage}
          </div>
        ) : null}

        <div className="tantalum-ai-chat-content">
          {isViewingHistory ? renderThreadList() : renderConversation()}
        </div>

        {isViewingHistory && sessionSearchOpen ? null : renderComposer()}
        {renderBottomStatusBar()}
      </div>
    );
  }

  async function handleAgentToolToggle(descriptor: AgentToolDescriptor, enabled: boolean) {
    setSavingAgentToolId(descriptor.id);
    try {
      const result = await window.tantalum.agent.tools.updateSettings({
        tools: {
          [descriptor.id]: { enabled },
        },
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      setAgentToolSettings({
        descriptors: result.descriptors,
        settings: result.settings,
        categories: result.categories,
      });
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to update agent tool settings.', 'error');
    } finally {
      setSavingAgentToolId((current) => (current === descriptor.id ? null : current));
    }
  }

  function renderAgentToolSettingsSection() {
    const descriptors = agentToolSettings?.descriptors ?? [];
    const categories = agentToolSettings?.categories ?? {};
    const grouped = descriptors.reduce<Record<string, AgentToolDescriptor[]>>((groups, descriptor) => {
      const key = descriptor.category || 'other';
      groups[key] = [...(groups[key] ?? []), descriptor];
      return groups;
    }, {});

    return (
      <section className="tantalum-ai-settings-card agent-tools-settings-card">
        <div className="card-header agent-tools-card-header">
          <div>
            <Wrench size={14} className="text-accent" />
            <h3>Agent Tools</h3>
          </div>
          <span>Local IDE actions available to Tantalum AI</span>
        </div>
        {!agentToolSettings ? (
          <div className="agent-loading-state compact" role="status">
            <LoaderCircle size={16} className="spin" />
            <span>Loading tools...</span>
          </div>
        ) : (
          <div className="agent-tool-settings-groups">
            {Object.entries(grouped).map(([category, tools]) => (
              <div key={category} className="agent-tool-settings-group">
                <h4>{categories[category] || category}</h4>
                <div className="agent-tool-settings-list">
                  {tools.map((descriptor) => {
                    const enabled = agentToolSettings.settings.tools[descriptor.id]?.enabled !== false;
                    const disabled = !descriptor.available || savingAgentToolId === descriptor.id;
                    return (
                      <article key={descriptor.id} className={`agent-tool-row ${descriptor.available ? '' : 'agent-tool-row-unavailable'}`}>
                        <div>
                          <strong>{descriptor.label}</strong>
                          <span>{descriptor.description}</span>
                          <code>{descriptor.id}</code>
                          {descriptor.unavailableReason ? <small>{descriptor.unavailableReason}</small> : null}
                        </div>
                        <label className="agent-tool-toggle">
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={disabled}
                            onChange={(event) => void handleAgentToolToggle(descriptor, event.target.checked)}
                          />
                          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
                        </label>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderSettingsView() {
    return (
      <div className="agent-settings-view tantalum-ai-settings-layout">
        {/* Relocated Core Configuration Card */}
        <div className="tantalum-ai-settings-card core-config-card">
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
                      className="tantalum-ai-settings-select"
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
                      className="tantalum-ai-settings-select"
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

        {renderAgentUsageSection()}
        {renderAgentToolSettingsSection()}

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
                className="tantalum-ai-settings-select"
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

  function renderAgentUsageSection() {
    const creditAccount = settings.creditAccount;
    const { monthlyAllowance, usedCredits, remainingCredits } = creditBalance;
    const usedPercent = monthlyAllowance > 0 ? (usedCredits / monthlyAllowance) * 100 : 0;
    const recentUsage = settings.recentUsage;
    const recentTotalTokens = recentUsage.reduce((total, event) => total + event.totalTokens, 0);
    const recentChargedCredits = recentUsage.reduce((total, event) => total + event.chargedCredits, 0);
    const managedEvents = recentUsage.filter((event) => event.source === 'managed').length;
    const customEvents = recentUsage.filter((event) => event.source === 'custom').length;
    const blockedOrFailedEvents = recentUsage.filter((event) => event.status === 'blocked' || event.status === 'failed').length;

    return (
      <section className="tantalum-ai-settings-card agent-usage-settings-card">
        <div className="card-header agent-usage-card-header">
          <Bot size={14} className="text-accent" />
          <div>
            <h3>Agent Usage</h3>
            <span>Credit account and usage ledger</span>
          </div>
        </div>

        <div className="agent-usage-summary">
          <div className="agent-usage-summary-card">
            <span>Allowance</span>
            <strong>{formatCredits(monthlyAllowance)}</strong>
          </div>
          <div className="agent-usage-summary-card">
            <span>Used</span>
            <strong>{formatCredits(usedCredits)}</strong>
          </div>
          <div className="agent-usage-summary-card">
            <span>Remaining</span>
            <strong>{formatCredits(remainingCredits)}</strong>
          </div>
          <div className="agent-usage-summary-card">
            <span>Used Share</span>
            <strong>{formatUsagePercent(usedPercent)}</strong>
          </div>
        </div>

        <div className="agent-usage-meter" title={`${formatCredits(usedCredits)} of ${formatCredits(monthlyAllowance)} credits used`}>
          <span style={{ width: `${Math.max(0, Math.min(100, usedPercent))}%` }} />
        </div>

        <div className="agent-usage-detail-grid">
          <div>
            <span>Account ID</span>
            <code>{creditAccount.id || 'Not assigned'}</code>
          </div>
          <div>
            <span>Period Key</span>
            <strong>{creditAccount.periodKey || 'Not set'}</strong>
          </div>
          <div>
            <span>Reset At</span>
            <strong>{formatDetailedDate(creditAccount.resetAt)}</strong>
          </div>
          <div>
            <span>Created At</span>
            <strong>{formatDetailedDate(creditAccount.createdAt)}</strong>
          </div>
          <div>
            <span>Updated At</span>
            <strong>{formatDetailedDate(creditAccount.updatedAt)}</strong>
          </div>
        </div>

        <div className="agent-usage-subsection">
          <div className="agent-usage-subsection-title">
            <h4>Ledger Totals</h4>
            <span>{recentUsage.length.toLocaleString()} entries</span>
          </div>
          <div className="agent-usage-summary agent-usage-ledger-summary">
            <div className="agent-usage-summary-card">
              <span>Charged Credits</span>
              <strong>{formatCredits(recentChargedCredits)}</strong>
            </div>
            <div className="agent-usage-summary-card">
              <span>Total Tokens</span>
              <strong>{recentTotalTokens.toLocaleString()}</strong>
            </div>
            <div className="agent-usage-summary-card">
              <span>Managed Runs</span>
              <strong>{managedEvents.toLocaleString()}</strong>
            </div>
            <div className="agent-usage-summary-card">
              <span>Custom Runs</span>
              <strong>{customEvents.toLocaleString()}</strong>
            </div>
            <div className="agent-usage-summary-card">
              <span>Blocked / Failed</span>
              <strong>{blockedOrFailedEvents.toLocaleString()}</strong>
            </div>
          </div>
        </div>

        <div className="agent-usage-list">
          <div className="agent-usage-subsection-title">
            <h4>Usage Ledger</h4>
            <span>Newest first</span>
          </div>
          {settings.recentUsage.length === 0 ? (
            <div className="agent-empty-state">
              <Bot size={18} />
              <span>No agent runs recorded yet.</span>
            </div>
          ) : null}
          {settings.recentUsage.map((event) => (
            <article key={event.id} className="agent-usage-row">
              <div className="agent-usage-row-head">
                <div>
                  <strong>{event.source === 'managed' ? (event.mode === 'power' ? 'Power' : 'Fast') : event.modelAlias || 'Custom'}</strong>
                  <span>{formatDetailedDate(event.createdAt)}</span>
                </div>
                <div className="agent-usage-row-credit">
                  <strong>{event.chargedCredits.toLocaleString()} credits</strong>
                  <span>{event.totalTokens.toLocaleString()} tokens</span>
                </div>
              </div>

              <div className="agent-usage-event-grid">
                <div>
                  <span>Status</span>
                  <strong>{event.status || 'unknown'}</strong>
                </div>
                <div>
                  <span>Source</span>
                  <strong>{event.source}</strong>
                </div>
                <div>
                  <span>Mode</span>
                  <strong>{event.mode}</strong>
                </div>
                <div>
                  <span>Provider</span>
                  <strong>{event.providerLabel || 'Not recorded'}</strong>
                </div>
                <div>
                  <span>Model</span>
                  <strong>{event.modelAlias || 'Not recorded'}</strong>
                </div>
                <div>
                  <span>Multiplier</span>
                  <strong>{event.multiplier.toLocaleString()}x</strong>
                </div>
                <div>
                  <span>Request ID</span>
                  <code>{event.requestId || 'Not recorded'}</code>
                </div>
                <div>
                  <span>Ledger ID</span>
                  <code>{event.id}</code>
                </div>
              </div>

              {event.errorMessage ? (
                <div className="agent-usage-error">
                  <span>Error</span>
                  <code>{event.errorMessage}</code>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    );
  }

  return (
    <>
      <section className={`agent-panel tantalum-ai-panel ${chatOnly ? 'tantalum-ai-panel-compact' : ''}`}>
        {renderHeader()}
        {renderTabs()}

        {view === 'chat' ? renderChatView() : null}
        {view === 'settings' ? renderSettingsView() : null}
      </section>
      <Modal
        open={Boolean(renameThreadPrompt)}
        title="Rename thread"
        size="sm"
        onClose={() => {
          if (renamingThreadId) {
            return;
          }

          setRenameThreadPrompt(null);
          setRenameThreadTitle('');
        }}
      >
        {renameThreadPrompt ? (
          <form className="modal-form" onSubmit={(event) => void submitThreadRename(event)}>
            <label>
              Thread title
              <input
                autoFocus
                value={renameThreadTitle}
                onChange={(event) => setRenameThreadTitle(event.target.value)}
                placeholder={renameThreadPrompt.title}
                disabled={renamingThreadId === renameThreadPrompt.id}
              />
            </label>
            <div className="form-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={renamingThreadId === renameThreadPrompt.id}
                onClick={() => {
                  setRenameThreadPrompt(null);
                  setRenameThreadTitle('');
                }}
              >
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={renamingThreadId === renameThreadPrompt.id}>
                {renamingThreadId === renameThreadPrompt.id ? 'Renaming...' : 'Rename'}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>
    </>
  );
}

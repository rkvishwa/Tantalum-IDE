import { executeFunction } from './functions';
import { appwriteConfig } from './config';

export type AgentMode = 'fast' | 'power';
export type AgentSource = 'managed' | 'custom';

export type AgentUiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'status';
  content: string;
  tone?: 'default' | 'success' | 'error' | 'warning';
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type AgentManagedMode = {
  id: AgentMode;
  label: string;
  creditMultiplier: number;
  model: string;
  editorModel: string;
  contextWindow: number | null;
  repoMapTokens: number;
  reasoningEffort?: string | null;
};

export type AgentManagedModelMetadata = {
  providerLabel: string;
  fastModel: string;
  fastEditorModel: string;
  powerModel: string;
  powerEditorModel: string;
  powerReasoningEffort: string;
  fastContextWindow: number | null;
  powerContextWindow: number | null;
  repoMapTokens: number;
};

export type AgentCustomCredential = {
  id: string;
  displayName: string;
  baseUrl: string;
  modelNames: string[];
  enabled: boolean;
  apiKeyPreview: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type AgentPreferences = {
  selectedSource: AgentSource;
  defaultMode: AgentMode;
  selectedCustomCredentialId: string | null;
  selectedCustomModelName: string | null;
};

type LegacyAgentPreferences = Omit<AgentPreferences, 'selectedCustomModelName'>;

type SaveAgentPreferencesOptions = {
  includeCustomModelName?: boolean;
};

type LoadAgentSettingsOptions = {
  includeUsage?: boolean;
  bypassCache?: boolean;
};

type AgentFunctionReadOptions = {
  bypassCache?: boolean;
};

const AGENT_SETTINGS_READ_EXECUTION_OPTIONS = {
  async: true,
  waitForCompletion: true,
  waitTimeoutMs: 95_000,
  pollMs: 1_000,
} as const;

export type AgentCreditAccount = {
  id: string;
  periodKey: string;
  monthlyAllowance: number;
  usedCredits: number;
  remainingCredits: number;
  resetAt: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentUsageEvent = {
  id: string;
  requestId: string;
  source: AgentSource;
  mode: AgentMode;
  status: 'success' | 'failed' | 'blocked' | string;
  providerLabel: string | null;
  modelAlias: string | null;
  totalTokens: number;
  multiplier: number;
  chargedCredits: number;
  createdAt: string;
  errorMessage: string | null;
};

export type AgentThreadSummary = {
  id: string;
  title: string;
  workspaceKey: string | null;
  workspaceName: string | null;
  status: 'active' | 'archived' | 'deleted' | string;
  messageCount: number;
  lastMessagePreview: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
};

export type AgentThreadMessage = AgentUiMessage & {
  threadId: string;
};

export type AgentThreadTruncateResult = {
  thread: AgentThreadSummary;
  messages: AgentThreadMessage[];
  removedCount: number;
};

export type AgentSettingsState = {
  managedAvailable: boolean;
  managedModes: AgentManagedMode[];
  managedModelMetadata: AgentManagedModelMetadata;
  preferences: AgentPreferences;
  customCredentials: AgentCustomCredential[];
  creditAccount: AgentCreditAccount;
  recentUsage: AgentUsageEvent[];
  recentThreads: AgentThreadSummary[];
};

export type AgentCredentialInput = {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  modelNames: string[];
  enabled?: boolean;
};

export type AgentCredentialUpdateInput = Partial<AgentCredentialInput> & {
  credentialId: string;
};

export type AgentThreadCreateInput = {
  title?: string;
  workspaceKey?: string | null;
  workspaceName?: string | null;
};

export type AgentThreadMessageInput = {
  threadId: string;
  role: AgentUiMessage['role'];
  content: string;
  tone?: AgentUiMessage['tone'];
  metadata?: Record<string, unknown>;
};

function assertAgentSettingsFunction() {
  if (!appwriteConfig.agentSettingsFunctionId) {
    throw new Error('The agent settings function is not configured.');
  }
}

function isUnknownSelectedCustomModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('Unknown attribute') && message.includes('selectedCustomModelName');
}

function normalizeSavedPreferences(saved: Partial<AgentPreferences>, fallback: AgentPreferences): AgentPreferences {
  const selectedSource = saved.selectedSource === 'custom' || saved.selectedSource === 'managed' ? saved.selectedSource : fallback.selectedSource;
  const savedMode = String(saved.defaultMode || '');
  const defaultMode = savedMode === 'power' || savedMode === 'plan' ? 'power' : savedMode === 'fast' ? 'fast' : fallback.defaultMode;

  return {
    selectedSource,
    defaultMode,
    selectedCustomCredentialId:
      selectedSource === 'custom'
        ? (typeof saved.selectedCustomCredentialId === 'string' && saved.selectedCustomCredentialId) || fallback.selectedCustomCredentialId || null
        : null,
    selectedCustomModelName:
      selectedSource === 'custom'
        ? (typeof saved.selectedCustomModelName === 'string' && saved.selectedCustomModelName) || fallback.selectedCustomModelName || null
        : null,
  };
}

function withoutSelectedCustomModelName(preferences: AgentPreferences): LegacyAgentPreferences {
  return {
    selectedSource: preferences.selectedSource,
    defaultMode: preferences.defaultMode,
    selectedCustomCredentialId: preferences.selectedCustomCredentialId,
  };
}

export function createDefaultAgentSettings(): AgentSettingsState {
  const managedModelMetadata: AgentManagedModelMetadata = {
    providerLabel: 'Azure AI Foundry',
    fastModel: 'gpt-4.1',
    fastEditorModel: 'gpt-4.1',
    powerModel: 'gpt-5.5',
    powerEditorModel: 'gpt-4.1',
    powerReasoningEffort: 'medium',
    fastContextWindow: null,
    powerContextWindow: null,
    repoMapTokens: 2048,
  };

  return {
    managedAvailable: false,
    managedModes: [
      {
        id: 'fast',
        label: 'Fast',
        creditMultiplier: 1,
        model: managedModelMetadata.fastModel,
        editorModel: managedModelMetadata.fastEditorModel,
        contextWindow: managedModelMetadata.fastContextWindow,
        repoMapTokens: managedModelMetadata.repoMapTokens,
      },
      {
        id: 'power',
        label: 'Power',
        creditMultiplier: 2,
        model: managedModelMetadata.powerModel,
        editorModel: managedModelMetadata.powerEditorModel,
        contextWindow: managedModelMetadata.powerContextWindow,
        repoMapTokens: managedModelMetadata.repoMapTokens,
        reasoningEffort: managedModelMetadata.powerReasoningEffort,
      },
    ],
    managedModelMetadata,
    preferences: {
      selectedSource: 'managed',
      defaultMode: 'fast',
      selectedCustomCredentialId: null,
      selectedCustomModelName: null,
    },
    customCredentials: [],
    creditAccount: {
      id: '',
      periodKey: '',
      monthlyAllowance: 0,
      usedCredits: 0,
      remainingCredits: 0,
      resetAt: '',
      createdAt: '',
      updatedAt: '',
    },
    recentUsage: [],
    recentThreads: [],
  };
}

export async function loadAgentSettings(workspaceKey?: string | null, options: LoadAgentSettingsOptions = {}) {
  assertAgentSettingsFunction();
  return executeFunction<{ workspaceKey?: string | null; includeUsage?: boolean }, AgentSettingsState>(
    appwriteConfig.agentSettingsFunctionId,
    { workspaceKey: workspaceKey ?? null, includeUsage: options.includeUsage === true },
    '/bootstrap',
    { ...AGENT_SETTINGS_READ_EXECUTION_OPTIONS, bypassCache: options.bypassCache },
  );
}

export async function saveAgentPreferences(preferences: AgentPreferences, options: SaveAgentPreferencesOptions = {}) {
  assertAgentSettingsFunction();
  const firstPayload = options.includeCustomModelName === false ? withoutSelectedCustomModelName(preferences) : preferences;

  try {
    const saved = await executeFunction<typeof firstPayload, Partial<AgentPreferences>>(
      appwriteConfig.agentSettingsFunctionId,
      firstPayload,
      '/preferences',
    );
    return normalizeSavedPreferences(saved, preferences);
  } catch (error) {
    if (!isUnknownSelectedCustomModelError(error) || options.includeCustomModelName === false) {
      throw error;
    }

    const legacyPreferences = withoutSelectedCustomModelName(preferences);
    const saved = await executeFunction<typeof legacyPreferences, Partial<AgentPreferences>>(
      appwriteConfig.agentSettingsFunctionId,
      legacyPreferences,
      '/preferences',
    );
    return normalizeSavedPreferences(saved, preferences);
  }
}

export async function createCustomCredential(input: AgentCredentialInput) {
  assertAgentSettingsFunction();
  return executeFunction<AgentCredentialInput, AgentCustomCredential>(
    appwriteConfig.agentSettingsFunctionId,
    input,
    '/custom-credentials/create',
  );
}

export async function updateCustomCredential(input: AgentCredentialUpdateInput) {
  assertAgentSettingsFunction();
  return executeFunction<AgentCredentialUpdateInput, AgentCustomCredential>(
    appwriteConfig.agentSettingsFunctionId,
    input,
    '/custom-credentials/update',
  );
}

export async function deleteCustomCredential(credentialId: string) {
  assertAgentSettingsFunction();
  return executeFunction<{ credentialId: string }, { deleted: boolean }>(
    appwriteConfig.agentSettingsFunctionId,
    { credentialId },
    '/custom-credentials/delete',
  );
}

export async function testCustomCredential(credentialId: string) {
  assertAgentSettingsFunction();
  return executeFunction<{ credentialId: string }, { ok: boolean }>(
    appwriteConfig.agentSettingsFunctionId,
    { credentialId },
    '/custom-credentials/test',
  );
}

export async function listAgentThreads(workspaceKey?: string | null, options: AgentFunctionReadOptions = {}) {
  assertAgentSettingsFunction();
  return executeFunction<{ workspaceKey?: string | null }, AgentThreadSummary[]>(
    appwriteConfig.agentSettingsFunctionId,
    { workspaceKey: workspaceKey ?? null },
    '/threads/list',
    { ...AGENT_SETTINGS_READ_EXECUTION_OPTIONS, bypassCache: options.bypassCache },
  );
}

export async function createAgentThread(input: AgentThreadCreateInput) {
  assertAgentSettingsFunction();
  return executeFunction<AgentThreadCreateInput, AgentThreadSummary>(
    appwriteConfig.agentSettingsFunctionId,
    input,
    '/threads/create',
  );
}

export async function loadAgentThreadMessages(threadId: string) {
  assertAgentSettingsFunction();
  return executeFunction<{ threadId: string }, AgentThreadMessage[]>(
    appwriteConfig.agentSettingsFunctionId,
    { threadId },
    '/threads/messages',
    AGENT_SETTINGS_READ_EXECUTION_OPTIONS,
  );
}

export async function createAgentThreadMessage(input: AgentThreadMessageInput) {
  assertAgentSettingsFunction();
  return executeFunction<AgentThreadMessageInput, AgentThreadMessage>(
    appwriteConfig.agentSettingsFunctionId,
    input,
    '/threads/message/create',
  );
}

export async function truncateAgentThreadMessages(threadId: string, afterMessageId: string) {
  assertAgentSettingsFunction();
  return executeFunction<{ threadId: string; afterMessageId: string }, AgentThreadTruncateResult>(
    appwriteConfig.agentSettingsFunctionId,
    { threadId, afterMessageId },
    '/threads/messages/truncate',
  );
}

export async function renameAgentThread(threadId: string, title: string) {
  assertAgentSettingsFunction();
  return executeFunction<{ threadId: string; title: string }, AgentThreadSummary>(
    appwriteConfig.agentSettingsFunctionId,
    { threadId, title },
    '/threads/rename',
  );
}

export async function deleteAgentThread(threadId: string) {
  assertAgentSettingsFunction();
  return executeFunction<{ threadId: string }, { deleted: boolean }>(
    appwriteConfig.agentSettingsFunctionId,
    { threadId },
    '/threads/delete',
  );
}

export function normalizeModelList(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

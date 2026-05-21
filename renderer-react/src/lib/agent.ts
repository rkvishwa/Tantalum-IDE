import { executeFunction } from './functions';
import { appwriteConfig } from './config';

export type AgentMode = 'fast' | 'plan';
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
  planModel: string;
  planEditorModel: string;
  planReasoningEffort: string;
  fastContextWindow: number | null;
  planContextWindow: number | null;
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

export type AgentCreditAccount = {
  id: string;
  periodKey: string;
  monthlyAllowance: number;
  usedCredits: number;
  remainingCredits: number;
  resetAt: string;
  updatedAt: string;
};

export type AgentUsageEvent = {
  id: string;
  source: AgentSource;
  mode: AgentMode;
  status: 'success' | 'failed' | 'blocked' | string;
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

export function createDefaultAgentSettings(): AgentSettingsState {
  const managedModelMetadata: AgentManagedModelMetadata = {
    providerLabel: 'Azure AI Foundry',
    fastModel: 'gpt-4.1',
    fastEditorModel: 'gpt-4.1',
    planModel: 'gpt-5.5',
    planEditorModel: 'gpt-4.1',
    planReasoningEffort: 'medium',
    fastContextWindow: null,
    planContextWindow: null,
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
        id: 'plan',
        label: 'Plan',
        creditMultiplier: 2,
        model: managedModelMetadata.planModel,
        editorModel: managedModelMetadata.planEditorModel,
        contextWindow: managedModelMetadata.planContextWindow,
        repoMapTokens: managedModelMetadata.repoMapTokens,
        reasoningEffort: managedModelMetadata.planReasoningEffort,
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
      updatedAt: '',
    },
    recentUsage: [],
    recentThreads: [],
  };
}

export async function loadAgentSettings() {
  assertAgentSettingsFunction();
  return executeFunction<Record<string, never>, AgentSettingsState>(
    appwriteConfig.agentSettingsFunctionId,
    {},
    '/bootstrap',
  );
}

export async function saveAgentPreferences(preferences: AgentPreferences) {
  assertAgentSettingsFunction();
  return executeFunction<AgentPreferences, AgentPreferences>(
    appwriteConfig.agentSettingsFunctionId,
    preferences,
    '/preferences',
  );
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

export async function listAgentThreads(workspaceKey?: string | null) {
  assertAgentSettingsFunction();
  return executeFunction<{ workspaceKey?: string | null }, AgentThreadSummary[]>(
    appwriteConfig.agentSettingsFunctionId,
    { workspaceKey: workspaceKey ?? null },
    '/threads/list',
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

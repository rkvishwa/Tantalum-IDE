import { executeFunction } from './functions';
import { appwriteConfig } from './config';

export type AgentMode = 'fast' | 'plan';
export type AgentSource = 'managed' | 'custom';

export type AgentUiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'status';
  content: string;
  tone?: 'default' | 'success' | 'error' | 'warning';
};

export type AgentManagedMode = {
  id: AgentMode;
  label: string;
  creditMultiplier: number;
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

export type AgentSettingsState = {
  managedAvailable: boolean;
  managedModes: AgentManagedMode[];
  preferences: AgentPreferences;
  customCredentials: AgentCustomCredential[];
  creditAccount: AgentCreditAccount;
  recentUsage: AgentUsageEvent[];
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

function assertAgentSettingsFunction() {
  if (!appwriteConfig.agentSettingsFunctionId) {
    throw new Error('The agent settings function is not configured.');
  }
}

export function createDefaultAgentSettings(): AgentSettingsState {
  return {
    managedAvailable: false,
    managedModes: [
      { id: 'fast', label: 'Fast', creditMultiplier: 1 },
      { id: 'plan', label: 'Plan', creditMultiplier: 2 },
    ],
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

export function normalizeModelList(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

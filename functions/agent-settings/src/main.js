import dns from 'node:dns/promises';
import net from 'node:net';

import { Account, Client, Databases, ID, Query } from 'node-appwrite';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID = 'agent_managed_key_pool',
  APPWRITE_AGENT_USER_MANAGED_KEYS_COLLECTION_ID = 'agent_user_managed_keys',
  APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID = 'agent_custom_credentials',
  APPWRITE_AGENT_USER_PREFERENCES_COLLECTION_ID = 'agent_user_preferences',
  APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID = 'agent_credit_accounts',
  APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID = 'agent_usage_ledger',
  APPWRITE_AGENT_THREADS_COLLECTION_ID = 'agent_threads',
  APPWRITE_AGENT_THREAD_MESSAGES_COLLECTION_ID = 'agent_thread_messages',
  AGENT_DEFAULT_MONTHLY_CREDITS = '500',
} = process.env;

const DEFAULT_CREDIT_ALLOWANCE = Number.parseInt(AGENT_DEFAULT_MONTHLY_CREDITS, 10) || 500;
const DEFAULT_MANAGED_MODEL_METADATA = {
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

function json(res, status, payload) {
  return res.json(payload, status);
}

function ok(res, data, status = 200) {
  return json(res, status, { ok: true, data });
}

function fail(res, status, error, details) {
  return json(res, status, { ok: false, error, details });
}

function readPayload(req) {
  if (req.bodyJson && typeof req.bodyJson === 'object') {
    return req.bodyJson;
  }

  try {
    return JSON.parse(req.bodyText || '{}');
  } catch {
    return {};
  }
}

function createAdminClient(req) {
  if (!APPWRITE_FUNCTION_API_ENDPOINT || !APPWRITE_FUNCTION_PROJECT_ID) {
    throw new Error('Function environment is missing Appwrite runtime credentials.');
  }

  const executionKey = req.headers['x-appwrite-key'];
  if (!executionKey) {
    throw new Error('Appwrite did not provide an execution API key.');
  }

  return new Client()
    .setEndpoint(APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(executionKey);
}

function createUserClient(jwt) {
  if (!jwt) {
    throw new Error('User JWT header is missing.');
  }

  return new Client()
    .setEndpoint(APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(APPWRITE_FUNCTION_PROJECT_ID)
    .setJWT(jwt);
}

async function resolveUser(req) {
  const account = new Account(createUserClient(req.headers['x-appwrite-user-jwt']));
  return account.get();
}

function periodKeyFor(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function redactSecret(value) {
  const secret = String(value || '').trim();
  if (secret.length <= 4) {
    return secret ? '••••' : '';
  }

  return `••••${secret.slice(-4)}`;
}

function maskCredential(document) {
  return {
    id: document.$id,
    displayName: document.displayName || 'Custom key',
    baseUrl: document.baseUrl || '',
    modelNames: ensureArray(document.modelNames),
    enabled: Boolean(document.enabled),
    apiKeyPreview: document.apiKeyPreview || redactSecret(document.apiKey),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastUsedAt: document.lastUsedAt || null,
  };
}

function maskCreditAccount(document) {
  const monthlyAllowance = Number(document.monthlyAllowance || 0);
  const usedCredits = Number(document.usedCredits || 0);

  return {
    id: document.$id,
    periodKey: document.periodKey,
    monthlyAllowance,
    usedCredits,
    remainingCredits: Math.max(0, monthlyAllowance - usedCredits),
    resetAt: document.resetAt,
    updatedAt: document.updatedAt,
  };
}

function asNullablePositiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function cleanPreview(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function defaultThreadTitle(value) {
  const title = cleanPreview(value).slice(0, 64);
  return title || 'New thread';
}

function isUnknownSelectedCustomModelError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('Unknown attribute') && message.includes('selectedCustomModelName');
}

function maskManagedModelMetadata(poolKey) {
  if (!poolKey) {
    return DEFAULT_MANAGED_MODEL_METADATA;
  }

  return {
    providerLabel: poolKey.providerLabel || DEFAULT_MANAGED_MODEL_METADATA.providerLabel,
    fastModel: poolKey.fastModel || DEFAULT_MANAGED_MODEL_METADATA.fastModel,
    fastEditorModel: poolKey.fastEditorModel || poolKey.fastModel || DEFAULT_MANAGED_MODEL_METADATA.fastEditorModel,
    planModel: poolKey.planModel || DEFAULT_MANAGED_MODEL_METADATA.planModel,
    planEditorModel: poolKey.planEditorModel || poolKey.fastEditorModel || poolKey.fastModel || DEFAULT_MANAGED_MODEL_METADATA.planEditorModel,
    planReasoningEffort: poolKey.planReasoningEffort || DEFAULT_MANAGED_MODEL_METADATA.planReasoningEffort,
    fastContextWindow: asNullablePositiveInteger(poolKey.fastContextWindow),
    planContextWindow: asNullablePositiveInteger(poolKey.planContextWindow),
    repoMapTokens: Number(poolKey.repoMapTokens || DEFAULT_MANAGED_MODEL_METADATA.repoMapTokens),
  };
}

function managedModesFromMetadata(metadata) {
  return [
    {
      id: 'fast',
      label: 'Fast',
      creditMultiplier: 1,
      model: metadata.fastModel,
      editorModel: metadata.fastEditorModel,
      contextWindow: metadata.fastContextWindow,
      repoMapTokens: metadata.repoMapTokens,
      reasoningEffort: null,
    },
    {
      id: 'plan',
      label: 'Plan',
      creditMultiplier: 2,
      model: metadata.planModel,
      editorModel: metadata.planEditorModel,
      contextWindow: metadata.planContextWindow,
      repoMapTokens: metadata.repoMapTokens,
      reasoningEffort: metadata.planReasoningEffort,
    },
  ];
}

function maskThread(document) {
  return {
    id: document.$id,
    title: document.title || 'New thread',
    workspaceKey: document.workspaceKey || null,
    workspaceName: document.workspaceName || null,
    status: document.status || 'active',
    messageCount: Number(document.messageCount || 0),
    lastMessagePreview: document.lastMessagePreview || '',
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastMessageAt: document.lastMessageAt || document.updatedAt || document.createdAt,
  };
}

function maskThreadMessage(document) {
  let metadata = {};
  try {
    metadata = document.metadataJson ? JSON.parse(document.metadataJson) : {};
  } catch {
    metadata = {};
  }

  return {
    id: document.$id,
    threadId: document.threadId,
    role: document.role,
    content: document.content || '',
    tone: document.tone || 'default',
    metadata,
    createdAt: document.createdAt,
  };
}

function isBlockedIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split('.').map((part) => Number.parseInt(part, 10));
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] === 0
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }

  return false;
}

async function validatePublicHttpsBaseUrl(value) {
  const rawValue = String(value || '').trim();
  let url;

  try {
    url = new URL(rawValue);
  } catch {
    throw new Error('Base URL must be a valid HTTPS URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Base URL must use HTTPS.');
  }

  if (url.username || url.password) {
    throw new Error('Base URL must not include embedded credentials.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new Error('Base URL host is not allowed.');
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('Base URL must not point to a private or local address.');
    }
  } else {
    const records = await dns.lookup(hostname, { all: true });
    if (records.some((record) => isBlockedIp(record.address))) {
      throw new Error('Base URL resolves to a private or local address.');
    }
  }

  return rawValue.replace(/\/+$/, '');
}

function nextResetAt() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

async function findDocument(databases, collectionId, queries) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [...queries, Query.limit(1)]);
  return response.documents[0] || null;
}

async function ensureCreditAccount(databases, userId) {
  const now = new Date().toISOString();
  const periodKey = periodKeyFor();
  const existing = await findDocument(databases, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, [
    Query.equal('userId', userId),
    Query.equal('periodKey', periodKey),
  ]);

  if (existing) {
    return existing;
  }

  return databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID,
    ID.unique(),
    {
      userId,
      periodKey,
      monthlyAllowance: DEFAULT_CREDIT_ALLOWANCE,
      usedCredits: 0,
      resetAt: nextResetAt(),
      createdAt: now,
      updatedAt: now,
    },
    [],
  );
}

async function ensurePreferences(databases, userId) {
  const existing = await findDocument(databases, APPWRITE_AGENT_USER_PREFERENCES_COLLECTION_ID, [Query.equal('userId', userId)]);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const preferences = {
    userId,
    selectedSource: 'managed',
    defaultMode: 'fast',
    selectedCustomCredentialId: null,
    createdAt: now,
    updatedAt: now,
  };

  return databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_USER_PREFERENCES_COLLECTION_ID,
    ID.unique(),
    preferences,
    [],
  );
}

async function ensureManagedAssignment(databases, userId) {
  const existing = await findDocument(databases, APPWRITE_AGENT_USER_MANAGED_KEYS_COLLECTION_ID, [
    Query.equal('userId', userId),
    Query.equal('status', 'active'),
  ]);

  if (existing) {
    return existing;
  }

  const pool = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, [
    Query.equal('status', 'active'),
    Query.limit(100),
  ]);

  const available = pool.documents
    .filter((entry) => {
      const maxAssignments = Number(entry.maxAssignments || 0);
      return maxAssignments <= 0 || Number(entry.assignedCount || 0) < maxAssignments;
    })
    .sort((left, right) => {
      const weightDelta = Number(right.assignmentWeight || 1) - Number(left.assignmentWeight || 1);
      return weightDelta || Number(left.assignedCount || 0) - Number(right.assignedCount || 0);
    })[0];

  if (!available) {
    return null;
  }

  const now = new Date().toISOString();
  const assignment = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_USER_MANAGED_KEYS_COLLECTION_ID,
    ID.unique(),
    {
      userId,
      poolKeyId: available.$id,
      status: 'active',
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    [],
  );

  try {
    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, available.$id, {
      assignedCount: Number(available.assignedCount || 0) + 1,
      updatedAt: now,
    });
  } catch {
    // Assignment is still valid if this non-critical counter update loses a race.
  }

  return assignment;
}

async function getManagedPoolKey(databases, assignment) {
  if (!assignment?.poolKeyId) {
    return null;
  }

  try {
    return await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, assignment.poolKeyId);
  } catch {
    return null;
  }
}

async function listCustomCredentials(databases, userId) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, [
    Query.equal('userId', userId),
    Query.limit(100),
  ]);

  return response.documents.map(maskCredential);
}

async function listRecentUsage(databases, userId) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID, [
    Query.equal('userId', userId),
    Query.orderDesc('createdAt'),
    Query.limit(20),
  ]);

  return response.documents.map((entry) => ({
    id: entry.$id,
    source: entry.source,
    mode: entry.mode,
    status: entry.status,
    modelAlias: entry.modelAlias || null,
    totalTokens: Number(entry.totalTokens || 0),
    multiplier: Number(entry.multiplier || 1),
    chargedCredits: Number(entry.chargedCredits || 0),
    createdAt: entry.createdAt,
    errorMessage: entry.errorMessage || null,
  }));
}

async function getOwnedThread(databases, userId, threadId) {
  const cleanThreadId = String(threadId || '').trim();
  if (!cleanThreadId) {
    throw new Error('threadId is required.');
  }

  const thread = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_THREADS_COLLECTION_ID, cleanThreadId);
  if (thread.userId !== userId || thread.status === 'deleted') {
    throw new Error('Thread was not found.');
  }

  return thread;
}

async function listThreadDocuments(databases, userId, workspaceKey = null, limit = 50) {
  const queries = [
    Query.equal('userId', userId),
    Query.orderDesc('lastMessageAt'),
    Query.limit(limit),
  ];

  try {
    const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_THREADS_COLLECTION_ID, queries);
    return response.documents
      .filter((thread) => thread.status === 'active' && (!workspaceKey || thread.workspaceKey === workspaceKey))
      .map(maskThread);
  } catch {
    return [];
  }
}

async function listThreads(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const workspaceKey = String(payload.workspaceKey || '').trim() || null;
  return ok(res, await listThreadDocuments(databases, user.$id, workspaceKey));
}

async function createThread(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const now = new Date().toISOString();
  const title = defaultThreadTitle(payload.title);

  const thread = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_THREADS_COLLECTION_ID,
    ID.unique(),
    {
      userId: user.$id,
      title,
      workspaceKey: String(payload.workspaceKey || '').trim() || null,
      workspaceName: String(payload.workspaceName || '').trim() || null,
      status: 'active',
      messageCount: 0,
      lastMessagePreview: '',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    },
    [],
  );

  return ok(res, maskThread(thread), 201);
}

async function listThreadMessages(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const thread = await getOwnedThread(databases, user.$id, payload.threadId);

  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_THREAD_MESSAGES_COLLECTION_ID, [
    Query.equal('userId', user.$id),
    Query.equal('threadId', thread.$id),
    Query.orderAsc('createdAt'),
    Query.limit(200),
  ]);

  return ok(res, response.documents.map(maskThreadMessage));
}

async function createThreadMessage(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const thread = await getOwnedThread(databases, user.$id, payload.threadId);
  const role = ['user', 'assistant', 'status'].includes(payload.role) ? payload.role : 'status';
  const tone = ['default', 'success', 'error', 'warning'].includes(payload.tone) ? payload.tone : 'default';
  const content = String(payload.content || '').trim();

  if (!content) {
    return fail(res, 400, 'Message content is required.');
  }

  const now = new Date().toISOString();
  const metadataJson = payload.metadata && typeof payload.metadata === 'object' ? JSON.stringify(payload.metadata).slice(0, 4096) : '{}';
  const message = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_THREAD_MESSAGES_COLLECTION_ID,
    ID.unique(),
    {
      userId: user.$id,
      threadId: thread.$id,
      role,
      content,
      tone,
      metadataJson,
      createdAt: now,
    },
    [],
  );

  const messageCount = Number(thread.messageCount || 0) + 1;
  const shouldRename = messageCount === 1 && role === 'user' && (!thread.title || thread.title === 'New thread' || thread.title === 'New Chat');
  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_THREADS_COLLECTION_ID, thread.$id, {
    title: shouldRename ? defaultThreadTitle(content) : thread.title,
    messageCount,
    lastMessagePreview: cleanPreview(content),
    lastMessageAt: now,
    updatedAt: now,
  });

  return ok(res, maskThreadMessage(message), 201);
}

async function renameThread(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const thread = await getOwnedThread(databases, user.$id, payload.threadId);
  const title = defaultThreadTitle(payload.title);
  const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_THREADS_COLLECTION_ID, thread.$id, {
    title,
    updatedAt: new Date().toISOString(),
  });

  return ok(res, maskThread(updated));
}

async function deleteThread(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const thread = await getOwnedThread(databases, user.$id, payload.threadId);

  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_THREADS_COLLECTION_ID, thread.$id, {
    status: 'deleted',
    updatedAt: new Date().toISOString(),
  });

  return ok(res, { deleted: true });
}

async function bootstrap(req, res) {
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const [assignment, preferences, creditAccount, customCredentials, recentUsage, recentThreads] = await Promise.all([
    ensureManagedAssignment(databases, user.$id),
    ensurePreferences(databases, user.$id),
    ensureCreditAccount(databases, user.$id),
    listCustomCredentials(databases, user.$id),
    listRecentUsage(databases, user.$id),
    listThreadDocuments(databases, user.$id),
  ]);
  const managedModelMetadata = maskManagedModelMetadata(await getManagedPoolKey(databases, assignment));

  return ok(res, {
    managedAvailable: Boolean(assignment),
    managedModes: managedModesFromMetadata(managedModelMetadata),
    managedModelMetadata,
    preferences: {
      selectedSource: preferences.selectedSource || 'managed',
      defaultMode: preferences.defaultMode || 'fast',
      selectedCustomCredentialId: preferences.selectedCustomCredentialId || null,
      selectedCustomModelName: preferences.selectedCustomModelName || null,
    },
    customCredentials,
    creditAccount: maskCreditAccount(creditAccount),
    recentUsage,
    recentThreads,
  });
}

async function savePreferences(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const preferences = await ensurePreferences(databases, user.$id);
  const now = new Date().toISOString();

  const update = {
    selectedSource: payload.selectedSource === 'custom' ? 'custom' : 'managed',
    defaultMode: payload.defaultMode === 'plan' ? 'plan' : 'fast',
    selectedCustomCredentialId: payload.selectedSource === 'custom' ? payload.selectedCustomCredentialId || null : null,
    updatedAt: now,
  };

  let updated;
  if (payload.selectedSource === 'custom' && payload.selectedCustomModelName) {
    try {
      updated = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_USER_PREFERENCES_COLLECTION_ID, preferences.$id, {
        ...update,
        selectedCustomModelName: payload.selectedCustomModelName,
      });
    } catch (error) {
      if (!isUnknownSelectedCustomModelError(error)) {
        throw error;
      }
    }
  }

  if (!updated) {
    updated = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_USER_PREFERENCES_COLLECTION_ID, preferences.$id, update);
  }

  return ok(res, {
    selectedSource: updated.selectedSource,
    defaultMode: updated.defaultMode,
    selectedCustomCredentialId: updated.selectedCustomCredentialId || null,
    selectedCustomModelName: updated.selectedCustomModelName || null,
  });
}

async function createCustomCredential(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const displayName = String(payload.displayName || '').trim();
  const apiKey = String(payload.apiKey || '').trim();
  const modelNames = ensureArray(payload.modelNames);

  if (!displayName) {
    return fail(res, 400, 'Display name is required.');
  }

  if (!apiKey) {
    return fail(res, 400, 'API key is required.');
  }

  if (modelNames.length === 0) {
    return fail(res, 400, 'Add at least one model name.');
  }

  const baseUrl = await validatePublicHttpsBaseUrl(payload.baseUrl);
  const databases = new Databases(createAdminClient(req));
  const now = new Date().toISOString();
  const document = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID,
    ID.unique(),
    {
      userId: user.$id,
      displayName,
      baseUrl,
      apiKey,
      apiKeyPreview: redactSecret(apiKey),
      modelNames,
      enabled: payload.enabled !== false,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    [],
  );

  return ok(res, maskCredential(document), 201);
}

async function updateCustomCredential(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const credentialId = String(payload.credentialId || '').trim();

  if (!credentialId) {
    return fail(res, 400, 'credentialId is required.');
  }

  const databases = new Databases(createAdminClient(req));
  const existing = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, credentialId);
  if (existing.userId !== user.$id) {
    return fail(res, 404, 'Credential was not found.');
  }

  const update = {
    updatedAt: new Date().toISOString(),
  };

  if ('displayName' in payload) {
    const displayName = String(payload.displayName || '').trim();
    if (!displayName) {
      return fail(res, 400, 'Display name is required.');
    }
    update.displayName = displayName;
  }

  if ('baseUrl' in payload) {
    update.baseUrl = await validatePublicHttpsBaseUrl(payload.baseUrl);
  }

  if ('modelNames' in payload) {
    const modelNames = ensureArray(payload.modelNames);
    if (modelNames.length === 0) {
      return fail(res, 400, 'Add at least one model name.');
    }
    update.modelNames = modelNames;
  }

  if ('enabled' in payload) {
    update.enabled = Boolean(payload.enabled);
  }

  if (String(payload.apiKey || '').trim()) {
    update.apiKey = String(payload.apiKey).trim();
    update.apiKeyPreview = redactSecret(update.apiKey);
  }

  const document = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, credentialId, update);
  return ok(res, maskCredential(document));
}

async function deleteCustomCredential(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const credentialId = String(payload.credentialId || '').trim();

  if (!credentialId) {
    return fail(res, 400, 'credentialId is required.');
  }

  const databases = new Databases(createAdminClient(req));
  const existing = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, credentialId);
  if (existing.userId !== user.$id) {
    return fail(res, 404, 'Credential was not found.');
  }

  await databases.deleteDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, credentialId);
  return ok(res, { deleted: true });
}

async function testCustomCredential(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const credentialId = String(payload.credentialId || '').trim();

  if (!credentialId) {
    return fail(res, 400, 'credentialId is required.');
  }

  const databases = new Databases(createAdminClient(req));
  const credential = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, credentialId);
  if (credential.userId !== user.$id) {
    return fail(res, 404, 'Credential was not found.');
  }

  const baseUrl = await validatePublicHttpsBaseUrl(credential.baseUrl);
  const response = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${credential.apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status >= 300 && response.status < 400) {
    return fail(res, 400, 'Provider redirected the request, so the endpoint was rejected.');
  }

  if (!response.ok) {
    return fail(res, response.status, 'Provider rejected the API key or base URL.');
  }

  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, credentialId, {
    updatedAt: new Date().toISOString(),
  });

  return ok(res, { ok: true });
}

export default async function ({ req, res, error }) {
  try {
    if (!APPWRITE_DATABASE_ID) {
      return fail(res, 500, 'Database configuration is incomplete.');
    }

    switch (req.path) {
      case '/bootstrap':
      case '/':
        return await bootstrap(req, res);
      case '/preferences':
        return await savePreferences(req, res);
      case '/custom-credentials/create':
        return await createCustomCredential(req, res);
      case '/custom-credentials/update':
        return await updateCustomCredential(req, res);
      case '/custom-credentials/delete':
        return await deleteCustomCredential(req, res);
      case '/custom-credentials/test':
        return await testCustomCredential(req, res);
      case '/threads/list':
        return await listThreads(req, res);
      case '/threads/create':
        return await createThread(req, res);
      case '/threads/messages':
        return await listThreadMessages(req, res);
      case '/threads/message/create':
        return await createThreadMessage(req, res);
      case '/threads/rename':
        return await renameThread(req, res);
      case '/threads/delete':
        return await deleteThread(req, res);
      default:
        return fail(res, 404, `Unknown agent settings path: ${req.path}`);
    }
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : 'Unexpected agent-settings failure.';
    error(message);
    return fail(res, 500, message);
  }
}

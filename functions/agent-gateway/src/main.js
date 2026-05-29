import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

import { Account, Client, Databases, ID, Query } from 'node-appwrite';
import {
  AGENT_OUTPUT_STYLE_SETTING_KEY,
  DEFAULT_AGENT_OUTPUT_STYLE,
  applyAgentOutputPolicy,
  normalizeAgentOutputStyle,
} from './outputPolicy.js';
import { resolveStoredApiKey } from './secretEnvelope.js';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID = 'agent_managed_key_pool',
  APPWRITE_AGENT_USER_MANAGED_KEYS_COLLECTION_ID = 'agent_user_managed_keys',
  APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID = 'agent_custom_credentials',
  APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID = 'agent_credit_accounts',
  APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID = 'agent_usage_ledger',
  APPWRITE_APP_SETTINGS_COLLECTION_ID = 'app_settings',
  AGENT_DEFAULT_MONTHLY_CREDITS = '500',
} = process.env;

const DEFAULT_CREDIT_ALLOWANCE = Number.parseInt(AGENT_DEFAULT_MONTHLY_CREDITS, 10) || 500;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_POWER_REASONING_EFFORT = 'medium';

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
  if (Buffer.byteLength(req.bodyText || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('Agent request body is too large.');
  }

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

function requestUserJwt(req) {
  const authorization = req.headers.authorization || req.headers.Authorization || '';
  return (
    req.headers['x-appwrite-user-jwt'] ||
    req.headers['x-appwrite-jwt'] ||
    String(authorization).replace(/^Bearer\s+/i, '').trim()
  );
}

async function resolveUser(req) {
  const account = new Account(createUserClient(requestUserJwt(req)));
  return account.get();
}

function periodKeyFor(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextResetAt() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
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

function isAzureFoundryHost(hostname) {
  return hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com');
}

async function normalizeOpenAiV1BaseUrl(value) {
  const safeBaseUrl = await validatePublicHttpsBaseUrl(value);
  const url = new URL(safeBaseUrl);
  const pathName = url.pathname.replace(/\/+$/, '');

  if (pathName.endsWith('/openai/v1') || pathName.endsWith('/v1')) {
    url.pathname = pathName || '/';
    return {
      baseUrl: url.toString().replace(/\/+$/, ''),
      isAzure: isAzureFoundryHost(url.hostname.toLowerCase()),
    };
  }

  url.pathname = `${pathName}${isAzureFoundryHost(url.hostname.toLowerCase()) ? '/openai/v1' : '/v1'}`;
  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    isAzure: isAzureFoundryHost(url.hostname.toLowerCase()),
  };
}

function normalizeGatewayPath(value) {
  const rawPath = String(value || '/v1/chat/completions').trim();
  if (rawPath.endsWith('/responses')) {
    return '/responses';
  }
  if (rawPath.endsWith('/completions') && !rawPath.endsWith('/chat/completions')) {
    return '/completions';
  }
  return '/chat/completions';
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

function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const values = [
      error.message,
      error.response?.message,
      error.responseBody,
      error.body,
    ];
    const message = values.find((value) => typeof value === 'string' && value.length > 0);
    if (message) {
      return message;
    }
  }

  return String(error || '');
}

function isConflictError(error) {
  const statusCode = Number(error?.code || error?.status || error?.response?.code || 0);
  return statusCode === 409 || /already exists|conflict/i.test(errorMessage(error));
}

function stableDocumentId(prefix, ...parts) {
  const suffix = parts
    .join('_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, Math.max(1, 35 - prefix.length));

  return `${prefix}_${suffix || 'document'}`.slice(0, 36);
}

async function findDocument(databases, collectionId, queries) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [...queries, Query.limit(1)]);
  return response.documents[0] || null;
}

async function resolveAgentOutputStyle(databases) {
  try {
    const document = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_APP_SETTINGS_COLLECTION_ID, AGENT_OUTPUT_STYLE_SETTING_KEY);
    return normalizeAgentOutputStyle(document?.value);
  } catch {
    try {
      const document = await findDocument(databases, APPWRITE_APP_SETTINGS_COLLECTION_ID, [Query.equal('key', AGENT_OUTPUT_STYLE_SETTING_KEY)]);
      return normalizeAgentOutputStyle(document?.value);
    } catch {
      return DEFAULT_AGENT_OUTPUT_STYLE;
    }
  }
}

async function ensureCreditAccount(databases, userId) {
  const now = new Date().toISOString();
  const periodKey = periodKeyFor();
  const documentId = stableDocumentId('credit', periodKey.replace(/-/g, ''), userId);
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
    documentId,
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
  ).catch(async (error) => {
    if (!isConflictError(error)) {
      throw error;
    }

    return databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, documentId);
  });
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
  const documentId = stableDocumentId('managed', userId);
  let createdAssignment = false;
  const assignment = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_USER_MANAGED_KEYS_COLLECTION_ID,
    documentId,
    {
      userId,
      poolKeyId: available.$id,
      status: 'active',
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    [],
  ).then((document) => {
    createdAssignment = true;
    return document;
  }).catch(async (error) => {
    if (!isConflictError(error)) {
      throw error;
    }

    const racedAssignment = await findDocument(databases, APPWRITE_AGENT_USER_MANAGED_KEYS_COLLECTION_ID, [
      Query.equal('userId', userId),
      Query.equal('status', 'active'),
    ]);

    return racedAssignment || databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_USER_MANAGED_KEYS_COLLECTION_ID, documentId);
  });

  try {
    if (createdAssignment) {
      await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, available.$id, {
        assignedCount: Number(available.assignedCount || 0) + 1,
        updatedAt: now,
      });
    }
  } catch {
    // Assignment is still valid if this non-critical counter update loses a race.
  }

  return assignment;
}

function stripOpenAiPrefix(modelName) {
  const value = String(modelName || '').trim();
  return value.startsWith('openai/') ? value.slice('openai/'.length) : value;
}

function normalizeAgentMode(value) {
  return value === 'power' || value === 'plan' ? 'power' : 'fast';
}

function resolveManagedModel(poolKey, mode, incomingModel) {
  const alias = stripOpenAiPrefix(incomingModel);
  if (alias === 'tantalum-power-editor' || alias === 'tantalum-plan-editor') {
    return poolKey.powerEditorModel || poolKey.planEditorModel || poolKey.powerModel || poolKey.planModel;
  }

  if (alias === 'tantalum-fast-editor') {
    return poolKey.fastEditorModel || poolKey.fastModel;
  }

  if (mode === 'power') {
    return poolKey.powerModel || poolKey.planModel || poolKey.fastModel;
  }

  return poolKey.fastModel;
}

async function resolveManagedProvider(databases, userId, mode, incomingModel) {
  const assignment = await ensureManagedAssignment(databases, userId);

  if (!assignment) {
    throw new Error('No managed model key is assigned to this account yet.');
  }

  const poolKey = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, assignment.poolKeyId);
  if (poolKey.status !== 'active') {
    throw new Error('The assigned managed model key is not active.');
  }

  const model = resolveManagedModel(poolKey, mode, incomingModel);
  if (!model) {
    throw new Error('The assigned managed key does not have a model configured for this mode.');
  }

  const endpoint = await normalizeOpenAiV1BaseUrl(poolKey.baseUrl);
  const apiKey = resolveStoredApiKey(poolKey, 'Managed model key');

  return {
    baseUrl: endpoint.baseUrl,
    isAzure: endpoint.isAzure,
    apiKey,
    model,
    modelAlias: mode === 'power' ? 'Power' : 'Fast',
    sourceLabel: poolKey.providerLabel || 'Managed',
    reasoningEffort: mode === 'power' ? poolKey.powerReasoningEffort || poolKey.planReasoningEffort || DEFAULT_POWER_REASONING_EFFORT : null,
  };
}

async function resolveCustomProvider(databases, userId, credentialId, modelName) {
  if (!credentialId) {
    throw new Error('Choose a custom credential before using custom models.');
  }

  const credential = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, credentialId);
  if (credential.userId !== userId || !credential.enabled) {
    throw new Error('The selected custom credential is not available.');
  }

  const cleanModelName = stripOpenAiPrefix(modelName);
  const modelNames = ensureArray(credential.modelNames);
  if (!cleanModelName || !modelNames.includes(cleanModelName)) {
    throw new Error('The selected custom model is not configured for this credential.');
  }

  const endpoint = await normalizeOpenAiV1BaseUrl(credential.baseUrl);
  const apiKey = resolveStoredApiKey(credential, 'Custom credential');

  return {
    baseUrl: endpoint.baseUrl,
    isAzure: endpoint.isAzure,
    apiKey,
    model: cleanModelName,
    modelAlias: cleanModelName,
    sourceLabel: credential.displayName || 'Custom',
    credentialId,
  };
}

function calculateCredits(openAiResponse, requestBody, multiplier) {
  const totalTokens = Number(openAiResponse?.usage?.total_tokens || 0);
  const estimatedTokens = totalTokens || Math.ceil(JSON.stringify(requestBody || {}).length / 4);
  const baseCredits = Math.max(1, Math.ceil(estimatedTokens / 1000));
  return {
    totalTokens: estimatedTokens,
    chargedCredits: baseCredits * multiplier,
  };
}

async function recordUsage(databases, event) {
  const now = new Date().toISOString();
  await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID,
    ID.unique(),
    {
      requestId: event.requestId,
      userId: event.userId,
      source: event.source,
      mode: event.mode,
      providerLabel: event.providerLabel || '',
      modelAlias: event.modelAlias || '',
      status: event.status,
      totalTokens: Number(event.totalTokens || 0),
      multiplier: Number(event.multiplier || 1),
      chargedCredits: Number(event.chargedCredits || 0),
      errorMessage: event.errorMessage || null,
      createdAt: now,
    },
    [],
  );
}

async function debitCredits(databases, creditAccount, chargedCredits) {
  const usedCredits = Number(creditAccount.usedCredits || 0) + chargedCredits;
  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, creditAccount.$id, {
    usedCredits,
    updatedAt: new Date().toISOString(),
  });
}

async function callUpstream(provider, requestBody, endpointPath) {
  const upstreamBody = {
    ...requestBody,
    model: provider.model,
  };
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };

  if (provider.isAzure) {
    headers['api-key'] = provider.apiKey;
  }

  const response = await fetch(`${provider.baseUrl}${endpointPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(120000),
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = { rawText };
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Provider redirected the request, so the endpoint was rejected.');
  }

  if (!response.ok) {
    throw new Error(parsed?.error?.message || parsed?.message || rawText || 'Provider request failed.');
  }

  return parsed;
}

async function handleChatCompletion(req, res) {
  const payload = readPayload(req);
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const source = payload.source === 'custom' ? 'custom' : 'managed';
  const mode = normalizeAgentMode(payload.mode);
  const multiplier = source === 'managed' && mode === 'power' ? 2 : 1;
  const requestBody = payload.request && typeof payload.request === 'object' ? payload.request : {};
  const endpointPath = normalizeGatewayPath(payload.apiPath || req.path);
  const requestId = crypto.randomUUID();
  const creditAccount = await ensureCreditAccount(databases, user.$id);
  const outputStyle = await resolveAgentOutputStyle(databases);
  const upstreamRequestBody = applyAgentOutputPolicy(requestBody, endpointPath, outputStyle);

  if (source === 'managed') {
    const remainingCredits = Number(creditAccount.monthlyAllowance || 0) - Number(creditAccount.usedCredits || 0);
    if (remainingCredits <= 0) {
      await recordUsage(databases, {
        requestId,
        userId: user.$id,
        source,
        mode,
        status: 'blocked',
        multiplier,
        errorMessage: 'Monthly managed agent credits are exhausted.',
      });
      return fail(res, 402, 'Monthly managed agent credits are exhausted.');
    }
  }

  let provider;
  try {
    provider =
      source === 'custom'
        ? await resolveCustomProvider(databases, user.$id, payload.customCredentialId, payload.customModelName || upstreamRequestBody.model)
        : await resolveManagedProvider(databases, user.$id, mode, upstreamRequestBody.model);

    const upstreamResponse = await callUpstream(provider, upstreamRequestBody, endpointPath);
    const credits = calculateCredits(upstreamResponse, upstreamRequestBody, multiplier);
    const chargedCredits = source === 'managed' ? credits.chargedCredits : 0;
    if (source === 'managed' && upstreamResponse && typeof upstreamResponse === 'object') {
      upstreamResponse.model = upstreamRequestBody.model || (mode === 'power' ? 'openai/tantalum-power' : 'openai/tantalum-fast');
    }

    if (source === 'managed') {
      await debitCredits(databases, creditAccount, chargedCredits);
    }

    if (source === 'custom' && provider.credentialId) {
      await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CUSTOM_CREDENTIALS_COLLECTION_ID, provider.credentialId, {
        lastUsedAt: new Date().toISOString(),
      });
    }

    await recordUsage(databases, {
      requestId,
      userId: user.$id,
      source,
      mode,
      providerLabel: provider.sourceLabel,
      modelAlias: provider.modelAlias,
      status: 'success',
      totalTokens: credits.totalTokens,
      multiplier,
      chargedCredits,
    });

    return ok(res, upstreamResponse);
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : 'Agent gateway request failed.';
    await recordUsage(databases, {
      requestId,
      userId: user.$id,
      source,
      mode,
      providerLabel: provider?.sourceLabel,
      modelAlias: provider?.modelAlias,
      status: 'failed',
      multiplier,
      errorMessage: message,
    });
    return fail(res, 500, message);
  }
}

export default async function ({ req, res, error }) {
  try {
    if (!APPWRITE_DATABASE_ID) {
      return fail(res, 500, 'Database configuration is incomplete.');
    }

    if (['/chat-completions', '/responses', '/completions', '/gateway', '/'].includes(req.path)) {
      return await handleChatCompletion(req, res);
    }

    return fail(res, 404, `Unknown agent gateway path: ${req.path}`);
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : 'Unexpected agent-gateway failure.';
    error(message);
    return fail(res, 500, message);
  }
}

export { applyAgentOutputPolicy, normalizeAgentOutputStyle } from './outputPolicy.js';

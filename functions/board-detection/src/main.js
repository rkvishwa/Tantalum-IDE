import crypto from 'node:crypto';

import { Account, Client, Databases, ID, Query } from 'node-appwrite';
import { resolveStoredApiKey } from './secretEnvelope.js';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID,
  APPWRITE_BOARD_DETECTION_MODEL_CONFIG_COLLECTION_ID,
  APPWRITE_BOARD_DETECTION_CACHE_COLLECTION_ID = 'board_detection_cache',
  APPWRITE_BOARD_DETECTION_USAGE_COLLECTION_ID = 'board_detection_usage',
} = process.env;

const MAX_PROMPT_BYTES = 12000;
const BOARD_DETECTION_TASK_TAG = 'board-detection';
const UTILITY_AI_MODEL_POOL_COLLECTION_ID =
  APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID ||
  APPWRITE_BOARD_DETECTION_MODEL_CONFIG_COLLECTION_ID ||
  'utility_ai_model_pool';

function json(res, status, payload) {
  return res.json(payload, status);
}

function ok(res, data, status = 200) {
  return json(res, status, { ok: true, data });
}

function fail(res, status, error) {
  return json(res, status, { ok: false, error });
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

function normalizeText(value, maxLength = 512) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeBaseUrl(value) {
  return normalizeText(value).replace(/\/+$/, '');
}

function fingerprintCandidate(candidate) {
  const existing = normalizeText(candidate?.fingerprint, 128);
  if (existing) {
    return existing;
  }

  const stable = [
    candidate?.serialNumber,
    candidate?.vendorId,
    candidate?.productId,
    candidate?.pnpId,
    candidate?.locationId,
    candidate?.manufacturer,
    candidate?.port,
  ]
    .map((entry) => normalizeText(entry).toLowerCase())
    .filter(Boolean)
    .join('|');

  return crypto.createHash('sha256').update(stable || crypto.randomUUID()).digest('hex');
}

async function findDocument(databases, collectionId, queries) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [...queries, Query.limit(1)]);
  return response.documents[0] || null;
}

function normalizeTaskTags(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry, 64).toLowerCase()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((entry) => normalizeText(entry, 64).toLowerCase())
      .filter(Boolean);
  }

  return [];
}

function supportsBoardDetection(config) {
  const taskTags = normalizeTaskTags(config.taskTags);
  return taskTags.length === 0 || taskTags.includes(BOARD_DETECTION_TASK_TAG);
}

function utilityModelPriority(value) {
  if (value === null || value === undefined || value === '') {
    return 100;
  }

  const priority = Number(value);
  return Number.isFinite(priority) ? priority : 100;
}

function sortUtilityModels(left, right) {
  const priorityDelta = utilityModelPriority(left.priority) - utilityModelPriority(right.priority);
  if (priorityDelta) {
    return priorityDelta;
  }

  const createdDelta = normalizeText(left.createdAt, 64).localeCompare(normalizeText(right.createdAt, 64));
  if (createdDelta) {
    return createdDelta;
  }

  return normalizeText(left.$id, 64).localeCompare(normalizeText(right.$id, 64));
}

async function listActiveUtilityModelConfigs(databases) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, UTILITY_AI_MODEL_POOL_COLLECTION_ID, [
    Query.equal('enabled', true),
    Query.limit(100),
  ]);
  return response.documents.filter(supportsBoardDetection).sort(sortUtilityModels);
}

function buildPrompt(candidate) {
  const input = {
    port: candidate.port,
    manufacturer: candidate.manufacturer,
    vendorId: candidate.vendorId,
    productId: candidate.productId,
    serialNumber: candidate.serialNumber,
    pnpId: candidate.pnpId,
    label: candidate.label,
    boardLabel: candidate.boardLabel,
    matchingBoards: candidate.matchingBoards,
  };
  const prompt = `Infer the most likely Arduino FQBN for this connected board metadata. Return strict JSON with keys fqbn, boardLabel, confidence from 0 to 1, and reason. If uncertain, return fqbn as an empty string and confidence below 0.55.\n${JSON.stringify(input)}`;
  return Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES ? prompt.slice(0, MAX_PROMPT_BYTES) : prompt;
}

function parseSuggestion(rawText, model) {
  const text = normalizeText(rawText, 4096);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { fqbn: '', confidence: 0, reason: 'Model did not return JSON.', model };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const confidence = Number(parsed.confidence || 0);
    return {
      fqbn: normalizeText(parsed.fqbn, 255),
      boardLabel: normalizeText(parsed.boardLabel || parsed.name, 255),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason: normalizeText(parsed.reason, 512),
      model,
    };
  } catch {
    return { fqbn: '', confidence: 0, reason: 'Model JSON was invalid.', model };
  }
}

async function callModel(config, candidate) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = normalizeText(config.model, 255);
  if (!baseUrl || !model) {
    throw new Error('Utility AI model pool entry is incomplete.');
  }
  const apiKey = resolveStoredApiKey(config, 'Utility AI model');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You identify Arduino-compatible boards from USB and Arduino CLI metadata. Prefer no answer over a low-quality guess.',
        },
        {
          role: 'user',
          content: buildPrompt(candidate),
        },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  const payload = await response.json().catch(() => ({}));
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Utility AI model request was redirected.');
  }

  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || 'Utility AI model request failed.');
  }

  const content = payload?.choices?.[0]?.message?.content || '';
  return parseSuggestion(content, model);
}

async function callUtilityModelPool(configs, candidate) {
  const failures = [];

  for (const config of configs) {
    try {
      return await callModel(config, candidate);
    } catch (error) {
      const provider = normalizeText(config.providerLabel, 120) || normalizeText(config.$id, 120) || 'Utility AI model';
      const model = normalizeText(config.model, 255);
      const message = error instanceof Error ? error.message : 'Utility AI model request failed.';
      failures.push(`${provider}${model ? `/${model}` : ''}: ${message}`);
    }
  }

  throw new Error(`All utility AI model pool entries failed. ${failures.join(' | ')}`);
}

async function cacheSuggestion(databases, fingerprint, suggestion) {
  const now = new Date().toISOString();
  const existing = await findDocument(databases, APPWRITE_BOARD_DETECTION_CACHE_COLLECTION_ID, [Query.equal('fingerprint', fingerprint)]);
  const data = {
    fingerprint,
    fqbn: suggestion.fqbn || '',
    boardLabel: suggestion.boardLabel || '',
    confidence: Number(suggestion.confidence || 0),
    reason: suggestion.reason || '',
    model: suggestion.model || '',
    updatedAt: now,
  };

  if (existing) {
    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARD_DETECTION_CACHE_COLLECTION_ID, existing.$id, data);
    return;
  }

  await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARD_DETECTION_CACHE_COLLECTION_ID, ID.unique(), {
    ...data,
    createdAt: now,
  });
}

async function recordUsage(databases, event) {
  await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARD_DETECTION_USAGE_COLLECTION_ID, ID.unique(), {
    userId: event.userId,
    fingerprint: event.fingerprint,
    status: event.status,
    fqbn: event.fqbn || '',
    confidence: Number(event.confidence || 0),
    model: event.model || '',
    errorMessage: event.errorMessage ? normalizeText(event.errorMessage, 1024) : null,
    createdAt: new Date().toISOString(),
  });
}

async function detect(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const candidate = payload.candidate && typeof payload.candidate === 'object' ? payload.candidate : null;
  if (!candidate) {
    return fail(res, 400, 'candidate is required.');
  }

  const databases = new Databases(createAdminClient(req));
  const fingerprint = fingerprintCandidate(candidate);
  const cached = await findDocument(databases, APPWRITE_BOARD_DETECTION_CACHE_COLLECTION_ID, [Query.equal('fingerprint', fingerprint)]);
  if (cached && Number(cached.confidence || 0) >= 0.55) {
    await recordUsage(databases, {
      userId: user.$id,
      fingerprint,
      status: 'cache-hit',
      fqbn: cached.fqbn,
      confidence: cached.confidence,
      model: cached.model,
    });
    return ok(res, {
      fqbn: cached.fqbn,
      boardLabel: cached.boardLabel,
      confidence: Number(cached.confidence || 0),
      reason: cached.reason || 'Cached board detection.',
      model: cached.model || null,
    });
  }

  const configs = await listActiveUtilityModelConfigs(databases);
  if (configs.length === 0) {
    await recordUsage(databases, {
      userId: user.$id,
      fingerprint,
      status: 'unconfigured',
      errorMessage: 'No eligible utility AI model pool entry is configured for board detection.',
    });
    return ok(res, {
      fqbn: '',
      confidence: 0,
      reason: 'No eligible utility AI model pool entry is configured for board detection.',
      model: null,
    });
  }

  try {
    const suggestion = await callUtilityModelPool(configs, candidate);
    await cacheSuggestion(databases, fingerprint, suggestion);
    await recordUsage(databases, {
      userId: user.$id,
      fingerprint,
      status: suggestion.fqbn ? 'suggested' : 'no-suggestion',
      fqbn: suggestion.fqbn,
      confidence: suggestion.confidence,
      model: suggestion.model,
    });
    return ok(res, suggestion);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Board detection failed.';
    await recordUsage(databases, {
      userId: user.$id,
      fingerprint,
      status: 'failed',
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

    return await detect(req, res);
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : 'Unexpected board-detection failure.';
    error(message);
    return fail(res, 500, message);
  }
}

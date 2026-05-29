import crypto from 'node:crypto';

import { Account, Client, Databases, ID, Query } from 'node-appwrite';
import { resolveStoredApiKey } from './secretEnvelope.js';
import {
  buildPrompt,
  clampConfidence,
  normalizeTaskTags,
  normalizeText,
  parseModelJson,
  supportsCodeExtract,
} from './helpers.js';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID = 'utility_ai_model_pool',
  APPWRITE_CODE_EXTRACT_USAGE_COLLECTION_ID = 'code_extract_usage',
} = process.env;

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

function normalizeBaseUrl(value) {
  return normalizeText(value).replace(/\/+$/, '');
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
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID, [
    Query.equal('enabled', true),
    Query.limit(100),
  ]);
  return response.documents.filter(supportsCodeExtract).sort(sortUtilityModels);
}

async function callModel(config, payload) {
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
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: 'You reconstruct Arduino/C++ code from firmware metadata. Be explicit about uncertainty and never claim exact decompilation.',
        },
        {
          role: 'user',
          content: buildPrompt(payload),
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });

  const responsePayload = await response.json().catch(() => ({}));
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Utility AI model request was redirected.');
  }
  if (!response.ok) {
    throw new Error(responsePayload?.error?.message || responsePayload?.message || 'Utility AI model request failed.');
  }

  const content = responsePayload?.choices?.[0]?.message?.content || '';
  return parseModelJson(content, model);
}

async function callUtilityModelPool(configs, payload) {
  const failures = [];

  for (const config of configs) {
    try {
      return await callModel(config, payload);
    } catch (error) {
      const provider = normalizeText(config.providerLabel, 120) || normalizeText(config.$id, 120) || 'Utility AI model';
      const model = normalizeText(config.model, 255);
      const message = error instanceof Error ? error.message : 'Utility AI model request failed.';
      failures.push(`${provider}${model ? `/${model}` : ''}: ${message}`);
    }
  }

  throw new Error(`All utility AI model pool entries failed. ${failures.join(' | ')}`);
}

async function recordUsage(databases, event) {
  try {
    await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_CODE_EXTRACT_USAGE_COLLECTION_ID, ID.unique(), {
      userId: event.userId,
      boardId: normalizeText(event.boardId, 128),
      boardType: normalizeText(event.boardType, 255),
      status: normalizeText(event.status, 64),
      model: normalizeText(event.model, 255),
      confidence: clampConfidence(event.confidence),
      errorMessage: event.errorMessage ? normalizeText(event.errorMessage, 1024) : null,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Usage logging must not block code viewing.
  }
}

async function extract(req, res) {
  const user = await resolveUser(req);
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const configs = await listActiveUtilityModelConfigs(databases);

  if (configs.length === 0) {
    await recordUsage(databases, {
      userId: user.$id,
      boardId: payload?.board?.id,
      boardType: payload?.board?.fqbn || payload?.board?.boardType,
      status: 'unconfigured',
      errorMessage: 'No eligible utility AI model pool entry is configured for code extraction.',
    });
    return ok(res, {
      files: [],
      confidence: 0,
      notes: 'No eligible utility AI model pool entry is configured for code extraction.',
      limitations: 'Create an enabled utility_ai_model_pool entry with taskTags containing code-extract.',
      model: null,
    });
  }

  try {
    const result = await callUtilityModelPool(configs, payload);
    await recordUsage(databases, {
      userId: user.$id,
      boardId: payload?.board?.id,
      boardType: payload?.board?.fqbn || payload?.board?.boardType,
      status: result.files.length ? 'generated' : 'empty',
      model: result.model,
      confidence: result.confidence,
    });
    return ok(res, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Code extraction failed.';
    await recordUsage(databases, {
      userId: user.$id,
      boardId: payload?.board?.id,
      boardType: payload?.board?.fqbn || payload?.board?.boardType,
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

    return await extract(req, res);
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : 'Unexpected code-extract failure.';
    error(message);
    return fail(res, 500, message);
  }
}

export const __test = {
  normalizeTaskTags,
  parseModelJson,
  supportsCodeExtract,
};

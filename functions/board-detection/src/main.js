import crypto from 'node:crypto';

import { Account, Client, Databases, ID, Query } from 'node-appwrite';
import { resolveStoredApiKey } from './secretEnvelope.js';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARD_DETECTION_MODEL_CONFIG_COLLECTION_ID = 'board_detection_model_config',
  APPWRITE_BOARD_DETECTION_CACHE_COLLECTION_ID = 'board_detection_cache',
  APPWRITE_BOARD_DETECTION_USAGE_COLLECTION_ID = 'board_detection_usage',
} = process.env;

const MAX_PROMPT_BYTES = 12000;

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

async function resolveUser(req) {
  const account = new Account(createUserClient(req.headers['x-appwrite-user-jwt']));
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

async function getActiveModelConfig(databases) {
  return findDocument(databases, APPWRITE_BOARD_DETECTION_MODEL_CONFIG_COLLECTION_ID, [
    Query.equal('enabled', true),
  ]);
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
    throw new Error('Board detection model config is incomplete.');
  }
  const apiKey = resolveStoredApiKey(config, 'Board detection model');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
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
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || 'Board detection model request failed.');
  }

  const content = payload?.choices?.[0]?.message?.content || '';
  return parseSuggestion(content, model);
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
    errorMessage: event.errorMessage || null,
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

  const config = await getActiveModelConfig(databases);
  if (!config) {
    await recordUsage(databases, {
      userId: user.$id,
      fingerprint,
      status: 'unconfigured',
      errorMessage: 'No active board detection model config.',
    });
    return ok(res, { fqbn: '', confidence: 0, reason: 'No active board detection model config.', model: null });
  }

  try {
    const suggestion = await callModel(config, candidate);
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

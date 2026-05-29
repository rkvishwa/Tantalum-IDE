#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_RAW_KEY_SENTINEL,
  encryptSecret,
  isLegacyRawSecret,
} from '../functions/agent-settings/src/secretEnvelope.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const applyChanges = args.has('--apply');

if (args.has('--help') || args.has('-h')) {
  console.log(`
Usage:
  node scripts/migrate-api-key-envelopes.mjs [--apply]

Required environment:
  APPWRITE_API_KEY                  Appwrite API key with database/document read+write access.
  TANTALUM_SECRET_KEK_V1            Base64-encoded 32-byte key-encryption key.

Optional environment:
  APPWRITE_ENDPOINT                 Defaults to appwrite.config.json endpoint.
  APPWRITE_PROJECT_ID               Defaults to appwrite.config.json projectId.
  APPWRITE_DATABASE_ID              Defaults to the first tablesDB id in appwrite.config.json.
  TANTALUM_SECRET_ACTIVE_KEK_VERSION Defaults to v1.

Default mode is dry-run. Pass --apply to write apiKeyEnvelope and replace raw apiKey values.
`);
  process.exit(0);
}

const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'appwrite.config.json'), 'utf8'));
const endpoint = String(process.env.APPWRITE_ENDPOINT || manifest.endpoint || '').replace(/\/+$/, '');
const projectId = String(process.env.APPWRITE_PROJECT_ID || manifest.projectId || '').trim();
const databaseId = String(process.env.APPWRITE_DATABASE_ID || manifest.tablesDB?.[0]?.$id || '').trim();
const appwriteApiKey = String(process.env.APPWRITE_API_KEY || '').trim();
const legacyBoardDetectionCollectionId = 'board_detection_model_config';
const utilityAiModelPoolCollectionId = 'utility_ai_model_pool';

const collections = [
  {
    id: 'agent_managed_key_pool',
    label: 'Agent managed key pool',
    hasApiKeyPreview: false,
  },
  {
    id: 'agent_custom_credentials',
    label: 'Agent custom credentials',
    hasApiKeyPreview: true,
  },
  {
    id: utilityAiModelPoolCollectionId,
    label: 'Utility AI model pool',
    hasApiKeyPreview: false,
  },
];

function assertReady() {
  const missing = [];
  if (!endpoint) missing.push('APPWRITE_ENDPOINT');
  if (!projectId) missing.push('APPWRITE_PROJECT_ID');
  if (!databaseId) missing.push('APPWRITE_DATABASE_ID');
  if (!appwriteApiKey) missing.push('APPWRITE_API_KEY');
  if (applyChanges && !process.env.TANTALUM_SECRET_KEK_V1) missing.push('TANTALUM_SECRET_KEK_V1');

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }

  if (applyChanges) {
    encryptSecret('migration-readiness-check');
  }
}

function redactSecret(value) {
  const secret = String(value || '').trim();
  if (secret.length <= 4) {
    return secret ? '****' : '';
  }

  return `****${secret.slice(-4)}`;
}

async function appwriteRequest(method, pathName, body, options = {}) {
  const response = await fetch(`${endpoint}${pathName}`, {
    method,
    headers: {
      'X-Appwrite-Project': projectId,
      'X-Appwrite-Key': appwriteApiKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { rawText: text };
  }

  if (options.allow404 && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`${method} ${pathName} failed with ${response.status}: ${payload.message || text}`);
  }

  return payload;
}

function documentPath(collectionId, documentId) {
  return `/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(documentId)}`;
}

async function getDocument(collectionId, documentId) {
  return appwriteRequest('GET', documentPath(collectionId, documentId), null, { allow404: true });
}

async function listDocuments(collectionId, options = {}) {
  const documents = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const searchParams = new URLSearchParams();
    searchParams.append('queries[]', `limit(${limit})`);
    searchParams.append('queries[]', `offset(${offset})`);

    const payload = await appwriteRequest(
      'GET',
      `/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(collectionId)}/documents?${searchParams}`,
      null,
      { allow404: Boolean(options.allowMissing) },
    );
    if (!payload) {
      return documents;
    }

    const batch = Array.isArray(payload.documents) ? payload.documents : [];
    documents.push(...batch);

    if (batch.length < limit) {
      break;
    }

    offset += limit;
  }

  return documents;
}

function ensureTaskTags(value) {
  const tags = Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : String(value || '')
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  return tags.includes('board-detection') ? tags : [...tags, 'board-detection'];
}

function utilityModelPriority(value) {
  if (value === null || value === undefined || value === '') {
    return 100;
  }

  const priority = Number(value);
  return Number.isFinite(priority) ? priority : 100;
}

function copyableUtilityAiPoolData(document, now) {
  const rawKey = String(document.apiKey || '').trim();
  return {
    providerLabel: String(document.providerLabel || 'OpenAI-compatible').trim(),
    baseUrl: String(document.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: rawKey || LEGACY_RAW_KEY_SENTINEL,
    apiKeyEnvelope: String(document.apiKeyEnvelope || '').trim() || null,
    model: String(document.model || '').trim(),
    enabled: Boolean(document.enabled),
    taskTags: ensureTaskTags(document.taskTags),
    priority: utilityModelPriority(document.priority),
    createdAt: String(document.createdAt || document.$createdAt || now),
    updatedAt: String(document.updatedAt || document.$updatedAt || now),
  };
}

async function copyLegacyBoardDetectionModelConfigs() {
  const legacyDocuments = await listDocuments(legacyBoardDetectionCollectionId, { allowMissing: true });
  const summary = {
    checked: legacyDocuments.length,
    wouldCreate: 0,
    created: 0,
    skipped: 0,
    warnings: 0,
  };
  const now = new Date().toISOString();

  for (const document of legacyDocuments) {
    const existing = await getDocument(utilityAiModelPoolCollectionId, document.$id);
    if (existing) {
      summary.skipped += 1;
      continue;
    }

    const data = copyableUtilityAiPoolData(document, now);
    if (!data.baseUrl || !data.model) {
      summary.warnings += 1;
      console.warn(`[warn] Legacy board detection document ${document.$id} is missing baseUrl or model and was not copied.`);
      continue;
    }

    summary.wouldCreate += 1;
    if (applyChanges) {
      await appwriteRequest('POST', `/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(utilityAiModelPoolCollectionId)}/documents`, {
        documentId: document.$id,
        data,
        permissions: [],
      });
      summary.created += 1;
    }
  }

  return summary;
}

async function migrateCollection(collection) {
  const documents = await listDocuments(collection.id);
  const summary = {
    checked: documents.length,
    wouldUpdate: 0,
    updated: 0,
    skipped: 0,
    warnings: 0,
  };

  for (const document of documents) {
    const rawKey = String(document.apiKey || '').trim();
    const hasEnvelope = Boolean(String(document.apiKeyEnvelope || '').trim());
    const update = {};

    if (isLegacyRawSecret(rawKey)) {
      summary.wouldUpdate += 1;
      update.apiKey = LEGACY_RAW_KEY_SENTINEL;
      update.updatedAt = new Date().toISOString();

      if (collection.hasApiKeyPreview) {
        update.apiKeyPreview = redactSecret(rawKey);
      }

      if (applyChanges) {
        update.apiKeyEnvelope = encryptSecret(rawKey);
      }
    } else if (hasEnvelope && rawKey !== LEGACY_RAW_KEY_SENTINEL) {
      summary.wouldUpdate += 1;
      update.apiKey = LEGACY_RAW_KEY_SENTINEL;
      update.updatedAt = new Date().toISOString();
    } else if (!hasEnvelope) {
      summary.warnings += 1;
      console.warn(`[warn] ${collection.label} document ${document.$id} has no raw apiKey and no apiKeyEnvelope.`);
      continue;
    } else {
      summary.skipped += 1;
      continue;
    }

    if (applyChanges) {
      await appwriteRequest('PATCH', documentPath(collection.id, document.$id), update);
      summary.updated += 1;
    }
  }

  return summary;
}

assertReady();

console.log(`API key envelope migration running in ${applyChanges ? 'APPLY' : 'DRY-RUN'} mode.`);
if (!applyChanges) {
  console.log('Pass --apply to write encrypted envelopes and replace legacy raw apiKey values.');
}

const copySummary = await copyLegacyBoardDetectionModelConfigs();
console.log(
  `Legacy board detection config copy: checked ${copySummary.checked}, ${applyChanges ? 'created' : 'would create'} ${
    applyChanges ? copySummary.created : copySummary.wouldCreate
  }, skipped ${copySummary.skipped}, warnings ${copySummary.warnings}`,
);

for (const collection of collections) {
  const summary = await migrateCollection(collection);
  console.log(
    `${collection.label}: checked ${summary.checked}, ${applyChanges ? 'updated' : 'would update'} ${
      applyChanges ? summary.updated : summary.wouldUpdate
    }, skipped ${summary.skipped}, warnings ${summary.warnings}`,
  );
}

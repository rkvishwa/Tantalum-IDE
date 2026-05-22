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
    id: 'board_detection_model_config',
    label: 'Board detection model config',
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

async function appwriteRequest(method, pathName, body) {
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

  if (!response.ok) {
    throw new Error(`${method} ${pathName} failed with ${response.status}: ${payload.message || text}`);
  }

  return payload;
}

function documentPath(collectionId, documentId) {
  return `/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(documentId)}`;
}

async function listDocuments(collectionId) {
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
    );
    const batch = Array.isArray(payload.documents) ? payload.documents : [];
    documents.push(...batch);

    if (batch.length < limit) {
      break;
    }

    offset += limit;
  }

  return documents;
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

for (const collection of collections) {
  const summary = await migrateCollection(collection);
  console.log(
    `${collection.label}: checked ${summary.checked}, ${applyChanges ? 'updated' : 'would update'} ${
      applyChanges ? summary.updated : summary.wouldUpdate
    }, skipped ${summary.skipped}, warnings ${summary.warnings}`,
  );
}

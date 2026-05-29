#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_RAW_KEY_SENTINEL,
  encryptSecret,
} from '../functions/agent-settings/src/secretEnvelope.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const applyChanges = args.has('--yes') || args.has('--apply');
const jsonOutput = args.has('--json');

if (args.has('--help') || args.has('-h')) {
  console.log(`
Usage:
  node scripts/seed-selfhost-appwrite.mjs [--yes] [--json]

Required environment:
  APPWRITE_ENDPOINT       Self-host endpoint, for example https://api.example.com/v1.
  APPWRITE_PROJECT_ID     Defaults to appwrite.config.json projectId.
  APPWRITE_DATABASE_ID    Defaults to appwrite.config.json database id.
  APPWRITE_API_KEY        Admin API key with database document read/write scope.

Required only when writing encrypted provider keys:
  TANTALUM_SECRET_KEK_V1

Optional documents seeded when matching env vars are present:
  AGENT_OUTPUT_STYLE
  TANTALUM_MANAGED_API_KEY plus TANTALUM_MANAGED_BASE_URL
  TANTALUM_UTILITY_AI_API_KEY

Default mode is dry-run. Pass --yes to create or update documents.
`);
  process.exit(0);
}

const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'appwrite.config.json'), 'utf8'));
const endpoint = String(process.env.APPWRITE_ENDPOINT || manifest.endpoint || '').replace(/\/+$/, '');
const projectId = String(process.env.APPWRITE_PROJECT_ID || manifest.projectId || '').trim();
const databaseId = String(process.env.APPWRITE_DATABASE_ID || manifest.tablesDB?.[0]?.$id || '697b8f660033fffde4be').trim();
const appwriteApiKey = String(process.env.APPWRITE_API_KEY || '').trim();

const collectionIds = {
  appSettings: process.env.APPWRITE_APP_SETTINGS_COLLECTION_ID || 'app_settings',
  managedPool: process.env.APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID || 'agent_managed_key_pool',
  utilityAiModelPool: process.env.APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID || 'utility_ai_model_pool',
};

function env(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function envFirst(names, fallback = '') {
  for (const name of names) {
    const value = env(name);
    if (value) {
      return value;
    }
  }
  return fallback;
}

function intEnv(name, fallback) {
  const value = Number.parseInt(env(name), 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = env(name).toLowerCase();
  if (!value) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function listEnv(name, fallback = '') {
  return env(name, fallback)
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function redactSecret(value) {
  const secret = String(value || '').trim();
  if (secret.length <= 4) {
    return secret ? '****' : '';
  }
  return `****${secret.slice(-4)}`;
}

function assertReady() {
  const missing = [];
  if (!endpoint) missing.push('APPWRITE_ENDPOINT');
  if (!projectId) missing.push('APPWRITE_PROJECT_ID');
  if (!databaseId) missing.push('APPWRITE_DATABASE_ID');
  if (!appwriteApiKey) missing.push('APPWRITE_API_KEY');

  if (applyChanges) {
    const createsEncryptedSecret =
      envFirst(['TANTALUM_MANAGED_API_KEY', 'MANAGED_MODEL_API_KEY']) ||
      env('TANTALUM_UTILITY_AI_API_KEY');
    if (createsEncryptedSecret && !process.env.TANTALUM_SECRET_KEK_V1) {
      missing.push('TANTALUM_SECRET_KEK_V1');
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
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

async function upsertDocument(plan, item) {
  const existing = await getDocument(item.collectionId, item.documentId);
  const operation = existing ? 'update' : 'create';
  plan.push({
    label: item.label,
    collectionId: item.collectionId,
    documentId: item.documentId,
    operation,
    fields: Object.keys(item.data).sort(),
  });

  if (!applyChanges) {
    return;
  }

  if (existing) {
    const updateData = { ...item.data };
    delete updateData.createdAt;
    await appwriteRequest('PATCH', documentPath(item.collectionId, item.documentId), {
      data: updateData,
      permissions: item.permissions || [],
    });
    return;
  }

  await appwriteRequest('POST', `/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(item.collectionId)}/documents`, {
    documentId: item.documentId,
    data: item.data,
    permissions: item.permissions || [],
  });
}

function buildSeedItems() {
  const now = new Date().toISOString();
  const items = [];
  const outputStyle = env('AGENT_OUTPUT_STYLE');

  if (outputStyle) {
    items.push({
      label: 'Agent output style',
      collectionId: collectionIds.appSettings,
      documentId: 'agent.outputStyle',
      permissions: [],
      data: {
        key: 'agent.outputStyle',
        value: outputStyle,
        description: 'Default output policy for managed agent responses.',
        updatedAt: now,
      },
    });
  }

  const managedApiKey = envFirst(['TANTALUM_MANAGED_API_KEY', 'MANAGED_MODEL_API_KEY']);
  if (managedApiKey) {
    const baseUrl = env('TANTALUM_MANAGED_BASE_URL');
    if (!baseUrl) {
      throw new Error('TANTALUM_MANAGED_BASE_URL is required when TANTALUM_MANAGED_API_KEY is set.');
    }

    const managedData = {
      providerLabel: env('TANTALUM_MANAGED_PROVIDER_LABEL', 'Azure AI Foundry'),
      baseUrl,
      apiKey: LEGACY_RAW_KEY_SENTINEL,
      apiKeyEnvelope: applyChanges ? encryptSecret(managedApiKey) : '<encrypted-on-apply>',
      status: env('TANTALUM_MANAGED_STATUS', 'active'),
      fastModel: env('TANTALUM_MANAGED_FAST_MODEL', 'gpt-4.1'),
      fastEditorModel: env('TANTALUM_MANAGED_FAST_EDITOR_MODEL', env('TANTALUM_MANAGED_FAST_MODEL', 'gpt-4.1')),
      powerModel: env('TANTALUM_MANAGED_POWER_MODEL', 'gpt-5.5'),
      powerEditorModel: env('TANTALUM_MANAGED_POWER_EDITOR_MODEL', env('TANTALUM_MANAGED_FAST_MODEL', 'gpt-4.1')),
      powerReasoningEffort: env('TANTALUM_MANAGED_POWER_REASONING_EFFORT', 'medium'),
      fastContextWindow: intEnv('TANTALUM_MANAGED_FAST_CONTEXT_WINDOW', 0),
      powerContextWindow: intEnv('TANTALUM_MANAGED_POWER_CONTEXT_WINDOW', 0),
      repoMapTokens: intEnv('TANTALUM_MANAGED_REPO_MAP_TOKENS', 2048),
      assignmentWeight: intEnv('TANTALUM_MANAGED_ASSIGNMENT_WEIGHT', 1),
      maxAssignments: intEnv('TANTALUM_MANAGED_MAX_ASSIGNMENTS', 0),
      createdAt: now,
      updatedAt: now,
    };
    if (env('TANTALUM_MANAGED_ASSIGNED_COUNT')) {
      managedData.assignedCount = intEnv('TANTALUM_MANAGED_ASSIGNED_COUNT', 0);
    }

    items.push({
      label: 'Managed agent model key',
      collectionId: collectionIds.managedPool,
      documentId: env('TANTALUM_MANAGED_POOL_DOCUMENT_ID', 'managed_primary'),
      permissions: [],
      data: managedData,
      safeDetails: {
        apiKeyPreview: redactSecret(managedApiKey),
      },
    });
  }

  const utilityAiApiKey = env('TANTALUM_UTILITY_AI_API_KEY');
  if (utilityAiApiKey) {
    items.push({
      label: 'Utility AI model pool key',
      collectionId: collectionIds.utilityAiModelPool,
      documentId: env('TANTALUM_UTILITY_AI_DOCUMENT_ID', 'utility_ai_board_detection_primary'),
      permissions: [],
      data: {
        providerLabel: env('TANTALUM_UTILITY_AI_PROVIDER_LABEL', 'OpenAI-compatible'),
        baseUrl: env('TANTALUM_UTILITY_AI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
        apiKey: LEGACY_RAW_KEY_SENTINEL,
        apiKeyEnvelope: applyChanges ? encryptSecret(utilityAiApiKey) : '<encrypted-on-apply>',
        model: env('TANTALUM_UTILITY_AI_MODEL', 'gpt-4.1-mini'),
        enabled: boolEnv('TANTALUM_UTILITY_AI_ENABLED', true),
        taskTags: listEnv('TANTALUM_UTILITY_AI_TASK_TAGS', 'board-detection'),
        priority: intEnv('TANTALUM_UTILITY_AI_PRIORITY', 100),
        createdAt: now,
        updatedAt: now,
      },
      safeDetails: {
        apiKeyPreview: redactSecret(utilityAiApiKey),
      },
    });
  }

  return items;
}

assertReady();

const items = buildSeedItems();
const plan = [];

for (const item of items) {
  await upsertDocument(plan, item);
}

const summary = {
  mode: applyChanges ? 'apply' : 'dry-run',
  endpoint,
  projectId,
  databaseId,
  planned: plan.length,
  documents: plan,
};

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Self-host seed ${applyChanges ? 'applied' : 'dry-run'} for ${projectId} at ${endpoint}.`);
  if (plan.length === 0) {
    console.log('No seed env vars were present, so no documents were planned.');
  } else {
    for (const document of plan) {
      console.log(`- ${document.operation}: ${document.label} (${document.collectionId}/${document.documentId})`);
    }
  }
  if (!applyChanges) {
    console.log('Pass --yes to write these documents. Raw provider keys are never printed.');
  }
}

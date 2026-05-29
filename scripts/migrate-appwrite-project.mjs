#!/usr/bin/env node
import { Blob } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'appwrite.config.json'), 'utf8'));
const args = new Set(process.argv.slice(2));

const SOURCE_DEFAULTS = {
  endpoint: 'https://sgp.cloud.appwrite.io/v1',
  projectId: '697b8f42002a34ba04b3',
};

const TARGET_DEFAULTS = {
  endpoint: String(manifest.endpoint || 'https://fra.cloud.appwrite.io/v1').replace(/\/+$/, ''),
  projectId: String(manifest.projectId || 'tantalum').trim(),
};

const databaseId = String(process.env.APPWRITE_DATABASE_ID || manifest.tablesDB?.[0]?.$id || '').trim();
const tables = Array.isArray(manifest.tables) ? manifest.tables : [];
const buckets = Array.isArray(manifest.buckets) ? manifest.buckets : [];
const functions = Array.isArray(manifest.functions) ? manifest.functions : [];
const sites = Array.isArray(manifest.sites) ? manifest.sites : [];

const source = {
  label: 'source',
  endpoint: String(process.env.SOURCE_APPWRITE_ENDPOINT || process.env.OLD_APPWRITE_ENDPOINT || SOURCE_DEFAULTS.endpoint).replace(/\/+$/, ''),
  projectId: String(process.env.SOURCE_APPWRITE_PROJECT_ID || process.env.OLD_APPWRITE_PROJECT_ID || SOURCE_DEFAULTS.projectId).trim(),
  apiKey: String(process.env.SOURCE_APPWRITE_API_KEY || process.env.OLD_APPWRITE_API_KEY || '').trim(),
};

const target = {
  label: 'target',
  endpoint: String(
    process.env.TARGET_APPWRITE_ENDPOINT ||
      process.env.NEW_APPWRITE_ENDPOINT ||
      process.env.APPWRITE_ENDPOINT ||
      TARGET_DEFAULTS.endpoint,
  ).replace(/\/+$/, ''),
  projectId: String(
    process.env.TARGET_APPWRITE_PROJECT_ID ||
      process.env.NEW_APPWRITE_PROJECT_ID ||
      process.env.APPWRITE_PROJECT_ID ||
      TARGET_DEFAULTS.projectId,
  ).trim(),
  apiKey: String(process.env.TARGET_APPWRITE_API_KEY || process.env.NEW_APPWRITE_API_KEY || process.env.APPWRITE_API_KEY || '').trim(),
};

const applyChanges = args.has('--yes');
const copyDatabase = args.has('--copy-database') || args.has('--copy-all');
const copyStorage = args.has('--copy-storage') || args.has('--copy-all');
const overwrite = args.has('--overwrite');
const jsonOutput = args.has('--json');

if (args.has('--help') || args.has('-h')) {
  console.log(`
Usage:
  node scripts/migrate-appwrite-project.mjs [--copy-database] [--copy-storage] [--copy-all] [--overwrite] [--yes] [--json]

Default mode verifies source and target counts without writing.

Required environment:
  SOURCE_APPWRITE_API_KEY or OLD_APPWRITE_API_KEY       Admin key for old SGP project.
  TARGET_APPWRITE_API_KEY or NEW_APPWRITE_API_KEY       Admin key for new FRA project.

Optional environment:
  SOURCE_APPWRITE_ENDPOINT / OLD_APPWRITE_ENDPOINT      Defaults to ${SOURCE_DEFAULTS.endpoint}
  SOURCE_APPWRITE_PROJECT_ID / OLD_APPWRITE_PROJECT_ID  Defaults to ${SOURCE_DEFAULTS.projectId}
  TARGET_APPWRITE_ENDPOINT / NEW_APPWRITE_ENDPOINT      Defaults to appwrite.config.json endpoint.
  TARGET_APPWRITE_PROJECT_ID / NEW_APPWRITE_PROJECT_ID  Defaults to appwrite.config.json projectId.
  APPWRITE_DATABASE_ID                                  Defaults to the first tablesDB id in appwrite.config.json.

Examples:
  npm run migrate:appwrite-project
  npm run migrate:appwrite-project -- --copy-database --copy-storage
  npm run migrate:appwrite-project -- --copy-all --yes

Notes:
  - Use Appwrite Console migration first for Auth users and password/session-compatible account data.
  - This script is a controlled fallback for verifying counts and copying database rows/files after schema exists.
  - Without --yes, copy flags run as a dry-run and do not mutate the target project.
`);
  process.exit(0);
}

function assertReady() {
  const missing = [];
  if (!databaseId) missing.push('APPWRITE_DATABASE_ID');
  if (!source.endpoint) missing.push('SOURCE_APPWRITE_ENDPOINT');
  if (!source.projectId) missing.push('SOURCE_APPWRITE_PROJECT_ID');
  if (!source.apiKey) missing.push('SOURCE_APPWRITE_API_KEY');
  if (!target.endpoint) missing.push('TARGET_APPWRITE_ENDPOINT');
  if (!target.projectId) missing.push('TARGET_APPWRITE_PROJECT_ID');
  if (!target.apiKey) missing.push('TARGET_APPWRITE_API_KEY');

  if (missing.length > 0) {
    throw new Error(`Missing required migration configuration: ${missing.join(', ')}`);
  }
}

function encodePath(...segments) {
  return segments.map((segment) => encodeURIComponent(String(segment))).join('/');
}

function withQueries(pathName, queries = []) {
  const params = new URLSearchParams();
  for (const query of queries) {
    params.append('queries[]', query);
  }

  const queryString = params.toString();
  return queryString ? `${pathName}?${queryString}` : pathName;
}

async function appwriteRequest(context, method, pathName, options = {}) {
  const headers = {
    'X-Appwrite-Project': context.projectId,
    'X-Appwrite-Key': context.apiKey,
    ...(options.headers || {}),
  };

  let body = options.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBlob = body instanceof Blob;
  if (body && !isFormData && !isBlob) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const response = await fetch(`${context.endpoint}${pathName}`, {
    method,
    headers,
    body,
  });

  if (options.raw) {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${context.label} ${method} ${pathName} failed with ${response.status}: ${text}`);
    }
    return response;
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { rawText: text };
  }

  if (!response.ok) {
    throw new Error(`${context.label} ${method} ${pathName} failed with ${response.status}: ${payload.message || text}`);
  }

  return payload;
}

async function optionalRequest(context, method, pathName) {
  try {
    return { ok: true, payload: await appwriteRequest(context, method, pathName) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function documentListPath(collectionId, queries = []) {
  return withQueries(
    `/databases/${encodePath(databaseId)}/collections/${encodePath(collectionId)}/documents`,
    queries,
  );
}

function documentPath(collectionId, documentId) {
  return `/databases/${encodePath(databaseId)}/collections/${encodePath(collectionId)}/documents/${encodePath(documentId)}`;
}

function fileListPath(bucketId, queries = []) {
  return withQueries(`/storage/buckets/${encodePath(bucketId)}/files`, queries);
}

function filePath(bucketId, fileId, action = '') {
  const suffix = action ? `/${action}` : '';
  return `/storage/buckets/${encodePath(bucketId)}/files/${encodePath(fileId)}${suffix}`;
}

async function countList(context, label, pathName, key) {
  const result = await optionalRequest(context, 'GET', withQueries(pathName, ['limit(1)']));
  if (!result.ok) {
    return { label, count: null, error: result.error };
  }

  const list = Array.isArray(result.payload[key]) ? result.payload[key] : [];
  const total = Number.isFinite(result.payload.total) ? result.payload.total : list.length;
  return { label, count: total, error: null };
}

async function compareCounts(label, sourceCount, targetCount) {
  return {
    label,
    source: sourceCount.count,
    target: targetCount.count,
    matches:
      sourceCount.error || targetCount.error
        ? false
        : Number(sourceCount.count) === Number(targetCount.count),
    sourceError: sourceCount.error,
    targetError: targetCount.error,
  };
}

async function buildVerificationSummary() {
  const summary = {
    source: { endpoint: source.endpoint, projectId: source.projectId },
    target: { endpoint: target.endpoint, projectId: target.projectId },
    authUsers: null,
    tables: [],
    buckets: [],
    functions: null,
    sites: null,
  };

  summary.authUsers = await compareCounts(
    'auth users',
    await countList(source, 'auth users', '/users', 'users'),
    await countList(target, 'auth users', '/users', 'users'),
  );

  for (const table of tables) {
    const tableId = table.$id;
    summary.tables.push(
      await compareCounts(
        tableId,
        await countList(source, tableId, `/databases/${encodePath(databaseId)}/collections/${encodePath(tableId)}/documents`, 'documents'),
        await countList(target, tableId, `/databases/${encodePath(databaseId)}/collections/${encodePath(tableId)}/documents`, 'documents'),
      ),
    );
  }

  for (const bucket of buckets) {
    const bucketId = bucket.$id;
    summary.buckets.push(
      await compareCounts(
        bucketId,
        await countList(source, bucketId, `/storage/buckets/${encodePath(bucketId)}/files`, 'files'),
        await countList(target, bucketId, `/storage/buckets/${encodePath(bucketId)}/files`, 'files'),
      ),
    );
  }

  summary.functions = await compareCounts(
    'functions',
    await countList(source, 'functions', '/functions', 'functions'),
    await countList(target, 'functions', '/functions', 'functions'),
  );

  if (sites.length > 0) {
    summary.sites = await compareCounts(
      'sites',
      await countList(source, 'sites', '/sites', 'sites'),
      await countList(target, 'sites', '/sites', 'sites'),
    );
  }

  return summary;
}

async function listAllDocuments(context, collectionId) {
  const documents = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const payload = await appwriteRequest(context, 'GET', documentListPath(collectionId, [`limit(${limit})`, `offset(${offset})`]));
    const batch = Array.isArray(payload.documents) ? payload.documents : [];
    documents.push(...batch);
    if (batch.length < limit) {
      return documents;
    }
    offset += limit;
  }
}

async function listAllFiles(context, bucketId) {
  const files = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const payload = await appwriteRequest(context, 'GET', fileListPath(bucketId, [`limit(${limit})`, `offset(${offset})`]));
    const batch = Array.isArray(payload.files) ? payload.files : [];
    files.push(...batch);
    if (batch.length < limit) {
      return files;
    }
    offset += limit;
  }
}

function stripDocumentData(document) {
  const data = {};
  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith('$')) {
      continue;
    }
    data[key] = value;
  }
  return data;
}

async function targetDocumentExists(collectionId, documentId) {
  const result = await optionalRequest(target, 'GET', documentPath(collectionId, documentId));
  return result.ok;
}

async function copyDatabaseRows() {
  const summary = [];

  for (const table of tables) {
    const collectionId = table.$id;
    const documents = await listAllDocuments(source, collectionId);
    const tableSummary = {
      collectionId,
      source: documents.length,
      created: 0,
      updated: 0,
      skipped: 0,
      dryRun: !applyChanges,
    };

    for (const document of documents) {
      const exists = await targetDocumentExists(collectionId, document.$id);
      if (exists && !overwrite) {
        tableSummary.skipped += 1;
        continue;
      }

      if (!applyChanges) {
        if (exists) tableSummary.updated += 1;
        else tableSummary.created += 1;
        continue;
      }

      const payload = {
        data: stripDocumentData(document),
        permissions: Array.isArray(document.$permissions) ? document.$permissions : [],
      };

      if (exists) {
        await appwriteRequest(target, 'PATCH', documentPath(collectionId, document.$id), payload);
        tableSummary.updated += 1;
      } else {
        await appwriteRequest(target, 'POST', documentListPath(collectionId), {
          documentId: document.$id,
          ...payload,
        });
        tableSummary.created += 1;
      }
    }

    summary.push(tableSummary);
  }

  return summary;
}

async function targetFileExists(bucketId, fileId) {
  const result = await optionalRequest(target, 'GET', filePath(bucketId, fileId));
  return result.ok;
}

async function downloadSourceFile(bucketId, fileId) {
  const response = await appwriteRequest(source, 'GET', filePath(bucketId, fileId, 'download'), { raw: true });
  const arrayBuffer = await response.arrayBuffer();
  return new Blob([arrayBuffer], {
    type: response.headers.get('content-type') || 'application/octet-stream',
  });
}

async function createTargetFile(bucketId, file) {
  const blob = await downloadSourceFile(bucketId, file.$id);
  const formData = new FormData();
  formData.append('fileId', file.$id);
  formData.append('file', blob, file.name || file.$id);

  for (const permission of Array.isArray(file.$permissions) ? file.$permissions : []) {
    formData.append('permissions[]', permission);
  }

  await appwriteRequest(target, 'POST', fileListPath(bucketId), { body: formData });
}

async function copyStorageFiles() {
  const summary = [];

  for (const bucket of buckets) {
    const bucketId = bucket.$id;
    const files = await listAllFiles(source, bucketId);
    const bucketSummary = {
      bucketId,
      source: files.length,
      created: 0,
      overwritten: 0,
      skipped: 0,
      dryRun: !applyChanges,
    };

    for (const file of files) {
      const exists = await targetFileExists(bucketId, file.$id);
      if (exists && !overwrite) {
        bucketSummary.skipped += 1;
        continue;
      }

      if (!applyChanges) {
        if (exists) bucketSummary.overwritten += 1;
        else bucketSummary.created += 1;
        continue;
      }

      if (exists) {
        await appwriteRequest(target, 'DELETE', filePath(bucketId, file.$id));
        bucketSummary.overwritten += 1;
      } else {
        bucketSummary.created += 1;
      }

      await createTargetFile(bucketId, file);
    }

    summary.push(bucketSummary);
  }

  return summary;
}

function printVerification(summary) {
  console.log(`Source: ${summary.source.endpoint} (${summary.source.projectId})`);
  console.log(`Target: ${summary.target.endpoint} (${summary.target.projectId})`);
  console.log(`Auth users: ${formatComparison(summary.authUsers)}`);

  for (const table of summary.tables) {
    console.log(`Table ${table.label}: ${formatComparison(table)}`);
  }

  for (const bucket of summary.buckets) {
    console.log(`Bucket ${bucket.label}: ${formatComparison(bucket)}`);
  }

  console.log(`Functions: ${formatComparison(summary.functions)}`);
  if (summary.sites) {
    console.log(`Sites: ${formatComparison(summary.sites)}`);
  }
}

function formatComparison(entry) {
  if (entry.sourceError || entry.targetError) {
    const parts = [];
    if (entry.sourceError) parts.push(`source error: ${entry.sourceError}`);
    if (entry.targetError) parts.push(`target error: ${entry.targetError}`);
    return parts.join('; ');
  }

  return `${entry.source} -> ${entry.target}${entry.matches ? ' (match)' : ' (mismatch)'}`;
}

function printCopySummary(label, summaries) {
  console.log(label);
  for (const item of summaries) {
    const name = item.collectionId || item.bucketId;
    const dryRun = item.dryRun ? ' dry-run' : '';
    const updatedPart = item.updated !== undefined ? `, updated ${item.updated}` : '';
    const overwrittenPart = item.overwritten !== undefined ? `, overwritten ${item.overwritten}` : '';
    console.log(
      `- ${name}:${dryRun} source ${item.source}, created ${item.created}${updatedPart}${overwrittenPart}, skipped ${item.skipped}`,
    );
  }
}

assertReady();

const verification = await buildVerificationSummary();

if (jsonOutput) {
  const output = { verification };
  if (copyDatabase) output.databaseCopy = await copyDatabaseRows();
  if (copyStorage) output.storageCopy = await copyStorageFiles();
  console.log(JSON.stringify(output, null, 2));
} else {
  printVerification(verification);

  if ((copyDatabase || copyStorage) && !applyChanges) {
    console.log('Copy flags are running in dry-run mode. Pass --yes to mutate the target project.');
  }

  if (copyDatabase) {
    printCopySummary('Database row copy:', await copyDatabaseRows());
  }

  if (copyStorage) {
    printCopySummary('Storage file copy:', await copyStorageFiles());
  }
}

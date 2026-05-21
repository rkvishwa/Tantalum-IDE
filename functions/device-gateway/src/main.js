import crypto from 'node:crypto';

import { Client, Databases, Query } from 'node-appwrite';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARDS_COLLECTION_ID,
  APPWRITE_FIRMWARE_COLLECTION_ID,
  APPWRITE_FIRMWARE_BUCKET_ID,
} = process.env;

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

function json(res, status, payload) {
  return res.json(payload, status);
}

function ok(res, data) {
  return json(res, 200, { ok: true, data });
}

function fail(res, status, error) {
  return json(res, status, { ok: false, error });
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareVersions(left, right) {
  const leftParts = String(left || '0.0.0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || '0.0.0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function buildDownloadUrl(fileId) {
  const endpoint = APPWRITE_FUNCTION_API_ENDPOINT.replace(/\/$/, '');
  return `${endpoint}/storage/buckets/${encodeURIComponent(APPWRITE_FIRMWARE_BUCKET_ID)}/files/${encodeURIComponent(fileId)}/download?project=${encodeURIComponent(APPWRITE_FUNCTION_PROJECT_ID)}`;
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

async function resolveBoard(databases, payload) {
  if (!payload.boardId || !payload.apiToken) {
    throw new Error('boardId and apiToken are required.');
  }

  const board = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, payload.boardId);
  const incomingHash = hashToken(payload.apiToken);

  if (board.tokenHash !== incomingHash) {
    throw new Error('Invalid board credentials.');
  }

  return board;
}

async function handleHeartbeat(databases, payload, res) {
  const board = await resolveBoard(databases, payload);
  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, board.$id, {
    status: 'online',
    lastSeen: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return ok(res, { received: true });
}

async function handleCheckUpdate(databases, payload, res) {
  const board = await resolveBoard(databases, payload);
  const firmwareList = await databases.listDocuments(
    APPWRITE_DATABASE_ID,
    APPWRITE_FIRMWARE_COLLECTION_ID,
    [Query.equal('boardId', board.$id)],
  );

  const deployedFirmware = firmwareList.documents
    .filter((firmware) => firmware.deployed)
    .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))[0];

  if (!deployedFirmware) {
    return ok(res, { updateAvailable: false });
  }

  if (compareVersions(deployedFirmware.version, payload.currentVersion) <= 0) {
    return ok(res, { updateAvailable: false });
  }

  return ok(res, {
    updateAvailable: true,
    firmware: {
      version: deployedFirmware.version,
      size: deployedFirmware.size,
      checksum: deployedFirmware.checksum,
      downloadUrl: buildDownloadUrl(deployedFirmware.fileId),
    },
  });
}

export default async function ({ req, res, error }) {
  try {
    if (!APPWRITE_DATABASE_ID || !APPWRITE_BOARDS_COLLECTION_ID || !APPWRITE_FIRMWARE_COLLECTION_ID || !APPWRITE_FIRMWARE_BUCKET_ID) {
      return fail(res, 500, 'Database or storage configuration is incomplete.');
    }

    const databases = new Databases(createAdminClient(req));
    const payload = readPayload(req);

    if (req.path === '/heartbeat') {
      return await handleHeartbeat(databases, payload, res);
    }

    if (req.path === '/check-update') {
      return await handleCheckUpdate(databases, payload, res);
    }

    return fail(res, 404, `Unknown device gateway path: ${req.path}`);
  } catch (caughtError) {
    error(caughtError instanceof Error ? caughtError.message : 'Unexpected device-gateway failure.');
    return fail(res, 400, caughtError instanceof Error ? caughtError.message : 'Unexpected device-gateway failure.');
  }
}

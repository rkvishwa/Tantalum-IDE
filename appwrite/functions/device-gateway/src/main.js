import crypto from 'node:crypto';

import { Client, Databases } from 'node-appwrite';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARDS_COLLECTION_ID,
  APPWRITE_FIRMWARE_COLLECTION_ID,
  APPWRITE_FIRMWARE_BUCKET_ID,
} = process.env;

const DEFAULT_RECOMMENDED_POLL_MS = 15 * 60 * 1000;

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

async function resolveDesiredFirmware(databases, board) {
  if (!board.desiredFirmwareId) {
    return null;
  }

  try {
    return await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_FIRMWARE_COLLECTION_ID, board.desiredFirmwareId);
  } catch {
    return null;
  }
}

function hasPendingDesiredFirmware(board, payload) {
  if (!board.desiredFirmwareId) {
    return false;
  }

  const deploymentId = board.desiredDeploymentId || board.desiredFirmwareId;
  if (deploymentId && (payload.lastAppliedDeploymentId === deploymentId || board.lastAppliedDeploymentId === deploymentId)) {
    return false;
  }

  if (deploymentId && board.otaStatus === 'failed') {
    return false;
  }

  return payload.firmwareId !== board.desiredFirmwareId || Boolean(deploymentId);
}

function signOtaCommand(apiToken, command) {
  const message = [
    command.deploymentId || '',
    command.firmwareId || '',
    command.version || '',
    command.size || 0,
    command.checksum || '',
    command.downloadUrl || '',
  ].join('\n');

  return crypto.createHmac('sha256', apiToken).update(message).digest('hex');
}

function shouldOfferUpdate(board, firmware, payload) {
  if (!firmware) {
    return false;
  }

  const deploymentId = board.desiredDeploymentId || firmware.$id;
  if (deploymentId && (payload.lastAppliedDeploymentId === deploymentId || board.lastAppliedDeploymentId === deploymentId)) {
    return false;
  }

  if (deploymentId && board.desiredDeploymentId === deploymentId && board.otaStatus === 'failed') {
    return false;
  }

  if (payload.firmwareId && payload.firmwareId === firmware.$id && compareVersions(firmware.version, payload.currentVersion) <= 0) {
    return false;
  }

  return compareVersions(firmware.version, payload.currentVersion) > 0 || payload.firmwareId !== firmware.$id;
}

function buildOtaCommand(board, firmware, payload) {
  const command = {
    deploymentId: board.desiredDeploymentId || firmware.$id,
    firmwareId: firmware.$id,
    version: firmware.version,
    size: firmware.size,
    checksum: firmware.checksum,
    downloadUrl: buildDownloadUrl(firmware.fileId),
  };
  command.signature = signOtaCommand(payload.apiToken, command);
  return command;
}

async function buildDeviceResponse(databases, board, payload, options = {}) {
  const shouldResolveFirmware = options.resolveFirmware || hasPendingDesiredFirmware(board, payload);
  const firmware = shouldResolveFirmware ? await resolveDesiredFirmware(databases, board) : null;
  const data = {
    recommendedPollMs: DEFAULT_RECOMMENDED_POLL_MS,
  };

  if (shouldOfferUpdate(board, firmware, payload)) {
    data.otaCommand = buildOtaCommand(board, firmware, payload);
  }

  if (board.provisioningStatus === 'requested') {
    data.provisioningCommand = {
      open: true,
      mode: board.provisioningMode || 'auto',
      requestedAt: board.provisioningRequestedAt || null,
    };
  }

  return data;
}

async function handleHeartbeat(databases, payload, res) {
  const board = await resolveBoard(databases, payload);
  const now = new Date().toISOString();

  const updates = {
    status: 'online',
    lastSeen: now,
    updatedAt: now,
  };

  if (payload.runtimeVersion) {
    updates.runtimeVersion = String(payload.runtimeVersion);
  }

  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, board.$id, updates);
  const response = await buildDeviceResponse(databases, { ...board, ...updates }, payload);
  return ok(res, response);
}

async function handleCheckUpdate(databases, payload, res) {
  const board = await resolveBoard(databases, payload);
  const now = new Date().toISOString();
  const updates = {
    lastUpdateCheckAt: now,
    lastSeen: now,
    status: 'online',
    updatedAt: now,
  };

  if (payload.runtimeVersion) {
    updates.runtimeVersion = String(payload.runtimeVersion);
  }

  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, board.$id, updates);
  const response = await buildDeviceResponse(databases, { ...board, ...updates }, payload, { resolveFirmware: true });
  return ok(res, response);
}

async function handleOtaResult(databases, payload, res) {
  const board = await resolveBoard(databases, payload);
  const now = new Date().toISOString();
  const status = payload.status === 'success' ? 'success' : 'failed';

  const updates = {
    status: 'online',
    lastSeen: now,
    updatedAt: now,
    otaStatus: status,
    lastOtaError: status === 'failed' ? String(payload.error || 'OTA update failed.') : '',
  };

  if (payload.runtimeVersion) {
    updates.runtimeVersion = String(payload.runtimeVersion);
  }

  if (status === 'success') {
    updates.firmwareVersion = String(payload.version || board.desiredVersion || board.firmwareVersion || '0.0.0');
    updates.lastAppliedDeploymentId = String(payload.deploymentId || board.desiredDeploymentId || '');
  }

  const updatedBoard = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, board.$id, updates);
  return ok(res, { received: true, board: updatedBoard });
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

    if (req.path === '/ota-result') {
      return await handleOtaResult(databases, payload, res);
    }

    return fail(res, 404, `Unknown device gateway path: ${req.path}`);
  } catch (caughtError) {
    error(caughtError instanceof Error ? caughtError.message : 'Unexpected device-gateway failure.');
    return fail(res, 400, caughtError instanceof Error ? caughtError.message : 'Unexpected device-gateway failure.');
  }
}

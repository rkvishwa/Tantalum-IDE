import crypto from 'node:crypto';

import { Client, Databases } from 'node-appwrite';

import { buildDownloadUrl } from './otaDownloadUrl.js';
import {
  buildTelemetryUpdates,
  hasPendingDesiredFirmware,
  shouldOfferUpdate,
} from './telemetry.js';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARDS_COLLECTION_ID,
  APPWRITE_FIRMWARE_COLLECTION_ID,
  APPWRITE_FIRMWARE_BUCKET_ID,
} = process.env;

const DEFAULT_RECOMMENDED_POLL_MS = 15 * 60 * 1000;
const OTA_UPDATE_MODES = new Set(['polling', 'mqtt', 'both']);

function normalizeOtaUpdateMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return OTA_UPDATE_MODES.has(mode) ? mode : 'polling';
}

function heartbeatCanOfferOta(board) {
  return normalizeOtaUpdateMode(board?.otaUpdateMode) !== 'mqtt';
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
  const allowOtaCommand = options.allowOtaCommand !== false;
  const shouldResolveFirmware = allowOtaCommand && (options.resolveFirmware || hasPendingDesiredFirmware(board, payload));
  const firmware = shouldResolveFirmware ? await resolveDesiredFirmware(databases, board) : null;
  const data = {
    recommendedPollMs: DEFAULT_RECOMMENDED_POLL_MS,
  };

  if (allowOtaCommand && shouldOfferUpdate(board, firmware, payload)) {
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

  const updates = buildTelemetryUpdates(board, payload, now);

  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, board.$id, updates);
  const response = await buildDeviceResponse(databases, { ...board, ...updates }, payload, {
    allowOtaCommand: heartbeatCanOfferOta(board),
  });
  return ok(res, response);
}

async function handleCheckUpdate(databases, payload, res) {
  const board = await resolveBoard(databases, payload);
  const now = new Date().toISOString();
  const updates = buildTelemetryUpdates(board, payload, now, { includeLastUpdateCheckAt: true });

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

  if (payload.currentVersion) {
    updates.firmwareVersion = String(payload.currentVersion);
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

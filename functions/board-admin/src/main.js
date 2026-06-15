import crypto from 'node:crypto';

import mqtt from 'mqtt';
import { Account, Client, Databases, ID, Permission, Query, Role } from 'node-appwrite';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARDS_COLLECTION_ID,
  APPWRITE_FIRMWARE_COLLECTION_ID,
  TANTALUM_BOARD_SECRET_KEK_V1,
  TANTALUM_MQTT_URL,
  TANTALUM_MQTT_HOST,
  TANTALUM_MQTT_PORT,
  TANTALUM_MQTT_PUBLISHER_USERNAME,
  TANTALUM_MQTT_PUBLISHER_PASSWORD,
  TANTALUM_MQTT_CA_CERT,
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

function json(res, status, payload) {
  return res.json(payload, status);
}

function ok(res, data, status = 200) {
  return json(res, status, { ok: true, data });
}

function fail(res, status, error) {
  return json(res, status, { ok: false, error });
}

function generateToken() {
  return `board_${crypto.randomBytes(32).toString('hex')}`;
}

function generateDocumentId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateProvisioningPop() {
  return crypto.randomBytes(6).toString('hex');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boardPermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

async function resolveUser(req) {
  const account = new Account(createUserClient(requestUserJwt(req)));
  return account.get();
}

function getEnvelopeKey() {
  if (!TANTALUM_BOARD_SECRET_KEK_V1) {
    return null;
  }

  const trimmed = TANTALUM_BOARD_SECRET_KEK_V1.trim();
  const base64 = Buffer.from(trimmed, 'base64');
  if (base64.length === 32) {
    return base64;
  }

  const hex = Buffer.from(trimmed, 'hex');
  if (hex.length === 32) {
    return hex;
  }

  return crypto.createHash('sha256').update(trimmed).digest();
}

function encryptSecret(secret) {
  const key = getEnvelopeKey();
  if (!key) {
    return '';
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decryptSecret(envelope) {
  if (!envelope) {
    return '';
  }

  const key = getEnvelopeKey();
  if (!key) {
    return '';
  }

  const parsed = JSON.parse(envelope);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function commandTopic(boardId, topicSuffix) {
  return `tantalum/boards/${boardId}/${topicSuffix}/cmd`;
}

const OTA_UPDATE_MODES = new Set(['polling', 'mqtt', 'both']);

function isValidOtaUpdateMode(value) {
  return OTA_UPDATE_MODES.has(String(value || '').trim().toLowerCase());
}

function normalizeOtaUpdateMode(value, fallback = 'polling') {
  const mode = String(value || '').trim().toLowerCase();
  return OTA_UPDATE_MODES.has(mode) ? mode : fallback;
}

function normalizePem(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function mqttConnectionUrl() {
  const configuredUrl = String(TANTALUM_MQTT_URL || '').trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const host = String(TANTALUM_MQTT_HOST || '').trim();
  if (!host) {
    return '';
  }

  const port = Number.parseInt(TANTALUM_MQTT_PORT || '8883', 10) || 8883;
  return `mqtts://${host}:${port}`;
}

function validateMqttPublisherConfig(url) {
  if (!url) {
    return 'MQTT broker is not configured.';
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'mqtts:') {
      return 'MQTT must use mqtts:// with a TLS CA certificate.';
    }
  } catch {
    return 'MQTT broker URL is invalid.';
  }

  if (!normalizePem(TANTALUM_MQTT_CA_CERT)) {
    return 'MQTT TLS CA certificate is missing.';
  }

  if (!TANTALUM_MQTT_PUBLISHER_USERNAME || !TANTALUM_MQTT_PUBLISHER_PASSWORD) {
    return 'MQTT publisher credentials are missing.';
  }

  return '';
}

function defaultOtaUpdateMode() {
  const configError = validateMqttPublisherConfig(mqttConnectionUrl());
  return configError ? 'polling' : 'both';
}

function boardUsesMqttOta(board) {
  const mode = normalizeOtaUpdateMode(board?.otaUpdateMode);
  return mode === 'mqtt' || mode === 'both';
}

function mqttStatusForFailure(board) {
  return normalizeOtaUpdateMode(board?.otaUpdateMode) === 'both'
    ? 'mqtt-failed-with-polling-fallback'
    : 'mqtt-failed-no-fallback';
}

function signCommand(secret, action, deploymentId, nonce, issuedAt) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${action}\n${deploymentId || ''}\n${nonce}\n${issuedAt}`)
    .digest('hex');
}

async function publishBoardCommand(board, action, deploymentId = '') {
  const url = mqttConnectionUrl();
  const commandSecret = decryptSecret(board.commandSecretEnvelope);

  if (!url) {
    return { published: false, reason: 'MQTT broker is not configured.' };
  }

  if (!board.mqttTopicSuffix) {
    return { published: false, reason: 'Board MQTT topic is missing. Reinstall the cloud runtime.' };
  }

  if (!commandSecret) {
    return { published: false, reason: 'Board MQTT command secret is missing. Reinstall the cloud runtime.' };
  }

  const mqttConfigError = validateMqttPublisherConfig(url);
  if (mqttConfigError) {
    return { published: false, reason: mqttConfigError };
  }

  const nonce = crypto.randomBytes(12).toString('hex');
  const issuedAt = new Date().toISOString();
  const payload = {
    action,
    deploymentId,
    nonce,
    issuedAt,
    signature: signCommand(commandSecret, action, deploymentId, nonce, issuedAt),
  };

  const client = mqtt.connect(url, {
    username: TANTALUM_MQTT_PUBLISHER_USERNAME,
    password: TANTALUM_MQTT_PUBLISHER_PASSWORD,
    ca: normalizePem(TANTALUM_MQTT_CA_CERT),
    rejectUnauthorized: true,
    reconnectPeriod: 0,
    connectTimeout: 5000,
  });

  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });

    await new Promise((resolve, reject) => {
      client.publish(commandTopic(board.$id, board.mqttTopicSuffix), JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  } finally {
    client.end(true);
  }

  return { published: true };
}

async function ensureUserCanAccessBoard(req, boardId) {
  const user = await resolveUser(req);
  const userDatabases = new Databases(createUserClient(requestUserJwt(req)));
  const board = await userDatabases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, boardId);
  if (board.userId !== user.$id) {
    throw new Error('Board does not belong to the current user.');
  }
  return { user, board };
}

async function createBoard(req, res) {
  const payload = req.bodyJson || {};
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));

  if (!payload.name || !payload.boardType) {
    return fail(res, 400, 'Board name and type are required.');
  }
  if (payload.otaUpdateMode && !isValidOtaUpdateMode(payload.otaUpdateMode)) {
    return fail(res, 400, 'otaUpdateMode must be polling, mqtt, or both.');
  }

  const apiToken = generateToken();
  const commandSecret = generateSecret();
  const topicSuffix = generateSecret(12);
  const provisioningPop = generateProvisioningPop();
  const boardId = generateDocumentId('bd');
  const now = new Date().toISOString();

  const board = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_BOARDS_COLLECTION_ID,
    boardId,
    {
      userId: user.$id,
      name: payload.name,
      boardType: payload.boardType,
      apiToken: '',
      tokenHash: hashToken(apiToken),
      tokenPreview: apiToken.slice(-6),
      commandSecretEnvelope: encryptSecret(commandSecret),
      mqttTopicSuffix: topicSuffix,
      provisioningPop,
      firmwareVersion: '0.0.0',
      desiredFirmwareId: '',
      desiredVersion: '',
      desiredDeploymentId: '',
      lastAppliedDeploymentId: '',
      runtimeVersion: '',
      lastUpdateCheckAt: null,
      otaStatus: 'idle',
      otaUpdateMode: normalizeOtaUpdateMode(payload.otaUpdateMode, defaultOtaUpdateMode()),
      provisioningStatus: 'pending',
      provisioningRequestedAt: null,
      provisioningMode: '',
      lastOtaError: '',
      sourceCodeVisibility: payload.sourceCodeVisibility === 'public' ? 'public' : 'private',
      status: 'pending',
      lastSeen: null,
      lastProvisionedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    boardPermissions(user.$id),
  );

  return ok(res, {
    board,
    apiToken,
    commandSecret,
    mqttTopic: commandTopic(board.$id, topicSuffix),
    provisioningPop,
  }, 201);
}

async function rotateToken(req, res) {
  const payload = req.bodyJson || {};
  if (!payload.boardId) {
    return fail(res, 400, 'boardId is required.');
  }

  const { user } = await ensureUserCanAccessBoard(req, payload.boardId);
  const databases = new Databases(createAdminClient(req));
  const apiToken = generateToken();
  const commandSecret = generateSecret();
  const topicSuffix = generateSecret(12);
  const provisioningPop = generateProvisioningPop();

  const board = await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_BOARDS_COLLECTION_ID,
    payload.boardId,
    {
      apiToken: '',
      tokenHash: hashToken(apiToken),
      tokenPreview: apiToken.slice(-6),
      commandSecretEnvelope: encryptSecret(commandSecret),
      mqttTopicSuffix: topicSuffix,
      provisioningPop,
      updatedAt: new Date().toISOString(),
    },
    boardPermissions(user.$id),
  );

  return ok(res, {
    board,
    apiToken,
    commandSecret,
    mqttTopic: commandTopic(board.$id, topicSuffix),
    provisioningPop,
  });
}

async function deployFirmware(req, res) {
  const payload = req.bodyJson || {};
  if (!payload.boardId || !payload.firmwareId || !payload.deploymentId) {
    return fail(res, 400, 'boardId, firmwareId, and deploymentId are required.');
  }

  const { user } = await ensureUserCanAccessBoard(req, payload.boardId);
  const userDatabases = new Databases(createUserClient(requestUserJwt(req)));
  const firmware = await userDatabases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_FIRMWARE_COLLECTION_ID, payload.firmwareId);
  if (firmware.boardId !== payload.boardId || firmware.userId !== user.$id) {
    return fail(res, 403, 'Firmware does not belong to this board.');
  }

  const databases = new Databases(createAdminClient(req));
  const history = await databases.listDocuments(
    APPWRITE_DATABASE_ID,
    APPWRITE_FIRMWARE_COLLECTION_ID,
    [
      Query.equal('boardId', payload.boardId),
      Query.equal('deployed', true),
      Query.limit(100),
    ],
  );

  await Promise.all(history.documents.map((entry) =>
    databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_FIRMWARE_COLLECTION_ID, entry.$id, {
      deployed: entry.$id === payload.firmwareId,
    }),
  ));

  const board = await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_BOARDS_COLLECTION_ID,
    payload.boardId,
    {
      desiredFirmwareId: firmware.$id,
      desiredVersion: firmware.version,
      desiredDeploymentId: payload.deploymentId,
      otaStatus: 'pending',
      lastOtaError: '',
      updatedAt: new Date().toISOString(),
    },
  );

  let mqttResult = {
    published: false,
    status: 'skipped-polling-only',
    reason: 'Board OTA update mode is polling-only.',
  };
  if (boardUsesMqttOta(board)) {
    try {
      mqttResult = await publishBoardCommand(board, 'check-update', payload.deploymentId);
      mqttResult = {
        ...mqttResult,
        status: mqttResult.published ? 'published' : mqttStatusForFailure(board),
      };
    } catch (error) {
      mqttResult = {
        published: false,
        status: mqttStatusForFailure(board),
        reason: error instanceof Error ? error.message : 'MQTT publish failed.',
      };
    }
  }

  return ok(res, { board, firmware, mqtt: mqttResult });
}

async function startProvisioning(req, res) {
  const payload = req.bodyJson || {};
  if (!payload.boardId) {
    return fail(res, 400, 'boardId is required.');
  }

  await ensureUserCanAccessBoard(req, payload.boardId);
  const databases = new Databases(createAdminClient(req));
  const now = new Date().toISOString();
  const board = await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_BOARDS_COLLECTION_ID,
    payload.boardId,
    {
      provisioningStatus: 'requested',
      provisioningRequestedAt: now,
      provisioningMode: payload.mode || 'auto',
      updatedAt: now,
    },
  );

  let mqttResult = {
    published: false,
    status: 'skipped-polling-only',
    reason: 'Board runtime update mode does not include MQTT.',
  };
  if (boardUsesMqttOta(board)) {
    try {
      mqttResult = await publishBoardCommand(board, 'start-provisioning');
      mqttResult = {
        ...mqttResult,
        status: mqttResult.published ? 'published' : mqttStatusForFailure(board),
      };
    } catch (error) {
      mqttResult = {
        published: false,
        status: mqttStatusForFailure(board),
        reason: error instanceof Error ? error.message : 'MQTT publish failed.',
      };
    }
  }

  return ok(res, {
    board,
    mqtt: mqttResult,
    provisioning: {
      serviceName: `Tantalum-${String(board.$id).slice(-8)}`,
      pop: board.provisioningPop || '',
      mode: payload.mode || 'auto',
    },
  });
}

export default async function ({ req, res, error }) {
  try {
    if (!APPWRITE_DATABASE_ID || !APPWRITE_BOARDS_COLLECTION_ID) {
      return fail(res, 500, 'Database configuration is incomplete.');
    }

    if (req.path === '/rotate-token') {
      return await rotateToken(req, res);
    }

    if (req.path === '/deploy-firmware') {
      if (!APPWRITE_FIRMWARE_COLLECTION_ID) {
        return fail(res, 500, 'Firmware collection configuration is incomplete.');
      }
      return await deployFirmware(req, res);
    }

    if (req.path === '/start-provisioning') {
      return await startProvisioning(req, res);
    }

    return await createBoard(req, res);
  } catch (caughtError) {
    error(caughtError instanceof Error ? caughtError.message : 'Unexpected board-admin failure.');
    return fail(res, 500, caughtError instanceof Error ? caughtError.message : 'Unexpected board-admin failure.');
  }
}

import crypto from 'node:crypto';

import { Account, Client, Databases, ID, Permission, Role } from 'node-appwrite';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARDS_COLLECTION_ID,
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
  const jwt = req.headers['x-appwrite-user-jwt'];
  const account = new Account(createUserClient(jwt));
  return account.get();
}

async function createBoard(req, res) {
  const payload = req.bodyJson || {};
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));

  if (!payload.name || !payload.boardType || !payload.wifiSSID) {
    return fail(res, 400, 'Board name, type, and WiFi SSID are required.');
  }

  const apiToken = generateToken();
  const now = new Date().toISOString();

  const board = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_BOARDS_COLLECTION_ID,
    ID.unique(),
    {
      userId: user.$id,
      name: payload.name,
      boardType: payload.boardType,
      apiToken: '',
      wifiSSID: payload.wifiSSID,
      wifiPassword: '',
      tokenHash: hashToken(apiToken),
      tokenPreview: apiToken.slice(-6),
      firmwareVersion: '1.0.0',
      status: 'pending',
      lastSeen: null,
      lastProvisionedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    boardPermissions(user.$id),
  );

  return ok(res, { board, apiToken }, 201);
}

async function rotateToken(req, res) {
  const payload = req.bodyJson || {};
  if (!payload.boardId) {
    return fail(res, 400, 'boardId is required.');
  }

  const user = await resolveUser(req);
  const userDatabases = new Databases(createUserClient(req.headers['x-appwrite-user-jwt']));
  await userDatabases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, payload.boardId);

  const databases = new Databases(createAdminClient(req));
  const apiToken = generateToken();
  const board = await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_BOARDS_COLLECTION_ID,
    payload.boardId,
    {
      apiToken: '',
      tokenHash: hashToken(apiToken),
      tokenPreview: apiToken.slice(-6),
      updatedAt: new Date().toISOString(),
    },
    boardPermissions(user.$id),
  );

  return ok(res, { board, apiToken });
}

export default async function ({ req, res, error }) {
  try {
    if (!APPWRITE_DATABASE_ID || !APPWRITE_BOARDS_COLLECTION_ID) {
      return fail(res, 500, 'Database configuration is incomplete.');
    }

    if (req.path === '/rotate-token') {
      return await rotateToken(req, res);
    }

    return await createBoard(req, res);
  } catch (caughtError) {
    error(caughtError instanceof Error ? caughtError.message : 'Unexpected board-admin failure.');
    return fail(res, 500, caughtError instanceof Error ? caughtError.message : 'Unexpected board-admin failure.');
  }
}

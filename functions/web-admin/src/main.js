import { Account, Client, Databases, ID, Permission, Query, Role, Users } from 'node-appwrite';
import { LEGACY_RAW_KEY_SENTINEL, encryptSecret, redactSecret } from './secretEnvelope.js';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARDS_COLLECTION_ID = 'boards',
  APPWRITE_FIRMWARE_COLLECTION_ID = 'firmwares',
  APPWRITE_APP_SETTINGS_COLLECTION_ID = 'app_settings',
  APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID = 'agent_managed_key_pool',
  APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID = 'agent_credit_accounts',
  APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID = 'agent_usage_ledger',
  APPWRITE_USER_ENTITLEMENTS_COLLECTION_ID = 'user_entitlements',
  ADMIN_LABEL = 'admin',
} = process.env;

function json(res, status, payload) {
  return res.json(payload, status);
}

function ok(res, data, status = 200) {
  return json(res, status, { ok: true, data });
}

function fail(res, status, error, details) {
  return json(res, status, { ok: false, error, details });
}

function readPayload(req) {
  try {
    if (req.bodyJson && typeof req.bodyJson === 'object') {
      return req.bodyJson;
    }
  } catch {
    // Fall through to bodyText parsing; Appwrite throws here for malformed JSON.
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
    const error = new Error('User JWT header is missing.');
    error.statusCode = 401;
    throw error;
  }

  return new Client()
    .setEndpoint(APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(APPWRITE_FUNCTION_PROJECT_ID)
    .setJWT(jwt);
}

function requestUserJwt(req) {
  const authorization = req.headers.authorization || req.headers.Authorization || '';
  const jwt = (
    req.headers['x-appwrite-user-jwt'] ||
    req.headers['x-appwrite-jwt'] ||
    String(authorization).replace(/^Bearer\s+/i, '').trim()
  );
  const cleanJwt = String(jwt || '').trim();
  return cleanJwt.split('.').length === 3 ? cleanJwt : '';
}

async function resolveAdmin(req) {
  const account = new Account(createUserClient(requestUserJwt(req)));
  const user = await account.get();
  const labels = Array.isArray(user.labels) ? user.labels : [];
  if (!labels.includes(ADMIN_LABEL)) {
    const error = new Error('Admin access is required.');
    error.statusCode = 403;
    throw error;
  }
  return user;
}

function cleanLimit(value, fallback = 50, max = 100) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(max, Math.trunc(number))) : fallback;
}

function cleanOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function periodKeyFor(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function entitlementId(userId) {
  return `ent_${String(userId).replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 36);
}

function settingId(key) {
  return `set_${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 36);
}

function userEntitlementPermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
  ];
}

function maskUser(user) {
  return {
    id: user.$id,
    name: user.name || '',
    email: user.email || '',
    status: Boolean(user.status),
    labels: Array.isArray(user.labels) ? user.labels : [],
    emailVerification: Boolean(user.emailVerification),
    phoneVerification: Boolean(user.phoneVerification),
    registration: user.registration || null,
    accessedAt: user.accessedAt || null,
  };
}

function maskBoard(board) {
  return {
    id: board.$id,
    userId: board.userId,
    name: board.name,
    boardType: board.boardType,
    status: board.status,
    otaStatus: board.otaStatus || 'idle',
    provisioningStatus: board.provisioningStatus || '',
    firmwareVersion: board.firmwareVersion || '',
    tokenPreview: board.tokenPreview || '',
    lastSeen: board.lastSeen || null,
    createdAt: board.createdAt || board.$createdAt,
    updatedAt: board.updatedAt || board.$updatedAt,
  };
}

function maskUsage(event) {
  return {
    id: event.$id,
    requestId: event.requestId,
    userId: event.userId,
    source: event.source,
    mode: event.mode,
    status: event.status,
    providerLabel: event.providerLabel || '',
    modelAlias: event.modelAlias || '',
    totalTokens: Number(event.totalTokens || 0),
    chargedCredits: Number(event.chargedCredits || 0),
    createdAt: event.createdAt || event.$createdAt,
    errorMessage: event.errorMessage || '',
  };
}

function maskCredit(account) {
  return {
    id: account.$id,
    userId: account.userId,
    periodKey: account.periodKey,
    monthlyAllowance: Number(account.monthlyAllowance || 0),
    usedCredits: Number(account.usedCredits || 0),
    resetAt: account.resetAt || '',
    updatedAt: account.updatedAt || account.$updatedAt,
  };
}

function maskEntitlement(entitlement) {
  if (!entitlement) {
    return null;
  }

  return {
    id: entitlement.$id,
    userId: entitlement.userId,
    tier: entitlement.tier || 'hobby',
    status: entitlement.status || 'active',
    monthlyCredits: Number(entitlement.monthlyCredits || 0),
    notes: entitlement.notes || '',
    updatedAt: entitlement.updatedAt || entitlement.$updatedAt,
  };
}

function maskSetting(setting) {
  return {
    id: setting.$id,
    key: setting.key,
    value: setting.value,
    description: setting.description || '',
    updatedAt: setting.updatedAt || setting.$updatedAt,
  };
}

function maskPoolKey(entry) {
  const rawPreview = entry.apiKey && entry.apiKey !== LEGACY_RAW_KEY_SENTINEL ? redactSecret(entry.apiKey) : '';
  return {
    id: entry.$id,
    providerLabel: entry.providerLabel || '',
    baseUrl: entry.baseUrl || '',
    status: entry.status || 'active',
    fastModel: entry.fastModel || '',
    fastEditorModel: entry.fastEditorModel || '',
    powerModel: entry.powerModel || '',
    powerEditorModel: entry.powerEditorModel || '',
    assignmentWeight: Number(entry.assignmentWeight || 1),
    maxAssignments: Number(entry.maxAssignments || 0),
    assignedCount: Number(entry.assignedCount || 0),
    apiKeyPreview: entry.apiKeyPreview || rawPreview || (entry.apiKeyEnvelope ? 'encrypted' : ''),
    updatedAt: entry.updatedAt || entry.$updatedAt,
  };
}

async function findFirst(databases, collectionId, queries) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [...queries, Query.limit(1)]);
  return response.documents[0] || null;
}

async function listUsers(req, res) {
  const payload = readPayload(req);
  const users = new Users(createAdminClient(req));
  const limit = cleanLimit(payload.limit);
  const offset = cleanOffset(payload.offset);
  const queries = [Query.limit(limit), Query.offset(offset)];
  const response = await users.list(queries, String(payload.search || '').trim() || undefined);
  return ok(res, {
    total: response.total || 0,
    users: response.users.map(maskUser),
  });
}

async function dashboard(req, res) {
  const adminClient = createAdminClient(req);
  const users = new Users(adminClient);
  const databases = new Databases(adminClient);
  const [userList, boardList, usageList, creditList, settingsList] = await Promise.all([
    users.list([Query.limit(10)]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, [Query.limit(1)]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID, [Query.limit(25), Query.orderDesc('createdAt')]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, [Query.limit(25)]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_APP_SETTINGS_COLLECTION_ID, [Query.limit(50), Query.orderAsc('key')]),
  ]);

  const chargedCredits = usageList.documents.reduce((total, event) => total + Number(event.chargedCredits || 0), 0);
  return ok(res, {
    totals: {
      users: userList.total || 0,
      boards: boardList.total || 0,
      recentUsageEvents: usageList.total || 0,
      chargedCredits,
    },
    recentUsers: userList.users.map(maskUser),
    recentUsage: usageList.documents.map(maskUsage),
    creditAccounts: creditList.documents.map(maskCredit),
    settings: settingsList.documents.map(maskSetting),
  });
}

async function userDetail(req, res) {
  const payload = readPayload(req);
  const userId = String(payload.userId || '').trim();
  if (!userId) {
    return fail(res, 400, 'userId is required.');
  }

  const adminClient = createAdminClient(req);
  const users = new Users(adminClient);
  const databases = new Databases(adminClient);
  const [user, boards, firmwares, usage, credits, entitlement] = await Promise.all([
    users.get(userId),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(100), Query.orderDesc('createdAt')]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_FIRMWARE_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(100)]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(50), Query.orderDesc('createdAt')]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(24), Query.orderDesc('periodKey')]),
    findFirst(databases, APPWRITE_USER_ENTITLEMENTS_COLLECTION_ID, [Query.equal('userId', userId)]).catch(() => null),
  ]);

  return ok(res, {
    user: maskUser(user),
    entitlement: maskEntitlement(entitlement),
    boards: boards.documents.map(maskBoard),
    firmwares: firmwares.documents.map((firmware) => ({
      id: firmware.$id,
      userId: firmware.userId,
      boardId: firmware.boardId,
      version: firmware.version,
      filename: firmware.filename,
      size: Number(firmware.size || 0),
      deployed: Boolean(firmware.deployed),
      uploadedAt: firmware.uploadedAt || firmware.$createdAt,
    })),
    usage: usage.documents.map(maskUsage),
    credits: credits.documents.map(maskCredit),
  });
}

async function updateEntitlement(req, res) {
  const payload = readPayload(req);
  const userId = String(payload.userId || '').trim();
  if (!userId) {
    return fail(res, 400, 'userId is required.');
  }

  const tier = ['hobby', 'pro', 'max'].includes(payload.tier) ? payload.tier : 'hobby';
  const status = ['active', 'paused', 'blocked'].includes(payload.status) ? payload.status : 'active';
  const monthlyCredits = Math.max(0, Math.trunc(Number(payload.monthlyCredits || 0)));
  const now = new Date().toISOString();
  const adminClient = createAdminClient(req);
  const databases = new Databases(adminClient);
  const id = entitlementId(userId);
  const data = {
    userId,
    tier,
    status,
    monthlyCredits,
    notes: String(payload.notes || '').slice(0, 2000),
    updatedAt: now,
  };

  let entitlement;
  try {
    entitlement = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_USER_ENTITLEMENTS_COLLECTION_ID, id, data, userEntitlementPermissions(userId));
  } catch (error) {
    if (Number(error?.code || 0) !== 404) {
      throw error;
    }
    entitlement = await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_USER_ENTITLEMENTS_COLLECTION_ID, id, {
      ...data,
      createdAt: now,
    }, userEntitlementPermissions(userId));
  }

  const periodKey = periodKeyFor();
  const creditAccount = await findFirst(databases, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, [
    Query.equal('userId', userId),
    Query.equal('periodKey', periodKey),
  ]).catch(() => null);

  if (creditAccount && monthlyCredits > 0) {
    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, creditAccount.$id, {
      monthlyAllowance: monthlyCredits,
      updatedAt: now,
    });
  }

  return ok(res, { entitlement: maskEntitlement(entitlement) });
}

async function listSettings(req, res) {
  const databases = new Databases(createAdminClient(req));
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_APP_SETTINGS_COLLECTION_ID, [Query.limit(100), Query.orderAsc('key')]);
  return ok(res, { settings: response.documents.map(maskSetting) });
}

async function upsertSetting(req, res) {
  const payload = readPayload(req);
  const key = String(payload.key || '').trim();
  if (!/^[A-Za-z0-9._:-]{2,128}$/.test(key)) {
    return fail(res, 400, 'A valid setting key is required.');
  }

  const databases = new Databases(createAdminClient(req));
  const existing = await findFirst(databases, APPWRITE_APP_SETTINGS_COLLECTION_ID, [Query.equal('key', key)]).catch(() => null);
  const data = {
    key,
    value: String(payload.value ?? ''),
    description: String(payload.description || '').slice(0, 512),
    updatedAt: new Date().toISOString(),
  };
  const document = existing
    ? await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_APP_SETTINGS_COLLECTION_ID, existing.$id, data)
    : await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_APP_SETTINGS_COLLECTION_ID, settingId(key), data, []);

  return ok(res, { setting: maskSetting(document) });
}

async function listModelPool(req, res) {
  const databases = new Databases(createAdminClient(req));
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, [Query.limit(100)]);
  return ok(res, { keys: response.documents.map(maskPoolKey) });
}

async function upsertModelPoolKey(req, res) {
  const payload = readPayload(req);
  const keyId = String(payload.keyId || '').trim();
  const now = new Date().toISOString();
  const data = {
    providerLabel: String(payload.providerLabel || 'Managed').trim().slice(0, 120),
    baseUrl: String(payload.baseUrl || '').trim(),
    status: payload.status === 'disabled' ? 'disabled' : 'active',
    fastModel: String(payload.fastModel || '').trim(),
    fastEditorModel: String(payload.fastEditorModel || payload.fastModel || '').trim(),
    powerModel: String(payload.powerModel || '').trim(),
    powerEditorModel: String(payload.powerEditorModel || payload.powerModel || '').trim(),
    assignmentWeight: Math.max(1, Math.trunc(Number(payload.assignmentWeight || 1))),
    maxAssignments: Math.max(0, Math.trunc(Number(payload.maxAssignments || 0))),
    updatedAt: now,
  };

  if (!data.baseUrl || !data.fastModel || !data.powerModel) {
    return fail(res, 400, 'baseUrl, fastModel, and powerModel are required.');
  }

  if (String(payload.apiKey || '').trim()) {
    data.apiKey = LEGACY_RAW_KEY_SENTINEL;
    data.apiKeyEnvelope = encryptSecret(payload.apiKey);
    data.apiKeyPreview = redactSecret(payload.apiKey);
  }

  const databases = new Databases(createAdminClient(req));
  const document = keyId
    ? await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, keyId, data)
    : await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, ID.unique(), {
      ...data,
      assignedCount: 0,
      lastHealthStatus: '',
      lastHealthAt: '',
      createdAt: now,
    }, []);

  return ok(res, { key: maskPoolKey(document) });
}

function errorResponse(caughtError) {
  const rawMessage = caughtError instanceof Error ? caughtError.message : 'Unexpected admin failure.';
  const statusCode = Number(caughtError?.statusCode || caughtError?.code || 0);
  return {
    status: statusCode >= 400 && statusCode < 600 ? statusCode : 500,
    error: rawMessage,
  };
}

export default async function ({ req, res, error }) {
  try {
    if (req.path === '/health' || req.path === '/warm') {
      return ok(res, { service: 'web-admin', status: 'ok', timestamp: new Date().toISOString() });
    }

    await resolveAdmin(req);

    switch (req.path) {
      case '/':
      case '/dashboard':
        return await dashboard(req, res);
      case '/users':
        return await listUsers(req, res);
      case '/users/detail':
        return await userDetail(req, res);
      case '/users/entitlement':
        return await updateEntitlement(req, res);
      case '/settings':
        return await listSettings(req, res);
      case '/settings/upsert':
        return await upsertSetting(req, res);
      case '/model-pool':
        return await listModelPool(req, res);
      case '/model-pool/upsert':
        return await upsertModelPoolKey(req, res);
      default:
        return fail(res, 404, `Unknown admin path: ${req.path}`);
    }
  } catch (caughtError) {
    const response = errorResponse(caughtError);
    error(response.error);
    return fail(res, response.status, response.error);
  }
}

import { Client, Databases, Functions, ID, Permission, Query, Role, Storage, Users } from 'node-appwrite';
import { LEGACY_RAW_KEY_SENTINEL, encryptSecret, redactSecret, resolveStoredApiKey } from './secretEnvelope.js';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_BOARDS_COLLECTION_ID = 'boards',
  APPWRITE_FIRMWARE_COLLECTION_ID = 'firmwares',
  APPWRITE_APP_SETTINGS_COLLECTION_ID = 'app_settings',
  APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID = 'agent_managed_key_pool',
  APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID = 'utility_ai_model_pool',
  APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID = 'agent_credit_accounts',
  APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID = 'agent_usage_ledger',
  APPWRITE_CLOUD_PROJECTS_COLLECTION_ID = 'cloud_projects',
  APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID = 'cloud_project_devices',
  APPWRITE_CLOUD_PROJECT_SYNC_EVENTS_COLLECTION_ID = 'cloud_project_sync_events',
  APPWRITE_SUPPORT_TICKETS_COLLECTION_ID = 'support_tickets',
  APPWRITE_ADMIN_OPERATION_RUNS_COLLECTION_ID = 'admin_operation_runs',
  APPWRITE_ADMIN_AUDIT_EVENTS_COLLECTION_ID = 'admin_audit_events',
  APPWRITE_FIRMWARE_BUCKET_ID = 'firmware_bucket',
  APPWRITE_FIRMWARE_SOURCE_BUCKET_ID = 'firmware_source_snapshots',
  APPWRITE_USER_ENTITLEMENTS_COLLECTION_ID = 'user_entitlements',
  APPWRITE_AGENT_SETTINGS_FUNCTION_ID = 'agent-settings',
  APPWRITE_BOARD_ADMIN_FUNCTION_ID = 'board-admin',
  APPWRITE_DEVICE_GATEWAY_FUNCTION_ID = 'device-gateway',
  APPWRITE_AGENT_GATEWAY_FUNCTION_ID = 'agent-gateway',
  APPWRITE_BOARD_DETECTION_FUNCTION_ID = 'board-detection',
  APPWRITE_PROJECT_SYNC_FUNCTION_ID = 'project-sync',
  APPWRITE_DESKTOP_AUTH_FUNCTION_ID = 'desktop-auth',
  AZURE_SUBSCRIPTION_ID = '',
  AZURE_TENANT_ID = '',
  AZURE_CLIENT_ID = '',
  AZURE_CLIENT_SECRET = '',
  AZURE_APPWRITE_RESOURCE_GROUP = 'rg-tantalum-appwrite-prod',
  AZURE_APPWRITE_VM_NAME = 'vm-tantalum-appwrite-prod',
  AZURE_GITEA_RESOURCE_GROUP = 'rg-tantalum-git-prod',
  AZURE_GITEA_VM_NAME = 'vm-tantalum-git-prod',
  AZURE_LOG_ANALYTICS_WORKSPACE_ID = '',
  AZURE_LOG_ANALYTICS_RESOURCE_GROUP = '',
  AZURE_LOG_ANALYTICS_WORKSPACE_NAME = '',
  AZURE_BACKUP_STORAGE_ACCOUNT = '',
  AZURE_BACKUP_CONTAINER = 'appwrite-backups',
  AZURE_BACKUP_PREFIX = 'scheduled/',
  AZURE_GITEA_BACKUP_STORAGE_ACCOUNT = '',
  AZURE_GITEA_BACKUP_CONTAINER = 'git-backups',
  AZURE_GITEA_BACKUP_PREFIX = 'scheduled/',
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

  const candidates = [req.body, req.bodyText, req.bodyRaw];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (typeof candidate === 'object' && !Buffer.isBuffer(candidate)) {
      return candidate;
    }
    try {
      return JSON.parse(Buffer.isBuffer(candidate) ? candidate.toString('utf8') : String(candidate));
    } catch {
      // Try the next body shape exposed by the runtime.
    }
  }

  return {};
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

function headerValue(req, names) {
  const headers = req.headers || {};
  for (const name of names) {
    if (headers[name]) {
      return headers[name];
    }

    const lowerName = name.toLowerCase();
    if (headers[lowerName]) {
      return headers[lowerName];
    }

    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
    if (match?.[1]) {
      return match[1];
    }
  }

  return '';
}

function requestUserJwt(req) {
  const bodyJwt = readPayload(req).__tantalumUserJwt;
  const candidates = [
    bodyJwt,
    headerValue(req, ['x-tantalum-user-jwt']),
  ];

  for (const candidate of candidates) {
    const cleanJwt = String(candidate || '').replace(/^Bearer\s+/i, '').trim();
    if (cleanJwt.split('.').length === 3) {
      return cleanJwt;
    }
  }

  return '';
}

function requestAppwriteUserJwt(req) {
  const candidates = [
    headerValue(req, ['x-appwrite-user-jwt']),
    headerValue(req, ['x-appwrite-jwt']),
  ];

  for (const candidate of candidates) {
    const cleanJwt = String(candidate || '').replace(/^Bearer\s+/i, '').trim();
    if (cleanJwt.split('.').length === 3) {
      return cleanJwt;
    }
  }

  return '';
}

function jwtClaims(jwt) {
  try {
    const payload = String(jwt || '').split('.')[1] || '';
    const padded = `${payload}${'='.repeat((4 - (payload.length % 4)) % 4)}`;
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function userIdFromJwt(jwt) {
  return String(jwtClaims(jwt).userId || '').trim();
}

function requestExecutionUserId(req) {
  return String(headerValue(req, [
    'x-appwrite-user-id',
    'x-appwrite-userid',
    'x-appwrite-user',
  ]) || '').trim();
}

async function userFromBrowserJwt(req, jwt, users) {
  const claims = jwtClaims(jwt);
  const userId = String(claims.userId || '').trim();
  const sessionId = String(claims.sessionId || '').trim();
  const expiresAt = Number(claims.exp || 0);
  if (!userId || !sessionId || !expiresAt || expiresAt * 1000 <= Date.now()) {
    const error = new Error('Admin session token is invalid or expired. Please sign out and sign in again.');
    error.statusCode = 401;
    throw error;
  }

  const sessionList = await adminGetJson(req, `/users/${encodeURIComponent(userId)}/sessions`, [restQuery('limit', 100)], 5000);
  const session = (sessionList.sessions || []).find((entry) => entry?.$id === sessionId);
  if (!session || (session.expire && new Date(session.expire).getTime() <= Date.now())) {
    const error = new Error('Admin session token is not active. Please sign out and sign in again.');
    error.statusCode = 401;
    throw error;
  }

  return await users.get(userId);
}

async function resolveAdmin(req) {
  const untrustedJwt = requestUserJwt(req);
  const executionUserId = requestExecutionUserId(req);
  const appwriteJwtUserId = userIdFromJwt(requestAppwriteUserJwt(req));
  let user;
  const users = new Users(createAdminClient(req));

  if (executionUserId) {
    user = await users.get(executionUserId);
  } else if (appwriteJwtUserId) {
    user = await users.get(appwriteJwtUserId);
  } else if (untrustedJwt) {
    user = await userFromBrowserJwt(req, untrustedJwt, users);
  } else {
    const error = new Error('Admin session is missing. Please sign out and sign in again.');
    error.statusCode = 401;
    throw error;
  }

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

function maskUtilityModel(entry) {
  const rawPreview = entry.apiKey && entry.apiKey !== LEGACY_RAW_KEY_SENTINEL ? redactSecret(entry.apiKey) : '';
  return {
    id: entry.$id,
    providerLabel: entry.providerLabel || '',
    baseUrl: entry.baseUrl || '',
    model: entry.model || '',
    enabled: entry.enabled !== false,
    taskTags: Array.isArray(entry.taskTags) ? entry.taskTags : [],
    priority: Number(entry.priority || 100),
    apiKeyPreview: entry.apiKeyPreview || rawPreview || (entry.apiKeyEnvelope ? 'encrypted' : ''),
    updatedAt: entry.updatedAt || entry.$updatedAt,
  };
}

function maskProject(project) {
  return {
    id: project.$id,
    userId: project.userId,
    name: project.name,
    repoOwner: project.repoOwner,
    repoName: project.repoName,
    status: project.status,
    quotaMb: Number(project.quotaMb || 0),
    lastSyncedAt: project.lastSyncedAt || '',
    updatedAt: project.updatedAt || project.$updatedAt,
  };
}

function maskSupportTicket(ticket) {
  return {
    id: ticket.$id,
    userId: ticket.userId,
    subject: ticket.subject || '',
    status: ticket.status || '',
    priority: ticket.priority || 'normal',
    createdAt: ticket.createdAt || ticket.$createdAt,
    updatedAt: ticket.updatedAt || ticket.$updatedAt,
  };
}

function maskOperation(operation) {
  return {
    id: operation.$id,
    actorUserId: operation.actorUserId || '',
    operation: operation.operation || '',
    target: operation.target || '',
    status: operation.status || '',
    preflightJson: operation.preflightJson || '',
    resultJson: operation.resultJson || '',
    error: operation.error || '',
    createdAt: operation.createdAt || operation.$createdAt,
    updatedAt: operation.updatedAt || operation.$updatedAt,
    completedAt: operation.completedAt || '',
  };
}

function maskAuditEvent(event) {
  return {
    id: event.$id,
    actorUserId: event.actorUserId || '',
    action: event.action || '',
    target: event.target || '',
    status: event.status || '',
    message: event.message || '',
    metadataJson: event.metadataJson || '',
    createdAt: event.createdAt || event.$createdAt,
  };
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function redactLogText(value) {
  return String(value || '')
    .replace(/(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(x-appwrite-key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api|access|secret|refresh|session|jwt|token|password|passwd|pwd|client_secret)[-_a-z0-9]*["'\s:=]+)["']?[^"',\s]+/gi, '$1[redacted]')
    .replace(/(mongodb(?:\+srv)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, '$1[redacted]$2')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .slice(0, 8000);
}

function logEntry({ id, source, service, severity = 'info', status = '', message, timestamp = new Date().toISOString(), metadata = {} }) {
  return {
    id: String(id || `${source}_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    source,
    service: service || '',
    severity: String(severity || status || 'info').toLowerCase(),
    status: String(status || ''),
    message: redactLogText(message),
    timestamp,
    metadata,
  };
}

async function writeAudit(databases, adminUser, action, target, status, message, metadata = {}) {
  if (!APPWRITE_ADMIN_AUDIT_EVENTS_COLLECTION_ID) {
    return;
  }

  try {
    await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_ADMIN_AUDIT_EVENTS_COLLECTION_ID, ID.unique(), {
      actorUserId: adminUser?.$id || '',
      action: String(action || '').slice(0, 128),
      target: String(target || '').slice(0, 255),
      status: String(status || '').slice(0, 32),
      message: String(message || '').slice(0, 1024),
      metadataJson: JSON.stringify(metadata || {}).slice(0, 32768),
      createdAt: new Date().toISOString(),
    }, []);
  } catch {
    // Auditing should not hide the primary admin operation result.
  }
}

async function findFirst(databases, collectionId, queries) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [...queries, Query.limit(1)]);
  return response.documents[0] || null;
}

function restQuery(method, value) {
  if (method === 'orderAsc' || method === 'orderDesc') {
    return { method, attribute: String(value) };
  }
  return { method, values: Array.isArray(value) ? value : [value] };
}

async function adminGetJson(req, path, queries = [], timeoutMs = 8000) {
  const endpoint = APPWRITE_FUNCTION_API_ENDPOINT.replace(/\/+$/, '');
  const queryText = queries.length
    ? `?${queries.map((query, index) => `queries[${index}]=${encodeURIComponent(JSON.stringify(query))}`).join('&')}`
    : '';
  const response = await fetch(`${endpoint}${path}${queryText}`, {
    headers: {
      'x-appwrite-project': APPWRITE_FUNCTION_PROJECT_ID,
      'x-appwrite-key': headerValue(req, ['x-appwrite-key']),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(payload?.message || `Appwrite request failed with ${response.status}.`);
    requestError.statusCode = response.status;
    throw requestError;
  }
  return payload;
}

async function adminPostJson(req, path, body = {}, timeoutMs = 8000) {
  const endpoint = APPWRITE_FUNCTION_API_ENDPOINT.replace(/\/+$/, '');
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-appwrite-project': APPWRITE_FUNCTION_PROJECT_ID,
      'x-appwrite-key': headerValue(req, ['x-appwrite-key']),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(payload?.message || `Appwrite request failed with ${response.status}.`);
    requestError.statusCode = response.status;
    throw requestError;
  }
  return payload;
}

function emptyDocuments() {
  return { total: 0, documents: [] };
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
  const [userList, boardList, usageList, creditList, settingsList, projectList, supportList] = await Promise.all([
    adminGetJson(req, '/users', [restQuery('limit', 10)], 1500).catch(() => ({ total: 0, users: [] })),
    adminGetJson(req, `/databases/${APPWRITE_DATABASE_ID}/collections/${APPWRITE_BOARDS_COLLECTION_ID}/documents`, [restQuery('limit', 1)], 1000).catch(emptyDocuments),
    adminGetJson(req, `/databases/${APPWRITE_DATABASE_ID}/collections/${APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID}/documents`, [restQuery('limit', 25), restQuery('orderDesc', 'createdAt')], 1000).catch(emptyDocuments),
    adminGetJson(req, `/databases/${APPWRITE_DATABASE_ID}/collections/${APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID}/documents`, [restQuery('limit', 25)], 1000).catch(emptyDocuments),
    adminGetJson(req, `/databases/${APPWRITE_DATABASE_ID}/collections/${APPWRITE_APP_SETTINGS_COLLECTION_ID}/documents`, [restQuery('limit', 50), restQuery('orderAsc', 'key')], 1000).catch(emptyDocuments),
    adminGetJson(req, `/databases/${APPWRITE_DATABASE_ID}/collections/${APPWRITE_CLOUD_PROJECTS_COLLECTION_ID}/documents`, [restQuery('limit', 25), restQuery('orderDesc', 'updatedAt')], 1000).catch(emptyDocuments),
    adminGetJson(req, `/databases/${APPWRITE_DATABASE_ID}/collections/${APPWRITE_SUPPORT_TICKETS_COLLECTION_ID}/documents`, [restQuery('limit', 25), restQuery('orderDesc', 'createdAt')], 1000).catch(emptyDocuments),
  ]);

  const chargedCredits = usageList.documents.reduce((total, event) => total + Number(event.chargedCredits || 0), 0);
  return ok(res, {
    totals: {
      users: userList.total || 0,
      boards: boardList.total || 0,
      recentUsageEvents: usageList.total || 0,
      chargedCredits,
      projects: projectList.total || 0,
      supportTickets: supportList.total || 0,
      settings: settingsList.total || settingsList.documents.length,
    },
    recentUsers: userList.users.map(maskUser),
    recentUsage: usageList.documents.map(maskUsage),
    creditAccounts: creditList.documents.map(maskCredit),
    settings: settingsList.documents.map(maskSetting),
    projects: projectList.documents.map(maskProject),
    supportTickets: supportList.documents.map(maskSupportTicket),
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
  const [user, boards, firmwares, usage, credits, entitlement, projects] = await Promise.all([
    users.get(userId),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_BOARDS_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(100), Query.orderDesc('createdAt')]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_FIRMWARE_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(100)]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(50), Query.orderDesc('createdAt')]),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(24), Query.orderDesc('periodKey')]),
    findFirst(databases, APPWRITE_USER_ENTITLEMENTS_COLLECTION_ID, [Query.equal('userId', userId)]).catch(() => null),
    databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECTS_COLLECTION_ID, [Query.equal('userId', userId), Query.limit(50), Query.orderDesc('updatedAt')]).catch(() => ({ documents: [] })),
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
    projects: projects.documents.map(maskProject),
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

async function listUtilityModelPool(req, res) {
  const databases = new Databases(createAdminClient(req));
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID, [Query.limit(100), Query.orderAsc('priority')]);
  return ok(res, { models: response.documents.map(maskUtilityModel) });
}

async function upsertUtilityModel(req, res) {
  const payload = readPayload(req);
  const keyId = String(payload.keyId || '').trim();
  const now = new Date().toISOString();
  const data = {
    providerLabel: String(payload.providerLabel || 'Utility AI').trim().slice(0, 120),
    baseUrl: String(payload.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(payload.model || '').trim(),
    enabled: payload.enabled !== false,
    taskTags: Array.isArray(payload.taskTags)
      ? payload.taskTags.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
      : String(payload.taskTags || '').split(/[\n,]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    priority: Math.trunc(Number(payload.priority || 100)),
    updatedAt: now,
  };

  if (!data.baseUrl || !data.model) {
    return fail(res, 400, 'baseUrl and model are required.');
  }

  if (String(payload.apiKey || '').trim()) {
    data.apiKey = LEGACY_RAW_KEY_SENTINEL;
    data.apiKeyEnvelope = encryptSecret(payload.apiKey);
    data.apiKeyPreview = redactSecret(payload.apiKey);
  }

  const databases = new Databases(createAdminClient(req));
  const document = keyId
    ? await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID, keyId, data)
    : await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID, ID.unique(), {
      ...data,
      createdAt: now,
    }, []);

  return ok(res, { model: maskUtilityModel(document) });
}

async function testModelEndpoint(baseUrl, apiKey) {
  const response = await fetch(`${String(baseUrl || '').replace(/\/+$/, '')}/models`, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Provider redirected the request.');
  }

  if (!response.ok) {
    throw new Error(`Provider returned ${response.status}.`);
  }
}

async function testPoolKey(req, res, collectionId, mask) {
  const payload = readPayload(req);
  const keyId = String(payload.keyId || '').trim();
  if (!keyId) {
    return fail(res, 400, 'keyId is required.');
  }

  const databases = new Databases(createAdminClient(req));
  const entry = await databases.getDocument(APPWRITE_DATABASE_ID, collectionId, keyId);
  const apiKey = resolveStoredApiKey(entry, 'Model pool API key');
  await testModelEndpoint(entry.baseUrl, apiKey);

  const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, collectionId, keyId, {
    lastHealthStatus: 'pass',
    lastHealthAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).catch(() => entry);

  return ok(res, { entry: mask(updated), tested: true });
}

async function databaseStatus(req, res) {
  const collectionIds = [
    APPWRITE_BOARDS_COLLECTION_ID,
    APPWRITE_FIRMWARE_COLLECTION_ID,
    APPWRITE_APP_SETTINGS_COLLECTION_ID,
    APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID,
    APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID,
    APPWRITE_AGENT_CREDIT_ACCOUNTS_COLLECTION_ID,
    APPWRITE_AGENT_USAGE_LEDGER_COLLECTION_ID,
    APPWRITE_USER_ENTITLEMENTS_COLLECTION_ID,
    APPWRITE_CLOUD_PROJECTS_COLLECTION_ID,
    APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID,
    APPWRITE_CLOUD_PROJECT_SYNC_EVENTS_COLLECTION_ID,
    APPWRITE_SUPPORT_TICKETS_COLLECTION_ID,
    APPWRITE_ADMIN_OPERATION_RUNS_COLLECTION_ID,
    APPWRITE_ADMIN_AUDIT_EVENTS_COLLECTION_ID,
  ].filter(Boolean);
  const missing = collectionIds.filter((id) => !id);
  const collections = await Promise.all(collectionIds.map(async (id) => {
    try {
      const response = await adminGetJson(req, `/databases/${APPWRITE_DATABASE_ID}/collections/${id}/documents`, [restQuery('limit', 1)], 1000);
      return { id, name: id, total: response.total || 0, status: 'ok' };
    } catch (error) {
      return { id, name: id, total: 0, status: 'error', error: error instanceof Error ? error.message : 'Unable to read collection.' };
    }
  }));

  const bucketIds = [APPWRITE_FIRMWARE_BUCKET_ID, APPWRITE_FIRMWARE_SOURCE_BUCKET_ID].filter(Boolean);
  const buckets = await Promise.all(bucketIds.map(async (id) => {
    try {
      const response = await adminGetJson(req, `/storage/buckets/${id}/files`, [restQuery('limit', 1)], 1000);
      return { id, name: id, total: response.total || 0, status: 'ok' };
    } catch (error) {
      return { id, name: id, total: 0, status: 'error', error: error instanceof Error ? error.message : 'Unable to read bucket.' };
    }
  }));

  return ok(res, { collections, storage: buckets, missing });
}

async function functionStatus(req, res) {
  const functionIds = [
    APPWRITE_AGENT_SETTINGS_FUNCTION_ID,
    APPWRITE_BOARD_ADMIN_FUNCTION_ID,
    APPWRITE_DEVICE_GATEWAY_FUNCTION_ID,
    APPWRITE_AGENT_GATEWAY_FUNCTION_ID,
    APPWRITE_BOARD_DETECTION_FUNCTION_ID,
    APPWRITE_PROJECT_SYNC_FUNCTION_ID,
    APPWRITE_DESKTOP_AUTH_FUNCTION_ID,
    'web-admin',
  ].filter(Boolean);

  const results = await Promise.all(functionIds.map(async (functionId) => {
    const startedAt = Date.now();
    try {
      const execution = await adminPostJson(req, `/functions/${functionId}/executions`, {
        body: JSON.stringify({ reason: 'web-admin-status' }),
        async: false,
        path: '/health',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, 4500);
      const statusCode = Number(execution.responseStatusCode || execution.statusCode || 0);
      return {
        id: functionId,
        name: functionId,
        status: statusCode >= 400 ? 'error' : execution.status || 'completed',
        statusCode,
        duration: Number(execution.duration || Date.now() - startedAt),
        updatedAt: execution.$updatedAt || execution.$createdAt,
      };
    } catch (error) {
      return {
        id: functionId,
        name: functionId,
        status: 'error',
        duration: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'Function check failed.',
      };
    }
  }));

  return ok(res, { functions: results });
}

function azureTarget(key) {
  if (key === 'gitea') {
    return {
      key: 'gitea',
      label: 'Gitea VM',
      resourceGroup: AZURE_GITEA_RESOURCE_GROUP,
      vmName: AZURE_GITEA_VM_NAME,
      backupAccount: AZURE_GITEA_BACKUP_STORAGE_ACCOUNT,
      backupContainer: AZURE_GITEA_BACKUP_CONTAINER,
      backupPrefix: AZURE_GITEA_BACKUP_PREFIX,
    };
  }

  return {
    key: 'appwrite',
    label: 'Appwrite VM',
    resourceGroup: AZURE_APPWRITE_RESOURCE_GROUP,
    vmName: AZURE_APPWRITE_VM_NAME,
    backupAccount: AZURE_BACKUP_STORAGE_ACCOUNT,
    backupContainer: AZURE_BACKUP_CONTAINER,
    backupPrefix: AZURE_BACKUP_PREFIX,
  };
}

async function azureToken(resource = 'https://management.azure.com/') {
  if (AZURE_TENANT_ID && AZURE_CLIENT_ID && AZURE_CLIENT_SECRET) {
    const response = await fetch(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        grant_type: 'client_credentials',
        scope: `${resource.replace(/\/$/, '')}/.default`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error_description || payload.error || 'Azure service principal token request failed.');
    }
    return payload.access_token;
  }

  const response = await fetch(`http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}`, {
    headers: { Metadata: 'true' },
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Azure managed identity token request failed.');
  }
  return payload.access_token;
}

async function azureRequest(pathOrUrl, options = {}, resource = 'https://management.azure.com/') {
  if (!AZURE_SUBSCRIPTION_ID && !String(pathOrUrl).startsWith('https://')) {
    throw new Error('AZURE_SUBSCRIPTION_ID is not configured.');
  }
  const token = await azureToken(resource);
  const url = String(pathOrUrl).startsWith('https://') ? pathOrUrl : `https://management.azure.com${pathOrUrl}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    signal: options.signal || AbortSignal.timeout(30000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok && response.status !== 202) {
    throw new Error(payload?.error?.message || payload?.message || `Azure request failed with ${response.status}.`);
  }
  return {
    status: response.status,
    payload,
    operationUrl: response.headers.get('azure-asyncoperation') || response.headers.get('location') || '',
  };
}

function vmPath(target) {
  return `/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${target.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${target.vmName}`;
}

async function getVm(target) {
  const result = await azureRequest(`${vmPath(target)}?$expand=instanceView&api-version=2023-09-01`);
  const statuses = result.payload?.properties?.instanceView?.statuses || [];
  const power = statuses.find((entry) => String(entry.code || '').startsWith('PowerState/'))?.displayStatus || '';
  return {
    raw: result.payload,
    size: result.payload?.properties?.hardwareProfile?.vmSize || '',
    powerState: power,
    resourceId: result.payload?.id || '',
  };
}

async function getLatestBackup(target) {
  if (!target.backupAccount || !target.backupContainer) {
    return { ok: false, message: 'Backup storage is not configured.' };
  }

  return { ok: true, message: 'Backup storage configured.' };
}

function recommendMode(size, memoryMetric = 0) {
  const lower = String(size || '').toLowerCase();
  if (memoryMetric >= 85) return 'Growth';
  if (lower.includes('b8')) return 'Surge';
  if (lower.includes('b4')) return 'Growth';
  if (lower.includes('b2s')) return 'Baseline';
  return 'Cost';
}

async function infraTargetStatus(target) {
  if (!AZURE_SUBSCRIPTION_ID || !target.resourceGroup || !target.vmName) {
    return { ...target, configured: false, error: 'Azure subscription, resource group, or VM name is not configured.' };
  }

  try {
    const vm = await getVm(target);
    const backup = await getLatestBackup(target);
    return {
      ...target,
      configured: true,
      size: vm.size,
      powerState: vm.powerState,
      publicIp: '',
      backup,
      health: { ok: true, message: 'Azure VM metadata readable.' },
      metrics: {},
      recommendedMode: recommendMode(vm.size),
    };
  } catch (error) {
    return {
      ...target,
      configured: true,
      error: error instanceof Error ? error.message : 'Unable to read Azure VM.',
    };
  }
}

async function listOperationRuns(databases, limit = 20) {
  if (!APPWRITE_ADMIN_OPERATION_RUNS_COLLECTION_ID) {
    return [];
  }

  try {
    const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ADMIN_OPERATION_RUNS_COLLECTION_ID, [Query.limit(limit), Query.orderDesc('updatedAt')]);
    return response.documents.map(maskOperation);
  } catch {
    return [];
  }
}

async function infraStatus(req, res) {
  const databases = new Databases(createAdminClient(req));
  const [appwrite, gitea, operations] = await Promise.all([
    infraTargetStatus(azureTarget('appwrite')),
    infraTargetStatus(azureTarget('gitea')),
    listOperationRuns(databases),
  ]);
  return ok(res, { targets: [appwrite, gitea], operations });
}

async function infraPreflight(req, res) {
  const payload = readPayload(req);
  const target = azureTarget(payload.target === 'gitea' ? 'gitea' : 'appwrite');
  const size = String(payload.size || '').trim();
  if (!size) {
    return fail(res, 400, 'size is required.');
  }

  const status = await infraTargetStatus(target);
  if (!status.configured || status.error) {
    return fail(res, 400, status.error || 'Azure target is not configured.');
  }

  return ok(res, {
    target: status,
    preflight: {
      currentSize: status.size,
      targetSize: size,
      powerState: status.powerState,
      backup: status.backup,
      health: status.health,
    },
    confirmation: `RESIZE ${target.vmName} ${size}`,
  });
}

async function createOperation(databases, adminUser, operation, target, preflight, result = {}) {
  const now = new Date().toISOString();
  const document = await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_ADMIN_OPERATION_RUNS_COLLECTION_ID, ID.unique(), {
    actorUserId: adminUser.$id,
    operation,
    target,
    status: 'started',
    preflightJson: JSON.stringify(preflight || {}),
    resultJson: JSON.stringify(result || {}),
    error: '',
    createdAt: now,
    updatedAt: now,
    completedAt: '',
  }, []);
  return maskOperation(document);
}

async function updateOperation(databases, operationId, data) {
  const document = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_ADMIN_OPERATION_RUNS_COLLECTION_ID, operationId, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
  return maskOperation(document);
}

async function infraResize(req, res, adminUser) {
  const payload = readPayload(req);
  const target = azureTarget(payload.target === 'gitea' ? 'gitea' : 'appwrite');
  const size = String(payload.size || '').trim();
  const expectedConfirmation = `RESIZE ${target.vmName} ${size}`;
  if (String(payload.confirmation || '').trim() !== expectedConfirmation) {
    return fail(res, 400, `Confirmation must be exactly: ${expectedConfirmation}`);
  }

  const databases = new Databases(createAdminClient(req));
  const preflight = await infraTargetStatus(target);
  if (!preflight.configured || preflight.error) {
    return fail(res, 400, preflight.error || 'Azure target is not configured.');
  }

  const deallocate = await azureRequest(`${vmPath(target)}/deallocate?api-version=2023-09-01`, { method: 'POST' });
  const operation = await createOperation(databases, adminUser, 'azure.vm.resize', target.key, preflight, {
    phase: 'deallocating',
    target,
    targetSize: size,
    azureOperationUrl: deallocate.operationUrl,
  });
  await writeAudit(databases, adminUser, 'infra.resize.start', target.key, 'started', `Started guarded resize to ${size}.`, { operationId: operation.id });
  return ok(res, { operation });
}

async function pollAzureOperation(operationUrl) {
  if (!operationUrl) {
    return { done: true, status: 'Succeeded' };
  }
  const result = await azureRequest(operationUrl);
  const status = result.payload?.status || (result.status === 200 ? 'Succeeded' : 'InProgress');
  return { done: status === 'Succeeded' || status === 'Failed' || status === 'Canceled', status, payload: result.payload };
}

async function infraOperation(req, res, adminUser) {
  const payload = readPayload(req);
  const operationId = String(payload.operationId || '').trim();
  if (!operationId) {
    return fail(res, 400, 'operationId is required.');
  }

  const databases = new Databases(createAdminClient(req));
  const current = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_ADMIN_OPERATION_RUNS_COLLECTION_ID, operationId);
  const result = parseJson(current.resultJson, {});
  if (['completed', 'failed'].includes(current.status)) {
    return ok(res, { operation: maskOperation(current) });
  }

  try {
    const target = result.target || azureTarget(current.target);
    const azureStatus = await pollAzureOperation(result.azureOperationUrl);
    if (!azureStatus.done) {
      const operation = await updateOperation(databases, operationId, {
        status: result.phase || 'running',
        resultJson: JSON.stringify({ ...result, azureStatus: azureStatus.status }),
      });
      return ok(res, { operation });
    }

    if (azureStatus.status !== 'Succeeded') {
      const operation = await updateOperation(databases, operationId, {
        status: 'failed',
        error: `Azure operation ended with ${azureStatus.status}.`,
        completedAt: new Date().toISOString(),
      });
      await writeAudit(databases, adminUser, 'infra.resize', current.target, 'failed', operation.error, { operationId });
      return ok(res, { operation });
    }

    if (result.phase === 'deallocating') {
      const vm = await getVm(target);
      vm.raw.properties.hardwareProfile.vmSize = result.targetSize;
      const resize = await azureRequest(`${vmPath(target)}?api-version=2023-09-01`, { method: 'PUT', body: vm.raw });
      const operation = await updateOperation(databases, operationId, {
        status: 'resizing',
        resultJson: JSON.stringify({ ...result, phase: 'resizing', azureOperationUrl: resize.operationUrl }),
      });
      return ok(res, { operation });
    }

    if (result.phase === 'resizing') {
      const start = await azureRequest(`${vmPath(target)}/start?api-version=2023-09-01`, { method: 'POST' });
      const operation = await updateOperation(databases, operationId, {
        status: 'starting',
        resultJson: JSON.stringify({ ...result, phase: 'starting', azureOperationUrl: start.operationUrl }),
      });
      return ok(res, { operation });
    }

    const operation = await updateOperation(databases, operationId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultJson: JSON.stringify({ ...result, phase: 'completed' }),
    });
    await writeAudit(databases, adminUser, 'infra.resize', current.target, 'completed', 'Resize operation completed.', { operationId });
    return ok(res, { operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Operation polling failed.';
    const operation = await updateOperation(databases, operationId, {
      status: 'failed',
      error: message,
      completedAt: new Date().toISOString(),
    });
    await writeAudit(databases, adminUser, 'infra.operation', current.target, 'failed', message, { operationId });
    return ok(res, { operation });
  }
}

function logSources() {
  return [
    { id: 'appwrite-functions', label: 'Appwrite function executions', supportsTail: true, supportsExport: true },
    { id: 'tantalum-monitor', label: 'tantalum-monitor syslog', supportsTail: true, supportsExport: true },
    { id: 'appwrite-docker', label: 'Appwrite Docker/syslog', supportsTail: true, supportsExport: true },
    { id: 'vm-syslog', label: 'VM syslog/journal', supportsTail: true, supportsExport: true },
    { id: 'gitea', label: 'Gitea logs', supportsTail: true, supportsExport: true },
    { id: 'azure-activity', label: 'Azure Activity Log', supportsTail: false, supportsExport: true },
    { id: 'azure-metrics', label: 'Azure VM metrics', supportsTail: false, supportsExport: true },
  ];
}

function cleanTimespan(value) {
  const clean = String(value || 'PT1H').trim();
  return /^(PT(15M|30M|1H|6H|12H)|P(1D|7D))$/.test(clean) ? clean : 'PT1H';
}

async function resolveWorkspaceId() {
  if (AZURE_LOG_ANALYTICS_WORKSPACE_ID) {
    return AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  }
  if (!AZURE_LOG_ANALYTICS_RESOURCE_GROUP || !AZURE_LOG_ANALYTICS_WORKSPACE_NAME) {
    return '';
  }
  const result = await azureRequest(`/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${AZURE_LOG_ANALYTICS_RESOURCE_GROUP}/providers/Microsoft.OperationalInsights/workspaces/${AZURE_LOG_ANALYTICS_WORKSPACE_NAME}?api-version=2022-10-01`);
  return result.payload?.properties?.customerId || '';
}

async function logAnalyticsQuery(query, timespan) {
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) {
    throw new Error('Log Analytics workspace is not configured.');
  }
  const token = await azureToken('https://api.loganalytics.io/');
  const response = await fetch(`https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, timespan }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Log Analytics query failed.');
  }
  const table = payload.tables?.[0];
  if (!table) {
    return [];
  }
  const columns = table.columns.map((column) => column.name);
  return table.rows.map((row) => Object.fromEntries(row.map((value, index) => [columns[index], value])));
}

async function queryAppwriteFunctionLogs(req, payload) {
  const functions = new Functions(createAdminClient(req));
  const functionIds = [
    APPWRITE_AGENT_SETTINGS_FUNCTION_ID,
    APPWRITE_BOARD_ADMIN_FUNCTION_ID,
    APPWRITE_DEVICE_GATEWAY_FUNCTION_ID,
    APPWRITE_AGENT_GATEWAY_FUNCTION_ID,
    APPWRITE_BOARD_DETECTION_FUNCTION_ID,
    APPWRITE_PROJECT_SYNC_FUNCTION_ID,
    APPWRITE_DESKTOP_AUTH_FUNCTION_ID,
    'web-admin',
  ].filter(Boolean);
  const limit = cleanLimit(payload.limit, 100, 500);
  const entries = [];

  for (const functionId of functionIds) {
    if (payload.service && !String(functionId).includes(String(payload.service))) {
      continue;
    }
    try {
      const response = await functions.listExecutions(functionId, [Query.limit(Math.min(25, limit)), Query.orderDesc('$createdAt')]);
      for (const execution of response.executions || []) {
        const message = [execution.logs, execution.errors, execution.responseBody || execution.response].filter(Boolean).join('\n');
        if (payload.search && !message.toLowerCase().includes(String(payload.search).toLowerCase())) {
          continue;
        }
        entries.push(logEntry({
          id: `${functionId}_${execution.$id}`,
          source: 'appwrite-functions',
          service: functionId,
          severity: execution.status === 'failed' ? 'error' : 'info',
          status: execution.status,
          message: message || `Execution ${execution.$id} ${execution.status}.`,
          timestamp: execution.$createdAt,
          metadata: { executionId: execution.$id, duration: execution.duration, statusCode: execution.responseStatusCode },
        }));
      }
    } catch (error) {
      entries.push(logEntry({
        id: `${functionId}_error`,
        source: 'appwrite-functions',
        service: functionId,
        severity: 'error',
        message: error instanceof Error ? error.message : 'Unable to list executions.',
      }));
    }
  }

  return entries.slice(0, limit);
}

function kqlForSource(source, payload) {
  const limit = cleanLimit(payload.limit, 100, 500);
  const search = String(payload.search || '').replace(/'/g, "''");
  const service = String(payload.service || '').replace(/'/g, "''");
  let query = 'Syslog | where TimeGenerated > ago(1d)';

  if (source === 'tantalum-monitor') {
    query += " | where ProcessName == 'tantalum-monitor'";
  } else if (source === 'appwrite-docker') {
    query += " | where SyslogMessage has_any ('appwrite', 'openruntimes', 'docker')";
  } else if (source === 'gitea') {
    query += " | where SyslogMessage has_any ('gitea', 'tantalum-gitea')";
  }

  if (service) {
    query += ` | where SyslogMessage has '${service}' or ProcessName has '${service}'`;
  }
  if (search) {
    query += ` | where SyslogMessage has '${search}'`;
  }
  query += ` | order by TimeGenerated desc | take ${limit} | project TimeGenerated, Computer, ProcessName, SeverityLevel, SyslogMessage`;
  return query;
}

async function queryLogAnalyticsLogs(source, payload) {
  const rows = await logAnalyticsQuery(kqlForSource(source, payload), cleanTimespan(payload.range));
  return rows.map((row, index) => logEntry({
    id: `${source}_${row.TimeGenerated}_${index}`,
    source,
    service: row.ProcessName || row.Computer || '',
    severity: row.SeverityLevel || 'info',
    message: row.SyslogMessage || '',
    timestamp: row.TimeGenerated,
    metadata: { computer: row.Computer },
  }));
}

async function queryAzureActivityLogs(payload) {
  const target = azureTarget(payload.service === 'gitea' ? 'gitea' : 'appwrite');
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  const filter = encodeURIComponent(`eventTimestamp ge '${start.toISOString()}' and eventTimestamp le '${end.toISOString()}' and resourceGroupName eq '${target.resourceGroup}'`);
  const result = await azureRequest(`/subscriptions/${AZURE_SUBSCRIPTION_ID}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=${filter}`);
  return (result.payload?.value || []).slice(0, cleanLimit(payload.limit, 100, 500)).map((event) => logEntry({
    id: event.eventDataId,
    source: 'azure-activity',
    service: event.resourceProviderName?.value || event.operationName?.value || '',
    severity: event.level || 'info',
    status: event.status?.value || '',
    message: event.operationName?.localizedValue || event.operationName?.value || '',
    timestamp: event.eventTimestamp,
    metadata: { resourceId: event.resourceId, caller: event.caller },
  }));
}

async function queryAzureMetrics(payload) {
  const target = azureTarget(payload.service === 'gitea' ? 'gitea' : 'appwrite');
  const vm = await getVm(target);
  const result = await azureRequest(`/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${target.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${target.vmName}/providers/Microsoft.Insights/metrics?api-version=2018-01-01&metricnames=Percentage CPU&timespan=PT1H&interval=PT5M&aggregation=Average,Maximum`);
  const data = result.payload?.value?.[0]?.timeseries?.[0]?.data || [];
  return data.slice(-cleanLimit(payload.limit, 100, 500)).reverse().map((point, index) => logEntry({
    id: `metric_${index}_${point.timeStamp}`,
    source: 'azure-metrics',
    service: target.key,
    severity: 'info',
    message: `CPU avg=${point.average ?? '-'} max=${point.maximum ?? '-'} size=${vm.size}`,
    timestamp: point.timeStamp,
  }));
}

async function logsQuery(req, res, adminUser, mode = 'query') {
  const payload = readPayload(req);
  const source = String(payload.source || 'appwrite-functions');
  let entries = [];

  if (source === 'appwrite-functions') {
    entries = await queryAppwriteFunctionLogs(req, payload);
  } else if (source === 'azure-activity') {
    entries = await queryAzureActivityLogs(payload);
  } else if (source === 'azure-metrics') {
    entries = await queryAzureMetrics(payload);
  } else {
    entries = await queryLogAnalyticsLogs(source, payload);
  }

  if (payload.severity) {
    const severity = String(payload.severity).toLowerCase();
    entries = entries.filter((entry) => entry.severity.includes(severity) || entry.status.toLowerCase().includes(severity));
  }

  const exportedText = mode === 'export'
    ? entries.map((entry) => `${entry.timestamp}\t${entry.source}\t${entry.service}\t${entry.severity}\t${entry.message}`).join('\n')
    : undefined;

  const databases = new Databases(createAdminClient(req));
  await writeAudit(databases, adminUser, `logs.${mode}`, source, 'success', `${mode} returned ${entries.length} log entries.`, {
    source,
    range: payload.range,
    service: payload.service || '',
    severity: payload.severity || '',
    search: payload.search ? '[present]' : '',
  });

  return ok(res, { entries, exportedText });
}

async function auditList(req, res) {
  const payload = readPayload(req);
  const databases = new Databases(createAdminClient(req));
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ADMIN_AUDIT_EVENTS_COLLECTION_ID, [
    Query.limit(cleanLimit(payload.limit, 100, 500)),
    Query.orderDesc('createdAt'),
  ]);
  return ok(res, { events: response.documents.map(maskAuditEvent) });
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

    const adminUser = await resolveAdmin(req);

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
      case '/model-pool/test':
        return await testPoolKey(req, res, APPWRITE_AGENT_MANAGED_KEY_POOL_COLLECTION_ID, maskPoolKey);
      case '/utility-model-pool':
        return await listUtilityModelPool(req, res);
      case '/utility-model-pool/upsert':
        return await upsertUtilityModel(req, res);
      case '/utility-model-pool/test':
        return await testPoolKey(req, res, APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID, maskUtilityModel);
      case '/database/status':
        return await databaseStatus(req, res);
      case '/functions/status':
        return await functionStatus(req, res);
      case '/infra/status':
        return await infraStatus(req, res);
      case '/infra/preflight':
        return await infraPreflight(req, res);
      case '/infra/resize':
        return await infraResize(req, res, adminUser);
      case '/infra/operation':
        return await infraOperation(req, res, adminUser);
      case '/logs/sources':
        return ok(res, { sources: logSources() });
      case '/logs/query':
        return await logsQuery(req, res, adminUser, 'query');
      case '/logs/tail':
        return await logsQuery(req, res, adminUser, 'tail');
      case '/logs/export':
        return await logsQuery(req, res, adminUser, 'export');
      case '/audit/list':
        return await auditList(req, res);
      default:
        return fail(res, 404, `Unknown admin path: ${req.path}`);
    }
  } catch (caughtError) {
    const response = errorResponse(caughtError);
    error(response.error);
    return fail(res, response.status, response.error);
  }
}

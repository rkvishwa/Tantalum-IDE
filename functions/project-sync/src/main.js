import crypto from 'node:crypto';

import { Account, Client, Databases, Permission, Query, Role } from 'node-appwrite';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_CLOUD_PROJECTS_COLLECTION_ID = 'cloud_projects',
  APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID = 'cloud_project_devices',
  APPWRITE_CLOUD_PROJECT_SYNC_EVENTS_COLLECTION_ID = 'cloud_project_sync_events',
  GITEA_BASE_URL = 'https://git.metl.run',
  GITEA_ADMIN_TOKEN,
  GITEA_ORG = 'tantalum-users',
  GITEA_SSH_HOST = 'git.metl.run',
  GITEA_SSH_PORT = '2222',
  PROJECT_SYNC_DEFAULT_QUOTA_MB = '1024',
} = process.env;

const DEFAULT_BRANCH = 'main';
const DEFAULT_QUOTA_MB = Math.max(128, Number.parseInt(PROJECT_SYNC_DEFAULT_QUOTA_MB, 10) || 1024);

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
  if (req.bodyJson && typeof req.bodyJson === 'object') {
    return req.bodyJson;
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
  if (!cleanJwt || /^(undefined|null|false)$/i.test(cleanJwt)) {
    return '';
  }

  return cleanJwt.split('.').length === 3 ? cleanJwt : '';
}

async function resolveUser(req) {
  const account = new Account(createUserClient(requestUserJwt(req)));
  return account.get();
}

function userDocumentPermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function userEventPermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function serviceConfigured() {
  return Boolean(
    APPWRITE_DATABASE_ID &&
    APPWRITE_CLOUD_PROJECTS_COLLECTION_ID &&
    APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID &&
    APPWRITE_CLOUD_PROJECT_SYNC_EVENTS_COLLECTION_ID &&
    GITEA_BASE_URL &&
    GITEA_ADMIN_TOKEN &&
    GITEA_ORG,
  );
}

function assertServiceConfigured() {
  if (!serviceConfigured()) {
    const error = new Error('Project sync service is not configured.');
    error.statusCode = 503;
    throw error;
  }
}

function randomDocumentId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function stableDocumentId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32)}`;
}

function slugPart(value, fallback = 'project') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return slug || fallback;
}

function cleanText(value, maxLength = 255) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanDeviceId(value) {
  const deviceId = cleanText(value, 128);
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(deviceId)) {
    const error = new Error('Invalid device ID.');
    error.statusCode = 400;
    throw error;
  }
  return deviceId;
}

function cleanSshPublicKey(value) {
  const key = cleanText(value, 4096).replace(/\s+/g, ' ');
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/=]+(?: .*)?$/.test(key)) {
    const error = new Error('Invalid SSH public key.');
    error.statusCode = 400;
    throw error;
  }
  return key;
}

function keyFingerprint(publicKey) {
  return crypto.createHash('sha256').update(publicKey, 'utf8').digest('base64url');
}

function giteaBaseUrl() {
  return String(GITEA_BASE_URL || '').replace(/\/+$/, '');
}

async function giteaRequest(apiPath, options = {}) {
  assertServiceConfigured();
  const response = await fetch(`${giteaBaseUrl()}${apiPath}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `token ${GITEA_ADMIN_TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok && !(options.allowStatuses || []).includes(response.status)) {
    const error = new Error(payload?.message || `Gitea request failed with status ${response.status}.`);
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return { status: response.status, payload };
}

async function ensureOrg() {
  const username = slugPart(GITEA_ORG, 'tantalum-users');
  const current = await giteaRequest(`/api/v1/orgs/${encodeURIComponent(username)}`, { allowStatuses: [404] });
  if (current.status !== 404) {
    return current.payload;
  }

  const created = await giteaRequest('/api/v1/orgs', {
    method: 'POST',
    body: {
      username,
      full_name: 'Tantalum Users',
      visibility: 'private',
    },
    allowStatuses: [409, 422],
  });
  if (created.status === 409 || created.status === 422) {
    return giteaRequest(`/api/v1/orgs/${encodeURIComponent(username)}`).then((result) => result.payload);
  }
  return created.payload;
}

function gitPayload(project) {
  const owner = project.repoOwner || GITEA_ORG;
  const repo = project.repoName;
  return {
    owner,
    repo,
    branch: project.defaultBranch || DEFAULT_BRANCH,
    sshHost: GITEA_SSH_HOST,
    sshPort: Number.parseInt(GITEA_SSH_PORT, 10) || 2222,
    sshCloneUrl: project.sshCloneUrl || `ssh://git@${GITEA_SSH_HOST}:${GITEA_SSH_PORT}/${owner}/${repo}.git`,
    webUrl: `${giteaBaseUrl()}/${owner}/${repo}`,
  };
}

async function createRepo(repoName, name) {
  await ensureOrg();
  const response = await giteaRequest(`/api/v1/orgs/${encodeURIComponent(GITEA_ORG)}/repos`, {
    method: 'POST',
    body: {
      name: repoName,
      description: `Tantalum cloud project: ${name}`,
      private: true,
      auto_init: false,
      default_branch: DEFAULT_BRANCH,
    },
    allowStatuses: [409, 422],
  });

  if (response.status === 409 || response.status === 422) {
    const existing = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORG)}/${encodeURIComponent(repoName)}`);
    return existing.payload;
  }

  return response.payload;
}

async function addDeployKey(repoOwner, repoName, deviceId, deviceName, publicKey) {
  const title = `device-${slugPart(deviceName || deviceId, 'device')}-${crypto.createHash('sha1').update(deviceId).digest('hex').slice(0, 10)}`;
  const response = await giteaRequest(`/api/v1/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/keys`, {
    method: 'POST',
    body: {
      title,
      key: publicKey,
      read_only: false,
    },
    allowStatuses: [409, 422],
  });

  if (response.status === 409 || response.status === 422) {
    const keys = await giteaRequest(`/api/v1/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/keys`);
    const fingerprint = keyFingerprint(publicKey);
    const matched = (keys.payload || []).find((key) => key.key === publicKey || key.title === title);
    if (matched) {
      return { id: matched.id, title: matched.title, fingerprint };
    }
    const error = new Error('This SSH key is already registered on another Gitea repository.');
    error.statusCode = 409;
    throw error;
  }

  return {
    id: response.payload?.id,
    title: response.payload?.title || title,
    fingerprint: keyFingerprint(publicKey),
  };
}

async function deleteDeployKey(repoOwner, repoName, keyId) {
  if (!keyId) {
    return;
  }

  await giteaRequest(`/api/v1/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/keys/${encodeURIComponent(String(keyId))}`, {
    method: 'DELETE',
    allowStatuses: [404],
  });
}

async function getOwnedProject(databases, userId, projectId) {
  const project = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECTS_COLLECTION_ID, projectId);
  if (project.userId !== userId || project.status === 'deleted') {
    const error = new Error('Cloud project was not found.');
    error.statusCode = 404;
    throw error;
  }
  return project;
}

async function findDevice(databases, userId, projectId, deviceId) {
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID, [
    Query.equal('userId', userId),
    Query.equal('projectId', projectId),
    Query.equal('deviceId', deviceId),
    Query.limit(1),
  ]);
  return response.documents[0] || null;
}

async function upsertDevice(databases, user, project, payload) {
  const deviceId = cleanDeviceId(payload.deviceId);
  const deviceName = cleanText(payload.deviceName || deviceId, 255);
  const sshPublicKey = cleanSshPublicKey(payload.sshPublicKey);
  const now = new Date().toISOString();
  const existing = await findDevice(databases, user.$id, project.$id, deviceId);

  if (existing && existing.status === 'active' && existing.sshPublicKey === sshPublicKey) {
    return existing;
  }

  if (existing?.giteaKeyId) {
    await deleteDeployKey(project.repoOwner, project.repoName, existing.giteaKeyId).catch(() => {});
  }

  const giteaKey = await addDeployKey(project.repoOwner, project.repoName, deviceId, deviceName, sshPublicKey);
  const data = {
    userId: user.$id,
    projectId: project.$id,
    deviceId,
    deviceName,
    sshPublicKey,
    sshPublicKeyFingerprint: giteaKey.fingerprint,
    giteaKeyId: String(giteaKey.id || ''),
    status: 'active',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revokedAt: '',
  };
  const permissions = userDocumentPermissions(user.$id);

  if (existing) {
    return databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID, existing.$id, data, permissions);
  }

  return databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID,
    stableDocumentId('pd', `${project.$id}:${deviceId}`),
    data,
    permissions,
  );
}

async function createProject(req, res) {
  assertServiceConfigured();
  const payload = readPayload(req);
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const now = new Date().toISOString();
  const name = cleanText(payload.name || 'Untitled project', 255) || 'Untitled project';
  const projectId = randomDocumentId('cp');
  const repoName = slugPart(`${projectId}-${name}`, projectId).slice(0, 100);

  await createRepo(repoName, name);

  const projectData = {
    userId: user.$id,
    name,
    repoOwner: GITEA_ORG,
    repoName,
    sshCloneUrl: `ssh://git@${GITEA_SSH_HOST}:${GITEA_SSH_PORT}/${GITEA_ORG}/${repoName}.git`,
    defaultBranch: DEFAULT_BRANCH,
    status: 'active',
    quotaMb: DEFAULT_QUOTA_MB,
    lastSyncedAt: '',
    createdAt: now,
    updatedAt: now,
  };
  const project = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_CLOUD_PROJECTS_COLLECTION_ID,
    projectId,
    projectData,
    userDocumentPermissions(user.$id),
  );
  const device = await upsertDevice(databases, user, project, payload);

  return ok(res, {
    project,
    device,
    git: gitPayload(project),
  }, 201);
}

async function listProjects(req, res) {
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const response = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECTS_COLLECTION_ID, [
    Query.equal('userId', user.$id),
    Query.equal('status', 'active'),
    Query.orderDesc('updatedAt'),
    Query.limit(100),
  ]);

  return ok(res, {
    projects: response.documents.map((project) => ({
      ...project,
      git: gitPayload(project),
    })),
  });
}

async function linkDevice(req, res) {
  assertServiceConfigured();
  const payload = readPayload(req);
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const projectId = cleanText(payload.projectId, 64);
  if (!projectId) {
    return fail(res, 400, 'Project ID is required.');
  }

  const project = await getOwnedProject(databases, user.$id, projectId);
  const device = await upsertDevice(databases, user, project, payload);

  return ok(res, {
    project,
    device,
    git: gitPayload(project),
  });
}

async function revokeDevice(req, res) {
  assertServiceConfigured();
  const payload = readPayload(req);
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const projectId = cleanText(payload.projectId, 64);
  const deviceId = cleanDeviceId(payload.deviceId);
  const project = await getOwnedProject(databases, user.$id, projectId);
  const device = await findDevice(databases, user.$id, project.$id, deviceId);
  if (!device) {
    return fail(res, 404, 'Device was not linked to this project.');
  }

  await deleteDeployKey(project.repoOwner, project.repoName, device.giteaKeyId).catch(() => {});
  const now = new Date().toISOString();
  const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECT_DEVICES_COLLECTION_ID, device.$id, {
    status: 'revoked',
    revokedAt: now,
    updatedAt: now,
  }, userDocumentPermissions(user.$id));

  return ok(res, { project, device: updated, revoked: true });
}

async function deleteProject(req, res) {
  assertServiceConfigured();
  const payload = readPayload(req);
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const projectId = cleanText(payload.projectId, 64);
  const project = await getOwnedProject(databases, user.$id, projectId);
  const now = new Date().toISOString();

  await giteaRequest(`/api/v1/repos/${encodeURIComponent(project.repoOwner)}/${encodeURIComponent(project.repoName)}`, {
    method: 'DELETE',
    allowStatuses: [404],
  });

  const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECTS_COLLECTION_ID, project.$id, {
    status: 'deleted',
    updatedAt: now,
  }, userDocumentPermissions(user.$id));

  return ok(res, { project: updated, deleted: true });
}

async function recordSyncEvent(req, res) {
  const payload = readPayload(req);
  const user = await resolveUser(req);
  const databases = new Databases(createAdminClient(req));
  const projectId = cleanText(payload.projectId, 64);
  const project = await getOwnedProject(databases, user.$id, projectId);
  const now = new Date().toISOString();
  const status = ['success', 'failed', 'conflict', 'paused'].includes(payload.status) ? payload.status : 'success';

  const event = await databases.createDocument(
    APPWRITE_DATABASE_ID,
    APPWRITE_CLOUD_PROJECT_SYNC_EVENTS_COLLECTION_ID,
    randomDocumentId('se'),
    {
      userId: user.$id,
      projectId: project.$id,
      deviceId: cleanText(payload.deviceId, 128),
      operation: cleanText(payload.operation || 'sync', 64),
      status,
      commitHash: cleanText(payload.commitHash, 64),
      branch: cleanText(payload.branch || project.defaultBranch || DEFAULT_BRANCH, 64),
      message: cleanText(payload.message, 1024),
      createdAt: now,
    },
    userEventPermissions(user.$id),
  );

  if (status === 'success') {
    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_CLOUD_PROJECTS_COLLECTION_ID, project.$id, {
      lastSyncedAt: now,
      updatedAt: now,
    }, userDocumentPermissions(user.$id)).catch(() => {});
  }

  return ok(res, { event });
}

function errorResponse(caughtError) {
  const rawMessage = caughtError instanceof Error ? caughtError.message : 'Unexpected project-sync failure.';
  const statusCode = Number(caughtError?.statusCode || caughtError?.code || 0);
  if (statusCode === 401 || /jwt|unauthorized|missing.*user/i.test(rawMessage)) {
    return { status: 401, error: 'Sign in again, then retry.' };
  }

  if (statusCode === 404) {
    return { status: 404, error: rawMessage };
  }

  return {
    status: statusCode >= 400 && statusCode < 600 ? statusCode : 500,
    error: statusCode >= 500 ? 'Project sync failed. Try again.' : rawMessage,
  };
}

export default async function ({ req, res, error }) {
  try {
    if (req.path === '/health' || req.path === '/warm') {
      return ok(res, {
        service: 'project-sync',
        status: 'ok',
        configured: serviceConfigured(),
        giteaBaseUrl: giteaBaseUrl(),
        giteaOrg: GITEA_ORG,
        timestamp: new Date().toISOString(),
      });
    }

    if (req.path === '/projects/create') {
      return await createProject(req, res);
    }
    if (req.path === '/projects/list') {
      return await listProjects(req, res);
    }
    if (req.path === '/projects/link-device') {
      return await linkDevice(req, res);
    }
    if (req.path === '/projects/revoke-device') {
      return await revokeDevice(req, res);
    }
    if (req.path === '/projects/delete') {
      return await deleteProject(req, res);
    }
    if (req.path === '/projects/sync-event') {
      return await recordSyncEvent(req, res);
    }

    return fail(res, 404, `Unknown project sync path: ${req.path}`);
  } catch (caughtError) {
    const response = errorResponse(caughtError);
    error(response.error);
    return fail(res, response.status, response.error, caughtError?.details);
  }
}

import crypto from 'node:crypto';

import { Account, Client, Databases, Users } from 'node-appwrite';

const {
  APPWRITE_FUNCTION_API_ENDPOINT,
  APPWRITE_FUNCTION_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  APPWRITE_DESKTOP_AUTH_GRANTS_COLLECTION_ID = 'desktop_auth_grants',
  TANTALUM_DESKTOP_AUTH_GRANT_TTL_SECONDS = '180',
  TANTALUM_DESKTOP_AUTH_TOKEN_TTL_SECONDS = '120',
  TANTALUM_DESKTOP_CALLBACK_SCHEME = 'tantalum',
} = process.env;

const GRANT_TTL_MS = Math.max(30, Number.parseInt(TANTALUM_DESKTOP_AUTH_GRANT_TTL_SECONDS, 10) || 180) * 1000;
const TOKEN_TTL_SECONDS = Math.max(30, Number.parseInt(TANTALUM_DESKTOP_AUTH_TOKEN_TTL_SECONDS, 10) || 120);
const BASE64URL_RE = /^[A-Za-z0-9_-]{16,256}$/;

function json(res, status, payload) {
  return res.json(payload, status);
}

function ok(res, data, status = 200) {
  return json(res, status, { ok: true, data });
}

function fail(res, status, error) {
  return json(res, status, { ok: false, error });
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

async function resolveUser(req) {
  const account = new Account(createUserClient(requestUserJwt(req)));
  return account.get();
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

function generateGrantId() {
  return `dg_${crypto.randomBytes(18).toString('hex')}`;
}

function normalizeScheme(value) {
  const scheme = String(value || TANTALUM_DESKTOP_CALLBACK_SCHEME || 'tantalum').trim().toLowerCase();
  return /^[a-z][a-z0-9+.-]{1,31}$/.test(scheme) ? scheme : 'tantalum';
}

function validateGrantInput(payload) {
  const state = String(payload.state || '').trim();
  const codeChallenge = String(payload.codeChallenge || '').trim();

  if (!BASE64URL_RE.test(state)) {
    throw Object.assign(new Error('Invalid desktop login state.'), { statusCode: 400 });
  }

  if (!BASE64URL_RE.test(codeChallenge)) {
    throw Object.assign(new Error('Invalid desktop login challenge.'), { statusCode: 400 });
  }

  return {
    state,
    codeChallenge,
    callbackScheme: normalizeScheme(payload.callbackScheme),
  };
}

async function createGrant(req, res) {
  if (!APPWRITE_DATABASE_ID || !APPWRITE_DESKTOP_AUTH_GRANTS_COLLECTION_ID) {
    return fail(res, 500, 'Desktop auth storage is not configured.');
  }

  const user = await resolveUser(req);
  if (!user.emailVerification) {
    return fail(res, 403, 'Verify your email address before signing in to the desktop app.');
  }

  const payload = validateGrantInput(readPayload(req));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString();
  const grantId = generateGrantId();
  const databases = new Databases(createAdminClient(req));

  await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_DESKTOP_AUTH_GRANTS_COLLECTION_ID, grantId, {
    userId: user.$id,
    stateHash: sha256Base64Url(payload.state),
    codeChallenge: payload.codeChallenge,
    callbackScheme: payload.callbackScheme,
    expiresAt,
    consumedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }, []);

  return ok(res, {
    grantId,
    expiresAt,
    callbackUrl: `${payload.callbackScheme}://auth/callback?grant=${encodeURIComponent(grantId)}&state=${encodeURIComponent(payload.state)}`,
  }, 201);
}

function validateExchangeInput(payload) {
  const grantId = String(payload.grantId || payload.grant || '').trim();
  const state = String(payload.state || '').trim();
  const codeVerifier = String(payload.codeVerifier || '').trim();

  if (!/^dg_[a-f0-9]{36}$/.test(grantId)) {
    throw Object.assign(new Error('Invalid desktop login grant.'), { statusCode: 400 });
  }

  if (!BASE64URL_RE.test(state) || !BASE64URL_RE.test(codeVerifier)) {
    throw Object.assign(new Error('Invalid desktop login proof.'), { statusCode: 400 });
  }

  return { grantId, state, codeVerifier };
}

async function exchangeGrant(req, res) {
  if (!APPWRITE_DATABASE_ID || !APPWRITE_DESKTOP_AUTH_GRANTS_COLLECTION_ID) {
    return fail(res, 500, 'Desktop auth storage is not configured.');
  }

  const payload = validateExchangeInput(readPayload(req));
  const adminClient = createAdminClient(req);
  const databases = new Databases(adminClient);
  const users = new Users(adminClient);
  const grant = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_DESKTOP_AUTH_GRANTS_COLLECTION_ID, payload.grantId);
  const now = new Date();

  if (grant.consumedAt) {
    return fail(res, 409, 'This desktop login grant has already been used.');
  }

  if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return fail(res, 410, 'This desktop login grant has expired.');
  }

  if (grant.stateHash !== sha256Base64Url(payload.state)) {
    return fail(res, 400, 'Desktop login state did not match.');
  }

  if (grant.codeChallenge !== sha256Base64Url(payload.codeVerifier)) {
    return fail(res, 400, 'Desktop login proof did not match.');
  }

  const user = await users.get(grant.userId);
  if (!user.emailVerification) {
    return fail(res, 403, 'Verify your email address before signing in to the desktop app.');
  }

  const token = await users.createToken(user.$id, 64, TOKEN_TTL_SECONDS);
  if (!token?.secret) {
    return fail(res, 500, 'Unable to create desktop login token.');
  }

  await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_DESKTOP_AUTH_GRANTS_COLLECTION_ID, grant.$id, {
    consumedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  return ok(res, {
    userId: user.$id,
    secret: token.secret,
    expiresAt: token.expire || null,
  });
}

function errorResponse(caughtError) {
  const rawMessage = caughtError instanceof Error ? caughtError.message : 'Unexpected desktop auth failure.';
  const statusCode = Number(caughtError?.statusCode || caughtError?.code || 0);
  return {
    status: statusCode >= 400 && statusCode < 600 ? statusCode : 500,
    error: statusCode >= 500 ? 'Desktop login failed. Try again.' : rawMessage,
  };
}

export default async function ({ req, res, error }) {
  try {
    if (req.path === '/health' || req.path === '/warm') {
      return ok(res, { service: 'desktop-auth', status: 'ok', timestamp: new Date().toISOString() });
    }

    if (req.path === '/grant') {
      return await createGrant(req, res);
    }

    if (req.path === '/exchange') {
      return await exchangeGrant(req, res);
    }

    return fail(res, 404, `Unknown desktop auth path: ${req.path}`);
  } catch (caughtError) {
    const response = errorResponse(caughtError);
    error(response.error);
    return fail(res, response.status, response.error);
  }
}

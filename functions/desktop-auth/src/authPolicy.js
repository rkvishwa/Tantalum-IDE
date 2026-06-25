import crypto from 'node:crypto';

const {
  TANTALUM_DESKTOP_CALLBACK_SCHEME = 'tantalum',
  TANTALUM_ALLOWED_AUTH_CALLBACK_SCHEMES = `${TANTALUM_DESKTOP_CALLBACK_SCHEME || 'tantalum'},tantalum-mobile`,
} = process.env;

const BASE64URL_RE = /^[A-Za-z0-9_-]{16,256}$/;
const CALLBACK_SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}$/;

export const ALLOWED_CALLBACK_SCHEMES = new Set(
  String(TANTALUM_ALLOWED_AUTH_CALLBACK_SCHEMES || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

export function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

export function normalizeScheme(value) {
  const scheme = String(value || TANTALUM_DESKTOP_CALLBACK_SCHEME || 'tantalum').trim().toLowerCase();
  if (!CALLBACK_SCHEME_RE.test(scheme)) {
    throw Object.assign(new Error('Invalid app login callback scheme.'), { statusCode: 400 });
  }
  if (!ALLOWED_CALLBACK_SCHEMES.has(scheme)) {
    throw Object.assign(new Error('This app login callback scheme is not allowed.'), { statusCode: 400 });
  }
  return scheme;
}

export function validateGrantInput(payload) {
  const state = String(payload.state || '').trim();
  const codeChallenge = String(payload.codeChallenge || '').trim();

  if (!BASE64URL_RE.test(state)) {
    throw Object.assign(new Error('Invalid app login state.'), { statusCode: 400 });
  }

  if (!BASE64URL_RE.test(codeChallenge)) {
    throw Object.assign(new Error('Invalid app login challenge.'), { statusCode: 400 });
  }

  return {
    state,
    codeChallenge,
    callbackScheme: normalizeScheme(payload.callbackScheme),
  };
}

export function validateExchangeInput(payload) {
  const grantId = String(payload.grantId || payload.grant || '').trim();
  const state = String(payload.state || '').trim();
  const codeVerifier = String(payload.codeVerifier || '').trim();

  if (!/^dg_[a-f0-9]{36}$/.test(grantId)) {
    throw Object.assign(new Error('Invalid app login grant.'), { statusCode: 400 });
  }

  if (!BASE64URL_RE.test(state) || !BASE64URL_RE.test(codeVerifier)) {
    throw Object.assign(new Error('Invalid app login proof.'), { statusCode: 400 });
  }

  return { grantId, state, codeVerifier };
}

export const _test = {
  ALLOWED_CALLBACK_SCHEMES,
  normalizeScheme,
  validateExchangeInput,
  validateGrantInput,
  sha256Base64Url,
};

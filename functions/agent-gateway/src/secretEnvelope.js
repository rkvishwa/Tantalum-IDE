import crypto from 'node:crypto';

export const LEGACY_RAW_KEY_SENTINEL = '__TANTALUM_SECRET_ENVELOPE__';

const ENVELOPE_VERSION = 1;
const ENVELOPE_ALGORITHM = 'AES-256-GCM';
const NODE_CIPHER = 'aes-256-gcm';
const DEFAULT_KEK_VERSION = 'v1';
const KEK_BYTES = 32;

function normalizeKekVersion(value) {
  const version = String(value || DEFAULT_KEK_VERSION).trim();
  if (!/^[A-Za-z0-9_]+$/.test(version)) {
    throw new Error('Secret KEK version contains unsupported characters.');
  }
  return version;
}

function readKek(version, env = process.env) {
  const normalizedVersion = normalizeKekVersion(version);
  const envName = `TANTALUM_SECRET_KEK_${normalizedVersion.toUpperCase()}`;
  const encoded = String(env[envName] || '').trim();
  if (!encoded) {
    throw new Error(`${envName} is required to encrypt or decrypt API keys.`);
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`${envName} must be a base64-encoded 32-byte key.`);
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEK_BYTES) {
    throw new Error(`${envName} must decode to exactly 32 bytes.`);
  }

  return key;
}

function activeKekVersion(env = process.env) {
  return normalizeKekVersion(env.TANTALUM_SECRET_ACTIVE_KEK_VERSION || DEFAULT_KEK_VERSION);
}

export function encryptSecret(plaintext, env = process.env) {
  const secret = String(plaintext || '').trim();
  if (!secret) {
    throw new Error('Cannot encrypt an empty API key.');
  }

  const kekVersion = activeKekVersion(env);
  const key = readKek(kekVersion, env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(NODE_CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    kekVersion,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

export function decryptSecretEnvelope(envelope, env = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(String(envelope || ''));
  } catch {
    throw new Error('Stored API key envelope is not valid JSON.');
  }

  if (parsed.version !== ENVELOPE_VERSION || parsed.algorithm !== ENVELOPE_ALGORITHM) {
    throw new Error('Stored API key envelope uses an unsupported format.');
  }

  const key = readKek(parsed.kekVersion, env);
  const iv = Buffer.from(String(parsed.iv || ''), 'base64');
  const authTag = Buffer.from(String(parsed.authTag || ''), 'base64');
  const ciphertext = Buffer.from(String(parsed.ciphertext || ''), 'base64');

  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Stored API key envelope is incomplete.');
  }

  try {
    const decipher = crypto.createDecipheriv(NODE_CIPHER, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored API key envelope could not be decrypted.');
  }
}

export function allowLegacyRawKeys(env = process.env) {
  return String(env.TANTALUM_ALLOW_LEGACY_RAW_KEYS || '').trim().toLowerCase() === 'true';
}

export function isLegacyRawSecret(value) {
  const secret = String(value || '').trim();
  return Boolean(secret && secret !== LEGACY_RAW_KEY_SENTINEL);
}

export function resolveStoredApiKey(document, label = 'Provider', env = process.env) {
  const envelope = String(document?.apiKeyEnvelope || '').trim();
  if (envelope) {
    return decryptSecretEnvelope(envelope, env);
  }

  if (allowLegacyRawKeys(env) && isLegacyRawSecret(document?.apiKey)) {
    return String(document.apiKey).trim();
  }

  throw new Error(`${label} API key is not configured with an encrypted envelope.`);
}

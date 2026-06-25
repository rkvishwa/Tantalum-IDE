import crypto from 'node:crypto';

export const LEGACY_RAW_KEY_SENTINEL = '__TANTALUM_SECRET_ENVELOPE__';

function activeVersion(env = process.env) {
  return String(env.TANTALUM_SECRET_ACTIVE_KEK_VERSION || 'v1').trim() || 'v1';
}

function readKek(version = activeVersion(), env = process.env) {
  const value = env[`TANTALUM_SECRET_KEK_${String(version).toUpperCase()}`] || env.TANTALUM_SECRET_KEK_V1 || '';
  const key = Buffer.from(String(value).trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`TANTALUM_SECRET_KEK_${String(version).toUpperCase()} must be a 32-byte base64 value.`);
  }
  return key;
}

export function encryptSecret(secret, env = process.env) {
  const cleanSecret = String(secret || '').trim();
  if (!cleanSecret) {
    throw new Error('Secret value is required.');
  }

  const version = activeVersion(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', readKek(version, env), iv);
  const ciphertext = Buffer.concat([cipher.update(cleanSecret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    version,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

export function decryptSecretEnvelope(envelope, env = process.env) {
  if (!envelope) {
    return '';
  }

  const parsed = JSON.parse(envelope);
  const version = parsed.version || 'v1';
  const decipher = crypto.createDecipheriv('aes-256-gcm', readKek(version, env), Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function resolveStoredApiKey(document, label = 'API key', env = process.env) {
  if (document?.apiKeyEnvelope) {
    return decryptSecretEnvelope(document.apiKeyEnvelope, env);
  }

  if (document?.apiKey && document.apiKey !== LEGACY_RAW_KEY_SENTINEL) {
    return String(document.apiKey);
  }

  throw new Error(`${label} is not configured.`);
}

export function redactSecret(value) {
  const secret = String(value || '').trim();
  if (!secret) {
    return '';
  }

  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  LEGACY_RAW_KEY_SENTINEL,
  decryptSecretEnvelope,
  encryptSecret,
  resolveStoredApiKey,
} from '../functions/agent-settings/src/secretEnvelope.js';

const env = {
  TANTALUM_SECRET_ACTIVE_KEK_VERSION: 'v1',
  TANTALUM_SECRET_KEK_V1: crypto.randomBytes(32).toString('base64'),
};

const plaintext = 'sk-test-secret-value';
const envelope = encryptSecret(plaintext, env);

assert.doesNotMatch(envelope, /sk-test-secret-value/);
assert.equal(decryptSecretEnvelope(envelope, env), plaintext);
assert.equal(resolveStoredApiKey({ apiKeyEnvelope: envelope }, 'Smoke test', env), plaintext);
assert.equal(
  resolveStoredApiKey({ apiKey: 'sk-legacy-value' }, 'Smoke test', {
    ...env,
    TANTALUM_ALLOW_LEGACY_RAW_KEYS: 'true',
  }),
  'sk-legacy-value',
);
assert.throws(() => resolveStoredApiKey({ apiKey: 'sk-legacy-value' }, 'Smoke test', env), /encrypted envelope/);
assert.throws(() => resolveStoredApiKey({ apiKey: LEGACY_RAW_KEY_SENTINEL }, 'Smoke test', env), /encrypted envelope/);
assert.throws(
  () =>
    decryptSecretEnvelope(envelope, {
      ...env,
      TANTALUM_SECRET_KEK_V1: crypto.randomBytes(32).toString('base64'),
    }),
  /could not be decrypted/,
);

console.log('Secret envelope smoke test passed.');

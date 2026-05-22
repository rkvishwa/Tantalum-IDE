#!/usr/bin/env node
import {
  LEGACY_RAW_KEY_SENTINEL,
  encryptSecret,
} from '../functions/agent-settings/src/secretEnvelope.js';

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`
Usage:
  TANTALUM_PLAINTEXT_API_KEY=... TANTALUM_SECRET_KEK_V1=... node scripts/encrypt-api-key-envelope.mjs

Required environment:
  TANTALUM_PLAINTEXT_API_KEY        Raw provider key to encrypt.
  TANTALUM_SECRET_KEK_V1            Base64-encoded 32-byte key-encryption key.

Optional environment:
  TANTALUM_SECRET_ACTIVE_KEK_VERSION Defaults to v1.

The raw key is never printed. The output fields can be pasted into managed key or board detection documents.
`);
  process.exit(0);
}

function redactSecret(value) {
  const secret = String(value || '').trim();
  if (secret.length <= 4) {
    return secret ? '****' : '';
  }

  return `****${secret.slice(-4)}`;
}

const plaintext = String(process.env.TANTALUM_PLAINTEXT_API_KEY || '').trim();
if (!plaintext) {
  throw new Error('TANTALUM_PLAINTEXT_API_KEY is required.');
}

const output = {
  apiKey: LEGACY_RAW_KEY_SENTINEL,
  apiKeyEnvelope: encryptSecret(plaintext),
  apiKeyPreview: redactSecret(plaintext),
};

console.log(JSON.stringify(output, null, 2));

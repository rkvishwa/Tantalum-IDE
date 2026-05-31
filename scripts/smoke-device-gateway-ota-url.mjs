#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildDownloadUrl,
  resolveOtaDownloadEndpoint,
} from '../functions/device-gateway/src/otaDownloadUrl.js';

const baseEnv = {
  APPWRITE_FUNCTION_PROJECT_ID: 'tantalum project',
  APPWRITE_FIRMWARE_BUCKET_ID: 'firmware bucket',
};

{
  const env = {
    ...baseEnv,
    APPWRITE_FUNCTION_API_ENDPOINT: 'http://appwrite-internal/v1',
    TANTALUM_APPWRITE_PUBLIC_ENDPOINT: 'https://api.metl.run/v1/',
  };

  assert.equal(resolveOtaDownloadEndpoint(env), 'https://api.metl.run/v1');
  assert.equal(
    buildDownloadUrl('firmware file/one.bin', env),
    'https://api.metl.run/v1/storage/buckets/firmware%20bucket/files/firmware%20file%2Fone.bin/download?project=tantalum%20project',
  );
}

{
  const env = {
    ...baseEnv,
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://cloud.appwrite.example/v1',
  };

  assert.equal(resolveOtaDownloadEndpoint(env), 'https://cloud.appwrite.example/v1');
  assert.equal(
    buildDownloadUrl('firmware.bin', env),
    'https://cloud.appwrite.example/v1/storage/buckets/firmware%20bucket/files/firmware.bin/download?project=tantalum%20project',
  );
}

assert.throws(
  () => buildDownloadUrl('firmware.bin', {
    ...baseEnv,
    APPWRITE_FUNCTION_API_ENDPOINT: 'http://appwrite-internal/v1',
  }),
  /TANTALUM_APPWRITE_PUBLIC_ENDPOINT/,
);

assert.throws(
  () => resolveOtaDownloadEndpoint({
    ...baseEnv,
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://cloud.appwrite.example/v1',
    TANTALUM_APPWRITE_PUBLIC_ENDPOINT: 'http://api.metl.run/v1',
  }),
  /TANTALUM_APPWRITE_PUBLIC_ENDPOINT must be a valid HTTPS Appwrite endpoint/,
);

console.log('device-gateway OTA URL smoke test passed.');

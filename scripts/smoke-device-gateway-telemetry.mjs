#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTelemetryUpdates,
  hasPendingDesiredFirmware,
  shouldOfferUpdate,
} from '../functions/device-gateway/src/telemetry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = '2026-05-31T18:30:00.000Z';

{
  const updates = buildTelemetryUpdates(
    { otaStatus: 'pending' },
    { currentVersion: '0.0.2', runtimeVersion: '1.1.5' },
    now,
  );

  assert.equal(updates.firmwareVersion, '0.0.2');
  assert.equal(updates.runtimeVersion, '1.1.5');
  assert.equal(updates.status, 'online');
  assert.equal(updates.lastSeen, now);
}

{
  const updates = buildTelemetryUpdates(
    { otaStatus: 'pending' },
    { currentVersion: '0.0.2' },
    now,
    { includeLastUpdateCheckAt: true },
  );

  assert.equal(updates.lastUpdateCheckAt, now);
}

{
  const board = {
    desiredFirmwareId: 'fw_target',
    desiredDeploymentId: 'dep_target',
    desiredVersion: '0.0.3',
    otaStatus: 'pending',
    lastAppliedDeploymentId: 'dep_previous',
  };
  const firmware = {
    $id: 'fw_target',
    version: '0.0.3',
    size: 42,
    checksum: 'abc123',
    fileId: 'fw_target',
  };
  const payload = {
    currentVersion: '0.0.2',
    firmwareId: 'fw_previous',
  };

  assert.equal(hasPendingDesiredFirmware(board, payload), true);
  assert.equal(shouldOfferUpdate(board, firmware, payload), true);
}

{
  const board = {
    desiredFirmwareId: 'fw_target',
    desiredDeploymentId: 'dep_failed',
    desiredVersion: '0.0.3',
    otaStatus: 'failed',
  };
  const firmware = {
    $id: 'fw_target',
    version: '0.0.3',
    fileId: 'fw_target',
  };
  const payload = {
    currentVersion: '0.0.2',
    firmwareId: 'fw_previous',
  };

  assert.equal(hasPendingDesiredFirmware(board, payload), false);
  assert.equal(shouldOfferUpdate(board, firmware, payload), false);
}

{
  const board = {
    desiredFirmwareId: 'fw_target',
    desiredDeploymentId: 'dep_fresh',
    desiredVersion: '0.0.3',
    otaStatus: 'pending',
  };
  const firmware = {
    $id: 'fw_target',
    version: '0.0.3',
    fileId: 'fw_target',
  };
  const payload = {
    currentVersion: '0.0.2',
    firmwareId: 'fw_previous',
  };

  assert.equal(shouldOfferUpdate(board, firmware, payload), true);
}

{
  const updates = buildTelemetryUpdates(
    {
      desiredFirmwareId: 'fw_expected',
      desiredDeploymentId: 'dep_applied',
      desiredVersion: '0.0.3',
      lastAppliedDeploymentId: 'dep_applied',
      otaStatus: 'success',
    },
    {
      currentVersion: '0.0.2',
      firmwareId: 'fw_previous',
    },
    now,
  );

  assert.equal(updates.firmwareVersion, '0.0.2');
  assert.equal(updates.otaStatus, 'failed');
  assert.equal(updates.lastAppliedDeploymentId, '');
  assert.match(updates.lastOtaError, /OTA success could not be verified/);
  assert.match(updates.lastOtaError, /fw_previous version 0\.0\.2/);
  assert.match(updates.lastOtaError, /fw_expected version 0\.0\.3/);
}

{
  const updates = buildTelemetryUpdates(
    {
      desiredFirmwareId: 'fw_expected',
      desiredDeploymentId: 'dep_applied',
      desiredVersion: '0.0.3',
      lastAppliedDeploymentId: 'dep_applied',
      otaStatus: 'success',
    },
    {
      currentVersion: '0.0.3',
      firmwareId: 'fw_expected',
    },
    now,
  );

  assert.equal(updates.firmwareVersion, '0.0.3');
  assert.equal(updates.otaStatus, undefined);
  assert.equal(updates.lastAppliedDeploymentId, undefined);
  assert.equal(updates.lastOtaError, undefined);
}

const activeTelemetry = fs.readFileSync(path.join(repoRoot, 'functions/device-gateway/src/telemetry.js'), 'utf8');
const legacyTelemetry = fs.readFileSync(path.join(repoRoot, 'appwrite/functions/device-gateway/src/telemetry.js'), 'utf8');
assert.equal(legacyTelemetry, activeTelemetry);

console.log('device-gateway telemetry smoke test passed.');

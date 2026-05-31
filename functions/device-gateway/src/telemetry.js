function normalizeDeviceField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function compareVersions(left, right) {
  const leftParts = String(left || '0.0.0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || '0.0.0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

export function hasPendingDesiredFirmware(board, payload) {
  if (!board.desiredFirmwareId) {
    return false;
  }

  const deploymentId = board.desiredDeploymentId || board.desiredFirmwareId;
  if (deploymentId && (payload.lastAppliedDeploymentId === deploymentId || board.lastAppliedDeploymentId === deploymentId)) {
    return false;
  }

  if (deploymentId && board.otaStatus === 'failed') {
    return false;
  }

  return payload.firmwareId !== board.desiredFirmwareId || Boolean(deploymentId);
}

export function shouldOfferUpdate(board, firmware, payload) {
  if (!firmware) {
    return false;
  }

  const deploymentId = board.desiredDeploymentId || firmware.$id;
  if (deploymentId && (payload.lastAppliedDeploymentId === deploymentId || board.lastAppliedDeploymentId === deploymentId)) {
    return false;
  }

  if (deploymentId && board.desiredDeploymentId === deploymentId && board.otaStatus === 'failed') {
    return false;
  }

  if (payload.firmwareId && payload.firmwareId === firmware.$id && compareVersions(firmware.version, payload.currentVersion) <= 0) {
    return false;
  }

  return compareVersions(firmware.version, payload.currentVersion) > 0 || payload.firmwareId !== firmware.$id;
}

function appliedDeploymentMismatch(board, payload) {
  if (board.otaStatus !== 'success') {
    return null;
  }

  const lastAppliedDeploymentId = normalizeDeviceField(board.lastAppliedDeploymentId);
  if (!lastAppliedDeploymentId) {
    return null;
  }

  const desiredDeploymentId = normalizeDeviceField(board.desiredDeploymentId);
  if (desiredDeploymentId && lastAppliedDeploymentId !== desiredDeploymentId) {
    return null;
  }

  const expectedVersion = normalizeDeviceField(board.desiredVersion);
  const expectedFirmwareId = normalizeDeviceField(board.desiredFirmwareId);
  const reportedVersion = normalizeDeviceField(payload.currentVersion);
  const reportedFirmwareId = normalizeDeviceField(payload.firmwareId);
  const versionMismatch = Boolean(expectedVersion && reportedVersion && expectedVersion !== reportedVersion);
  const firmwareMismatch = Boolean(expectedFirmwareId && reportedFirmwareId && expectedFirmwareId !== reportedFirmwareId);

  if (!versionMismatch && !firmwareMismatch) {
    return null;
  }

  return {
    expectedVersion,
    expectedFirmwareId,
    reportedVersion,
    reportedFirmwareId,
  };
}

export function buildTelemetryUpdates(board, payload, now, options = {}) {
  const updates = {
    status: 'online',
    lastSeen: now,
    updatedAt: now,
  };

  if (options.includeLastUpdateCheckAt) {
    updates.lastUpdateCheckAt = now;
  }

  const runtimeVersion = normalizeDeviceField(payload.runtimeVersion);
  if (runtimeVersion) {
    updates.runtimeVersion = runtimeVersion;
  }

  const currentVersion = normalizeDeviceField(payload.currentVersion);
  if (currentVersion) {
    updates.firmwareVersion = currentVersion;
  }

  const mismatch = appliedDeploymentMismatch(board, payload);
  if (mismatch) {
    updates.otaStatus = 'failed';
    updates.lastAppliedDeploymentId = '';
    updates.lastOtaError = [
      'OTA success could not be verified.',
      `Device reported firmware ${mismatch.reportedFirmwareId || 'unknown'} version ${mismatch.reportedVersion || 'unknown'}.`,
      `Cloud expected firmware ${mismatch.expectedFirmwareId || 'unknown'} version ${mismatch.expectedVersion || 'unknown'}.`,
    ].join(' ');
  }

  return updates;
}

const fs = require('node:fs');
const path = require('node:path');
const appwriteManifest = require('../../appwrite.config.json');

function parseEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const values = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const separator = line.indexOf('=');
      if (separator <= 0) {
        continue;
      }

      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeEnv = {
  ...parseEnvFile(path.join(repoRoot, '.env')),
  ...parseEnvFile(path.join(repoRoot, 'renderer-react', '.env')),
  ...process.env,
};

function readRuntimeValue(...keys) {
  for (const key of keys) {
    const value = runtimeEnv[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function normalizePemLiteral(value) {
  return String(value || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n');
}

function deriveCollections(config) {
  if (config.collections && typeof config.collections === 'object') {
    return config.collections;
  }

  const tables = Array.isArray(config.tables) ? config.tables : [];
  return {
    boards: tables.find((table) => table.$id === 'boards')?.$id || 'boards',
    firmwares: tables.find((table) => table.$id === 'firmwares')?.$id || 'firmwares',
    sketches: tables.find((table) => table.$id === 'sketches')?.$id || 'sketches',
    boardSourceSnapshots: tables.find((table) => table.$id === 'board_source_snapshots')?.$id || 'board_source_snapshots',
    agentAsyncReadResults: tables.find((table) => table.$id === 'agent_async_read_results')?.$id || 'agent_async_read_results',
    supportTickets: tables.find((table) => table.$id === 'support_tickets')?.$id || 'support_tickets',
    cloudProjects: tables.find((table) => table.$id === 'cloud_projects')?.$id || 'cloud_projects',
    cloudProjectDevices: tables.find((table) => table.$id === 'cloud_project_devices')?.$id || 'cloud_project_devices',
    cloudProjectSyncEvents: tables.find((table) => table.$id === 'cloud_project_sync_events')?.$id || 'cloud_project_sync_events',
  };
}

function deriveDatabaseId(config) {
  if (typeof config.databaseId === 'string' && config.databaseId.length > 0) {
    return config.databaseId;
  }

  const tablesDb = Array.isArray(config.tablesDB) ? config.tablesDB : [];
  return tablesDb[0]?.$id || '';
}

function deriveFirmwareBucketId(config) {
  if (typeof config.firmwareBucketId === 'string' && config.firmwareBucketId.length > 0) {
    return config.firmwareBucketId;
  }

  const buckets = Array.isArray(config.buckets) ? config.buckets : [];
  return buckets.find((bucket) => bucket.$id === 'firmware_bucket')?.$id || buckets[0]?.$id || '';
}

function deriveFirmwareSourceBucketId(config) {
  if (typeof config.firmwareSourceBucketId === 'string' && config.firmwareSourceBucketId.length > 0) {
    return config.firmwareSourceBucketId;
  }

  const buckets = Array.isArray(config.buckets) ? config.buckets : [];
  return buckets.find((bucket) => bucket.$id === 'firmware_source_bucket')?.$id || '';
}

function deriveFunctionId(config, preferredId) {
  const functions = Array.isArray(config.functions) ? config.functions : [];
  const match = functions.find((entry) => entry?.$id === preferredId || entry?.name === preferredId);
  return match?.$id || '';
}

function getRendererCloudConfig() {
  const collections = deriveCollections(appwriteManifest);
  const webAppUrl = readRuntimeValue('TANTALUM_WEB_APP_URL', 'VITE_TANTALUM_WEB_APP_URL') || appwriteManifest.webAppUrl || 'https://tantalum.knurdz.org';

  return {
    endpoint: String(appwriteManifest.endpoint || '').trim(),
    projectId: String(appwriteManifest.projectId || '').trim(),
    databaseId: deriveDatabaseId(appwriteManifest),
    boardsCollectionId: String(collections.boards || '').trim(),
    firmwareCollectionId: String(collections.firmwares || '').trim(),
    sketchesCollectionId: String(collections.sketches || '').trim(),
    sourceSnapshotsCollectionId: String(collections.boardSourceSnapshots || '').trim(),
    agentAsyncReadResultsCollectionId: String(collections.agentAsyncReadResults || 'agent_async_read_results').trim(),
    supportTicketsCollectionId: String(collections.supportTickets || 'support_tickets').trim(),
    cloudProjectsCollectionId: String(collections.cloudProjects || 'cloud_projects').trim(),
    cloudProjectDevicesCollectionId: String(collections.cloudProjectDevices || 'cloud_project_devices').trim(),
    cloudProjectSyncEventsCollectionId: String(collections.cloudProjectSyncEvents || 'cloud_project_sync_events').trim(),
    firmwareBucketId: deriveFirmwareBucketId(appwriteManifest),
    firmwareSourceBucketId: deriveFirmwareSourceBucketId(appwriteManifest),
    boardAdminFunctionId: deriveFunctionId(appwriteManifest, 'board-admin'),
    deviceGatewayFunctionId: deriveFunctionId(appwriteManifest, 'device-gateway'),
    agentSettingsFunctionId: deriveFunctionId(appwriteManifest, 'agent-settings'),
    agentGatewayFunctionId: deriveFunctionId(appwriteManifest, 'agent-gateway'),
    boardDetectionFunctionId: deriveFunctionId(appwriteManifest, 'board-detection'),
    desktopAuthFunctionId: deriveFunctionId(appwriteManifest, 'desktop-auth'),
    webAdminFunctionId: deriveFunctionId(appwriteManifest, 'web-admin'),
    projectSyncFunctionId: deriveFunctionId(appwriteManifest, 'project-sync'),
    webAppUrl: String(webAppUrl || '').trim().replace(/\/+$/, ''),
    desktopCallbackScheme: readRuntimeValue('TANTALUM_DESKTOP_CALLBACK_SCHEME', 'VITE_TANTALUM_DESKTOP_CALLBACK_SCHEME') || 'tantalum',
    mqttHost: readRuntimeValue('TANTALUM_MQTT_HOST', 'VITE_TANTALUM_MQTT_HOST') || appwriteManifest.mqttHost || '',
    mqttPort: readRuntimeValue('TANTALUM_MQTT_PORT', 'VITE_TANTALUM_MQTT_PORT') || appwriteManifest.mqttPort || '',
    mqttUsername: readRuntimeValue('TANTALUM_MQTT_DEVICE_USERNAME', 'VITE_TANTALUM_MQTT_DEVICE_USERNAME'),
    mqttPassword: readRuntimeValue('TANTALUM_MQTT_DEVICE_PASSWORD', 'VITE_TANTALUM_MQTT_DEVICE_PASSWORD'),
    mqttCaCert: normalizePemLiteral(readRuntimeValue('TANTALUM_MQTT_CA_CERT', 'VITE_TANTALUM_MQTT_CA_CERT')),
    tlsCaCert: normalizePemLiteral(readRuntimeValue('TANTALUM_TLS_CA_CERT', 'VITE_TANTALUM_TLS_CA_CERT')),
  };
}

module.exports = {
  deriveCollections,
  deriveDatabaseId,
  deriveFirmwareBucketId,
  deriveFirmwareSourceBucketId,
  deriveFunctionId,
  getRendererCloudConfig,
};

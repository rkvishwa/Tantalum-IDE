const appwriteManifest = require('../../appwrite.config.json');

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

  return {
    endpoint: String(appwriteManifest.endpoint || '').trim(),
    projectId: String(appwriteManifest.projectId || '').trim(),
    databaseId: deriveDatabaseId(appwriteManifest),
    boardsCollectionId: String(collections.boards || '').trim(),
    firmwareCollectionId: String(collections.firmwares || '').trim(),
    sketchesCollectionId: String(collections.sketches || '').trim(),
    sourceSnapshotsCollectionId: String(collections.boardSourceSnapshots || '').trim(),
    agentAsyncReadResultsCollectionId: String(collections.agentAsyncReadResults || 'agent_async_read_results').trim(),
    firmwareBucketId: deriveFirmwareBucketId(appwriteManifest),
    firmwareSourceBucketId: deriveFirmwareSourceBucketId(appwriteManifest),
    boardAdminFunctionId: deriveFunctionId(appwriteManifest, 'board-admin'),
    deviceGatewayFunctionId: deriveFunctionId(appwriteManifest, 'device-gateway'),
    agentSettingsFunctionId: deriveFunctionId(appwriteManifest, 'agent-settings'),
    agentGatewayFunctionId: deriveFunctionId(appwriteManifest, 'agent-gateway'),
    boardDetectionFunctionId: deriveFunctionId(appwriteManifest, 'board-detection'),
    mqttHost: process.env.TANTALUM_MQTT_HOST || appwriteManifest.mqttHost || '',
    mqttPort: process.env.TANTALUM_MQTT_PORT || appwriteManifest.mqttPort || '',
    mqttUsername: process.env.TANTALUM_MQTT_DEVICE_USERNAME || '',
    mqttPassword: process.env.TANTALUM_MQTT_DEVICE_PASSWORD || '',
    mqttCaCert: process.env.TANTALUM_MQTT_CA_CERT || '',
    tlsCaCert: process.env.TANTALUM_TLS_CA_CERT || '',
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

import type { CloudConfig } from '@/types/electron';

const env = import.meta.env;
const desktopCloudConfig: Partial<CloudConfig> = (
  window as typeof window & {
    tantalum?: {
      app?: {
        cloudConfig?: Partial<CloudConfig>;
      };
    };
  }
).tantalum?.app?.cloudConfig ?? {};

function readConfig(name: string, fallback = '') {
  const value = env[name as keyof ImportMetaEnv];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export const appwriteConfig = {
  endpoint: readConfig('VITE_APPWRITE_ENDPOINT', desktopCloudConfig.endpoint ?? ''),
  projectId: readConfig('VITE_APPWRITE_PROJECT_ID', desktopCloudConfig.projectId ?? ''),
  databaseId: readConfig('VITE_APPWRITE_DATABASE_ID', desktopCloudConfig.databaseId ?? ''),
  boardsCollectionId: readConfig('VITE_APPWRITE_BOARDS_COLLECTION_ID', desktopCloudConfig.boardsCollectionId ?? ''),
  firmwareCollectionId: readConfig('VITE_APPWRITE_FIRMWARE_COLLECTION_ID', desktopCloudConfig.firmwareCollectionId ?? ''),
  sketchesCollectionId: readConfig('VITE_APPWRITE_SKETCHES_COLLECTION_ID', desktopCloudConfig.sketchesCollectionId ?? ''),
  sourceSnapshotsCollectionId: readConfig('VITE_APPWRITE_SOURCE_SNAPSHOTS_COLLECTION_ID', desktopCloudConfig.sourceSnapshotsCollectionId ?? ''),
  firmwareBucketId: readConfig('VITE_APPWRITE_FIRMWARE_BUCKET_ID', desktopCloudConfig.firmwareBucketId ?? ''),
  firmwareSourceBucketId: readConfig('VITE_APPWRITE_FIRMWARE_SOURCE_BUCKET_ID', desktopCloudConfig.firmwareSourceBucketId ?? ''),
  boardAdminFunctionId: readConfig('VITE_APPWRITE_BOARD_ADMIN_FUNCTION_ID', desktopCloudConfig.boardAdminFunctionId ?? ''),
  deviceGatewayFunctionId: readConfig('VITE_APPWRITE_DEVICE_GATEWAY_FUNCTION_ID', desktopCloudConfig.deviceGatewayFunctionId ?? ''),
  agentSettingsFunctionId: readConfig('VITE_APPWRITE_AGENT_SETTINGS_FUNCTION_ID', desktopCloudConfig.agentSettingsFunctionId ?? ''),
  agentGatewayFunctionId: readConfig('VITE_APPWRITE_AGENT_GATEWAY_FUNCTION_ID', desktopCloudConfig.agentGatewayFunctionId ?? ''),
  boardDetectionFunctionId: readConfig('VITE_APPWRITE_BOARD_DETECTION_FUNCTION_ID', desktopCloudConfig.boardDetectionFunctionId ?? ''),
  mqttHost: readConfig('VITE_TANTALUM_MQTT_HOST', desktopCloudConfig.mqttHost ? String(desktopCloudConfig.mqttHost) : ''),
  mqttPort: readConfig('VITE_TANTALUM_MQTT_PORT', desktopCloudConfig.mqttPort ? String(desktopCloudConfig.mqttPort) : ''),
  mqttUsername: readConfig('VITE_TANTALUM_MQTT_DEVICE_USERNAME', desktopCloudConfig.mqttUsername ?? ''),
  mqttPassword: readConfig('VITE_TANTALUM_MQTT_DEVICE_PASSWORD', desktopCloudConfig.mqttPassword ?? ''),
  mqttCaCert: readConfig('VITE_TANTALUM_MQTT_CA_CERT', desktopCloudConfig.mqttCaCert ?? ''),
  tlsCaCert: readConfig('VITE_TANTALUM_TLS_CA_CERT', desktopCloudConfig.tlsCaCert ?? ''),
};

export function hasRequiredCloudConfiguration() {
  return [
    appwriteConfig.endpoint,
    appwriteConfig.projectId,
    appwriteConfig.databaseId,
    appwriteConfig.boardsCollectionId,
    appwriteConfig.firmwareCollectionId,
    appwriteConfig.firmwareBucketId,
  ].every((value) => value.length > 0);
}

export function hasBoardAdminFunction() {
  return appwriteConfig.boardAdminFunctionId.length > 0;
}

export function hasDeviceGatewayFunction() {
  return appwriteConfig.deviceGatewayFunctionId.length > 0;
}

export function hasAgentSettingsFunction() {
  return appwriteConfig.agentSettingsFunctionId.length > 0;
}

export function hasAgentCloudConfiguration() {
  return [
    appwriteConfig.endpoint,
    appwriteConfig.projectId,
    appwriteConfig.databaseId,
    appwriteConfig.agentSettingsFunctionId,
    appwriteConfig.agentGatewayFunctionId,
  ].every((value) => value.length > 0);
}

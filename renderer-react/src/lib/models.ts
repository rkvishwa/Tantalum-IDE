import type { Models } from 'appwrite';

export type OtaUpdateMode = 'polling' | 'mqtt' | 'both';

export type BoardDocument = Models.Document & {
  userId: string;
  name: string;
  boardType: string;
  apiToken?: string;
  tokenHash: string;
  tokenPreview: string;
  desiredFirmwareId?: string;
  desiredVersion?: string;
  desiredDeploymentId?: string;
  lastAppliedDeploymentId?: string;
  runtimeVersion?: string;
  lastUpdateCheckAt?: string | null;
  otaStatus?: string;
  provisioningStatus?: string;
  provisioningRequestedAt?: string | null;
  provisioningMode?: string;
  provisioningPop?: string;
  mqttTopicSuffix?: string;
  commandSecretEnvelope?: string;
  otaUpdateMode?: OtaUpdateMode | string;
  lastOtaError?: string;
  sourceCodeVisibility?: 'private' | 'public' | string;
  firmwareVersion: string;
  status: string;
  lastSeen: string | null;
  lastProvisionedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FirmwareDocument = Models.Document & {
  userId: string;
  boardId: string;
  version: string;
  fileId: string;
  filename: string;
  size: number;
  checksum: string;
  uploadedAt: string;
  deployed: boolean;
  notes?: string;
  sourceSnapshotFileId?: string;
  sourceSnapshotChecksum?: string;
  sourceSnapshotManifest?: string | null;
  sourceSnapshotCreatedAt?: string;
};

export type BoardInput = {
  name: string;
  boardType: string;
  sourceCodeVisibility?: 'private' | 'public';
  otaUpdateMode?: OtaUpdateMode;
};

export type BoardSecret = {
  apiToken: string;
  commandSecret?: string;
  mqttTopic?: string;
  provisioningPop?: string;
  updatedAt?: string;
};

export type FunctionEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

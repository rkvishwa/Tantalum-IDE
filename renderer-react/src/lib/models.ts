import type { Models } from 'appwrite';

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
  lastOtaError?: string;
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
};

export type BoardInput = {
  name: string;
  boardType: string;
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

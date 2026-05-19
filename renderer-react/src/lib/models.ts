import type { Models } from 'appwrite';

export type BoardDocument = Models.Document & {
  userId: string;
  name: string;
  boardType: string;
  apiToken?: string;
  wifiSSID: string;
  wifiPassword?: string;
  tokenHash: string;
  tokenPreview: string;
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
  wifiSSID: string;
  wifiPassword: string;
};

export type BoardSecret = {
  apiToken: string;
  wifiPassword: string;
  updatedAt?: string;
};

export type FunctionEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

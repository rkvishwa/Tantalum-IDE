import type { Models } from 'appwrite';

import { Permission, Query, Role, databases, storage } from './appwrite';
import { appwriteConfig, hasBoardAdminFunction } from './config';
import { executeFunction } from './functions';
import type { BoardDocument, FirmwareDocument } from './models';
import { base64ToUint8Array, sha256HexBytes } from './utils';

function firmwarePermissions(userId: string) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function firmwareFilePermissions(userId: string) {
  return [
    Permission.read(Role.any()),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function bytesToFirmwareFile(bytes: Uint8Array<ArrayBuffer>, filename: string) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new File([data], filename, { type: 'application/octet-stream' });
}

const FIRMWARE_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const FIRMWARE_HISTORY_LIMIT = 50;
const FIRMWARE_SELECT_FIELDS = [
  '$id',
  'userId',
  'boardId',
  'version',
  'fileId',
  'filename',
  'size',
  'checksum',
  'uploadedAt',
  'deployed',
  'notes',
  'sourceSnapshotFileId',
  'sourceSnapshotChecksum',
  'sourceSnapshotManifest',
  'sourceSnapshotCreatedAt',
];

export async function listFirmwareHistory(boardId: string, options: { bypassCache?: boolean } = {}) {
  const response = await databases.listDocuments<FirmwareDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.firmwareCollectionId,
    [
      Query.equal('boardId', boardId),
      Query.orderDesc('uploadedAt'),
      Query.limit(FIRMWARE_HISTORY_LIMIT),
      Query.select(FIRMWARE_SELECT_FIELDS),
    ],
    {
      cacheTtlMs: FIRMWARE_HISTORY_CACHE_TTL_MS,
      cacheKey: `firmware:history:${boardId}`,
      bypassCache: options.bypassCache,
    },
  );

  return response.documents;
}

async function listDeployedFirmware(boardId: string) {
  const response = await databases.listDocuments<FirmwareDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.firmwareCollectionId,
    [
      Query.equal('boardId', boardId),
      Query.equal('deployed', true),
      Query.limit(FIRMWARE_HISTORY_LIMIT),
      Query.select(FIRMWARE_SELECT_FIELDS),
    ],
    {
      cacheTtlMs: 0,
      cacheKey: `firmware:deployed:${boardId}`,
    },
  );

  return response.documents;
}

export type FirmwareDeployResult = {
  board?: BoardDocument;
  firmware?: FirmwareDocument;
  mqtt?: {
    published: boolean;
    status?: 'published' | 'skipped-polling-only' | 'mqtt-failed-with-polling-fallback' | 'mqtt-failed-no-fallback' | string;
    reason?: string;
  };
};

export async function uploadFirmwareRelease(payload: {
  user: Models.User<Models.Preferences>;
  board: BoardDocument;
  firmwareId: string;
  deploymentId: string;
  version: string;
  compileResult: {
    filename: string;
    binData: string;
    binSize: number;
  };
  notes?: string;
  progressId?: string;
  sourceSnapshot?: {
    fileId: string;
    checksum: string;
    manifest: Record<string, unknown>;
    createdAt: string;
  } | null;
}) {
  const firmwareBytes = base64ToUint8Array(payload.compileResult.binData);
  const firmwareSize = firmwareBytes.byteLength;
  const checksum = await sha256HexBytes(firmwareBytes);
  const file = await storage.createFile(
    appwriteConfig.firmwareBucketId,
    payload.firmwareId,
    bytesToFirmwareFile(firmwareBytes, payload.compileResult.filename),
    firmwareFilePermissions(payload.user.$id),
    payload.progressId,
  );

  const now = new Date().toISOString();
  const existing = await listDeployedFirmware(payload.board.$id);

  await Promise.all(
    existing
      .map((firmware) =>
        databases.updateDocument<FirmwareDocument>(
          appwriteConfig.databaseId,
          appwriteConfig.firmwareCollectionId,
          firmware.$id,
          { deployed: false },
        ),
      ),
  );

  const firmware = await databases.createDocument<FirmwareDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.firmwareCollectionId,
    payload.firmwareId,
    {
      userId: payload.user.$id,
      boardId: payload.board.$id,
      version: payload.version,
      fileId: file.$id,
      filename: payload.compileResult.filename,
      size: firmwareSize,
      checksum,
      uploadedAt: now,
      deployed: true,
      notes: payload.notes ?? '',
      sourceSnapshotFileId: payload.sourceSnapshot?.fileId ?? '',
      sourceSnapshotChecksum: payload.sourceSnapshot?.checksum ?? '',
      sourceSnapshotManifest: payload.sourceSnapshot ? JSON.stringify(payload.sourceSnapshot.manifest) : '',
      sourceSnapshotCreatedAt: payload.sourceSnapshot?.createdAt ?? '',
    },
    firmwarePermissions(payload.user.$id),
  );

  const deployment = await deployFirmwareToBoard(payload.board.$id, payload.firmwareId, payload.deploymentId);

  return { firmware, deployment };
}

async function deployFirmwareToBoard(boardId: string, firmwareId: string, deploymentId: string) {
  if (hasBoardAdminFunction()) {
    return executeFunction<{ boardId: string; firmwareId: string; deploymentId: string }, FirmwareDeployResult>(
      appwriteConfig.boardAdminFunctionId,
      { boardId, firmwareId, deploymentId },
      '/deploy-firmware',
    );
  }

  const firmware = (await listFirmwareHistory(boardId)).find((entry) => entry.$id === firmwareId);
  if (!firmware) {
    throw new Error('Firmware release was not found.');
  }

  await databases.updateDocument<BoardDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.boardsCollectionId,
    boardId,
    {
      desiredFirmwareId: firmwareId,
      desiredVersion: firmware.version,
      desiredDeploymentId: deploymentId,
      otaStatus: 'pending',
      lastOtaError: '',
      updatedAt: new Date().toISOString(),
    },
  );

  return { firmware };
}

export async function markFirmwareAsCurrent(board: BoardDocument, firmware: FirmwareDocument) {
  const deploymentId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  return deployFirmwareToBoard(board.$id, firmware.$id, deploymentId);
}

export async function deleteFirmwareRelease(firmware: FirmwareDocument) {
  await storage.deleteFile(appwriteConfig.firmwareBucketId, firmware.fileId);
  if (firmware.sourceSnapshotFileId && appwriteConfig.firmwareSourceBucketId) {
    await storage.deleteFile(appwriteConfig.firmwareSourceBucketId, firmware.sourceSnapshotFileId).catch(() => undefined);
  }
  await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.firmwareCollectionId, firmware.$id);
}

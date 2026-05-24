import type { Models } from 'appwrite';

import { Permission, Query, Role, databases, storage } from './appwrite';
import { appwriteConfig, hasBoardAdminFunction } from './config';
import { executeFunction } from './functions';
import type { BoardDocument, FirmwareDocument } from './models';

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

function base64ToFile(base64: string, filename: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], filename, { type: 'application/octet-stream' });
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
];

export async function listFirmwareHistory(boardId: string) {
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
  checksum: string;
  notes?: string;
  progressId?: string;
}) {
  const file = await storage.createFile(
    appwriteConfig.firmwareBucketId,
    payload.firmwareId,
    base64ToFile(payload.compileResult.binData, payload.compileResult.filename),
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
      size: payload.compileResult.binSize,
      checksum: payload.checksum,
      uploadedAt: now,
      deployed: true,
      notes: payload.notes ?? '',
    },
    firmwarePermissions(payload.user.$id),
  );

  await deployFirmwareToBoard(payload.board.$id, payload.firmwareId, payload.deploymentId);

  return firmware;
}

async function deployFirmwareToBoard(boardId: string, firmwareId: string, deploymentId: string) {
  if (hasBoardAdminFunction()) {
    return executeFunction<{ boardId: string; firmwareId: string; deploymentId: string }, { board: BoardDocument; firmware: FirmwareDocument; mqtt?: { published: boolean; reason?: string } }>(
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
  await deployFirmwareToBoard(board.$id, firmware.$id, deploymentId);
}

export async function deleteFirmwareRelease(firmware: FirmwareDocument) {
  await storage.deleteFile(appwriteConfig.firmwareBucketId, firmware.fileId);
  await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.firmwareCollectionId, firmware.$id);
}

import type { Models } from 'appwrite';

import { ID, Permission, Query, Role, databases } from './appwrite';
import { appwriteConfig, hasBoardAdminFunction } from './config';
import { executeFunction } from './functions';
import type { BoardDocument, BoardInput, OtaUpdateMode } from './models';
import { generateToken, sha256Hex } from './utils';

function boardPermissions(userId: string) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

type BoardFunctionPayload = {
  board: BoardDocument;
  apiToken: string;
  commandSecret?: string;
  mqttTopic?: string;
  provisioningPop?: string;
};

export const OTA_UPDATE_MODES: OtaUpdateMode[] = ['polling', 'mqtt', 'both'];

export function isOtaUpdateMode(value: unknown): value is OtaUpdateMode {
  return OTA_UPDATE_MODES.includes(value as OtaUpdateMode);
}

export function normalizeOtaUpdateMode(value: unknown, fallback: OtaUpdateMode = 'polling'): OtaUpdateMode {
  return isOtaUpdateMode(value) ? value : fallback;
}

const BOARD_LIST_CACHE_TTL_MS = 2 * 60 * 1000;
const BOARD_LIST_LIMIT = 100;
const BOARD_SELECT_FIELDS = [
  '$id',
  'userId',
  'name',
  'boardType',
  'tokenHash',
  'tokenPreview',
  'desiredFirmwareId',
  'desiredVersion',
  'desiredDeploymentId',
  'lastAppliedDeploymentId',
  'runtimeVersion',
  'lastUpdateCheckAt',
  'otaStatus',
  'provisioningStatus',
  'provisioningRequestedAt',
  'provisioningMode',
  'provisioningPop',
  'mqttTopicSuffix',
  'commandSecretEnvelope',
  'otaUpdateMode',
  'lastOtaError',
  'sourceCodeVisibility',
  'firmwareVersion',
  'status',
  'lastSeen',
  'lastProvisionedAt',
  'createdAt',
  'updatedAt',
];

export async function listBoards(options: { bypassCache?: boolean } = {}) {
  const response = await databases.listDocuments<BoardDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.boardsCollectionId,
    [
      Query.orderDesc('createdAt'),
      Query.limit(BOARD_LIST_LIMIT),
      Query.select(BOARD_SELECT_FIELDS),
    ],
    {
      cacheTtlMs: BOARD_LIST_CACHE_TTL_MS,
      cacheKey: 'boards:list',
      bypassCache: options.bypassCache,
    },
  );

  return response.documents;
}

export async function createBoard(input: BoardInput, user: Models.User<Models.Preferences>) {
  if (hasBoardAdminFunction()) {
    return executeFunction<BoardInput, BoardFunctionPayload>(appwriteConfig.boardAdminFunctionId, input);
  }

  const apiToken = generateToken();
  const tokenHash = await sha256Hex(apiToken);
  const now = new Date().toISOString();

  const board = await databases.createDocument<BoardDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.boardsCollectionId,
    ID.unique(),
    {
      userId: user.$id,
      name: input.name,
      boardType: input.boardType,
      apiToken: '',
      tokenHash,
      tokenPreview: apiToken.slice(-6),
      firmwareVersion: '0.0.0',
      desiredFirmwareId: '',
      desiredVersion: '',
      desiredDeploymentId: '',
      lastAppliedDeploymentId: '',
      runtimeVersion: '',
      lastUpdateCheckAt: null,
      otaStatus: 'idle',
      provisioningStatus: 'pending',
      provisioningRequestedAt: null,
      provisioningMode: '',
      otaUpdateMode: normalizeOtaUpdateMode(input.otaUpdateMode),
      lastOtaError: '',
      sourceCodeVisibility: input.sourceCodeVisibility || 'private',
      status: 'pending',
      lastSeen: null,
      lastProvisionedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    boardPermissions(user.$id),
  );

  return { board, apiToken } as BoardFunctionPayload;
}

export async function updateBoard(boardId: string, updates: Partial<BoardDocument>) {
  const safeUpdates = Object.fromEntries(
    Object.entries(updates).filter(([key, value]) => {
      return (
        value !== undefined &&
        [
          'name',
          'status',
          'lastSeen',
          'lastProvisionedAt',
          'firmwareVersion',
          'desiredFirmwareId',
          'desiredVersion',
          'desiredDeploymentId',
          'lastAppliedDeploymentId',
          'runtimeVersion',
          'lastUpdateCheckAt',
          'otaStatus',
          'provisioningStatus',
          'provisioningRequestedAt',
          'provisioningMode',
          'otaUpdateMode',
          'lastOtaError',
          'sourceCodeVisibility',
          'updatedAt',
        ].includes(key)
      );
    }),
  ) as Record<string, unknown>;
  if (safeUpdates.otaUpdateMode !== undefined && !isOtaUpdateMode(safeUpdates.otaUpdateMode)) {
    throw new Error('otaUpdateMode must be polling, mqtt, or both.');
  }

  return databases.updateDocument<BoardDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.boardsCollectionId,
    boardId,
    safeUpdates,
  );
}

export async function deleteBoard(boardId: string) {
  await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.boardsCollectionId, boardId);
}

export async function rotateBoardToken(boardId: string) {
  if (hasBoardAdminFunction()) {
    return executeFunction<{ boardId: string }, BoardFunctionPayload>(appwriteConfig.boardAdminFunctionId, { boardId }, '/rotate-token');
  }

  const apiToken = generateToken();
  const tokenHash = await sha256Hex(apiToken);
  const board = await databases.updateDocument<BoardDocument>(
    appwriteConfig.databaseId,
    appwriteConfig.boardsCollectionId,
    boardId,
    {
      apiToken: '',
      tokenHash,
      tokenPreview: apiToken.slice(-6),
      status: 'pending',
      lastSeen: null,
      provisioningStatus: 'pending',
      updatedAt: new Date().toISOString(),
    },
  );

  return { board, apiToken } as BoardFunctionPayload;
}

export async function startBoardProvisioning(boardId: string, mode = 'auto') {
  if (!hasBoardAdminFunction()) {
    throw new Error('Board admin function is required to request remote provisioning.');
  }

  return executeFunction<{ boardId: string; mode: string }, { board: BoardDocument; mqtt?: { published: boolean; reason?: string }; provisioning?: { serviceName: string; pop: string; mode: string } }>(
    appwriteConfig.boardAdminFunctionId,
    { boardId, mode },
    '/start-provisioning',
  );
}

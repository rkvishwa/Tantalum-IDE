import { appwriteConfig } from './config';
import type { BoardDocument, FirmwareDocument } from './models';
import type { CloudRealtimeEvent } from '@/types/electron';

const DEDUPE_LIMIT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function collectionDocumentsChannel(databaseId: string, collectionId: string) {
  return `databases.${databaseId}.collections.${collectionId}.documents`;
}

export function boardRealtimeChannels() {
  return appwriteConfig.databaseId && appwriteConfig.boardsCollectionId
    ? [collectionDocumentsChannel(appwriteConfig.databaseId, appwriteConfig.boardsCollectionId)]
    : [];
}

export function firmwareRealtimeChannels() {
  return appwriteConfig.databaseId && appwriteConfig.firmwareCollectionId
    ? [collectionDocumentsChannel(appwriteConfig.databaseId, appwriteConfig.firmwareCollectionId)]
    : [];
}

export function realtimeEventMatchesCollection(event: CloudRealtimeEvent, collectionId: string) {
  return Boolean(collectionId && event.channels.some((channel) => channel.includes(`collections.${collectionId}`)));
}

export function realtimeEventAction(event: CloudRealtimeEvent) {
  const events = Array.isArray(event.events) ? event.events : [];
  if (events.some((entry) => entry.endsWith('.delete'))) {
    return 'delete';
  }
  if (events.some((entry) => entry.endsWith('.create'))) {
    return 'create';
  }
  if (events.some((entry) => entry.endsWith('.update'))) {
    return 'update';
  }
  return 'unknown';
}

function realtimeDedupeKey(event: CloudRealtimeEvent) {
  const payload = isRecord(event.payload) ? event.payload : {};
  const documentId = typeof payload.$id === 'string' ? payload.$id : 'unknown';
  return `${documentId}:${String(event.timestamp || '')}:${(event.events || []).join('|')}`;
}

export function createRealtimeEventDeduper() {
  const seenRealtimeEvents = new Set<string>();
  const seenRealtimeEventOrder: string[] = [];

  return (event: CloudRealtimeEvent) => {
    const key = realtimeDedupeKey(event);
    if (seenRealtimeEvents.has(key)) {
      return false;
    }

    seenRealtimeEvents.add(key);
    seenRealtimeEventOrder.push(key);
    while (seenRealtimeEventOrder.length > DEDUPE_LIMIT) {
      const oldest = seenRealtimeEventOrder.shift();
      if (oldest) {
        seenRealtimeEvents.delete(oldest);
      }
    }

    return true;
  };
}

export function isBoardRealtimeDocument(value: unknown): value is BoardDocument {
  return (
    isRecord(value) &&
    typeof value.$id === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.boardType === 'string' &&
    typeof value.status === 'string'
  );
}

export function isFirmwareRealtimeDocument(value: unknown): value is FirmwareDocument {
  return (
    isRecord(value) &&
    typeof value.$id === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.boardId === 'string' &&
    typeof value.version === 'string' &&
    typeof value.fileId === 'string'
  );
}

export function sortBoardsByCreatedAt(boards: BoardDocument[]) {
  return [...boards].sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
}

export function sortFirmwareByUploadedAt(firmware: FirmwareDocument[]) {
  return [...firmware].sort((left, right) => Date.parse(right.uploadedAt || '') - Date.parse(left.uploadedAt || ''));
}

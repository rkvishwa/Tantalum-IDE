import { ID, Permission, Query, Role } from 'appwrite';
import type { Models } from 'appwrite';

function unwrapResult<T extends object>(result: ({ success: true } & T) | { success: false; error: string }) {
  if (!result.success) {
    const error = new Error(result.error);
    if ('canceled' in result && result.canceled) {
      Object.assign(error, { canceled: true, name: 'AbortError', code: 'ABORT_ERR' });
    }
    throw error;
  }

  return result;
}

function arrayBufferToBase64(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

function getDesktopCloudApi() {
  const desktopApi = window.tantalum;

  if (!desktopApi?.cloud) {
    throw new Error('The desktop bridge is unavailable. Restart the app so the preload API can initialize.');
  }

  return desktopApi.cloud;
}

type ListDocumentsOptions = {
  cacheTtlMs?: number;
  cacheKey?: string;
  bypassCache?: boolean;
};

type FunctionExecutionOptions = {
  bypassCache?: boolean;
  waitForCompletion?: boolean;
  waitTimeoutMs?: number;
  pollMs?: number;
  retryOnSyncTimeout?: boolean;
};

export const account = {
  async get() {
    const result = unwrapResult(await getDesktopCloudApi().auth.getCurrentUser());
    return result.user as Models.User<Models.Preferences> | null;
  },
  async create(userId: string, email: string, password: string, name?: string) {
    const result = unwrapResult(await getDesktopCloudApi().auth.register({
      userId,
      email,
      password,
      name: name ?? '',
    }));

    return result.user as Models.User<Models.Preferences>;
  },
  async createEmailSession(email: string, password: string) {
    const result = unwrapResult(await getDesktopCloudApi().auth.signIn({ email, password }));
    return result.session;
  },
  async createEmailPasswordSession(email: string, password: string) {
    const result = unwrapResult(await getDesktopCloudApi().auth.signIn({ email, password }));
    return result.session;
  },
  async deleteSession(sessionId?: string) {
    void sessionId;
    unwrapResult(await getDesktopCloudApi().auth.signOut());
  },
};

export const databases = {
  async listDocuments<T>(databaseId: string, collectionId: string, queries?: string[], options: ListDocumentsOptions = {}) {
    const result = unwrapResult(await getDesktopCloudApi().databases.listDocuments({
      databaseId,
      collectionId,
      queries,
      cacheTtlMs: options.cacheTtlMs,
      cacheKey: options.cacheKey,
      bypassCache: options.bypassCache,
    }));

    return {
      total: result.total,
      documents: result.documents as T[],
    };
  },
  async createDocument<T>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: Record<string, unknown>,
    permissions?: string[],
  ) {
    const result = unwrapResult(await getDesktopCloudApi().databases.createDocument({
      databaseId,
      collectionId,
      documentId,
      data,
      permissions,
    }));

    return result.document as T;
  },
  async updateDocument<T>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: Record<string, unknown>,
    permissions?: string[],
  ) {
    const result = unwrapResult(await getDesktopCloudApi().databases.updateDocument({
      databaseId,
      collectionId,
      documentId,
      data,
      permissions,
    }));

    return result.document as T;
  },
  async deleteDocument(databaseId: string, collectionId: string, documentId: string) {
    unwrapResult(await getDesktopCloudApi().databases.deleteDocument({
      databaseId,
      collectionId,
      documentId,
    }));
  },
};

export const storage = {
  async createFile(bucketId: string, fileId: string, file: File, permissions?: string[], progressId?: string) {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);

    const result = unwrapResult(await getDesktopCloudApi().storage.createFile({
      bucketId,
      fileId,
      filename: file.name,
      base64,
      contentType: file.type || 'application/octet-stream',
      permissions,
      progressId,
    }));

    return result.file as Models.File;
  },
  async cancelUpload(progressId: string) {
    unwrapResult(await getDesktopCloudApi().storage.cancelUpload({ progressId }));
  },
  async deleteFile(bucketId: string, fileId: string) {
    unwrapResult(await getDesktopCloudApi().storage.deleteFile({ bucketId, fileId }));
  },
};

export const functions = {
  async createExecution(
    functionId: string,
    body: string,
    async = false,
    pathName = '/',
    method = 'POST',
    headers?: Record<string, string>,
    options: FunctionExecutionOptions = {},
  ) {
    const result = unwrapResult(await getDesktopCloudApi().functions.createExecution({
      functionId,
      body,
      async,
      pathName,
      method,
      headers,
      bypassCache: options.bypassCache,
      waitForCompletion: options.waitForCompletion,
      waitTimeoutMs: options.waitTimeoutMs,
      pollMs: options.pollMs,
      retryOnSyncTimeout: options.retryOnSyncTimeout,
    }));

    return result.execution as Models.Execution;
  },
};

export { ID, Permission, Query, Role };

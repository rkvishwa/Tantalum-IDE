import type { Models } from 'appwrite';

export type Result<T = Record<string, never>> =
  | ({ success: true } & T)
  | ({ success: false; error: string; canceled?: boolean });

export type DirectoryItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  extension: string | null;
};

export type MenuAction =
  | { type: 'new-file' }
  | { type: 'open-folder' }
  | { type: 'save-file' }
  | { type: 'save-file-as' }
  | { type: 'show-sketch-folder' }
  | { type: 'toggle-comment' }
  | { type: 'find' }
  | { type: 'find-next' }
  | { type: 'find-previous' }
  | { type: 'compile' }
  | { type: 'upload-cloud' }
  | { type: 'open-library-manager' }
  | { type: 'open-board-manager' }
  | { type: 'install-esp32-support' }
  | { type: 'format-document' }
  | { type: 'toggle-terminal' }
  | { type: 'about' }
  | { type: 'open-recent-file'; filePath: string }
  | { type: 'load-example'; name: string; content: string };

export type PortInfo = {
  path: string;
  manufacturer: string;
  vendorId?: string;
  productId?: string;
};

export type TerminalDataEvent = {
  sessionId: string;
  data: string;
};

export type TerminalExitEvent = {
  sessionId: string;
  exitCode: number;
  signal: number;
};

export type CloudConfig = {
  endpoint: string;
  projectId: string;
  databaseId: string;
  boardsCollectionId: string;
  firmwareCollectionId: string;
  sketchesCollectionId: string;
  firmwareBucketId: string;
  boardAdminFunctionId: string;
  deviceGatewayFunctionId: string;
  agentSettingsFunctionId: string;
  agentGatewayFunctionId: string;
};

export type AgentToolName = 'aider_apply';

export type AgentChangePreview = {
  path: string;
  changeType: 'create' | 'update' | 'delete';
  originalContent: string;
  nextContent: string;
  stats?: {
    changedLines: number;
    beforeLength: number;
    afterLength: number;
  };
};

export type AgentApprovalPreview =
  | {
      kind: 'agent-run';
      files: AgentChangePreview[];
      output: string;
    };

export type AgentApprovalRequest = {
  requestId: string;
  createdAt: string;
  toolName: AgentToolName;
  summary: string;
  preview: AgentApprovalPreview;
};

export type AgentToolInvokeResponse =
  | Result<{
      toolName: AgentToolName;
      output: string;
      meta?: Record<string, unknown>;
    }>
  | Result<{
      toolName: AgentToolName;
      requiresApproval: true;
      approval: AgentApprovalRequest;
    }>;

export type AgentApprovalResolution = Result<{
  toolName: AgentToolName;
  output: string;
  meta?: Record<string, unknown>;
  approved: boolean;
}>;

export type DesktopApi = {
  app: {
    cloudConfig?: CloudConfig;
    getInfo: () => Promise<Result<{ appName: string; version: string; platform: string }>>;
    controlWindow: (action: 'minimize' | 'maximize' | 'close') => Promise<Result>;
    onMenuAction: (callback: (action: MenuAction) => void) => () => void;
  };
  agent: {
    getStatus: () => Promise<
      Result<{
        workspaceRoot: string | null;
        setup: {
          installed: boolean;
          aiderPath: string | null;
          runtimeDir: string;
          message: string;
        };
      }>
    >;
    run: (payload: {
      prompt: string;
      source: 'managed' | 'custom';
      mode: 'fast' | 'plan';
      customCredentialId?: string | null;
      customModelName?: string | null;
      activeTab?: {
        path: string;
        name: string;
        content: string;
        isDirty: boolean;
      } | null;
    }) => Promise<
      Result<{
        output: string;
        changedFiles: Array<{
          path: string;
          changeType: 'create' | 'update' | 'delete';
          stats?: {
            changedLines: number;
            beforeLength: number;
            afterLength: number;
          };
        }>;
        requiresApproval?: boolean;
        approval?: AgentApprovalRequest;
      }>
    >;
    resolveApproval: (payload: { requestId: string; approved: boolean }) => Promise<AgentApprovalResolution>;
  };
  cloud: {
    auth: {
      getCurrentUser: () => Promise<Result<{ user: Models.User<Models.Preferences> | null }>>;
      signIn: (payload: { email: string; password: string }) => Promise<Result<{ session: Record<string, unknown> }>>;
      register: (payload: { userId: string; email: string; password: string; name: string }) => Promise<Result<{ user: Models.User<Models.Preferences> }>>;
      signOut: () => Promise<Result>;
    };
    databases: {
      listDocuments: (payload: { databaseId: string; collectionId: string; queries?: string[] }) => Promise<Result<{ total: number; documents: Array<Record<string, unknown>> }>>;
      createDocument: (payload: { databaseId: string; collectionId: string; documentId: string; data: Record<string, unknown>; permissions?: string[] }) => Promise<Result<{ document: Record<string, unknown> }>>;
      updateDocument: (payload: { databaseId: string; collectionId: string; documentId: string; data: Record<string, unknown>; permissions?: string[] }) => Promise<Result<{ document: Record<string, unknown> }>>;
      deleteDocument: (payload: { databaseId: string; collectionId: string; documentId: string }) => Promise<Result>;
    };
    storage: {
      createFile: (payload: { bucketId: string; fileId: string; filename: string; base64: string; contentType?: string; permissions?: string[] }) => Promise<Result<{ file: Record<string, unknown> }>>;
      deleteFile: (payload: { bucketId: string; fileId: string }) => Promise<Result>;
    };
    functions: {
      createExecution: (payload: { functionId: string; body: string; async?: boolean; pathName?: string; method?: string; headers?: Record<string, string> }) => Promise<Result<{ execution: Record<string, unknown> }>>;
    };
  };
  shell: {
    openExternal: (url: string) => Promise<Result>;
    openPath: (targetPath: string) => Promise<Result>;
  };
  fs: {
    openFolder: () => Promise<Result<{ path: string }>>;
    setWorkspace: (folderPath: string) => Promise<Result<{ path: string }>>;
    getLastWorkspace: () => Promise<Result<{ path: string }>>;
    getRecentWorkspaces: () => Promise<Result<{ paths: string[] }>>;
    showSaveDialog: (options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<Result<{ path: string }>>;
    readDirectory: (dirPath: string) => Promise<Result<{ items: DirectoryItem[] }>>;
    readFile: (filePath: string) => Promise<Result<{ path: string; content: string }>>;
    writeFile: (filePath: string, content: string) => Promise<Result>;
    createFile: (folderPath: string, fileName: string, content?: string) => Promise<Result<{ path: string }>>;
    createFolder: (parentPath: string, folderName: string) => Promise<Result<{ path: string }>>;
    rename: (oldPath: string, newPath: string) => Promise<Result<{ path: string }>>;
    deletePath: (targetPath: string) => Promise<Result>;
    addRecentFile: (filePath: string) => Promise<Result>;
  };
  secrets: {
    setBoardSecrets: (payload: { boardId: string; apiToken?: string; wifiPassword?: string }) => Promise<Result>;
    getBoardSecrets: (boardId: string) => Promise<Result<{ secrets: { apiToken?: string; wifiPassword?: string; updatedAt?: string } | null }>>;
    deleteBoardSecrets: (boardId: string) => Promise<Result>;
  };
  toolchain: {
    compile: (payload: { code: string; board: string }) => Promise<Result<{ filename: string; binData: string; binSize: number; board: string; output: string }>>;
    installBoardPackage: (payload: { packageName: string; packageUrl?: string | null }) => Promise<Result<{ output?: string }>>;
    removeBoardPackage: (payload: { packageName: string }) => Promise<Result<{ output?: string }>>;
    listInstalledBoards: () => Promise<Result<{ boards: Array<Record<string, unknown>> }>>;
    searchBoardPlatforms: (query: string) => Promise<Result<{ platforms: Array<Record<string, unknown>> }>>;
    listInstalledPlatforms: () => Promise<Result<{ platforms: Array<Record<string, unknown>> }>>;
    searchLibraries: (query: string) => Promise<Result<{ libraries: Array<Record<string, unknown>> }>>;
    getFeaturedLibraries: () => Promise<Result<{ libraries: Array<Record<string, unknown>> }>>;
    installLibrary: (payload: { name: string; version?: string }) => Promise<Result<{ output?: string }>>;
    listInstalledLibraries: () => Promise<Result<{ libraries: Array<Record<string, unknown>> }>>;
    listPorts: () => Promise<Result<{ ports: PortInfo[] }>>;
    provisionBoard: (payload: Record<string, unknown>) => Promise<Result<{ message?: string; output?: string }>>;
    installEsp32Support: () => Promise<Result<{ message?: string; output?: string }>>;
    onInstallProgress: (callback: (chunk: string) => void) => () => void;
  };
  terminal: {
    create: (options?: { cols?: number; rows?: number; cwd?: string; shell?: string }) => Promise<Result<{ sessionId: string; cwd: string; shell: string }>>;
    close: (sessionId: string) => Promise<Result>;
    navigate: (payload: { sessionId: string; targetPath: string }) => Promise<Result<{ cwd: string }>>;
    write: (payload: { sessionId: string; data: string }) => void;
    resize: (payload: { sessionId: string; cols: number; rows: number }) => void;
    onData: (callback: (event: TerminalDataEvent) => void) => () => void;
    onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
  };
};

declare global {
  interface Window {
    tantalum: DesktopApi;
  }
}

export {};

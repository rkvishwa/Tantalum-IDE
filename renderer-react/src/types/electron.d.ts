import type { Models } from 'appwrite';

export type Result<T = Record<string, never>> =
  | ({ success: true } & T)
  | ({ success: false; error: string; canceled?: boolean });

export type LibraryInstallProgressEvent = {
  installId: string;
  name: string;
  version?: string;
  status: 'queued' | 'running' | 'success' | 'error' | 'canceled';
  phase: string;
  message: string;
  progress: number | null;
};

export type UsbUploadProgressEvent = {
  uploadId: string;
  port: string;
  board: string;
  stream: 'stdout' | 'stderr' | string;
  chunk: string;
  message: string;
  progress: number | null;
};

export type CompileProgressEvent = {
  compileId: string;
  stream: 'stdout' | 'stderr' | string;
  chunk: string;
  message: string;
  progress: number | null;
};

export type StorageUploadProgressEvent = {
  progressId: string;
  bucketId: string;
  fileId: string;
  filename: string;
  sentBytes: number;
  totalBytes: number;
  progress: number;
};

export type ArduinoLibraryDirectoryInfo = {
  userDir: string;
  librariesDir: string;
  fallback: boolean;
  configuredUserDir: string | null;
  failures?: string[];
};

export type ArduinoStorageInfo = {
  configured: boolean;
  storageRoot: string | null;
  dataDir: string | null;
  downloadsDir: string | null;
  userDir: string | null;
  librariesDir: string | null;
  buildCacheDir: string | null;
  tempDir: string | null;
};

export type LibraryMigrationProgressEvent = {
  phase: string;
  message: string;
  progress: number | null;
  migrated: number;
  skipped: number;
  failed: number;
  total: number;
};

export type LibraryMigrationEntry = {
  action: 'migrated' | 'skipped' | 'failed';
  name: string;
  version?: string;
  sourcePath: string;
  targetPath?: string;
  reason?: string;
};

export type LibraryMigrationResult = {
  sourceLibrariesDir: string;
  targetLibrariesDir: string;
  userDir: string;
  migrated: LibraryMigrationEntry[];
  skipped: LibraryMigrationEntry[];
  failed: LibraryMigrationEntry[];
  total: number;
};

export type ToolchainNotificationStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled' | 'interrupted';

export type ToolchainNotificationKind =
  | 'library-install'
  | 'library-update'
  | 'library-remove'
  | 'library-migration'
  | 'platform-install'
  | 'platform-update'
  | 'platform-remove'
  | 'usb-upload'
  | 'firmware-upload'
  | 'cloud-runtime-install'
  | 'toolchain-task';

export type ToolchainNotificationMetadata = Record<string, string | number | boolean | null | undefined>;

export type ToolchainNotification = {
  id: string;
  kind: ToolchainNotificationKind | string;
  title: string;
  detail: string;
  status: ToolchainNotificationStatus;
  phase: string;
  progress: number | null;
  name: string;
  version: string;
  target: string;
  metadata: ToolchainNotificationMetadata;
  createdAt: number;
  updatedAt: number;
};

export type ToolchainNotificationInput = {
  id?: string;
  kind: ToolchainNotificationKind | string;
  title: string;
  detail?: string;
  status: ToolchainNotificationStatus;
  phase?: string;
  progress?: number | null;
  name?: string;
  version?: string;
  target?: string;
  metadata?: ToolchainNotificationMetadata;
  createdAt?: number;
  updatedAt?: number;
};

export type DirectoryItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  extension: string | null;
};

export type FileTreeNativeContextMenuAction = {
  key: string;
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
};

export type FileTreeNativeContextMenuRequest = {
  position: {
    x: number;
    y: number;
  };
  groups: FileTreeNativeContextMenuAction[][];
};

export type FileTreeNativeContextMenuResponse = {
  actionKey: string | null;
  actionId: string | null;
};

export type WorkspaceSearchMode = 'all' | 'files' | 'folders' | 'text';

export type WorkspaceSearchRequest = {
  query: string;
  mode?: WorkspaceSearchMode;
  replace?: string;
  useRegex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  includeGlob?: string;
  excludeGlob?: string;
  maxResults?: number;
  blockedPaths?: string[];
};

export type WorkspaceSearchResult = {
  id: string;
  type: 'file' | 'folder' | 'text';
  path: string;
  relativePath: string;
  name: string;
  lineNumber?: number;
  column?: number;
  endColumn?: number;
  preview?: string;
  matchText?: string;
};

export type WorkspaceSearchStats = {
  totalResults: number;
  fileResults: number;
  folderResults: number;
  textResults: number;
  durationMs: number;
};

export type WorkspaceReplacePreviewFile = {
  path: string;
  relativePath: string;
  matchCount: number;
  previews: Array<{
    lineNumber: number;
    column: number;
    before: string;
    after: string;
  }>;
};

export type WorkspaceReplaceChangedFile = {
  path: string;
  relativePath: string;
  matchCount: number;
  content: string;
};

export type ProjectFolder = {
  id: string;
  path: string;
  name: string;
  displayName?: string;
  favorite: boolean;
  addedAt: string;
  lastOpenedAt?: string;
  exists: boolean;
  details?: {
    topLevelFiles: number;
    topLevelFolders: number;
    lastModifiedAt?: string;
    gitRepository: boolean;
  };
};

export type MenuAction =
  | { type: 'new-file' }
  | { type: 'open-file' }
  | { type: 'open-folder' }
  | { type: 'open-recent-workspace'; folderPath: string }
  | { type: 'save-file' }
  | { type: 'save-file-as' }
  | { type: 'show-sketch-folder' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'cut' }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'select-all' }
  | { type: 'toggle-comment' }
  | { type: 'find' }
  | { type: 'find-in-workspace' }
  | { type: 'find-next' }
  | { type: 'find-previous' }
  | { type: 'show-explorer' }
  | { type: 'show-boards' }
  | { type: 'show-libraries' }
  | { type: 'show-git' }
  | { type: 'show-platforms' }
  | { type: 'show-my-projects' }
  | { type: 'show-output' }
  | { type: 'show-serial-monitor' }
  | { type: 'compile' }
  | { type: 'upload-local' }
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

export type LocalBoardMatch = {
  name: string;
  fqbn: string;
  isHidden?: boolean;
};

export type LocalBoardDetection = {
  id: string;
  fingerprint: string;
  path: string;
  port: string;
  label: string;
  protocol: string;
  protocolLabel: string;
  manufacturer: string;
  vendorId?: string | null;
  productId?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  locationId?: string | null;
  boardLabel: string;
  fqbn: string;
  matchingBoards: LocalBoardMatch[];
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low' | string;
  detectionSource: string;
  connected: boolean;
  ai?: {
    status: 'suggested' | 'no-suggestion' | 'error' | string;
    reason?: string;
    model?: string | null;
  } | null;
};

export type LocalBoardPort = {
  path: string;
  label: string;
  protocol: string;
  protocolLabel: string;
  manufacturer: string;
  vendorId?: string | null;
  productId?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  locationId?: string | null;
  likelyBoard?: boolean;
};

export type LocalBoardProfile = {
  id: string;
  name: string;
  fqbn: string;
  boardLabel: string;
  port: string;
  protocol: string;
  protocolLabel: string;
  manufacturer: string;
  vendorId?: string | null;
  productId?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  locationId?: string | null;
  fingerprint: string;
  confidence?: number | null;
  connected?: boolean;
  cloudBoardId?: string;
  cloudLinkedAt?: string;
  lastCloudProvisionedAt?: string;
  lastCloudUsbUploadAt?: string;
  createdAt: string;
  updatedAt: string;
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

export type SerialMonitorDataEvent = {
  sessionId: string;
  data: string;
};

export type SerialMonitorErrorEvent = {
  sessionId: string;
  error: string;
};

export type SerialMonitorCloseEvent = {
  sessionId: string;
  reason: string;
};

export type SerialPortBlocker = {
  blockerId: string;
  kind: 'tantalum-session' | 'external-process' | string;
  confidence: 'confirmed' | 'possible' | string;
  pid?: number | null;
  name: string;
  executablePath?: string | null;
  commandLine?: string | null;
  reason: string;
  canTerminate: boolean;
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
  boardDetectionFunctionId?: string;
  mqttHost?: string;
  mqttPort?: string | number;
  mqttUsername?: string;
  mqttPassword?: string;
  mqttCaCert?: string;
  tlsCaCert?: string;
};

export type AgentToolName = 'opencode_apply' | string;
export type AgentRouteEngine = 'local' | 'direct_llm' | 'opencode_ask' | 'opencode_edit' | 'agent_tool';
export type AgentReviewMode = 'live-applied' | 'none';
export type AgentPermissionMode = 'default' | 'bypass';
export type AgentRunStageName = 'routing' | 'preparing_workspace' | 'running_direct_llm' | 'running_opencode' | 'running_tool' | 'applying_changes';
export type PendingAgentActionStatus = 'pending' | 'approved' | 'running' | 'blocked' | 'skipped' | 'executed' | 'expired';
export type AgentDecisionKind = 'approve_skip' | 'clarify' | 'none';
export type AgentTaskStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'skipped';

export type AgentToolRisk = 'low' | 'medium' | 'high' | string;
export type AgentToolOrigin = 'user' | 'agent' | string;

export type AgentToolRequest = {
  requestId: string;
  toolId: string;
  summary: string;
  risk: AgentToolRisk;
  origin: AgentToolOrigin;
  arguments: Record<string, unknown>;
  approvalReason?: string;
};

export type AgentToolDescriptor = {
  id: string;
  category: string;
  label: string;
  description: string;
  risk: AgentToolRisk;
  approval: 'never' | 'default' | 'always' | string;
  enabledByDefault: boolean;
  available: boolean;
  unavailableReason?: string;
};

export type AgentToolSettings = {
  tools: Record<string, { enabled: boolean }>;
  updatedAt: string;
};

export type AgentToolSettingsResponse = {
  descriptors: AgentToolDescriptor[];
  settings: AgentToolSettings;
  categories: Record<string, string>;
};

export type AgentToolProgressEvent = {
  toolRequest?: AgentToolRequest;
  status: 'queued' | 'running' | 'completed' | 'error' | 'canceled' | string;
  message: string;
  createdAt: string;
};

export type PendingAgentAction = {
  id: string;
  threadId: string | null;
  kind: 'edit' | 'ask' | string;
  originalPrompt: string;
  normalizedPrompt: string;
  riskLevel: 'low' | 'medium' | 'high' | string;
  reason: string;
  createdAt: string;
  status: PendingAgentActionStatus;
  toolRequest?: AgentToolRequest;
};

export type AgentTaskItem = {
  id: string;
  title: string;
  status: AgentTaskStatus;
  kind: string;
  targetPath?: string;
  newPath?: string;
  sourceExtension?: string;
  targetExtension?: string;
  lineStart?: number;
  lineEnd?: number;
  contextItemId?: string;
  instruction?: string;
  result?: string;
  error?: string;
};

export type AgentTaskList = {
  id: string;
  actionId: string | null;
  items: AgentTaskItem[];
  createdAt: string;
  updatedAt: string;
};

export type AgentCompletedTaskReferenceItem = {
  kind: string;
  title: string;
  targetPath?: string;
  newPath?: string;
  lineStart?: number;
  lineEnd?: number;
  instruction?: string;
  result?: string;
};

export type AgentCompletedTaskReference = {
  taskListId: string;
  actionId: string | null;
  completedAt: string;
  items: AgentCompletedTaskReferenceItem[];
};

export type AgentThreadFileReference = {
  path: string;
  previousPath?: string;
  name: string;
  aliases: string[];
  source: 'task' | 'context';
  lastAction: 'created' | 'edited' | 'renamed' | 'deleted' | 'attached';
  expectedExists: boolean;
  updatedAt: string;
};

export type AgentThreadMemory = {
  files: AgentThreadFileReference[];
  updatedAt?: string;
};

export type AgentActivityStatus = 'running' | 'completed' | 'blocked' | 'error';

export type AgentActivityEntry = {
  id: string;
  status: AgentActivityStatus;
  title: string;
  detail?: string;
  createdAt: string;
};

export type AgentContextItemKind = 'file' | 'selection' | 'image';

export type AgentContextItem = {
  id: string;
  kind: AgentContextItemKind;
  path: string;
  name: string;
  relativePath?: string;
  content: string;
  mimeType?: string;
  sizeBytes?: number;
  dataUrl?: string;
  isDirty?: boolean;
  lineStart?: number;
  lineEnd?: number;
  tokenEstimate?: number;
  originalTokenEstimate?: number;
  truncated?: boolean;
  source?: 'active-editor' | 'workspace' | 'attachment';
};

export type AgentContextFileSuggestion = {
  path: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
};

export type AgentContextAttachmentRejection = {
  path?: string;
  name: string;
  reason: string;
};

export type AgentProgressEvent = {
  threadId: string;
  actionId: string | null;
  stage: 'running' | 'completed' | 'blocked' | string;
  taskList?: AgentTaskList;
  activity?: AgentActivityEntry;
  createdAt: string;
};

export type AgentRunStage = {
  name: AgentRunStageName | string;
  status: 'pending' | 'running' | 'completed' | 'failed' | string;
  message?: string;
};

export type AgentSkippedFile = {
  path: string;
  reason: 'excluded' | 'oversized' | 'binary' | 'non_utf8' | 'unreadable' | string;
  sizeBytes?: number;
};

export type AgentDiagnostic = {
  level: 'info' | 'warning' | 'error' | string;
  message: string;
  path?: string;
};

export type AgentRouteResult = {
  engine: AgentRouteEngine;
  reason: string;
  confidence: number;
  persistThread: boolean;
  titleSuggestion: string;
  userMessage?: string;
  requiresUserDecision?: boolean;
  decisionKind?: AgentDecisionKind;
  pendingAction?: PendingAgentAction;
  taskList?: AgentTaskList;
};

export type GitStatusState = 'no-workspace' | 'missing-git' | 'not-repository' | 'unsafe' | 'repository';

export type GitFileChange = {
  path: string;
  oldPath?: string;
  status: string;
  staged: boolean;
  conflicted: boolean;
  untracked: boolean;
};

export type GitStatus = {
  state: GitStatusState;
  available: boolean;
  isRepository: boolean;
  root: string | null;
  gitDir: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  operation: string | null;
  stagedFiles: GitFileChange[];
  unstagedFiles: GitFileChange[];
  untrackedFiles: GitFileChange[];
  conflictedFiles: GitFileChange[];
  hasChanges: boolean;
  safeDirectoryRequired: boolean;
  message: string;
};

export type GitDiffMode = 'working-tree' | 'staged';

export type GitDiff = {
  path: string;
  oldPath: string;
  mode: GitDiffMode;
  oldContent: string;
  newContent: string;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  authorEmail?: string;
  date: string;
  refs: string;
  branch: string;
  graphPrefix: string;
  stats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
};

export type GitBranch = {
  name: string;
  shortHash: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type GitRemote = {
  name: string;
  fetchUrl: string;
  pushUrl: string;
};

export type GitProvider = 'github' | 'gitlab';

export type GitConfiguration = {
  defaultProvider: GitProvider;
  githubUsername: string;
  gitlabUsername: string;
  gitUserName: string;
  gitUserEmail: string;
  githubTokenConfigured: boolean;
  gitlabTokenConfigured: boolean;
};

export type AgentChangePreview = {
  path: string;
  changeType: 'create' | 'update' | 'delete';
  originalContent: string;
  nextContent: string;
  workspaceOriginalContent?: string;
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

export type AgentRunPayload = {
  prompt: string;
  source: 'managed' | 'custom';
  mode: 'fast' | 'power';
  intent?: 'agent' | 'ask';
  permissionMode?: AgentPermissionMode;
  threadId?: string | null;
  customCredentialId?: string | null;
  customModelName?: string | null;
  fastContextWindow?: number | null;
  powerContextWindow?: number | null;
  threadMessages?: Array<{
    role: 'user' | 'assistant' | 'status';
    content: string;
  }>;
  activeTab?: {
    path: string;
    name: string;
    content: string;
    isDirty: boolean;
  } | null;
  contextItems?: AgentContextItem[];
  boardContext?: {
    id?: string;
    name: string;
    fqbn: string;
  } | null;
  localBoardContext?: {
    profileId?: string;
    name: string;
    fqbn: string;
    port: string;
    boardLabel?: string;
    connected?: boolean;
  } | null;
  arduinoPreferences?: {
    verifyBeforeUpload: boolean;
    nextReleaseVersion?: string;
  } | null;
  pendingAction?: PendingAgentAction | null;
  taskList?: AgentTaskList | null;
  completedTaskReferences?: AgentCompletedTaskReference[];
  threadMemory?: AgentThreadMemory | null;
  approvedActionId?: string | null;
};

export type DesktopApi = {
  app: {
    cloudConfig?: CloudConfig;
    getInfo: () => Promise<Result<{ appName: string; version: string; platform: string }>>;
    controlWindow: (action: 'minimize' | 'maximize' | 'close') => Promise<Result>;
    dispatchMenuAction: (action: MenuAction) => Promise<Result>;
    onMenuAction: (callback: (action: MenuAction) => void) => () => void;
  };
  notifications: {
    list: () => Promise<Result<{ notifications: ToolchainNotification[] }>>;
    upsert: (notification: ToolchainNotificationInput) => Promise<Result<{ notification: ToolchainNotification; notifications: ToolchainNotification[] }>>;
    clear: () => Promise<Result<{ notifications: ToolchainNotification[] }>>;
    onChanged: (callback: (notifications: ToolchainNotification[]) => void) => () => void;
  };
  agent: {
    getStatus: () => Promise<
      Result<{
        workspaceRoot: string | null;
        setup: {
          installed: boolean;
          opencodePath: string | null;
          runtimeDir: string;
          message: string;
        };
      }>
    >;
    route: (payload: AgentRunPayload) => Promise<Result<AgentRouteResult>>;
    run: (payload: AgentRunPayload) => Promise<
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
        autoApplied?: boolean;
        diff?: AgentChangePreview[];
        meta?: Record<string, unknown>;
        route?: AgentRouteResult;
        engine?: AgentRouteEngine;
        diagnostics?: AgentDiagnostic[];
        skippedFiles?: AgentSkippedFile[];
        reviewMode?: AgentReviewMode;
        stages?: AgentRunStage[];
        requiresApproval?: boolean;
        approval?: AgentApprovalRequest;
        taskList?: AgentTaskList;
        actionStatus?: PendingAgentActionStatus;
      }>
    >;
    stop: (payload: { threadId: string }) => Promise<Result<{ stopped: boolean }>>;
    resolveApproval: (payload: { requestId: string; approved: boolean }) => Promise<AgentApprovalResolution>;
    onProgress: (callback: (event: AgentProgressEvent) => void) => () => void;
    tools: {
      listSettings: () => Promise<Result<AgentToolSettingsResponse>>;
      updateSettings: (payload: { tools: Record<string, boolean | { enabled: boolean }> }) => Promise<Result<AgentToolSettingsResponse>>;
      onSettingsChanged: (callback: (settings: AgentToolSettingsResponse) => void) => () => void;
      onProgress: (callback: (event: AgentToolProgressEvent) => void) => () => void;
    };
  };
  cloud: {
    auth: {
      getCurrentUser: () => Promise<Result<{ user: Models.User<Models.Preferences> | null }>>;
      signIn: (payload: { email: string; password: string }) => Promise<Result<{ session: Record<string, unknown> }>>;
      register: (payload: { userId: string; email: string; password: string; name: string }) => Promise<Result<{ user: Models.User<Models.Preferences> }>>;
      signOut: () => Promise<Result>;
    };
    databases: {
      listDocuments: (payload: { databaseId: string; collectionId: string; queries?: string[]; cacheTtlMs?: number; cacheKey?: string; bypassCache?: boolean }) => Promise<Result<{ total: number; documents: Array<Record<string, unknown>> }>>;
      createDocument: (payload: { databaseId: string; collectionId: string; documentId: string; data: Record<string, unknown>; permissions?: string[] }) => Promise<Result<{ document: Record<string, unknown> }>>;
      updateDocument: (payload: { databaseId: string; collectionId: string; documentId: string; data: Record<string, unknown>; permissions?: string[] }) => Promise<Result<{ document: Record<string, unknown> }>>;
      deleteDocument: (payload: { databaseId: string; collectionId: string; documentId: string }) => Promise<Result>;
    };
    storage: {
      createFile: (payload: { bucketId: string; fileId: string; filename: string; base64: string; contentType?: string; permissions?: string[]; progressId?: string }) => Promise<Result<{ file: Record<string, unknown> }>>;
      deleteFile: (payload: { bucketId: string; fileId: string }) => Promise<Result>;
      onUploadProgress: (callback: (event: StorageUploadProgressEvent) => void) => () => void;
    };
    functions: {
      createExecution: (payload: { functionId: string; body: string; async?: boolean; pathName?: string; method?: string; headers?: Record<string, string> }) => Promise<Result<{ execution: Record<string, unknown> }>>;
    };
  };
  shell: {
    openExternal: (url: string) => Promise<Result>;
    openPath: (targetPath: string) => Promise<Result>;
  };
  fileTree: {
    showContextMenu: (payload: FileTreeNativeContextMenuRequest) => Promise<Result<FileTreeNativeContextMenuResponse>>;
  };
  fs: {
    openFolder: () => Promise<Result<{ path: string }>>;
    openFile: () => Promise<Result<{ path: string }>>;
    setWorkspace: (folderPath: string) => Promise<Result<{ path: string }>>;
    getLastWorkspace: () => Promise<Result<{ path: string }>>;
    getRecentWorkspaces: () => Promise<Result<{ paths: string[] }>>;
    getRecentFiles: () => Promise<Result<{ paths: string[] }>>;
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
  workspace: {
    search: (request: WorkspaceSearchRequest) => Promise<Result<{ results: WorkspaceSearchResult[]; truncated: boolean; stats: WorkspaceSearchStats }>>;
    suggestContextFiles: (request: { query?: string; maxResults?: number }) => Promise<Result<{ files: AgentContextFileSuggestion[] }>>;
    readContextFile: (request: { path: string; lineStart?: number | null; lineEnd?: number | null }) => Promise<Result<AgentContextItem>>;
    pickContextAttachments: () => Promise<Result<{ items: AgentContextItem[]; rejected: AgentContextAttachmentRejection[]; canceled?: boolean }>>;
    previewReplace: (request: WorkspaceSearchRequest) => Promise<Result<{ files: WorkspaceReplacePreviewFile[]; totalMatches: number; blockedPaths: string[] }>>;
    applyReplace: (request: WorkspaceSearchRequest) => Promise<Result<{ changedFiles: WorkspaceReplaceChangedFile[]; skippedFiles: string[]; totalReplacements: number }>>;
  };
  projects: {
    list: () => Promise<Result<{ projects: ProjectFolder[] }>>;
    add: (projectPath: string) => Promise<Result<{ project: ProjectFolder; alreadyExists: boolean }>>;
    pickFolder: () => Promise<Result<{ path: string }>>;
    remove: (projectId: string) => Promise<Result<{ projects: ProjectFolder[] }>>;
    update: (projectId: string, patch: Partial<Pick<ProjectFolder, 'path' | 'displayName' | 'favorite' | 'lastOpenedAt'>>) => Promise<Result<{ project: ProjectFolder }>>;
    inspect: (projectId: string) => Promise<Result<{ project: ProjectFolder }>>;
  };
  git: {
    getStatus: () => Promise<Result<{ status: GitStatus }>>;
    getDiff: (payload: { path: string; oldPath?: string; mode?: GitDiffMode }) => Promise<Result<{ diff: GitDiff }>>;
    stage: (payload: { path?: string; paths?: string[] }) => Promise<Result<{ output?: string }>>;
    unstage: (payload: { path?: string; paths?: string[] }) => Promise<Result<{ output?: string }>>;
    discard: (payload: { path?: string; paths?: string[]; staged?: boolean; untracked?: boolean }) => Promise<Result<{ output?: string }>>;
    commit: (payload: { message: string }) => Promise<Result<{ output?: string }>>;
    fetch: () => Promise<Result<{ output?: string }>>;
    pull: () => Promise<Result<{ output?: string }>>;
    push: () => Promise<Result<{ output?: string }>>;
    listBranches: () => Promise<Result<{ status: GitStatus; branches: GitBranch[] }>>;
    checkoutBranch: (payload: { branch: string }) => Promise<Result<{ output?: string }>>;
    createBranch: (payload: { branch: string }) => Promise<Result<{ output?: string }>>;
    getLog: (payload?: { limit?: number }) => Promise<Result<{ commits: GitCommit[] }>>;
    getRemotes: () => Promise<Result<{ remotes: GitRemote[] }>>;
    repairSafeDirectory: () => Promise<Result<{ output?: string }>>;
    initRepository: (payload?: { defaultBranch?: string }) => Promise<Result<{ output?: string }>>;
    publishRepository: (payload: {
      provider: GitProvider;
      repositoryName: string;
      owner?: string;
      visibility: 'private' | 'public';
      initialCommitMessage?: string;
    }) => Promise<Result<{ output?: string; remoteUrl: string; webUrl: string }>>;
    getConfiguration: () => Promise<Result<{ config: GitConfiguration }>>;
    setConfiguration: (payload: {
      defaultProvider: GitProvider;
      githubUsername?: string;
      gitlabUsername?: string;
      githubToken?: string;
      gitlabToken?: string;
      clearGithubToken?: boolean;
      clearGitlabToken?: boolean;
      gitUserName?: string;
      gitUserEmail?: string;
    }) => Promise<Result<{ config: GitConfiguration }>>;
  };
  secrets: {
    setBoardSecrets: (payload: { boardId: string; apiToken?: string; commandSecret?: string; mqttTopic?: string; provisioningPop?: string }) => Promise<Result>;
    getBoardSecrets: (boardId: string) => Promise<Result<{ secrets: { apiToken?: string; commandSecret?: string; mqttTopic?: string; provisioningPop?: string; updatedAt?: string } | null }>>;
    deleteBoardSecrets: (boardId: string) => Promise<Result>;
  };
  toolchain: {
    compile: (payload: { code: string; board: string; cloudRuntime?: Record<string, unknown> | null; compileId?: string }) => Promise<Result<{ filename: string; binData: string; binSize: number; board: string; output: string; cloudRuntime?: boolean }>>;
    detectLocalBoards: (payload?: { portsOnly?: boolean; probeEsp?: boolean; aiFallback?: boolean }) => Promise<Result<{ boards: LocalBoardDetection[]; ports?: LocalBoardPort[]; detectedAt: string }>>;
    listLocalBoardProfiles: () => Promise<Result<{ profiles: LocalBoardProfile[] }>>;
    saveLocalBoardProfile: (payload: Partial<LocalBoardProfile>) => Promise<Result<{ profile: LocalBoardProfile }>>;
    deleteLocalBoardProfile: (profileId: string) => Promise<Result<{ profiles: LocalBoardProfile[] }>>;
    replaceLocalBoardProfiles: (profiles: Array<Partial<LocalBoardProfile>>) => Promise<Result<{ profiles: LocalBoardProfile[] }>>;
    uploadLocalSketch: (payload: { code: string; board: string; port: string; uploadId?: string; cloudRuntime?: Record<string, unknown> | null }) => Promise<Result<{ message?: string; output?: string; board: string; port: string; cloudRuntime?: boolean }>>;
    provisionBoardWifiUsb: (payload: { boardId: string; port: string; ssid: string; password: string }) => Promise<Result<{ status?: string; message?: string; boardId: string; port: string }>>;
    installBoardPackage: (payload: { packageName: string; packageUrl?: string | null; installId?: string }) => Promise<Result<{ output?: string; installId?: string }>>;
    cancelBoardPackageInstall: (payload: { installId: string }) => Promise<Result<{ alreadyStopped?: boolean }>>;
    removeBoardPackage: (payload: { packageName: string }) => Promise<Result<{ output?: string }>>;
    listInstalledBoards: () => Promise<Result<{ boards: Array<Record<string, unknown>> }>>;
    searchBoardPlatforms: (query: string) => Promise<Result<{ platforms: Array<Record<string, unknown>> }>>;
    listInstalledPlatforms: () => Promise<Result<{ platforms: Array<Record<string, unknown>> }>>;
    searchLibraries: (query: string) => Promise<Result<{ libraries: Array<Record<string, unknown>> }>>;
    getFeaturedLibraries: () => Promise<Result<{ libraries: Array<Record<string, unknown>> }>>;
    getArduinoStorage: () => Promise<Result<ArduinoStorageInfo>>;
    selectArduinoStorage: () => Promise<Result<ArduinoStorageInfo>>;
    clearArduinoStorage: () => Promise<Result<ArduinoStorageInfo>>;
    getLibraryDirectory: () => Promise<Result<ArduinoLibraryDirectoryInfo>>;
    selectLibrarySourceFolder: (payload?: { defaultPath?: string }) => Promise<Result<{ path: string }>>;
    migrateLibraries: (payload: { sourcePath: string }) => Promise<Result<LibraryMigrationResult>>;
    installLibrary: (payload: { name: string; version?: string; installId?: string }) => Promise<Result<{
      output?: string;
      installId?: string;
      installedPath?: string;
      installedVersion?: string;
      dependenciesInstalled?: string[];
    }>>;
    cancelLibraryInstall: (payload: { installId: string }) => Promise<Result<{ alreadyStopped?: boolean }>>;
    removeLibrary: (payload: { name: string }) => Promise<Result<{ output?: string; removedPath?: string }>>;
    listInstalledLibraries: () => Promise<Result<{ libraries: Array<Record<string, unknown>> }>>;
    listPorts: () => Promise<Result<{ ports: PortInfo[] }>>;
    provisionBoard: (payload: Record<string, unknown>) => Promise<Result<{ message?: string; output?: string }>>;
    installEsp32Support: () => Promise<Result<{ message?: string; output?: string }>>;
    onCompileProgress: (callback: (event: CompileProgressEvent) => void) => () => void;
    onInstallProgress: (callback: (chunk: string) => void) => () => void;
    onUsbUploadProgress: (callback: (event: UsbUploadProgressEvent) => void) => () => void;
    onLibraryInstallProgress: (callback: (event: LibraryInstallProgressEvent) => void) => () => void;
    onLibraryMigrationProgress: (callback: (event: LibraryMigrationProgressEvent) => void) => () => void;
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
  serialMonitor: {
    open: (options: { port: string; baudRate?: number }) => Promise<Result<{ sessionId: string; port: string; baudRate: number }>>;
    close: (sessionId: string) => Promise<Result>;
    write: (payload: { sessionId: string; data: string }) => void;
    onData: (callback: (event: SerialMonitorDataEvent) => void) => () => void;
    onError: (callback: (event: SerialMonitorErrorEvent) => void) => () => void;
    onClose: (callback: (event: SerialMonitorCloseEvent) => void) => () => void;
  };
  serialPort: {
    listBlockers: (payload: { port: string }) => Promise<Result<{ port: string; platform: string; supported: boolean; blockers: SerialPortBlocker[]; message?: string }>>;
    terminateBlocker: (payload: { port: string; blockerId: string }) => Promise<Result<{ port: string; blockerId: string; pid?: number }>>;
  };
};

declare global {
  interface Window {
    tantalum: DesktopApi;
  }
}

export {};

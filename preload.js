const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

function readCloudConfig() {
  try {
    const result = ipcRenderer.sendSync("app:get-cloud-config-sync");
    if (result && typeof result === "object" && !("error" in result)) {
      return result;
    }
  } catch (error) {
    console.error("Unable to load renderer cloud config:", error);
  }

  return undefined;
}

contextBridge.exposeInMainWorld("tantalum", {
  app: {
    cloudConfig: readCloudConfig(),
    getInfo: () => ipcRenderer.invoke("app:get-info"),
    controlWindow: (action) => ipcRenderer.invoke("app:window-control", action),
    dispatchMenuAction: (action) => ipcRenderer.invoke("app:dispatch-menu-action", action),
    onMenuAction: (callback) => subscribe("app:menu-action", callback)
  },
  notifications: {
    list: () => ipcRenderer.invoke("notifications:list"),
    upsert: (notification) => ipcRenderer.invoke("notifications:upsert", notification),
    clear: () => ipcRenderer.invoke("notifications:clear"),
    onChanged: (callback) => subscribe("notifications:changed", callback)
  },
  agent: {
    getStatus: () => ipcRenderer.invoke("agent:get-status"),
    route: (payload) => ipcRenderer.invoke("agent:route", payload),
    run: (payload) => ipcRenderer.invoke("agent:run", payload),
    stop: (payload) => ipcRenderer.invoke("agent:stop", payload),
    resolveApproval: (payload) => ipcRenderer.invoke("agent:resolve-approval", payload),
    onProgress: (callback) => subscribe("agent:progress", callback),
    tools: {
      listSettings: () => ipcRenderer.invoke("agent:tools:list-settings"),
      updateSettings: (payload) => ipcRenderer.invoke("agent:tools:update-settings", payload),
      onSettingsChanged: (callback) => subscribe("agent:tools-settings-changed", callback),
      onProgress: (callback) => subscribe("agent:tool-progress", callback),
    },
  },
  cloud: {
    auth: {
      getCurrentUser: () => ipcRenderer.invoke("cloud:auth:get-current-user"),
      signIn: (payload) => ipcRenderer.invoke("cloud:auth:sign-in", payload),
      register: (payload) => ipcRenderer.invoke("cloud:auth:register", payload),
      signOut: () => ipcRenderer.invoke("cloud:auth:sign-out")
    },
    databases: {
      listDocuments: (payload) => ipcRenderer.invoke("cloud:databases:list-documents", payload),
      createDocument: (payload) => ipcRenderer.invoke("cloud:databases:create-document", payload),
      updateDocument: (payload) => ipcRenderer.invoke("cloud:databases:update-document", payload),
      deleteDocument: (payload) => ipcRenderer.invoke("cloud:databases:delete-document", payload)
    },
    storage: {
      createFile: (payload) => ipcRenderer.invoke("cloud:storage:create-file", payload),
      deleteFile: (payload) => ipcRenderer.invoke("cloud:storage:delete-file", payload),
      onUploadProgress: (callback) => subscribe("cloud:storage-upload-progress", callback)
    },
    functions: {
      createExecution: (payload) => ipcRenderer.invoke("cloud:functions:create-execution", payload)
    }
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
    openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath)
  },
  fileTree: {
    showContextMenu: (payload) => ipcRenderer.invoke("file-tree:show-context-menu", payload)
  },
  fs: {
    openFolder: () => ipcRenderer.invoke("fs:open-folder"),
    openFile: () => ipcRenderer.invoke("fs:open-file"),
    setWorkspace: (folderPath) => ipcRenderer.invoke("fs:set-workspace", folderPath),
    getLastWorkspace: () => ipcRenderer.invoke("fs:get-last-workspace"),
    getRecentWorkspaces: () => ipcRenderer.invoke("fs:get-recent-workspaces"),
    getRecentFiles: () => ipcRenderer.invoke("fs:get-recent-files"),
    showSaveDialog: (options) => ipcRenderer.invoke("fs:show-save-dialog", options),
    readDirectory: (dirPath) => ipcRenderer.invoke("fs:read-directory", dirPath),
    readFile: (filePath) => ipcRenderer.invoke("fs:read-file", filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke("fs:write-file", { filePath, content }),
    createFile: (folderPath, fileName, content) => ipcRenderer.invoke("fs:create-file", { folderPath, fileName, content }),
    createFolder: (parentPath, folderName) => ipcRenderer.invoke("fs:create-folder", { parentPath, folderName }),
    rename: (oldPath, newPath) => ipcRenderer.invoke("fs:rename", { oldPath, newPath }),
    deletePath: (targetPath) => ipcRenderer.invoke("fs:delete", targetPath),
    addRecentFile: (filePath) => ipcRenderer.invoke("workspace:add-recent-file", filePath)
  },
  workspace: {
    search: (payload) => ipcRenderer.invoke("workspace:search", payload),
    suggestContextFiles: (payload) => ipcRenderer.invoke("workspace:suggest-context-files", payload),
    readContextFile: (payload) => ipcRenderer.invoke("workspace:read-context-file", payload),
    pickContextAttachments: () => ipcRenderer.invoke("workspace:pick-context-attachments"),
    previewReplace: (payload) => ipcRenderer.invoke("workspace:preview-replace", payload),
    applyReplace: (payload) => ipcRenderer.invoke("workspace:apply-replace", payload)
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    add: (projectPath) => ipcRenderer.invoke("projects:add", projectPath),
    pickFolder: () => ipcRenderer.invoke("projects:pick-folder"),
    remove: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
    update: (projectId, patch) => ipcRenderer.invoke("projects:update", projectId, patch),
    inspect: (projectId) => ipcRenderer.invoke("projects:inspect", projectId)
  },
  git: {
    getStatus: () => ipcRenderer.invoke("git:get-status"),
    getDiff: (payload) => ipcRenderer.invoke("git:get-diff", payload),
    stage: (payload) => ipcRenderer.invoke("git:stage", payload),
    unstage: (payload) => ipcRenderer.invoke("git:unstage", payload),
    discard: (payload) => ipcRenderer.invoke("git:discard", payload),
    commit: (payload) => ipcRenderer.invoke("git:commit", payload),
    fetch: () => ipcRenderer.invoke("git:fetch"),
    pull: () => ipcRenderer.invoke("git:pull"),
    push: () => ipcRenderer.invoke("git:push"),
    listBranches: () => ipcRenderer.invoke("git:list-branches"),
    checkoutBranch: (payload) => ipcRenderer.invoke("git:checkout-branch", payload),
    createBranch: (payload) => ipcRenderer.invoke("git:create-branch", payload),
    getLog: (payload) => ipcRenderer.invoke("git:get-log", payload),
    getRemotes: () => ipcRenderer.invoke("git:get-remotes"),
    repairSafeDirectory: () => ipcRenderer.invoke("git:repair-safe-directory"),
    initRepository: (payload) => ipcRenderer.invoke("git:init-repository", payload),
    publishRepository: (payload) => ipcRenderer.invoke("git:publish-repository", payload),
    getConfiguration: () => ipcRenderer.invoke("git:get-configuration"),
    setConfiguration: (payload) => ipcRenderer.invoke("git:set-configuration", payload)
  },
  secrets: {
    setBoardSecrets: (payload) => ipcRenderer.invoke("secrets:set-board", payload),
    getBoardSecrets: (boardId) => ipcRenderer.invoke("secrets:get-board", boardId),
    deleteBoardSecrets: (boardId) => ipcRenderer.invoke("secrets:delete-board", boardId)
  },
  toolchain: {
    compile: (payload) => ipcRenderer.invoke("toolchain:compile", payload),
    detectLocalBoards: (payload) => ipcRenderer.invoke("toolchain:detect-local-boards", payload),
    listLocalBoardProfiles: () => ipcRenderer.invoke("toolchain:list-local-board-profiles"),
    saveLocalBoardProfile: (payload) => ipcRenderer.invoke("toolchain:save-local-board-profile", payload),
    deleteLocalBoardProfile: (profileId) => ipcRenderer.invoke("toolchain:delete-local-board-profile", profileId),
    replaceLocalBoardProfiles: (profiles) => ipcRenderer.invoke("toolchain:replace-local-board-profiles", profiles),
    uploadLocalSketch: (payload) => ipcRenderer.invoke("toolchain:upload-local-sketch", payload),
    createSourceSnapshot: (payload) => ipcRenderer.invoke("toolchain:create-source-snapshot", payload),
    viewBoardCode: (payload) => ipcRenderer.invoke("toolchain:view-board-code", payload),
    installBoardPackage: (payload) => ipcRenderer.invoke("toolchain:install-board-package", payload),
    cancelBoardPackageInstall: (payload) => ipcRenderer.invoke("toolchain:cancel-board-package-install", payload),
    removeBoardPackage: (payload) => ipcRenderer.invoke("toolchain:remove-board-package", payload),
    listInstalledBoards: () => ipcRenderer.invoke("toolchain:list-installed-boards"),
    searchBoardPlatforms: (query) => ipcRenderer.invoke("toolchain:search-board-platforms", query),
    listInstalledPlatforms: () => ipcRenderer.invoke("toolchain:list-installed-platforms"),
    searchLibraries: (query) => ipcRenderer.invoke("toolchain:search-libraries", query),
    getFeaturedLibraries: () => ipcRenderer.invoke("toolchain:get-featured-libraries"),
    getArduinoStorage: () => ipcRenderer.invoke("toolchain:get-arduino-storage"),
    selectArduinoStorage: () => ipcRenderer.invoke("toolchain:select-arduino-storage"),
    clearArduinoStorage: () => ipcRenderer.invoke("toolchain:clear-arduino-storage"),
    getLibraryDirectory: () => ipcRenderer.invoke("toolchain:get-library-directory"),
    selectLibrarySourceFolder: (payload) => ipcRenderer.invoke("toolchain:select-library-source-folder", payload),
    migrateLibraries: (payload) => ipcRenderer.invoke("toolchain:migrate-libraries", payload),
    installLibrary: (payload) => ipcRenderer.invoke("toolchain:install-library", payload),
    cancelLibraryInstall: (payload) => ipcRenderer.invoke("toolchain:cancel-library-install", payload),
    removeLibrary: (payload) => ipcRenderer.invoke("toolchain:remove-library", payload),
    listInstalledLibraries: () => ipcRenderer.invoke("toolchain:list-installed-libraries"),
    listPorts: () => ipcRenderer.invoke("toolchain:list-ports"),
    provisionBoard: (payload) => ipcRenderer.invoke("toolchain:provision-board", payload),
    provisionBoardWifiUsb: (payload) => ipcRenderer.invoke("toolchain:provision-board-wifi-usb", payload),
    installEsp32Support: () => ipcRenderer.invoke("toolchain:install-esp32-support"),
    onCompileProgress: (callback) => subscribe("toolchain:compile-progress", callback),
    onInstallProgress: (callback) => subscribe("toolchain:install-progress", callback),
    onUsbUploadProgress: (callback) => subscribe("toolchain:usb-upload-progress", callback),
    onBoardCodeProgress: (callback) => subscribe("toolchain:board-code-progress", callback),
    onLibraryInstallProgress: (callback) => subscribe("toolchain:library-install-progress", callback),
    onLibraryMigrationProgress: (callback) => subscribe("toolchain:library-migration-progress", callback)
  },
  terminal: {
    create: (options) => ipcRenderer.invoke("terminal:create", options),
    close: (sessionId) => ipcRenderer.invoke("terminal:close", sessionId),
    navigate: (payload) => ipcRenderer.invoke("terminal:navigate", payload),
    write: (payload) => ipcRenderer.send("terminal:write", payload),
    resize: (payload) => ipcRenderer.send("terminal:resize", payload),
    onData: (callback) => subscribe("terminal:data", callback),
    onExit: (callback) => subscribe("terminal:exit", callback)
  },
  serialMonitor: {
    open: (options) => ipcRenderer.invoke("serial-monitor:open", options),
    close: (sessionId) => ipcRenderer.invoke("serial-monitor:close", sessionId),
    write: (payload) => ipcRenderer.send("serial-monitor:write", payload),
    onData: (callback) => subscribe("serial-monitor:data", callback),
    onError: (callback) => subscribe("serial-monitor:error", callback),
    onClose: (callback) => subscribe("serial-monitor:close", callback)
  },
  serialPort: {
    listBlockers: (payload) => ipcRenderer.invoke("serial-port:list-blockers", payload),
    terminateBlocker: (payload) => ipcRenderer.invoke("serial-port:terminate-blocker", payload)
  }
});

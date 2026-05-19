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
    onMenuAction: (callback) => subscribe("app:menu-action", callback)
  },
  agent: {
    getStatus: () => ipcRenderer.invoke("agent:get-status"),
    run: (payload) => ipcRenderer.invoke("agent:run", payload),
    resolveApproval: (payload) => ipcRenderer.invoke("agent:resolve-approval", payload),
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
      deleteFile: (payload) => ipcRenderer.invoke("cloud:storage:delete-file", payload)
    },
    functions: {
      createExecution: (payload) => ipcRenderer.invoke("cloud:functions:create-execution", payload)
    }
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
    openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath)
  },
  fs: {
    openFolder: () => ipcRenderer.invoke("fs:open-folder"),
    setWorkspace: (folderPath) => ipcRenderer.invoke("fs:set-workspace", folderPath),
    getLastWorkspace: () => ipcRenderer.invoke("fs:get-last-workspace"),
    getRecentWorkspaces: () => ipcRenderer.invoke("fs:get-recent-workspaces"),
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
  secrets: {
    setBoardSecrets: (payload) => ipcRenderer.invoke("secrets:set-board", payload),
    getBoardSecrets: (boardId) => ipcRenderer.invoke("secrets:get-board", boardId),
    deleteBoardSecrets: (boardId) => ipcRenderer.invoke("secrets:delete-board", boardId)
  },
  toolchain: {
    compile: (payload) => ipcRenderer.invoke("toolchain:compile", payload),
    installBoardPackage: (payload) => ipcRenderer.invoke("toolchain:install-board-package", payload),
    removeBoardPackage: (payload) => ipcRenderer.invoke("toolchain:remove-board-package", payload),
    listInstalledBoards: () => ipcRenderer.invoke("toolchain:list-installed-boards"),
    searchBoardPlatforms: (query) => ipcRenderer.invoke("toolchain:search-board-platforms", query),
    listInstalledPlatforms: () => ipcRenderer.invoke("toolchain:list-installed-platforms"),
    searchLibraries: (query) => ipcRenderer.invoke("toolchain:search-libraries", query),
    getFeaturedLibraries: () => ipcRenderer.invoke("toolchain:get-featured-libraries"),
    installLibrary: (payload) => ipcRenderer.invoke("toolchain:install-library", payload),
    listInstalledLibraries: () => ipcRenderer.invoke("toolchain:list-installed-libraries"),
    listPorts: () => ipcRenderer.invoke("toolchain:list-ports"),
    provisionBoard: (payload) => ipcRenderer.invoke("toolchain:provision-board", payload),
    installEsp32Support: () => ipcRenderer.invoke("toolchain:install-esp32-support"),
    onInstallProgress: (callback) => subscribe("toolchain:install-progress", callback)
  },
  terminal: {
    create: (options) => ipcRenderer.invoke("terminal:create", options),
    close: (sessionId) => ipcRenderer.invoke("terminal:close", sessionId),
    navigate: (payload) => ipcRenderer.invoke("terminal:navigate", payload),
    write: (payload) => ipcRenderer.send("terminal:write", payload),
    resize: (payload) => ipcRenderer.send("terminal:resize", payload),
    onData: (callback) => subscribe("terminal:data", callback),
    onExit: (callback) => subscribe("terminal:exit", callback)
  }
});

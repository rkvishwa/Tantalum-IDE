const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  compileArduino,
  getFeaturedLibraries,
  installBoardPackage,
  installLibrary,
  listInstalledBoards,
  listInstalledLibraries,
  listInstalledPlatforms,
  removeBoardPackage,
  searchBoardPlatforms,
  searchLibraries
} = require("./arduinoHandler");
const { SecurityManager } = require("./src/agent/securityManager");
const { AgentRuntimeManager } = require("./src/agent/aiderRuntimeManager");
const { getRendererCloudConfig } = require("./src/config/runtimeCloudConfig");
const { WorkspaceScanner } = require("./src/agent/workspaceScanner");
const provisioningService = require("./src/services/provisioningService");
const appwriteManifest = require("./appwrite.config.json");

const APP_NAME = "Tantalum IDE";
const APPWRITE_ENDPOINT = String(appwriteManifest.endpoint || "https://sgp.cloud.appwrite.io/v1").replace(/\/$/, "");
const APPWRITE_PROJECT_ID = String(appwriteManifest.projectId || "");
const REACT_DIST_ENTRY = path.join(__dirname, "renderer-react", "dist", "index.html");
const DEFAULT_EDITOR_CONTENT = `// Welcome to ${APP_NAME}

void setup() {
  // Put your setup code here.
}

void loop() {
  // Put your main code here.
}
`;

let mainWindow = null;
let preferenceStore = null;
let secretStore = null;
let currentWorkspace = null;
let terminalSessionCounter = 0;
let rendererServer = null;
let rendererServerUrl = null;
const trustedRoots = new Set();
const terminalSessions = new Map();
const workspaceScanner = new WorkspaceScanner();
const securityManager = new SecurityManager();
const agentRuntimeManager = new AgentRuntimeManager({
  app,
  getWorkspaceRoot: () => currentWorkspace,
  executeGatewayRequest: executeAgentGatewayRequest,
  securityManager,
  markWorkspaceDirty,
  addRecentFile,
});

let pty = null;
try {
  pty = require("node-pty");
} catch (error) {
  console.warn("node-pty is unavailable:", error.message);
}

function registerTrustedPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return;
  }

  const absolutePath = path.resolve(targetPath);
  trustedRoots.add(absolutePath);
}

function getRecentWorkspaces() {
  const recentWorkspaces = preferenceStore?.get("recentWorkspaces");
  const normalized = Array.isArray(recentWorkspaces)
    ? recentWorkspaces.filter((workspacePath) => {
        if (typeof workspacePath !== "string" || !fs.existsSync(workspacePath)) {
          return false;
        }

        try {
          return fs.statSync(workspacePath).isDirectory();
        } catch {
          return false;
        }
      })
    : [];

  if (normalized.length !== (recentWorkspaces?.length ?? 0)) {
    preferenceStore?.set("recentWorkspaces", normalized);
  }

  return normalized;
}

function addRecentWorkspace(workspacePath) {
  const absolutePath = path.resolve(workspacePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
    return { success: false, error: "The selected workspace no longer exists." };
  }

  const updated = [absolutePath, ...getRecentWorkspaces().filter((entry) => entry !== absolutePath)].slice(0, 10);
  preferenceStore?.set("recentWorkspaces", updated);
  return { success: true, paths: updated };
}

function setCurrentWorkspace(workspacePath) {
  const absolutePath = path.resolve(workspacePath);

  currentWorkspace = absolutePath;
  registerTrustedPath(absolutePath);
  preferenceStore?.set("lastWorkspace", absolutePath);
  addRecentWorkspace(absolutePath);
  workspaceScanner.markDirty();
}

function getRecentFiles() {
  const recentFiles = preferenceStore?.get("recentFiles");
  const normalized = Array.isArray(recentFiles)
    ? recentFiles.filter((filePath) => typeof filePath === "string" && fs.existsSync(filePath))
    : [];

  if (normalized.length !== (recentFiles?.length ?? 0)) {
    preferenceStore?.set("recentFiles", normalized);
  }

  return normalized;
}

function addRecentFile(filePath) {
  const absolutePath = path.resolve(filePath);
  registerTrustedPath(path.dirname(absolutePath));

  const updated = [absolutePath, ...getRecentFiles().filter((entry) => entry !== absolutePath)].slice(0, 10);
  preferenceStore?.set("recentFiles", updated);
  createMenu();

  return { success: true, recentFiles: updated };
}

function isPathInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isTrustedPath(targetPath) {
  const absolutePath = path.resolve(targetPath);

  if (currentWorkspace && isPathInsideRoot(absolutePath, currentWorkspace)) {
    return true;
  }

  for (const rootPath of trustedRoots) {
    if (isPathInsideRoot(absolutePath, rootPath)) {
      return true;
    }
  }

  return false;
}

function assertTrustedPath(targetPath, options = {}) {
  const { allowMissing = false, disallowWorkspaceRootDeletion = false } = options;
  const absolutePath = path.resolve(targetPath);

  if (!isTrustedPath(absolutePath)) {
    throw new Error("Blocked access to a path outside the active workspace.");
  }

  if (!allowMissing && !fs.existsSync(absolutePath)) {
    throw new Error("The requested path does not exist.");
  }

  if (disallowWorkspaceRootDeletion && currentWorkspace && absolutePath === currentWorkspace) {
    throw new Error("Deleting the active workspace root is not allowed.");
  }

  return absolutePath;
}

function toErrorResult(error) {
  return {
    success: false,
    error: error instanceof Error ? error.message : "Unexpected error"
  };
}

function markWorkspaceDirty(changedPath = currentWorkspace) {
  if (!currentWorkspace) {
    return workspaceScanner.getRevision();
  }

  if (changedPath) {
    const absolutePath = path.resolve(changedPath);
    if (!isPathInsideRoot(absolutePath, currentWorkspace)) {
      return workspaceScanner.getRevision();
    }
  }

  return workspaceScanner.markDirty();
}

function toWorkspaceRelativePath(absolutePath) {
  if (!currentWorkspace) {
    return absolutePath;
  }

  const relativePath = path.relative(currentWorkspace, absolutePath);
  return relativePath && relativePath.length > 0 ? relativePath : ".";
}

function serializeApproval(approval) {
  return {
    requestId: approval.requestId,
    createdAt: approval.createdAt,
    toolName: approval.toolName,
    summary: approval.summary,
    preview: approval.preview,
  };
}

function sendRendererEvent(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

function sendMenuAction(action) {
  sendRendererEvent("app:menu-action", action);
}

function openDocumentation(url) {
  void shell.openExternal(url);
}

function getAppwriteSessionHeaders() {
  const headers = {};
  const fallbackCookies = secretStore?.get("appwrite.sessionFallback");
  const cookieHeader = secretStore?.get("appwrite.sessionCookie");

  if (typeof fallbackCookies === "string" && fallbackCookies.length > 0) {
    headers["X-Fallback-Cookies"] = fallbackCookies;
  }

  if (typeof cookieHeader === "string" && cookieHeader.length > 0) {
    headers.Cookie = cookieHeader;
  }

  return headers;
}

function clearAppwriteSession() {
  secretStore?.delete("appwrite.sessionFallback");
  secretStore?.delete("appwrite.sessionCookie");
}

function storeAppwriteSession(response) {
  const fallbackCookies = response.headers.get("x-fallback-cookies");
  if (fallbackCookies) {
    secretStore?.set("appwrite.sessionFallback", fallbackCookies);
  }

  let cookies = [];
  if (typeof response.headers.getSetCookie === "function") {
    cookies = response.headers.getSetCookie();
  } else {
    const cookieHeaderValue = response.headers.get("set-cookie");
    if (cookieHeaderValue) {
      cookies = [cookieHeaderValue];
    }
  }

  if (Array.isArray(cookies) && cookies.length > 0) {
    const cookieHeader = cookies
      .map((value) => value.split(";")[0])
      .filter(Boolean)
      .join("; ");

    if (cookieHeader) {
      secretStore?.set("appwrite.sessionCookie", cookieHeader);
    }
  }
}

async function readAppwritePayload(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return { message: text };
}

async function appwriteRequest({ method = "GET", pathName, queries = [], body, formData, useSession = true }) {
  if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID) {
    throw new Error("Appwrite endpoint or project ID is missing from the local manifest.");
  }

  const normalizedPath = String(pathName || "").replace(/^\/+/, "");
  const url = new URL(`${APPWRITE_ENDPOINT}/${normalizedPath}`);
  const headers = {
    "X-Appwrite-Project": APPWRITE_PROJECT_ID,
    "X-Appwrite-Response-Format": "1.4.0",
  };

  if (Array.isArray(queries)) {
    queries.filter(Boolean).forEach((query) => {
      url.searchParams.append("queries[]", query);
    });
  }

  if (useSession) {
    Object.assign(headers, getAppwriteSessionHeaders());
  }

  const options = {
    method,
    headers,
  };

  if (formData) {
    options.body = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  storeAppwriteSession(response);
  const payload = await readAppwritePayload(response);

  if (!response.ok) {
    const error = new Error(payload?.message || `Appwrite request failed with status ${response.status}.`);
    error.status = response.status;
    error.type = payload?.type || "appwrite_error";
    throw error;
  }

  return payload;
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function executeAgentGatewayRequest(body) {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.agentGatewayFunctionId) {
    throw new Error("The agent gateway function is not configured.");
  }

  const execution = await appwriteRequest({
    method: "POST",
    pathName: `functions/${encodeURIComponent(cloudConfig.agentGatewayFunctionId)}/executions`,
    body: {
      body: JSON.stringify(body),
      async: false,
      path: "/chat-completions",
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  });
  const parsed = safeJsonParse(execution.responseBody || "{}", { ok: false, error: "Agent gateway returned an unreadable response." });

  if (execution.responseStatusCode >= 400 || !parsed.ok) {
    throw new Error(parsed.error || execution.responseBody || execution.errors || "Agent gateway execution failed.");
  }

  return parsed.data;
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function resolveRendererAsset(requestPath) {
  const pathname = decodeURIComponent(requestPath.split("?")[0] || "/");
  const normalizedPath = pathname === "/" ? "/index.html" : path.normalize(pathname);
  const relativePath = normalizedPath.replace(/^([/\\])+/, "");
  const candidatePath = path.resolve(path.join(path.dirname(REACT_DIST_ENTRY), relativePath));
  const distRoot = path.resolve(path.dirname(REACT_DIST_ENTRY));

  if (
    candidatePath.startsWith(distRoot) &&
    fs.existsSync(candidatePath) &&
    fs.statSync(candidatePath).isFile()
  ) {
    return candidatePath;
  }

  return REACT_DIST_ENTRY;
}

async function ensureRendererServer() {
  if (rendererServer && rendererServerUrl) {
    return rendererServerUrl;
  }

  await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const assetPath = resolveRendererAsset(request.url || "/");
        response.writeHead(200, {
          "Content-Type": contentTypeFor(assetPath),
          "Cache-Control": assetPath === REACT_DIST_ENTRY ? "no-cache" : "public, max-age=31536000, immutable",
        });
        fs.createReadStream(assetPath).pipe(response);
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : "Renderer server failed.");
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine the local renderer server address."));
        return;
      }

      rendererServer = server;
      rendererServerUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  return rendererServerUrl;
}

async function loadRenderer(window) {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    return;
  }

  if (fs.existsSync(REACT_DIST_ENTRY)) {
    const localRendererUrl = await ensureRendererServer();
    await window.loadURL(localRendererUrl);
    return;
  }

  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${APP_NAME}</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: #081420;
            color: #f4f7fb;
            font-family: ui-sans-serif, system-ui, sans-serif;
          }
          main {
            max-width: 540px;
            padding: 32px;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 20px;
            background: rgba(255,255,255,0.04);
            box-shadow: 0 24px 80px rgba(0,0,0,0.35);
          }
          h1 { margin-top: 0; }
          code {
            padding: 2px 6px;
            border-radius: 6px;
            background: rgba(255,255,255,0.08);
          }
        </style>
      </head>
      <body>
        <main>
          <h1>${APP_NAME}</h1>
          <p>The React renderer has not been built yet.</p>
          <p>Run <code>npm run build:renderer</code> and launch the app again.</p>
        </main>
      </body>
      </html>
    `)}`
  );
}

function exampleSketches() {
  return {
    Blink: `// Blink
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}`,
    BareMinimum: `void setup() {
  // put your setup code here, to run once:
}

void loop() {
  // put your main code here, to run repeatedly:
}`,
    AnalogReadSerial: `int sensorValue = 0;

void setup() {
  Serial.begin(9600);
}

void loop() {
  sensorValue = analogRead(A0);
  Serial.println(sensorValue);
  delay(100);
}`
  };
}

function createMenu() {
  const isMac = process.platform === "darwin";

  const recentFilesSubmenu = getRecentFiles().length
    ? [
        ...getRecentFiles().map((filePath) => ({
          label: path.basename(filePath),
          click: () => {
            registerTrustedPath(path.dirname(filePath));
            sendMenuAction({ type: "open-recent-file", filePath });
          }
        })),
        { type: "separator" },
        {
          label: "Clear Recent",
          click: () => {
            preferenceStore?.set("recentFiles", []);
            createMenu();
          }
        }
      ]
    : [{ label: "No Recent Files", enabled: false }];

  const examplesSubmenu = Object.entries(exampleSketches()).map(([name, content]) => ({
    label: name,
    click: () => sendMenuAction({ type: "load-example", name, content })
  }));

  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New", accelerator: "CmdOrCtrl+N", click: () => sendMenuAction({ type: "new-file" }) },
        { label: "Open Folder...", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction({ type: "open-folder" }) },
        { label: "Open Recent", submenu: recentFilesSubmenu },
        { label: "Examples", submenu: examplesSubmenu },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenuAction({ type: "save-file" }) },
        { label: "Save As...", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenuAction({ type: "save-file-as" }) },
        { type: "separator" },
        { label: "Show Sketch Folder", accelerator: "CmdOrCtrl+K", click: () => sendMenuAction({ type: "show-sketch-folder" }) },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Comment / Uncomment", accelerator: "CmdOrCtrl+/", click: () => sendMenuAction({ type: "toggle-comment" }) },
        { label: "Find", accelerator: "CmdOrCtrl+F", click: () => sendMenuAction({ type: "find" }) },
        { label: "Find Next", accelerator: "CmdOrCtrl+G", click: () => sendMenuAction({ type: "find-next" }) },
        { label: "Find Previous", accelerator: "CmdOrCtrl+Shift+G", click: () => sendMenuAction({ type: "find-previous" }) }
      ]
    },
    {
      label: "Sketch",
      submenu: [
        { label: "Verify / Compile", accelerator: "CmdOrCtrl+R", click: () => sendMenuAction({ type: "compile" }) },
        { label: "Upload OTA Firmware", accelerator: "CmdOrCtrl+U", click: () => sendMenuAction({ type: "upload-cloud" }) },
        { type: "separator" },
        { label: "Manage Libraries...", click: () => sendMenuAction({ type: "open-library-manager" }) },
        { label: "Boards Manager...", click: () => sendMenuAction({ type: "open-board-manager" }) },
        { label: "Install ESP32 Support", click: () => sendMenuAction({ type: "install-esp32-support" }) }
      ]
    },
    {
      label: "Tools",
      submenu: [
        { label: "Auto Format", accelerator: "CmdOrCtrl+T", click: () => sendMenuAction({ type: "format-document" }) },
        { label: "Serial / Terminal", accelerator: "CmdOrCtrl+Shift+M", click: () => sendMenuAction({ type: "toggle-terminal" }) }
      ]
    },
    {
      label: "Help",
      submenu: [
        { label: "Getting Started", click: () => openDocumentation("https://docs.arduino.cc/learn/starting-guide/getting-started-arduino") },
        { label: "Arduino Reference", click: () => openDocumentation("https://www.arduino.cc/reference/en/") },
        { type: "separator" },
        { label: `About ${APP_NAME}`, click: () => sendMenuAction({ type: "about" }) }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(null);
}

function getDefaultTerminalCwd() {
  const homePath = app.getPath("home") || process.cwd();
  return path.parse(homePath).root || process.cwd();
}

function resolveTerminalWorkingDirectory(targetPath) {
  const candidatePath = typeof targetPath === "string" && targetPath.trim().length > 0 ? path.resolve(targetPath) : getDefaultTerminalCwd();

  if (!fs.existsSync(candidatePath)) {
    throw new Error("The requested terminal folder does not exist.");
  }

  const stats = fs.statSync(candidatePath);
  return stats.isDirectory() ? candidatePath : path.dirname(candidatePath);
}

function createTerminalSessionId() {
  terminalSessionCounter += 1;
  return `terminal-${terminalSessionCounter}`;
}

function buildTerminalNavigationCommand(shellBinary, targetPath) {
  const normalizedShell = String(shellBinary || "").toLowerCase();

  if (process.platform === "win32") {
    if (normalizedShell.includes("powershell") || normalizedShell.includes("pwsh")) {
      return `Set-Location -LiteralPath '${targetPath.replace(/'/g, "''")}'\r`;
    }

    return `cd /d "${targetPath.replace(/"/g, '""')}"\r`;
  }

  return `cd -- '${targetPath.replace(/'/g, "'\\''")}'\r`;
}

function disposeTerminalSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return false;
  }

  try {
    session.ptyProcess.kill();
  } catch (error) {
    console.warn(`Failed to terminate terminal ${sessionId}:`, error.message);
  } finally {
    terminalSessions.delete(sessionId);
  }

  return true;
}

function disposeAllTerminalSessions() {
  for (const sessionId of [...terminalSessions.keys()]) {
    disposeTerminalSession(sessionId);
  }
}

async function initializeStores() {
  const Store = (await import("electron-store")).default;

  preferenceStore = new Store({ name: "tantalum-preferences" });
  secretStore = new Store({ name: "tantalum-device-secrets" });

  const lastWorkspace = preferenceStore.get("lastWorkspace");
  if (typeof lastWorkspace === "string" && fs.existsSync(lastWorkspace)) {
    setCurrentWorkspace(lastWorkspace);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 760,
    title: APP_NAME,
    backgroundColor: "#1e1e1e",
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[renderer] did-finish-load");
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error("[renderer] did-fail-load", {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const prefix = `[renderer console:${level}]`;
    if (level >= 2) {
      console.error(prefix, message, sourceId ? `(${sourceId}:${line})` : "");
      return;
    }

    console.log(prefix, message, sourceId ? `(${sourceId}:${line})` : "");
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[renderer] render-process-gone", details);
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[renderer] preload-error", preloadPath, error);
  });

  mainWindow.on("unresponsive", () => {
    console.error("[renderer] window became unresponsive");
  });

  void loadRenderer(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    disposeAllTerminalSessions();
    mainWindow = null;
  });

  createMenu();
}

ipcMain.handle("app:get-info", async () => ({
  success: true,
  appName: APP_NAME,
  version: app.getVersion(),
  platform: process.platform
}));

ipcMain.handle("app:window-control", async (event, action) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow) {
    return { success: false, error: "Window is unavailable." };
  }

  switch (action) {
    case "minimize":
      targetWindow.minimize();
      return { success: true };
    case "maximize":
      if (targetWindow.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow.maximize();
      }
      return { success: true };
    case "close":
      targetWindow.close();
      return { success: true };
    default:
      return { success: false, error: "Unknown window control action." };
  }
});

ipcMain.on("app:get-cloud-config-sync", (event) => {
  try {
    event.returnValue = getRendererCloudConfig();
  } catch (error) {
    event.returnValue = {
      error: error instanceof Error ? error.message : "Unable to read cloud configuration.",
    };
  }
});

ipcMain.handle("agent:get-status", async () => {
  try {
    const status = await agentRuntimeManager.getStatus();
    return { success: true, ...status };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("agent:run", async (_event, payload = {}) => {
  try {
    const result = await agentRuntimeManager.run(payload);
    return {
      success: true,
      ...result,
      ...(result.approval ? { approval: serializeApproval(result.approval) } : {}),
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("agent:resolve-approval", async (_event, payload = {}) => {
  try {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    if (!requestId) {
      throw new Error("requestId is required.");
    }

    const result = await agentRuntimeManager.resolveApproval(requestId, Boolean(payload.approved));
    return {
      success: true,
      toolName: result.toolName,
      output: result.output,
      meta: result.meta ?? {
        denied: result.approved === false,
      },
      approved: result.approved !== false,
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:auth:get-current-user", async () => {
  try {
    const user = await appwriteRequest({ pathName: "account" });
    return { success: true, user };
  } catch (error) {
    if (error?.status === 401) {
      clearAppwriteSession();
      return { success: true, user: null };
    }

    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:auth:sign-in", async (_event, payload) => {
  try {
    const session = await appwriteRequest({
      method: "POST",
      pathName: "account/sessions/email",
      body: {
        email: payload.email,
        password: payload.password,
      },
      useSession: false,
    });

    return { success: true, session };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:auth:register", async (_event, payload) => {
  try {
    const user = await appwriteRequest({
      method: "POST",
      pathName: "account",
      body: {
        userId: payload.userId,
        email: payload.email,
        password: payload.password,
        name: payload.name,
      },
      useSession: false,
    });

    return { success: true, user };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:auth:sign-out", async () => {
  try {
    await appwriteRequest({
      method: "DELETE",
      pathName: "account/sessions/current",
    });
  } catch (error) {
    if (error?.status !== 401) {
      return toErrorResult(error);
    }
  }

  clearAppwriteSession();
  return { success: true };
});

ipcMain.handle("cloud:databases:list-documents", async (_event, payload) => {
  try {
    const response = await appwriteRequest({
      pathName: `databases/${encodeURIComponent(payload.databaseId)}/collections/${encodeURIComponent(payload.collectionId)}/documents`,
      queries: payload.queries,
    });

    return {
      success: true,
      total: response.total ?? 0,
      documents: Array.isArray(response.documents) ? response.documents : [],
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:databases:create-document", async (_event, payload) => {
  try {
    const document = await appwriteRequest({
      method: "POST",
      pathName: `databases/${encodeURIComponent(payload.databaseId)}/collections/${encodeURIComponent(payload.collectionId)}/documents`,
      body: {
        documentId: payload.documentId,
        data: payload.data,
        permissions: payload.permissions,
      },
    });

    return { success: true, document };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:databases:update-document", async (_event, payload) => {
  try {
    const document = await appwriteRequest({
      method: "PATCH",
      pathName: `databases/${encodeURIComponent(payload.databaseId)}/collections/${encodeURIComponent(payload.collectionId)}/documents/${encodeURIComponent(payload.documentId)}`,
      body: {
        data: payload.data,
        permissions: payload.permissions,
      },
    });

    return { success: true, document };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:databases:delete-document", async (_event, payload) => {
  try {
    await appwriteRequest({
      method: "DELETE",
      pathName: `databases/${encodeURIComponent(payload.databaseId)}/collections/${encodeURIComponent(payload.collectionId)}/documents/${encodeURIComponent(payload.documentId)}`,
    });

    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:storage:create-file", async (_event, payload) => {
  try {
    const formData = new FormData();
    const fileBuffer = Buffer.from(payload.base64, "base64");

    formData.append("fileId", payload.fileId);
    formData.append("file", new Blob([fileBuffer], { type: payload.contentType || "application/octet-stream" }), payload.filename);

    if (Array.isArray(payload.permissions)) {
      payload.permissions.forEach((permission) => {
        formData.append("permissions[]", permission);
      });
    }

    const file = await appwriteRequest({
      method: "POST",
      pathName: `storage/buckets/${encodeURIComponent(payload.bucketId)}/files`,
      formData,
    });

    return { success: true, file };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:storage:delete-file", async (_event, payload) => {
  try {
    await appwriteRequest({
      method: "DELETE",
      pathName: `storage/buckets/${encodeURIComponent(payload.bucketId)}/files/${encodeURIComponent(payload.fileId)}`,
    });

    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:functions:create-execution", async (_event, payload) => {
  try {
    const execution = await appwriteRequest({
      method: "POST",
      pathName: `functions/${encodeURIComponent(payload.functionId)}/executions`,
      body: {
        body: payload.body,
        async: Boolean(payload.async),
        path: payload.pathName ?? "/",
        method: payload.method ?? "POST",
        headers: payload.headers ?? { "content-type": "application/json" },
      },
    });

    return { success: true, execution };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("shell:open-external", async (_event, targetUrl) => {
  try {
    const parsedUrl = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are allowed.");
    }

    await shell.openExternal(parsedUrl.toString());
    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("shell:open-path", async (_event, targetPath) => {
  try {
    const absolutePath = assertTrustedPath(targetPath);
    const response = await shell.openPath(absolutePath);

    if (response) {
      throw new Error(response);
    }

    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:open-folder", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const selectedPath = result.filePaths[0];
    setCurrentWorkspace(selectedPath);

    return { success: true, path: selectedPath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:set-workspace", async (_event, folderPath) => {
  try {
    const absolutePath = path.resolve(folderPath);
    const stats = await fsPromises.stat(absolutePath);

    if (!stats.isDirectory()) {
      throw new Error("Workspace path must be a directory.");
    }

    setCurrentWorkspace(absolutePath);
    return { success: true, path: absolutePath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:get-last-workspace", async () => {
  try {
    if (!currentWorkspace) {
      return { success: false };
    }

    await fsPromises.access(currentWorkspace);
    return { success: true, path: currentWorkspace };
  } catch {
    return { success: false };
  }
});

ipcMain.handle("fs:get-recent-workspaces", async () => {
  try {
    return { success: true, paths: getRecentWorkspaces() };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:show-save-dialog", async (_event, options = {}) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: options.defaultPath,
      filters: options.filters
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    registerTrustedPath(path.dirname(result.filePath));
    return { success: true, path: result.filePath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:read-directory", async (_event, dirPath) => {
  try {
    const absolutePath = assertTrustedPath(dirPath);
    const entries = await fsPromises.readdir(absolutePath, { withFileTypes: true });

    const items = entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist")
      .map((entry) => {
        const fullPath = path.join(absolutePath, entry.name);
        const isDirectory = entry.isDirectory();

        return {
          name: entry.name,
          path: fullPath,
          isDirectory,
          extension: isDirectory ? null : path.extname(entry.name).toLowerCase()
        };
      })
      .sort((left, right) => {
        if (left.isDirectory && !right.isDirectory) {
          return -1;
        }

        if (!left.isDirectory && right.isDirectory) {
          return 1;
        }

        return left.name.localeCompare(right.name);
      });

    return { success: true, items };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:read-file", async (_event, filePath) => {
  try {
    const absolutePath = assertTrustedPath(filePath);
    const content = await fsPromises.readFile(absolutePath, "utf8");

    return { success: true, path: absolutePath, content };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:write-file", async (_event, payload) => {
  try {
    const absolutePath = assertTrustedPath(payload.filePath);
    await fsPromises.writeFile(absolutePath, payload.content, "utf8");

    addRecentFile(absolutePath);
    markWorkspaceDirty(absolutePath);
    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:create-file", async (_event, payload) => {
  try {
    const folderPath = assertTrustedPath(payload.folderPath);
    const targetPath = assertTrustedPath(path.join(folderPath, payload.fileName), { allowMissing: true });

    if (fs.existsSync(targetPath)) {
      throw new Error("A file with that name already exists.");
    }

    await fsPromises.writeFile(targetPath, payload.content ?? "", "utf8");
    addRecentFile(targetPath);
    markWorkspaceDirty(targetPath);

    return { success: true, path: targetPath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:create-folder", async (_event, payload) => {
  try {
    const parentPath = assertTrustedPath(payload.parentPath);
    const targetPath = assertTrustedPath(path.join(parentPath, payload.folderName), { allowMissing: true });

    if (fs.existsSync(targetPath)) {
      throw new Error("A folder with that name already exists.");
    }

    await fsPromises.mkdir(targetPath, { recursive: false });
    markWorkspaceDirty(targetPath);
    return { success: true, path: targetPath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:rename", async (_event, payload) => {
  try {
    const oldPath = assertTrustedPath(payload.oldPath);
    const newPath = assertTrustedPath(payload.newPath, { allowMissing: true });

    if (fs.existsSync(newPath)) {
      throw new Error("The destination path already exists.");
    }

    await fsPromises.rename(oldPath, newPath);
    markWorkspaceDirty(newPath);
    return { success: true, path: newPath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:delete", async (_event, targetPath) => {
  try {
    const absolutePath = assertTrustedPath(targetPath, {
      disallowWorkspaceRootDeletion: true
    });

    const stats = await fsPromises.stat(absolutePath);
    if (stats.isDirectory()) {
      await fsPromises.rm(absolutePath, { recursive: true, force: false });
    } else {
      await fsPromises.unlink(absolutePath);
    }

    markWorkspaceDirty(absolutePath);
    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("workspace:add-recent-file", async (_event, filePath) => {
  try {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error("The selected file no longer exists.");
    }

    return addRecentFile(absolutePath);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("secrets:set-board", async (_event, payload) => {
  try {
    if (!payload?.boardId) {
      throw new Error("boardId is required.");
    }

    secretStore?.set(`boards.${payload.boardId}`, {
      apiToken: payload.apiToken ?? "",
      wifiPassword: payload.wifiPassword ?? "",
      updatedAt: new Date().toISOString()
    });

    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("secrets:get-board", async (_event, boardId) => {
  try {
    if (!boardId) {
      throw new Error("boardId is required.");
    }

    const boardSecrets = secretStore?.get(`boards.${boardId}`) ?? null;
    return { success: true, secrets: boardSecrets };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("secrets:delete-board", async (_event, boardId) => {
  try {
    if (!boardId) {
      throw new Error("boardId is required.");
    }

    secretStore?.delete(`boards.${boardId}`);
    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:compile", async (_event, payload) => {
  try {
    return await compileArduino(payload.code ?? DEFAULT_EDITOR_CONTENT, payload.board ?? "arduino:avr:uno");
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:install-board-package", async (event, payload) => {
  try {
    const result = await installBoardPackage(payload.packageUrl, payload.packageName, (chunk) => {
      event.sender.send("toolchain:install-progress", chunk);
    });

    return result;
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:remove-board-package", async (event, payload) => {
  try {
    const result = await removeBoardPackage(payload.packageName, (chunk) => {
      event.sender.send("toolchain:install-progress", chunk);
    });

    return result;
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:list-installed-boards", async () => {
  try {
    return await listInstalledBoards();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:search-board-platforms", async (_event, query) => {
  try {
    return await searchBoardPlatforms(query ?? "");
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:list-installed-platforms", async () => {
  try {
    return await listInstalledPlatforms();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:search-libraries", async (_event, query) => {
  try {
    return await searchLibraries(query ?? "");
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:get-featured-libraries", async () => {
  try {
    return await getFeaturedLibraries();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:install-library", async (_event, payload) => {
  try {
    return await installLibrary(payload.name, payload.version);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:list-installed-libraries", async () => {
  try {
    return await listInstalledLibraries();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:list-ports", async () => {
  try {
    return await provisioningService.listPorts();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:provision-board", async (_event, payload) => {
  try {
    const board = payload?.board;
    const secrets = payload?.secrets;
    const appwriteConfig = payload?.appwriteConfig;
    const port = payload?.port;

    if (!board?.$id || !board?.boardType || !board?.wifiSSID) {
      throw new Error("A valid board payload is required for provisioning.");
    }

    if (!secrets?.apiToken || !secrets?.wifiPassword) {
      throw new Error("Local board secrets are missing. Re-enter the WiFi password or rotate the board token.");
    }

    if (!appwriteConfig?.endpoint || !appwriteConfig?.projectId || !appwriteConfig?.deviceGatewayFunctionId) {
      throw new Error("Appwrite function configuration is incomplete.");
    }

    return await provisioningService.provisionBoard(
      {
        ...board,
        apiToken: secrets.apiToken,
        wifiPassword: secrets.wifiPassword
      },
      port,
      appwriteConfig
    );
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:install-esp32-support", async () => {
  try {
    return await provisioningService.installBoardSupport();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("terminal:create", async (_event, options = {}) => {
  try {
    if (!pty) {
      throw new Error("The terminal runtime is unavailable because node-pty could not be loaded.");
    }

    const desiredCwd = resolveTerminalWorkingDirectory(options.cwd);
    const shellBinary =
      options.shell ||
      process.env.SHELL ||
      (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const sessionId = createTerminalSessionId();

    const terminalPty = pty.spawn(shellBinary, [], {
      name: "xterm-color",
      cols: Number.isInteger(options.cols) ? options.cols : 100,
      rows: Number.isInteger(options.rows) ? options.rows : 28,
      cwd: desiredCwd,
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    terminalSessions.set(sessionId, {
      ptyProcess: terminalPty,
      shellBinary,
      cwd: desiredCwd
    });

    terminalPty.onData((data) => {
      sendRendererEvent("terminal:data", { sessionId, data });
    });

    terminalPty.onExit((event) => {
      terminalSessions.delete(sessionId);
      sendRendererEvent("terminal:exit", {
        sessionId,
        exitCode: event.exitCode,
        signal: event.signal
      });
    });

    return { success: true, sessionId, cwd: desiredCwd, shell: shellBinary };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("terminal:close", async (_event, sessionId) => {
  try {
    if (typeof sessionId === "string" && sessionId.length > 0) {
      disposeTerminalSession(sessionId);
    }

    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("terminal:navigate", async (_event, payload = {}) => {
  try {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const session = terminalSessions.get(sessionId);

    if (!session) {
      throw new Error("The selected terminal session is no longer running.");
    }

    const desiredCwd = resolveTerminalWorkingDirectory(payload.targetPath);
    session.ptyProcess.write(buildTerminalNavigationCommand(session.shellBinary, desiredCwd));
    session.cwd = desiredCwd;

    return { success: true, cwd: desiredCwd };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.on("terminal:write", (_event, payload) => {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return;
  }

  session.ptyProcess.write(String(payload?.data ?? ""));
});

ipcMain.on("terminal:resize", (_event, payload) => {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return;
  }

  const cols = Number.isInteger(payload?.cols) ? payload.cols : 100;
  const rows = Number.isInteger(payload?.rows) ? payload.rows : 28;
  session.ptyProcess.resize(cols, rows);
});

app.whenReady().then(async () => {
  await initializeStores();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  disposeAllTerminalSessions();

  if (rendererServer) {
    rendererServer.close();
    rendererServer = null;
    rendererServerUrl = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

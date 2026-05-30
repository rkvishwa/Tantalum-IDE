const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { Permission, Query, Role } = require("appwrite");

function isBrokenPipeError(error) {
  return error?.code === "EPIPE" || /EPIPE|broken pipe/i.test(String(error?.message || ""));
}

function installSafeConsole() {
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.("error", (error) => {
      if (!isBrokenPipeError(error)) {
        return;
      }
      // Electron can outlive the launcher pipe on Windows; logging must not crash the app.
    });
  }

  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = console[method]?.bind(console);
    if (typeof original !== "function") {
      continue;
    }

    console[method] = (...args) => {
      try {
        original(...args);
      } catch (error) {
        if (!isBrokenPipeError(error)) {
          throw error;
        }
      }
    };
  }
}

installSafeConsole();

const {
  buildTantalumWifiHostname,
  compileArduino,
  configureArduinoStorageRoot,
  getFeaturedLibraries,
  getArduinoStorageInfo,
  getArduinoLibraryDirectory,
  installBoardPackage,
  installLibrary,
  listInstalledBoards,
  listInstalledLibraries,
  listInstalledPlatforms,
  migrateLibrariesFrom,
  removeBoardPackage,
  removeLibrary,
  searchBoardPlatforms,
  searchLibraries,
  uploadLocalSketch
} = require("./arduinoHandler");
const { SecurityManager } = require("./src/agent/securityManager");
const { AgentRuntimeManager } = require("./src/agent/opencodeRuntimeManager");
const { AgentRestorePointStore } = require("./src/agent/restorePointStore");
const { AgentToolRegistry } = require("./src/agent/toolRegistry");
const { AgentToolExecutor } = require("./src/agent/toolExecutor");
const { deriveFunctionId, getRendererCloudConfig } = require("./src/config/runtimeCloudConfig");
const { WorkspaceScanner } = require("./src/agent/workspaceScanner");
const boardCodeService = require("./src/services/boardCodeService");
const { detectLocalBoardsDeterministic } = require("./src/services/localBoardService");
const provisioningService = require("./src/services/provisioningService");
const appwriteManifest = require("./appwrite.config.json");

const APP_NAME = "Tantalum IDE";
const APPWRITE_ENDPOINT = String(appwriteManifest.endpoint || "").replace(/\/$/, "");
const APPWRITE_PROJECT_ID = String(appwriteManifest.projectId || "");
const REACT_DIST_ENTRY = path.join(__dirname, "renderer-react", "dist", "index.html");
const DEFAULT_WORKSPACE_SKETCH_FILE = "main.ino";
const DEFAULT_EDITOR_CONTENT = `// Welcome to ${APP_NAME}

void setup() {
  // Put your setup code here.
}

void loop() {
  // Put your main code here.
}
`;
const LOCAL_BOARD_PROFILES_KEY = "localBoardProfiles";
const ARDUINO_STORAGE_ROOT_KEY = "arduinoStorageRoot";
const AGENT_TOOL_SETTINGS_KEY = "agentToolSettings";
const BOARD_DETECTION_FUNCTION_ID = deriveFunctionId(appwriteManifest, "board-detection");
const TOOLCHAIN_NOTIFICATIONS_KEY = "toolchainNotifications";
const TOOLCHAIN_NOTIFICATIONS_LIMIT = 100;
const BOARD_CODE_EXTRACTION_MODES = new Set(["restore-first", "force-hardware-reconstruct", "force-hardware-artifacts"]);
const SOURCE_MARKER_STATUS_PENDING = "pending";
const SOURCE_MARKER_STATUS_CURRENT = "current";
const SOURCE_MARKER_STATUS_PREVIOUS = "previous";
const SOURCE_MARKER_ALLOWED_RESTORE_STATUSES = new Set([SOURCE_MARKER_STATUS_CURRENT, SOURCE_MARKER_STATUS_PREVIOUS]);
const SOURCE_CODE_VISIBILITY_PRIVATE = "private";
const SOURCE_CODE_VISIBILITY_PUBLIC = "public";
const SOURCE_CODE_VISIBILITIES = new Set([SOURCE_CODE_VISIBILITY_PRIVATE, SOURCE_CODE_VISIBILITY_PUBLIC]);
const SOURCE_MARKER_FLASH_VIA_USB = "usb";
const SOURCE_MARKER_FLASH_VIA_OTA = "ota";

let mainWindow = null;
let preferenceStore = null;
let secretStore = null;
let currentWorkspace = null;
let terminalSessionCounter = 0;
let serialMonitorSessionCounter = 0;
let rendererServer = null;
let rendererServerUrl = null;
const trustedRoots = new Set();
const terminalSessions = new Map();
const serialMonitorSessions = new Map();
const activeSerialMonitorPorts = new Map();
const activeBoardPackageInstalls = new Map();
const activeLibraryInstallOperations = new Map();
const activeLocalUploadPorts = new Set();
const activeBoardCodePorts = new Set();
const workspaceScanner = new WorkspaceScanner();
const securityManager = new SecurityManager();
const agentToolRegistry = new AgentToolRegistry();
const agentToolExecutor = new AgentToolExecutor({
  registry: agentToolRegistry,
  getSettings: getAgentToolSettings,
  getWorkspaceRoot: () => currentWorkspace,
  compileArduino,
  uploadLocalSketch: uploadLocalSketchForAgent,
  installLibrary,
  installBoardPackage,
  listInstalledLibraries,
  listInstalledPlatforms,
  registerLibraryInstall: (installId, controller, metadata = {}) => {
    activeLibraryInstallOperations.set(installId, {
      controller,
      sender: { send: (channel, payload) => sendRendererEvent(channel, payload) },
      name: metadata.name,
      version: metadata.version,
    });
  },
  unregisterLibraryInstall: (installId) => activeLibraryInstallOperations.delete(installId),
  registerBoardPackageInstall: (installId, controller) => activeBoardPackageInstalls.set(installId, controller),
  unregisterBoardPackageInstall: (installId) => activeBoardPackageInstalls.delete(installId),
  emitToolchainEvent: (channel, payload) => sendRendererEvent(channel, payload),
  emitProgress: (event) => sendRendererEvent("agent:tool-progress", event),
  upsertNotification: upsertToolchainNotification,
  uploadCloudFirmware: uploadCloudFirmwareFromAgent,
  git: {
    getStatus: getGitStatus,
    getDiff: getAgentGitDiff,
    getLog: getGitLog,
    stage: stageGitPathsForAgent,
    commit: commitGitForAgent,
    branch: branchGitForAgent,
    pull: pullGitForAgent,
    push: pushGitForAgent,
    discard: discardGitPaths,
    publish: publishGitRepository,
  },
});
const agentRuntimeManager = new AgentRuntimeManager({
  app,
  getWorkspaceRoot: () => currentWorkspace,
  executeGatewayRequest: executeAgentGatewayRequest,
  securityManager,
  markWorkspaceDirty,
  addRecentFile,
  toolRegistry: agentToolRegistry,
  toolExecutor: agentToolExecutor,
  getAgentToolSettings,
  listInstalledLibraries,
  emitProgress: (event) => sendRendererEvent("agent:progress", event),
});
const agentRestorePointStore = new AgentRestorePointStore({
  app,
  getWorkspaceRoot: () => currentWorkspace,
  markWorkspaceDirty,
  addRecentFile,
});

let pty = null;
let cachedRipgrepPath = null;
try {
  pty = require("node-pty");
} catch (error) {
  console.warn("node-pty is unavailable:", error.message);
}

async function getRipgrepPath() {
  if (cachedRipgrepPath) {
    return cachedRipgrepPath;
  }

  const ripgrepModule = await import("@vscode/ripgrep");
  cachedRipgrepPath = ripgrepModule.rgPath;
  return cachedRipgrepPath;
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
    return { success: false, error: "The selected Project no longer exists." };
  }

  const updated = [absolutePath, ...getRecentWorkspaces().filter((entry) => entry !== absolutePath)].slice(0, 10);
  preferenceStore?.set("recentWorkspaces", updated);
  createMenu();
  return { success: true, paths: updated };
}

function isActiveToolchainNotificationStatus(status) {
  return status === "queued" || status === "running";
}

function normalizeToolchainNotificationStatus(status) {
  return ["queued", "running", "success", "error", "canceled", "interrupted"].includes(status) ? status : "running";
}

function normalizeToolchainNotificationKind(kind) {
  const normalized = String(kind || "").trim();
  return normalized || "toolchain-task";
}

function normalizeNotificationProgress(progress) {
  if (progress === null || progress === undefined) {
    return null;
  }

  const value = Number(progress);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, value));
}

function normalizeNotificationText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function latestToolchainProgressLine(value, fallback = "") {
  const lines = String(value || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d{1,3}(?:\.\d+)?\s*%$/.test(line));

  return normalizeNotificationText(lines.at(-1), fallback);
}

function textFromToolchainProgressPayload(value, fallback = "") {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const message = value.message || value.detail || value.phase || value.status;
    if (message) {
      return String(message);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  return String(value ?? fallback);
}

function normalizeToolchainNotification(entry, existing = null) {
  const source = entry && typeof entry === "object" ? entry : {};
  const now = Date.now();
  const id = normalizeNotificationText(source.id || existing?.id || crypto.randomUUID(), crypto.randomUUID());
  const status = normalizeToolchainNotificationStatus(source.status || existing?.status);
  const title = normalizeNotificationText(source.title || existing?.title, "Toolchain task");
  const createdAt = Number.isFinite(Number(source.createdAt ?? existing?.createdAt)) ? Number(source.createdAt ?? existing?.createdAt) : now;
  const updatedAt = Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now;
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? source.metadata
    : existing?.metadata && typeof existing.metadata === "object"
      ? existing.metadata
      : {};

  return {
    id,
    kind: normalizeToolchainNotificationKind(source.kind || existing?.kind),
    title,
    detail: normalizeNotificationText(source.detail ?? existing?.detail),
    status,
    phase: normalizeNotificationText(source.phase ?? existing?.phase, status),
    progress: normalizeNotificationProgress(source.progress !== undefined ? source.progress : existing?.progress),
    name: normalizeNotificationText(source.name ?? existing?.name),
    version: normalizeNotificationText(source.version ?? existing?.version),
    target: normalizeNotificationText(source.target ?? existing?.target),
    metadata,
    createdAt,
    updatedAt,
  };
}

function sortToolchainNotifications(notifications) {
  return [...notifications].sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

function getToolchainNotifications() {
  const stored = preferenceStore?.get(TOOLCHAIN_NOTIFICATIONS_KEY);
  const normalized = Array.isArray(stored)
    ? sortToolchainNotifications(stored.map((entry) => normalizeToolchainNotification(entry))).slice(0, TOOLCHAIN_NOTIFICATIONS_LIMIT)
    : [];

  if (preferenceStore && JSON.stringify(stored || []) !== JSON.stringify(normalized)) {
    preferenceStore.set(TOOLCHAIN_NOTIFICATIONS_KEY, normalized);
  }

  return normalized;
}

function persistToolchainNotifications(notifications) {
  const nextNotifications = sortToolchainNotifications(notifications).slice(0, TOOLCHAIN_NOTIFICATIONS_LIMIT);
  preferenceStore?.set(TOOLCHAIN_NOTIFICATIONS_KEY, nextNotifications);
  sendRendererEvent("notifications:changed", nextNotifications);
  return nextNotifications;
}

function upsertToolchainNotification(notification) {
  const current = getToolchainNotifications();
  const existing = current.find((entry) => entry.id === notification?.id) || null;
  const nextNotification = normalizeToolchainNotification(notification, existing);
  const notifications = existing
    ? current.map((entry) => (entry.id === nextNotification.id ? nextNotification : entry))
    : [nextNotification, ...current];

  const nextNotifications = persistToolchainNotifications(notifications);
  return {
    notification: nextNotifications.find((entry) => entry.id === nextNotification.id) || nextNotification,
    notifications: nextNotifications,
  };
}

function clearToolchainNotifications() {
  return persistToolchainNotifications([]);
}

function getAgentToolSettings() {
  return agentToolRegistry.normalizeSettings(preferenceStore?.get(AGENT_TOOL_SETTINGS_KEY));
}

function updateAgentToolSettings(patch = {}) {
  const current = getAgentToolSettings();
  const incomingTools = patch && typeof patch === "object" && patch.tools && typeof patch.tools === "object" ? patch.tools : {};
  const nextTools = { ...current.tools };

  for (const descriptor of agentToolRegistry.listDescriptors()) {
    if (!Object.prototype.hasOwnProperty.call(incomingTools, descriptor.id)) {
      continue;
    }

    const incoming = incomingTools[descriptor.id];
    const enabled =
      typeof incoming === "boolean"
        ? incoming
        : incoming && typeof incoming === "object" && typeof incoming.enabled === "boolean"
          ? incoming.enabled
          : nextTools[descriptor.id]?.enabled;
    nextTools[descriptor.id] = {
      enabled: descriptor.available === false ? false : Boolean(enabled),
    };
  }

  const next = agentToolRegistry.normalizeSettings({
    tools: nextTools,
    updatedAt: new Date().toISOString(),
  });
  preferenceStore?.set(AGENT_TOOL_SETTINGS_KEY, next);
  const response = agentToolRegistry.settingsResponse(next);
  sendRendererEvent("agent:tools-settings-changed", response);
  return response;
}

function interruptActiveToolchainNotifications() {
  const current = getToolchainNotifications();
  let changed = false;
  const now = Date.now();
  const next = current.map((notification) => {
    if (!isActiveToolchainNotificationStatus(notification.status)) {
      return notification;
    }

    changed = true;
    return {
      ...notification,
      status: "interrupted",
      phase: "interrupted",
      detail: notification.detail || "Task was interrupted because Tantalum IDE restarted.",
      progress: notification.progress ?? null,
      updatedAt: now,
    };
  });

  if (changed) {
    preferenceStore?.set(TOOLCHAIN_NOTIFICATIONS_KEY, sortToolchainNotifications(next).slice(0, TOOLCHAIN_NOTIFICATIONS_LIMIT));
  }
}

function normalizeBoardText(value, maxLength = 255) {
  return String(value || "").trim().slice(0, maxLength);
}

function createLocalBoardProfileId(profile) {
  const key = [
    profile?.fingerprint,
    profile?.serialNumber,
    profile?.vendorId,
    profile?.productId,
    profile?.port,
    profile?.fqbn
  ]
    .map((value) => normalizeBoardText(value).toLowerCase())
    .filter(Boolean)
    .join("|");

  return crypto.createHash("sha256").update(key || crypto.randomUUID()).digest("hex").slice(0, 18);
}

function createUniqueLocalBoardProfileId(profile, usedIds) {
  const stableId = createLocalBoardProfileId(profile);
  if (!usedIds.has(stableId)) {
    return stableId;
  }

  const baseKey = [
    profile?.fingerprint,
    profile?.serialNumber,
    profile?.pnpId,
    profile?.locationId,
    profile?.vendorId,
    profile?.productId,
    profile?.port,
    profile?.fqbn,
  ]
    .map((value) => normalizeBoardText(value).toLowerCase())
    .filter(Boolean)
    .join("|");

  for (let index = 2; index < 1000; index += 1) {
    const candidate = crypto
      .createHash("sha256")
      .update(`${baseKey || stableId}|${index}`)
      .digest("hex")
      .slice(0, 18);
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }

  return crypto.randomUUID().replace(/-/g, "").slice(0, 18);
}

function localBoardProfilePortKey(profile) {
  return normalizeBoardText(profile?.port).toLowerCase();
}

function normalizeLocalBoardProfile(entry) {
  const source = entry && typeof entry === "object" ? entry : null;
  if (!source) {
    return null;
  }

  const fqbn = normalizeBoardText(source.fqbn || source.board || source.boardType);
  const port = normalizeBoardText(source.port || source.path);
  if (!fqbn && !port) {
    return null;
  }

  const now = new Date().toISOString();
  const normalized = {
    id: normalizeBoardText(source.id, 64),
    name: normalizeBoardText(source.name),
    fqbn,
    boardLabel: normalizeBoardText(source.boardLabel || source.detectedBoardName || fqbn),
    port,
    protocol: normalizeBoardText(source.protocol || "serial", 64) || "serial",
    protocolLabel: normalizeBoardText(source.protocolLabel || "Serial", 128) || "Serial",
    manufacturer: normalizeBoardText(source.manufacturer || "Unknown"),
    vendorId: normalizeBoardText(source.vendorId, 64) || null,
    productId: normalizeBoardText(source.productId, 64) || null,
    serialNumber: normalizeBoardText(source.serialNumber, 128) || null,
    pnpId: normalizeBoardText(source.pnpId, 255) || null,
    locationId: normalizeBoardText(source.locationId, 128) || null,
    fingerprint: normalizeBoardText(source.fingerprint, 128),
    confidence: Number.isFinite(Number(source.confidence)) ? Number(source.confidence) : null,
    connected: Boolean(source.connected),
    cloudBoardId: normalizeBoardText(source.cloudBoardId, 128),
    cloudLinkedAt: normalizeBoardText(source.cloudLinkedAt, 64),
    lastCloudProvisionedAt: normalizeBoardText(source.lastCloudProvisionedAt, 64),
    lastCloudUsbUploadAt: normalizeBoardText(source.lastCloudUsbUploadAt, 64),
    sourceCodeVisibility: normalizeSourceCodeVisibility(source.sourceCodeVisibility),
    createdAt: normalizeBoardText(source.createdAt, 64) || now,
    updatedAt: now
  };

  normalized.id = normalized.id || createLocalBoardProfileId(normalized);
  normalized.fingerprint = normalized.fingerprint || createLocalBoardProfileId(normalized);
  return normalized;
}

function getLocalBoardProfiles() {
  const storedProfiles = preferenceStore?.get(LOCAL_BOARD_PROFILES_KEY);
  const seen = new Set();
  const normalized = Array.isArray(storedProfiles)
    ? storedProfiles
        .map(normalizeLocalBoardProfile)
        .filter((profile) => {
          if (!profile || seen.has(profile.id)) {
            return false;
          }

          seen.add(profile.id);
          return true;
        })
    : [];

  preferenceStore?.set(LOCAL_BOARD_PROFILES_KEY, normalized);
  return normalized;
}

function findLocalBoardProfileMatch(profile, profiles, usedIds = new Set(), allowVidPidFallback = false) {
  const availableProfiles = profiles.filter((entry) => !usedIds.has(entry.id));
  const strongMatch = availableProfiles.find((entry) => {
    return (
      entry.id === profile.id ||
      (profile.fingerprint && entry.fingerprint === profile.fingerprint) ||
      (profile.serialNumber && entry.serialNumber === profile.serialNumber) ||
      (profile.pnpId && entry.pnpId === profile.pnpId) ||
      (profile.locationId && entry.locationId === profile.locationId) ||
      (profile.port && entry.port === profile.port)
    );
  });

  if (strongMatch || !allowVidPidFallback) {
    return strongMatch || null;
  }

  if (profile.vendorId && profile.productId) {
    const vidPidMatches = availableProfiles.filter((entry) => entry.vendorId === profile.vendorId && entry.productId === profile.productId);
    if (vidPidMatches.length === 1) {
      return vidPidMatches[0];
    }
  }

  const cloudLinkedTypeMatches = availableProfiles.filter((entry) => {
    return Boolean(entry.cloudBoardId && profile.fqbn && entry.fqbn === profile.fqbn);
  });
  return cloudLinkedTypeMatches.length === 1 ? cloudLinkedTypeMatches[0] : null;
}

function saveLocalBoardProfile(profile) {
  const normalized = normalizeLocalBoardProfile(profile);
  if (!normalized?.fqbn) {
    throw new Error("Choose a board type before saving this local board.");
  }

  if (!normalized.port) {
    throw new Error("Choose a port before saving this local board.");
  }

  const profiles = getLocalBoardProfiles();
  const existingProfile = findLocalBoardProfileMatch(normalized, profiles, new Set(), true);
  const existingIndex = existingProfile ? profiles.findIndex((entry) => entry.id === existingProfile.id) : -1;

  const nextProfile =
    existingIndex >= 0
      ? preserveLocalBoardCloudLink({
          ...profiles[existingIndex],
          ...normalized,
          id: profiles[existingIndex].id,
          createdAt: profiles[existingIndex].createdAt,
          updatedAt: new Date().toISOString(),
        }, profiles[existingIndex], profile)
      : normalized;
  const nextProfiles =
    existingIndex >= 0
      ? profiles.map((entry, index) => (index === existingIndex ? nextProfile : entry))
      : [nextProfile, ...profiles];

  preferenceStore?.set(LOCAL_BOARD_PROFILES_KEY, nextProfiles);
  return nextProfile;
}

function preserveLocalBoardCloudLink(nextProfile, existingProfile, sourceProfile) {
  if (!existingProfile || !sourceProfile || typeof sourceProfile !== "object") {
    return nextProfile;
  }

  for (const key of ["cloudBoardId", "cloudLinkedAt", "lastCloudProvisionedAt", "lastCloudUsbUploadAt"]) {
    if (!Object.prototype.hasOwnProperty.call(sourceProfile, key)) {
      nextProfile[key] = existingProfile[key] || "";
    }
  }

  return nextProfile;
}

function deleteLocalBoardProfile(profileId) {
  const id = normalizeBoardText(profileId, 64);
  if (!id) {
    throw new Error("A local board profile ID is required.");
  }

  const nextProfiles = getLocalBoardProfiles().filter((profile) => profile.id !== id);
  preferenceStore?.set(LOCAL_BOARD_PROFILES_KEY, nextProfiles);
  return nextProfiles;
}

function replaceLocalBoardProfiles(profiles) {
  if (!Array.isArray(profiles)) {
    throw new Error("Local board profiles must be an array.");
  }

  const existingProfiles = getLocalBoardProfiles();
  const nextProfiles = [];
  const seen = new Set();
  const seenPorts = new Set();
  const usedExistingIds = new Set();

  for (const profile of profiles) {
    const normalized = normalizeLocalBoardProfile(profile);
    if (!normalized?.port) {
      continue;
    }

    const existingProfile = findLocalBoardProfileMatch(normalized, existingProfiles, usedExistingIds, true);
    let nextProfile = existingProfile
      ? preserveLocalBoardCloudLink({
          ...existingProfile,
          ...normalized,
          id: existingProfile.id,
          name: normalized.name || existingProfile.name,
          createdAt: existingProfile.createdAt,
          updatedAt: new Date().toISOString(),
        }, existingProfile, profile)
      : normalized;
    const portKey = localBoardProfilePortKey(nextProfile);
    if (portKey && seenPorts.has(portKey)) {
      continue;
    }

    if (seen.has(nextProfile.id)) {
      nextProfile = {
        ...nextProfile,
        id: createUniqueLocalBoardProfileId(nextProfile, seen),
        createdAt: normalized.createdAt,
        updatedAt: new Date().toISOString(),
      };
    }

    if (!seen.has(nextProfile.id)) {
      seen.add(nextProfile.id);
      if (portKey) {
        seenPorts.add(portKey);
      }
      if (existingProfile) {
        usedExistingIds.add(existingProfile.id);
      }
      nextProfiles.push(nextProfile);
    }
  }

  for (const existingProfile of existingProfiles) {
    if (!existingProfile.cloudBoardId || usedExistingIds.has(existingProfile.id) || seen.has(existingProfile.id)) {
      continue;
    }

    seen.add(existingProfile.id);
    nextProfiles.push({
      ...existingProfile,
      connected: false,
      updatedAt: new Date().toISOString(),
    });
  }

  preferenceStore?.set(LOCAL_BOARD_PROFILES_KEY, nextProfiles);
  return nextProfiles;
}

function createProjectFolderId(projectPath) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(projectPath).toLowerCase())
    .digest("hex")
    .slice(0, 18);
}

function getProjectFolderDetails(projectPath) {
  const absolutePath = path.resolve(projectPath);

  try {
    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      return { exists: false, details: undefined };
    }

    registerTrustedPath(absolutePath);

    const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist");
    const topLevelFiles = visibleEntries.filter((entry) => entry.isFile()).length;
    const topLevelFolders = visibleEntries.filter((entry) => entry.isDirectory()).length;
    const gitRepository = fs.existsSync(path.join(absolutePath, ".git"));

    return {
      exists: true,
      details: {
        topLevelFiles,
        topLevelFolders,
        lastModifiedAt: stats.mtime.toISOString(),
        gitRepository,
      },
    };
  } catch {
    return { exists: false, details: undefined };
  }
}

function normalizeProjectFolder(entry) {
  const source = typeof entry === "string" ? { path: entry } : entry && typeof entry === "object" ? entry : null;
  if (!source || typeof source.path !== "string" || source.path.trim().length === 0) {
    return null;
  }

  const absolutePath = path.resolve(source.path);
  const inspected = getProjectFolderDetails(absolutePath);

  return {
    id: typeof source.id === "string" && source.id.trim().length > 0 ? source.id : createProjectFolderId(absolutePath),
    path: absolutePath,
    name: path.basename(absolutePath) || absolutePath,
    displayName: typeof source.displayName === "string" && source.displayName.trim().length > 0 ? source.displayName.trim() : undefined,
    favorite: Boolean(source.favorite),
    addedAt: typeof source.addedAt === "string" ? source.addedAt : new Date().toISOString(),
    lastOpenedAt: typeof source.lastOpenedAt === "string" ? source.lastOpenedAt : undefined,
    exists: inspected.exists,
    details: inspected.details,
  };
}

function getProjectFolders() {
  const projectFolders = preferenceStore?.get("projectFolders");
  const seenPaths = new Set();
  const normalized = Array.isArray(projectFolders)
    ? projectFolders
        .map(normalizeProjectFolder)
        .filter((project) => {
          if (!project) {
            return false;
          }

          const comparablePath = project.path.toLowerCase();
          if (seenPaths.has(comparablePath)) {
            return false;
          }

          seenPaths.add(comparablePath);
          return true;
        })
    : [];

  preferenceStore?.set("projectFolders", normalized);
  return normalized;
}

function getProjectFolderById(projectId) {
  return getProjectFolders().find((project) => project.id === projectId) ?? null;
}

function saveProjectFolders(projectFolders) {
  preferenceStore?.set("projectFolders", projectFolders.map(normalizeProjectFolder).filter(Boolean));
  return getProjectFolders();
}

function markProjectFolderOpened(projectPath) {
  const absolutePath = path.resolve(projectPath);
  const projects = getProjectFolders();
  const matchingProject = projects.find((project) => project.path.toLowerCase() === absolutePath.toLowerCase());

  if (!matchingProject) {
    return null;
  }

  const nextProjects = projects.map((project) =>
    project.id === matchingProject.id
      ? {
          ...project,
          lastOpenedAt: new Date().toISOString(),
        }
      : project
  );

  return saveProjectFolders(nextProjects).find((project) => project.id === matchingProject.id) ?? null;
}

function addProjectFolder(projectPath) {
  const absolutePath = path.resolve(projectPath);
  const stats = fs.statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error("Project path must be a directory.");
  }

  registerTrustedPath(absolutePath);

  const projects = getProjectFolders();
  const comparablePath = absolutePath.toLowerCase();
  const existingProject = projects.find((project) => project.path.toLowerCase() === comparablePath);

  if (existingProject) {
    const refreshedProject = normalizeProjectFolder(existingProject);
    return { project: refreshedProject, alreadyExists: true };
  }

  const project = normalizeProjectFolder({
    id: createProjectFolderId(absolutePath),
    path: absolutePath,
    favorite: false,
    addedAt: new Date().toISOString(),
  });
  const nextProjects = saveProjectFolders([project, ...projects]);

  return {
    project: nextProjects.find((entry) => entry.id === project.id) ?? project,
    alreadyExists: false,
  };
}

function setCurrentWorkspace(workspacePath) {
  const absolutePath = path.resolve(workspacePath);

  currentWorkspace = absolutePath;
  registerTrustedPath(absolutePath);
  preferenceStore?.set("lastWorkspace", absolutePath);
  addRecentWorkspace(absolutePath);
  markProjectFolderOpened(absolutePath);
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
    throw new Error("Blocked access to a path outside the active Project.");
  }

  if (!allowMissing && !fs.existsSync(absolutePath)) {
    throw new Error("The requested path does not exist.");
  }

  if (disallowWorkspaceRootDeletion && currentWorkspace && absolutePath === currentWorkspace) {
    throw new Error("Deleting the active Project root is not allowed.");
  }

  return absolutePath;
}

function normalizeToolchainSketchSourcePayload(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  if (source.kind === "inline") {
    return {
      kind: "inline",
      fileName: String(source.fileName || DEFAULT_WORKSPACE_SKETCH_FILE),
      code: String(source.code ?? DEFAULT_EDITOR_CONTENT)
    };
  }

  if (source.kind !== "workspace") {
    return null;
  }

  const workspacePath = assertTrustedPath(source.workspacePath);
  const workspaceStats = fs.statSync(workspacePath);
  if (!workspaceStats.isDirectory()) {
    throw new Error("Project source must be a directory.");
  }

  const entryFileName = String(source.entryFileName || DEFAULT_WORKSPACE_SKETCH_FILE)
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "." && part !== "..")
    .join("/");
  if (entryFileName.includes("/") || !/\.(ino|pde)$/i.test(entryFileName)) {
    throw new Error("Project entry must be a root .ino or .pde file.");
  }

  const dirtyFiles = Array.isArray(source.dirtyFiles) ? source.dirtyFiles : [];
  const normalizedDirtyFiles = [];
  for (const dirtyFile of dirtyFiles) {
    if (!dirtyFile || typeof dirtyFile !== "object") {
      continue;
    }
    const rawPath = String(dirtyFile.path || "").trim();
    if (!rawPath) {
      continue;
    }
    const absolutePath = path.isAbsolute(rawPath)
      ? assertTrustedPath(rawPath, { allowMissing: true })
      : assertTrustedPath(path.join(workspacePath, rawPath), { allowMissing: true });
    if (!isPathInsideRoot(absolutePath, workspacePath)) {
      continue;
    }
    normalizedDirtyFiles.push({
      path: absolutePath,
      content: String(dirtyFile.content ?? "")
    });
  }

  return {
    kind: "workspace",
    workspacePath,
    entryFileName,
    dirtyFiles: normalizedDirtyFiles
  };
}

function toErrorResult(error) {
  return {
    success: false,
    error: error instanceof Error ? error.message : "Unexpected error",
    ...(error?.canceled || error?.name === "AbortError" || error?.code === "ABORT_ERR" ? { canceled: true } : {}),
    ...(error?.storage ? { storage: error.storage } : {})
  };
}

function normalizeArduinoStorageRoot(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return path.resolve(value.trim());
}

function applyArduinoStorageRootPreference() {
  const storageRoot = normalizeArduinoStorageRoot(preferenceStore?.get(ARDUINO_STORAGE_ROOT_KEY));
  configureArduinoStorageRoot(storageRoot);
  if (storageRoot) {
    registerTrustedPath(storageRoot);
  }
  return storageRoot;
}

function getArduinoStorageConfigurationResult() {
  const storageRoot = normalizeArduinoStorageRoot(preferenceStore?.get(ARDUINO_STORAGE_ROOT_KEY));
  if (storageRoot) {
    configureArduinoStorageRoot(storageRoot);
  }

  return {
    success: true,
    storageRoot,
    ...getArduinoStorageInfo()
  };
}

function extractCliProgressPercent(chunk) {
  const match = String(chunk || "").match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) {
    return null;
  }

  const progress = Number.parseFloat(match[1]);
  if (!Number.isFinite(progress)) {
    return null;
  }

  return Math.max(0, Math.min(100, progress));
}

function extractLastCliProgressPercent(chunk) {
  const matches = Array.from(String(chunk || "").matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g));
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch) {
    return null;
  }

  const progress = Number.parseFloat(lastMatch[1]);
  if (!Number.isFinite(progress)) {
    return null;
  }

  return Math.max(0, Math.min(100, progress));
}

function classifyLibraryInstallPhase(chunk) {
  const normalized = String(chunk || "").toLowerCase();

  if (normalized.includes("download")) {
    return "download";
  }

  if (normalized.includes("extract")) {
    return "extract";
  }

  if (normalized.includes("install")) {
    return "install";
  }

  return "running";
}

function formatLibraryInstallMessage(chunk) {
  const normalized = String(chunk || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  return normalized || "Installing library...";
}

function formatUsbUploadProgressMessage(chunk) {
  const normalized = textFromToolchainProgressPayload(chunk)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  return normalized || "Uploading over USB...";
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

const GIT_COMMAND_DEFAULT_TIMEOUT_MS = 120000;
const GIT_COMMAND_NETWORK_TIMEOUT_MS = 300000;

function createGitError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function getGitWorkspaceRoot() {
  if (!currentWorkspace) {
    throw createGitError("Open a Project before using Git.", "NO_WORKSPACE");
  }

  return currentWorkspace;
}

function normalizeGitText(value) {
  return String(value ?? "").trim();
}

function formatGitCommandOutput(result) {
  return normalizeGitText([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

function classifyGitFailure(args, stdout, stderr, code) {
  const output = normalizeGitText(stderr || stdout);
  const lowerOutput = output.toLowerCase();
  const command = `git ${args.join(" ")}`;

  if (lowerOutput.includes("detected dubious ownership") || lowerOutput.includes("safe.directory")) {
    return createGitError("Git blocked this repository because its ownership is not trusted.", "SAFE_DIRECTORY", {
      command,
      output,
      exitCode: code
    });
  }

  if (lowerOutput.includes("not a git repository") || lowerOutput.includes("not a git repo")) {
    return createGitError("The active Project is not a Git repository.", "NOT_REPOSITORY", {
      command,
      output,
      exitCode: code
    });
  }

  if (lowerOutput.includes("no upstream branch") || lowerOutput.includes("no tracking information")) {
    return createGitError("The current branch does not have an upstream branch.", "NO_UPSTREAM", {
      command,
      output,
      exitCode: code
    });
  }

  if (
    lowerOutput.includes("authentication failed") ||
    lowerOutput.includes("permission denied") ||
    lowerOutput.includes("could not read username") ||
    lowerOutput.includes("repository not found")
  ) {
    return createGitError("Git authentication failed. Check your existing Git credentials or SSH key.", "AUTH_FAILED", {
      command,
      output,
      exitCode: code
    });
  }

  if (lowerOutput.includes("conflict") || lowerOutput.includes("merge failed")) {
    return createGitError(output || `${command} failed because of conflicts.`, "GIT_CONFLICT", {
      command,
      output,
      exitCode: code
    });
  }

  return createGitError(output || `${command} failed with exit code ${code}.`, "GIT_FAILED", {
    command,
    output,
    exitCode: code
  });
}

function runGit(args, options = {}) {
  const cwd = options.cwd ?? getGitWorkspaceRoot();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : GIT_COMMAND_DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0"
      }
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        child.kill();
      } catch {}

      reject(createGitError(`Git command timed out: git ${args.join(" ")}`, "GIT_TIMEOUT"));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (error?.code === "ENOENT") {
        reject(createGitError("Git is not installed or is not available on PATH.", "MISSING_GIT"));
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      const result = { stdout, stderr, code: code ?? 0 };
      if (!options.allowFailure && result.code !== 0) {
        reject(classifyGitFailure(args, stdout, stderr, result.code));
        return;
      }

      resolve(result);
    });
  });
}

function createGitStatusState(state, message = "") {
  return {
    state,
    available: state !== "missing-git",
    isRepository: state === "repository",
    root: currentWorkspace,
    gitDir: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    operation: null,
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    conflictedFiles: [],
    hasChanges: false,
    safeDirectoryRequired: state === "unsafe",
    message
  };
}

function parsePorcelainStatusPath(value) {
  const pathValue = String(value ?? "").trim();
  if (pathValue.length >= 2 && pathValue.startsWith('"') && pathValue.endsWith('"')) {
    return pathValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  return pathValue;
}

function createGitFileChange(pathValue, statusCode, options = {}) {
  return {
    path: parsePorcelainStatusPath(pathValue),
    oldPath: options.oldPath ? parsePorcelainStatusPath(options.oldPath) : undefined,
    status: statusCode,
    staged: Boolean(options.staged),
    conflicted: Boolean(options.conflicted),
    untracked: Boolean(options.untracked)
  };
}

function parseGitStatus(output) {
  const status = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    conflictedFiles: []
  };

  for (const rawLine of String(output ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    if (line.startsWith("# branch.head ")) {
      const branchHead = line.slice("# branch.head ".length).trim();
      status.detached = branchHead === "(detached)";
      status.branch = status.detached ? null : branchHead;
      continue;
    }

    if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const aheadMatch = line.match(/\+(\d+)/);
      const behindMatch = line.match(/-(\d+)/);
      status.ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
      status.behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0;
      continue;
    }

    if (line.startsWith("? ")) {
      status.untrackedFiles.push(createGitFileChange(line.slice(2), "??", { untracked: true }));
      continue;
    }

    if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const pathValue = parts.slice(10).join(" ");
      status.conflictedFiles.push(createGitFileChange(pathValue, parts[1] || "UU", { conflicted: true }));
      continue;
    }

    if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1] || "..";
      const pathValue = parts.slice(8).join(" ");
      const indexStatus = xy.charAt(0);
      const worktreeStatus = xy.charAt(1);

      if (indexStatus && indexStatus !== ".") {
        status.stagedFiles.push(createGitFileChange(pathValue, xy, { staged: true }));
      }

      if (worktreeStatus && worktreeStatus !== ".") {
        status.unstagedFiles.push(createGitFileChange(pathValue, xy));
      }
      continue;
    }

    if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] || "..";
      const renamePayload = parts.slice(9).join(" ");
      const [pathValue, oldPath] = renamePayload.split("\t");
      const indexStatus = xy.charAt(0);
      const worktreeStatus = xy.charAt(1);

      if (indexStatus && indexStatus !== ".") {
        status.stagedFiles.push(createGitFileChange(pathValue, xy, { oldPath, staged: true }));
      }

      if (worktreeStatus && worktreeStatus !== ".") {
        status.unstagedFiles.push(createGitFileChange(pathValue, xy, { oldPath }));
      }
    }
  }

  return status;
}

function normalizeGitPathList(paths) {
  const input = Array.isArray(paths) ? paths : [paths];
  const rootPath = getGitWorkspaceRoot();
  const normalized = [];

  for (const entry of input) {
    const candidate = String(entry ?? "").trim();
    if (!candidate || candidate === ".") {
      continue;
    }

    if (path.isAbsolute(candidate)) {
      throw new Error("Git file paths must be relative to the active Project.");
    }

    const absolutePath = path.resolve(rootPath, candidate);
    if (!isPathInsideRoot(absolutePath, rootPath)) {
      throw new Error("Blocked Git access to a path outside the active Project.");
    }

    const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
    if (relativePath && relativePath !== "." && !normalized.includes(relativePath)) {
      normalized.push(relativePath);
    }
  }

  if (normalized.length === 0) {
    throw new Error("Choose at least one file path.");
  }

  return normalized;
}

async function getGitDirectory() {
  const result = await runGit(["rev-parse", "--git-dir"]);
  const gitDir = result.stdout.trim();
  if (!gitDir) {
    return null;
  }

  return path.isAbsolute(gitDir) ? gitDir : path.resolve(getGitWorkspaceRoot(), gitDir);
}

async function detectGitOperation(gitDir) {
  if (!gitDir) {
    return null;
  }

  const checks = [
    { file: "MERGE_HEAD", operation: "merge" },
    { file: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
    { file: "REVERT_HEAD", operation: "revert" },
    { file: "BISECT_LOG", operation: "bisect" }
  ];

  for (const check of checks) {
    if (fs.existsSync(path.join(gitDir, check.file))) {
      return check.operation;
    }
  }

  if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) {
    return "rebase";
  }

  return null;
}

async function getGitStatus() {
  if (!currentWorkspace) {
    return createGitStatusState("no-workspace", "Open a Project to use Git.");
  }

  try {
    const statusResult = await runGit(["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
    const parsed = parseGitStatus(statusResult.stdout);
    let repoRoot = currentWorkspace;
    let gitDir = null;

    try {
      const rootResult = await runGit(["rev-parse", "--show-toplevel"]);
      repoRoot = rootResult.stdout.trim() || currentWorkspace;
    } catch {}

    try {
      gitDir = await getGitDirectory();
    } catch {}

    const operation = await detectGitOperation(gitDir);
    const hasChanges =
      parsed.stagedFiles.length > 0 ||
      parsed.unstagedFiles.length > 0 ||
      parsed.untrackedFiles.length > 0 ||
      parsed.conflictedFiles.length > 0;

    return {
      ...createGitStatusState("repository"),
      ...parsed,
      root: repoRoot,
      gitDir,
      operation,
      hasChanges
    };
  } catch (error) {
    if (error?.code === "NO_WORKSPACE") {
      return createGitStatusState("no-workspace", error.message);
    }

    if (error?.code === "MISSING_GIT") {
      return createGitStatusState("missing-git", error.message);
    }

    if (error?.code === "SAFE_DIRECTORY") {
      return createGitStatusState("unsafe", error.output || error.message);
    }

    if (error?.code === "NOT_REPOSITORY") {
      return createGitStatusState("not-repository", "The active Project is not a Git repository.");
    }

    throw error;
  }
}

async function readWorkspaceFileForGit(relativePath) {
  const absolutePath = path.resolve(getGitWorkspaceRoot(), relativePath);
  if (!isPathInsideRoot(absolutePath, getGitWorkspaceRoot()) || !fs.existsSync(absolutePath)) {
    return "";
  }

  const stats = await fsPromises.stat(absolutePath);
  if (stats.isDirectory()) {
    return "";
  }

  return await fsPromises.readFile(absolutePath, "utf8");
}

async function readGitObjectContent(revision, relativePath) {
  const result = await runGit(["show", `${revision}:${relativePath}`], { allowFailure: true });
  if (result.code !== 0) {
    return "";
  }

  return result.stdout;
}

async function getGitDiff(payload = {}) {
  const [relativePath] = normalizeGitPathList(payload.path);
  const mode = payload.mode === "staged" ? "staged" : "working-tree";
  const oldPath = payload.oldPath ? normalizeGitPathList(payload.oldPath)[0] : relativePath;

  if (mode === "staged") {
    return {
      path: relativePath,
      oldPath,
      mode,
      oldContent: await readGitObjectContent("HEAD", oldPath),
      newContent: await readGitObjectContent("", relativePath)
    };
  }

  return {
    path: relativePath,
    oldPath,
    mode,
    oldContent: await readGitObjectContent("HEAD", oldPath),
    newContent: await readWorkspaceFileForGit(relativePath)
  };
}

async function getGitLog(limit = 80) {
  const normalizedLimit = Math.max(1, Math.min(250, Number.parseInt(limit, 10) || 80));
  const prettyFormat = "%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%D%x1f%S%x1f%s";
  const result = await runGit(
    [
      "log",
      "--all",
      "--topo-order",
      "--source",
      "--decorate=short",
      "--date=iso-strict",
      "--numstat",
      `--pretty=format:${prettyFormat}`,
      `-${normalizedLimit}`
    ],
    { allowFailure: true }
  );

  if (result.code !== 0) {
    const output = formatGitCommandOutput(result).toLowerCase();
    if (output.includes("does not have any commits") || output.includes("your current branch") || output.includes("bad revision")) {
      return [];
    }

    throw classifyGitFailure(["log"], result.stdout, result.stderr, result.code);
  }

  return result.stdout
    .split("\x1e")
    .map((record) => {
      const normalizedRecord = record.trimStart();
      if (!normalizedRecord) {
        return null;
      }

      const [metadataLine, ...statLines] = normalizedRecord.split(/\r?\n/);
      const [hash, shortHash, parents, author, authorEmail, date, refs, branch, subject] = metadataLine.split("\x1f");
      if (!hash) {
        return null;
      }

      const stats = statLines.reduce(
        (currentStats, line) => {
          const [insertions, deletions] = line.split("\t");
          if (insertions === undefined || deletions === undefined) {
            return currentStats;
          }

          const parsedInsertions = Number.parseInt(insertions, 10);
          const parsedDeletions = Number.parseInt(deletions, 10);

          currentStats.filesChanged += 1;
          currentStats.insertions += Number.isFinite(parsedInsertions) ? parsedInsertions : 0;
          currentStats.deletions += Number.isFinite(parsedDeletions) ? parsedDeletions : 0;
          return currentStats;
        },
        { filesChanged: 0, insertions: 0, deletions: 0 }
      );

      return {
        hash,
        shortHash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        subject: subject || "(no commit message)",
        author: author || "",
        authorEmail: authorEmail || "",
        date: date || "",
        refs: refs || "",
        branch: branch || "",
        graphPrefix: "",
        stats
      };
    })
    .filter(Boolean);
}

function parseGitBranchTrack(value) {
  const track = String(value ?? "").trim();
  if (!track) {
    return { ahead: 0, behind: 0 };
  }

  if (track === "=" || track === "[gone]") {
    return { ahead: 0, behind: 0 };
  }

  const aheadMatch = track.match(/ahead\s+(\d+)/);
  const behindMatch = track.match(/behind\s+(\d+)/);

  return {
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : track.includes(">") ? 1 : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : track.includes("<") ? 1 : 0
  };
}

async function listGitBranches() {
  const status = await getGitStatus();
  if (status.state !== "repository") {
    return { status, branches: [] };
  }

  const result = await runGit(["for-each-ref", "--format=%(refname)%09%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(upstream:track)", "refs/heads", "refs/remotes"]);
  const branches = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("refs/remotes/") || !line.includes("/HEAD\t"))
    .map((line) => {
      const [refName, name, shortHash, upstream, track] = line.split("\t");
      const remote = refName.startsWith("refs/remotes/");
      const trackState = parseGitBranchTrack(track);
      return {
        name,
        shortHash: shortHash || "",
        current: !remote && status.branch === name,
        remote,
        upstream: upstream || null,
        ahead: trackState.ahead,
        behind: trackState.behind
      };
    });

  return { status, branches };
}

async function getGitRemotes() {
  const result = await runGit(["remote", "-v"], { allowFailure: true });
  if (result.code !== 0) {
    return [];
  }

  const remotes = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) {
      continue;
    }

    const [, name, url, kind] = match;
    const current = remotes.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") {
      current.fetchUrl = url;
    } else {
      current.pushUrl = url;
    }
    remotes.set(name, current);
  }

  return [...remotes.values()];
}

function getGitHomeCwd() {
  return app.getPath("home") || getDefaultTerminalCwd();
}

async function getGlobalGitConfigValue(name) {
  const result = await runGit(["config", "--global", "--get", name], {
    cwd: getGitHomeCwd(),
    allowFailure: true
  });

  return result.code === 0 ? result.stdout.trim() : "";
}

async function setGlobalGitConfigValue(name, value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return;
  }

  await runGit(["config", "--global", name, normalized], { cwd: getGitHomeCwd() });
}

async function getGitConfiguration() {
  const config = secretStore?.get("git.config") ?? {};
  const githubToken = secretStore?.get("git.githubToken") ?? "";
  const gitlabToken = secretStore?.get("git.gitlabToken") ?? "";

  return {
    defaultProvider: config.defaultProvider === "gitlab" ? "gitlab" : "github",
    githubUsername: typeof config.githubUsername === "string" ? config.githubUsername : "",
    gitlabUsername: typeof config.gitlabUsername === "string" ? config.gitlabUsername : "",
    gitUserName: await getGlobalGitConfigValue("user.name"),
    gitUserEmail: await getGlobalGitConfigValue("user.email"),
    githubTokenConfigured: typeof githubToken === "string" && githubToken.length > 0,
    gitlabTokenConfigured: typeof gitlabToken === "string" && gitlabToken.length > 0
  };
}

async function setGitConfiguration(payload = {}) {
  const defaultProvider = payload.defaultProvider === "gitlab" ? "gitlab" : "github";
  const githubUsername = String(payload.githubUsername ?? "").trim();
  const gitlabUsername = String(payload.gitlabUsername ?? "").trim();
  const gitUserName = String(payload.gitUserName ?? "").trim();
  const gitUserEmail = String(payload.gitUserEmail ?? "").trim();

  secretStore?.set("git.config", {
    defaultProvider,
    githubUsername,
    gitlabUsername,
    updatedAt: new Date().toISOString()
  });

  if (typeof payload.githubToken === "string" && payload.githubToken.trim()) {
    secretStore?.set("git.githubToken", payload.githubToken.trim());
  }

  if (typeof payload.gitlabToken === "string" && payload.gitlabToken.trim()) {
    secretStore?.set("git.gitlabToken", payload.gitlabToken.trim());
  }

  if (payload.clearGithubToken) {
    secretStore?.delete("git.githubToken");
  }

  if (payload.clearGitlabToken) {
    secretStore?.delete("git.gitlabToken");
  }

  await setGlobalGitConfigValue("user.name", gitUserName);
  await setGlobalGitConfigValue("user.email", gitUserEmail);

  return await getGitConfiguration();
}

function normalizeRepositoryName(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error("Repository name is required.");
  }

  return normalized;
}

function encodeGitBasicCredential(username, token) {
  return Buffer.from(`${username}:${token}`, "utf8").toString("base64");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body?.message
        ? body.message
        : typeof body === "string" && body.trim()
          ? body.trim()
          : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  return body;
}

async function createGithubRepository({ token, owner, repositoryName, visibility, username }) {
  const targetOwner = String(owner ?? "").trim();
  const isOrgRepository = targetOwner && targetOwner.toLowerCase() !== String(username ?? "").trim().toLowerCase();
  const url = isOrgRepository ? `https://api.github.com/orgs/${encodeURIComponent(targetOwner)}/repos` : "https://api.github.com/user/repos";
  const body = {
    name: repositoryName,
    private: visibility !== "public",
    auto_init: false
  };

  const repo = await requestJson(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": APP_NAME
    },
    body: JSON.stringify(body)
  });

  if (!repo?.clone_url) {
    throw new Error("GitHub did not return a clone URL for the new repository.");
  }

  return {
    url: repo.clone_url,
    webUrl: repo.html_url || repo.clone_url
  };
}

async function findGitlabNamespaceId(token, owner) {
  const search = String(owner ?? "").trim();
  if (!search) {
    return null;
  }

  const namespaces = await requestJson(`https://gitlab.com/api/v4/namespaces?search=${encodeURIComponent(search)}`, {
    headers: {
      "PRIVATE-TOKEN": token,
      "User-Agent": APP_NAME
    }
  });

  const match = Array.isArray(namespaces)
    ? namespaces.find((namespace) => namespace?.full_path === search || namespace?.path === search || namespace?.name === search)
    : null;

  return match?.id ?? null;
}

async function createGitlabRepository({ token, owner, repositoryName, visibility }) {
  const namespaceId = await findGitlabNamespaceId(token, owner);
  const body = {
    name: repositoryName,
    path: repositoryName,
    visibility: visibility === "public" ? "public" : "private",
    ...(namespaceId ? { namespace_id: namespaceId } : {})
  };

  const repo = await requestJson("https://gitlab.com/api/v4/projects", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PRIVATE-TOKEN": token,
      "User-Agent": APP_NAME
    },
    body: JSON.stringify(body)
  });

  if (!repo?.http_url_to_repo) {
    throw new Error("GitLab did not return a clone URL for the new repository.");
  }

  return {
    url: repo.http_url_to_repo,
    webUrl: repo.web_url || repo.http_url_to_repo
  };
}

async function initializeGitRepository(defaultBranch = "main") {
  getGitWorkspaceRoot();
  const branch = String(defaultBranch || "main").trim() || "main";
  let result = await runGit(["init", "-b", branch], { allowFailure: true });
  if (result.code !== 0) {
    result = await runGit(["init"]);
  }

  markWorkspaceDirty();
  return { output: formatGitCommandOutput(result) || "Initialized empty Git repository." };
}

async function ensureGitRepository() {
  const status = await getGitStatus();
  if (status.state === "repository") {
    return status;
  }

  if (status.state === "not-repository") {
    await initializeGitRepository("main");
    return await getGitStatus();
  }

  throw new Error(status.message || "Git repository is not available.");
}

async function hasGitCommit() {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  return result.code === 0;
}

async function ensureInitialCommit(message) {
  if (await hasGitCommit()) {
    return;
  }

  const workspaceRoot = getGitWorkspaceRoot();
  const statusResult = await runGit(["status", "--porcelain"], { allowFailure: true });
  if (!statusResult.stdout.trim()) {
    const readmePath = path.join(workspaceRoot, "README.md");
    await fsPromises.writeFile(readmePath, `# ${path.basename(workspaceRoot)}\n`, { flag: "wx" }).catch(async (error) => {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    });
  }

  await runGit(["add", "-A"]);
  await runGit(["commit", "-m", String(message || "Initial commit").trim() || "Initial commit"]);
  markWorkspaceDirty();
}

async function getCurrentGitBranchName() {
  const result = await runGit(["branch", "--show-current"], { allowFailure: true });
  const branch = result.stdout.trim();
  return branch || "main";
}

async function setOriginRemote(remoteUrl) {
  const remotes = await getGitRemotes();
  if (remotes.some((remote) => remote.name === "origin")) {
    await runGit(["remote", "set-url", "origin", remoteUrl]);
    return;
  }

  await runGit(["remote", "add", "origin", remoteUrl]);
}

async function publishGitRepository(payload = {}) {
  const provider = payload.provider === "gitlab" ? "gitlab" : "github";
  const repositoryName = normalizeRepositoryName(payload.repositoryName);
  const visibility = payload.visibility === "public" ? "public" : "private";
  const config = await getGitConfiguration();
  const token = provider === "github" ? secretStore?.get("git.githubToken") : secretStore?.get("git.gitlabToken");

  if (typeof token !== "string" || !token.trim()) {
    throw new Error(`Configure a ${provider === "github" ? "GitHub" : "GitLab"} token in Settings > Git Configuration before publishing.`);
  }

  await ensureGitRepository();
  await ensureInitialCommit(payload.initialCommitMessage);

  const remote =
    provider === "github"
      ? await createGithubRepository({
          token,
          owner: payload.owner,
          repositoryName,
          visibility,
          username: config.githubUsername
        })
      : await createGitlabRepository({
          token,
          owner: payload.owner,
          repositoryName,
          visibility
        });

  await setOriginRemote(remote.url);

  const branch = await getCurrentGitBranchName();
  const host = provider === "github" ? "https://github.com/" : "https://gitlab.com/";
  const user = provider === "github" ? "x-access-token" : "oauth2";
  const encoded = encodeGitBasicCredential(user, token);
  const result = await runGit(["-c", `http.${host}.extraheader=AUTHORIZATION: basic ${encoded}`, "push", "-u", "origin", branch], {
    timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS
  });

  return {
    output: formatGitCommandOutput(result) || `Published ${repositoryName}.`,
    remoteUrl: remote.url,
    webUrl: remote.webUrl
  };
}

async function discardGitPaths(payload = {}) {
  const paths = normalizeGitPathList(payload.paths ?? payload.path);
  const untracked = Boolean(payload.untracked);
  const staged = Boolean(payload.staged);

  if (untracked) {
    const rootPath = getGitWorkspaceRoot();
    for (const relativePath of paths) {
      const absolutePath = path.resolve(rootPath, relativePath);
      if (!isPathInsideRoot(absolutePath, rootPath)) {
        throw new Error("Blocked Git discard outside the active Project.");
      }

      if (fs.existsSync(absolutePath)) {
        await fsPromises.rm(absolutePath, { recursive: true, force: true });
      }
    }

    markWorkspaceDirty();
    return { output: `Discarded ${paths.length} untracked ${paths.length === 1 ? "path" : "paths"}.` };
  }

  const args = staged ? ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths] : ["restore", "--worktree", "--", ...paths];
  const result = await runGit(args);
  markWorkspaceDirty();
  return { output: formatGitCommandOutput(result) || `Discarded ${paths.length} ${paths.length === 1 ? "file" : "files"}.` };
}

async function getAgentGitDiff(payload = {}) {
  const pathValue = String(payload.path ?? "").trim();
  const mode = payload.mode === "staged" ? "staged" : "working-tree";
  if (!pathValue) {
    const result = await runGit(mode === "staged" ? ["diff", "--staged"] : ["diff"], { allowFailure: true });
    if (result.code !== 0) {
      throw classifyGitFailure(["diff"], result.stdout, result.stderr, result.code);
    }
    return {
      mode,
      output: formatGitCommandOutput(result) || "No Git diff.",
    };
  }

  return getGitDiff({ ...payload, mode, path: pathValue });
}

async function stageGitPathsForAgent(payload = {}) {
  const rawPaths = Array.isArray(payload.paths ?? payload.path) ? payload.paths ?? payload.path : [payload.paths ?? payload.path];
  const stageAll = rawPaths.length === 0 || rawPaths.some((entry) => !String(entry ?? "").trim() || String(entry ?? "").trim() === ".");
  const result = stageAll
    ? await runGit(["add", "-A"])
    : await runGit(["add", "--", ...normalizeGitPathList(rawPaths)]);
  markWorkspaceDirty();
  return { output: formatGitCommandOutput(result) || (stageAll ? "Staged all Git changes." : "Staged Git changes.") };
}

async function commitGitForAgent(payload = {}) {
  const message = String(payload.message ?? "").trim();
  if (!message) {
    throw new Error("Write a commit message before committing.");
  }

  const result = await runGit(["commit", "-m", message], { timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS });
  markWorkspaceDirty();
  return { output: formatGitCommandOutput(result) || "Committed changes." };
}

async function branchGitForAgent(payload = {}) {
  const branch = String(payload.branch ?? "").trim();
  if (!branch) {
    throw new Error("Use a valid Git branch name.");
  }

  await runGit(["check-ref-format", "--branch", branch]);
  const mode = payload.mode === "checkout" ? "checkout" : "create";
  const result = await runGit(mode === "checkout" ? ["checkout", branch] : ["checkout", "-b", branch]);
  markWorkspaceDirty();
  return { output: formatGitCommandOutput(result) || (mode === "checkout" ? `Switched to ${branch}.` : `Created ${branch}.`) };
}

async function pullGitForAgent() {
  const result = await runGit(["pull", "--ff-only"], { timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS });
  markWorkspaceDirty();
  return { output: formatGitCommandOutput(result) || "Pulled from upstream." };
}

async function pushGitForAgent() {
  const result = await runGit(["push"], { timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS });
  return { output: formatGitCommandOutput(result) || "Pushed to upstream." };
}

async function uploadLocalSketchForAgent(code, board, port, onProgress, options = {}) {
  const portValue = String(port || "").trim();
  const portKey = portValue.toLowerCase();
  if (portKey && activeLocalUploadPorts.has(portKey)) {
    throw new Error(`A USB upload is already running on ${portValue}. Wait for it to finish before starting another upload.`);
  }
  if (portKey && activeSerialMonitorPorts.has(portKey)) {
    throw new Error(`Serial Monitor is open on ${portValue}. Disconnect it before uploading.`);
  }

  if (portKey) {
    activeLocalUploadPorts.add(portKey);
  }

  try {
    return await uploadLocalSketch(code, board, port, onProgress, options);
  } finally {
    if (portKey) {
      activeLocalUploadPorts.delete(portKey);
    }
  }
}

const WORKSPACE_SEARCH_DEFAULT_MAX_RESULTS = 300;
const WORKSPACE_SEARCH_MAX_RESULTS = 1000;
const WORKSPACE_SEARCH_MAX_FILE_SIZE = "2M";
const AGENT_CONTEXT_DEFAULT_SUGGESTION_LIMIT = 3;
const AGENT_CONTEXT_MAX_SUGGESTION_LIMIT = 20;
const AGENT_CONTEXT_MAX_FILE_BYTES = 1_500_000;
const AGENT_CONTEXT_MAX_IMAGE_BYTES = 2_000_000;
const AGENT_CONTEXT_MAX_PICKED_FILES = 10;
const AGENT_CONTEXT_MAX_IMAGE_DATA_URL_CHARS = 6_000_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const WORKSPACE_SEARCH_DEFAULT_GLOBS = [
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.tentalum/**",
  "!**/.tantalum-file-tree-trash/**",
  "!**/.trash_*/**",
];
const AGENT_CONTEXT_SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^id_rsa(?:\..*)?$/i,
  /^id_ed25519(?:\..*)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /credentials/i,
  /secret/i,
];
const AGENT_CONTEXT_TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hh",
  ".hpp",
  ".html",
  ".ini",
  ".ino",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".py",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const AGENT_CONTEXT_IMAGE_MIME_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function clampSearchLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return WORKSPACE_SEARCH_DEFAULT_MAX_RESULTS;
  }

  return Math.max(20, Math.min(WORKSPACE_SEARCH_MAX_RESULTS, parsed));
}

function normalizeWorkspaceSearchRequest(payload = {}) {
  const mode = ["all", "files", "folders", "text"].includes(payload.mode) ? payload.mode : "all";

  return {
    query: String(payload.query ?? ""),
    mode,
    replace: String(payload.replace ?? ""),
    useRegex: Boolean(payload.useRegex),
    matchCase: Boolean(payload.matchCase),
    wholeWord: Boolean(payload.wholeWord),
    includeGlob: String(payload.includeGlob ?? ""),
    excludeGlob: String(payload.excludeGlob ?? ""),
    maxResults: clampSearchLimit(payload.maxResults),
    blockedPaths: Array.isArray(payload.blockedPaths) ? payload.blockedPaths.filter((entry) => typeof entry === "string") : [],
  };
}

function splitGlobInput(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function appendWorkspaceSearchGlobs(args, request) {
  for (const glob of WORKSPACE_SEARCH_DEFAULT_GLOBS) {
    args.push("--glob", glob);
  }

  for (const glob of splitGlobInput(request.includeGlob)) {
    args.push("--glob", glob);
  }

  for (const glob of splitGlobInput(request.excludeGlob)) {
    args.push("--glob", glob.startsWith("!") ? glob : `!${glob}`);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function buildSearchPattern(request) {
  const basePattern = request.useRegex ? request.query : escapeRegExp(request.query);
  return request.wholeWord ? `\\b(?:${basePattern})\\b` : basePattern;
}

async function runRipgrep(args, options = {}) {
  const resolvedRipgrepPath = await getRipgrepPath();

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedRipgrepPath, args, {
      cwd: options.cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve({ stdout, stderr, code });
        return;
      }

      reject(new Error(stderr.trim() || `ripgrep exited with code ${code}.`));
    });
  });
}

function decodeRipgrepJsonData(value) {
  if (!value) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.bytes === "string") {
    return Buffer.from(value.bytes, "base64").toString("utf8");
  }

  return "";
}

function resolveWorkspaceResultPath(rootPath, resultPath) {
  const normalized = String(resultPath || "").replace(/^[.][\\/]/, "");
  return path.resolve(rootPath, normalized);
}

function parseRipgrepJsonMatches(output, rootPath, limit) {
  const results = [];
  let truncated = false;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type !== "match" || !event.data) {
      continue;
    }

    const absolutePath = resolveWorkspaceResultPath(rootPath, decodeRipgrepJsonData(event.data.path));
    const relativePath = toWorkspaceRelativePath(absolutePath);
    const preview = decodeRipgrepJsonData(event.data.lines).replace(/\r?\n$/, "");
    const lineNumber = event.data.line_number ?? 1;
    const submatches = Array.isArray(event.data.submatches) && event.data.submatches.length > 0 ? event.data.submatches : [{ start: 0, end: preview.length, match: { text: preview } }];

    for (const submatch of submatches) {
      if (results.length >= limit) {
        truncated = true;
        return { results, truncated };
      }

      const start = Number.isInteger(submatch.start) ? submatch.start : 0;
      const end = Number.isInteger(submatch.end) ? submatch.end : start;
      results.push({
        id: `text:${relativePath}:${lineNumber}:${start}:${results.length}`,
        type: "text",
        path: absolutePath,
        relativePath,
        name: path.basename(absolutePath),
        lineNumber,
        column: start + 1,
        endColumn: Math.max(start + 1, end + 1),
        preview,
        matchText: decodeRipgrepJsonData(submatch.match),
      });
    }
  }

  return { results, truncated };
}

function buildRipgrepSearchArgs(request, options = {}) {
  const args = ["--no-config"];

  if (options.filesWithMatches) {
    args.push("--files-with-matches");
  } else {
    args.push("--json");
  }

  args.push("--max-filesize", WORKSPACE_SEARCH_MAX_FILE_SIZE);
  appendWorkspaceSearchGlobs(args, request);

  if (!request.matchCase) {
    args.push("--ignore-case");
  } else {
    args.push("--case-sensitive");
  }

  if (!request.useRegex) {
    args.push("--fixed-strings");
  } else {
    args.push("--engine", "auto");
  }

  if (request.wholeWord) {
    args.push("--word-regexp");
  }

  args.push("--", request.query, ".");
  return args;
}

function buildPathMatcher(request) {
  const query = request.query;
  if (!query) {
    return () => false;
  }

  if (request.useRegex || request.wholeWord) {
    const pattern = request.useRegex ? query : escapeRegExp(query);
    const wrappedPattern = request.wholeWord ? `\\b(?:${pattern})\\b` : pattern;
    const regex = new RegExp(wrappedPattern, request.matchCase ? "" : "i");
    return (value) => regex.test(value);
  }

  const needle = request.matchCase ? query : query.toLowerCase();
  return (value) => {
    const haystack = request.matchCase ? value : value.toLowerCase();
    return haystack.includes(needle);
  };
}

function rankPathSearchResult(result, request) {
  const query = request.matchCase ? request.query : request.query.toLowerCase();
  const name = request.matchCase ? result.name : result.name.toLowerCase();
  const relativePath = request.matchCase ? result.relativePath : result.relativePath.toLowerCase();

  if (name === query) {
    return 0;
  }

  if (name.startsWith(query)) {
    return 1;
  }

  if (relativePath.startsWith(query)) {
    return 2;
  }

  return 3;
}

async function searchWorkspacePaths(request, rootPath) {
  const args = ["--files", "--no-config"];
  appendWorkspaceSearchGlobs(args, request);
  const { stdout } = await runRipgrep(args, { cwd: rootPath });
  const matcher = buildPathMatcher(request);
  const files = [];
  const folders = new Map();

  for (const line of stdout.split(/\r?\n/)) {
    const relativeFilePath = line.trim();
    if (!relativeFilePath) {
      continue;
    }

    const absolutePath = path.resolve(rootPath, relativeFilePath);
    const fileResult = {
      id: `file:${relativeFilePath}`,
      type: "file",
      path: absolutePath,
      relativePath: relativeFilePath,
      name: path.basename(relativeFilePath),
    };

    if (matcher(fileResult.name) || matcher(fileResult.relativePath)) {
      files.push(fileResult);
    }

    let directoryPath = path.dirname(relativeFilePath);
    while (directoryPath && directoryPath !== ".") {
      if (!folders.has(directoryPath)) {
        const folderResult = {
          id: `folder:${directoryPath}`,
          type: "folder",
          path: path.resolve(rootPath, directoryPath),
          relativePath: directoryPath,
          name: path.basename(directoryPath),
        };

        if (matcher(folderResult.name) || matcher(folderResult.relativePath)) {
          folders.set(directoryPath, folderResult);
        }
      }

      const nextDirectoryPath = path.dirname(directoryPath);
      if (nextDirectoryPath === directoryPath) {
        break;
      }
      directoryPath = nextDirectoryPath;
    }
  }

  const sortedFiles = files.sort((left, right) => rankPathSearchResult(left, request) - rankPathSearchResult(right, request) || left.relativePath.localeCompare(right.relativePath));
  const sortedFolders = [...folders.values()].sort((left, right) => rankPathSearchResult(left, request) - rankPathSearchResult(right, request) || left.relativePath.localeCompare(right.relativePath));

  return { files: sortedFiles, folders: sortedFolders };
}

async function searchWorkspaceText(request, rootPath, limit) {
  const { stdout } = await runRipgrep(buildRipgrepSearchArgs(request), { cwd: rootPath });
  return parseRipgrepJsonMatches(stdout, rootPath, limit);
}

function normalizeAgentContextSuggestionLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return AGENT_CONTEXT_DEFAULT_SUGGESTION_LIMIT;
  }

  return Math.max(1, Math.min(AGENT_CONTEXT_MAX_SUGGESTION_LIMIT, parsed));
}

function normalizeAgentContextRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isSensitiveAgentContextRelativePath(relativePath) {
  const normalized = normalizeAgentContextRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  return (
    parts.some((part) => part === ".git" || part === ".tentalum" || part === "node_modules" || part === "dist" || part === "build") ||
    AGENT_CONTEXT_SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(parts.at(-1) || normalized))
  );
}

function validateAgentContextTextBuffer(buffer) {
  if (buffer.length > AGENT_CONTEXT_MAX_FILE_BYTES) {
    return { ok: false, reason: "oversized" };
  }

  if (buffer.includes(0)) {
    return { ok: false, reason: "binary" };
  }

  try {
    UTF8_DECODER.decode(buffer);
    return { ok: true };
  } catch {
    return { ok: false, reason: "non_utf8" };
  }
}

function sanitizeAgentContextAttachmentName(value) {
  const baseName = path.basename(String(value || "attachment")).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_").trim();
  return (baseName || "attachment").slice(0, 180);
}

function isSensitiveAgentContextAttachmentPath(filePath) {
  const name = path.basename(String(filePath || ""));
  return AGENT_CONTEXT_SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function getAgentContextImageMimeType(filePath, buffer) {
  const extensionMime = AGENT_CONTEXT_IMAGE_MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase());
  if (!extensionMime) {
    return null;
  }

  if (
    extensionMime === "image/png" &&
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return extensionMime;
  }

  if (extensionMime === "image/jpeg" && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return extensionMime;
  }

  if (
    extensionMime === "image/webp" &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return extensionMime;
  }

  return null;
}

function createAttachmentContextId(kind, filePath, buffer) {
  const hash = crypto.createHash("sha256").update(filePath).update(buffer.subarray(0, Math.min(buffer.length, 4096))).digest("hex").slice(0, 16);
  return `attachment:${kind}:${hash}`;
}

async function readPickedAgentContextAttachment(filePath, aggregateImageDataUrlChars) {
  const absolutePath = path.resolve(filePath);
  const name = sanitizeAgentContextAttachmentName(absolutePath);

  if (isSensitiveAgentContextAttachmentPath(absolutePath)) {
    return { rejected: { path: absolutePath, name, reason: "Sensitive filenames cannot be attached as agent context." } };
  }

  const stats = await fsPromises.lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    return { rejected: { path: absolutePath, name, reason: "Symbolic links cannot be attached as agent context." } };
  }

  if (!stats.isFile()) {
    return { rejected: { path: absolutePath, name, reason: "Only regular files can be attached as agent context." } };
  }

  const extension = path.extname(absolutePath).toLowerCase();
  const isImageCandidate = AGENT_CONTEXT_IMAGE_MIME_BY_EXTENSION.has(extension);
  const isTextCandidate = AGENT_CONTEXT_TEXT_EXTENSIONS.has(extension);
  if (!isImageCandidate && !isTextCandidate) {
    return { rejected: { path: absolutePath, name, reason: "This file type is not supported for agent context." } };
  }

  if (isImageCandidate && stats.size > AGENT_CONTEXT_MAX_IMAGE_BYTES) {
    return { rejected: { path: absolutePath, name, reason: "This image is too large for agent context." } };
  }

  if (isTextCandidate && stats.size > AGENT_CONTEXT_MAX_FILE_BYTES) {
    return { rejected: { path: absolutePath, name, reason: "This text file is too large for agent context." } };
  }

  const buffer = await fsPromises.readFile(absolutePath);
  if (isImageCandidate) {
    const mimeType = getAgentContextImageMimeType(absolutePath, buffer);
    if (!mimeType) {
      return { rejected: { path: absolutePath, name, reason: "Image bytes did not match a supported PNG, JPEG, or WebP file." } };
    }

    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    if (aggregateImageDataUrlChars + dataUrl.length > AGENT_CONTEXT_MAX_IMAGE_DATA_URL_CHARS) {
      return { rejected: { path: absolutePath, name, reason: "Attached images exceed the safe request size limit." } };
    }

    return {
      item: {
        id: createAttachmentContextId("image", absolutePath, buffer),
        kind: "image",
        path: absolutePath,
        name,
        content: `[Image attachment: ${name}]`,
        mimeType,
        sizeBytes: stats.size,
        dataUrl,
        tokenEstimate: Math.max(256, Math.ceil(stats.size / 2048)),
        originalTokenEstimate: Math.max(256, Math.ceil(stats.size / 2048)),
        source: "attachment",
      },
      imageDataUrlChars: dataUrl.length,
    };
  }

  const validation = validateAgentContextTextBuffer(buffer);
  if (!validation.ok) {
    return { rejected: { path: absolutePath, name, reason: `This file is ${validation.reason} and cannot be attached as agent context.` } };
  }

  const content = buffer.toString("utf8");
  const tokenEstimate = Math.max(1, Math.ceil(content.length / 3.5));
  return {
    item: {
      id: createAttachmentContextId("file", absolutePath, buffer),
      kind: "file",
      path: absolutePath,
      name,
      content,
      sizeBytes: stats.size,
      tokenEstimate,
      originalTokenEstimate: tokenEstimate,
      source: "attachment",
    },
  };
}

async function pickAgentContextAttachments(ownerWindow = mainWindow) {
  const dialogOptions = {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Photos and text files",
        extensions: [
          "png",
          "jpg",
          "jpeg",
          "webp",
          ...[...AGENT_CONTEXT_TEXT_EXTENSIONS].map((extension) => extension.replace(/^\./, "")),
        ],
      },
      { name: "Photos", extensions: ["png", "jpg", "jpeg", "webp"] },
      { name: "Text and code", extensions: [...AGENT_CONTEXT_TEXT_EXTENSIONS].map((extension) => extension.replace(/^\./, "")) },
    ],
  };
  const result = ownerWindow ? await dialog.showOpenDialog(ownerWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return { success: true, canceled: true, items: [], rejected: [] };
  }

  const items = [];
  const rejected = [];
  let aggregateImageDataUrlChars = 0;

  for (const filePath of result.filePaths.slice(0, AGENT_CONTEXT_MAX_PICKED_FILES)) {
    try {
      const attachment = await readPickedAgentContextAttachment(filePath, aggregateImageDataUrlChars);
      if (attachment.rejected) {
        rejected.push(attachment.rejected);
        continue;
      }

      if (attachment.item) {
        items.push(attachment.item);
        aggregateImageDataUrlChars += attachment.imageDataUrlChars || 0;
      }
    } catch (error) {
      rejected.push({
        path: filePath,
        name: sanitizeAgentContextAttachmentName(filePath),
        reason: error instanceof Error ? error.message : "Unable to attach this file.",
      });
    }
  }

  if (result.filePaths.length > AGENT_CONTEXT_MAX_PICKED_FILES) {
    rejected.push({
      name: "Additional selected files",
      reason: `Only ${AGENT_CONTEXT_MAX_PICKED_FILES} files can be attached at once.`,
    });
  }

  return { success: true, items, rejected };
}

function rankAgentContextSuggestion(candidate, query) {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) {
    return candidate.relativePath.split(/[\\/]/).length;
  }

  const name = candidate.name.toLowerCase();
  const relativePath = candidate.relativePath.toLowerCase();
  if (name === normalizedQuery) {
    return 0;
  }

  if (name.startsWith(normalizedQuery)) {
    return 1;
  }

  if (relativePath.startsWith(normalizedQuery)) {
    return 2;
  }

  if (name.includes(normalizedQuery)) {
    return 3;
  }

  return 4;
}

async function suggestAgentContextFiles(payload = {}) {
  const rootPath = ensureActiveWorkspace();
  const query = String(payload.query || "").trim().toLowerCase();
  const maxResults = normalizeAgentContextSuggestionLimit(payload.maxResults);
  const request = normalizeWorkspaceSearchRequest({ query: "", mode: "files", maxResults });
  const args = ["--files", "--no-config"];
  appendWorkspaceSearchGlobs(args, request);
  const { stdout } = await runRipgrep(args, { cwd: rootPath });
  const candidates = [];

  for (const line of stdout.split(/\r?\n/)) {
    const relativePath = normalizeAgentContextRelativePath(line.trim());
    if (!relativePath || isSensitiveAgentContextRelativePath(relativePath)) {
      continue;
    }

    const name = path.basename(relativePath);
    const haystack = `${name} ${relativePath}`.toLowerCase();
    if (query && !haystack.includes(query)) {
      continue;
    }

    const absolutePath = path.resolve(rootPath, relativePath);
    try {
      const stats = await fsPromises.stat(absolutePath);
      if (!stats.isFile()) {
        continue;
      }

      candidates.push({
        path: absolutePath,
        relativePath,
        name,
        sizeBytes: stats.size,
      });
    } catch {
      // Ignore files that disappear while suggestions are being collected.
    }
  }

  candidates.sort(
    (left, right) =>
      rankAgentContextSuggestion(left, query) - rankAgentContextSuggestion(right, query) ||
      left.relativePath.localeCompare(right.relativePath),
  );

  return { success: true, files: candidates.slice(0, maxResults) };
}

function sliceAgentContextLines(content, lineStart, lineEnd) {
  const lines = String(content || "").split(/\r?\n/);
  const start = Math.max(1, Math.min(lines.length || 1, Number.parseInt(lineStart, 10) || 1));
  const end = Math.max(start, Math.min(lines.length || start, Number.parseInt(lineEnd, 10) || start));
  return {
    lineStart: start,
    lineEnd: end,
    content: lines.slice(start - 1, end).join("\n"),
  };
}

async function readAgentContextFile(payload = {}) {
  const rootPath = ensureActiveWorkspace();
  const absolutePath = assertTrustedPath(payload.path);
  if (!isPathInsideRoot(absolutePath, rootPath)) {
    throw new Error("Blocked access to a path outside the active Project.");
  }

  const relativePath = normalizeAgentContextRelativePath(path.relative(rootPath, absolutePath));
  if (!relativePath || isSensitiveAgentContextRelativePath(relativePath)) {
    throw new Error("This file cannot be added to agent context.");
  }

  const stats = await fsPromises.stat(absolutePath);
  if (!stats.isFile()) {
    throw new Error("Only files can be added to agent context.");
  }

  const buffer = await fsPromises.readFile(absolutePath);
  const validation = validateAgentContextTextBuffer(buffer);
  if (!validation.ok) {
    throw new Error(`This file is ${validation.reason} and cannot be added to agent context.`);
  }

  const fullContent = buffer.toString("utf8");
  const hasRange = Number.isFinite(Number(payload.lineStart)) && Number.isFinite(Number(payload.lineEnd));
  const sliced = hasRange ? sliceAgentContextLines(fullContent, payload.lineStart, payload.lineEnd) : null;

  return {
    success: true,
    id: hasRange ? `selection:${relativePath}:${sliced.lineStart}-${sliced.lineEnd}` : `file:${relativePath}`,
    kind: hasRange ? "selection" : "file",
    path: absolutePath,
    relativePath,
    name: path.basename(absolutePath),
    content: sliced?.content ?? fullContent,
    lineStart: sliced?.lineStart,
    lineEnd: sliced?.lineEnd,
    source: "workspace",
  };
}

function ensureActiveWorkspace() {
  if (!currentWorkspace) {
    throw new Error("Open a Project before searching.");
  }

  return currentWorkspace;
}

async function searchWorkspace(requestPayload) {
  const request = normalizeWorkspaceSearchRequest(requestPayload);
  const rootPath = ensureActiveWorkspace();
  const startedAt = Date.now();

  if (!request.query) {
    return {
      success: true,
      results: [],
      truncated: false,
      stats: {
        totalResults: 0,
        fileResults: 0,
        folderResults: 0,
        textResults: 0,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  const results = [];
  let textResults = [];
  let textTruncated = false;

  if (request.mode === "all" || request.mode === "files" || request.mode === "folders") {
    const pathResults = await searchWorkspacePaths(request, rootPath);
    if (request.mode === "all" || request.mode === "files") {
      results.push(...pathResults.files);
    }
    if (request.mode === "all" || request.mode === "folders") {
      results.push(...pathResults.folders);
    }
  }

  if (request.mode === "all" || request.mode === "text") {
    const remainingLimit = Math.max(0, request.maxResults - results.length);
    if (remainingLimit > 0) {
      const searchResult = await searchWorkspaceText(request, rootPath, remainingLimit);
      textResults = searchResult.results;
      textTruncated = searchResult.truncated;
      results.push(...textResults);
    }
  }

  const limitedResults = results.slice(0, request.maxResults);
  return {
    success: true,
    results: limitedResults,
    truncated: textTruncated || results.length > request.maxResults,
    stats: {
      totalResults: limitedResults.length,
      fileResults: limitedResults.filter((result) => result.type === "file").length,
      folderResults: limitedResults.filter((result) => result.type === "folder").length,
      textResults: limitedResults.filter((result) => result.type === "text").length,
      durationMs: Date.now() - startedAt,
    },
  };
}

function buildJavaScriptSearchRegex(request) {
  const pattern = buildSearchPattern(request);
  const flags = `g${request.matchCase ? "" : "i"}m`;
  const regex = new RegExp(pattern, flags);
  const emptyTestRegex = new RegExp(pattern, request.matchCase ? "m" : "im");

  if (emptyTestRegex.test("")) {
    throw new Error("Search pattern must not match empty text.");
  }

  return regex;
}

function lineStartsForContent(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineColumnAtOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const lineIndex = Math.max(0, high);
  return {
    lineNumber: lineIndex + 1,
    column: offset - lineStarts[lineIndex] + 1,
  };
}

function lineTextAtOffset(content, lineStarts, offset) {
  const location = lineColumnAtOffset(lineStarts, offset);
  const start = lineStarts[location.lineNumber - 1];
  const nextStart = lineStarts[location.lineNumber] ?? content.length + 1;
  return content.slice(start, nextStart).replace(/\r?\n$/, "");
}

function expandReplacementTemplate(template, matchText, captures, offset, input, groups) {
  return String(template).replace(/\$(\$|&|`|'|<([^>]+)>|\d{1,2})/g, (token, expression, namedGroup) => {
    if (expression === "$") {
      return "$";
    }
    if (expression === "&") {
      return matchText;
    }
    if (expression === "`") {
      return input.slice(0, offset);
    }
    if (expression === "'") {
      return input.slice(offset + matchText.length);
    }
    if (namedGroup) {
      return groups?.[namedGroup] ?? "";
    }

    const captureIndex = Number.parseInt(expression, 10);
    if (!Number.isFinite(captureIndex) || captureIndex === 0) {
      return token;
    }

    return captures[captureIndex - 1] ?? "";
  });
}

function replaceContentWithPreview(content, regex, replacement, previewLimit = 4) {
  const lineStarts = lineStartsForContent(content);
  const previews = [];
  let matchCount = 0;

  regex.lastIndex = 0;
  const nextContent = content.replace(regex, (matchText, ...args) => {
    let groups;
    if (args.length > 0 && typeof args[args.length - 1] === "object") {
      groups = args.pop();
    }

    const input = args.pop();
    const offset = args.pop();
    const captures = args;
    const expandedReplacement = expandReplacementTemplate(replacement, matchText, captures, offset, input, groups);

    if (previews.length < previewLimit) {
      const location = lineColumnAtOffset(lineStarts, offset);
      previews.push({
        lineNumber: location.lineNumber,
        column: location.column,
        before: lineTextAtOffset(content, lineStarts, offset),
        after: expandedReplacement,
      });
    }

    matchCount += 1;
    return expandedReplacement;
  });

  return { content: nextContent, matchCount, previews };
}

function normalizeBlockedPaths(request, rootPath) {
  const blocked = new Set();
  for (const entry of request.blockedPaths) {
    const absolutePath = path.resolve(entry);
    if (isPathInsideRoot(absolutePath, rootPath)) {
      blocked.add(absolutePath);
    }
  }
  return blocked;
}

async function listWorkspaceTextMatchFiles(request, rootPath) {
  const { stdout } = await runRipgrep(buildRipgrepSearchArgs(request, { filesWithMatches: true }), { cwd: rootPath });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((relativePath) => resolveWorkspaceResultPath(rootPath, relativePath));
}

async function buildReplacePlan(requestPayload) {
  const request = normalizeWorkspaceSearchRequest(requestPayload);
  const rootPath = ensureActiveWorkspace();
  const regex = buildJavaScriptSearchRegex(request);
  const blocked = normalizeBlockedPaths(request, rootPath);
  const candidateFiles = await listWorkspaceTextMatchFiles(request, rootPath);
  const files = [];
  const blockedPaths = [];

  for (const filePath of candidateFiles) {
    const absolutePath = assertTrustedPath(filePath);
    const content = await fsPromises.readFile(absolutePath, "utf8");
    const replacementResult = replaceContentWithPreview(content, regex, request.replace);

    if (replacementResult.matchCount === 0 || replacementResult.content === content) {
      continue;
    }

    const entry = {
      path: absolutePath,
      relativePath: toWorkspaceRelativePath(absolutePath),
      matchCount: replacementResult.matchCount,
      previews: replacementResult.previews,
      nextContent: replacementResult.content,
    };

    files.push(entry);
    if (blocked.has(absolutePath)) {
      blockedPaths.push(absolutePath);
    }
  }

  return { request, files, blockedPaths };
}

async function previewWorkspaceReplace(requestPayload) {
  const plan = await buildReplacePlan(requestPayload);
  const files = plan.files.map(({ nextContent, ...file }) => file);

  return {
    success: true,
    files,
    totalMatches: files.reduce((total, file) => total + file.matchCount, 0),
    blockedPaths: plan.blockedPaths,
  };
}

async function applyWorkspaceReplace(requestPayload) {
  const plan = await buildReplacePlan(requestPayload);
  const blocked = new Set(plan.blockedPaths);
  const changedFiles = [];
  const skippedFiles = [];
  let totalReplacements = 0;

  for (const file of plan.files) {
    if (blocked.has(file.path)) {
      skippedFiles.push(file.path);
      continue;
    }

    await fsPromises.writeFile(file.path, file.nextContent, "utf8");
    markWorkspaceDirty(file.path);
    changedFiles.push({
      path: file.path,
      relativePath: file.relativePath,
      matchCount: file.matchCount,
      content: file.nextContent,
    });
    totalReplacements += file.matchCount;
  }

  return {
    success: true,
    changedFiles,
    skippedFiles,
    totalReplacements,
  };
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

function fileDialogFilters() {
  return [
    { name: "Supported Source Files", extensions: ["ino", "cpp", "c", "h", "hpp", "js", "jsx", "ts", "tsx", "json", "md", "txt", "css", "html", "yaml", "yml", "toml", "ini"] },
    { name: "Arduino Project Files", extensions: ["ino", "cpp", "c", "h", "hpp"] },
    { name: "All Files", extensions: ["*"] }
  ];
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
  clearAppwriteJwtCache();
  clearAppwriteReadCache();
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

function headerListValue(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(", ");
  }

  return typeof value === "string" ? value : "";
}

function storeAppwriteSessionFromNodeHeaders(headers = {}) {
  const fallbackCookies = headerListValue(headers["x-fallback-cookies"]);
  if (fallbackCookies) {
    secretStore?.set("appwrite.sessionFallback", fallbackCookies);
  }

  const cookies = Array.isArray(headers["set-cookie"])
    ? headers["set-cookie"]
    : typeof headers["set-cookie"] === "string"
      ? [headers["set-cookie"]]
      : [];

  if (cookies.length > 0) {
    const cookieHeader = cookies
      .map((value) => String(value).split(";")[0])
      .filter(Boolean)
      .join("; ");

    if (cookieHeader) {
      secretStore?.set("appwrite.sessionCookie", cookieHeader);
    }
  }
}

function parseAppwriteNodePayload(headers, buffer) {
  const text = buffer.toString("utf8");
  if (headerListValue(headers["content-type"]).includes("application/json")) {
    try {
      return JSON.parse(text || "{}");
    } catch {
      return { message: text };
    }
  }

  return { message: text };
}

async function appwriteRawUploadRequest({ method = "POST", pathName, queries = [], rawBody, headers: requestHeaders = {}, useSession = true }, onUploadProgress) {
  if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID) {
    throw new Error("Appwrite endpoint or project ID is missing from the local manifest.");
  }

  const normalizedPath = String(pathName || "").replace(/^\/+/, "");
  const url = new URL(`${APPWRITE_ENDPOINT}/${normalizedPath}`);
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  const headers = {
    "X-Appwrite-Project": APPWRITE_PROJECT_ID,
    "X-Appwrite-Response-Format": "1.4.0",
    "Content-Length": String(bodyBuffer.length),
  };

  if (Array.isArray(queries)) {
    queries.filter(Boolean).forEach((query) => {
      url.searchParams.append("queries[]", query);
    });
  }

  if (useSession) {
    Object.assign(headers, getAppwriteSessionHeaders());
  }
  Object.assign(headers, requestHeaders);

  const transport = url.protocol === "https:" ? https : http;
  const totalBytes = bodyBuffer.length;

  return await new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        storeAppwriteSessionFromNodeHeaders(response.headers);
        const payload = parseAppwriteNodePayload(response.headers, Buffer.concat(chunks));

        if (Number(response.statusCode || 0) < 200 || Number(response.statusCode || 0) >= 300) {
          const error = new Error(payload?.message || `Appwrite request failed with status ${response.statusCode}.`);
          error.status = response.statusCode;
          error.type = payload?.type || "appwrite_error";
          reject(error);
          return;
        }

        resolve(payload);
      });
    });

    request.on("error", reject);

    let sentBytes = 0;
    const chunkSize = 256 * 1024;
    const emitProgress = () => {
      onUploadProgress?.({
        sentBytes,
        totalBytes,
        progress: totalBytes > 0 ? Math.max(0, Math.min(100, (sentBytes / totalBytes) * 100)) : 100,
      });
    };

    const writeNextChunk = () => {
      if (sentBytes >= totalBytes) {
        request.end();
        emitProgress();
        return;
      }

      const nextSentBytes = Math.min(totalBytes, sentBytes + chunkSize);
      const canContinue = request.write(bodyBuffer.subarray(sentBytes, nextSentBytes));
      sentBytes = nextSentBytes;
      emitProgress();

      if (canContinue) {
        setImmediate(writeNextChunk);
      } else {
        request.once("drain", writeNextChunk);
      }
    };

    emitProgress();
    writeNextChunk();
  });
}

const APPWRITE_READ_CACHE_MAX_ENTRIES = 200;
const APPWRITE_BOARD_LIST_CACHE_TTL_MS = 2 * 60 * 1000;
const APPWRITE_FIRMWARE_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const APPWRITE_AGENT_BOOTSTRAP_CACHE_TTL_MS = 60 * 1000;
const APPWRITE_AGENT_THREADS_CACHE_TTL_MS = 60 * 1000;
const APPWRITE_AGENT_MESSAGES_CACHE_TTL_MS = 30 * 1000;
const APPWRITE_AGENT_SETTINGS_WARM_INITIAL_DELAY_MS = 5 * 1000;
const APPWRITE_AGENT_SETTINGS_WARM_INTERVAL_MS = 4 * 60 * 1000;
const APPWRITE_AGENT_SETTINGS_WARM_STALE_MS = 2 * 60 * 1000;
const appwriteReadCache = new Map();
const appwriteInflightReadCache = new Map();
let appwriteReadCacheEpoch = 0;
let appwriteJwtCache = { sessionKey: "", jwt: "", expiresAt: 0 };
let agentSettingsWarmTimer = null;
let agentSettingsWarmInFlight = null;
let lastAgentSettingsWarmAt = 0;

function cloneAppwritePayload(payload) {
  try {
    return structuredClone(payload);
  } catch {
    return JSON.parse(JSON.stringify(payload));
  }
}

function appwriteSessionCacheKey(useSession = true) {
  if (!useSession) {
    return "public";
  }

  const headers = getAppwriteSessionHeaders();
  return crypto
    .createHash("sha256")
    .update(`${headers.Cookie || ""}\n${headers["X-Fallback-Cookies"] || ""}`)
    .digest("hex");
}

function clearAppwriteJwtCache() {
  appwriteJwtCache = { sessionKey: "", jwt: "", expiresAt: 0 };
}

async function getCurrentAppwriteJwt() {
  const sessionHeaders = getAppwriteSessionHeaders();
  if (!sessionHeaders.Cookie && !sessionHeaders["X-Fallback-Cookies"]) {
    return "";
  }

  const sessionKey = appwriteSessionCacheKey(true);
  const now = Date.now();
  if (appwriteJwtCache.jwt && appwriteJwtCache.sessionKey === sessionKey && appwriteJwtCache.expiresAt > now + 60_000) {
    return appwriteJwtCache.jwt;
  }

  const token = await appwriteRequest({
    method: "POST",
    pathName: "account/jwt",
    useSession: true,
    invalidateCache: false,
  });
  const jwt = typeof token?.jwt === "string" ? token.jwt : "";
  appwriteJwtCache = {
    sessionKey,
    jwt,
    expiresAt: now + 10 * 60 * 1000,
  };
  return jwt;
}

function prewarmCurrentAppwriteJwt() {
  void getCurrentAppwriteJwt().catch(() => {
    // The first function execution will retry JWT creation if prewarming fails.
  });
}

function appwriteCacheKeyForRequest(request, cacheKey) {
  return JSON.stringify({
    cacheKey: cacheKey || "",
    endpoint: APPWRITE_ENDPOINT,
    projectId: APPWRITE_PROJECT_ID,
    session: appwriteSessionCacheKey(request.useSession !== false),
    method: String(request.method || "GET").toUpperCase(),
    pathName: String(request.pathName || "").replace(/^\/+/, ""),
    queries: Array.isArray(request.queries) ? request.queries.filter(Boolean) : [],
    body: request.body ?? null,
  });
}

function pruneAppwriteReadCache(now = Date.now()) {
  for (const [key, entry] of appwriteReadCache) {
    if (entry.expiresAt <= now) {
      appwriteReadCache.delete(key);
    }
  }

  while (appwriteReadCache.size > APPWRITE_READ_CACHE_MAX_ENTRIES) {
    const oldestKey = appwriteReadCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    appwriteReadCache.delete(oldestKey);
  }
}

function clearAppwriteReadCache() {
  appwriteReadCacheEpoch += 1;
  appwriteReadCache.clear();
  appwriteInflightReadCache.clear();
}

async function cachedAppwriteRequest(
  request,
  { ttlMs = 0, cacheKey = "", bypassCache = false, requestExecutor = appwriteRequest, shouldCachePayload = () => true } = {},
) {
  const safeTtlMs = Number(ttlMs || 0);
  if (bypassCache || !Number.isFinite(safeTtlMs) || safeTtlMs <= 0) {
    return requestExecutor(request);
  }

  const now = Date.now();
  pruneAppwriteReadCache(now);

  const key = appwriteCacheKeyForRequest(request, cacheKey);
  const cached = appwriteReadCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cloneAppwritePayload(cached.payload);
  }

  const inflight = appwriteInflightReadCache.get(key);
  if (inflight) {
    return cloneAppwritePayload(await inflight);
  }

  const cacheEpoch = appwriteReadCacheEpoch;
  const promise = requestExecutor({ ...request, invalidateCache: false })
    .then((payload) => {
      let cacheable = false;
      try {
        cacheable = shouldCachePayload(payload);
      } catch {
        cacheable = false;
      }

      if (cacheable && cacheEpoch === appwriteReadCacheEpoch) {
        appwriteReadCache.set(key, {
          expiresAt: Date.now() + safeTtlMs,
          payload: cloneAppwritePayload(payload),
        });
        pruneAppwriteReadCache();
      }
      return payload;
    })
    .finally(() => {
      appwriteInflightReadCache.delete(key);
    });

  appwriteInflightReadCache.set(key, promise);
  return cloneAppwritePayload(await promise);
}

function defaultDatabaseListCacheTtlMs(collectionId) {
  switch (collectionId) {
    case "boards":
      return APPWRITE_BOARD_LIST_CACHE_TTL_MS;
    case "firmwares":
      return APPWRITE_FIRMWARE_LIST_CACHE_TTL_MS;
    default:
      return 0;
  }
}

function functionExecutionCacheTtlMs(payload) {
  if (payload?.async && !payload?.waitForCompletion) {
    return 0;
  }

  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.agentSettingsFunctionId || payload?.functionId !== cloudConfig.agentSettingsFunctionId) {
    return 0;
  }

  const pathName = String(payload?.pathName ?? "/");
  const method = String(payload?.method ?? "POST").toUpperCase();
  if (method !== "POST") {
    return 0;
  }

  switch (pathName) {
    case "/bootstrap":
    case "/":
      return APPWRITE_AGENT_BOOTSTRAP_CACHE_TTL_MS;
    case "/threads/list":
      return APPWRITE_AGENT_THREADS_CACHE_TTL_MS;
    case "/threads/messages":
      return APPWRITE_AGENT_MESSAGES_CACHE_TTL_MS;
    default:
      return 0;
  }
}

async function appwriteRequest({ method = "GET", pathName, queries = [], body, formData, rawBody, headers: requestHeaders = {}, useSession = true, invalidateCache = true }) {
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
  Object.assign(headers, requestHeaders);

  const options = {
    method,
    headers,
  };

  if (rawBody !== undefined) {
    options.body = rawBody;
  } else if (formData) {
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

  if (invalidateCache && String(method || "GET").toUpperCase() !== "GET") {
    clearAppwriteReadCache();
  }

  return payload;
}

async function warmAgentSettingsFunction(reason = "background") {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.agentSettingsFunctionId) {
    return;
  }

  if (agentSettingsWarmInFlight) {
    return agentSettingsWarmInFlight;
  }

  agentSettingsWarmInFlight = appwriteRequest({
      method: "POST",
      pathName: `functions/${encodeURIComponent(cloudConfig.agentSettingsFunctionId)}/executions`,
      useSession: false,
      invalidateCache: false,
      body: {
        body: JSON.stringify({ reason }),
        async: false,
        path: "/warm",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    })
    .then((payload) => {
      lastAgentSettingsWarmAt = Date.now();
      return payload;
    })
    .finally(() => {
      agentSettingsWarmInFlight = null;
    });

  try {
    return await agentSettingsWarmInFlight;
  } catch (error) {
    console.warn("Agent settings warmup failed:", error?.message || error);
    return null;
  }
}

function isPassiveAgentSettingsRead(payload) {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.agentSettingsFunctionId || payload?.functionId !== cloudConfig.agentSettingsFunctionId) {
    return false;
  }

  if (String(payload?.method ?? "POST").toUpperCase() !== "POST") {
    return false;
  }

  return ["/bootstrap", "/", "/threads/list", "/threads/messages"].includes(String(payload?.pathName ?? "/"));
}

async function warmAgentSettingsFunctionIfStale(reason = "preflight") {
  if (Date.now() - lastAgentSettingsWarmAt < APPWRITE_AGENT_SETTINGS_WARM_STALE_MS) {
    return;
  }

  await warmAgentSettingsFunction(reason);
}

function startAgentSettingsWarmLoop() {
  if (agentSettingsWarmTimer) {
    clearInterval(agentSettingsWarmTimer);
  }

  setTimeout(() => {
    void warmAgentSettingsFunction("startup");
  }, APPWRITE_AGENT_SETTINGS_WARM_INITIAL_DELAY_MS);

  agentSettingsWarmTimer = setInterval(() => {
    void warmAgentSettingsFunction("interval");
  }, APPWRITE_AGENT_SETTINGS_WARM_INTERVAL_MS);

  if (typeof agentSettingsWarmTimer.unref === "function") {
    agentSettingsWarmTimer.unref();
  }
}

function cloudFirmwarePermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function cloudFirmwareFilePermissions(userId) {
  return [
    Permission.read(Role.any()),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function cloudFirmwareSourceFilePermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function normalizeSourceCodeVisibility(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SOURCE_CODE_VISIBILITIES.has(normalized) ? normalized : SOURCE_CODE_VISIBILITY_PRIVATE;
}

function sourceCodePublicReadRole() {
  return Role.users();
}

function cloudSourceSnapshotPermissions(userId, visibility = SOURCE_CODE_VISIBILITY_PRIVATE) {
  const readRole = normalizeSourceCodeVisibility(visibility) === SOURCE_CODE_VISIBILITY_PUBLIC
    ? sourceCodePublicReadRole()
    : Role.user(userId);
  return [
    Permission.read(readRole),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function normalizeSourceMarkerFlashedVia(value, operation = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === SOURCE_MARKER_FLASH_VIA_USB || normalized === SOURCE_MARKER_FLASH_VIA_OTA) {
    return normalized;
  }
  const normalizedOperation = String(operation || "").trim().toLowerCase();
  if (normalizedOperation === "firmware-release" || normalizedOperation === "ota" || normalizedOperation === "cloud-release") {
    return SOURCE_MARKER_FLASH_VIA_OTA;
  }
  return SOURCE_MARKER_FLASH_VIA_USB;
}

function requireCloudConfigForSourceSnapshots() {
  const cloudConfig = requireCloudConfigForFirmware();
  if (!cloudConfig.firmwareSourceBucketId) {
    throw new Error("Cloud firmware source snapshot storage is not configured.");
  }
  return cloudConfig;
}

function requireCloudConfigForSourceMarkers() {
  const cloudConfig = requireCloudConfigForSourceSnapshots();
  if (!cloudConfig.sourceSnapshotsCollectionId) {
    throw new Error("Cloud source marker storage is not configured.");
  }
  return cloudConfig;
}

function sourceSnapshotManifestValue(manifest) {
  if (!manifest) {
    return "";
  }
  return typeof manifest === "string" ? manifest : JSON.stringify(manifest);
}

function parseSourceSnapshotManifest(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function normalizeSourceRestoreMarker(value = null) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const markerId = String(value.markerId || "").trim();
  const snapshotChecksum = String(value.snapshotChecksum || value.sourceSnapshotChecksum || "").trim().toLowerCase();
  if (!/^source_[a-z0-9_-]{8,80}$/i.test(markerId) || !/^[a-f0-9]{64}$/.test(snapshotChecksum)) {
    return null;
  }
  return { markerId, snapshotChecksum };
}

function sourceMarkerRetentionGroup(identity = {}) {
  if (identity.cloudBoardId || identity.id) {
    return `cloud:${identity.cloudBoardId || identity.id}`;
  }
  if (identity.fingerprint) {
    return `fingerprint:${identity.fingerprint}`;
  }
  if (identity.profileId) {
    return `profile:${identity.profileId}`;
  }
  if (identity.port && identity.fqbn) {
    return `port:${identity.port}|${identity.fqbn}`;
  }
  return "";
}

function sourceSnapshotManifestMarkerId(manifest = null) {
  const metadata = manifest && typeof manifest === "object" && manifest.metadata && typeof manifest.metadata === "object"
    ? manifest.metadata
    : {};
  return String(
    metadata.sourceMarkerId ||
    metadata.sourceRestoreMarkerId ||
    metadata.sourceMarker?.markerId ||
    metadata.sourceRestoreMarker?.markerId ||
    "",
  ).trim();
}

function sourceMarkerDocumentSummary(document = null) {
  if (!document || typeof document !== "object") {
    return null;
  }
  return {
    id: document.$id || document.markerId || "",
    markerId: document.markerId || document.$id || "",
    status: document.status || "",
    retentionGroup: document.retentionGroup || "",
    boardId: document.boardId || "",
    boardName: document.boardName || "",
    boardType: document.boardType || "",
    profileId: document.profileId || "",
    fingerprint: document.fingerprint || "",
    port: document.port || "",
    uploadId: document.uploadId || "",
    firmwareId: document.firmwareId || "",
    createdAt: document.createdAt || "",
    appliedAt: document.appliedAt || "",
    sourceSnapshotFileId: document.sourceSnapshotFileId || "",
    visibility: normalizeSourceCodeVisibility(document.visibility),
    flashedVia: document.flashedVia || "",
    visibilityUpdatedAt: document.visibilityUpdatedAt || "",
  };
}

async function createPendingSourceRestoreMarker(payload = {}) {
  const cloudConfig = requireCloudConfigForSourceMarkers();
  const sourceSnapshot = payload.sourceSnapshot || {};
  if (!Array.isArray(sourceSnapshot.files) || sourceSnapshot.files.length === 0) {
    throw new Error("No source files were available for the cloud source marker.");
  }

  const user = await appwriteRequest({ pathName: "account" });
  const identity = normalizeBoardCodeIdentity(payload.identity || payload.sourceIdentity || payload.board || {});
  const markerId = payload.markerId || `source_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const retentionGroup = String(payload.retentionGroup || sourceMarkerRetentionGroup(identity)).trim();
  if (!retentionGroup) {
    throw new Error("Cloud source marker requires a board identity.");
  }
  const operation = payload.operation || sourceSnapshot.metadata?.operation || "source-marker-upload";
  const visibility = normalizeSourceCodeVisibility(payload.visibility || payload.sourceCodeVisibility || payload.metadata?.sourceCodeVisibility || identity.sourceCodeVisibility);
  const flashedVia = normalizeSourceMarkerFlashedVia(payload.flashedVia || payload.metadata?.flashedVia, operation);

  let snapshot = null;
  try {
    snapshot = await createAndUploadSourceSnapshot({
      fileId: markerId,
      sourceSnapshot,
      visibility,
      metadata: {
        operation,
        ...(payload.metadata || {}),
        sourceMarkerId: markerId,
        sourceMarkerVersion: 1,
        retentionGroup,
        sourceCodeVisibility: visibility,
        flashedVia,
        boardId: identity.cloudBoardId || identity.id || "",
        boardName: identity.boardName || sourceSnapshot.metadata?.boardName || "",
        boardType: identity.fqbn || "",
        profileId: identity.profileId || "",
        fingerprint: identity.fingerprint || "",
        port: identity.port || "",
        uploadId: payload.uploadId || sourceSnapshot.metadata?.uploadId || "",
        firmwareId: payload.firmwareId || "",
      },
    });

    const now = new Date().toISOString();
    const documentData = {
      userId: user.$id,
      markerId,
      sourceSnapshotFileId: snapshot.fileId,
      sourceSnapshotChecksum: snapshot.checksum,
      sourceSnapshotManifest: sourceSnapshotManifestValue(snapshot.manifest),
      status: SOURCE_MARKER_STATUS_PENDING,
      retentionGroup,
      visibility,
      flashedVia,
      visibilityUpdatedAt: now,
      boardId: identity.cloudBoardId || identity.id || "",
      boardName: identity.boardName || sourceSnapshot.metadata?.boardName || "",
      boardType: identity.fqbn || "",
      profileId: identity.profileId || "",
      fingerprint: identity.fingerprint || "",
      port: identity.port || "",
      uploadId: payload.uploadId || sourceSnapshot.metadata?.uploadId || "",
      firmwareId: payload.firmwareId || "",
      createdAt: now,
      appliedAt: null,
    };
    const document = await appwriteRequest({
      method: "POST",
      pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.sourceSnapshotsCollectionId)}/documents`,
      body: {
        documentId: markerId,
        data: documentData,
        permissions: cloudSourceSnapshotPermissions(user.$id, visibility),
      },
    });

    return {
      markerId,
      snapshotChecksum: snapshot.checksum,
      sourceSnapshotFileId: snapshot.fileId,
      sourceSnapshotChecksum: snapshot.checksum,
      sourceSnapshotManifest: snapshot.manifest,
      createdAt: snapshot.createdAt,
      retentionGroup,
      document,
      status: SOURCE_MARKER_STATUS_PENDING,
    };
  } catch (error) {
    if (snapshot?.fileId) {
      await deleteAppwriteFileQuiet(cloudConfig.firmwareSourceBucketId, snapshot.fileId);
    }
    throw error;
  }
}

async function getSourceMarkerDocument(markerId) {
  const cloudConfig = requireCloudConfigForSourceMarkers();
  const normalizedMarkerId = String(markerId || "").trim();
  if (!normalizedMarkerId) {
    return null;
  }
  try {
    return await appwriteRequest({
      pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.sourceSnapshotsCollectionId)}/documents/${encodeURIComponent(normalizedMarkerId)}`,
    });
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }
    throw error;
  }
}

async function deleteAppwriteFileQuiet(bucketId, fileId) {
  if (!bucketId || !fileId) {
    return;
  }
  try {
    await appwriteRequest({
      method: "DELETE",
      pathName: `storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}`,
    });
  } catch (error) {
    if (error?.status !== 404) {
      console.warn("Unable to delete source marker file:", error.message || error);
    }
  }
}

async function updateAppwriteFilePermissionsQuiet(bucketId, fileId, permissions = []) {
  if (!bucketId || !fileId || !Array.isArray(permissions) || permissions.length === 0) {
    return;
  }
  try {
    await appwriteRequest({
      method: "PUT",
      pathName: `storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}`,
      body: {
        permissions,
      },
    });
  } catch (error) {
    console.warn("Unable to update source snapshot file permissions:", error.message || error);
  }
}

async function deleteSourceMarkerDocumentQuiet(cloudConfig, documentId) {
  if (!documentId) {
    return;
  }
  try {
    await appwriteRequest({
      method: "DELETE",
      pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.sourceSnapshotsCollectionId)}/documents/${encodeURIComponent(documentId)}`,
    });
  } catch (error) {
    if (error?.status !== 404) {
      console.warn("Unable to delete source marker document:", error.message || error);
    }
  }
}

async function discardSourceRestoreMarker(payload = {}) {
  const cloudConfig = requireCloudConfigForSourceMarkers();
  const markerId = String(payload.markerId || payload.sourceRestoreMarker?.markerId || "").trim();
  if (!markerId) {
    return { discarded: false };
  }
  const document = await getSourceMarkerDocument(markerId);
  if (!document) {
    return { discarded: false };
  }
  if (document.status === SOURCE_MARKER_STATUS_PENDING) {
    await deleteAppwriteFileQuiet(cloudConfig.firmwareSourceBucketId, document.sourceSnapshotFileId);
    await deleteSourceMarkerDocumentQuiet(cloudConfig, document.$id || markerId);
    clearAppwriteReadCache();
    return { discarded: true };
  }
  return { discarded: false, reason: `Source marker is ${document.status || "not pending"}.` };
}

async function listSourceMarkerDocuments(retentionGroup, queries = []) {
  const cloudConfig = requireCloudConfigForSourceMarkers();
  if (!retentionGroup) {
    return [];
  }
  const response = await appwriteRequest({
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.sourceSnapshotsCollectionId)}/documents`,
    queries: [
      Query.equal("retentionGroup", retentionGroup),
      ...queries,
    ],
  });
  return Array.isArray(response.documents) ? response.documents : [];
}

async function applySourceMarkerRetention(cloudConfig, retentionGroup, currentMarkerId) {
  const documents = await listSourceMarkerDocuments(retentionGroup, [
    Query.orderDesc("createdAt"),
    Query.limit(25),
  ]);
  const currentDocuments = documents
    .filter((document) => document.status === SOURCE_MARKER_STATUS_CURRENT && document.$id !== currentMarkerId)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const previousDocuments = documents
    .filter((document) => document.status === SOURCE_MARKER_STATUS_PREVIOUS)
    .sort((left, right) => String(right.appliedAt || right.createdAt || "").localeCompare(String(left.appliedAt || left.createdAt || "")));

  if (currentDocuments[0]) {
    await appwriteRequest({
      method: "PATCH",
      pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.sourceSnapshotsCollectionId)}/documents/${encodeURIComponent(currentDocuments[0].$id)}`,
      body: {
        data: {
          status: SOURCE_MARKER_STATUS_PREVIOUS,
        },
      },
    });
  }

  const keepPreviousId = currentDocuments[0]?.$id || previousDocuments[0]?.$id || "";
  const deleteCandidates = [
    ...currentDocuments.slice(1),
    ...previousDocuments.filter((document) => document.$id !== keepPreviousId),
    ...documents.filter((document) => document.status === SOURCE_MARKER_STATUS_PENDING && document.$id !== currentMarkerId),
  ];
  for (const document of deleteCandidates) {
    await deleteAppwriteFileQuiet(cloudConfig.firmwareSourceBucketId, document.sourceSnapshotFileId);
    await deleteSourceMarkerDocumentQuiet(cloudConfig, document.$id);
  }
}

async function promoteSourceRestoreMarker(payload = {}) {
  const cloudConfig = requireCloudConfigForSourceMarkers();
  const markerId = String(payload.markerId || payload.sourceRestoreMarker?.markerId || "").trim();
  if (!markerId) {
    return { promoted: false };
  }
  const document = await getSourceMarkerDocument(markerId);
  if (!document) {
    throw new Error("Cloud source marker was not found.");
  }
  if (document.status !== SOURCE_MARKER_STATUS_PENDING && document.status !== SOURCE_MARKER_STATUS_CURRENT) {
    throw new Error(`Cloud source marker cannot be promoted from status ${document.status}.`);
  }

  const appliedAt = new Date().toISOString();
  await appwriteRequest({
    method: "PATCH",
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.sourceSnapshotsCollectionId)}/documents/${encodeURIComponent(document.$id || markerId)}`,
    body: {
      data: {
        status: SOURCE_MARKER_STATUS_CURRENT,
        appliedAt,
        firmwareId: String(payload.firmwareId || document.firmwareId || ""),
      },
    },
  });
  await applySourceMarkerRetention(cloudConfig, document.retentionGroup, document.$id || markerId);
  clearAppwriteReadCache();
  return { promoted: true, markerId, appliedAt };
}

async function setBoardCodeVisibility(payload = {}) {
  const cloudConfig = requireCloudConfigForSourceMarkers();
  const visibility = normalizeSourceCodeVisibility(payload.visibility);
  const identity = normalizeBoardCodeIdentity(payload.identity || payload.board || payload.sourceIdentity || {});
  const retentionGroup = String(payload.retentionGroup || sourceMarkerRetentionGroup(identity)).trim();
  if (!retentionGroup) {
    throw new Error("Board code visibility requires a board identity.");
  }

  const user = await appwriteRequest({ pathName: "account" });
  const permissions = cloudSourceSnapshotPermissions(user.$id, visibility);
  const now = new Date().toISOString();
  const documents = await listSourceMarkerDocuments(retentionGroup, [
    Query.equal("status", [SOURCE_MARKER_STATUS_CURRENT, SOURCE_MARKER_STATUS_PREVIOUS]),
    Query.orderDesc("createdAt"),
    Query.limit(10),
  ]);

  let updated = 0;
  for (const document of documents) {
    await appwriteRequest({
      method: "PATCH",
      pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.sourceSnapshotsCollectionId)}/documents/${encodeURIComponent(document.$id)}`,
      body: {
        data: {
          visibility,
          visibilityUpdatedAt: now,
        },
        permissions,
      },
    });
    await updateAppwriteFilePermissionsQuiet(cloudConfig.firmwareSourceBucketId, document.sourceSnapshotFileId, permissions);
    updated += 1;
  }
  clearAppwriteReadCache();
  return {
    visibility,
    updated,
    retentionGroup,
    updatedAt: now,
  };
}

async function createAndUploadSourceSnapshot(payload = {}) {
  const cloudConfig = requireCloudConfigForSourceSnapshots();
  const sourceSnapshot = payload.sourceSnapshot || {};
  const user = await appwriteRequest({ pathName: "account" });
  const fileId = payload.fileId || `source_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const { buffer, manifest, checksum } = await boardCodeService.createSourceSnapshotZipBuffer({
    files: sourceSnapshot.files,
    metadata: {
      ...(sourceSnapshot.metadata || {}),
      ...(payload.metadata || {}),
    },
  });

  const multipart = buildMultipartBody({
    fields: [
      ["fileId", fileId],
      ...cloudSourceSnapshotPermissions(user.$id, payload.visibility).map((permission) => ["permissions[]", permission]),
    ],
    files: [
      {
        name: "file",
        filename: `${fileId}.zip`,
        contentType: "application/zip",
        buffer,
      },
    ],
  });

  const file = await appwriteRawUploadRequest({
    method: "POST",
    pathName: `storage/buckets/${encodeURIComponent(cloudConfig.firmwareSourceBucketId)}/files`,
    rawBody: multipart.body,
    headers: multipart.headers,
  });

  return {
    fileId: file.$id || fileId,
    checksum,
    manifest,
    createdAt: manifest.createdAt || new Date().toISOString(),
  };
}

async function downloadAppwriteFileBuffer(bucketId, fileId) {
  if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID) {
    throw new Error("Appwrite endpoint or project ID is missing from the local manifest.");
  }

  const url = new URL(`${APPWRITE_ENDPOINT}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}/download`);
  const response = await fetch(url, {
    headers: {
      "X-Appwrite-Project": APPWRITE_PROJECT_ID,
      "X-Appwrite-Response-Format": "1.4.0",
      ...getAppwriteSessionHeaders(),
    },
  });
  storeAppwriteSession(response);

  if (!response.ok) {
    const payload = await readAppwritePayload(response).catch(() => null);
    throw new Error(payload?.message || `Unable to download source snapshot ${fileId}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function firmwareSourceSnapshotFields(snapshot) {
  return {
    sourceSnapshotFileId: snapshot?.fileId || "",
    sourceSnapshotChecksum: snapshot?.checksum || "",
    sourceSnapshotManifest: sourceSnapshotManifestValue(snapshot?.manifest),
    sourceSnapshotCreatedAt: snapshot?.createdAt || "",
  };
}

async function fetchFirmwareDocument(cloudConfig, firmwareId = "") {
  const normalizedFirmwareId = String(firmwareId || "").trim();
  if (!normalizedFirmwareId) {
    return null;
  }
  return await appwriteRequest({
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.firmwareCollectionId)}/documents/${encodeURIComponent(normalizedFirmwareId)}`,
  });
}

async function listFirmwareDocumentsForBoard(cloudConfig, boardId, { deployedOnly = false, limit = 25 } = {}) {
  const queries = [
    Query.equal("boardId", boardId),
    Query.orderDesc("uploadedAt"),
    Query.limit(limit),
  ];
  if (deployedOnly) {
    queries.splice(1, 0, Query.equal("deployed", true));
  }

  const response = await appwriteRequest({
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.firmwareCollectionId)}/documents`,
    queries,
  });
  return Array.isArray(response.documents) ? response.documents : [];
}

async function fetchFirmwareForBoardCode(cloudConfig, boardId, firmwareId = "") {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (firmware) => {
    if (!firmware?.$id || seen.has(firmware.$id)) {
      return;
    }
    seen.add(firmware.$id);
    candidates.push(firmware);
  };

  try {
    addCandidate(await fetchFirmwareDocument(cloudConfig, firmwareId));
  } catch {
    // Fall back to board history below when the requested firmware is unavailable.
  }
  try {
    for (const firmware of await listFirmwareDocumentsForBoard(cloudConfig, boardId, { deployedOnly: true })) {
      addCandidate(firmware);
    }
  } catch {
    // Continue with the broader firmware-history query.
  }
  try {
    for (const firmware of await listFirmwareDocumentsForBoard(cloudConfig, boardId, { deployedOnly: false })) {
      addCandidate(firmware);
    }
  } catch {
    // Returning the candidates already collected is still better than failing restore entirely.
  }

  return candidates.find((firmware) => firmware.sourceSnapshotFileId) || candidates[0] || null;
}

async function restoreCloudSourceSnapshot(boardPayload = {}) {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.databaseId || !cloudConfig.boardsCollectionId || !cloudConfig.firmwareCollectionId || !cloudConfig.firmwareSourceBucketId) {
    return null;
  }

  const boardId = String(boardPayload.id || boardPayload.cloudBoardId || "").trim();
  if (!boardId) {
    return null;
  }

  const board = await appwriteRequest({
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.boardsCollectionId)}/documents/${encodeURIComponent(boardId)}`,
  });
  const firmware = await fetchFirmwareForBoardCode(cloudConfig, boardId, board.desiredFirmwareId || boardPayload.firmwareId);
  if (!firmware?.sourceSnapshotFileId) {
    return null;
  }

  const snapshotBuffer = await downloadAppwriteFileBuffer(cloudConfig.firmwareSourceBucketId, firmware.sourceSnapshotFileId);
  if (firmware.sourceSnapshotChecksum) {
    const actualChecksum = crypto.createHash("sha256").update(snapshotBuffer).digest("hex");
    if (actualChecksum !== firmware.sourceSnapshotChecksum) {
      throw new Error("Saved source snapshot checksum does not match the firmware record.");
    }
  }

  const restored = await boardCodeService.readZipEntriesFromBuffer(snapshotBuffer);
  const manifest = restored.manifest || parseSourceSnapshotManifest(firmware.sourceSnapshotManifest);
  const identity = normalizeBoardCodeIdentity({
    ...boardPayload,
    cloudBoardId: boardId,
    id: boardId,
    fqbn: board.boardType || boardPayload.fqbn || boardPayload.boardType,
  });
  const validation = boardCodeService.validateSourceSnapshotManifestForIdentity(manifest, identity, { source: "snapshot" });
  return {
    files: restored.files,
    manifest,
    validation,
    board,
    firmware,
  };
}

async function restoreSourceMarkerSnapshotDocument(document = null, boardPayload = {}, options = {}) {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.firmwareSourceBucketId || !document?.sourceSnapshotFileId) {
    return null;
  }

  const markerId = String(document.markerId || document.$id || options.marker?.markerId || "").trim();
  const expectedMarker = normalizeSourceRestoreMarker(options.marker || {
    markerId,
    snapshotChecksum: document.sourceSnapshotChecksum,
  });
  if (!SOURCE_MARKER_ALLOWED_RESTORE_STATUSES.has(String(document.status || ""))) {
    throw new Error(`Source marker ${markerId || document.$id || ""} is not current or previous.`);
  }
  if (expectedMarker && document.sourceSnapshotChecksum && expectedMarker.snapshotChecksum !== String(document.sourceSnapshotChecksum).trim().toLowerCase()) {
    throw new Error("Source marker checksum does not match the cloud source snapshot record.");
  }

  const snapshotBuffer = await downloadAppwriteFileBuffer(cloudConfig.firmwareSourceBucketId, document.sourceSnapshotFileId);
  const actualChecksum = crypto.createHash("sha256").update(snapshotBuffer).digest("hex");
  if (document.sourceSnapshotChecksum && actualChecksum !== String(document.sourceSnapshotChecksum).trim().toLowerCase()) {
    throw new Error("Saved source marker snapshot checksum does not match the cloud record.");
  }
  if (expectedMarker && actualChecksum !== expectedMarker.snapshotChecksum) {
    throw new Error("Saved source marker snapshot checksum does not match the firmware marker.");
  }

  const restored = await boardCodeService.readZipEntriesFromBuffer(snapshotBuffer);
  const manifest = restored.manifest || parseSourceSnapshotManifest(document.sourceSnapshotManifest);
  const manifestMarkerId = sourceSnapshotManifestMarkerId(manifest);
  if (!manifestMarkerId || manifestMarkerId !== markerId) {
    throw new Error("Saved source snapshot manifest does not match the firmware source marker.");
  }

  const identity = normalizeBoardCodeIdentity({
    ...boardPayload,
    cloudBoardId: boardPayload.cloudBoardId || boardPayload.id || document.boardId,
    id: boardPayload.id || document.boardId,
    fqbn: boardPayload.fqbn || boardPayload.boardType || document.boardType,
    boardType: boardPayload.boardType || document.boardType,
    profileId: boardPayload.profileId || document.profileId,
    fingerprint: boardPayload.fingerprint || document.fingerprint,
    port: boardPayload.port || document.port,
    name: boardPayload.name || document.boardName,
  });
  const validation = boardCodeService.validateSourceSnapshotManifestForIdentity(manifest, identity, { source: "source-marker" });
  if (validation.unsafeScope) {
    throw new Error(validation.reason || "Cloud source marker snapshot was rejected because it contains a broad Project snapshot.");
  }
  if (!options.verifiedFromFirmware && !validation.accepted) {
    throw new Error(validation.reason || "Cloud source marker snapshot did not match this board.");
  }

  return {
    files: restored.files,
    manifest,
    validation,
    marker: expectedMarker || { markerId, snapshotChecksum: actualChecksum },
    markerDocument: document,
    verifiedFromFirmware: Boolean(options.verifiedFromFirmware),
    restoreStatus: options.verifiedFromFirmware
      ? "firmware-marker-restored"
      : "current-marker-restored-without-firmware-verification",
  };
}

async function restoreSourceMarkerSnapshot(marker = null, boardPayload = {}, options = {}) {
  const normalizedMarker = normalizeSourceRestoreMarker(marker);
  if (!normalizedMarker) {
    return null;
  }
  const document = await getSourceMarkerDocument(normalizedMarker.markerId);
  if (!document) {
    throw new Error("Firmware source marker was found, but no matching cloud source snapshot exists.");
  }
  return restoreSourceMarkerSnapshotDocument(document, boardPayload, {
    ...options,
    marker: normalizedMarker,
    verifiedFromFirmware: true,
  });
}

async function restoreCurrentSourceMarkerSnapshotForBoard(boardPayload = {}) {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.databaseId || !cloudConfig.sourceSnapshotsCollectionId || !cloudConfig.firmwareSourceBucketId) {
    return null;
  }
  const identity = normalizeBoardCodeIdentity(boardPayload);
  const boardId = identity.cloudBoardId || boardPayload.id || "";
  if (!boardId) {
    return null;
  }
  const retentionGroup = `cloud:${boardId}`;
  const documents = await listSourceMarkerDocuments(retentionGroup, [
    Query.equal("status", SOURCE_MARKER_STATUS_CURRENT),
    Query.orderDesc("createdAt"),
    Query.limit(1),
  ]);
  if (!documents[0]) {
    return null;
  }
  return restoreSourceMarkerSnapshotDocument(documents[0], {
    ...boardPayload,
    cloudBoardId: boardId,
    id: boardId,
  }, {
    verifiedFromFirmware: false,
  });
}

function sourceMarkerSnapshotSummary(document = {}, options = {}) {
  return {
    id: document.$id || document.markerId || "",
    markerId: document.markerId || document.$id || "",
    status: document.status || "",
    visibility: normalizeSourceCodeVisibility(document.visibility),
    flashedVia: document.flashedVia || "",
    boardId: document.boardId || "",
    boardName: document.boardName || "",
    boardType: document.boardType || "",
    profileId: document.profileId || "",
    fingerprint: document.fingerprint || "",
    port: document.port || "",
    uploadId: document.uploadId || "",
    firmwareId: document.firmwareId || "",
    createdAt: document.createdAt || "",
    appliedAt: document.appliedAt || "",
    visibilityUpdatedAt: document.visibilityUpdatedAt || "",
    markerVerifiedFromFirmware: Boolean(options.markerVerifiedFromFirmware),
    firmwareMarkerMatched: Boolean(options.firmwareMarkerMatched),
    sourceSnapshotChecksum: document.sourceSnapshotChecksum || "",
  };
}

function sourceMarkerScanDiagnostic(scan = null) {
  if (!scan || typeof scan !== "object") {
    return "";
  }
  const details = [
    scan.reason || "",
    scan.scope ? `scope=${scan.scope}` : "",
    Number.isFinite(Number(scan.scannedBytes)) ? `scanned=${Number(scan.scannedBytes)} bytes` : "",
    scan.baseAddress !== null && scan.baseAddress !== undefined ? `base=0x${Number(scan.baseAddress).toString(16)}` : "",
  ].filter(Boolean);
  return details.length ? `Source marker scan: ${details.join("; ")}.` : "";
}

function sortSourceMarkerSnapshots(left, right) {
  const statusRank = (value) => {
    if (value === SOURCE_MARKER_STATUS_CURRENT) {
      return 0;
    }
    if (value === SOURCE_MARKER_STATUS_PREVIOUS) {
      return 1;
    }
    return 2;
  };
  const rankDelta = statusRank(left.status) - statusRank(right.status);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return String(right.appliedAt || right.createdAt || "").localeCompare(String(left.appliedAt || left.createdAt || ""));
}

async function listReadableSourceMarkerSnapshots(retentionGroup, options = {}) {
  const documents = await listSourceMarkerDocuments(retentionGroup, [
    Query.equal("status", [SOURCE_MARKER_STATUS_CURRENT, SOURCE_MARKER_STATUS_PREVIOUS]),
    Query.orderDesc("createdAt"),
    Query.limit(10),
  ]);
  return documents
    .filter((document) => SOURCE_MARKER_ALLOWED_RESTORE_STATUSES.has(String(document.status || "")))
    .filter((document) => !options.ownerUserId || document.userId === options.ownerUserId)
    .sort(sortSourceMarkerSnapshots)
    .slice(0, 2)
    .map((document) => sourceMarkerSnapshotSummary(document, options));
}

async function listBoardCodeSnapshots(payload = {}, eventSender = null) {
  const requestId = String(payload.requestId || `board-code-list:${crypto.randomUUID()}`);
  const boardPayload = payload.board || {};
  const identity = normalizeBoardCodeIdentity(boardPayload);
  const boardName = identity.boardName || "board";
  const warnings = [];
  const restoreAttempts = [];
  let hardwareTempDir = "";
  const emitProgress = (patch = {}) => {
    const event = {
      requestId,
      phase: patch.phase || "running",
      message: patch.message || "Checking board code snapshots...",
      progress: patch.progress ?? null,
    };
    eventSender?.send?.("toolchain:board-code-progress", event);
    upsertToolchainNotification({
      id: requestId,
      kind: "code-extraction",
      title: patch.title || `Finding code snapshots for ${boardName}`,
      detail: event.message,
      status: patch.status || "running",
      phase: event.phase,
      progress: event.progress,
      name: boardName,
      target: identity.port || identity.fqbn || boardName,
      metadata: {
        boardId: boardPayload.id || identity.cloudBoardId,
        boardType: identity.fqbn,
        port: identity.port,
      },
    });
  };

  const finish = (result, status = "success", message = "Board code snapshots checked.") => {
    emitProgress({ phase: "complete", message, progress: 100, status, title: `Code snapshots for ${boardName}` });
    return {
      status: result.status || "available",
      board: {
        id: boardPayload.id || identity.cloudBoardId || "",
        name: boardName,
        fqbn: identity.fqbn,
        port: identity.port,
        profileId: identity.profileId,
        fingerprint: identity.fingerprint,
        cloudBoardId: identity.cloudBoardId,
      },
      snapshots: Array.isArray(result.snapshots) ? result.snapshots : [],
      warnings,
      restoreAttempts,
      markerVerifiedFromFirmware: Boolean(result.markerVerifiedFromFirmware),
      sourceMarker: result.sourceMarker || null,
      markerScan: result.sourceMarker || null,
      message,
    };
  };

  try {
    if (identity.fqbn && identity.port) {
      emitProgress({ phase: "source-marker", message: "Reading Tantalum source marker from board firmware...", progress: 10 });
      const portKey = identity.port.toLowerCase();
      if (activeLocalUploadPorts.has(portKey)) {
        throw new Error(`A USB upload is already running on ${identity.port}. Wait for it to finish before viewing code.`);
      }
      if (activeSerialMonitorPorts.has(portKey)) {
        throw new Error(`Serial Monitor is open on ${identity.port}. Disconnect it before viewing code.`);
      }
      if (activeBoardCodePorts.has(portKey)) {
        throw new Error(`Code extraction is already running on ${identity.port}.`);
      }

      hardwareTempDir = boardCodeService.tempExtractionDir();
      activeBoardCodePorts.add(portKey);
      let hardware = null;
      try {
        hardware = await boardCodeService.readHardwareFirmware({
          board: identity.fqbn,
          port: identity.port,
          outputDir: hardwareTempDir,
          onProgress: (progressEvent = {}) => emitProgress({
            phase: progressEvent.phase || "source-marker",
            message: progressEvent.message || "Reading Tantalum source marker from board firmware...",
            progress: progressEvent.progress ?? null,
          }),
        });
      } finally {
        activeBoardCodePorts.delete(portKey);
      }

      const markerScan = hardware?.sourceMarkers || null;
      if (markerScan?.status === "found" && markerScan.marker) {
        restoreAttempts.push({ source: "source-marker", status: "found", reason: markerScan.reason, marker: markerScan.marker, scan: markerScan });
        let document = null;
        try {
          document = await getSourceMarkerDocument(markerScan.marker.markerId);
        } catch (error) {
          if (![401, 403, 404].includes(Number(error?.status))) {
            throw error;
          }
        }
        if (!document) {
          const message = "This board was flashed through Tantalum, but its code snapshot is private to the account that flashed it.";
          warnings.push(message);
          restoreAttempts.push({ source: "source-marker", status: "private", reason: message });
          return finish({ status: "private", snapshots: [], sourceMarker: markerScan, markerVerifiedFromFirmware: true }, "success", message);
        }
        if (!SOURCE_MARKER_ALLOWED_RESTORE_STATUSES.has(String(document.status || ""))) {
          const message = `This board has a Tantalum source marker, but its snapshot is ${document.status || "not ready"}.`;
          warnings.push(message);
          restoreAttempts.push({ source: "source-marker", status: "unavailable", reason: message });
          return finish({ status: "unavailable", snapshots: [], sourceMarker: markerScan, markerVerifiedFromFirmware: true }, "success", message);
        }

        const snapshots = await listReadableSourceMarkerSnapshots(document.retentionGroup, {
          markerVerifiedFromFirmware: true,
          firmwareMarkerMatched: true,
        });
        if (snapshots.length === 0) {
          const message = "This board was flashed through Tantalum, but no readable source snapshots are available.";
          warnings.push(message);
          return finish({ status: "private", snapshots: [], sourceMarker: markerScan, markerVerifiedFromFirmware: true }, "success", message);
        }
        return finish({ status: "available", snapshots, sourceMarker: markerScan, markerVerifiedFromFirmware: true }, "success", "Source snapshots are available.");
      }

      if (markerScan?.status === "ambiguous") {
        const message = markerScan.reason || "Multiple Tantalum source markers were found in firmware. Exact restore is blocked.";
        warnings.push(message);
        const diagnostic = sourceMarkerScanDiagnostic(markerScan);
        if (diagnostic) {
          warnings.push(diagnostic);
        }
        restoreAttempts.push({ source: "source-marker", status: "rejected", reason: message, scan: markerScan });
        return finish({ status: "unavailable", snapshots: [], sourceMarker: markerScan, markerVerifiedFromFirmware: true }, "success", message);
      }

      const diagnostic = sourceMarkerScanDiagnostic(markerScan);
      if (diagnostic) {
        warnings.push(diagnostic);
      }
      const retentionGroup = sourceMarkerRetentionGroup(identity);
      if (retentionGroup) {
        const account = await appwriteRequest({ pathName: "account" }).catch(() => null);
        if (account?.$id) {
          const snapshots = await listReadableSourceMarkerSnapshots(retentionGroup, {
            markerVerifiedFromFirmware: false,
            firmwareMarkerMatched: false,
            ownerUserId: account.$id,
          });
          if (snapshots.length > 0) {
            const message = "Tantalum could not verify a source marker in board flash. Showing unverified source snapshots saved for this board.";
            warnings.push(message);
            restoreAttempts.push({ source: "source-marker", status: "unverified-fallback", reason: markerScan?.reason || message, scan: markerScan, retentionGroup });
            return finish({
              status: "available-unverified",
              snapshots,
              sourceMarker: markerScan,
              markerVerifiedFromFirmware: false,
            }, "success", message);
          }
        }
      }

      const message = "This board was not flashed through Tantalum, so exact source restore is unavailable.";
      warnings.push(message);
      restoreAttempts.push({ source: "source-marker", status: "miss", reason: markerScan?.reason || message });
      return finish({ status: "not-tantalum-flashed", snapshots: [], sourceMarker: markerScan, markerVerifiedFromFirmware: true }, "success", message);
    }

    if (identity.cloudBoardId || boardPayload.id) {
      emitProgress({ phase: "source-marker", message: "Checking cloud source snapshots...", progress: 15 });
      const retentionGroup = `cloud:${identity.cloudBoardId || boardPayload.id}`;
      const snapshots = await listReadableSourceMarkerSnapshots(retentionGroup, {
        markerVerifiedFromFirmware: false,
        firmwareMarkerMatched: false,
      });
      if (snapshots.length === 0) {
        const message = "No source snapshots are available for this cloud board.";
        warnings.push(message);
        restoreAttempts.push({ source: "source-marker", status: "miss", reason: message });
        return finish({ status: "unavailable", snapshots: [], markerVerifiedFromFirmware: false }, "success", message);
      }
      warnings.push("These cloud snapshots were not verified from connected board firmware.");
      return finish({ status: "available", snapshots, markerVerifiedFromFirmware: false }, "success", "Source snapshots are available.");
    }

    const message = "Connect a board flashed through Tantalum or select a cloud board with source snapshots.";
    warnings.push(message);
    return finish({ status: "unavailable", snapshots: [], markerVerifiedFromFirmware: false }, "success", message);
  } finally {
    if (hardwareTempDir) {
      fsPromises.rm(hardwareTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function restoreBoardCodeSnapshot(payload = {}, eventSender = null) {
  const requestId = String(payload.requestId || `board-code-restore:${crypto.randomUUID()}`);
  const boardPayload = payload.board || {};
  const identity = normalizeBoardCodeIdentity(boardPayload);
  const markerId = String(payload.markerId || payload.snapshotId || payload.snapshot?.markerId || payload.snapshot?.id || "").trim();
  if (!markerId) {
    throw new Error("Choose a source snapshot to restore.");
  }

  const document = await getSourceMarkerDocument(markerId);
  if (!document) {
    throw new Error("The selected source snapshot is unavailable or private to another account.");
  }

  const boardName = document.boardName || identity.boardName || "board";
  const destination = await resolveBoardCodeDestination(payload.destination, boardName);
  const emitProgress = (patch = {}) => {
    const event = {
      requestId,
      phase: patch.phase || "restore",
      message: patch.message || "Restoring board code snapshot...",
      progress: patch.progress ?? null,
    };
    eventSender?.send?.("toolchain:board-code-progress", event);
    upsertToolchainNotification({
      id: requestId,
      kind: "code-extraction",
      title: patch.title || `Restoring code for ${boardName}`,
      detail: event.message,
      status: patch.status || "running",
      phase: event.phase,
      progress: event.progress,
      name: boardName,
      target: identity.port || identity.fqbn || boardName,
      metadata: {
        boardId: boardPayload.id || identity.cloudBoardId || document.boardId,
        boardType: identity.fqbn || document.boardType,
        port: identity.port || document.port,
      },
    });
  };

  emitProgress({ phase: "snapshot", message: "Downloading source snapshot...", progress: 20 });
  const markerSnapshot = await restoreSourceMarkerSnapshotDocument(document, boardPayload, {
    verifiedFromFirmware: Boolean(payload.markerVerifiedFromFirmware),
  });
  if (!markerSnapshot?.files?.length) {
    throw new Error("The selected source snapshot did not contain restorable files.");
  }

  emitProgress({ phase: "write", message: "Writing source files...", progress: 70 });
  const warnings = [];
  if (!payload.markerVerifiedFromFirmware) {
    warnings.push("Restored snapshot was not verified from connected board firmware.");
  }
  const result = await writeBoardCodeOutput({
    outputDir: destination.outputDir,
    workspacePath: destination.workspacePath,
    boardName: document.boardName || boardName,
    board: document.boardType || identity.fqbn,
    source: "snapshot",
    sourceFiles: markerSnapshot.files,
    warnings,
    notes: payload.markerVerifiedFromFirmware
      ? "Restored exact source using the Tantalum source marker embedded in the board firmware."
      : "Restored exact source from a saved Tantalum source snapshot for this cloud board.",
    metadata: {
      identity,
      extractionMode: "snapshot-only",
      restoreAttempts: [{
        source: "source-marker",
        status: "accepted",
        reason: markerSnapshot.restoreStatus,
        validation: markerSnapshot.validation,
        marker: markerSnapshot.marker,
      }],
      sourceSnapshotManifest: markerSnapshot.manifest,
      snapshotAccepted: true,
      snapshotRejectReason: "",
      reconstructionRequested: false,
      sourceMarker: {
        ...markerSnapshot.marker,
        document: sourceMarkerDocumentSummary(markerSnapshot.markerDocument),
      },
      markerVerifiedFromFirmware: Boolean(payload.markerVerifiedFromFirmware),
      markerRestoreStatus: markerSnapshot.restoreStatus,
      snapshot: sourceMarkerSnapshotSummary(document, {
        markerVerifiedFromFirmware: Boolean(payload.markerVerifiedFromFirmware),
      }),
    },
  });
  emitProgress({ phase: "complete", message: "Source snapshot restored.", progress: 100, status: "success", title: `Restored code for ${boardName}` });
  return result;
}

async function resolveBoardCodeDestination(destination = {}, boardName = "board") {
  const mode = destination.mode === "new" ? "new" : "current";
  if (mode === "new") {
    const folderPath = String(destination.folderPath || "").trim();
    if (!folderPath) {
    throw new Error("Choose a folder for the new Project.");
    }
    const workspacePath = path.resolve(folderPath);
    await fsPromises.mkdir(workspacePath, { recursive: true });
    registerTrustedPath(workspacePath);
    return {
      mode,
      workspacePath,
      outputDir: workspacePath,
    };
  }

  const rawWorkspacePath = String(destination.workspacePath || currentWorkspace || "").trim();
  if (!rawWorkspacePath) {
    throw new Error("Open a Project before writing extracted code into the current Project.");
  }
  const workspacePath = path.resolve(rawWorkspacePath);
  const stats = await fsPromises.stat(workspacePath);
  if (!stats.isDirectory()) {
    throw new Error("Current Project path is not a directory.");
  }
  const outputDir = path.join(workspacePath, "extracted-board-code", boardCodeService.defaultExtractionFolderName(boardName));
  await fsPromises.mkdir(outputDir, { recursive: true });
  return {
    mode,
    workspacePath,
    outputDir,
  };
}

function normalizeBoardCodeExtractionMode(value) {
  if (value === "force-hardware-reconstruct") {
    return "force-hardware-artifacts";
  }
  return BOARD_CODE_EXTRACTION_MODES.has(value) ? value : "restore-first";
}

function hasReconstructionEvidence(metadata = {}) {
  return Array.isArray(metadata.evidenceUsed) && metadata.evidenceUsed.length > 0;
}

function primaryBoardCodeFile(files = [], source = "", confidence = null, metadata = {}) {
  const readme = files.find((file) => /^readme\.md$/i.test(file.relativePath || file.path || ""));
  const codeFile = files.find((file) => /\.(ino|cpp|c|h|hpp)$/i.test(file.relativePath || file.path || ""));
  if (source === "hardware-ai" || source === "hardware-binary") {
    const confidentReconstruction = Number(confidence || 0) >= 0.65 && hasReconstructionEvidence(metadata);
    return confidentReconstruction ? (codeFile || readme || files[0] || null) : (readme || files[0] || null);
  }

  return codeFile
    || readme
    || files[0]
    || null;
}

function compactEspPartition(partition = null) {
  if (!partition || typeof partition !== "object") {
    return null;
  }
  return {
    index: Number.isFinite(Number(partition.index)) ? Number(partition.index) : null,
    label: String(partition.label || ""),
    type: Number.isFinite(Number(partition.type)) ? Number(partition.type) : null,
    subtype: Number.isFinite(Number(partition.subtype)) ? Number(partition.subtype) : null,
    typeName: String(partition.typeName || ""),
    subtypeName: String(partition.subtypeName || ""),
    offset: Number.isFinite(Number(partition.offset)) ? Number(partition.offset) : null,
    size: Number.isFinite(Number(partition.size)) ? Number(partition.size) : null,
    end: Number.isFinite(Number(partition.end)) ? Number(partition.end) : null,
    flags: Number.isFinite(Number(partition.flags)) ? Number(partition.flags) : null,
  };
}

function compactEspImage(image = null) {
  if (!image || typeof image !== "object") {
    return null;
  }
  return {
    valid: Boolean(image.valid),
    error: String(image.error || ""),
    partition: compactEspPartition(image.partition),
    header: image.header && typeof image.header === "object" ? {
      magic: image.header.magic,
      segmentCount: image.header.segmentCount,
      flashMode: image.header.flashMode,
      flashSizeFrequency: image.header.flashSizeFrequency,
      entryPoint: image.header.entryPoint,
      headerLength: image.header.headerLength,
    } : null,
    segments: Array.isArray(image.segments)
      ? image.segments.map((segment) => ({
          index: segment.index,
          loadAddress: segment.loadAddress,
          length: segment.length,
          fileOffset: segment.fileOffset,
          flashOffset: segment.flashOffset,
          executable: Boolean(segment.executable),
          classification: String(segment.classification || (segment.executable ? "executable" : "data")),
        }))
      : [],
    executableSegmentCount: Number.isFinite(Number(image.executableSegmentCount)) ? Number(image.executableSegmentCount) : 0,
    imageLength: Number.isFinite(Number(image.imageLength)) ? Number(image.imageLength) : null,
  };
}

function compactEspOtaEntry(entry = null) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return {
    index: entry.index,
    offset: entry.offset,
    otaSeq: entry.otaSeq,
    otaState: entry.otaState,
    crc: entry.crc,
    usable: Boolean(entry.usable),
  };
}

function summarizeEspBoardCodeEvidence(esp = null) {
  if (!esp || typeof esp !== "object") {
    return null;
  }
  return {
    partitionTableOffset: esp.partitionTableOffset,
    partitionErrors: Array.isArray(esp.partitionErrors) ? esp.partitionErrors : [],
    espPartitions: Array.isArray(esp.partitions) ? esp.partitions.map(compactEspPartition).filter(Boolean) : [],
    appPartitions: Array.isArray(esp.appPartitions) ? esp.appPartitions.map(compactEspPartition).filter(Boolean) : [],
    otaDataPartition: compactEspPartition(esp.otaDataPartition),
    otaEntries: Array.isArray(esp.otaEntries) ? esp.otaEntries.map(compactEspOtaEntry).filter(Boolean) : [],
    selectedAppPartition: compactEspPartition(esp.selectedAppPartition),
    selectedAppReason: String(esp.selectedAppReason || ""),
    espImage: compactEspImage(esp.appImage),
    appEvidenceAvailable: Boolean(esp.appEvidenceAvailable),
    appPartitionSizeRead: Number.isFinite(Number(esp.appPartitionSizeRead)) ? Number(esp.appPartitionSizeRead) : 0,
    appStringCount: Array.isArray(esp.appStrings) ? esp.appStrings.length : 0,
  };
}

async function writeBoardCodeOutput({
  outputDir,
  workspacePath,
  boardName,
  board,
  source,
  sourceFiles = [],
  warnings = [],
  model = null,
  confidence = null,
  notes = "",
  limitations = "",
  metadata = {},
  rawArtifact = null,
  rawArtifacts = [],
}) {
  const readme = boardCodeService.createExtractionReadme({
    boardName,
    board,
    source,
    warnings,
    notes,
    limitations,
    confidence,
    model,
  });
  const normalizedSourceFiles = boardCodeService.normalizeGeneratedFiles(sourceFiles);
  const hasReadme = normalizedSourceFiles.some((file) => /^readme\.md$/i.test(file.path));
  const textFiles = [
    ...(hasReadme ? [] : [{ path: "README.md", content: readme }]),
    ...normalizedSourceFiles,
    {
      path: "EXTRACTION_NOTES.md",
      content: readme,
    },
    {
      path: "metadata.json",
      content: JSON.stringify({
        version: 1,
        source,
        boardName,
        board,
        warnings,
        model,
        confidence,
        notes,
        limitations,
        createdAt: new Date().toISOString(),
        ...metadata,
      }, null, 2),
    },
  ];

  const files = await boardCodeService.writeTextFiles(outputDir, textFiles);
  const artifacts = [];
  const artifactInputs = [
    ...(rawArtifact?.path ? [rawArtifact] : []),
    ...(Array.isArray(rawArtifacts) ? rawArtifacts : []),
  ];
  const copiedArtifactPaths = new Set();
  for (const artifactInput of artifactInputs) {
    if (!artifactInput?.path) {
      continue;
    }
    const targetRelativePath = `artifacts/${artifactInput.filename || path.basename(artifactInput.path)}`;
    const artifactKey = targetRelativePath.toLowerCase();
    if (copiedArtifactPaths.has(artifactKey)) {
      continue;
    }
    const artifact = await boardCodeService.copyArtifact(outputDir, artifactInput.path, targetRelativePath);
    copiedArtifactPaths.add(artifactKey);
    artifacts.push({ ...artifact, type: artifactInput.type || artifactInput.format || "firmware-dump" });
  }

  return {
    source,
    exact: source === "snapshot" || source === "local-history",
    evidenceQuality: metadata.evidenceQuality || null,
    extractionMode: metadata.extractionMode || "restore-first",
    restoreAttempts: Array.isArray(metadata.restoreAttempts) ? metadata.restoreAttempts : [],
    snapshotManifest: metadata.sourceSnapshotManifest || metadata.snapshotManifest || null,
    snapshotAccepted: metadata.snapshotAccepted ?? null,
    snapshotRejectReason: metadata.snapshotRejectReason || "",
    reconstructionRequested: Boolean(metadata.reconstructionRequested),
    sourceMarker: metadata.sourceMarker || null,
    markerVerifiedFromFirmware: Boolean(metadata.markerVerifiedFromFirmware),
    markerRestoreStatus: metadata.markerRestoreStatus || "",
    workspacePath,
    outputPath: outputDir,
    files,
    warnings,
    model,
    confidence,
    artifacts,
    primaryFile: primaryBoardCodeFile(files, source, confidence, metadata),
  };
}

function normalizeBoardCodeIdentity(boardPayload = {}) {
  return {
    profileId: String(boardPayload.profileId || "").trim(),
    fingerprint: String(boardPayload.fingerprint || "").trim(),
    cloudBoardId: String(boardPayload.cloudBoardId || boardPayload.id || "").trim(),
    port: String(boardPayload.port || "").trim(),
    fqbn: String(boardPayload.fqbn || boardPayload.boardType || "").trim(),
    boardName: String(boardPayload.name || boardPayload.boardLabel || boardPayload.fqbn || boardPayload.id || "board").trim(),
    sourceCodeVisibility: normalizeSourceCodeVisibility(boardPayload.sourceCodeVisibility),
  };
}

async function writeUnavailableBoardCodeResult(destination, boardPayload, warnings, metadata = {}) {
  const identity = normalizeBoardCodeIdentity(boardPayload);
  return writeBoardCodeOutput({
    outputDir: destination.outputDir,
    workspacePath: destination.workspacePath,
    boardName: identity.boardName,
    board: identity.fqbn,
    source: "unavailable",
    warnings,
    notes: "Tantalum could not find a saved source snapshot or local upload history, and hardware readback was not available for this board.",
    limitations: "Exact source can only be restored from a saved source snapshot or validated local upload history. Compiled firmware readback can only produce diagnostic artifacts.",
    metadata: {
      identity,
      ...metadata,
    },
  });
}

async function viewBoardCode(payload = {}, eventSender = null) {
  const requestId = String(payload.requestId || `board-code:${crypto.randomUUID()}`);
  const boardPayload = payload.board || {};
  const identity = normalizeBoardCodeIdentity(boardPayload);
  const boardName = identity.boardName || "board";
  const warnings = [];
  const requestedExtractionMode = String(payload.extractionMode || "restore-first");
  const extractionMode = normalizeBoardCodeExtractionMode(payload.extractionMode);
  const forceHardware = extractionMode === "force-hardware-artifacts";
  const legacyReconstructMode = requestedExtractionMode === "force-hardware-reconstruct";
  const reconstructionRequested = false;
  const restoreAttempts = [];
  const snapshotList = await listBoardCodeSnapshots({ requestId, board: boardPayload }, eventSender);
  if (snapshotList.snapshots?.[0]) {
    return restoreBoardCodeSnapshot({
      requestId,
      board: boardPayload,
      destination: payload.destination,
      markerId: snapshotList.snapshots[0].markerId,
      markerVerifiedFromFirmware: snapshotList.markerVerifiedFromFirmware,
    }, eventSender);
  }
  throw new Error(snapshotList.message || "No Tantalum source snapshot is available for this board.");
  const destination = await resolveBoardCodeDestination(payload.destination, boardName);
  let hardware = null;
  let hardwareTempDir = "";
  let hardwareReadAttempted = false;
  let hardwareReadError = null;
  const emitProgress = (patch = {}) => {
    const event = {
      requestId,
      phase: patch.phase || "running",
      message: patch.message || "Viewing board code...",
      progress: patch.progress ?? null,
    };
    eventSender?.send?.("toolchain:board-code-progress", event);
    upsertToolchainNotification({
      id: requestId,
      kind: "code-extraction",
      title: patch.title || `Viewing code for ${boardName}`,
      detail: event.message,
      status: patch.status || "running",
      phase: event.phase,
      progress: event.progress,
      name: boardName,
      target: identity.port || identity.fqbn || boardName,
      metadata: {
        boardId: boardPayload.id || identity.cloudBoardId,
        boardType: identity.fqbn,
        port: identity.port,
      },
    });
  };
  const ensureHardwareRead = async () => {
    if (hardwareReadAttempted) {
      if (hardwareReadError) {
        throw hardwareReadError;
      }
      return hardware;
    }
    hardwareReadAttempted = true;
    if (!identity.fqbn || !identity.port) {
      throw new Error("Hardware readback requires a board FQBN and serial port.");
    }

    const portKey = identity.port.toLowerCase();
    if (activeLocalUploadPorts.has(portKey)) {
      throw new Error(`A USB upload is already running on ${identity.port}. Wait for it to finish before viewing code.`);
    }
    if (activeSerialMonitorPorts.has(portKey)) {
      throw new Error(`Serial Monitor is open on ${identity.port}. Disconnect it before viewing code.`);
    }
    if (activeBoardCodePorts.has(portKey)) {
      throw new Error(`Code extraction is already running on ${identity.port}.`);
    }

    hardwareTempDir = hardwareTempDir || boardCodeService.tempExtractionDir();
    activeBoardCodePorts.add(portKey);
    try {
      hardware = await boardCodeService.readHardwareFirmware({
        board: identity.fqbn,
        port: identity.port,
        outputDir: hardwareTempDir,
        onProgress: (progressEvent = {}) => emitProgress({
          phase: progressEvent.phase || "read-flash",
          message: progressEvent.message || "Reading firmware from the board...",
          progress: progressEvent.progress ?? null,
        }),
      });
      return hardware;
    } catch (error) {
      hardwareReadError = error;
      throw error;
    } finally {
      activeBoardCodePorts.delete(portKey);
    }
  };
  const cleanupHardwareTempDir = () => {
    if (!hardwareTempDir) {
      return;
    }
    const dir = hardwareTempDir;
    hardwareTempDir = "";
    fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  if (legacyReconstructMode) {
    warnings.push("Binary-to-source reconstruction was removed because it produced unreliable code. Firmware artifacts will be written instead.");
  }

  if (forceHardware) {
    restoreAttempts.push({ source: "snapshot", status: "skipped", reason: "User requested hardware firmware extraction." });
    restoreAttempts.push({ source: "local-history", status: "skipped", reason: "User requested hardware firmware extraction." });
  } else {
    if (identity.fqbn && identity.port) {
      emitProgress({ phase: "source-marker", message: "Reading board source marker...", progress: 8 });
      try {
        const markerHardware = await ensureHardwareRead();
        const markerScan = markerHardware?.sourceMarkers || null;
        if (markerScan?.status === "found" && markerScan.marker) {
          restoreAttempts.push({ source: "source-marker", status: "found", reason: markerScan.reason, marker: markerScan.marker, scan: markerScan });
          const markerSnapshot = await restoreSourceMarkerSnapshot(markerScan.marker, boardPayload, { verifiedFromFirmware: true });
          if (markerSnapshot?.files?.length) {
            restoreAttempts.push({
              source: "source-marker",
              status: "accepted",
              reason: markerSnapshot.restoreStatus,
              validation: markerSnapshot.validation,
              marker: markerSnapshot.marker,
            });
            if (markerSnapshot.validation && !markerSnapshot.validation.accepted && markerSnapshot.validation.reason) {
              warnings.push(`Firmware marker matched a source snapshot; board identity validation note: ${markerSnapshot.validation.reason}`);
            }
            const result = await writeBoardCodeOutput({
              outputDir: destination.outputDir,
              workspacePath: destination.workspacePath,
              boardName: markerSnapshot.markerDocument?.boardName || boardName,
              board: markerSnapshot.markerDocument?.boardType || identity.fqbn,
              source: "snapshot",
              sourceFiles: markerSnapshot.files,
              warnings,
              notes: "Restored exact source using the Tantalum source marker embedded in the board firmware.",
              metadata: {
                identity,
                extractionMode,
                restoreAttempts,
                sourceSnapshotManifest: markerSnapshot.manifest,
                snapshotAccepted: true,
                snapshotRejectReason: "",
                reconstructionRequested: false,
                sourceMarker: {
                  ...markerSnapshot.marker,
                  document: sourceMarkerDocumentSummary(markerSnapshot.markerDocument),
                  scan: markerScan,
                },
                markerVerifiedFromFirmware: true,
                markerRestoreStatus: markerSnapshot.restoreStatus,
              },
            });
            emitProgress({ phase: "complete", message: "Firmware source marker restored.", progress: 100, status: "success", title: `Restored code for ${boardName}` });
            cleanupHardwareTempDir();
            return result;
          }
        } else if (markerScan?.status === "ambiguous") {
          const reason = markerScan.reason || "Multiple source markers were found in firmware.";
          restoreAttempts.push({ source: "source-marker", status: "rejected", reason, scan: markerScan });
          warnings.push(reason);
        } else {
          restoreAttempts.push({ source: "source-marker", status: "miss", reason: markerScan?.reason || "No firmware source marker was found." });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unable to restore firmware source marker.";
        restoreAttempts.push({ source: "source-marker", status: "error", reason });
        warnings.push(reason);
      }
    } else if (identity.cloudBoardId || boardPayload.id) {
      emitProgress({ phase: "source-marker", message: "Checking cloud source marker...", progress: 8 });
      try {
        const markerSnapshot = await restoreCurrentSourceMarkerSnapshotForBoard(boardPayload);
        if (markerSnapshot?.files?.length) {
          restoreAttempts.push({
            source: "source-marker",
            status: "accepted",
            reason: markerSnapshot.restoreStatus,
            validation: markerSnapshot.validation,
            marker: markerSnapshot.marker,
          });
          warnings.push("Restored the current cloud source marker without firmware verification because no local board port was available.");
          const result = await writeBoardCodeOutput({
            outputDir: destination.outputDir,
            workspacePath: destination.workspacePath,
            boardName: markerSnapshot.markerDocument?.boardName || boardName,
            board: markerSnapshot.markerDocument?.boardType || identity.fqbn,
            source: "snapshot",
            sourceFiles: markerSnapshot.files,
            warnings,
            notes: "Restored exact source from the current cloud source marker for this board. The board firmware was not read because no local port was available.",
            metadata: {
              identity,
              extractionMode,
              restoreAttempts,
              sourceSnapshotManifest: markerSnapshot.manifest,
              snapshotAccepted: true,
              snapshotRejectReason: "",
              reconstructionRequested: false,
              sourceMarker: {
                ...markerSnapshot.marker,
                document: sourceMarkerDocumentSummary(markerSnapshot.markerDocument),
              },
              markerVerifiedFromFirmware: false,
              markerRestoreStatus: markerSnapshot.restoreStatus,
            },
          });
          emitProgress({ phase: "complete", message: "Cloud source marker restored.", progress: 100, status: "success", title: `Restored code for ${boardName}` });
          cleanupHardwareTempDir();
          return result;
        }
        restoreAttempts.push({ source: "source-marker", status: "miss", reason: "No current cloud source marker was available." });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unable to restore the current cloud source marker.";
        restoreAttempts.push({ source: "source-marker", status: "error", reason });
        warnings.push(reason);
      }
    }

    emitProgress({ phase: "snapshot", message: "Checking saved source snapshots...", progress: 8 });
    try {
      const snapshot = await restoreCloudSourceSnapshot(boardPayload);
      if (snapshot?.files?.length) {
        if (!snapshot.validation?.accepted) {
          const reason = snapshot.validation?.reason || "Saved source snapshot did not match this board.";
          restoreAttempts.push({ source: "snapshot", status: "rejected", reason, validation: snapshot.validation });
          warnings.push(reason);
        } else {
          restoreAttempts.push({ source: "snapshot", status: "accepted", reason: snapshot.validation.reason, validation: snapshot.validation });
          const result = await writeBoardCodeOutput({
            outputDir: destination.outputDir,
            workspacePath: destination.workspacePath,
            boardName: snapshot.board?.name || boardName,
            board: snapshot.board?.boardType || identity.fqbn,
            source: "snapshot",
            sourceFiles: snapshot.files,
            warnings,
            notes: "Restored exact source from the firmware source snapshot stored with this release.",
            metadata: {
              identity,
              extractionMode,
              restoreAttempts,
              sourceSnapshotManifest: snapshot.manifest,
              snapshotAccepted: true,
              snapshotRejectReason: "",
              reconstructionRequested: false,
              firmware: snapshot.firmware
                ? {
                    id: snapshot.firmware.$id,
                    version: snapshot.firmware.version,
                    fileId: snapshot.firmware.fileId,
                    sourceSnapshotFileId: snapshot.firmware.sourceSnapshotFileId,
                  }
                : null,
            },
          });
          emitProgress({ phase: "complete", message: "Source snapshot restored.", progress: 100, status: "success", title: `Restored code for ${boardName}` });
          cleanupHardwareTempDir();
          return result;
        }
      } else {
        restoreAttempts.push({ source: "snapshot", status: "miss", reason: "No cloud source snapshot was available." });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unable to restore the cloud source snapshot.";
      restoreAttempts.push({ source: "snapshot", status: "error", reason });
      warnings.push(reason);
    }

    emitProgress({ phase: "local-history", message: "Checking local upload history...", progress: 18 });
    try {
      const historyEntries = boardCodeService.findSourceHistoryEntries(preferenceStore, identity);
      if (historyEntries.length === 0) {
        restoreAttempts.push({ source: "local-history", status: "miss", reason: "No local upload source snapshot was available." });
      }
      for (const historyEntry of historyEntries) {
        const history = await boardCodeService.readLocalSourceHistory(historyEntry);
        const validation = boardCodeService.validateSourceSnapshotManifestForIdentity(history.manifest, identity, { source: "local-history" });
        if (!validation.accepted) {
          const reason = validation.reason || "Local source history did not match this board.";
          restoreAttempts.push({ source: "local-history", status: "rejected", reason, matchedKey: historyEntry.matchedKey, validation });
          warnings.push(reason);
          continue;
        }
        if (history.files?.length) {
          restoreAttempts.push({ source: "local-history", status: "accepted", reason: validation.reason, matchedKey: historyEntry.matchedKey, validation });
          const result = await writeBoardCodeOutput({
            outputDir: destination.outputDir,
            workspacePath: destination.workspacePath,
            boardName: historyEntry.boardName || boardName,
            board: historyEntry.board || identity.fqbn,
            source: "local-history",
            sourceFiles: history.files,
            warnings,
            notes: "Restored exact source from this machine's last successful USB upload snapshot.",
            metadata: {
              identity,
              extractionMode,
              restoreAttempts,
              sourceSnapshotManifest: history.manifest,
              snapshotAccepted: true,
              snapshotRejectReason: "",
              reconstructionRequested: false,
              localHistory: {
                id: historyEntry.id,
                checksum: historyEntry.checksum,
                createdAt: historyEntry.createdAt,
                matchedKey: historyEntry.matchedKey,
              },
            },
          });
          emitProgress({ phase: "complete", message: "Local source history restored.", progress: 100, status: "success", title: `Restored code for ${boardName}` });
          cleanupHardwareTempDir();
          return result;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unable to restore local source history.";
      restoreAttempts.push({ source: "local-history", status: "error", reason });
      warnings.push(reason);
    }
  }

  if (!identity.fqbn || !identity.port) {
    warnings.push("Hardware readback requires a board FQBN and serial port.");
    const result = await writeUnavailableBoardCodeResult(destination, boardPayload, warnings, {
      extractionMode,
      restoreAttempts,
      reconstructionRequested,
    });
    emitProgress({ phase: "complete", message: "Code extraction notes were written.", progress: 100, status: "success", title: `Code unavailable for ${boardName}` });
    return result;
  }

  try {
    emitProgress({ phase: "read-flash", message: "Reading firmware from the board...", progress: 25 });
    hardware = await ensureHardwareRead();
    const espEvidence = summarizeEspBoardCodeEvidence(hardware.esp);
    const espAppEvidenceAvailable = hardware.boardDetails?.family !== "esp" || Boolean(espEvidence?.appEvidenceAvailable);
    if (forceHardware) {
      warnings.push("Source snapshots and local upload history were skipped because hardware artifact extraction was selected.");
    }
    warnings.push("Compiled firmware cannot be converted back into exact Arduino source. Firmware readback artifacts were written for diagnostics only.");
    if (hardware.boardDetails?.family === "esp" && !espAppEvidenceAvailable) {
      warnings.push("No valid ESP application partition/image was found. Wrote binary artifacts only.");
    }
    const evidenceSummary = {
      evidenceQuality: hardware.evidenceQuality || "none",
      evidence: hardware.evidence || null,
      sourceMarkers: hardware.sourceMarkers || null,
      stringCount: hardware.strings?.length || 0,
      flashStringCount: hardware.flashStrings?.length || 0,
      readbackRanges: hardware.dump?.readbackRanges || [],
      espPartitions: espEvidence?.espPartitions || [],
      selectedAppPartition: espEvidence?.selectedAppPartition || null,
      espImage: espEvidence?.espImage || null,
      appEvidenceAvailable: Boolean(espEvidence?.appEvidenceAvailable),
      disassembly: {
        available: Boolean(hardware.disassembly?.text),
        source: hardware.disassembly?.source || "",
        tool: hardware.disassembly?.tool || "",
        command: hardware.disassembly?.command || "",
        error: hardware.disassembly?.error || "",
        truncated: Boolean(hardware.disassembly?.truncated),
      },
    };
    const espTextFiles = hardware.boardDetails?.family === "esp"
      ? [
          {
            path: "artifacts/esp-partitions.json",
            content: JSON.stringify({
              partitionTableOffset: espEvidence?.partitionTableOffset ?? null,
              partitionErrors: espEvidence?.partitionErrors || [],
              partitions: espEvidence?.espPartitions || [],
            }, null, 2),
          },
          {
            path: "artifacts/esp-selected-app.json",
            content: JSON.stringify({
              selectedAppPartition: espEvidence?.selectedAppPartition || null,
              selectedAppReason: espEvidence?.selectedAppReason || "",
              appEvidenceAvailable: Boolean(espEvidence?.appEvidenceAvailable),
              appPartitionSizeRead: espEvidence?.appPartitionSizeRead || 0,
              appStringCount: espEvidence?.appStringCount || 0,
              appPartitions: espEvidence?.appPartitions || [],
              otaDataPartition: espEvidence?.otaDataPartition || null,
              otaEntries: espEvidence?.otaEntries || [],
              espImage: espEvidence?.espImage || null,
            }, null, 2),
          },
          {
            path: "artifacts/esp-app-strings.txt",
            content: (hardware.esp?.appStrings || []).join("\n"),
          },
          {
            path: "artifacts/esp-app-disassembly.txt",
            content: hardware.disassembly?.source === "esp-app"
              ? (hardware.disassembly?.text || hardware.disassembly?.error || "No ESP app disassembly was produced.")
              : (hardware.disassembly?.error || "No ESP app disassembly was produced because no valid ESP app image was found."),
          },
        ]
      : [];
    const hardwareTextFiles = [
      {
        path: "artifacts/strings.txt",
        content: (hardware.strings || []).join("\n"),
      },
      {
        path: "artifacts/hexdump-excerpt.txt",
        content: hardware.hexdump || "",
      },
      {
        path: "artifacts/disassembly-excerpt.txt",
        content: hardware.disassembly?.text || hardware.disassembly?.error || "Disassembly was not available for this board dump.",
      },
      {
        path: "artifacts/board-details.json",
        content: JSON.stringify(hardware.boardDetails || {}, null, 2),
      },
      {
        path: "artifacts/evidence-summary.json",
        content: JSON.stringify(evidenceSummary, null, 2),
      },
      {
        path: "artifacts/readback-output.txt",
        content: hardware.dump?.commandOutput || "",
      },
      ...espTextFiles,
    ];

    if (hardware.disassembly?.error) {
      warnings.push(hardware.disassembly.error);
    }
    const result = await writeBoardCodeOutput({
      outputDir: destination.outputDir,
      workspacePath: destination.workspacePath,
      boardName,
      board: identity.fqbn,
      source: "hardware-binary",
      sourceFiles: hardwareTextFiles,
      warnings,
      model: null,
      confidence: null,
      notes: "Firmware readback succeeded. The output includes raw dump artifacts, decoded strings, hexdump, and disassembly evidence.",
      limitations: "Exact source cannot be recovered from a binary dump. Tantalum no longer generates source from board flash because reconstructed code was unreliable.",
      metadata: {
        identity,
        extractionMode,
        restoreAttempts,
        snapshotAccepted: false,
        snapshotRejectReason: restoreAttempts.find((attempt) => attempt.status === "rejected")?.reason || "",
        reconstructionRequested: false,
        evidenceQuality: hardware.evidenceQuality || "none",
        evidenceUsed: [],
        userCodeEvidence: null,
        inferredBehaviors: [],
        deterministicReconstruction: null,
        aiRejectedReason: "",
        sourceMarker: hardware.sourceMarkers || null,
        markerVerifiedFromFirmware: false,
        markerRestoreStatus: hardware.sourceMarkers?.status || "",
        firmwareDump: {
          format: hardware.dump?.format,
          filename: hardware.dump?.filename,
          size: hardware.dump?.size,
          checksum: hardware.dump?.checksum,
          readbackRanges: hardware.dump?.readbackRanges || [],
        },
        espPartitions: espEvidence?.espPartitions || [],
        selectedAppPartition: espEvidence?.selectedAppPartition || null,
        espImage: espEvidence?.espImage || null,
        appEvidenceAvailable: Boolean(espEvidence?.appEvidenceAvailable),
        readbackRanges: hardware.dump?.readbackRanges || [],
        esp: espEvidence,
        disassembly: {
          available: Boolean(hardware.disassembly?.text),
          source: hardware.disassembly?.source || "",
          tool: hardware.disassembly?.tool || "",
          command: hardware.disassembly?.command || "",
          error: hardware.disassembly?.error || "",
        },
      },
      rawArtifact: hardware.dump
        ? {
            path: hardware.dump.path,
            filename: hardware.dump.filename,
            type: "firmware-dump",
            format: hardware.dump.format,
          }
        : null,
      rawArtifacts: hardware.artifacts || [],
    });
    emitProgress({ phase: "complete", message: "Board code view is ready.", progress: 100, status: "success", title: `Viewed code for ${boardName}` });
    return result;
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Hardware readback failed.");
    const result = await writeUnavailableBoardCodeResult(destination, boardPayload, warnings, {
      extractionMode,
      restoreAttempts,
      reconstructionRequested,
    });
    emitProgress({ phase: "complete", message: "Code extraction notes were written.", progress: 100, status: "success", title: `Code unavailable for ${boardName}` });
    return result;
  } finally {
    if (hardwareTempDir) {
      fsPromises.rm(hardwareTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function escapeMultipartValue(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function buildMultipartBody({ fields = [], files = [] }) {
  const boundary = `----Tantalum${crypto.randomUUID().replace(/-/g, "")}`;
  const chunks = [];
  const appendText = (value) => chunks.push(Buffer.from(value, "utf8"));

  for (const [name, value] of fields) {
    appendText(`--${boundary}\r\n`);
    appendText(`Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n`);
    appendText(`${String(value ?? "")}\r\n`);
  }

  for (const file of files) {
    appendText(`--${boundary}\r\n`);
    appendText(`Content-Disposition: form-data; name="${escapeMultipartValue(file.name)}"; filename="${escapeMultipartValue(file.filename)}"\r\n`);
    appendText(`Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`);
    chunks.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || ""));
    appendText("\r\n");
  }

  appendText(`--${boundary}--\r\n`);
  const body = Buffer.concat(chunks);
  return {
    body,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
  };
}

function generateCloudDocumentId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function sha256HexBase64(value) {
  return crypto.createHash("sha256").update(Buffer.from(String(value || ""), "base64")).digest("hex");
}

function requireCloudConfigForFirmware() {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.databaseId || !cloudConfig.boardsCollectionId || !cloudConfig.firmwareCollectionId || !cloudConfig.firmwareBucketId) {
    throw new Error("Cloud firmware storage is not configured.");
  }

  return cloudConfig;
}

function buildCloudRuntimeConfigForAgent(board, secrets, cloudConfig, overrides = {}) {
  return {
    boardId: board.$id,
    boardName: board.name,
    wifiHostname: buildTantalumWifiHostname(board.name, board.$id),
    apiToken: secrets.apiToken,
    commandSecret: secrets.commandSecret,
    mqttTopic: secrets.mqttTopic,
    provisioningPop: secrets.provisioningPop,
    appwriteEndpoint: cloudConfig.endpoint,
    appwriteProjectId: cloudConfig.projectId,
    deviceGatewayFunctionId: cloudConfig.deviceGatewayFunctionId,
    firmwareVersion: overrides.firmwareVersion || board.firmwareVersion || "0.0.0",
    firmwareId: overrides.firmwareId || board.desiredFirmwareId || "",
    mqttHost: cloudConfig.mqttHost,
    mqttPort: cloudConfig.mqttPort,
    mqttUsername: cloudConfig.mqttUsername,
    mqttPassword: cloudConfig.mqttPassword,
    mqttCaCert: cloudConfig.mqttCaCert,
    tlsCaCert: cloudConfig.tlsCaCert,
  };
}

async function deployCloudFirmwareFromAgent(cloudConfig, boardId, firmwareId, deploymentId) {
  if (cloudConfig.boardAdminFunctionId) {
    const execution = await appwriteRequest({
      method: "POST",
      pathName: `functions/${encodeURIComponent(cloudConfig.boardAdminFunctionId)}/executions`,
      body: {
        body: JSON.stringify({ boardId, firmwareId, deploymentId }),
        async: false,
        path: "/deploy-firmware",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    });

    const responseBody = functionExecutionResponseBody(execution);
    const parsed = safeJsonParse(responseBody || JSON.stringify({
      ok: false,
      error: functionExecutionDiagnostic(execution) || "Function returned an empty response.",
    }), {
      ok: false,
      error: "Function returned an unreadable response.",
    });
    if (functionExecutionResponseStatusCode(execution) >= 400 || !parsed?.ok || parsed?.data === undefined || parsed?.data === null) {
      throw new Error(parsed?.error || responseBody || functionExecutionDiagnostic(execution) || "Function execution failed.");
    }
    return parsed.data;
  }

  const firmwareList = await appwriteRequest({
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.firmwareCollectionId)}/documents`,
    queries: [
      Query.equal("boardId", boardId),
      Query.equal("deployed", true),
      Query.limit(100),
    ],
  });
  const firmware = Array.isArray(firmwareList.documents)
    ? firmwareList.documents.find((entry) => entry.$id === firmwareId)
    : null;
  if (!firmware) {
    throw new Error("Firmware release was not found.");
  }

  const board = await appwriteRequest({
    method: "PATCH",
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.boardsCollectionId)}/documents/${encodeURIComponent(boardId)}`,
    body: {
      data: {
        desiredFirmwareId: firmwareId,
        desiredVersion: firmware.version,
        desiredDeploymentId: deploymentId,
        otaStatus: "pending",
        lastOtaError: "",
        updatedAt: new Date().toISOString(),
      },
    },
  });

  return { firmware, board };
}

async function uploadCloudFirmwareFromAgent(payload = {}) {
  const cloudConfig = requireCloudConfigForFirmware();
  const boardId = String(payload.boardId || "").trim();
  const boardType = String(payload.boardType || "").trim();
  const version = String(payload.version || "1.0.0").trim();
  if (!boardId || !boardType) {
    throw new Error("A cloud board and board FQBN are required before OTA upload.");
  }

  const user = await appwriteRequest({ pathName: "account" });
  const board = await appwriteRequest({
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.boardsCollectionId)}/documents/${encodeURIComponent(boardId)}`,
  });
  const secrets = secretStore?.get(`boards.${boardId}`) || {};
  if (!secrets.apiToken || !secrets.commandSecret || !secrets.mqttTopic || !secrets.provisioningPop) {
    throw new Error("Local board secrets are missing. Rotate the board token, then provision the board again.");
  }

  const firmwareId = generateCloudDocumentId("fw");
  const deploymentId = generateCloudDocumentId("dep");
  const notificationId = payload.notificationId || firmwareId;
  const boardName = String(payload.boardName || board.name || boardType || "cloud board");
  const cloudRuntime = buildCloudRuntimeConfigForAgent(board, secrets, cloudConfig, {
    firmwareId,
    firmwareVersion: version,
  });
  let notificationProgress = 2;
  let compileProgressEvents = 0;
  const updateFirmwareNotification = (patch = {}) => {
    notificationProgress = typeof patch.progress === "number"
      ? Math.max(notificationProgress, Math.max(0, Math.min(100, patch.progress)))
      : notificationProgress;

    upsertToolchainNotification({
      id: notificationId,
      kind: "firmware-upload",
      title: patch.title || (patch.phase === "upload" || patch.phase === "queue" ? `Uploading ${boardName} ${version}` : `Building ${boardName} ${version}`),
      detail: patch.detail || "Preparing firmware release...",
      status: patch.status || "running",
      phase: patch.phase || "prepare",
      progress: notificationProgress,
      name: boardName,
      version,
      target: boardName,
      metadata: {
        boardId,
        boardType,
        filename: patch.filename,
        agentTool: true,
      },
    });
  };

  updateFirmwareNotification({
    detail: "Preparing firmware release...",
    phase: "prepare",
    progress: 2,
  });

  const compileResult = await compileArduino(String(payload.code || DEFAULT_EDITOR_CONTENT), boardType, {
    cloudRuntime,
    signal: payload.signal,
    onProgress: (progressEvent) => {
      compileProgressEvents += 1;
      const rawMessage = typeof progressEvent === "string" ? progressEvent : progressEvent?.message || progressEvent?.phase || "";
      const normalizedMessage = latestToolchainProgressLine(rawMessage).slice(0, 180);
      const dependencyPhase = /(download|extract|install|library|dependency|index)/i.test(normalizedMessage);
      const phaseStart = dependencyPhase ? 8 : 18;
      const phaseEnd = dependencyPhase ? 18 : 68;
      const cliProgress = typeof progressEvent?.progress === "number" ? progressEvent.progress : extractLastCliProgressPercent(rawMessage);
      const estimatedProgress = cliProgress === null
        ? phaseStart + Math.min(phaseEnd - phaseStart - 1, compileProgressEvents * (dependencyPhase ? 1.2 : 0.75))
        : phaseStart + ((phaseEnd - phaseStart) * cliProgress) / 100;

      updateFirmwareNotification({
        detail: normalizedMessage || (dependencyPhase ? "Checking cloud runtime dependencies..." : "Compiling firmware release..."),
        phase: dependencyPhase ? "dependencies" : "compile",
        progress: Math.min(phaseEnd - 0.5, estimatedProgress),
      });
    },
  });

  updateFirmwareNotification({
    detail: "Calculating firmware checksum...",
    phase: "checksum",
    progress: 68,
    filename: compileResult.filename,
  });
  const checksum = sha256HexBase64(compileResult.binData);
  updateFirmwareNotification({
    title: `Uploading ${boardName} ${version}`,
    detail: "Uploading firmware to Appwrite storage...",
    phase: "upload",
    progress: 72,
    filename: compileResult.filename,
  });

  const fileBuffer = Buffer.from(compileResult.binData, "base64");
  const multipart = buildMultipartBody({
    fields: [
      ["fileId", firmwareId],
      ...cloudFirmwareFilePermissions(user.$id).map((permission) => ["permissions[]", permission]),
    ],
    files: [
      {
        name: "file",
        filename: compileResult.filename,
        contentType: "application/octet-stream",
        buffer: fileBuffer,
      },
    ],
  });

  const file = await appwriteRawUploadRequest({
    method: "POST",
    pathName: `storage/buckets/${encodeURIComponent(cloudConfig.firmwareBucketId)}/files`,
    rawBody: multipart.body,
    headers: multipart.headers,
  }, (progressEvent) => {
    const uploadProgress = 72 + (Math.max(0, Math.min(100, Number(progressEvent.progress) || 0)) * 18) / 100;
    updateFirmwareNotification({
      title: `Uploading ${boardName} ${version}`,
      detail: progressEvent.progress >= 100 ? "Queuing OTA deployment..." : "Uploading firmware to Appwrite storage...",
      phase: progressEvent.progress >= 100 ? "queue" : "upload",
      progress: progressEvent.progress >= 100 ? 90 : uploadProgress,
      filename: compileResult.filename,
    });
  });

  let sourceSnapshot = null;
  let sourceSnapshotWarning = "";
  if (cloudConfig.firmwareSourceBucketId) {
    updateFirmwareNotification({
      title: `Uploading ${boardName} ${version}`,
      detail: "Saving firmware source snapshot...",
      phase: "upload",
      progress: 90,
      filename: compileResult.filename,
    });
    try {
      sourceSnapshot = await createAndUploadSourceSnapshot({
        sourceSnapshot: payload.sourceSnapshot || {
          name: boardName,
          files: [
            {
              path: `${boardCodeService.sanitizeName(boardName || "sketch", "sketch")}.ino`,
              content: String(payload.code || DEFAULT_EDITOR_CONTENT),
            },
          ],
        },
        metadata: {
          boardId,
          boardName,
          boardType,
          firmwareId,
          version,
          source: "agent-cloud-upload",
        },
      });
    } catch (error) {
      sourceSnapshotWarning = error instanceof Error ? error.message : "Unable to save source snapshot.";
      console.warn("Unable to save cloud firmware source snapshot:", sourceSnapshotWarning);
    }
  }

  updateFirmwareNotification({
    title: `Uploading ${boardName} ${version}`,
    detail: "Updating firmware records...",
    phase: "queue",
    progress: 92,
    filename: compileResult.filename,
  });
  const existing = await appwriteRequest({
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.firmwareCollectionId)}/documents`,
    queries: [
      Query.equal("boardId", boardId),
      Query.equal("deployed", true),
      Query.limit(100),
    ],
  });
  await Promise.all(
    (Array.isArray(existing.documents) ? existing.documents : [])
      .filter((firmware) => firmware.deployed)
      .map((firmware) =>
        appwriteRequest({
          method: "PATCH",
          pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.firmwareCollectionId)}/documents/${encodeURIComponent(firmware.$id)}`,
          body: { data: { deployed: false } },
        }),
      ),
  );

  updateFirmwareNotification({
    title: `Uploading ${boardName} ${version}`,
    detail: "Creating firmware release record...",
    phase: "queue",
    progress: 94,
    filename: compileResult.filename,
  });
  const firmware = await appwriteRequest({
    method: "POST",
    pathName: `databases/${encodeURIComponent(cloudConfig.databaseId)}/collections/${encodeURIComponent(cloudConfig.firmwareCollectionId)}/documents`,
    body: {
      documentId: firmwareId,
      data: {
        userId: user.$id,
        boardId,
        version,
        fileId: file.$id,
        filename: compileResult.filename,
        size: compileResult.binSize,
        checksum,
        uploadedAt: new Date().toISOString(),
        deployed: true,
        notes: String(payload.notes || ""),
        ...firmwareSourceSnapshotFields(sourceSnapshot),
      },
      permissions: cloudFirmwarePermissions(user.$id),
    },
  });

  updateFirmwareNotification({
    title: `Uploading ${boardName} ${version}`,
    detail: "Queuing OTA deployment...",
    phase: "queue",
    progress: 96,
    filename: compileResult.filename,
  });
  await deployCloudFirmwareFromAgent(cloudConfig, boardId, firmwareId, deploymentId);
  updateFirmwareNotification({
    title: `Uploaded ${boardName} ${version}`,
    detail: "Firmware uploaded and queued for OTA deployment.",
    status: "success",
    phase: "complete",
    progress: 100,
    filename: compileResult.filename,
  });

  return {
    firmwareId,
    firmware,
    output: [
      compileResult.output || compileResult.message || "Compilation successful.",
      `Firmware ${version} uploaded to Appwrite storage and queued for OTA deployment.`,
      sourceSnapshotWarning ? `Source snapshot warning: ${sourceSnapshotWarning}` : "",
    ].filter(Boolean).join("\n\n"),
  };
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function functionExecutionResponseBody(execution) {
  if (typeof execution?.responseBody === "string") {
    if (execution.responseBody.length > 0 || typeof execution.response !== "string") {
      return execution.responseBody;
    }
  }

  if (typeof execution?.response === "string") {
    return execution.response;
  }

  return typeof execution?.responseBody === "string" ? execution.responseBody : "";
}

function functionExecutionResponseStatusCode(execution) {
  const statusCode = Number(execution?.responseStatusCode ?? execution?.statusCode ?? 0);
  return Number.isFinite(statusCode) ? statusCode : 0;
}

function cleanFunctionExecutionText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function functionExecutionDiagnostic(execution) {
  const status = String(execution?.status || "").toLowerCase();
  const duration = Number(execution?.duration || 0);
  if ((status === "timeout" || (status === "failed" && duration >= 25)) && !functionExecutionResponseBody(execution).trim()) {
    return "Function timed out before returning a response.";
  }

  return [
    cleanFunctionExecutionText(execution?.errors),
    cleanFunctionExecutionText(execution?.stderr),
    cleanFunctionExecutionText(execution?.logs),
    cleanFunctionExecutionText(execution?.stdout),
  ].find(Boolean) || "";
}

function functionExecutionIsSynchronousTimeout(execution) {
  const status = String(execution?.status || "").toLowerCase();
  const duration = Number(execution?.duration || 0);
  const diagnostic = functionExecutionDiagnostic(execution);
  return (
    /synchronous function execution timed out|error code:\s*408/i.test(diagnostic) ||
    ((status === "failed" || status === "timeout") && duration >= 29 && !functionExecutionResponseBody(execution).trim())
  );
}

function normalizeFunctionExecutionShape(execution) {
  if (!execution || typeof execution !== "object") {
    return execution;
  }

  const responseBody = functionExecutionResponseBody(execution);
  const responseStatusCode = functionExecutionResponseStatusCode(execution);
  const normalized = { ...execution };

  if (typeof normalized.responseBody !== "string" && typeof responseBody === "string") {
    normalized.responseBody = responseBody;
  }

  if (!Number.isFinite(Number(normalized.responseStatusCode)) && Number.isFinite(responseStatusCode)) {
    normalized.responseStatusCode = responseStatusCode;
  }

  if (typeof normalized.errors !== "string" && typeof execution.stderr === "string") {
    normalized.errors = execution.stderr;
  }

  if (typeof normalized.logs !== "string" && typeof execution.stdout === "string") {
    normalized.logs = execution.stdout;
  }

  return normalized;
}

function functionExecutionIsUncacheable(execution) {
  const status = String(execution?.status || "").toLowerCase();
  if (status === "failed" || status === "timeout") {
    return true;
  }

  if (functionExecutionResponseStatusCode(execution) >= 400) {
    return true;
  }

  const responseBody = functionExecutionResponseBody(execution).trim();
  if (!responseBody) {
    return true;
  }

  const parsed = safeJsonParse(responseBody, null);
  return Boolean(parsed && typeof parsed === "object" && parsed.ok === false);
}

function functionExecutionIsTerminal(execution) {
  const status = String(execution?.status || "").toLowerCase();
  return status === "completed" || status === "failed" || status === "timeout";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedPositiveNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

async function waitForFunctionExecution(functionId, executionId, { timeoutMs = 125000, pollMs = 1000 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const execution = normalizeFunctionExecutionShape(await appwriteRequest({
      method: "GET",
      pathName: `functions/${encodeURIComponent(functionId)}/executions/${encodeURIComponent(executionId)}`,
      invalidateCache: false,
    }));

    if (functionExecutionIsTerminal(execution)) {
      return execution;
    }

    await delay(pollMs);
  }

  throw new Error("Function execution did not finish before the local wait timeout.");
}

async function createFunctionExecutionAndWait(functionId, body, { timeoutMs = 125000, pollMs = 1000, invalidateCache = true } = {}) {
  const initial = normalizeFunctionExecutionShape(await appwriteRequest({
    method: "POST",
    pathName: `functions/${encodeURIComponent(functionId)}/executions`,
    body,
    invalidateCache,
  }));

  if (!body?.async || functionExecutionIsTerminal(initial)) {
    return initial;
  }

  const executionId = initial?.$id || initial?.id;
  if (!executionId) {
    throw new Error("Appwrite did not return an execution ID for the async function request.");
  }

  return waitForFunctionExecution(functionId, executionId, { timeoutMs, pollMs });
}

async function executeAgentGatewayRequest(body) {
  const cloudConfig = getRendererCloudConfig();
  if (!cloudConfig.agentGatewayFunctionId) {
    throw new Error("The agent gateway function is not configured.");
  }

  const headers = { "content-type": "application/json" };
  try {
    const jwt = await getCurrentAppwriteJwt();
    if (jwt) {
      headers["X-Appwrite-JWT"] = jwt;
    }
  } catch {
    // Appwrite will reject the function if a user session is required and unavailable.
  }

  const execution = await createFunctionExecutionAndWait(cloudConfig.agentGatewayFunctionId, {
    body: JSON.stringify(body),
    async: true,
    path: "/gateway",
    method: "POST",
    headers,
  });
  const responseBody = functionExecutionResponseBody(execution);
  const parsed = safeJsonParse(responseBody || "{}", {
    ok: false,
    error: functionExecutionDiagnostic(execution) || "Agent gateway returned an empty response.",
  });

  if (functionExecutionResponseStatusCode(execution) >= 400 || !parsed.ok) {
    throw new Error(parsed.error || responseBody || functionExecutionDiagnostic(execution) || "Agent gateway execution failed.");
  }

  return parsed.data;
}

function localBoardConfidenceLabel(confidence) {
  const value = Number(confidence || 0);
  if (value >= 0.9) {
    return "high";
  }
  if (value >= 0.55) {
    return "medium";
  }
  return "low";
}

function shouldUseBoardDetectionAi(candidate) {
  if (!candidate) {
    return false;
  }

  if (!BOARD_DETECTION_FUNCTION_ID) {
    return false;
  }

  if (candidate.detectionSource === "esptool-chip-probe") {
    return false;
  }

  return !candidate.fqbn || Number(candidate.confidence || 0) < 0.9 || (candidate.matchingBoards?.length || 0) !== 1;
}

async function executeBoardDetectionAi(candidate) {
  const headers = { "content-type": "application/json" };
  try {
    const jwt = await getCurrentAppwriteJwt();
    if (jwt) {
      headers["X-Appwrite-JWT"] = jwt;
    }
  } catch {
    // Appwrite will reject the function if a user session is required and unavailable.
  }

  const execution = await appwriteRequest({
    method: "POST",
    pathName: `functions/${encodeURIComponent(BOARD_DETECTION_FUNCTION_ID)}/executions`,
    body: {
      body: JSON.stringify({ candidate }),
      async: false,
      path: "/",
      method: "POST",
      headers,
    },
  });
  const responseBody = functionExecutionResponseBody(execution);
  const parsed = safeJsonParse(responseBody || "{}", {
    ok: false,
    error: functionExecutionDiagnostic(execution) || "Board detection AI returned an empty response.",
  });

  if (functionExecutionResponseStatusCode(execution) >= 400 || !parsed.ok) {
    throw new Error(parsed.error || responseBody || functionExecutionDiagnostic(execution) || "Board detection AI failed.");
  }

  return parsed.data || null;
}

async function applyBoardDetectionAiFallback(candidate) {
  if (!shouldUseBoardDetectionAi(candidate)) {
    return candidate;
  }

  try {
    const suggestion = await executeBoardDetectionAi(candidate);
    if (!suggestion?.fqbn) {
      return {
        ...candidate,
        ai: {
          status: "no-suggestion",
          reason: suggestion?.reason || "No confident board match was returned.",
        },
      };
    }

    const confidence = Number.isFinite(Number(suggestion.confidence)) ? Number(suggestion.confidence) : 0.65;
    return {
      ...candidate,
      fqbn: suggestion.fqbn,
      boardLabel: suggestion.boardLabel || suggestion.name || candidate.boardLabel,
      confidence,
      confidenceLabel: localBoardConfidenceLabel(confidence),
      detectionSource: "board-detection-ai",
      ai: {
        status: "suggested",
        reason: suggestion.reason || "",
        model: suggestion.model || null,
      },
    };
  } catch (error) {
    return {
      ...candidate,
      ai: {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "Board detection AI failed.",
      },
    };
  }
}

async function detectLocalBoards(options = {}) {
  const result = await detectLocalBoardsDeterministic({
    portsOnly: Boolean(options.portsOnly),
    probeEsp: Boolean(options.probeEsp),
  });
  const boards = options.aiFallback
    ? await Promise.all(result.boards.map(applyBoardDetectionAiFallback))
    : result.boards;
  return {
    ...result,
    boards,
  };
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

  const recentWorkspacesSubmenu = getRecentWorkspaces().length
    ? [
        ...getRecentWorkspaces().map((workspacePath) => ({
          label: path.basename(workspacePath) || workspacePath,
          click: () => {
            registerTrustedPath(workspacePath);
            sendMenuAction({ type: "open-recent-workspace", folderPath: workspacePath });
          }
        })),
        { type: "separator" },
        {
          label: "Clear Recent Folders",
          click: () => {
            preferenceStore?.set("recentWorkspaces", []);
            createMenu();
          }
        }
      ]
    : [{ label: "No Recent Folders", enabled: false }];

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
          label: "Clear Recent Files",
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
        { label: "New File", accelerator: "CmdOrCtrl+N", click: () => sendMenuAction({ type: "new-file" }) },
        { label: "Open File...", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction({ type: "open-file" }) },
        { label: "Open Project...", accelerator: "CmdOrCtrl+Shift+O", click: () => sendMenuAction({ type: "open-folder" }) },
        {
          label: "Open Recent",
          submenu: [
            { label: "Projects", submenu: recentWorkspacesSubmenu },
            { label: "Files", submenu: recentFilesSubmenu }
          ]
        },
        { label: "Examples", submenu: examplesSubmenu },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenuAction({ type: "save-file" }) },
        { label: "Save As...", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenuAction({ type: "save-file-as" }) },
        { type: "separator" },
        { label: "Show Project Folder", accelerator: "CmdOrCtrl+K", click: () => sendMenuAction({ type: "show-sketch-folder" }) },
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
      label: "View",
      submenu: [
        { label: "Explorer", click: () => sendMenuAction({ type: "show-explorer" }) },
        { label: "Boards", click: () => sendMenuAction({ type: "show-boards" }) },
        { label: "Libraries", click: () => sendMenuAction({ type: "show-libraries" }) },
        { label: "Git", click: () => sendMenuAction({ type: "show-git" }) },
        { label: "Board Platforms", click: () => sendMenuAction({ type: "show-platforms" }) },
        { label: "My Projects", click: () => sendMenuAction({ type: "show-my-projects" }) },
        { type: "separator" },
        { label: "Output", click: () => sendMenuAction({ type: "show-output" }) },
        { label: "Terminal", accelerator: "CmdOrCtrl+Shift+M", click: () => sendMenuAction({ type: "toggle-terminal" }) },
        { label: "Serial Monitor", click: () => sendMenuAction({ type: "show-serial-monitor" }) }
      ]
    },
    {
      label: "Project",
      submenu: [
        { label: "Verify / Compile", accelerator: "CmdOrCtrl+R", click: () => sendMenuAction({ type: "compile" }) },
        { label: "Upload", accelerator: "CmdOrCtrl+U", click: () => sendMenuAction({ type: "upload-local" }) },
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
        { label: "Terminal", accelerator: "CmdOrCtrl+Shift+M", click: () => sendMenuAction({ type: "toggle-terminal" }) },
        { label: "Serial Monitor", click: () => sendMenuAction({ type: "show-serial-monitor" }) }
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

function normalizeContextMenuCoordinate(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return undefined;
  }

  return Math.max(0, Math.round(numberValue));
}

function normalizeNativeContextMenuAccelerator(shortcut) {
  if (typeof shortcut !== "string") {
    return undefined;
  }

  const normalized = shortcut.trim().replace(/\s+/g, "").replace(/^Ctrl\+/i, "CmdOrCtrl+").replace(/^Control\+/i, "CmdOrCtrl+");
  return normalized || undefined;
}

function normalizeNativeContextMenuText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function normalizeFileTreeContextMenuGroups(groups) {
  if (!Array.isArray(groups)) {
    return [];
  }

  return groups
    .map((group) => {
      if (!Array.isArray(group)) {
        return [];
      }

      return group
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const id = normalizeNativeContextMenuText(item.id);
          const key = normalizeNativeContextMenuText(item.key, id);
          const label = normalizeNativeContextMenuText(item.label, id);
          if (!id || !key || !label) {
            return null;
          }

          return {
            id,
            key,
            label,
            enabled: !item.disabled,
            accelerator: normalizeNativeContextMenuAccelerator(item.shortcut),
          };
        })
        .filter(Boolean);
    })
    .filter((group) => group.length > 0);
}

function createFileTreeContextMenuTemplate(groups, finish, includeAccelerators = true) {
  const template = [];

  for (const group of groups) {
    if (template.length > 0) {
      template.push({ type: "separator" });
    }

    for (const item of group) {
      template.push({
        label: item.label,
        enabled: item.enabled,
        ...(includeAccelerators && item.accelerator ? { accelerator: item.accelerator } : {}),
        click: () => finish({ actionKey: item.key, actionId: item.id }),
      });
    }
  }

  return template;
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

function createSerialMonitorSessionId() {
  serialMonitorSessionCounter += 1;
  return `serial-monitor-${serialMonitorSessionCounter}`;
}

function normalizeSerialMonitorPort(value) {
  const port = String(value || "").trim();
  if (!port) {
    throw new Error("Select a serial port before opening Serial Monitor.");
  }

  return port;
}

function normalizeSerialMonitorBaudRate(value) {
  const baudRate = Number(value);
  if (!Number.isInteger(baudRate) || baudRate < 300 || baudRate > 2000000) {
    throw new Error("Use a valid serial baud rate between 300 and 2000000.");
  }

  return baudRate;
}

function serialMonitorPortKey(port) {
  return String(port || "").trim().toLowerCase();
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeProcessPath(value) {
  return String(value || "").trim().replace(/\//g, "\\").toLowerCase();
}

function serialPortMentionPattern(port) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(port)}([^a-z0-9]|$)`, "i");
}

function commandMentionsSerialPort(commandLine, port) {
  return serialPortMentionPattern(port).test(String(commandLine || ""));
}

function isKnownSerialProcess(processInfo) {
  const text = `${processInfo.name || ""} ${processInfo.executablePath || ""} ${processInfo.commandLine || ""}`;
  return /\b(arduino(?:-ide|-cli)?|esptool|serial|platformio|pio|putty|tterm|teraterm|coolterm|python(?:w)?|node)\b/i.test(text);
}

function isOwnTantalumProcess(processInfo) {
  const pid = Number(processInfo.pid);
  if (pid === process.pid) {
    return true;
  }

  const executablePath = normalizeProcessPath(processInfo.executablePath);
  const commandLine = String(processInfo.commandLine || "").toLowerCase();
  const ownExecutablePath = normalizeProcessPath(process.execPath);
  const appPath = normalizeProcessPath(app.getAppPath?.());
  const userDataPath = normalizeProcessPath(app.getPath?.("userData"));

  if (ownExecutablePath && executablePath === ownExecutablePath) {
    if ((appPath && commandLine.includes(appPath)) || (userDataPath && commandLine.includes(userDataPath)) || commandLine.includes("tantalum-ide")) {
      return true;
    }
  }

  return Boolean(
    (appPath && commandLine.includes(appPath)) ||
    (userDataPath && commandLine.includes(userDataPath))
  );
}

function createExternalBlockerId(port, processInfo) {
  const signature = crypto
    .createHash("sha1")
    .update([
      String(port || "").toLowerCase(),
      String(processInfo.pid || ""),
      String(processInfo.name || ""),
      String(processInfo.executablePath || ""),
      String(processInfo.commandLine || "")
    ].join("\0"))
    .digest("hex")
    .slice(0, 12);

  return `external:${processInfo.pid}:${signature}`;
}

function mapWindowsProcessInfo(rawProcess) {
  return {
    pid: Number(rawProcess?.ProcessId ?? rawProcess?.processId ?? rawProcess?.pid),
    parentPid: Number(rawProcess?.ParentProcessId ?? rawProcess?.parentProcessId ?? rawProcess?.parentPid),
    name: String(rawProcess?.Name ?? rawProcess?.name ?? "").trim(),
    executablePath: String(rawProcess?.ExecutablePath ?? rawProcess?.executablePath ?? "").trim(),
    commandLine: String(rawProcess?.CommandLine ?? rawProcess?.commandLine ?? "").trim()
  };
}

function normalizeWindowsProcessList(payload) {
  if (!payload) {
    return [];
  }

  const parsed = JSON.parse(payload);
  if (Array.isArray(parsed)) {
    return parsed.map(mapWindowsProcessInfo);
  }

  if (parsed && typeof parsed === "object") {
    return [mapWindowsProcessInfo(parsed)];
  }

  return [];
}

function buildInternalSerialPortBlockers(port) {
  const portKey = serialMonitorPortKey(port);
  const blockers = [];

  for (const [sessionId, session] of serialMonitorSessions.entries()) {
    if (session.portKey !== portKey) {
      continue;
    }

    blockers.push({
      blockerId: `tantalum-session:${sessionId}`,
      kind: "tantalum-session",
      confidence: "confirmed",
      pid: process.pid,
      name: "Tantalum Serial Monitor",
      executablePath: null,
      commandLine: null,
      reason: `Tantalum Serial Monitor has ${session.port} open.`,
      canTerminate: true
    });
  }

  return blockers;
}

async function listWindowsSerialPortBlockers(port) {
  const script = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Depth 3 -Compress";
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000,
    windowsHide: true
  });
  const processes = normalizeWindowsProcessList(String(stdout || "").trim());
  const blockers = [];

  for (const processInfo of processes) {
    if (!Number.isInteger(processInfo.pid) || processInfo.pid <= 0) {
      continue;
    }

    if (!commandMentionsSerialPort(processInfo.commandLine, port) || isOwnTantalumProcess(processInfo)) {
      continue;
    }

    const confirmed = isKnownSerialProcess(processInfo);
    blockers.push({
      blockerId: createExternalBlockerId(port, processInfo),
      kind: "external-process",
      confidence: confirmed ? "confirmed" : "possible",
      pid: processInfo.pid,
      name: processInfo.name || `Process ${processInfo.pid}`,
      executablePath: processInfo.executablePath || null,
      commandLine: processInfo.commandLine || null,
      reason: confirmed
        ? `${processInfo.name || "This process"} references ${port} in its command line.`
        : `This process references ${port}, but it is not a recognized serial tool.`,
      canTerminate: confirmed
    });
  }

  return blockers;
}

async function listSerialPortBlockers(payload = {}) {
  const port = normalizeSerialMonitorPort(payload.port);
  const blockers = buildInternalSerialPortBlockers(port);

  if (process.platform !== "win32") {
    return {
      success: true,
      port,
      platform: process.platform,
      supported: false,
      blockers,
      message: "External serial blocker detection is currently available on Windows only."
    };
  }

  blockers.push(...await listWindowsSerialPortBlockers(port));

  return {
    success: true,
    port,
    platform: process.platform,
    supported: true,
    blockers
  };
}

async function terminateSerialPortBlocker(payload = {}) {
  const port = normalizeSerialMonitorPort(payload.port);
  const blockerId = String(payload.blockerId || "").trim();
  if (!blockerId) {
    throw new Error("Choose a serial port blocker to close.");
  }

  if (blockerId.startsWith("tantalum-session:")) {
    const sessionId = blockerId.slice("tantalum-session:".length);
    const session = serialMonitorSessions.get(sessionId);
    if (!session || session.portKey !== serialMonitorPortKey(port)) {
      throw new Error("That Tantalum Serial Monitor session is no longer open on this port.");
    }

    disposeSerialMonitorSession(sessionId, "closed", true);
    return { success: true, port, blockerId };
  }

  const currentBlockers = await listSerialPortBlockers({ port });
  if (!currentBlockers.success) {
    throw new Error(currentBlockers.error || "Unable to refresh serial port blockers.");
  }

  const blocker = currentBlockers.blockers.find((item) => item.blockerId === blockerId);
  if (!blocker) {
    throw new Error("That serial port blocker is no longer present.");
  }

  if (blocker.kind !== "external-process" || blocker.confidence !== "confirmed" || !blocker.canTerminate || !Number.isInteger(blocker.pid)) {
    throw new Error("Only confirmed external serial-tool processes can be terminated.");
  }

  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(blocker.pid), "/T", "/F"], {
      timeout: 15000,
      windowsHide: true
    });
  } else {
    process.kill(blocker.pid, "SIGTERM");
  }

  return { success: true, port, blockerId, pid: blocker.pid };
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

function finalizeSerialMonitorSession(sessionId, reason = "closed", notify = true) {
  const session = serialMonitorSessions.get(sessionId);
  if (!session) {
    return false;
  }

  serialMonitorSessions.delete(sessionId);
  if (session.portKey) {
    activeSerialMonitorPorts.delete(session.portKey);
  }
  if (notify) {
    sendRendererEvent("serial-monitor:close", { sessionId, reason });
  }
  return true;
}

function disposeSerialMonitorSession(sessionId, reason = "closed", notify = true) {
  const session = serialMonitorSessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.closing = true;
  session.closeReason = reason;
  session.notifyOnClose = notify;

  try {
    if (session.serialPort.isOpen) {
      session.serialPort.close((error) => {
        if (error) {
          console.warn(`Failed to close serial monitor ${sessionId}:`, error.message);
          finalizeSerialMonitorSession(sessionId, "error", notify);
        }
      });
      return true;
    }
  } catch (error) {
    console.warn(`Failed to close serial monitor ${sessionId}:`, error.message);
  }

  finalizeSerialMonitorSession(sessionId, reason, notify);
  return true;
}

function disposeAllSerialMonitorSessions() {
  for (const sessionId of [...serialMonitorSessions.keys()]) {
    disposeSerialMonitorSession(sessionId, "closed", false);
  }
}

async function initializeStores() {
  const Store = (await import("electron-store")).default;

  preferenceStore = new Store({ name: "tantalum-preferences" });
  secretStore = new Store({ name: "tantalum-device-secrets" });
  applyArduinoStorageRootPreference();
  interruptActiveToolchainNotifications();

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
    backgroundColor: "#00000000",
    frame: false,
    thickFrame: false,
    hasShadow: false,
    transparent: true,
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

  mainWindow.webContents.on("console-message", (details) => {
    const level = details.level || "info";
    const message = details.message || "";
    const location = details.sourceId ? `(${details.sourceId}:${details.lineNumber || 0})` : "";
    const prefix = `[renderer console:${level}]`;
    if (level === "error" || level === "warning") {
      console.error(prefix, message, location);
      return;
    }

    console.log(prefix, message, location);
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
    mainWindow.focus();
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    }
  });

  mainWindow.on("closed", () => {
    disposeAllTerminalSessions();
    disposeAllSerialMonitorSessions();
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

ipcMain.handle("app:dispatch-menu-action", async (_event, action) => {
  if (!action || typeof action.type !== "string") {
    return { success: false, error: "Invalid menu action." };
  }

  sendMenuAction(action);
  return { success: true };
});

ipcMain.handle("notifications:list", async () => {
  try {
    return { success: true, notifications: getToolchainNotifications() };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("notifications:upsert", async (_event, notification = {}) => {
  try {
    const result = upsertToolchainNotification(notification);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("notifications:clear", async () => {
  try {
    return { success: true, notifications: clearToolchainNotifications() };
  } catch (error) {
    return toErrorResult(error);
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

ipcMain.handle("agent:route", async (_event, payload = {}) => {
  try {
    const route = await agentRuntimeManager.route(payload);
    return { success: true, ...route };
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

ipcMain.handle("agent:stop", async (_event, payload = {}) => {
  try {
    const result = agentRuntimeManager.stop(payload);
    return { success: true, ...result };
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

ipcMain.handle("agent:restore-points:list", async (_event, payload = {}) => {
  try {
    const restorePoints = await agentRestorePointStore.list(payload);
    return { success: true, restorePoints };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("agent:restore-points:record", async (_event, payload = {}) => {
  try {
    const result = await agentRestorePointStore.record(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("agent:restore-points:update-review-status", async (_event, payload = {}) => {
  try {
    const result = await agentRestorePointStore.updateReviewStatus(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("agent:restore-points:restore-to-message", async (_event, payload = {}) => {
  try {
    const result = await agentRestorePointStore.restoreToMessage(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("agent:tools:list-settings", async () => {
  try {
    return {
      success: true,
      ...agentToolRegistry.settingsResponse(getAgentToolSettings()),
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("agent:tools:update-settings", async (_event, payload = {}) => {
  try {
    return {
      success: true,
      ...updateAgentToolSettings(payload),
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:auth:get-current-user", async () => {
  try {
    const user = await appwriteRequest({ pathName: "account" });
    if (user) {
      prewarmCurrentAppwriteJwt();
    }
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

    clearAppwriteReadCache();
    prewarmCurrentAppwriteJwt();
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

    clearAppwriteReadCache();
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
  clearAppwriteReadCache();
  return { success: true };
});

ipcMain.handle("cloud:databases:list-documents", async (_event, payload) => {
  try {
    const response = await cachedAppwriteRequest(
      {
        pathName: `databases/${encodeURIComponent(payload.databaseId)}/collections/${encodeURIComponent(payload.collectionId)}/documents`,
        queries: payload.queries,
      },
      {
        ttlMs: payload.cacheTtlMs ?? defaultDatabaseListCacheTtlMs(payload.collectionId),
        cacheKey: payload.cacheKey,
        bypassCache: Boolean(payload.bypassCache),
      },
    );

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

    clearAppwriteReadCache();
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

    clearAppwriteReadCache();
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

    clearAppwriteReadCache();
    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:storage:create-file", async (event, payload) => {
  try {
    const fileBuffer = Buffer.from(payload.base64, "base64");
    const multipart = buildMultipartBody({
      fields: [
        ["fileId", payload.fileId],
        ...(Array.isArray(payload.permissions) ? payload.permissions.map((permission) => ["permissions[]", permission]) : []),
      ],
      files: [
        {
          name: "file",
          filename: payload.filename,
          contentType: payload.contentType || "application/octet-stream",
          buffer: fileBuffer,
        },
      ],
    });
    const progressId = typeof payload.progressId === "string" && payload.progressId.trim() ? payload.progressId.trim() : "";
    const sendUploadProgress = progressId
      ? (progress) => {
          event.sender.send("cloud:storage-upload-progress", {
            progressId,
            bucketId: payload.bucketId,
            fileId: payload.fileId,
            filename: payload.filename,
            sentBytes: progress.sentBytes,
            totalBytes: progress.totalBytes,
            progress: progress.progress,
          });
        }
      : null;

    const file = sendUploadProgress
      ? await appwriteRawUploadRequest({
          method: "POST",
          pathName: `storage/buckets/${encodeURIComponent(payload.bucketId)}/files`,
          rawBody: multipart.body,
          headers: multipart.headers,
        }, sendUploadProgress)
      : await appwriteRequest({
          method: "POST",
          pathName: `storage/buckets/${encodeURIComponent(payload.bucketId)}/files`,
          rawBody: multipart.body,
          headers: multipart.headers,
        });

    clearAppwriteReadCache();
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

    clearAppwriteReadCache();
    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("cloud:functions:create-execution", async (_event, payload) => {
  try {
    const executionHeaders = {
      "content-type": "application/json",
      ...(payload.headers ?? {}),
    };
    const hasForwardedJwt = Object.keys(executionHeaders).some((key) => key.toLowerCase() === "x-appwrite-jwt");
    if (!hasForwardedJwt) {
      try {
        const jwt = await getCurrentAppwriteJwt();
        if (jwt) {
          executionHeaders["X-Appwrite-JWT"] = jwt;
        }
      } catch {
        // Appwrite will still enforce the function execute permissions if no session JWT is available.
      }
    }

    const request = {
      method: "POST",
      pathName: `functions/${encodeURIComponent(payload.functionId)}/executions`,
      body: {
        body: payload.body,
        async: Boolean(payload.async),
        path: payload.pathName ?? "/",
        method: payload.method ?? "POST",
        headers: executionHeaders,
      },
    };
    const cacheTtlMs = functionExecutionCacheTtlMs(payload);
    const requestExecutor = payload.waitForCompletion
      ? (nextRequest) => createFunctionExecutionAndWait(payload.functionId, nextRequest.body, {
          timeoutMs: boundedPositiveNumber(payload.waitTimeoutMs, 95000, 5000, 125000),
          pollMs: boundedPositiveNumber(payload.pollMs, 1000, 250, 5000),
          invalidateCache: nextRequest.invalidateCache !== false,
        })
      : appwriteRequest;
    const functionRequestExecutor = async (nextRequest) => {
      const execution = await requestExecutor(nextRequest);
      const normalized = normalizeFunctionExecutionShape(execution);
      if (!payload.retryOnSyncTimeout || !functionExecutionIsSynchronousTimeout(normalized)) {
        return execution;
      }

      await delay(750);
      return requestExecutor(nextRequest);
    };

    if (payload.retryOnSyncTimeout && isPassiveAgentSettingsRead(payload)) {
      await warmAgentSettingsFunctionIfStale("read-preflight");
    }

    const execution = cacheTtlMs > 0
      ? await cachedAppwriteRequest(request, {
          ttlMs: cacheTtlMs,
          cacheKey: `function:${payload.functionId}:${payload.pathName ?? "/"}:${payload.body ?? ""}`,
          bypassCache: Boolean(payload.bypassCache),
          requestExecutor: functionRequestExecutor,
          shouldCachePayload: (payload) => !functionExecutionIsUncacheable(normalizeFunctionExecutionShape(payload)),
        })
      : await functionRequestExecutor(request);
    const normalizedExecution = normalizeFunctionExecutionShape(execution);

    if (cacheTtlMs <= 0) {
      clearAppwriteReadCache();
    } else if (functionExecutionIsUncacheable(normalizedExecution)) {
      clearAppwriteReadCache();
    }

    return { success: true, execution: normalizedExecution };
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

ipcMain.handle("file-tree:show-context-menu", async (event, payload = {}) => {
  try {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) {
      throw new Error("Unable to find the active window for the file tree menu.");
    }

    const x = normalizeContextMenuCoordinate(payload?.position?.x);
    const y = normalizeContextMenuCoordinate(payload?.position?.y);
    const groups = normalizeFileTreeContextMenuGroups(payload?.groups);
    if (groups.length === 0) {
      return { success: true, actionKey: null, actionId: null };
    }

    return await new Promise((resolve) => {
      let resolved = false;
      const finish = (selection) => {
        if (resolved) {
          return;
        }

        resolved = true;
        resolve({
          success: true,
          actionKey: selection?.actionKey ?? null,
          actionId: selection?.actionId ?? null,
        });
      };

      const popupMenu = (includeAccelerators = true) => {
        const menu = Menu.buildFromTemplate(createFileTreeContextMenuTemplate(groups, finish, includeAccelerators));
        menu.popup({
          window: targetWindow,
          ...(x !== undefined && y !== undefined ? { x, y } : {}),
          callback: () => finish(null),
        });
      };

      try {
        popupMenu(true);
      } catch {
        try {
          popupMenu(false);
        } catch {
          finish(null);
        }
      }
    });
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

    const selectedPath = path.resolve(result.filePaths[0]);

    return { success: true, path: selectedPath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("fs:open-file", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: fileDialogFilters()
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const selectedPath = path.resolve(result.filePaths[0]);
    registerTrustedPath(path.dirname(selectedPath));
    addRecentFile(selectedPath);

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
      throw new Error("Project path must be a directory.");
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

ipcMain.handle("fs:get-recent-files", async () => {
  try {
    return { success: true, paths: getRecentFiles() };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("projects:list", async () => {
  try {
    return { success: true, projects: getProjectFolders() };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("projects:add", async (_event, projectPath) => {
  try {
    const { project, alreadyExists } = addProjectFolder(projectPath);
    return { success: true, project, alreadyExists };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("projects:pick-folder", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const selectedPath = path.resolve(result.filePaths[0]);
    registerTrustedPath(selectedPath);
    return { success: true, path: selectedPath };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("projects:remove", async (_event, projectId) => {
  try {
    const projects = getProjectFolders();
    const nextProjects = projects.filter((project) => project.id !== projectId);

    if (nextProjects.length === projects.length) {
      throw new Error("Project folder was not found.");
    }

    return { success: true, projects: saveProjectFolders(nextProjects) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("projects:update", async (_event, projectId, patch = {}) => {
  try {
    const projects = getProjectFolders();
    const project = projects.find((entry) => entry.id === projectId);

    if (!project) {
      throw new Error("Project folder was not found.");
    }

    let nextProject = { ...project };

    if (typeof patch.path === "string" && patch.path.trim().length > 0) {
      const absolutePath = path.resolve(patch.path);
      const stats = await fsPromises.stat(absolutePath);

      if (!stats.isDirectory()) {
        throw new Error("Project path must be a directory.");
      }

      const duplicateProject = projects.find((entry) => entry.id !== projectId && entry.path.toLowerCase() === absolutePath.toLowerCase());
      if (duplicateProject) {
        throw new Error("That folder is already in My Projects.");
      }

      registerTrustedPath(absolutePath);
      nextProject = {
        ...nextProject,
        path: absolutePath,
        name: path.basename(absolutePath) || absolutePath,
      };
    }

    if ("displayName" in patch) {
      nextProject.displayName = typeof patch.displayName === "string" && patch.displayName.trim().length > 0 ? patch.displayName.trim() : undefined;
    }

    if (typeof patch.favorite === "boolean") {
      nextProject.favorite = patch.favorite;
    }

    if (typeof patch.lastOpenedAt === "string") {
      nextProject.lastOpenedAt = patch.lastOpenedAt;
    }

    const nextProjects = saveProjectFolders(projects.map((entry) => (entry.id === projectId ? nextProject : entry)));
    return { success: true, project: nextProjects.find((entry) => entry.id === projectId) ?? nextProject };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("projects:inspect", async (_event, projectId) => {
  try {
    const project = getProjectFolderById(projectId);

    if (!project) {
      throw new Error("Project folder was not found.");
    }

    return { success: true, project };
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
    const absolutePath = assertTrustedPath(payload.filePath, { allowMissing: true });
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
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

ipcMain.handle("workspace:search", async (_event, payload = {}) => {
  try {
    return await searchWorkspace(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("workspace:suggest-context-files", async (_event, payload = {}) => {
  try {
    return await suggestAgentContextFiles(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("workspace:read-context-file", async (_event, payload = {}) => {
  try {
    return await readAgentContextFile(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("workspace:pick-context-attachments", async (event) => {
  try {
    return await pickAgentContextAttachments(BrowserWindow.fromWebContents(event.sender) || mainWindow);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("workspace:preview-replace", async (_event, payload = {}) => {
  try {
    return await previewWorkspaceReplace(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("workspace:apply-replace", async (_event, payload = {}) => {
  try {
    return await applyWorkspaceReplace(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:get-status", async () => {
  try {
    const status = await getGitStatus();
    return { success: true, status };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:get-diff", async (_event, payload = {}) => {
  try {
    const diff = await getGitDiff(payload);
    return { success: true, diff };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:stage", async (_event, payload = {}) => {
  try {
    const paths = normalizeGitPathList(payload.paths ?? payload.path);
    const result = await runGit(["add", "--", ...paths]);
    markWorkspaceDirty();
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:unstage", async (_event, payload = {}) => {
  try {
    const paths = normalizeGitPathList(payload.paths ?? payload.path);
    const result = await runGit(["restore", "--staged", "--", ...paths]);
    markWorkspaceDirty();
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:discard", async (_event, payload = {}) => {
  try {
    const result = await discardGitPaths(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:commit", async (_event, payload = {}) => {
  try {
    const message = String(payload.message ?? "").trim();
    if (!message) {
      throw new Error("Write a commit message before committing.");
    }

    const result = await runGit(["commit", "-m", message], { timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS });
    markWorkspaceDirty();
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:fetch", async () => {
  try {
    const result = await runGit(["fetch", "--prune"], { timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS });
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:pull", async () => {
  try {
    const result = await runGit(["pull", "--ff-only"], { timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS });
    markWorkspaceDirty();
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:push", async () => {
  try {
    const result = await runGit(["push"], { timeoutMs: GIT_COMMAND_NETWORK_TIMEOUT_MS });
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:list-branches", async () => {
  try {
    const result = await listGitBranches();
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:checkout-branch", async (_event, payload = {}) => {
  try {
    const branch = String(payload.branch ?? "").trim();
    if (!branch) {
      throw new Error("Choose a branch to check out.");
    }

    const result = await runGit(["checkout", branch]);
    markWorkspaceDirty();
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:create-branch", async (_event, payload = {}) => {
  try {
    const branch = String(payload.branch ?? "").trim();
    if (!branch) {
      throw new Error("Use a valid Git branch name.");
    }

    await runGit(["check-ref-format", "--branch", branch]);
    const result = await runGit(["checkout", "-b", branch]);
    markWorkspaceDirty();
    return { success: true, output: formatGitCommandOutput(result) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:get-log", async (_event, payload = {}) => {
  try {
    const commits = await getGitLog(payload.limit);
    return { success: true, commits };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:get-remotes", async () => {
  try {
    const remotes = await getGitRemotes();
    return { success: true, remotes };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:repair-safe-directory", async () => {
  try {
    const workspaceRoot = getGitWorkspaceRoot();
    const result = await runGit(["config", "--global", "--add", "safe.directory", workspaceRoot], {
      cwd: app.getPath("home") || getDefaultTerminalCwd()
    });
    return { success: true, output: formatGitCommandOutput(result) || "Repository trusted for Git." };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:init-repository", async (_event, payload = {}) => {
  try {
    const result = await initializeGitRepository(payload.defaultBranch);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:publish-repository", async (_event, payload = {}) => {
  try {
    const result = await publishGitRepository(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:get-configuration", async () => {
  try {
    const config = await getGitConfiguration();
    return { success: true, config };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("git:set-configuration", async (_event, payload = {}) => {
  try {
    const config = await setGitConfiguration(payload);
    return { success: true, config };
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
      commandSecret: payload.commandSecret ?? "",
      mqttTopic: payload.mqttTopic ?? "",
      provisioningPop: payload.provisioningPop ?? "",
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
    if (boardSecrets && Object.prototype.hasOwnProperty.call(boardSecrets, "wifiPassword")) {
      const { wifiPassword, ...sanitizedSecrets } = boardSecrets;
      secretStore?.set(`boards.${boardId}`, sanitizedSecrets);
      return { success: true, secrets: sanitizedSecrets };
    }
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
    const compileId = typeof payload?.compileId === "string" && payload.compileId.trim() ? payload.compileId.trim() : "";
    const emitCompileProgress = compileId
      ? (progressEvent, stream = "stdout") => {
          const rawChunk = typeof progressEvent === "string" ? progressEvent : progressEvent?.message || progressEvent?.phase || "";
          _event.sender.send("toolchain:compile-progress", {
            compileId,
            stream,
            chunk: rawChunk,
            message: String(rawChunk || "").trim(),
            progress: typeof progressEvent?.progress === "number" ? progressEvent.progress : extractLastCliProgressPercent(rawChunk),
          });
        }
      : undefined;

    const sketchSource = normalizeToolchainSketchSourcePayload(payload?.sketchSource);
    return await compileArduino(payload?.code ?? DEFAULT_EDITOR_CONTENT, payload?.board ?? "arduino:avr:uno", {
      cloudRuntime: payload?.cloudRuntime || null,
      sourceRestoreMarker: payload?.sourceRestoreMarker || null,
      sketchSource,
      onProgress: emitCompileProgress,
    });
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:detect-local-boards", async (_event, payload = {}) => {
  try {
    return await detectLocalBoards(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:list-local-board-profiles", async () => {
  try {
    return { success: true, profiles: getLocalBoardProfiles() };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:save-local-board-profile", async (_event, payload = {}) => {
  try {
    return { success: true, profile: saveLocalBoardProfile(payload) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:delete-local-board-profile", async (_event, profileId) => {
  try {
    return { success: true, profiles: deleteLocalBoardProfile(profileId) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:replace-local-board-profiles", async (_event, profiles = []) => {
  try {
    return { success: true, profiles: replaceLocalBoardProfiles(profiles) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:create-source-snapshot", async (_event, payload = {}) => {
  try {
    const snapshot = await createAndUploadSourceSnapshot(payload);
    clearAppwriteReadCache();
    return { success: true, ...snapshot };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:prepare-source-restore-marker", async (_event, payload = {}) => {
  try {
    const marker = await createPendingSourceRestoreMarker(payload);
    clearAppwriteReadCache();
    return { success: true, ...marker };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:promote-source-restore-marker", async (_event, payload = {}) => {
  try {
    const result = await promoteSourceRestoreMarker(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:discard-source-restore-marker", async (_event, payload = {}) => {
  try {
    const result = await discardSourceRestoreMarker(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:list-board-code-snapshots", async (event, payload = {}) => {
  try {
    const result = await listBoardCodeSnapshots(payload, event.sender);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:restore-board-code-snapshot", async (event, payload = {}) => {
  try {
    const result = await restoreBoardCodeSnapshot(payload, event.sender);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:set-board-code-visibility", async (_event, payload = {}) => {
  try {
    const result = await setBoardCodeVisibility(payload);
    return { success: true, ...result };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:view-board-code", async (event, payload = {}) => {
  try {
    const result = await viewBoardCode(payload, event.sender);
    return { success: true, ...result };
  } catch (error) {
    const requestId = String(payload.requestId || "");
    if (requestId) {
      upsertToolchainNotification({
        id: requestId,
        kind: "code-extraction",
        title: "Board code view failed",
        detail: error instanceof Error ? error.message : "Unable to view board code.",
        status: "error",
        phase: "error",
        progress: null,
        name: payload.board?.name || "",
        target: payload.board?.port || payload.board?.fqbn || "",
        metadata: {
          boardId: payload.board?.id || payload.board?.cloudBoardId,
          boardType: payload.board?.fqbn,
          port: payload.board?.port,
        },
      });
    }
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:upload-local-sketch", async (_event, payload = {}) => {
  const port = String(payload.port || "").trim();
  const portKey = port.toLowerCase();
  const uploadId = String(payload.uploadId || `usb-upload:${portKey || Date.now()}`);
  if (portKey && activeLocalUploadPorts.has(portKey)) {
    return {
      success: false,
      error: `A USB upload is already running on ${port}. Wait for it to finish before starting another upload.`
    };
  }
  if (portKey && activeSerialMonitorPorts.has(portKey)) {
    return {
      success: false,
      error: `Serial Monitor is open on ${port}. Disconnect it before uploading.`
    };
  }

  if (portKey) {
    activeLocalUploadPorts.add(portKey);
  }

  try {
    const sketchSource = normalizeToolchainSketchSourcePayload(payload?.sketchSource);
    const result = await uploadLocalSketch(payload.code ?? DEFAULT_EDITOR_CONTENT, payload.board, port || payload.port, (chunk, stream) => {
      const rawChunk = textFromToolchainProgressPayload(chunk);
      _event.sender.send("toolchain:usb-upload-progress", {
        uploadId,
        port,
        board: payload.board,
        stream,
        chunk: rawChunk,
        message: formatUsbUploadProgressMessage(rawChunk),
        progress: typeof chunk?.progress === "number" ? chunk.progress : extractLastCliProgressPercent(rawChunk)
      });
    }, {
      cloudRuntime: payload?.cloudRuntime || null,
      sourceRestoreMarker: payload?.sourceRestoreMarker || null,
      sketchSource,
    });
    if (result?.success && payload.sourceSnapshot) {
      try {
        await boardCodeService.saveLocalSourceHistory(preferenceStore, app.getPath("userData"), {
          ...(payload.sourceIdentity || {}),
          fqbn: payload.sourceIdentity?.fqbn || payload.board,
          port: payload.sourceIdentity?.port || port || payload.port,
        }, payload.sourceSnapshot);
      } catch (error) {
        console.warn("Unable to save local source history:", error instanceof Error ? error.message : error);
      }
    }
    if (result?.success && payload.sourceRestoreMarker?.markerId) {
      try {
        await promoteSourceRestoreMarker({ sourceRestoreMarker: payload.sourceRestoreMarker });
      } catch (error) {
        console.warn("Unable to promote source restore marker:", error instanceof Error ? error.message : error);
      }
    }
    return result;
  } catch (error) {
    if (payload.sourceRestoreMarker?.markerId) {
      try {
        await discardSourceRestoreMarker({ sourceRestoreMarker: payload.sourceRestoreMarker });
      } catch (discardError) {
        console.warn("Unable to discard source restore marker:", discardError instanceof Error ? discardError.message : discardError);
      }
    }
    return toErrorResult(error);
  } finally {
    if (portKey) {
      activeLocalUploadPorts.delete(portKey);
    }
  }
});

ipcMain.handle("toolchain:install-board-package", async (event, payload = {}) => {
  const installId = payload.installId || crypto.randomUUID();
  const controller = new AbortController();
  activeBoardPackageInstalls.set(installId, controller);

  try {
    const result = await installBoardPackage(payload.packageUrl, payload.packageName, (chunk) => {
      event.sender.send("toolchain:install-progress", chunk);
    }, {
      signal: controller.signal
    });

    return { ...result, installId };
  } catch (error) {
    return { ...toErrorResult(error), installId };
  } finally {
    activeBoardPackageInstalls.delete(installId);
  }
});

ipcMain.handle("toolchain:cancel-board-package-install", async (_event, payload = {}) => {
  const installId = payload.installId;
  if (!installId) {
    return { success: false, error: "installId is required." };
  }

  const controller = activeBoardPackageInstalls.get(installId);
  if (!controller) {
    return { success: true, alreadyStopped: true };
  }

  controller.abort();
  return { success: true };
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

ipcMain.handle("toolchain:get-arduino-storage", async () => {
  try {
    return getArduinoStorageConfigurationResult();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:select-arduino-storage", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select Arduino storage folder",
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const storageRoot = path.resolve(result.filePaths[0]);
    fs.mkdirSync(storageRoot, { recursive: true });
    preferenceStore?.set(ARDUINO_STORAGE_ROOT_KEY, storageRoot);
    configureArduinoStorageRoot(storageRoot);
    registerTrustedPath(storageRoot);
    return getArduinoStorageConfigurationResult();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:clear-arduino-storage", async () => {
  try {
    preferenceStore?.delete(ARDUINO_STORAGE_ROOT_KEY);
    configureArduinoStorageRoot(null);
    return getArduinoStorageConfigurationResult();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:get-library-directory", async () => {
  try {
    const result = await getArduinoLibraryDirectory();
    registerTrustedPath(result.userDir);
    registerTrustedPath(result.librariesDir);
    return result;
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:select-library-source-folder", async (_event, payload = {}) => {
  try {
    const defaultPath = typeof payload.defaultPath === "string" && fs.existsSync(payload.defaultPath)
      ? path.resolve(payload.defaultPath)
      : undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select Arduino IDE sketchbook or libraries folder",
      defaultPath,
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, path: path.resolve(result.filePaths[0]) };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:migrate-libraries", async (event, payload = {}) => {
  try {
    const result = await migrateLibrariesFrom(payload.sourcePath, (progressEvent) => {
      event.sender.send("toolchain:library-migration-progress", progressEvent);
    });
    registerTrustedPath(result.userDir);
    registerTrustedPath(result.targetLibrariesDir);
    return result;
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:install-library", async (event, payload = {}) => {
  const installId = payload.installId || crypto.randomUUID();
  const name = payload.name;
  const version = payload.version;
  const controller = new AbortController();
  const emitLibraryProgress = (status, patch = {}) => {
    event.sender.send("toolchain:library-install-progress", {
      installId,
      name,
      version,
      status,
      phase: patch.phase || status,
      message: patch.message || "",
      progress: typeof patch.progress === "number" ? patch.progress : null
    });
  };

  activeLibraryInstallOperations.set(installId, {
    controller,
    sender: event.sender,
    name,
    version
  });

  try {
    emitLibraryProgress("queued", {
      phase: "prepare",
      message: `Preparing ${name} install...`
    });

    const result = await installLibrary(name, version, (progressEvent) => {
      if (typeof progressEvent === "string") {
        event.sender.send("toolchain:install-progress", progressEvent);
        emitLibraryProgress("running", {
          phase: classifyLibraryInstallPhase(progressEvent),
          message: formatLibraryInstallMessage(progressEvent),
          progress: extractCliProgressPercent(progressEvent)
        });
        return;
      }

      const message = progressEvent?.message || "";
      if (message) {
        event.sender.send("toolchain:install-progress", `${message}\n`);
      }
      emitLibraryProgress("running", {
        phase: progressEvent?.phase || "running",
        message,
        progress: typeof progressEvent?.progress === "number" ? progressEvent.progress : null
      });
    }, {
      signal: controller.signal
    });

    emitLibraryProgress("success", {
      phase: "Installed",
      message: result.installedVersion ? `${name}@${result.installedVersion} installed.` : `${name} installed.`,
      progress: 100
    });

    return { ...result, installId };
  } catch (error) {
    const errorResult = toErrorResult(error);
    if (errorResult.canceled) {
      emitLibraryProgress("canceled", {
        phase: "canceled",
        message: `${name} install stopped.`
      });
    } else {
      emitLibraryProgress("error", {
        phase: "error",
        message: errorResult.error
      });
    }
    return { ...errorResult, installId };
  } finally {
    activeLibraryInstallOperations.delete(installId);
  }
});

ipcMain.handle("toolchain:cancel-library-install", async (_event, payload = {}) => {
  const installId = payload.installId;
  if (!installId) {
    return { success: false, error: "installId is required." };
  }

  const operation = activeLibraryInstallOperations.get(installId);
  if (!operation) {
    return { success: true, alreadyStopped: true };
  }

  operation.controller.abort();
  operation.sender.send("toolchain:library-install-progress", {
    installId,
    name: operation.name,
    version: operation.version,
    status: "running",
    phase: "stopping",
    message: `Stopping ${operation.name} install...`,
    progress: null
  });

  return { success: true };
});

ipcMain.handle("toolchain:list-installed-libraries", async () => {
  try {
    return await listInstalledLibraries();
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:remove-library", async (_event, payload = {}) => {
  try {
    return await removeLibrary(payload.name);
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
    const port = String(payload?.port || "").trim();
    const uploadId = String(payload?.uploadId || `cloud-runtime-install:${board?.$id || Date.now()}`);

    if (!board?.$id || !board?.boardType) {
      throw new Error("A valid board payload is required for provisioning.");
    }

    if (!secrets?.apiToken || !secrets?.commandSecret || !secrets?.mqttTopic || !secrets?.provisioningPop) {
      throw new Error("Local board secrets are missing. Rotate the board token, then provision again.");
    }

    if (!appwriteConfig?.endpoint || !appwriteConfig?.projectId || !appwriteConfig?.deviceGatewayFunctionId) {
      throw new Error("Appwrite function configuration is incomplete.");
    }

    return await provisioningService.provisionBoard(
      {
        ...board,
        apiToken: secrets.apiToken,
        commandSecret: secrets.commandSecret,
        mqttTopic: secrets.mqttTopic,
        provisioningPop: secrets.provisioningPop
      },
      port,
      appwriteConfig,
      (chunk, stream) => {
        const rawChunk = textFromToolchainProgressPayload(chunk);
        _event.sender.send("toolchain:usb-upload-progress", {
          uploadId,
          port,
          board: board.boardType,
          stream: stream || "stdout",
          chunk: rawChunk,
          message: formatUsbUploadProgressMessage(rawChunk),
          progress: typeof chunk?.progress === "number" ? chunk.progress : extractLastCliProgressPercent(rawChunk)
        });
      }
    );
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("toolchain:provision-board-wifi-usb", async (_event, payload = {}) => {
  try {
    const boardId = String(payload.boardId || "").trim();
    const secrets = secretStore?.get(`boards.${boardId}`) ?? null;

    if (!boardId) {
      throw new Error("A cloud board ID is required.");
    }

    if (!secrets?.commandSecret) {
      throw new Error("Local command secret is missing. Rotate the board token, then flash the cloud runtime again.");
    }

    return await provisioningService.provisionBoardWifiUsb({
      boardId,
      commandSecret: secrets.commandSecret,
      port: payload.port,
      ssid: payload.ssid,
      password: payload.password,
    });
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

ipcMain.handle("serial-monitor:open", async (_event, options = {}) => {
  try {
    let SerialPort;
    try {
      ({ SerialPort } = require("serialport"));
    } catch (error) {
      throw new Error(`Serial port support is unavailable: ${error.message}`);
    }

    const port = normalizeSerialMonitorPort(options.port);
    const baudRate = normalizeSerialMonitorBaudRate(options.baudRate || 115200);
    const portKey = serialMonitorPortKey(port);

    if (activeLocalUploadPorts.has(portKey)) {
      throw new Error(`A USB upload is already running on ${port}. Wait for it to finish before opening Serial Monitor.`);
    }
    if (activeSerialMonitorPorts.has(portKey)) {
      throw new Error(`Serial Monitor is already open on ${port}.`);
    }

    const sessionId = createSerialMonitorSessionId();
    const serialPort = new SerialPort({ path: port, baudRate, autoOpen: false });
    const session = {
      serialPort,
      port,
      baudRate,
      portKey,
      closing: false,
      closeReason: "closed",
      notifyOnClose: true,
    };

    serialPort.on("data", (chunk) => {
      sendRendererEvent("serial-monitor:data", { sessionId, data: chunk.toString("utf8") });
    });

    serialPort.on("error", (error) => {
      sendRendererEvent("serial-monitor:error", { sessionId, error: error.message });
    });

    serialPort.on("close", () => {
      finalizeSerialMonitorSession(sessionId, session.closing ? session.closeReason : "disconnected", session.notifyOnClose !== false);
    });

    await new Promise((resolve, reject) => {
      serialPort.open((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    serialMonitorSessions.set(sessionId, session);
    activeSerialMonitorPorts.set(portKey, sessionId);

    return { success: true, sessionId, port, baudRate };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("serial-monitor:close", async (_event, sessionId) => {
  try {
    if (typeof sessionId === "string" && sessionId.length > 0) {
      disposeSerialMonitorSession(sessionId);
    }

    return { success: true };
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("serial-port:list-blockers", async (_event, payload = {}) => {
  try {
    return await listSerialPortBlockers(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.handle("serial-port:terminate-blocker", async (_event, payload = {}) => {
  try {
    return await terminateSerialPortBlocker(payload);
  } catch (error) {
    return toErrorResult(error);
  }
});

ipcMain.on("serial-monitor:write", (_event, payload) => {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const session = serialMonitorSessions.get(sessionId);
  if (!session || !session.serialPort.isOpen) {
    return;
  }

  const data = String(payload?.data ?? "");
  if (!data) {
    return;
  }

  session.serialPort.write(data, (error) => {
    if (error) {
      sendRendererEvent("serial-monitor:error", { sessionId, error: error.message });
      return;
    }

    session.serialPort.drain((drainError) => {
      if (drainError) {
        sendRendererEvent("serial-monitor:error", { sessionId, error: drainError.message });
      }
    });
  });
});

app.whenReady().then(async () => {
  await initializeStores();
  createMainWindow();
  startAgentSettingsWarmLoop();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      return;
    }

    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on("before-quit", () => {
  disposeAllTerminalSessions();
  disposeAllSerialMonitorSessions();
  if (agentSettingsWarmTimer) {
    clearInterval(agentSettingsWarmTimer);
    agentSettingsWarmTimer = null;
  }

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

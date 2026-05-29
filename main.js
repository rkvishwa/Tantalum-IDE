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
const { AgentToolRegistry } = require("./src/agent/toolRegistry");
const { AgentToolExecutor } = require("./src/agent/toolExecutor");
const { deriveFunctionId, getRendererCloudConfig } = require("./src/config/runtimeCloudConfig");
const { WorkspaceScanner } = require("./src/agent/workspaceScanner");
const { detectLocalBoardsDeterministic } = require("./src/services/localBoardService");
const provisioningService = require("./src/services/provisioningService");
const appwriteManifest = require("./appwrite.config.json");

const APP_NAME = "Tantalum IDE";
const APPWRITE_ENDPOINT = String(appwriteManifest.endpoint || "").replace(/\/$/, "");
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
const LOCAL_BOARD_PROFILES_KEY = "localBoardProfiles";
const ARDUINO_STORAGE_ROOT_KEY = "arduinoStorageRoot";
const AGENT_TOOL_SETTINGS_KEY = "agentToolSettings";
const BOARD_DETECTION_FUNCTION_ID = deriveFunctionId(appwriteManifest, "board-detection");
const TOOLCHAIN_NOTIFICATIONS_KEY = "toolchainNotifications";
const TOOLCHAIN_NOTIFICATIONS_LIMIT = 100;

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
    return { success: false, error: "The selected workspace no longer exists." };
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
  const usedExistingIds = new Set();

  for (const profile of profiles) {
    const normalized = normalizeLocalBoardProfile(profile);
    if (!normalized?.port) {
      continue;
    }

    const existingProfile = findLocalBoardProfileMatch(normalized, existingProfiles, usedExistingIds, true);
    const nextProfile = existingProfile
      ? preserveLocalBoardCloudLink({
          ...existingProfile,
          ...normalized,
          id: existingProfile.id,
          name: normalized.name || existingProfile.name,
          createdAt: existingProfile.createdAt,
          updatedAt: new Date().toISOString(),
        }, existingProfile, profile)
      : normalized;

    if (!seen.has(nextProfile.id)) {
      seen.add(nextProfile.id);
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
    throw createGitError("Open a workspace folder before using Git.", "NO_WORKSPACE");
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
    return createGitError("The active workspace is not a Git repository.", "NOT_REPOSITORY", {
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
      throw new Error("Git file paths must be relative to the active workspace.");
    }

    const absolutePath = path.resolve(rootPath, candidate);
    if (!isPathInsideRoot(absolutePath, rootPath)) {
      throw new Error("Blocked Git access to a path outside the active workspace.");
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
    return createGitStatusState("no-workspace", "Open a workspace folder to use Git.");
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
      return createGitStatusState("not-repository", "The active workspace is not a Git repository.");
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
        throw new Error("Blocked Git discard outside the active workspace.");
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
    parts.some((part) => part === ".git" || part === "node_modules" || part === "dist" || part === "build") ||
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
    throw new Error("Blocked access to a path outside the active workspace.");
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
    throw new Error("Open a workspace folder before searching.");
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
    { name: "Arduino Sketches", extensions: ["ino", "cpp", "c", "h", "hpp"] },
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
const appwriteReadCache = new Map();
const appwriteInflightReadCache = new Map();
let appwriteReadCacheEpoch = 0;
let appwriteJwtCache = { sessionKey: "", jwt: "", expiresAt: 0 };

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

async function cachedAppwriteRequest(request, { ttlMs = 0, cacheKey = "", bypassCache = false } = {}) {
  const safeTtlMs = Number(ttlMs || 0);
  if (bypassCache || !Number.isFinite(safeTtlMs) || safeTtlMs <= 0) {
    return appwriteRequest(request);
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
  const promise = appwriteRequest({ ...request, invalidateCache: false })
    .then((payload) => {
      if (cacheEpoch === appwriteReadCacheEpoch) {
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
  if (payload?.async) {
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

    const parsed = safeJsonParse(execution.responseBody || '{"ok":false,"error":"Function returned an empty response."}', {
      ok: false,
      error: "Function returned an unreadable response.",
    });
    if (Number(execution.responseStatusCode || 0) >= 400 || !parsed?.ok || !parsed?.data) {
      throw new Error(parsed?.error || execution.responseBody || execution.errors || "Function execution failed.");
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
      path: "/gateway",
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
  const execution = await appwriteRequest({
    method: "POST",
    pathName: `functions/${encodeURIComponent(BOARD_DETECTION_FUNCTION_ID)}/executions`,
    body: {
      body: JSON.stringify({ candidate }),
      async: false,
      path: "/",
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  });
  const parsed = safeJsonParse(execution.responseBody || "{}", { ok: false, error: "Board detection AI returned an unreadable response." });

  if (execution.responseStatusCode >= 400 || !parsed.ok) {
    throw new Error(parsed.error || execution.responseBody || execution.errors || "Board detection AI failed.");
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
        { label: "Open Folder...", accelerator: "CmdOrCtrl+Shift+O", click: () => sendMenuAction({ type: "open-folder" }) },
        {
          label: "Open Recent",
          submenu: [
            { label: "Folders", submenu: recentWorkspacesSubmenu },
            { label: "Files", submenu: recentFilesSubmenu }
          ]
        },
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
      label: "Sketch",
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
    const execution = cacheTtlMs > 0
      ? await cachedAppwriteRequest(request, {
          ttlMs: cacheTtlMs,
          cacheKey: `function:${payload.functionId}:${payload.pathName ?? "/"}:${payload.body ?? ""}`,
          bypassCache: Boolean(payload.bypassCache),
        })
      : await appwriteRequest(request);

    if (cacheTtlMs <= 0) {
      clearAppwriteReadCache();
    }

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
      properties: ["openDirectory"]
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

    return await compileArduino(payload?.code ?? DEFAULT_EDITOR_CONTENT, payload?.board ?? "arduino:avr:uno", {
      cloudRuntime: payload?.cloudRuntime || null,
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
    return await uploadLocalSketch(payload.code ?? DEFAULT_EDITOR_CONTENT, payload.board, port || payload.port, (chunk, stream) => {
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
      cloudRuntime: payload?.cloudRuntime || null
    });
  } catch (error) {
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

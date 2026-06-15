const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeRelativePath,
  parseTantalumIgnore,
  shouldExcludePath,
} = require("./cloudSyncIgnore");

const CLOUD_SYNC_PREFERENCES_KEY = "cloudSyncProjects";
const SHADOW_MANIFEST_PATH = ".tantalum-sync/manifest.json";
const DEFAULT_BRANCH = "main";
const DEVICE_IDENTITY_PATH = "identity/device.json";

function safeProjectId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `local_${crypto.randomBytes(12).toString("hex")}`;
}

function projectIdForWorkspace(workspacePath) {
  return `local_${crypto.createHash("sha256").update(path.resolve(workspacePath)).digest("hex").slice(0, 24)}`;
}

function isPathInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function bufferFromStream(stream) {
  return new Promise((resolve) => {
    let output = "";
    stream?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    stream?.on("end", () => resolve(output));
  });
}

function runProcess(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });

    const stdoutPromise = bufferFromStream(child.stdout);
    const stderrPromise = bufferFromStream(child.stderr);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill();
      } catch {}
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error?.code === "ENOENT" ? new Error(`${command} is not installed or is not available on PATH.`) : error);
    });

    child.on("close", async (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      const result = { stdout, stderr, code: code ?? 0 };
      if (!options.allowFailure && result.code !== 0) {
        const message = [stderr, stdout].filter(Boolean).join("\n").trim() || `${command} ${args.join(" ")} failed with exit code ${result.code}.`;
        reject(new Error(message));
        return;
      }
      resolve(result);
    });
  });
}

function runGit(cwd, args, options = {}) {
  return runProcess("git", args, {
    ...options,
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env || {}),
    },
  });
}

async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(targetPath, fallback = null) {
  try {
    return JSON.parse(await fsPromises.readFile(targetPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function hashFile(targetPath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(targetPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function quoteSshCommandPath(value) {
  return `"${String(value || "").replace(/\\/g, "/").replace(/"/g, "\\\"")}"`;
}

function normalizeRemoteGitPayload(payload = {}) {
  const project = payload.project && typeof payload.project === "object" ? payload.project : {};
  const git = payload.git && typeof payload.git === "object" ? payload.git : {};
  return {
    cloudProjectId: project.$id || project.id || "",
    cloudProjectName: project.name || "",
    repoOwner: project.repoOwner || git.owner || "",
    repoName: project.repoName || git.repo || "",
    remoteUrl: project.sshCloneUrl || git.sshCloneUrl || "",
    branch: project.defaultBranch || git.branch || DEFAULT_BRANCH,
    webUrl: git.webUrl || "",
    sshHost: git.sshHost || "",
    sshPort: git.sshPort || "",
  };
}

async function readTantalumIgnore(workspacePath) {
  const ignorePath = path.join(workspacePath, ".tantalumignore");
  try {
    return parseTantalumIgnore(await fsPromises.readFile(ignorePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function createEmptyStats() {
  return {
    includedFiles: 0,
    excludedFiles: 0,
    excludedDirectories: 0,
    emptyDirectories: 0,
    bytes: 0,
  };
}

function addExcludedSample(samples, relativePath, decision, isDirectory) {
  if (samples.length >= 100) {
    return;
  }
  samples.push({
    path: normalizeRelativePath(relativePath),
    isDirectory: Boolean(isDirectory),
    rule: decision.rule || "",
    category: decision.category || "",
    core: Boolean(decision.core),
  });
}

async function walkWorkspace(workspacePath, userRules, options = {}) {
  const stats = createEmptyStats();
  const files = [];
  const emptyDirectories = [];
  const excluded = [];
  const root = path.resolve(workspacePath);

  async function walkDirectory(directoryPath) {
    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    let includedChildren = 0;

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      const isDirectory = entry.isDirectory();
      const decision = shouldExcludePath(relativePath, { isDirectory, userRules });

      if (decision.excluded) {
        if (isDirectory) {
          stats.excludedDirectories += 1;
        } else {
          stats.excludedFiles += 1;
        }
        addExcludedSample(excluded, relativePath, decision, isDirectory);
        continue;
      }

      if (entry.isSymbolicLink()) {
        stats.excludedFiles += 1;
        addExcludedSample(excluded, relativePath, { rule: "symlink", category: "safety" }, false);
        continue;
      }

      if (isDirectory) {
        const child = await walkDirectory(absolutePath);
        if (child.physicalEmpty) {
          emptyDirectories.push(relativePath);
          stats.emptyDirectories += 1;
        }
        includedChildren += child.includedChildren;
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileStats = await fsPromises.stat(absolutePath);
      const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : 50 * 1024 * 1024;
      if (fileStats.size > maxFileBytes) {
        stats.excludedFiles += 1;
        addExcludedSample(excluded, relativePath, { rule: `>${maxFileBytes}`, category: "large-file" }, false);
        continue;
      }

      files.push({
        relativePath,
        absolutePath,
        size: fileStats.size,
        mtimeMs: Math.trunc(fileStats.mtimeMs),
      });
      stats.includedFiles += 1;
      stats.bytes += fileStats.size;
      includedChildren += 1;
    }

    return { includedChildren, physicalEmpty: entries.length === 0 };
  }

  await walkDirectory(root);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  emptyDirectories.sort((left, right) => left.localeCompare(right));
  return { files, emptyDirectories, excluded, stats };
}

async function collectPhysicalEmptyDirectories(workspacePath, userRules, options = {}) {
  const emptyDirectories = [];
  const root = path.resolve(workspacePath);
  const isIgnored = typeof options.isIgnored === "function" ? options.isIgnored : async () => false;

  async function walkDirectory(directoryPath) {
    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    if (entries.length === 0) {
      return true;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      const decision = shouldExcludePath(relativePath, { isDirectory: true, userRules });
      if (decision.excluded || await isIgnored(relativePath)) {
        continue;
      }
      if (await walkDirectory(absolutePath)) {
        emptyDirectories.push(relativePath);
      }
    }

    return false;
  }

  await walkDirectory(root);
  return emptyDirectories.sort((left, right) => left.localeCompare(right));
}

async function gitIgnoresPath(workspacePath, relativePath) {
  const result = await runGit(workspacePath, ["check-ignore", "-q", "--", relativePath], { allowFailure: true });
  return result.code === 0;
}

async function gitTrackedAndUntrackedFiles(workspacePath) {
  const result = await runGit(workspacePath, ["ls-files", "-co", "--exclude-standard", "-z"]);
  return result.stdout
    .split("\0")
    .map(normalizeRelativePath)
    .filter(Boolean);
}

async function scanGitWorkspace(workspacePath, userRules, options = {}) {
  const stats = createEmptyStats();
  const files = [];
  const excluded = [];
  const root = path.resolve(workspacePath);
  const candidates = await gitTrackedAndUntrackedFiles(root);

  for (const relativePath of candidates) {
    const decision = shouldExcludePath(relativePath, { isDirectory: false, userRules });
    if (decision.excluded) {
      stats.excludedFiles += 1;
      addExcludedSample(excluded, relativePath, decision, false);
      continue;
    }

    const absolutePath = path.join(root, relativePath);
    let fileStats;
    try {
      fileStats = await fsPromises.lstat(absolutePath);
    } catch {
      continue;
    }

    if (fileStats.isSymbolicLink()) {
      stats.excludedFiles += 1;
      addExcludedSample(excluded, relativePath, { rule: "symlink", category: "safety" }, false);
      continue;
    }
    if (!fileStats.isFile()) {
      continue;
    }

    const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : 50 * 1024 * 1024;
    if (fileStats.size > maxFileBytes) {
      stats.excludedFiles += 1;
      addExcludedSample(excluded, relativePath, { rule: `>${maxFileBytes}`, category: "large-file" }, false);
      continue;
    }

    files.push({
      relativePath,
      absolutePath,
      size: fileStats.size,
      mtimeMs: Math.trunc(fileStats.mtimeMs),
    });
    stats.includedFiles += 1;
    stats.bytes += fileStats.size;
  }

  const emptyDirectories = await collectPhysicalEmptyDirectories(root, userRules, {
    isIgnored: (relativePath) => gitIgnoresPath(root, relativePath),
  });
  stats.emptyDirectories = emptyDirectories.length;
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { files, emptyDirectories, excluded, stats };
}

async function removeDirectoryContents(rootPath) {
  const root = path.resolve(rootPath);
  if (!await pathExists(root)) {
    return;
  }

  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const targetPath = path.join(root, entry.name);
    if (!isPathInsideRoot(targetPath, root)) {
      throw new Error("Refusing to remove a path outside the shadow repository.");
    }
    await fsPromises.rm(targetPath, { recursive: true, force: true });
  }
}

async function copyFilesToShadow(files, shadowRepoPath) {
  const root = path.resolve(shadowRepoPath);
  for (const file of files) {
    const targetPath = path.join(root, file.relativePath);
    if (!isPathInsideRoot(targetPath, root)) {
      throw new Error(`Refusing to copy outside the shadow repository: ${file.relativePath}`);
    }
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.copyFile(file.absolutePath, targetPath);
  }
}

async function writeShadowManifest(shadowRepoPath, manifest) {
  const manifestPath = path.join(shadowRepoPath, SHADOW_MANIFEST_PATH);
  await fsPromises.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsPromises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function ensureShadowGitRepository(shadowRepoPath, branch = DEFAULT_BRANCH) {
  await fsPromises.mkdir(shadowRepoPath, { recursive: true });
  if (!await pathExists(path.join(shadowRepoPath, ".git"))) {
    await runGit(shadowRepoPath, ["init", "-b", branch], { allowFailure: true });
    await runGit(shadowRepoPath, ["init"], { allowFailure: true });
  }
  await runGit(shadowRepoPath, ["config", "user.name", "Tantalum Cloud Sync"]);
  await runGit(shadowRepoPath, ["config", "user.email", "cloud-sync@tantalum.local"]);
}

async function commitShadowChanges(shadowRepoPath, message) {
  await runGit(shadowRepoPath, ["add", "-A", "-f"]);
  await runGit(shadowRepoPath, ["rm", "--cached", "-r", "--quiet", ".tantalum-sync"], { allowFailure: true });
  const status = await runGit(shadowRepoPath, ["status", "--porcelain", "--untracked-files=no"], { allowFailure: true });
  if (!status.stdout.trim()) {
    return { committed: false, output: "No cloud sync changes to commit." };
  }

  const commit = await runGit(shadowRepoPath, ["commit", "-m", message || "Sync project files"]);
  const rev = await runGit(shadowRepoPath, ["rev-parse", "--short=12", "HEAD"], { allowFailure: true });
  return {
    committed: true,
    commit: rev.stdout.trim(),
    output: [commit.stdout, commit.stderr].filter(Boolean).join("\n").trim(),
  };
}

async function ensureShadowHead(shadowRepoPath, message = "Initialize cloud project") {
  const head = await runGit(shadowRepoPath, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  if (head.code === 0) {
    return false;
  }
  await runGit(shadowRepoPath, ["commit", "--allow-empty", "-m", message]);
  return true;
}

async function listShadowTrackedFiles(shadowRepoPath) {
  const result = await runGit(shadowRepoPath, ["ls-files", "-z"], { allowFailure: true });
  return result.stdout
    .split("\0")
    .map(normalizeRelativePath)
    .filter((relativePath) => relativePath && !relativePath.startsWith(".tantalum-sync/"))
    .sort((left, right) => left.localeCompare(right));
}

async function ensureShadowRemote(shadowRepoPath, remoteUrl) {
  if (!remoteUrl) {
    throw new Error("Cloud Git remote URL is missing.");
  }

  const current = await runGit(shadowRepoPath, ["remote", "get-url", "origin"], { allowFailure: true });
  if (current.code === 0) {
    if (current.stdout.trim() !== remoteUrl) {
      await runGit(shadowRepoPath, ["remote", "set-url", "origin", remoteUrl]);
    }
    return;
  }

  await runGit(shadowRepoPath, ["remote", "add", "origin", remoteUrl]);
}

async function remoteBranchExists(shadowRepoPath, branch, env) {
  const result = await runGit(shadowRepoPath, ["ls-remote", "--heads", "origin", branch], { env, allowFailure: true, timeoutMs: 60000 });
  return result.code === 0 && Boolean(result.stdout.trim());
}

async function checkoutBranch(shadowRepoPath, branch) {
  const current = await runGit(shadowRepoPath, ["branch", "--show-current"], { allowFailure: true });
  if (current.stdout.trim() === branch) {
    return;
  }

  await runGit(shadowRepoPath, ["checkout", "-B", branch], { allowFailure: true });
}

async function compareFiles(leftPath, rightPath) {
  try {
    const [left, right] = await Promise.all([fsPromises.readFile(leftPath), fsPromises.readFile(rightPath)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

class CloudSyncService {
  constructor(options = {}) {
    this.app = options.app || null;
    this.getPreferenceStore = typeof options.getPreferenceStore === "function" ? options.getPreferenceStore : () => null;
    this.userDataPath = options.userDataPath || null;
    this.executeProjectSync = typeof options.executeProjectSync === "function" ? options.executeProjectSync : null;
    this.syncInFlight = new Map();
  }

  getBasePath() {
    const userData = this.userDataPath || this.app?.getPath?.("userData");
    if (!userData) {
      throw new Error("Cloud sync app data path is unavailable.");
    }
    return path.join(userData, "cloud-sync");
  }

  getShadowRepoPath(projectId) {
    return path.join(this.getBasePath(), "repos", safeProjectId(projectId));
  }

  getDeviceIdentityPath() {
    return path.join(this.getBasePath(), DEVICE_IDENTITY_PATH);
  }

  getDeviceKeyPath(deviceId) {
    return path.join(this.getBasePath(), "keys", `${safeProjectId(deviceId)}_ed25519`);
  }

  getProjects() {
    const stored = this.getPreferenceStore()?.get(CLOUD_SYNC_PREFERENCES_KEY);
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  }

  saveProject(projectId, data) {
    const nextProject = {
      ...data,
      projectId,
      updatedAt: new Date().toISOString(),
    };
    const store = this.getPreferenceStore();
    if (!store) {
      return nextProject;
    }
    const projects = this.getProjects();
    const next = {
      ...projects,
      [projectId]: {
        ...(projects[projectId] || {}),
        ...nextProject,
      },
    };
    store.set(CLOUD_SYNC_PREFERENCES_KEY, next);
    return next[projectId];
  }

  getProject(projectId) {
    const projects = this.getProjects();
    return projects[projectId] || null;
  }

  async ensureDeviceIdentity() {
    const identityPath = this.getDeviceIdentityPath();
    const existing = await readJsonFile(identityPath, null);
    const now = new Date().toISOString();
    const identity = existing && typeof existing === "object" ? existing : {};
    const deviceId = typeof identity.deviceId === "string" && identity.deviceId.trim()
      ? identity.deviceId.trim()
      : `dev_${crypto.randomBytes(16).toString("hex")}`;
    const deviceName = typeof identity.deviceName === "string" && identity.deviceName.trim()
      ? identity.deviceName.trim()
      : `${os.hostname() || "device"} (${os.platform()})`;
    const privateKeyPath = this.getDeviceKeyPath(deviceId);
    const publicKeyPath = `${privateKeyPath}.pub`;

    await fsPromises.mkdir(path.dirname(identityPath), { recursive: true });
    await fsPromises.mkdir(path.dirname(privateKeyPath), { recursive: true });
    if (!await pathExists(privateKeyPath) || !await pathExists(publicKeyPath)) {
      await runProcess("ssh-keygen", [
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `tantalum:${deviceId}`,
        "-f",
        privateKeyPath,
      ], { timeoutMs: 60000 });
    }

    await fsPromises.chmod(privateKeyPath, 0o600).catch(() => {});
    const publicKey = (await fsPromises.readFile(publicKeyPath, "utf8")).trim();
    const nextIdentity = {
      deviceId,
      deviceName,
      privateKeyPath,
      publicKeyPath,
      publicKey,
      createdAt: identity.createdAt || now,
      updatedAt: now,
    };
    await fsPromises.writeFile(identityPath, `${JSON.stringify(nextIdentity, null, 2)}\n`, "utf8");
    return nextIdentity;
  }

  gitEnvForProject(project) {
    const privateKeyPath = project?.sshPrivateKeyPath;
    if (!privateKeyPath) {
      return {};
    }

    return {
      GIT_SSH_COMMAND: `ssh -i ${quoteSshCommandPath(privateKeyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    };
  }

  requireProjectSyncFunction() {
    if (!this.executeProjectSync) {
      throw new Error("Project sync function executor is not configured.");
    }
    return this.executeProjectSync;
  }

  async inspectWorkspace(workspacePath) {
    const root = path.resolve(workspacePath);
    const stat = await fsPromises.stat(root);
    if (!stat.isDirectory()) {
      throw new Error("Cloud sync source must be a folder.");
    }
    const gitPath = path.join(root, ".git");
    return {
      workspacePath: root,
      hasExistingGit: await pathExists(gitPath),
      gitPath,
    };
  }

  async scanWorkspace(workspacePath, options = {}) {
    const root = path.resolve(workspacePath);
    const inspection = await this.inspectWorkspace(root);
    const userRules = await readTantalumIgnore(root);
    let scan;
    let gitScanError = "";

    if (inspection.hasExistingGit) {
      try {
        scan = await scanGitWorkspace(root, userRules, options);
      } catch (error) {
        gitScanError = error instanceof Error ? error.message : "Unable to scan Git project.";
        scan = await walkWorkspace(root, userRules, options);
      }
    } else {
      scan = await walkWorkspace(root, userRules, options);
    }

    return {
      workspacePath: root,
      hasExistingGit: inspection.hasExistingGit,
      usedReadOnlyGitScan: inspection.hasExistingGit && !gitScanError,
      gitScanError,
      userIgnoreRules: userRules.map((rule) => rule.raw),
      files: scan.files,
      emptyDirectories: scan.emptyDirectories,
      excluded: scan.excluded,
      stats: scan.stats,
    };
  }

  async snapshotWorkspace(payload = {}) {
    const workspacePath = path.resolve(payload.workspacePath || "");
    const projectId = safeProjectId(payload.projectId || projectIdForWorkspace(workspacePath));
    const branch = String(payload.branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
    const shadowRepoPath = this.getShadowRepoPath(projectId);
    const scan = await this.scanWorkspace(workspacePath, payload);

    await ensureShadowGitRepository(shadowRepoPath, branch);
    await removeDirectoryContents(shadowRepoPath);
    await copyFilesToShadow(scan.files, shadowRepoPath);
    const manifestFiles = await Promise.all(scan.files.map(async (file) => ({
      path: file.relativePath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      sha256: await hashFile(file.absolutePath),
    })));

    const manifest = {
      version: 1,
      projectId,
      workspacePath,
      hasExistingGit: scan.hasExistingGit,
      usedReadOnlyGitScan: scan.usedReadOnlyGitScan,
      files: manifestFiles,
      emptyDirectories: scan.emptyDirectories,
      excludedSample: scan.excluded,
      stats: scan.stats,
      createdAt: new Date().toISOString(),
    };
    await writeShadowManifest(shadowRepoPath, manifest);

    const commitResult = await commitShadowChanges(shadowRepoPath, payload.message || "Sync project files");
    const savedProject = this.saveProject(projectId, {
      workspacePath,
      shadowRepoPath,
      branch,
      hasExistingGit: scan.hasExistingGit,
      usedReadOnlyGitScan: scan.usedReadOnlyGitScan,
      lastSnapshotAt: manifest.createdAt,
      lastCommit: commitResult.commit || "",
      stats: scan.stats,
    });

    return {
      project: savedProject,
      projectId,
      shadowRepoPath,
      manifestPath: path.join(shadowRepoPath, SHADOW_MANIFEST_PATH),
      commit: commitResult,
      scan: {
        hasExistingGit: scan.hasExistingGit,
        usedReadOnlyGitScan: scan.usedReadOnlyGitScan,
        gitScanError: scan.gitScanError,
        userIgnoreRules: scan.userIgnoreRules,
        emptyDirectories: scan.emptyDirectories,
        excluded: scan.excluded,
        stats: scan.stats,
      },
    };
  }

  async registerSyncEvent(project, event) {
    if (!project?.cloudProjectId || !this.executeProjectSync) {
      return null;
    }

    try {
      return await this.executeProjectSync("/projects/sync-event", {
        projectId: project.cloudProjectId,
        deviceId: project.deviceId || "",
        branch: project.branch || DEFAULT_BRANCH,
        ...event,
      });
    } catch {
      return null;
    }
  }

  async saveRemoteProject(projectId, patch) {
    const saved = this.saveProject(projectId, {
      ...patch,
      projectId,
    });
    return saved;
  }

  async createProject(payload = {}) {
    const workspacePath = path.resolve(payload.workspacePath || "");
    const projectName = String(payload.name || path.basename(workspacePath) || "Untitled project").trim();
    const identity = await this.ensureDeviceIdentity();
    const remoteResponse = await this.requireProjectSyncFunction()("/projects/create", {
      name: projectName,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      sshPublicKey: identity.publicKey,
    });
    const remote = normalizeRemoteGitPayload(remoteResponse);
    const projectId = safeProjectId(remote.cloudProjectId || remote.repoName || projectIdForWorkspace(workspacePath));
    const branch = remote.branch || DEFAULT_BRANCH;

    let savedProject = this.saveProject(projectId, {
      workspacePath,
      shadowRepoPath: this.getShadowRepoPath(projectId),
      branch,
      cloudProjectId: remote.cloudProjectId || projectId,
      cloudProjectName: remote.cloudProjectName || projectName,
      remoteUrl: remote.remoteUrl,
      repoOwner: remote.repoOwner,
      repoName: remote.repoName,
      webUrl: remote.webUrl,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      sshPrivateKeyPath: identity.privateKeyPath,
      sshPublicKeyPath: identity.publicKeyPath,
      syncStatus: "syncing",
      syncMessage: "Creating cloud project.",
      paused: false,
    });

    try {
      const snapshot = await this.snapshotWorkspace({
        ...payload,
        workspacePath,
        projectId,
        branch,
        message: "Initial cloud project sync",
      });
      savedProject = this.saveProject(projectId, {
        ...savedProject,
        ...snapshot.project,
        cloudProjectId: remote.cloudProjectId || projectId,
        cloudProjectName: remote.cloudProjectName || projectName,
        remoteUrl: remote.remoteUrl,
        repoOwner: remote.repoOwner,
        repoName: remote.repoName,
        webUrl: remote.webUrl,
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        sshPrivateKeyPath: identity.privateKeyPath,
        sshPublicKeyPath: identity.publicKeyPath,
        syncStatus: "syncing",
        syncMessage: "Pushing initial files.",
        paused: false,
      });

      await this.pushShadow(savedProject, { initial: true });
      const trackedFiles = await listShadowTrackedFiles(savedProject.shadowRepoPath);
      savedProject = this.saveProject(projectId, {
        ...savedProject,
        syncStatus: "idle",
        syncMessage: "Cloud sync is ready.",
        lastSyncAt: new Date().toISOString(),
        syncedFiles: trackedFiles,
      });
      await this.registerSyncEvent(savedProject, {
        operation: "create",
        status: "success",
        commitHash: savedProject.lastCommit || "",
        message: "Initial cloud project sync completed.",
      });
      return { project: savedProject, remote: remoteResponse };
    } catch (error) {
      savedProject = this.saveProject(projectId, {
        ...savedProject,
        syncStatus: "error",
        syncMessage: error instanceof Error ? error.message : "Cloud project was created, but the initial push failed.",
      });
      await this.registerSyncEvent(savedProject, {
        operation: "create",
        status: "failed",
        message: savedProject.syncMessage,
      });
      throw error;
    }
  }

  async linkProject(payload = {}) {
    const workspacePath = path.resolve(payload.workspacePath || "");
    const requestedProjectId = String(payload.projectId || payload.cloudProjectId || "").trim();
    if (!requestedProjectId) {
      throw new Error("Cloud project ID is required.");
    }
    const cloudProjectId = safeProjectId(requestedProjectId);

    const identity = await this.ensureDeviceIdentity();
    const remoteResponse = await this.requireProjectSyncFunction()("/projects/link-device", {
      projectId: cloudProjectId,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      sshPublicKey: identity.publicKey,
    });
    const remote = normalizeRemoteGitPayload(remoteResponse);
    const projectId = safeProjectId(remote.cloudProjectId || cloudProjectId);
    const branch = remote.branch || DEFAULT_BRANCH;
    const shadowRepoPath = this.getShadowRepoPath(projectId);

    let savedProject = this.saveProject(projectId, {
      workspacePath,
      shadowRepoPath,
      branch,
      cloudProjectId: remote.cloudProjectId || cloudProjectId,
      cloudProjectName: remote.cloudProjectName || "",
      remoteUrl: remote.remoteUrl,
      repoOwner: remote.repoOwner,
      repoName: remote.repoName,
      webUrl: remote.webUrl,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      sshPrivateKeyPath: identity.privateKeyPath,
      sshPublicKeyPath: identity.publicKeyPath,
      syncStatus: "syncing",
      syncMessage: "Linking device.",
      paused: false,
    });

    await ensureShadowGitRepository(shadowRepoPath, branch);
    await ensureShadowRemote(shadowRepoPath, remote.remoteUrl);
    const env = this.gitEnvForProject(savedProject);
    const hasRemoteBranch = await remoteBranchExists(shadowRepoPath, branch, env);

    if (hasRemoteBranch) {
      await runGit(shadowRepoPath, ["fetch", "origin", branch], { env });
      await runGit(shadowRepoPath, ["checkout", "-B", branch, `origin/${branch}`], { env });
      const scan = await this.scanWorkspace(workspacePath, payload);
      const conflicts = [];
      for (const file of scan.files) {
        const shadowFilePath = path.join(shadowRepoPath, file.relativePath);
        if (await pathExists(shadowFilePath) && !await compareFiles(file.absolutePath, shadowFilePath)) {
          conflicts.push(file.relativePath);
          if (conflicts.length >= 10) {
            break;
          }
        }
      }

      if (conflicts.length > 0) {
        savedProject = this.saveProject(projectId, {
          ...savedProject,
          syncStatus: "conflict",
          syncMessage: `Cloud project differs from local files: ${conflicts.join(", ")}`,
          conflictPaths: conflicts,
        });
        await this.registerSyncEvent(savedProject, {
          operation: "link",
          status: "conflict",
          message: savedProject.syncMessage,
        });
        return { project: savedProject, remote: remoteResponse, conflict: true };
      }

      await this.applyShadowToWorkspace(savedProject);
    }

    const syncResult = await this.syncNow(projectId, { reason: "link" });
    return { ...syncResult, remote: remoteResponse };
  }

  async pushShadow(project, options = {}) {
    const shadowRepoPath = project.shadowRepoPath || this.getShadowRepoPath(project.projectId);
    const branch = project.branch || DEFAULT_BRANCH;
    await ensureShadowRemote(shadowRepoPath, project.remoteUrl);
    await checkoutBranch(shadowRepoPath, branch);
    await ensureShadowHead(shadowRepoPath);
    const env = this.gitEnvForProject(project);
    if (!options.initial) {
      await runGit(shadowRepoPath, ["fetch", "origin"], { env, allowFailure: true, timeoutMs: 60000 });
    }
    await runGit(shadowRepoPath, ["push", "-u", "origin", branch], { env, timeoutMs: 120000 });
  }

  async pullRebaseShadow(project) {
    const shadowRepoPath = project.shadowRepoPath || this.getShadowRepoPath(project.projectId);
    const branch = project.branch || DEFAULT_BRANCH;
    await ensureShadowRemote(shadowRepoPath, project.remoteUrl);
    await checkoutBranch(shadowRepoPath, branch);
    const env = this.gitEnvForProject(project);
    if (!await remoteBranchExists(shadowRepoPath, branch, env)) {
      return { pulled: false, reason: "Remote branch does not exist yet." };
    }

    await runGit(shadowRepoPath, ["fetch", "origin", branch], { env, timeoutMs: 60000 });
    await runGit(shadowRepoPath, ["pull", "--rebase", "origin", branch], { env, timeoutMs: 120000 });
    return { pulled: true };
  }

  async applyShadowToWorkspace(project) {
    const shadowRepoPath = project.shadowRepoPath || this.getShadowRepoPath(project.projectId);
    const workspacePath = path.resolve(project.workspacePath || "");
    const workspaceStats = await fsPromises.stat(workspacePath);
    if (!workspaceStats.isDirectory()) {
      throw new Error("Linked workspace folder is missing.");
    }

    const trackedFiles = await listShadowTrackedFiles(shadowRepoPath);
    const nextSet = new Set(trackedFiles);
    const previousFiles = Array.isArray(project.syncedFiles) ? project.syncedFiles : [];

    for (const previousPath of previousFiles) {
      const normalized = normalizeRelativePath(previousPath);
      if (!normalized || nextSet.has(normalized)) {
        continue;
      }
      const targetPath = path.join(workspacePath, normalized);
      if (!isPathInsideRoot(targetPath, workspacePath)) {
        continue;
      }
      await fsPromises.rm(targetPath, { force: true }).catch(() => {});
    }

    for (const relativePath of trackedFiles) {
      const sourcePath = path.join(shadowRepoPath, relativePath);
      const targetPath = path.join(workspacePath, relativePath);
      if (!isPathInsideRoot(targetPath, workspacePath)) {
        throw new Error(`Refusing to apply cloud file outside the workspace: ${relativePath}`);
      }
      await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
      await fsPromises.copyFile(sourcePath, targetPath);
    }

    return trackedFiles;
  }

  async syncNow(projectId, options = {}) {
    const requestedProjectId = String(projectId || "").trim();
    if (!requestedProjectId) {
      throw new Error("Cloud sync project ID is required.");
    }
    const normalizedProjectId = safeProjectId(requestedProjectId);
    const existingProject = this.getProject(normalizedProjectId);
    if (!existingProject) {
      throw new Error("Cloud sync project was not found on this device.");
    }
    if (existingProject.paused) {
      return {
        project: existingProject,
        skipped: true,
        reason: "Cloud sync is paused.",
      };
    }
    if (!existingProject.remoteUrl) {
      throw new Error("Cloud Git remote is not linked for this project.");
    }

    if (this.syncInFlight.has(normalizedProjectId)) {
      return this.syncInFlight.get(normalizedProjectId);
    }

    const syncPromise = (async () => {
      let project = this.saveProject(normalizedProjectId, {
        ...existingProject,
        syncStatus: "syncing",
        syncMessage: "Preparing local changes.",
      });

      try {
        const snapshot = await this.snapshotWorkspace({
          workspacePath: project.workspacePath,
          projectId: normalizedProjectId,
          branch: project.branch || DEFAULT_BRANCH,
          message: options.reason === "auto" ? "Auto sync project files" : "Sync project files",
        });
        project = this.saveProject(normalizedProjectId, {
          ...project,
          ...snapshot.project,
          cloudProjectId: existingProject.cloudProjectId,
          cloudProjectName: existingProject.cloudProjectName,
          remoteUrl: existingProject.remoteUrl,
          repoOwner: existingProject.repoOwner,
          repoName: existingProject.repoName,
          webUrl: existingProject.webUrl,
          deviceId: existingProject.deviceId,
          deviceName: existingProject.deviceName,
          sshPrivateKeyPath: existingProject.sshPrivateKeyPath,
          sshPublicKeyPath: existingProject.sshPublicKeyPath,
          syncStatus: "syncing",
          syncMessage: "Rebasing with cloud.",
        });

        try {
          await this.pullRebaseShadow(project);
        } catch (error) {
          await runGit(project.shadowRepoPath, ["rebase", "--abort"], { allowFailure: true });
          const message = error instanceof Error ? error.message : "Cloud sync conflict.";
          project = this.saveProject(normalizedProjectId, {
            ...project,
            syncStatus: "conflict",
            syncMessage: message,
          });
          await this.registerSyncEvent(project, {
            operation: options.reason || "sync",
            status: "conflict",
            message,
          });
          return { project, conflict: true };
        }

        project = this.saveProject(normalizedProjectId, {
          ...project,
          syncStatus: "syncing",
          syncMessage: "Pushing cloud changes.",
        });
        await this.pushShadow(project);
        const trackedFiles = await this.applyShadowToWorkspace(project);
        project = this.saveProject(normalizedProjectId, {
          ...project,
          syncStatus: "idle",
          syncMessage: "Cloud sync complete.",
          lastSyncAt: new Date().toISOString(),
          syncedFiles: trackedFiles,
        });
        await this.registerSyncEvent(project, {
          operation: options.reason || "sync",
          status: "success",
          commitHash: project.lastCommit || "",
          message: "Cloud sync completed.",
        });

        return { project, snapshot };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Cloud sync failed.";
        project = this.saveProject(normalizedProjectId, {
          ...project,
          syncStatus: "error",
          syncMessage: message,
        });
        await this.registerSyncEvent(project, {
          operation: options.reason || "sync",
          status: "failed",
          message,
        });
        throw error;
      }
    })().finally(() => {
      this.syncInFlight.delete(normalizedProjectId);
    });

    this.syncInFlight.set(normalizedProjectId, syncPromise);
    return syncPromise;
  }

  pause(projectId) {
    const requestedProjectId = String(projectId || "").trim();
    if (!requestedProjectId) {
      throw new Error("Cloud sync project ID is required.");
    }
    const project = this.getProject(safeProjectId(requestedProjectId));
    if (!project) {
      throw new Error("Cloud sync project was not found on this device.");
    }
    return this.saveProject(project.projectId, {
      ...project,
      paused: true,
      syncStatus: "paused",
      syncMessage: "Cloud sync is paused.",
    });
  }

  resume(projectId) {
    const requestedProjectId = String(projectId || "").trim();
    if (!requestedProjectId) {
      throw new Error("Cloud sync project ID is required.");
    }
    const project = this.getProject(safeProjectId(requestedProjectId));
    if (!project) {
      throw new Error("Cloud sync project was not found on this device.");
    }
    return this.saveProject(project.projectId, {
      ...project,
      paused: false,
      syncStatus: "idle",
      syncMessage: "Cloud sync is ready.",
    });
  }

  getStatus(projectId) {
    const requestedProjectId = String(projectId || "").trim();
    if (!requestedProjectId) {
      throw new Error("Cloud sync project ID is required.");
    }
    const project = this.getProject(safeProjectId(requestedProjectId));
    if (!project) {
      throw new Error("Cloud sync project was not found on this device.");
    }
    return project;
  }

  listProjects() {
    return Object.values(this.getProjects());
  }
}

module.exports = {
  CLOUD_SYNC_PREFERENCES_KEY,
  SHADOW_MANIFEST_PATH,
  CloudSyncService,
  projectIdForWorkspace,
  safeProjectId,
};

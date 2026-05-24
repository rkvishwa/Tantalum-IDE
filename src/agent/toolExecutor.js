const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const {
  extractArduinoIncludes,
  includeLooksBuiltin,
  normalizeIncludeBase,
  normalizeToolRequest,
} = require("./toolRegistry");

function normalizeOutput(value, limit = 20000) {
  const text = String(value || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  return text.length > limit ? `${text.slice(0, limit)}\n\n[Output truncated.]` : text;
}

function createCanceledError(message = "Tool run stopped by user.") {
  const error = new Error(message);
  error.canceled = true;
  return error;
}

function throwIfCanceled(signal) {
  if (signal?.aborted) {
    throw createCanceledError();
  }
}

function isCanceledError(error) {
  return Boolean(error?.canceled || error?.name === "AbortError" || /stopped|aborted|canceled|cancelled/i.test(error?.message || ""));
}

function isPathInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function normalizePackageKey(value) {
  return String(value || "").trim().toLowerCase();
}

function createToolchainTaskId(prefix) {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
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

function formatProgressMessage(chunk, fallback) {
  return (
    String(chunk || "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() || fallback
  );
}

function classifyInstallPhase(chunk) {
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

function mergeAbortSignals(parentSignal, controller) {
  if (!parentSignal) {
    return () => {};
  }

  if (parentSignal.aborted) {
    controller.abort();
    return () => {};
  }

  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  return () => parentSignal.removeEventListener("abort", abort);
}

class AgentToolExecutor {
  constructor(context = {}) {
    this.context = context;
  }

  async execute(toolRequest, options = {}) {
    const request = normalizeToolRequest(toolRequest);
    if (!request) {
      throw new Error("A valid agent tool request is required.");
    }

    const registry = this.context.registry;
    const settings = this.context.getSettings?.() || {};
    if (registry && !registry.isEnabled(request.toolId, settings)) {
      throw new Error(`${request.toolId} is disabled in Agent Tools settings.`);
    }

    this.context.emitProgress?.({
      toolRequest: request,
      status: "running",
      message: request.summary,
      createdAt: new Date().toISOString(),
    });

    try {
      throwIfCanceled(options.signal);
      let result;
      switch (request.toolId) {
        case "arduino.verify":
          result = await this.#verifyArduino(request, options);
          break;
        case "arduino.upload":
          result = await this.#uploadArduino(request, options);
          break;
        case "arduino.library.install":
          result = await this.#installLibrary(request, options);
          break;
        case "arduino.platform.install":
          result = await this.#installPlatform(request, options);
          break;
        case "git.status":
        case "git.diff":
        case "git.log":
        case "git.stage":
        case "git.commit":
        case "git.branch":
        case "git.pull":
        case "git.push":
        case "git.discard":
        case "git.publish":
          result = await this.#runGitTool(request, options);
          break;
        default:
          throw new Error(`Agent tool ${request.toolId} is not implemented.`);
      }

      this.context.emitProgress?.({
        toolRequest: request,
        status: "completed",
        message: result.output || `${request.summary} completed.`,
        createdAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.context.emitProgress?.({
        toolRequest: request,
        status: isCanceledError(error) ? "canceled" : "error",
        message: error instanceof Error ? error.message : "Agent tool failed.",
        createdAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async #readSketchCode(request, options = {}) {
    const workspaceRoot = this.context.getWorkspaceRoot?.();
    if (!workspaceRoot) {
      throw new Error("Open a workspace before using Arduino agent tools.");
    }

    const relativePath = normalizeRelativePath(request.arguments.filePath);
    if (!relativePath) {
      throw new Error("Choose a saved sketch file before using this Arduino tool.");
    }

    const absoluteRoot = path.resolve(workspaceRoot);
    const absolutePath = path.resolve(absoluteRoot, relativePath);
    if (!isPathInsideRoot(absolutePath, absoluteRoot)) {
      throw new Error("Blocked Arduino tool access outside the active workspace.");
    }

    const activeTab = options.activeTab || null;
    if (activeTab?.path && path.resolve(activeTab.path) === absolutePath && typeof activeTab.content === "string") {
      return {
        absolutePath,
        relativePath,
        displayName: activeTab.name || path.basename(absolutePath),
        code: activeTab.content,
      };
    }

    return {
      absolutePath,
      relativePath,
      displayName: path.basename(absolutePath),
      code: await fsPromises.readFile(absolutePath, "utf8"),
    };
  }

  async #verifyArduino(request, options = {}) {
    const sketch = await this.#readSketchCode(request, options);
    const board = String(request.arguments.board || "").trim();
    if (!board) {
      throw new Error("A board FQBN is required before verifying.");
    }

    const result = await this.context.compileArduino(sketch.code, board, {
      signal: options.signal,
      cloudRuntime: request.arguments.cloudRuntime || null,
    });

    return {
      output: normalizeOutput(result.output || result.message || "Verification successful."),
      meta: {
        filename: result.filename,
        binSize: result.binSize,
        board,
        filePath: sketch.relativePath,
      },
    };
  }

  async #uploadArduino(request, options = {}) {
    const targetType = String(request.arguments.targetType || "local").toLowerCase();
    if (targetType === "cloud") {
      return this.#uploadCloudArduino(request, options);
    }

    return this.#uploadLocalArduino(request, options);
  }

  async #uploadLocalArduino(request, options = {}) {
    const sketch = await this.#readSketchCode(request, options);
    const board = String(request.arguments.board || "").trim();
    const port = String(request.arguments.port || "").trim();
    const boardName = String(request.arguments.boardName || board || "board").trim();
    const uploadId = String(request.arguments.uploadId || createToolchainTaskId("usb-upload"));
    const verifyBeforeUpload = request.arguments.verifyBeforeUpload !== false;

    if (!board) {
      throw new Error("A board FQBN is required before uploading.");
    }
    if (!port) {
      throw new Error("A serial port is required before uploading.");
    }

    if (verifyBeforeUpload) {
      this.context.upsertNotification?.({
        id: uploadId,
        kind: "usb-upload",
        title: `Verifying ${sketch.displayName}`,
        detail: `Checking ${sketch.displayName} before uploading to ${boardName}...`,
        status: "running",
        phase: "verify",
        progress: null,
        name: boardName,
        target: port,
        metadata: { board, port, fileName: sketch.displayName, agentTool: true },
      });
      await this.context.compileArduino(sketch.code, board, { signal: options.signal });
    }

    this.context.upsertNotification?.({
      id: uploadId,
      kind: "usb-upload",
      title: `Uploading to ${boardName}`,
      detail: `Uploading ${sketch.displayName} on ${port}...`,
      status: "running",
      phase: "upload",
      progress: null,
      name: boardName,
      target: port,
      metadata: { board, port, fileName: sketch.displayName, agentTool: true },
    });

    try {
      const result = await this.context.uploadLocalSketch(
        sketch.code,
        board,
        port,
        (chunk, stream) => {
          const message = formatProgressMessage(chunk, "Uploading over USB...");
          const progress = extractLastCliProgressPercent(chunk);
          this.context.emitToolchainEvent?.("toolchain:usb-upload-progress", {
            uploadId,
            port,
            board,
            stream,
            chunk,
            message,
            progress,
          });
          this.context.upsertNotification?.({
            id: uploadId,
            kind: "usb-upload",
            title: `Uploading to ${boardName}`,
            detail: message,
            status: "running",
            phase: "upload",
            progress,
            name: boardName,
            target: port,
            metadata: { board, port, fileName: sketch.displayName, agentTool: true },
          });
        },
        {
          signal: options.signal,
          cloudRuntime: request.arguments.cloudRuntime || null,
        },
      );

      this.context.upsertNotification?.({
        id: uploadId,
        kind: "usb-upload",
        title: `Uploaded to ${boardName}`,
        detail: result.message || "Upload finished.",
        status: "success",
        phase: "complete",
        progress: 100,
        name: boardName,
        target: port,
        metadata: { board, port, fileName: sketch.displayName, agentTool: true },
      });

      return {
        output: normalizeOutput(result.output || result.message || "Upload successful."),
        meta: { board, port, filePath: sketch.relativePath, uploadId },
      };
    } catch (error) {
      this.context.upsertNotification?.({
        id: uploadId,
        kind: "usb-upload",
        title: "USB upload failed",
        detail: error instanceof Error ? error.message : "Upload failed.",
        status: isCanceledError(error) ? "canceled" : "error",
        phase: isCanceledError(error) ? "canceled" : "error",
        progress: null,
        name: boardName,
        target: port,
        metadata: { board, port, fileName: sketch.displayName, agentTool: true },
      });
      throw error;
    }
  }

  async #uploadCloudArduino(request, options = {}) {
    const uploadCloudFirmware = this.context.uploadCloudFirmware;
    if (typeof uploadCloudFirmware !== "function") {
      throw new Error("Cloud OTA upload is not configured for agent tools.");
    }

    const sketch = await this.#readSketchCode(request, options);
    const boardId = String(request.arguments.boardId || "").trim();
    const board = String(request.arguments.board || "").trim();
    const version = String(request.arguments.version || "1.0.0").trim();
    const uploadId = String(request.arguments.uploadId || createToolchainTaskId("firmware-upload"));
    const boardName = String(request.arguments.boardName || boardId || "cloud board").trim();

    if (!boardId || !board) {
      throw new Error("A cloud board and board FQBN are required before OTA upload.");
    }

    this.context.upsertNotification?.({
      id: uploadId,
      kind: "firmware-upload",
      title: `Building ${boardName} ${version}`,
      detail: "Compiling firmware release...",
      status: "running",
      phase: "compile",
      progress: null,
      name: boardName,
      version,
      target: boardName,
      metadata: { boardId, boardType: board, fileName: sketch.displayName, agentTool: true },
    });

    try {
      const result = await uploadCloudFirmware({
        code: sketch.code,
        boardId,
        boardType: board,
        boardName,
        version,
        notes: String(request.arguments.notes || "Uploaded by Tantalum AI."),
        signal: options.signal,
        notificationId: uploadId,
        fileName: sketch.displayName,
      });

      this.context.upsertNotification?.({
        id: uploadId,
        kind: "firmware-upload",
        title: `Uploaded ${boardName} ${version}`,
        detail: "Firmware uploaded and queued for OTA deployment.",
        status: "success",
        phase: "complete",
        progress: 100,
        name: boardName,
        version,
        target: boardName,
        metadata: { boardId, boardType: board, fileName: sketch.displayName, agentTool: true },
      });

      return {
        output: normalizeOutput(result.output || `Firmware ${version} uploaded and queued for OTA deployment.`),
        meta: { boardId, board, version, uploadId, firmwareId: result.firmwareId },
      };
    } catch (error) {
      this.context.upsertNotification?.({
        id: uploadId,
        kind: "firmware-upload",
        title: `Failed to upload ${boardName} ${version}`,
        detail: error instanceof Error ? error.message : "Firmware upload failed.",
        status: isCanceledError(error) ? "canceled" : "error",
        phase: isCanceledError(error) ? "canceled" : "error",
        progress: null,
        name: boardName,
        version,
        target: boardName,
        metadata: { boardId, boardType: board, fileName: sketch.displayName, agentTool: true },
      });
      throw error;
    }
  }

  async #installLibrary(request, options = {}) {
    const name = String(request.arguments.name || "").trim();
    const version = String(request.arguments.version || "latest").trim() || "latest";
    const installId = String(request.arguments.installId || createToolchainTaskId("library"));
    if (!name) {
      throw new Error("Library name is required.");
    }

    const installed = await this.context.listInstalledLibraries?.();
    const installedMatch = installed?.success && Array.isArray(installed.libraries)
      ? installed.libraries.find((library) => normalizePackageKey(library.name) === normalizePackageKey(name))
      : null;
    if (installedMatch && (version === "latest" || !version || installedMatch.version === version || installedMatch.installedVersion === version)) {
      return {
        output: `${installedMatch.name}@${installedMatch.version || "installed"} is already installed.`,
        meta: { installId, alreadyInstalled: true, installedVersion: installedMatch.version || installedMatch.installedVersion || "" },
      };
    }

    const controller = new AbortController();
    const clearAbort = mergeAbortSignals(options.signal, controller);
    this.context.registerLibraryInstall?.(installId, controller, { name, version });

    const emitProgress = (status, patch = {}) => {
      this.context.emitToolchainEvent?.("toolchain:library-install-progress", {
        installId,
        name,
        version: version === "latest" ? "" : version,
        status,
        phase: patch.phase || status,
        message: patch.message || "",
        progress: typeof patch.progress === "number" ? patch.progress : null,
      });
      this.context.upsertNotification?.({
        id: installId,
        kind: installedMatch ? "library-update" : "library-install",
        title:
          status === "success"
            ? `Installed ${name}`
            : status === "error"
              ? `Failed to install ${name}`
              : status === "canceled"
                ? `Stopped installing ${name}`
                : `Installing ${name}${version && version !== "latest" ? ` ${version}` : ""}`,
        detail: patch.message || "",
        status,
        phase: patch.phase || status,
        progress: typeof patch.progress === "number" ? patch.progress : null,
        name,
        version: version === "latest" ? "" : version,
        target: name,
        metadata: { installId, agentTool: true },
      });
    };

    try {
      emitProgress("queued", { phase: "prepare", message: `Preparing ${name} install...` });
      const result = await this.context.installLibrary(
        name,
        version,
        (progressEvent) => {
          if (typeof progressEvent === "string") {
            const message = formatProgressMessage(progressEvent, "Installing library...");
            emitProgress("running", {
              phase: classifyInstallPhase(progressEvent),
              message,
              progress: extractLastCliProgressPercent(progressEvent),
            });
            return;
          }

          emitProgress("running", {
            phase: progressEvent?.phase || "running",
            message: progressEvent?.message || "",
            progress: typeof progressEvent?.progress === "number" ? progressEvent.progress : null,
          });
        },
        { signal: controller.signal },
      );

      emitProgress("success", {
        phase: "complete",
        message: result.installedVersion ? `${name}@${result.installedVersion} installed.` : `${name} installed.`,
        progress: 100,
      });

      return {
        output: normalizeOutput(result.output || `${name} installed.`),
        meta: { installId, installedVersion: result.installedVersion, installedPath: result.installedPath },
      };
    } catch (error) {
      emitProgress(isCanceledError(error) ? "canceled" : "error", {
        phase: isCanceledError(error) ? "canceled" : "error",
        message: error instanceof Error ? error.message : `Failed to install ${name}.`,
      });
      throw error;
    } finally {
      clearAbort();
      this.context.unregisterLibraryInstall?.(installId);
    }
  }

  async #installPlatform(request, options = {}) {
    const basePackageName = String(request.arguments.packageName || "").trim();
    const version = String(request.arguments.version || "latest").trim() || "latest";
    if (!basePackageName) {
      throw new Error("Board platform package name is required.");
    }

    const packageName = basePackageName.includes("@") ? basePackageName : `${basePackageName}@${version}`;
    const installId = String(request.arguments.installId || createToolchainTaskId("platform"));
    const installed = await this.context.listInstalledPlatforms?.();
    const installedMatch = installed?.success && Array.isArray(installed.platforms)
      ? installed.platforms.find((platform) => normalizePackageKey(platform.id) === normalizePackageKey(basePackageName))
      : null;
    if (installedMatch && (version === "latest" || installedMatch.version === version || installedMatch.installedVersion === version)) {
      return {
        output: `${installedMatch.name || installedMatch.id}@${installedMatch.version || "installed"} is already installed.`,
        meta: { installId, alreadyInstalled: true, installedVersion: installedMatch.version || "" },
      };
    }

    const controller = new AbortController();
    const clearAbort = mergeAbortSignals(options.signal, controller);
    this.context.registerBoardPackageInstall?.(installId, controller);

    const platformName = String(request.arguments.name || basePackageName).trim();
    const emitNotification = (patch = {}) => {
      this.context.upsertNotification?.({
        id: installId,
        kind: installedMatch ? "platform-update" : "platform-install",
        title: patch.title || `${installedMatch ? "Updating" : "Installing"} ${platformName}`,
        detail: patch.detail || "",
        status: patch.status || "running",
        phase: patch.phase || "install",
        progress: typeof patch.progress === "number" ? patch.progress : null,
        name: platformName,
        version,
        target: platformName,
        metadata: { installId, platformId: basePackageName, operation: "install", agentTool: true },
      });
    };

    try {
      emitNotification({ status: "queued", phase: "prepare", detail: "Preparing board core install..." });
      const result = await this.context.installBoardPackage(null, packageName, (chunk) => {
        const detail = formatProgressMessage(chunk, "Installing board core...");
        emitNotification({
          title: `${installedMatch ? "Updating" : "Installing"} ${platformName}`,
          detail,
          status: "running",
          phase: "install",
          progress: extractLastCliProgressPercent(chunk),
        });
        this.context.emitToolchainEvent?.("toolchain:install-progress", chunk);
      }, { signal: controller.signal });

      emitNotification({
        title: `${installedMatch ? "Updated" : "Installed"} ${platformName}`,
        detail: `${platformName} installed.`,
        status: "success",
        phase: "complete",
        progress: 100,
      });

      return {
        output: normalizeOutput(result.output || `${platformName} installed.`),
        meta: { installId, packageName },
      };
    } catch (error) {
      emitNotification({
        title: isCanceledError(error) ? `Stopped installing ${platformName}` : `Failed to install ${platformName}`,
        detail: error instanceof Error ? error.message : "Board core install failed.",
        status: isCanceledError(error) ? "canceled" : "error",
        phase: isCanceledError(error) ? "canceled" : "error",
      });
      throw error;
    } finally {
      clearAbort();
      this.context.unregisterBoardPackageInstall?.(installId);
    }
  }

  async #runGitTool(request) {
    const args = request.arguments || {};
    const git = this.context.git || {};

    switch (request.toolId) {
      case "git.status": {
        const status = await git.getStatus();
        return { output: normalizeOutput(JSON.stringify(status, null, 2)), meta: { status } };
      }
      case "git.diff": {
        const diff = await git.getDiff({ path: args.path || "" });
        return { output: normalizeOutput(JSON.stringify(diff, null, 2)), meta: { diff } };
      }
      case "git.log": {
        const commits = await git.getLog(Number(args.limit || 20));
        return { output: normalizeOutput(JSON.stringify(commits, null, 2)), meta: { commits } };
      }
      case "git.stage":
        return { output: normalizeOutput((await git.stage({ paths: args.paths || ["."] })).output || "Staged changes.") };
      case "git.commit":
        return { output: normalizeOutput((await git.commit({ message: args.message })).output || "Committed changes.") };
      case "git.branch":
        return { output: normalizeOutput((await git.branch({ branch: args.branch, mode: args.mode })).output || "Updated Git branch.") };
      case "git.pull":
        return { output: normalizeOutput((await git.pull()).output || "Pulled from upstream.") };
      case "git.push":
        return { output: normalizeOutput((await git.push()).output || "Pushed to upstream.") };
      case "git.discard":
        return { output: normalizeOutput((await git.discard(args)).output || "Discarded changes.") };
      case "git.publish":
        return { output: normalizeOutput((await git.publish(args)).output || "Published repository.") };
      default:
        throw new Error(`Unsupported Git tool: ${request.toolId}`);
    }
  }
}

function collectInstalledHeaders(installedLibraries = []) {
  const headers = new Set();

  for (const library of installedLibraries) {
    const sourceDir = library?.sourceDir || library?.installDir;
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      continue;
    }

    const queue = [sourceDir];
    while (queue.length > 0) {
      const current = queue.shift();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(entryPath);
          continue;
        }
        if (/\.(h|hpp|hh|hxx)$/i.test(entry.name)) {
          headers.add(entry.name.toLowerCase());
        }
      }
    }
  }

  return headers;
}

async function workspaceHeaderExists(workspaceRoot, includeName) {
  if (!workspaceRoot) {
    return false;
  }

  const target = String(includeName || "").toLowerCase();
  const queue = [{ dir: workspaceRoot, depth: 0 }];
  const maxDepth = 8;
  const ignored = new Set([".git", "node_modules", "dist", "build", ".opencode"]);

  while (queue.length > 0) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fsPromises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (ignored.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: entryPath, depth: current.depth + 1 });
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase() === target) {
        return true;
      }
    }
  }

  return false;
}

async function recommendMissingArduinoLibraries({ workspaceRoot, changes, installedLibraries }) {
  const installedHeaders = collectInstalledHeaders(installedLibraries);
  const recommendations = [];
  const seen = new Set();

  for (const change of changes || []) {
    if (!/\.(ino|cpp|cxx|cc|c|h|hpp)$/i.test(change.path || "")) {
      continue;
    }

    for (const includeName of extractArduinoIncludes(change.nextContent || "")) {
      const key = includeName.toLowerCase();
      if (seen.has(key) || includeLooksBuiltin(includeName) || installedHeaders.has(key)) {
        continue;
      }

      if (await workspaceHeaderExists(workspaceRoot, includeName)) {
        continue;
      }

      seen.add(key);
      const libraryName = normalizeIncludeBase(includeName);
      if (!libraryName) {
        continue;
      }

      recommendations.push({
        includeName,
        libraryName,
        sourcePath: change.path,
      });
    }
  }

  return recommendations;
}

module.exports = {
  AgentToolExecutor,
  createCanceledError,
  isCanceledError,
  normalizeOutput,
  recommendMissingArduinoLibraries,
};

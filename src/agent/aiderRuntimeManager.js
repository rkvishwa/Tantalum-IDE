const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_EXCLUDED_NAMES = new Set([
  ".aider.chat.history.md",
  ".aider.input.history",
  ".aider.llm.history",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "dist",
  "node_modules",
  "out",
]);

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /credentials/i,
  /secret/i,
];

const MAX_AGENT_CHANGED_FILES = 50;
const MAX_TEXT_PREVIEW_BYTES = 1_500_000;

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isSensitiveRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  return parts.some((part) => part === ".git") || SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(parts.at(-1) || normalized));
}

function shouldCopyWorkspacePath(workspaceRoot, sourcePath) {
  const relativePath = path.relative(workspaceRoot, sourcePath);
  if (!relativePath) {
    return true;
  }

  const parts = normalizeRelativePath(relativePath).split("/");
  if (parts.some((part) => DEFAULT_EXCLUDED_NAMES.has(part))) {
    return false;
  }

  return !isSensitiveRelativePath(relativePath);
}

function isProbablyText(buffer) {
  if (buffer.length > MAX_TEXT_PREVIEW_BYTES) {
    return false;
  }

  return !buffer.includes(0);
}

function summarizeFileChange(originalContent, nextContent) {
  const beforeLines = String(originalContent ?? "").split("\n");
  const afterLines = String(nextContent ?? "").split("\n");
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  let changedLines = 0;

  for (let index = 0; index < maxLength; index += 1) {
    if ((beforeLines[index] ?? "") !== (afterLines[index] ?? "")) {
      changedLines += 1;
    }
  }

  return {
    changedLines,
    beforeLength: beforeLines.length,
    afterLength: afterLines.length,
  };
}

function commandForPlatform(executablePath) {
  return process.platform === "win32" ? `${executablePath}.exe` : executablePath;
}

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs || 120000;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : -1,
        signal: signal ?? null,
        stdout,
        stderr,
        output: [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : ""),
      });
    });
  });
}

class LocalOpenAiBridge {
  constructor({ token, source, mode, customCredentialId, customModelName, executeGatewayRequest }) {
    this.token = token;
    this.source = source;
    this.mode = mode;
    this.customCredentialId = customCredentialId;
    this.customModelName = customModelName;
    this.executeGatewayRequest = executeGatewayRequest;
    this.server = null;
    this.baseUrl = null;
  }

  async start() {
    await new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.#handleRequest(request, response);
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Unable to bind the local agent bridge."));
          return;
        }

        this.server = server;
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    return this.baseUrl;
  }

  async stop() {
    if (!this.server) {
      return;
    }

    await new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    this.server = null;
    this.baseUrl = null;
  }

  async #handleRequest(request, response) {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const authorization = request.headers.authorization || "";
      if (authorization !== `Bearer ${this.token}`) {
        this.#send(response, 401, { error: { message: "Unauthorized agent bridge request." } });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        this.#send(response, 200, {
          object: "list",
          data: [
            { id: "openai/tantalum-fast", object: "model" },
            { id: "openai/tantalum-plan", object: "model" },
            { id: "openai/tantalum-fast-editor", object: "model" },
            { id: "openai/tantalum-plan-editor", object: "model" },
          ],
        });
        return;
      }

      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        this.#send(response, 404, { error: { message: "Unsupported local agent bridge route." } });
        return;
      }

      const body = await this.#readJsonBody(request);
      const completion = await this.executeGatewayRequest({
        source: this.source,
        mode: this.mode,
        customCredentialId: this.customCredentialId,
        customModelName: this.customModelName,
        request: body,
      });

      this.#send(response, 200, completion);
    } catch (error) {
      this.#send(response, 500, {
        error: {
          message: error instanceof Error ? error.message : "Local agent bridge failed.",
        },
      });
    }
  }

  #readJsonBody(request) {
    return new Promise((resolve, reject) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk.toString();
        if (Buffer.byteLength(body, "utf8") > 8 * 1024 * 1024) {
          reject(new Error("Agent request is too large."));
          request.destroy();
        }
      });

      request.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("Agent request body was not valid JSON."));
        }
      });

      request.on("error", reject);
    });
  }

  #send(response, status, payload) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(payload));
  }
}

class AgentRuntimeManager {
  constructor(options) {
    this.app = options.app;
    this.getWorkspaceRoot = options.getWorkspaceRoot;
    this.executeGatewayRequest = options.executeGatewayRequest;
    this.securityManager = options.securityManager;
    this.markWorkspaceDirty = options.markWorkspaceDirty;
    this.addRecentFile = options.addRecentFile;
    this.activeRuns = new Set();
  }

  async getStatus() {
    const workspaceRoot = this.getWorkspaceRoot();
    const runtime = this.#runtimePaths();
    const aiderPath = runtime.aiderPath;
    const installed = fs.existsSync(aiderPath);

    return {
      workspaceRoot,
      setup: {
        installed,
        aiderPath: installed ? aiderPath : null,
        runtimeDir: runtime.runtimeDir,
        message: installed
          ? "Aider runtime is installed."
          : "Aider will be installed into the app data runtime on the first agent run.",
      },
    };
  }

  async run(payload = {}) {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open a workspace before starting the agent.");
    }

    if (this.activeRuns.has(workspaceRoot)) {
      throw new Error("An agent run is already active for this workspace.");
    }

    const prompt = String(payload.prompt || "").trim();
    if (!prompt) {
      throw new Error("Enter a prompt before starting the agent.");
    }

    this.activeRuns.add(workspaceRoot);
    let sandboxParent = null;
    let bridge = null;

    try {
      const aiderPath = await this.#ensureAiderInstalled();
      sandboxParent = await fsPromises.mkdtemp(path.join(os.tmpdir(), "tantalum-aider-"));
      const sandboxRoot = path.join(sandboxParent, "workspace");
      await this.#copyWorkspace(workspaceRoot, sandboxRoot);
      await this.#applyActiveTabSnapshot(workspaceRoot, sandboxRoot, payload.activeTab);

      const messagePath = path.join(sandboxParent, "message.txt");
      await fsPromises.writeFile(messagePath, this.#buildAiderMessage(prompt, payload.activeTab), "utf8");

      const source = payload.source === "custom" ? "custom" : "managed";
      const mode = payload.mode === "plan" ? "plan" : "fast";
      const token = crypto.randomBytes(32).toString("hex");
      bridge = new LocalOpenAiBridge({
        token,
        source,
        mode,
        customCredentialId: payload.customCredentialId || null,
        customModelName: payload.customModelName || null,
        executeGatewayRequest: this.executeGatewayRequest,
      });
      const bridgeUrl = await bridge.start();

      const args = this.#buildAiderArgs({
        messagePath,
        bridgeUrl,
        token,
        source,
        mode,
        customModelName: payload.customModelName,
      });

      const result = await runChild(aiderPath, args, {
        cwd: sandboxRoot,
        env: this.#buildAiderEnv(token),
        timeoutMs: mode === "plan" ? 600000 : 360000,
      });

      const output = result.output || "(Aider produced no terminal output.)";
      const changes = await this.#collectChanges(workspaceRoot, sandboxRoot);

      if (result.exitCode !== 0 && changes.length === 0) {
        throw new Error(output || `Aider exited with code ${result.exitCode}.`);
      }

      if (changes.length === 0) {
        return {
          output,
          changedFiles: [],
          requiresApproval: false,
        };
      }

      const approval = this.securityManager.createApproval({
        toolName: "aider_apply",
        summary: `Apply ${changes.length} Aider workspace ${changes.length === 1 ? "change" : "changes"}`,
        preview: {
          kind: "agent-run",
          files: changes,
          output: output.slice(-12000),
        },
        execute: async () => {
          const applied = await this.#applyChanges(workspaceRoot, changes);
          return {
            toolName: "aider_apply",
            output: `Applied ${applied.length} Aider ${applied.length === 1 ? "change" : "changes"}.`,
            meta: {
              action: "aider_apply",
              files: applied,
              revision: this.markWorkspaceDirty(workspaceRoot),
            },
          };
        },
      });

      return {
        output,
        changedFiles: changes.map((change) => ({
          path: change.path,
          changeType: change.changeType,
          stats: change.stats,
        })),
        requiresApproval: true,
        approval,
      };
    } finally {
      if (bridge) {
        await bridge.stop();
      }

      if (sandboxParent) {
        await fsPromises.rm(sandboxParent, { recursive: true, force: true });
      }

      this.activeRuns.delete(workspaceRoot);
    }
  }

  async resolveApproval(requestId, approved) {
    return this.securityManager.resolveApproval(requestId, approved);
  }

  #runtimePaths() {
    const runtimeDir = path.join(this.app.getPath("userData"), "aider-runtime");
    const binDir = process.platform === "win32" ? "Scripts" : "bin";

    return {
      runtimeDir,
      pythonPath: commandForPlatform(path.join(runtimeDir, binDir, "python")),
      aiderPath: commandForPlatform(path.join(runtimeDir, binDir, "aider")),
    };
  }

  async #ensureAiderInstalled() {
    const runtime = this.#runtimePaths();
    if (fs.existsSync(runtime.aiderPath)) {
      return runtime.aiderPath;
    }

    await fsPromises.mkdir(path.dirname(runtime.runtimeDir), { recursive: true });
    const python = await this.#findPython();
    await runChild(python.command, [...python.args, "-m", "venv", runtime.runtimeDir], { timeoutMs: 180000 });
    await runChild(runtime.pythonPath, ["-m", "pip", "install", "--upgrade", "pip"], { timeoutMs: 180000 });
    await runChild(runtime.pythonPath, ["-m", "pip", "install", "--upgrade", "aider-chat"], { timeoutMs: 600000 });

    if (!fs.existsSync(runtime.aiderPath)) {
      throw new Error("Aider installed, but the executable was not found in the app data runtime.");
    }

    return runtime.aiderPath;
  }

  async #findPython() {
    const candidates =
      process.platform === "win32"
        ? [
            { command: "py", args: ["-3"] },
            { command: "python", args: [] },
            { command: "python3", args: [] },
          ]
        : [
            { command: "python3", args: [] },
            { command: "python", args: [] },
          ];

    for (const candidate of candidates) {
      try {
        const result = await runChild(candidate.command, [...candidate.args, "--version"], { timeoutMs: 15000 });
        if (result.exitCode === 0) {
          return candidate;
        }
      } catch {
        // Try the next Python launcher.
      }
    }

    throw new Error("Python 3 is required to install Aider, but no Python launcher was found.");
  }

  async #copyWorkspace(workspaceRoot, sandboxRoot) {
    await fsPromises.cp(workspaceRoot, sandboxRoot, {
      recursive: true,
      dereference: false,
      filter: (sourcePath) => shouldCopyWorkspacePath(workspaceRoot, sourcePath),
    });
  }

  async #applyActiveTabSnapshot(workspaceRoot, sandboxRoot, activeTab) {
    if (!activeTab?.path || typeof activeTab.content !== "string") {
      return;
    }

    const absolutePath = path.resolve(activeTab.path);
    if (!isInsideRoot(absolutePath, workspaceRoot)) {
      return;
    }

    const relativePath = path.relative(workspaceRoot, absolutePath);
    if (isSensitiveRelativePath(relativePath)) {
      return;
    }

    const sandboxPath = path.resolve(sandboxRoot, relativePath);
    if (!isInsideRoot(sandboxPath, sandboxRoot)) {
      return;
    }

    await fsPromises.mkdir(path.dirname(sandboxPath), { recursive: true });
    await fsPromises.writeFile(sandboxPath, activeTab.content, "utf8");
  }

  #buildAiderMessage(prompt, activeTab) {
    if (!activeTab?.path) {
      return prompt;
    }

    return [
      prompt,
      "",
      "Active editor context:",
      `File: ${activeTab.path}`,
      `Display name: ${activeTab.name || path.basename(activeTab.path)}`,
      `Unsaved changes: ${activeTab.isDirty ? "yes" : "no"}`,
    ].join("\n");
  }

  #buildAiderArgs({ messagePath, bridgeUrl, token, source, mode, customModelName }) {
    const model =
      source === "custom"
        ? `openai/${String(customModelName || "").trim()}`
        : mode === "plan"
          ? "openai/tantalum-plan"
          : "openai/tantalum-fast";
    const editorModel = source === "custom" ? model : mode === "plan" ? "openai/tantalum-plan-editor" : "openai/tantalum-fast-editor";
    const args = [
      "--message-file",
      messagePath,
      "--model",
      model,
      "--editor-model",
      editorModel,
      "--openai-api-base",
      `${bridgeUrl}/v1`,
      "--openai-api-key",
      token,
      "--no-auto-commits",
      "--no-auto-lint",
      "--no-auto-test",
      "--no-suggest-shell-commands",
      "--analytics-disable",
      "--no-stream",
      "--yes-always",
      "--no-check-update",
    ];

    if (mode === "plan") {
      args.push("--architect", "--auto-accept-architect");
    }

    return args;
  }

  #buildAiderEnv(token) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/(API_KEY|ACCESS_TOKEN|SECRET|OPENROUTER|GROQ|ANTHROPIC|AZURE_OPENAI|GOOGLE|VERTEX)/i.test(key)) {
        delete env[key];
      }
    }

    return {
      ...env,
      AIDER_ANALYTICS_DISABLE: "true",
      AIDER_CHECK_UPDATE: "false",
      OPENAI_API_KEY: token,
    };
  }

  async #collectFiles(rootPath) {
    const files = new Map();

    async function walk(currentPath) {
      const entries = await fsPromises.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(currentPath, entry.name);
        const relativePath = path.relative(rootPath, absolutePath);
        const normalized = normalizeRelativePath(relativePath);

        if (entry.isDirectory()) {
          if (DEFAULT_EXCLUDED_NAMES.has(entry.name) || isSensitiveRelativePath(normalized)) {
            continue;
          }
          await walk(absolutePath);
          continue;
        }

        if (!entry.isFile() || isSensitiveRelativePath(normalized)) {
          continue;
        }

        files.set(normalized, absolutePath);
      }
    }

    await walk(rootPath);
    return files;
  }

  async #readTextForPreview(filePath) {
    const buffer = await fsPromises.readFile(filePath);
    if (!isProbablyText(buffer)) {
      throw new Error(`Aider changed a binary or oversized file that cannot be safely reviewed: ${filePath}`);
    }

    return buffer.toString("utf8");
  }

  async #collectChanges(workspaceRoot, sandboxRoot) {
    const [realFiles, sandboxFiles] = await Promise.all([
      this.#collectFiles(workspaceRoot),
      this.#collectFiles(sandboxRoot),
    ]);
    const paths = new Set([...realFiles.keys(), ...sandboxFiles.keys()]);
    const changes = [];

    for (const relativePath of [...paths].sort()) {
      if (isSensitiveRelativePath(relativePath)) {
        continue;
      }

      const realPath = realFiles.get(relativePath);
      const sandboxPath = sandboxFiles.get(relativePath);

      if (realPath && sandboxPath) {
        const [realBuffer, sandboxBuffer] = await Promise.all([fsPromises.readFile(realPath), fsPromises.readFile(sandboxPath)]);
        if (realBuffer.equals(sandboxBuffer)) {
          continue;
        }

        if (!isProbablyText(realBuffer) || !isProbablyText(sandboxBuffer)) {
          throw new Error(`Aider changed a binary or oversized file that cannot be safely reviewed: ${relativePath}`);
        }

        const originalContent = realBuffer.toString("utf8");
        const nextContent = sandboxBuffer.toString("utf8");
        changes.push({
          path: relativePath,
          changeType: "update",
          originalContent,
          nextContent,
          stats: summarizeFileChange(originalContent, nextContent),
        });
        continue;
      }

      if (!realPath && sandboxPath) {
        const nextContent = await this.#readTextForPreview(sandboxPath);
        changes.push({
          path: relativePath,
          changeType: "create",
          originalContent: "",
          nextContent,
          stats: summarizeFileChange("", nextContent),
        });
        continue;
      }

      if (realPath && !sandboxPath) {
        const originalContent = await this.#readTextForPreview(realPath);
        changes.push({
          path: relativePath,
          changeType: "delete",
          originalContent,
          nextContent: "",
          stats: summarizeFileChange(originalContent, ""),
        });
      }
    }

    if (changes.length > MAX_AGENT_CHANGED_FILES) {
      throw new Error(`Aider changed ${changes.length} files. Narrow the request before applying changes.`);
    }

    return changes;
  }

  async #readUtf8IfPresent(filePath) {
    try {
      return await fsPromises.readFile(filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async #applyChanges(workspaceRoot, changes) {
    const applied = [];

    for (const change of changes) {
      const targetPath = path.resolve(workspaceRoot, change.path);
      if (!isInsideRoot(targetPath, workspaceRoot) || isSensitiveRelativePath(change.path)) {
        throw new Error(`Blocked unsafe agent change: ${change.path}`);
      }

      const currentContent = await this.#readUtf8IfPresent(targetPath);
      if (change.changeType === "create" && currentContent !== null) {
        throw new Error(`${change.path} was created after approval was requested. Ask the agent to refresh and try again.`);
      }

      if (change.changeType !== "create" && currentContent !== change.originalContent) {
        throw new Error(`${change.path} changed after approval was requested. Ask the agent to refresh and try again.`);
      }

      if (change.changeType === "delete") {
        await fsPromises.rm(targetPath, { recursive: false, force: false });
      } else {
        await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
        await fsPromises.writeFile(targetPath, change.nextContent, "utf8");
        this.addRecentFile(targetPath);
      }

      applied.push({
        path: change.path,
        changeType: change.changeType,
        content: change.changeType === "delete" ? null : change.nextContent,
      });
    }

    return applied;
  }
}

module.exports = {
  AgentRuntimeManager,
};

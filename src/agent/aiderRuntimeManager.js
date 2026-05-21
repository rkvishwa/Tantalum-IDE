const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");
const {
  AIDER_ASK_ENGINE,
  AIDER_EDIT_ENGINE,
  DIRECT_LLM_ENGINE,
  LOCAL_ENGINE,
  normalizePendingAction,
  routeAgentPrompt,
} = require("./agentRouter");

const DEFAULT_EXCLUDED_NAMES = new Set([
  ".aider.chat.history.md",
  ".aider.input.history",
  ".aider.llm.history",
  ".aider.tags.cache",
  ".aider.tags.cache.v1",
  ".aider.tags.cache.v2",
  ".aider.tags.cache.v3",
  ".aider.tags.cache.v4",
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

const AGENT_ARTIFACT_PATTERNS = [
  /^\.aider\.tags\.cache(?:\.v\d+)?$/i,
  /^\.aider\.repo\.map$/i,
];

const AIDER_GITIGNORE_LINES = new Set([
  ".aider*",
  ".aider.chat.history.md",
  ".aider.input.history",
  ".aider.llm.history",
  ".aider.repo.map",
  ".aider.tags.cache*",
]);

const MAX_AGENT_CHANGED_FILES = 50;
const MAX_TEXT_PREVIEW_BYTES = 1_500_000;
const AGENT_STOPPED_ERROR_CODE = "AGENT_RUN_STOPPED";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RESUMABLE_PENDING_STATUSES = new Set(["pending", "blocked"]);
const PROJECT_STRUCTURE_HINT = /\b(project structure|folder structure|repo structure|repository structure|workspace structure|directory structure)\b/i;
const CONFIRMATION_ONLY_OUTPUT = [
  /\bplease confirm\b/i,
  /\bconfirm if\b/i,
  /\bif you want me to proceed\b/i,
  /\bwould you like me to\b/i,
  /\blet me know if\b/i,
  /\bplease provide\b/i,
  /\bonce confirmed\b/i,
];

function createAgentStoppedError() {
  const error = new Error("Agent run stopped.");
  error.code = AGENT_STOPPED_ERROR_CODE;
  return error;
}

function isAgentStoppedError(error) {
  return error?.code === AGENT_STOPPED_ERROR_CODE || error?.message === "Agent run stopped.";
}

function throwIfAgentStopped(signal) {
  if (signal?.aborted) {
    throw createAgentStoppedError();
  }
}

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

function isIgnoredAgentArtifact(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  return parts.some((part) => DEFAULT_EXCLUDED_NAMES.has(part) || AGENT_ARTIFACT_PATTERNS.some((pattern) => pattern.test(part)));
}

function shouldCopyWorkspacePath(workspaceRoot, sourcePath) {
  const relativePath = path.relative(workspaceRoot, sourcePath);
  if (!relativePath) {
    return true;
  }

  if (isIgnoredAgentArtifact(relativePath)) {
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

function validateUtf8TextBuffer(buffer) {
  if (buffer.length > MAX_TEXT_PREVIEW_BYTES) {
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

function skippedFile(relativePath, reason, sizeBytes = 0) {
  return {
    path: normalizeRelativePath(relativePath),
    reason,
    sizeBytes,
  };
}

function stripAiderGitignoreLines(content) {
  return String(content ?? "")
    .split(/\r?\n/)
    .filter((line) => !AIDER_GITIGNORE_LINES.has(line.trim()))
    .join("\n")
    .trimEnd();
}

function isCasualGreetingPrompt(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");

  return /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay)$/.test(normalized);
}

function buildCasualGreetingResponse(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.startsWith("thank")) {
    return "You got it. What would you like to work on next?";
  }

  if (normalized === "ok" || normalized === "okay") {
    return "Ready when you are. Tell me what you want to inspect, explain, or change.";
  }

  return "Hello! What would you like to work on in this workspace?";
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function redactSandboxPaths(value) {
  return String(value || "")
    .replace(/[A-Za-z]:\\[^\r\n]*?\\Temp\\tantalum-aider-[^\\\s]+\\workspace\\?/gi, "")
    .replace(/\/tmp\/tantalum-aider-[^\s/]+\/workspace\/?/g, "")
    .replace(/\/var\/folders\/[^\r\n]*?\/T\/tantalum-aider-[^\s/]+\/workspace\/?/g, "");
}

function cleanAiderOutput(value) {
  const lines = redactSandboxPaths(stripAnsi(value))
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
  const noisePatterns = [
    /^Analytics have been permanently disabled\./i,
    /^Can't initialize prompt toolkit:/i,
    /^Terminal does not support pretty output/i,
    /^Added \.aider\* to \.gitignore/i,
    /^Git repository created in /i,
    /^Aider v[\d.]+/i,
    /^Model:/i,
    /^Git repo:/i,
    /^Repo-map:/i,
    /^Scanning repo:/i,
    /^Tokens:/i,
    /^Cost:/i,
    /^(cmd(?:\.exe)?\?\s*)+$/i,
  ];

  return lines
    .filter((line) => !noisePatterns.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function createTaskId(prefix = "task") {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function cloneTaskList(taskList) {
  return {
    ...taskList,
    items: taskList.items.map((item) => ({ ...item })),
  };
}

function normalizeTaskStatus(value) {
  return ["pending", "running", "completed", "blocked", "skipped"].includes(value) ? value : "pending";
}

function normalizeTaskList(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) {
    return null;
  }

  const id = String(value.id || "").trim();
  if (!id) {
    return null;
  }

  const items = value.items
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: String(item.id || `task-${index + 1}`),
      title: String(item.title || "Run workspace task").slice(0, 120),
      status: normalizeTaskStatus(item.status),
      kind: String(item.kind || "aider_edit"),
      targetPath: item.targetPath ? normalizeRelativePath(item.targetPath) : undefined,
      result: item.result ? String(item.result).slice(0, 180) : undefined,
      error: item.error ? String(item.error).slice(0, 180) : undefined,
    }));

  if (items.length === 0) {
    return null;
  }

  return {
    id,
    actionId: value.actionId ? String(value.actionId) : null,
    items,
    createdAt: String(value.createdAt || new Date().toISOString()),
    updatedAt: String(value.updatedAt || new Date().toISOString()),
  };
}

function updateTaskStatus(taskList, taskId, status, patch = {}) {
  const now = new Date().toISOString();
  return {
    ...taskList,
    updatedAt: now,
    items: taskList.items.map((item) =>
      item.id === taskId
        ? {
            ...item,
            status,
            ...patch,
          }
        : item,
    ),
  };
}

function normalizeFilePhrase(value) {
  let phrase = String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\bmarkdown\b/i, "md")
    .replace(/\btypescript\b/i, "ts")
    .replace(/\bjavascript\b/i, "js");

  phrase = phrase.replace(/\b([A-Za-z0-9_.-]+)\s+(md|js|ts|tsx|jsx|json|css|html|txt|yml|yaml|toml|py)\b/i, "$1.$2");
  return normalizeRelativePath(phrase.replace(/\s+/g, ""));
}

function levenshteinDistance(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let index = 0; index <= a.length; index += 1) {
    dp[index][0] = index;
  }
  for (let index = 0; index <= b.length; index += 1) {
    dp[0][index] = index;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[a.length][b.length];
}

function extractTargetBeforeFile(segment, verbPattern) {
  const match = segment.match(verbPattern);
  if (!match?.[1]) {
    return null;
  }

  return normalizeFilePhrase(match[1].replace(/\b(?:with|containing|for)\b.*$/i, ""));
}

function planAgentTaskList(prompt, actionId = null) {
  const originalPrompt = String(prompt || "").trim();
  const now = new Date().toISOString();
  const segments = originalPrompt
    .split(/\s+(?:and then|and|then|also)\s+/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const items = [];

  for (const segment of segments) {
    const deleteTarget = extractTargetBeforeFile(segment, /\b(?:delete|remove)\s+(?:the\s+)?(.+?)(?:\s+file\b|$)/i);
    if (deleteTarget) {
      items.push({
        id: createTaskId("delete"),
        title: `Delete ${deleteTarget}`,
        status: "pending",
        kind: "delete_file",
        targetPath: deleteTarget,
      });
      continue;
    }

    const createTarget = extractTargetBeforeFile(segment, /\b(?:create|add|write)\s+(?:a\s+|an\s+|the\s+|new\s+)*(.+?)(?:\s+file\b|$)/i);
    if (createTarget) {
      const projectStructure = PROJECT_STRUCTURE_HINT.test(segment) || PROJECT_STRUCTURE_HINT.test(originalPrompt);
      items.push({
        id: createTaskId("create"),
        title: projectStructure ? `Create ${createTarget} with project structure` : `Create ${createTarget}`,
        status: "pending",
        kind: projectStructure ? "create_project_structure_doc" : "create_file",
        targetPath: createTarget,
      });
    }
  }

  if (items.length === 0) {
    items.push({
      id: createTaskId("edit"),
      title: "Apply requested workspace changes",
      status: "pending",
      kind: "aider_edit",
    });
  }

  return {
    id: createTaskId("tasks"),
    actionId,
    items,
    createdAt: now,
    updatedAt: now,
  };
}

function canRunDeterministicTaskList(taskList) {
  return Boolean(taskList?.items?.length) && taskList.items.every((item) => ["delete_file", "create_project_structure_doc"].includes(item.kind));
}

function looksLikeConfirmationOnly(output) {
  const normalized = String(output || "").trim();
  return normalized.length > 0 && CONFIRMATION_ONLY_OUTPUT.some((pattern) => pattern.test(normalized));
}

function commandForPlatform(executablePath) {
  return process.platform === "win32" ? `${executablePath}.exe` : executablePath;
}

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(createAgentStoppedError());
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    });
    child.stdin?.end();

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs || 120000;

    const stopChild = () => {
      try {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      } catch {}
    };

    const settle = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      callback();
    };

    const handleAbort = () => {
      stopChild();
      settle(() => reject(createAgentStoppedError()));
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      stopChild();
      settle(() => reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)));
    }, timeoutMs);

    signal?.addEventListener("abort", handleAbort, { once: true });

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

      settle(() => reject(error));
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settle(() => resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : -1,
        signal: signal ?? null,
        stdout,
        stderr,
        output: [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : ""),
      }));
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

      const supportedPath =
        url.pathname === "/v1/chat/completions" ||
        url.pathname === "/v1/responses" ||
        url.pathname === "/v1/completions";

      if (request.method !== "POST" || !supportedPath) {
        this.#send(response, 404, { error: { message: "Unsupported local agent bridge route." } });
        return;
      }

      const body = await this.#readJsonBody(request);
      const completion = await this.executeGatewayRequest({
        source: this.source,
        mode: this.mode,
        customCredentialId: this.customCredentialId,
        customModelName: this.customModelName,
        apiPath: url.pathname,
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

function clampForPrompt(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n[Content truncated.]`;
}

function extractAssistantText(completion) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const chatContent = choice?.message?.content;
  if (typeof chatContent === "string" && chatContent.trim()) {
    return chatContent.trim();
  }

  if (Array.isArray(chatContent)) {
    const text = chatContent
      .map((part) => (typeof part?.text === "string" ? part.text : typeof part === "string" ? part : ""))
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  if (typeof choice?.text === "string" && choice.text.trim()) {
    return choice.text.trim();
  }

  if (typeof completion?.output_text === "string" && completion.output_text.trim()) {
    return completion.output_text.trim();
  }

  return "";
}

class AgentRuntimeManager {
  constructor(options) {
    this.app = options.app;
    this.getWorkspaceRoot = options.getWorkspaceRoot;
    this.executeGatewayRequest = options.executeGatewayRequest;
    this.securityManager = options.securityManager;
    this.markWorkspaceDirty = options.markWorkspaceDirty;
    this.addRecentFile = options.addRecentFile;
    this.emitProgress = typeof options.emitProgress === "function" ? options.emitProgress : () => {};
    this.activeRuns = new Map();
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

  async route(payload = {}) {
    const prompt = String(payload.prompt || "").trim();
    const route = routeAgentPrompt({ ...payload, prompt });
    if (route.engine !== AIDER_EDIT_ENGINE) {
      return route;
    }

    const pendingAction = normalizePendingAction(route.pendingAction || payload.pendingAction);
    const taskList = normalizeTaskList(payload.taskList) || planAgentTaskList(pendingAction?.originalPrompt || prompt, pendingAction?.id || null);
    const workspaceRoot = this.getWorkspaceRoot();
    const checkedTaskList = workspaceRoot ? await this.#resolveTaskTargets(workspaceRoot, taskList) : taskList;
    const blockedTask = checkedTaskList.items.find((item) => item.status === "blocked");

    if (blockedTask && route.requiresUserDecision) {
      return {
        ...route,
        engine: LOCAL_ENGINE,
        reason: "clarify_destructive_target",
        confidence: 0.94,
        userMessage: blockedTask.error || "I need a clearer file target before changing the workspace.",
        requiresUserDecision: true,
        decisionKind: "clarify",
        taskList: checkedTaskList,
      };
    }

    return {
      ...route,
      taskList: checkedTaskList,
    };
  }

  async run(payload = {}) {
    const approvedActionId = String(payload.approvedActionId || "").trim();
    const approvedPendingAction = approvedActionId ? normalizePendingAction(payload.pendingAction) : null;
    if (approvedActionId) {
      if (!approvedPendingAction || approvedPendingAction.id !== approvedActionId) {
        throw new Error("That pending agent action is stale or no longer available.");
      }

      if (!RESUMABLE_PENDING_STATUSES.has(approvedPendingAction.status)) {
        throw new Error("That pending agent action has already been used.");
      }
    }

    const prompt = approvedPendingAction?.originalPrompt || String(payload.prompt || "").trim();
    if (!prompt) {
      throw new Error("Enter a prompt before starting the agent.");
    }

    const route = await this.route({
      ...payload,
      prompt: approvedPendingAction ? "proceed" : prompt,
      pendingAction: approvedPendingAction || payload.pendingAction || null,
    });
    const taskList = normalizeTaskList(route.taskList || payload.taskList) || planAgentTaskList(prompt, approvedPendingAction?.id || route.pendingAction?.id || null);
    if (route.engine === LOCAL_ENGINE) {
      return {
        output: route.userMessage || "Tell me what you want to inspect, explain, or change.",
        changedFiles: [],
        requiresApproval: false,
        route,
        engine: route.engine,
        diagnostics: [],
        skippedFiles: [],
        reviewMode: "none",
        taskList: route.taskList || taskList,
        stages: [{ name: "routing", status: "completed", message: route.reason }],
      };
    }

    if (route.requiresUserDecision) {
      return {
        output: route.userMessage || "Approve this workspace action before I run it.",
        changedFiles: [],
        requiresApproval: true,
        route,
        engine: route.engine,
        diagnostics: [],
        skippedFiles: [],
        reviewMode: "none",
        taskList: route.taskList || taskList,
        stages: [{ name: "routing", status: "completed", message: route.reason }],
      };
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot && route.engine !== DIRECT_LLM_ENGINE) {
      throw new Error("Open a workspace before starting the agent.");
    }

    if (workspaceRoot && [...this.activeRuns.values()].some((run) => run.workspaceRoot === workspaceRoot)) {
      throw new Error("An agent run is already active for this workspace.");
    }

    const threadId = String(payload.threadId || "").trim() || null;
    const runKey = this.#activeRunKey(workspaceRoot || "no-workspace", threadId);
    const controller = new AbortController();
    this.activeRuns.set(runKey, {
      workspaceRoot: workspaceRoot || "no-workspace",
      threadId,
      controller,
    });

    let sandboxParent = null;
    let bridge = null;

    try {
      const signal = controller.signal;
      throwIfAgentStopped(signal);

      if (route.engine === DIRECT_LLM_ENGINE) {
        return await this.#runDirectLlm({ ...payload, prompt }, route, signal);
      }

      sandboxParent = await fsPromises.mkdtemp(path.join(os.tmpdir(), "tantalum-aider-"));
      const sandboxRoot = path.join(sandboxParent, "workspace");
      throwIfAgentStopped(signal);
      const copyResult = await this.#copyWorkspace(workspaceRoot, sandboxRoot, signal);
      const skippedPaths = new Set(copyResult.skippedFiles.map((file) => normalizeRelativePath(file.path)));
      throwIfAgentStopped(signal);
      await this.#applyActiveTabSnapshot(workspaceRoot, sandboxRoot, payload.activeTab);
      throwIfAgentStopped(signal);
      await this.#prepareSandboxGit(sandboxRoot, signal);
      throwIfAgentStopped(signal);

      const intent = route.engine === AIDER_ASK_ENGINE ? "ask" : "agent";
      let activeTaskList = await this.#resolveTaskTargets(workspaceRoot, cloneTaskList(taskList));
      const actionId = approvedPendingAction?.id || route.pendingAction?.id || activeTaskList.actionId || null;
      activeTaskList = { ...activeTaskList, actionId };
      this.#emitAgentProgress(threadId, actionId, activeTaskList, "running");

      let output = "";
      let changes = [];
      let result = { exitCode: 0 };

      if (intent !== "ask" && canRunDeterministicTaskList(activeTaskList)) {
        const deterministic = await this.#executeDeterministicTasks({
          workspaceRoot,
          sandboxRoot,
          taskList: activeTaskList,
          threadId,
          actionId,
          signal,
        });
        activeTaskList = deterministic.taskList;
        output = deterministic.output;
        changes = await this.#collectChanges(workspaceRoot, sandboxRoot, skippedPaths);
      } else {
        activeTaskList = this.#markFirstRunnableTask(activeTaskList, "running");
        this.#emitAgentProgress(threadId, actionId, activeTaskList, "running");
        const aiderPath = await this.#ensureAiderInstalled(signal);
        throwIfAgentStopped(signal);

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
        throwIfAgentStopped(signal);

        const metadataPath = path.join(sandboxParent, "model-metadata.json");
        await fsPromises.writeFile(metadataPath, JSON.stringify(this.#buildModelMetadata(payload), null, 2), "utf8");
        throwIfAgentStopped(signal);

        const runAiderOnce = async (messagePrompt, approvalGranted = false) => {
          const messagePath = path.join(sandboxParent, `message-${crypto.randomUUID()}.txt`);
          await fsPromises.writeFile(
            messagePath,
            this.#buildAiderMessage(messagePrompt, payload.activeTab, payload.threadMessages, intent, { approvalGranted }),
            "utf8",
          );
          throwIfAgentStopped(signal);
          const args = this.#buildAiderArgs({
            messagePath,
            metadataPath,
            bridgeUrl,
            token,
            source,
            mode,
            intent,
            customModelName: payload.customModelName,
          });
          return runChild(aiderPath, args, {
            cwd: sandboxRoot,
            env: this.#buildAiderEnv(token),
            timeoutMs: mode === "plan" ? 600000 : 360000,
            signal,
          });
        };

        result = await runAiderOnce(prompt, Boolean(approvedPendingAction));
        throwIfAgentStopped(signal);
        output = cleanAiderOutput(result.output) || result.output || "(Aider produced no terminal output.)";
        changes = intent === "ask" ? [] : await this.#collectChanges(workspaceRoot, sandboxRoot, skippedPaths);

        if (intent !== "ask" && changes.length === 0 && looksLikeConfirmationOnly(output)) {
          result = await runAiderOnce(
            `${prompt}\n\nApproval was already granted in Tantalum IDE. Do not ask for confirmation. Modify the workspace files now and finish the requested task.`,
            true,
          );
          throwIfAgentStopped(signal);
          output = cleanAiderOutput(result.output) || result.output || "(Aider produced no terminal output.)";
          changes = await this.#collectChanges(workspaceRoot, sandboxRoot, skippedPaths);
        }

        if (intent !== "ask") {
          activeTaskList =
            changes.length > 0
              ? this.#markRunnableTasks(activeTaskList, "completed", { result: "Workspace changes prepared." })
              : this.#markRunnableTasks(activeTaskList, "blocked", { error: "No workspace files changed." });
          this.#emitAgentProgress(threadId, actionId, activeTaskList, changes.length > 0 ? "completed" : "blocked");
        }
      }
      throwIfAgentStopped(signal);

      if (result.exitCode !== 0 && changes.length === 0) {
        throw new Error(output || `Aider exited with code ${result.exitCode}.`);
      }

      const blockedTasks = activeTaskList.items.filter((item) => item.status === "blocked");
      if (intent !== "ask" && blockedTasks.length > 0) {
        return {
          output: output || `Blocked ${blockedTasks.length} workspace task${blockedTasks.length === 1 ? "" : "s"}.`,
          changedFiles: [],
          requiresApproval: false,
          route,
          engine: route.engine,
          diagnostics: [],
          skippedFiles: copyResult.skippedFiles,
          reviewMode: "none",
          taskList: activeTaskList,
          actionStatus: "blocked",
          stages: [
            { name: "routing", status: "completed", message: route.reason },
            { name: "preparing_workspace", status: "completed" },
            { name: "running_aider", status: "completed" },
          ],
        };
      }

      if (changes.length === 0) {
        const actionStatus = intent === "ask" ? "executed" : "blocked";
        return {
          output: intent === "ask" ? output : output || "The agent did not change any workspace files, so the action is still blocked.",
          changedFiles: [],
          requiresApproval: false,
          route,
          engine: route.engine,
          diagnostics: [],
          skippedFiles: copyResult.skippedFiles,
          reviewMode: "none",
          taskList: activeTaskList,
          actionStatus,
          stages: [
            { name: "routing", status: "completed", message: route.reason },
            { name: "preparing_workspace", status: "completed" },
            { name: "running_aider", status: "completed" },
          ],
        };
      }

      const applied = await this.#applyChanges(workspaceRoot, changes);
      throwIfAgentStopped(signal);

      return {
        output,
        changedFiles: changes.map((change) => ({
          path: change.path,
          changeType: change.changeType,
          stats: change.stats,
        })),
        requiresApproval: false,
        autoApplied: true,
        diff: changes,
        route,
        engine: route.engine,
        diagnostics: [],
        skippedFiles: copyResult.skippedFiles,
        reviewMode: "live-applied",
        taskList: activeTaskList,
        actionStatus: "executed",
        stages: [
          { name: "routing", status: "completed", message: route.reason },
          { name: "preparing_workspace", status: "completed" },
          { name: "running_aider", status: "completed" },
          { name: "applying_changes", status: "completed" },
        ],
        meta: {
          action: "aider_live_preview",
          files: applied,
          revision: this.markWorkspaceDirty(workspaceRoot),
        },
      };
    } finally {
      if (bridge) {
        await bridge.stop();
      }

      if (sandboxParent) {
        await fsPromises.rm(sandboxParent, { recursive: true, force: true });
      }

      this.activeRuns.delete(runKey);
    }
  }

  stop(payload = {}) {
    const workspaceRoot = this.getWorkspaceRoot();
    const threadId = String(payload.threadId || "").trim();
    if (!workspaceRoot || !threadId) {
      return { stopped: false };
    }

    const run = this.activeRuns.get(this.#activeRunKey(workspaceRoot, threadId));
    if (!run) {
      return { stopped: false };
    }

    run.controller.abort();
    return { stopped: true };
  }

  async resolveApproval(requestId, approved) {
    return this.securityManager.resolveApproval(requestId, approved);
  }

  #activeRunKey(workspaceRoot, threadId) {
    return `${workspaceRoot}\0${threadId || "workspace"}`;
  }

  async #runDirectLlm(payload, route, signal) {
    const source = payload.source === "custom" ? "custom" : "managed";
    const mode = payload.mode === "plan" ? "plan" : "fast";
    const model =
      source === "custom"
        ? String(payload.customModelName || "").trim()
        : mode === "plan"
          ? "openai/tantalum-plan"
          : "openai/tantalum-fast";

    if (!model) {
      throw new Error("Choose a model before starting Tantalum AI.");
    }

    throwIfAgentStopped(signal);
    const completion = await this.executeGatewayRequest({
      source,
      mode,
      customCredentialId: payload.customCredentialId || null,
      customModelName: payload.customModelName || null,
      apiPath: "/v1/chat/completions",
      request: {
        model,
        messages: this.#buildDirectMessages(payload),
        temperature: 0.2,
        stream: false,
      },
    });
    throwIfAgentStopped(signal);

    return {
      output: extractAssistantText(completion) || "I could not produce a response from the selected model.",
      changedFiles: [],
      requiresApproval: false,
      route,
      engine: route.engine,
      diagnostics: [],
      skippedFiles: [],
      reviewMode: "none",
      stages: [
        { name: "routing", status: "completed", message: route.reason },
        { name: "running_direct_llm", status: "completed" },
      ],
    };
  }

  #buildDirectMessages(payload = {}) {
    const messages = [
      {
        role: "system",
        content:
          "You are Tantalum AI inside Tantalum IDE. Answer directly and concisely. Do not claim to have scanned the full repository unless repository context is explicitly included. Do not propose file edits as already done.",
      },
    ];

    const safeThreadMessages = Array.isArray(payload.threadMessages)
      ? payload.threadMessages
          .filter((message) => message && typeof message.content === "string" && message.content.trim())
          .slice(-8)
      : [];

    for (const message of safeThreadMessages) {
      const role = message.role === "assistant" ? "assistant" : "user";
      messages.push({
        role,
        content: clampForPrompt(message.content, 4000),
      });
    }

    const userParts = [String(payload.prompt || "").trim()];
    if (payload.activeTab?.path && typeof payload.activeTab.content === "string") {
      userParts.push(
        "",
        "Active editor context:",
        `File: ${payload.activeTab.path}`,
        `Display name: ${payload.activeTab.name || path.basename(payload.activeTab.path)}`,
        `Unsaved changes: ${payload.activeTab.isDirty ? "yes" : "no"}`,
        "",
        "Active file content:",
        clampForPrompt(payload.activeTab.content, 16000),
      );
    }

    messages.push({
      role: "user",
      content: userParts.join("\n"),
    });

    return messages;
  }

  #emitAgentProgress(threadId, actionId, taskList, stage) {
    if (!threadId || !taskList) {
      return;
    }

    this.emitProgress({
      threadId,
      actionId: actionId || null,
      stage,
      taskList,
      createdAt: new Date().toISOString(),
    });
  }

  #markFirstRunnableTask(taskList, status, patch = {}) {
    const next = cloneTaskList(taskList);
    const item = next.items.find((entry) => entry.status === "pending" || entry.status === "blocked");
    if (!item) {
      return next;
    }

    return updateTaskStatus(next, item.id, status, patch);
  }

  #markRunnableTasks(taskList, status, patch = {}) {
    const now = new Date().toISOString();
    return {
      ...taskList,
      updatedAt: now,
      items: taskList.items.map((item) =>
        item.status === "skipped"
          ? item
          : {
              ...item,
              status,
              ...patch,
            },
      ),
    };
  }

  async #resolveTaskTargets(workspaceRoot, taskList) {
    const next = cloneTaskList(taskList);

    for (const item of next.items) {
      if (!item.targetPath) {
        continue;
      }

      if (isSensitiveRelativePath(item.targetPath) || path.isAbsolute(item.targetPath) || item.targetPath.startsWith("..")) {
        item.status = "blocked";
        item.error = `Unsafe target path: ${item.targetPath}`;
        continue;
      }

      if (item.kind !== "delete_file") {
        continue;
      }

      const resolved = await this.#resolveWorkspaceFileTarget(workspaceRoot, item.targetPath);
      if (resolved.status === "ok") {
        item.targetPath = resolved.path;
        continue;
      }

      item.status = "blocked";
      item.error =
        resolved.status === "ambiguous"
          ? `I found multiple files named ${item.targetPath}: ${resolved.candidates.slice(0, 5).join(", ")}. Please name the exact path.`
          : `I could not find ${item.targetPath} in this workspace. Please name the exact file to delete.`;
    }

    next.updatedAt = new Date().toISOString();
    return next;
  }

  async #resolveWorkspaceFileTarget(workspaceRoot, relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const exactPath = path.resolve(workspaceRoot, normalized);
    if (isInsideRoot(exactPath, workspaceRoot)) {
      try {
        const stat = await fsPromises.stat(exactPath);
        if (stat.isFile()) {
          return { status: "ok", path: normalized };
        }
      } catch {
        // Fall through to basename lookup.
      }
    }

    const basename = path.basename(normalized).toLowerCase();
    const files = await this.#collectFiles(workspaceRoot);
    const candidates = [...files.keys()].filter((candidate) => path.basename(candidate).toLowerCase() === basename);
    if (candidates.length === 1) {
      return { status: "ok", path: candidates[0] };
    }

    if (candidates.length > 1) {
      return { status: "ambiguous", candidates };
    }

    const requestedExtension = path.extname(normalized).toLowerCase();
    const requestedStem = path.basename(normalized, requestedExtension).toLowerCase();
    const fuzzyCandidates = [...files.keys()].filter((candidate) => {
      const candidateExtension = path.extname(candidate).toLowerCase();
      if (requestedExtension && candidateExtension !== requestedExtension) {
        return false;
      }

      const candidateStem = path.basename(candidate, candidateExtension).toLowerCase();
      return levenshteinDistance(candidateStem, requestedStem) <= 2;
    });

    if (fuzzyCandidates.length === 1) {
      return { status: "ok", path: fuzzyCandidates[0] };
    }

    if (fuzzyCandidates.length > 1) {
      return { status: "ambiguous", candidates: fuzzyCandidates };
    }

    return { status: "missing", candidates: [] };
  }

  async #executeDeterministicTasks({ workspaceRoot, sandboxRoot, taskList, threadId, actionId, signal }) {
    let nextTaskList = cloneTaskList(taskList);

    for (const item of taskList.items) {
      throwIfAgentStopped(signal);
      if (item.status === "skipped") {
        continue;
      }

      nextTaskList = updateTaskStatus(nextTaskList, item.id, "running");
      this.#emitAgentProgress(threadId, actionId, nextTaskList, "running");

      try {
        const targetPath = item.targetPath ? path.resolve(sandboxRoot, item.targetPath) : null;
        if (!targetPath || !isInsideRoot(targetPath, sandboxRoot) || isSensitiveRelativePath(item.targetPath)) {
          throw new Error(`Unsafe target path: ${item.targetPath || "(missing)"}`);
        }

        if (item.kind === "delete_file") {
          const stat = await fsPromises.stat(targetPath);
          if (!stat.isFile()) {
            throw new Error(`${item.targetPath} is not a file.`);
          }

          await fsPromises.rm(targetPath, { force: false });
          nextTaskList = updateTaskStatus(nextTaskList, item.id, "completed", { result: `Deleted ${item.targetPath}.` });
        } else if (item.kind === "create_project_structure_doc") {
          const content = await this.#buildProjectStructureMarkdown(workspaceRoot, sandboxRoot);
          await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
          await fsPromises.writeFile(targetPath, content, "utf8");
          nextTaskList = updateTaskStatus(nextTaskList, item.id, "completed", { result: `Created ${item.targetPath}.` });
        } else {
          throw new Error(`Unsupported deterministic task: ${item.kind}`);
        }
      } catch (error) {
        nextTaskList = updateTaskStatus(nextTaskList, item.id, "blocked", {
          error: error instanceof Error ? error.message : "Task failed.",
        });
      }

      this.#emitAgentProgress(threadId, actionId, nextTaskList, "running");
    }

    const blocked = nextTaskList.items.filter((item) => item.status === "blocked");
    const completed = nextTaskList.items.filter((item) => item.status === "completed");
    const output =
      blocked.length > 0
        ? `Blocked ${blocked.length} task${blocked.length === 1 ? "" : "s"}: ${blocked.map((item) => item.error || item.title).join("; ")}`
        : `Completed ${completed.length} workspace task${completed.length === 1 ? "" : "s"}.`;
    this.#emitAgentProgress(threadId, actionId, nextTaskList, blocked.length > 0 ? "blocked" : "completed");

    return {
      taskList: nextTaskList,
      output,
    };
  }

  async #buildProjectStructureMarkdown(workspaceRoot, sandboxRoot) {
    const lines = ["# Project Structure", ""];
    const entries = [];

    const walk = async (currentPath, depth) => {
      if (depth > 2) {
        return;
      }

      const dirEntries = await fsPromises.readdir(currentPath, { withFileTypes: true });
      for (const entry of dirEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        const absolutePath = path.join(currentPath, entry.name);
        const relativePath = normalizeRelativePath(path.relative(sandboxRoot, absolutePath));
        if (!relativePath || isIgnoredAgentArtifact(relativePath) || isSensitiveRelativePath(relativePath)) {
          continue;
        }

        entries.push({ relativePath, isDirectory: entry.isDirectory(), depth });
        if (entry.isDirectory()) {
          await walk(absolutePath, depth + 1);
        }
      }
    };

    await walk(sandboxRoot, 0);
    if (entries.length === 0) {
      lines.push("The workspace is currently empty.");
      return `${lines.join("\n")}\n`;
    }

    for (const entry of entries.slice(0, 250)) {
      const indent = "  ".repeat(entry.depth);
      lines.push(`${indent}- \`${entry.relativePath}${entry.isDirectory ? "/" : ""}\``);
    }

    if (entries.length > 250) {
      lines.push("", `Showing the first 250 entries from ${path.basename(workspaceRoot)}.`);
    }

    return `${lines.join("\n")}\n`;
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

  async #ensureAiderInstalled(signal) {
    const runtime = this.#runtimePaths();
    if (fs.existsSync(runtime.aiderPath)) {
      return runtime.aiderPath;
    }

    throwIfAgentStopped(signal);
    await fsPromises.mkdir(path.dirname(runtime.runtimeDir), { recursive: true });
    const python = await this.#findPython(signal);
    await runChild(python.command, [...python.args, "-m", "venv", runtime.runtimeDir], { timeoutMs: 180000, signal });
    await runChild(runtime.pythonPath, ["-m", "pip", "install", "--upgrade", "pip"], { timeoutMs: 180000, signal });
    await runChild(runtime.pythonPath, ["-m", "pip", "install", "--upgrade", "aider-chat"], { timeoutMs: 600000, signal });

    if (!fs.existsSync(runtime.aiderPath)) {
      throw new Error("Aider installed, but the executable was not found in the app data runtime.");
    }

    return runtime.aiderPath;
  }

  async #findPython(signal) {
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
        const result = await runChild(candidate.command, [...candidate.args, "--version"], { timeoutMs: 15000, signal });
        if (result.exitCode === 0) {
          return candidate;
        }
      } catch (error) {
        if (isAgentStoppedError(error)) {
          throw error;
        }
        // Try the next Python launcher.
      }
    }

    throw new Error("Python 3 is required to install Aider, but no Python launcher was found.");
  }

  async #copyWorkspace(workspaceRoot, sandboxRoot, signal) {
    const skippedFiles = [];
    await fsPromises.mkdir(sandboxRoot, { recursive: true });

    const walk = async (currentPath) => {
      throwIfAgentStopped(signal);
      const entries = await fsPromises.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        throwIfAgentStopped(signal);
        const sourcePath = path.join(currentPath, entry.name);
        const relativePath = normalizeRelativePath(path.relative(workspaceRoot, sourcePath));
        const sandboxPath = path.join(sandboxRoot, relativePath);

        if (entry.isDirectory()) {
          if (isIgnoredAgentArtifact(relativePath) || isSensitiveRelativePath(relativePath)) {
            continue;
          }

          await fsPromises.mkdir(sandboxPath, { recursive: true });
          await walk(sourcePath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        if (isIgnoredAgentArtifact(relativePath) || isSensitiveRelativePath(relativePath)) {
          skippedFiles.push(skippedFile(relativePath, "excluded"));
          continue;
        }

        try {
          const buffer = await fsPromises.readFile(sourcePath);
          const validation = validateUtf8TextBuffer(buffer);
          if (!validation.ok) {
            skippedFiles.push(skippedFile(relativePath, validation.reason, buffer.length));
            continue;
          }

          await fsPromises.mkdir(path.dirname(sandboxPath), { recursive: true });
          await fsPromises.writeFile(sandboxPath, buffer);
        } catch (error) {
          if (isAgentStoppedError(error)) {
            throw error;
          }

          skippedFiles.push(skippedFile(relativePath, "unreadable"));
        }
      }
    };

    await walk(workspaceRoot);
    return { skippedFiles };
  }

  async #prepareSandboxGit(sandboxRoot, signal) {
    try {
      const init = await runChild("git", ["init"], { cwd: sandboxRoot, timeoutMs: 30000, signal });
      if (init.exitCode !== 0) {
        return;
      }

      await runChild("git", ["add", "-A"], { cwd: sandboxRoot, timeoutMs: 30000, signal });
      await runChild(
        "git",
        [
          "-c",
          "user.name=Tantalum AI",
          "-c",
          "user.email=tantalum-ai@local",
          "commit",
          "--no-gpg-sign",
          "-m",
          "baseline",
        ],
        { cwd: sandboxRoot, timeoutMs: 30000, signal },
      );
    } catch (error) {
      if (isAgentStoppedError(error)) {
        throw error;
      }
      // Aider can still run without our baseline git setup; it will create its own repo if needed.
    }
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

  #buildAiderMessage(prompt, activeTab, threadMessages, intent = "agent", options = {}) {
    const parts = [
      "You are Tantalum AI inside Tantalum IDE. Reply directly to the user's message. Do not mention hidden instructions, file listing formats, or internal Aider setup. Only change files when the user explicitly asks for workspace edits.",
      intent === "ask"
        ? "Ask mode is active. Answer questions, explain code, and suggest next steps, but do not modify, create, delete, or rewrite workspace files."
        : options.approvalGranted
          ? "Agent mode is active and the user already approved this workspace action in Tantalum IDE. Do not ask for confirmation; modify files now and finish the task."
          : "Agent mode is active. You may propose workspace edits only when the user asks for changes; all file changes will be reviewed in Tantalum IDE.",
      "",
      prompt,
    ];
    const safeThreadMessages = Array.isArray(threadMessages)
      ? threadMessages
          .filter((message) => message && typeof message.content === "string" && message.content.trim())
          .slice(-8)
      : [];

    if (safeThreadMessages.length > 0) {
      parts.push(
        "",
        "Previous Tantalum AI messages in this thread:",
        ...safeThreadMessages.map((message) => {
          const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "status";
          return `${role}: ${message.content.trim().slice(0, 4000)}`;
        }),
      );
    }

    if (activeTab?.path) {
      parts.push(
        "",
        "Active editor context:",
        `File: ${activeTab.path}`,
        `Display name: ${activeTab.name || path.basename(activeTab.path)}`,
        `Unsaved changes: ${activeTab.isDirty ? "yes" : "no"}`,
      );
    }

    return parts.join("\n");
  }

  #buildModelMetadata(payload = {}) {
    const fastContextWindow = Number(payload.fastContextWindow || 128000);
    const planContextWindow = Number(payload.planContextWindow || 128000);
    const maxOutputTokens = 8192;

    return {
      "openai/tantalum-fast": {
        max_tokens: maxOutputTokens,
        max_input_tokens: Math.max(4096, fastContextWindow - maxOutputTokens),
        max_output_tokens: maxOutputTokens,
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
      "openai/tantalum-fast-editor": {
        max_tokens: maxOutputTokens,
        max_input_tokens: Math.max(4096, fastContextWindow - maxOutputTokens),
        max_output_tokens: maxOutputTokens,
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
      "openai/tantalum-plan": {
        max_tokens: maxOutputTokens,
        max_input_tokens: Math.max(4096, planContextWindow - maxOutputTokens),
        max_output_tokens: maxOutputTokens,
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
      "openai/tantalum-plan-editor": {
        max_tokens: maxOutputTokens,
        max_input_tokens: Math.max(4096, fastContextWindow - maxOutputTokens),
        max_output_tokens: maxOutputTokens,
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
    };
  }

  #buildAiderArgs({ messagePath, metadataPath, bridgeUrl, token, source, mode, intent, customModelName }) {
    const model =
      source === "custom"
        ? `openai/${String(customModelName || "").trim()}`
        : mode === "plan"
          ? "openai/tantalum-plan"
          : "openai/tantalum-fast";
    const editorModel = source === "custom" ? model : "openai/tantalum-fast-editor";
    const args = [
      "--message-file",
      messagePath,
      "--model",
      model,
      "--editor-model",
      editorModel,
      "--model-metadata-file",
      metadataPath,
      "--map-tokens",
      "2048",
      "--encoding",
      "utf-8",
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

    if (intent === "ask") {
      args.push("--chat-mode", "ask");
    } else if (mode === "plan") {
      args.push("--architect", "--auto-accept-architect", "--reasoning-effort", "medium");
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
          if (isIgnoredAgentArtifact(normalized) || isSensitiveRelativePath(normalized)) {
            continue;
          }
          await walk(absolutePath);
          continue;
        }

        if (!entry.isFile() || isIgnoredAgentArtifact(normalized) || isSensitiveRelativePath(normalized)) {
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
    const validation = validateUtf8TextBuffer(buffer);
    if (!validation.ok) {
      throw new Error(`Aider changed a ${validation.reason} file that cannot be safely reviewed: ${filePath}`);
    }

    return buffer.toString("utf8");
  }

  async #collectChanges(workspaceRoot, sandboxRoot, skippedPaths = new Set()) {
    const [realFiles, sandboxFiles] = await Promise.all([
      this.#collectFiles(workspaceRoot),
      this.#collectFiles(sandboxRoot),
    ]);
    const paths = new Set([...realFiles.keys(), ...sandboxFiles.keys()]);
    const changes = [];

    for (const relativePath of [...paths].sort()) {
      if (skippedPaths.has(normalizeRelativePath(relativePath)) || isIgnoredAgentArtifact(relativePath) || isSensitiveRelativePath(relativePath)) {
        continue;
      }

      const realPath = realFiles.get(relativePath);
      const sandboxPath = sandboxFiles.get(relativePath);

      if (realPath && sandboxPath) {
        const [realBuffer, sandboxBuffer] = await Promise.all([fsPromises.readFile(realPath), fsPromises.readFile(sandboxPath)]);
        if (realBuffer.equals(sandboxBuffer)) {
          continue;
        }

        const realValidation = validateUtf8TextBuffer(realBuffer);
        const sandboxValidation = validateUtf8TextBuffer(sandboxBuffer);
        if (!realValidation.ok || !sandboxValidation.ok) {
          throw new Error(`Aider changed a non-reviewable file (${sandboxValidation.reason || realValidation.reason}): ${relativePath}`);
        }

        const originalContent = realBuffer.toString("utf8");
        const nextContent = sandboxBuffer.toString("utf8");
        if (relativePath === ".gitignore") {
          const cleanOriginalContent = stripAiderGitignoreLines(originalContent);
          const cleanNextContent = stripAiderGitignoreLines(nextContent);
          if (cleanOriginalContent === cleanNextContent) {
            continue;
          }

          changes.push({
            path: relativePath,
            changeType: "update",
            originalContent: cleanOriginalContent,
            nextContent: cleanNextContent,
            stats: summarizeFileChange(cleanOriginalContent, cleanNextContent),
          });
          continue;
        }

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
        let nextContent = await this.#readTextForPreview(sandboxPath);
        if (relativePath === ".gitignore") {
          nextContent = stripAiderGitignoreLines(nextContent);
          if (!nextContent.trim()) {
            continue;
          }
        }

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

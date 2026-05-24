const crypto = require("node:crypto");
const path = require("node:path");

const AGENT_TOOL_ENGINE = "agent_tool";

const TOOL_CATEGORIES = {
  arduino: "Arduino",
  git: "Git",
  web: "Web",
};

const TOOL_DESCRIPTORS = [
  {
    id: "arduino.verify",
    category: "arduino",
    label: "Verify Arduino Sketch",
    description: "Compile the selected Arduino sketch and return Arduino CLI diagnostics.",
    risk: "low",
    approval: "never",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "arduino.upload",
    category: "arduino",
    label: "Upload Arduino Sketch",
    description: "Verify and upload a sketch to a selected local board or cloud board target.",
    risk: "high",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "arduino.library.install",
    category: "arduino",
    label: "Install Arduino Library",
    description: "Install or update a library through the Arduino Library Manager.",
    risk: "medium",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "arduino.platform.install",
    category: "arduino",
    label: "Install Board Platform",
    description: "Install or update an Arduino board platform/core package.",
    risk: "medium",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.status",
    category: "git",
    label: "Git Status",
    description: "Read Git repository status.",
    risk: "low",
    approval: "never",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.diff",
    category: "git",
    label: "Git Diff",
    description: "Read Git diffs for workspace files.",
    risk: "low",
    approval: "never",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.log",
    category: "git",
    label: "Git Log",
    description: "Read recent Git commit history.",
    risk: "low",
    approval: "never",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.stage",
    category: "git",
    label: "Git Stage",
    description: "Stage selected workspace paths.",
    risk: "medium",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.commit",
    category: "git",
    label: "Git Commit",
    description: "Create a Git commit with a user-provided message.",
    risk: "medium",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.branch",
    category: "git",
    label: "Git Branch",
    description: "Create or switch to a Git branch.",
    risk: "medium",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.pull",
    category: "git",
    label: "Git Pull",
    description: "Pull from the current Git upstream.",
    risk: "medium",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.push",
    category: "git",
    label: "Git Push",
    description: "Push commits to the current Git upstream.",
    risk: "medium",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.discard",
    category: "git",
    label: "Git Discard",
    description: "Discard selected Git changes.",
    risk: "high",
    approval: "always",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "git.publish",
    category: "git",
    label: "Git Publish",
    description: "Publish the repository to a configured Git hosting provider.",
    risk: "high",
    approval: "default",
    enabledByDefault: true,
    available: true,
  },
  {
    id: "web.search",
    category: "web",
    label: "Web Search",
    description: "Search the web after a secure provider and result policy are configured.",
    risk: "medium",
    approval: "default",
    enabledByDefault: false,
    available: false,
    unavailableReason: "Web Search is reserved for a future secure provider integration.",
  },
];

const DESCRIPTOR_BY_ID = new Map(TOOL_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

const BUILTIN_ARDUINO_HEADERS = new Set([
  "arduino.h",
  "eeprom.h",
  "esp.h",
  "fs.h",
  "hardwareSerial.h".toLowerCase(),
  "pgmspace.h",
  "spi.h",
  "stdarg.h",
  "stdbool.h",
  "stddef.h",
  "stdint.h",
  "stdlib.h",
  "string.h",
  "wire.h",
]);

function normalizeToolId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRisk(value, fallback = "medium") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(normalized) ? normalized : fallback;
}

function normalizeOrigin(value) {
  return String(value || "").trim().toLowerCase() === "agent" ? "agent" : "user";
}

function normalizeToolArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function normalizeToolRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const toolId = normalizeToolId(value.toolId || value.id);
  if (!toolId || !DESCRIPTOR_BY_ID.has(toolId)) {
    return null;
  }

  const descriptor = DESCRIPTOR_BY_ID.get(toolId);
  const summary = String(value.summary || descriptor.label || toolId).trim().slice(0, 220);
  return {
    requestId: String(value.requestId || crypto.randomUUID()),
    toolId,
    summary,
    risk: normalizeRisk(value.risk, descriptor.risk),
    origin: normalizeOrigin(value.origin),
    arguments: normalizeToolArguments(value.arguments),
    approvalReason: String(value.approvalReason || "").trim().slice(0, 500),
  };
}

function createToolPendingAction(toolRequest, prompt = "") {
  const request = normalizeToolRequest(toolRequest);
  if (!request) {
    throw new Error("A valid tool request is required.");
  }

  const originalPrompt = String(prompt || request.summary || "").trim() || request.summary;
  return {
    id: crypto.randomUUID(),
    threadId: null,
    kind: "tool",
    originalPrompt,
    normalizedPrompt: originalPrompt.toLowerCase(),
    riskLevel: request.risk,
    reason: `tool:${request.toolId}`,
    createdAt: new Date().toISOString(),
    status: "pending",
    toolRequest: request,
  };
}

function createToolTaskList(toolRequest, actionId = null) {
  const request = normalizeToolRequest(toolRequest);
  const now = new Date().toISOString();
  const id = `tool-task-${crypto.randomUUID()}`;
  return {
    id,
    actionId,
    items: [
      {
        id: `tool-${request?.toolId || "request"}`,
        title: request?.summary || "Run IDE tool",
        status: "pending",
        kind: `tool:${request?.toolId || "unknown"}`,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function taskListWithStatus(taskList, status, patch = {}) {
  if (!taskList) {
    return null;
  }

  return {
    ...taskList,
    items: taskList.items.map((item) => ({
      ...item,
      status,
      ...patch,
    })),
    updatedAt: new Date().toISOString(),
  };
}

class AgentToolRegistry {
  constructor(descriptors = TOOL_DESCRIPTORS) {
    this.descriptors = descriptors.map((descriptor) => ({ ...descriptor }));
    this.descriptorById = new Map(this.descriptors.map((descriptor) => [descriptor.id, descriptor]));
  }

  listDescriptors() {
    return this.descriptors.map((descriptor) => ({ ...descriptor }));
  }

  getDescriptor(toolId) {
    return this.descriptorById.get(normalizeToolId(toolId)) || null;
  }

  normalizeSettings(value = {}) {
    const storedTools = value && typeof value === "object" && value.tools && typeof value.tools === "object" ? value.tools : {};
    const tools = {};

    for (const descriptor of this.descriptors) {
      const stored = storedTools[descriptor.id];
      const enabled =
        typeof stored === "boolean"
          ? stored
          : stored && typeof stored === "object" && typeof stored.enabled === "boolean"
            ? stored.enabled
            : descriptor.enabledByDefault;

      tools[descriptor.id] = {
        enabled: descriptor.available === false ? false : Boolean(enabled),
      };
    }

    return {
      tools,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    };
  }

  settingsResponse(value = {}) {
    const settings = this.normalizeSettings(value);
    return {
      descriptors: this.listDescriptors(),
      settings,
      categories: { ...TOOL_CATEGORIES },
    };
  }

  isEnabled(toolId, settings = {}) {
    const descriptor = this.getDescriptor(toolId);
    if (!descriptor || descriptor.available === false) {
      return false;
    }

    const normalized = this.normalizeSettings(settings);
    return normalized.tools[descriptor.id]?.enabled !== false;
  }

  shouldRequireApproval(toolRequest, settings = {}, permissionMode = "default") {
    const request = normalizeToolRequest(toolRequest);
    if (!request) {
      return true;
    }

    const descriptor = this.getDescriptor(request.toolId);
    if (!descriptor) {
      return true;
    }

    if (request.origin === "agent" && (request.toolId === "arduino.library.install" || request.toolId === "arduino.platform.install")) {
      return true;
    }

    if (descriptor.approval === "never") {
      return false;
    }

    if (descriptor.approval === "always") {
      return true;
    }

    return permissionMode !== "bypass";
  }
}

function normalizePrompt(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizePackageName(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+(?:library|lib|package|core|platform)$/i, "")
    .replace(/\s+version\s+[0-9]+(?:\.[0-9A-Za-z_-]+)*$/i, "")
    .replace(/\s+[0-9]+(?:\.[0-9A-Za-z_-]+)+$/i, "")
    .trim();
}

function extractVersion(value) {
  const match = String(value || "").match(/(?:@|\bversion\s+|:)([0-9]+(?:\.[0-9A-Za-z_-]+)+)\b/i);
  return match?.[1] || "";
}

function extractLibraryName(prompt) {
  const text = normalizePrompt(prompt);
  const patterns = [
    /\binstall\s+(?:the\s+)?(?:arduino\s+)?library\s+["'`]?([^"'`,.;]+)["'`]?/i,
    /\binstall\s+["'`]?([^"'`,.;]+?)["'`]?\s+(?:arduino\s+)?(?:library|lib)\b/i,
    /\badd\s+["'`]?([^"'`,.;]+?)["'`]?\s+(?:arduino\s+)?(?:library|lib)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = normalizePackageName(match?.[1]);
    if (name) {
      return name.replace(/@.+$/, "").trim();
    }
  }

  return "";
}

function extractPlatformName(prompt) {
  const text = normalizePrompt(prompt);
  const explicitId = text.match(/\b([a-z0-9_-]+:[a-z0-9_-]+)(?:@([0-9A-Za-z_.-]+))?\b/i);
  if (explicitId) {
    return explicitId[1];
  }

  if (/\besp32\b/i.test(text)) {
    return "esp32:esp32";
  }

  if (/\besp8266\b/i.test(text)) {
    return "esp8266:esp8266";
  }

  const match =
    text.match(/\binstall\s+(?:the\s+)?(?:board\s+)?(?:platform|core|package)\s+["'`]?([^"'`,.;]+)["'`]?/i) ||
    text.match(/\binstall\s+["'`]?([^"'`,.;]+?)["'`]?\s+(?:board\s+)?(?:platform|core|package)\b/i);
  return normalizePackageName(match?.[1]);
}

function normalizeRelativeFilePath(workspaceRoot, activeTab) {
  if (!workspaceRoot || !activeTab?.path) {
    return "";
  }

  const absoluteRoot = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(activeTab.path);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  return relative.replace(/\\/g, "/");
}

function normalizeRelativeContextFilePath(workspaceRoot, item) {
  if (!workspaceRoot || !item || typeof item !== "object") {
    return "";
  }

  const pathValue = String(item.path || item.relativePath || "").trim();
  if (!pathValue) {
    return "";
  }

  if (path.isAbsolute(pathValue)) {
    return normalizeRelativeFilePath(workspaceRoot, { path: pathValue });
  }

  const absoluteRoot = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(absoluteRoot, pathValue);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  return relative.replace(/\\/g, "/");
}

function isArduinoSourcePath(filePath) {
  return /\.(ino|pde|cpp|cxx|cc|c|h|hpp)$/i.test(String(filePath || ""));
}

function buildCurrentSketchArgs(payload, workspaceRoot) {
  const filePath = normalizeRelativeFilePath(workspaceRoot, payload.activeTab);
  if (filePath) {
    return {
      filePath,
      displayName: payload.activeTab?.name || path.basename(filePath),
    };
  }

  const contextItems = Array.isArray(payload.contextItems) ? payload.contextItems : [];
  const sourceItems = contextItems
    .map((item) => {
      const relativePath = normalizeRelativeContextFilePath(workspaceRoot, item);
      return relativePath ? { item, relativePath } : null;
    })
    .filter(Boolean)
    .filter(({ relativePath }) => isArduinoSourcePath(relativePath));

  const selected = sourceItems.find(({ relativePath }) => /\.ino$/i.test(relativePath)) || sourceItems[0] || null;
  if (!selected) {
    return null;
  }

  return {
    filePath: selected.relativePath,
    displayName: selected.item.name || path.basename(selected.relativePath),
  };
}

function buildLocalBoardArgs(payload) {
  const localBoard = payload.localBoardContext || null;
  if (!localBoard?.fqbn || !localBoard?.port) {
    return null;
  }

  return {
    targetType: "local",
    board: localBoard.fqbn,
    port: localBoard.port,
    boardName: localBoard.name || localBoard.boardLabel || localBoard.fqbn,
    verifyBeforeUpload: payload.arduinoPreferences?.verifyBeforeUpload !== false,
  };
}

function buildCloudBoardArgs(payload) {
  const board = payload.boardContext || null;
  if (!board?.id || !board?.fqbn) {
    return null;
  }

  return {
    targetType: "cloud",
    boardId: board.id,
    board: board.fqbn,
    boardName: board.name || board.fqbn,
    version: payload.arduinoPreferences?.nextReleaseVersion || "1.0.0",
  };
}

function createToolRequest(toolId, summary, args, options = {}) {
  const descriptor = DESCRIPTOR_BY_ID.get(toolId);
  return normalizeToolRequest({
    toolId,
    summary,
    risk: options.risk || descriptor?.risk || "medium",
    origin: options.origin || "user",
    arguments: args,
    approvalReason: options.approvalReason || "",
  });
}

function detectAgentToolRequest(prompt, payload = {}, workspaceRoot = "") {
  const text = normalizePrompt(prompt);
  const lower = text.toLowerCase();

  const libraryName = extractLibraryName(text);
  if (libraryName) {
    const version = extractVersion(text);
    return {
      request: createToolRequest(
        "arduino.library.install",
        `Install Arduino library ${libraryName}${version ? ` ${version}` : ""}`,
        { name: libraryName, version: version || "latest" },
      ),
    };
  }

  const platformName = extractPlatformName(text);
  if (platformName && /\b(?:install|add|setup|set up)\b/i.test(text)) {
    const version = extractVersion(text);
    return {
      request: createToolRequest(
        "arduino.platform.install",
        `Install board platform ${platformName}${version ? ` ${version}` : ""}`,
        { packageName: platformName, version: version || "latest" },
      ),
    };
  }

  if (/\b(verify|compile|build|check)\b/.test(lower) && /\b(arduino|sketch|ino|firmware|code)\b/.test(lower)) {
    const sketchArgs = buildCurrentSketchArgs(payload, workspaceRoot);
    if (!sketchArgs) {
      return {
        clarification: "Open a saved Arduino sketch before asking the agent to verify it.",
      };
    }

    const board = payload.localBoardContext?.fqbn || payload.boardContext?.fqbn || payload.boardContext?.board || "arduino:avr:uno";
    return {
      request: createToolRequest(
        "arduino.verify",
        `Verify ${sketchArgs.displayName} for ${board}`,
        { ...sketchArgs, board },
      ),
    };
  }

  if (/\b(upload|flash|push|program|deploy)\b/.test(lower) && /\b(arduino|sketch|ino|firmware|code|board|device|ota|cloud|usb)\b/.test(lower)) {
    const sketchArgs = buildCurrentSketchArgs(payload, workspaceRoot);
    if (!sketchArgs) {
      return {
        clarification: "Open a saved Arduino sketch before asking the agent to upload it.",
      };
    }

    const wantsCloud = /\b(cloud|ota|remote)\b/.test(lower);
    const targetArgs = wantsCloud ? buildCloudBoardArgs(payload) : buildLocalBoardArgs(payload) || buildCloudBoardArgs(payload);
    if (!targetArgs) {
      return {
        clarification: wantsCloud
          ? "Select a cloud board before asking the agent to upload OTA firmware."
          : "Select a connected local board with a board type and port before asking the agent to upload.",
      };
    }

    return {
      request: createToolRequest(
        "arduino.upload",
        `Upload ${sketchArgs.displayName} to ${targetArgs.boardName || targetArgs.board}`,
        { ...sketchArgs, ...targetArgs },
        { risk: "high" },
      ),
    };
  }

  if (/^\s*git\s+status\b/i.test(text) || /\bshow\s+git\s+status\b/i.test(text)) {
    return {
      request: createToolRequest("git.status", "Show Git status", {}),
    };
  }

  if (/^\s*git\s+(?:diff|changes)\b/i.test(text) || /\bshow\s+git\s+(?:diff|changes)\b/i.test(text)) {
    return {
      request: createToolRequest("git.diff", "Show Git diff", { path: "" }),
    };
  }

  if (/^\s*git\s+log\b/i.test(text) || /\bshow\s+git\s+log\b/i.test(text)) {
    return {
      request: createToolRequest("git.log", "Show recent Git commits", { limit: 20 }),
    };
  }

  if (/^\s*git\s+stage\b/i.test(text) || /\bstage\s+(?:all|changes|files?)\b/i.test(text)) {
    return {
      request: createToolRequest("git.stage", "Stage Git changes", { paths: ["."] }),
    };
  }

  if (/^\s*git\s+commit\b/i.test(text) || /\bcommit\s+(?:the\s+)?(?:changes|files)\b/i.test(text)) {
    const messageMatch = text.match(/(?:-m\s+|message\s+|with\s+message\s+)["'`]?([^"'`]+)["'`]?/i);
    const message = messageMatch?.[1]?.trim() || "";
    if (!message) {
      return {
        clarification: "Provide a commit message before asking the agent to commit changes.",
      };
    }

    return {
      request: createToolRequest("git.commit", `Commit Git changes: ${message}`, { message }),
    };
  }

  if (/^\s*git\s+(?:branch|checkout|switch)\b/i.test(text) || /\b(?:create|make|switch|checkout)\s+(?:a\s+)?(?:new\s+)?git\s+branch\b/i.test(text)) {
    const branchMatch =
      text.match(/\b(?:branch|checkout|switch)\s+["'`]?([^"'`\s]+)["'`]?/i) ||
      text.match(/\b(?:named|called)\s+["'`]?([^"'`\s]+)["'`]?/i);
    const branch = String(branchMatch?.[1] || "").trim();
    if (!branch) {
      return {
        clarification: "Provide a branch name before asking the agent to create or switch Git branches.",
      };
    }
    const mode = /\b(?:checkout|switch)\b/i.test(text) && !/\b(?:new|create|make)\b/i.test(text) ? "checkout" : "create";
    return {
      request: createToolRequest("git.branch", `${mode === "checkout" ? "Switch to" : "Create"} Git branch ${branch}`, { branch, mode }),
    };
  }

  if (/^\s*git\s+pull\b/i.test(text) || /\bpull\s+(?:from\s+)?git\b/i.test(text)) {
    return {
      request: createToolRequest("git.pull", "Pull from Git upstream", {}),
    };
  }

  if (/^\s*git\s+push\b/i.test(text) || /\bpush\s+(?:to\s+)?git\b/i.test(text)) {
    return {
      request: createToolRequest("git.push", "Push to Git upstream", {}),
    };
  }

  return null;
}

function extractArduinoIncludes(content) {
  const includes = [];
  const pattern = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
  for (const match of String(content || "").matchAll(pattern)) {
    const includeName = String(match[1] || "").trim();
    if (!includeName || includeName.includes("/") || includeName.includes("\\")) {
      continue;
    }
    includes.push(includeName);
  }
  return [...new Set(includes)];
}

function includeLooksBuiltin(includeName) {
  return BUILTIN_ARDUINO_HEADERS.has(String(includeName || "").toLowerCase());
}

function normalizeIncludeBase(includeName) {
  return String(includeName || "")
    .replace(/\.(h|hpp|hh|hxx)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

module.exports = {
  AGENT_TOOL_ENGINE,
  AgentToolRegistry,
  TOOL_DESCRIPTORS,
  createToolPendingAction,
  createToolRequest,
  createToolTaskList,
  detectAgentToolRequest,
  extractArduinoIncludes,
  includeLooksBuiltin,
  normalizeIncludeBase,
  normalizeToolRequest,
  taskListWithStatus,
};

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const RESTORE_HISTORY_VERSION = 1;
const ACTIVE_RESTORE_STATUSES = new Set(["pending", "kept"]);
const RESTORE_STATUSES = new Set(["pending", "kept", "reverted", "restored"]);
const RESTORE_HISTORY_DIR_NAME = "agent-restore-points";

function isInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeAgentRestoreRelativePath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!raw || raw.includes("\0") || path.isAbsolute(raw)) {
    return null;
  }

  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }

  const lower = normalized.toLowerCase();
  if (
    lower === ".git" ||
    lower.startsWith(".git/") ||
    lower === ".tantalum-file-tree-trash" ||
    lower.startsWith(".tantalum-file-tree-trash/")
  ) {
    return null;
  }

  return normalized;
}

function normalizeRestoreChangeType(value) {
  return value === "create" || value === "update" || value === "delete" ? value : null;
}

function normalizeRestoreStatus(value, fallback = "pending") {
  return RESTORE_STATUSES.has(value) ? value : fallback;
}

function normalizeIso(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeRestoreFile(file) {
  if (!file || typeof file !== "object") {
    return null;
  }

  const relativePath = normalizeAgentRestoreRelativePath(file.path);
  const changeType = normalizeRestoreChangeType(file.changeType);
  if (!relativePath || !changeType) {
    return null;
  }

  const normalized = {
    path: relativePath,
    changeType,
    originalContent: typeof file.originalContent === "string" ? file.originalContent : "",
    nextContent: typeof file.nextContent === "string" ? file.nextContent : "",
  };

  if (typeof file.workspaceOriginalContent === "string") {
    normalized.workspaceOriginalContent = file.workspaceOriginalContent;
  }

  if (file.stats && typeof file.stats === "object") {
    normalized.stats = {
      changedLines: Number(file.stats.changedLines || 0),
      beforeLength: Number(file.stats.beforeLength || 0),
      afterLength: Number(file.stats.afterLength || 0),
    };
  }

  return normalized;
}

function normalizeRestoreFiles(files) {
  if (!Array.isArray(files)) {
    return [];
  }

  return files.map(normalizeRestoreFile).filter(Boolean);
}

function sortChangesets(changesets) {
  return [...changesets].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || "") || 0;
    const rightTime = Date.parse(right.createdAt || "") || 0;
    return leftTime - rightTime || String(left.id).localeCompare(String(right.id));
  });
}

function summarizeChangeset(changeset) {
  return {
    id: changeset.id,
    threadId: changeset.threadId,
    userMessageId: changeset.userMessageId,
    userMessageCreatedAt: changeset.userMessageCreatedAt || null,
    reviewId: changeset.reviewId || null,
    status: changeset.status,
    createdAt: changeset.createdAt,
    fileCount: Array.isArray(changeset.files) ? changeset.files.length : 0,
    files: Array.isArray(changeset.files)
      ? changeset.files.map((file) => ({
          path: file.path,
          changeType: file.changeType,
          stats: file.stats,
        }))
      : [],
  };
}

function activeChangesets(history) {
  return sortChangesets(history.changesets || []).filter((changeset) => ACTIVE_RESTORE_STATUSES.has(changeset.status));
}

function messageOrderIndex(messageIdsInOrder, messageId) {
  if (!messageId) {
    return -1;
  }

  return messageIdsInOrder.indexOf(messageId);
}

class AgentRestorePointStore {
  constructor(options = {}) {
    this.app = options.app;
    this.getWorkspaceRoot = typeof options.getWorkspaceRoot === "function" ? options.getWorkspaceRoot : () => null;
    this.markWorkspaceDirty = typeof options.markWorkspaceDirty === "function" ? options.markWorkspaceDirty : () => {};
    this.addRecentFile = typeof options.addRecentFile === "function" ? options.addRecentFile : () => {};
  }

  restoreRoot() {
    const userData = this.app?.getPath?.("userData") || process.cwd();
    return path.join(userData, RESTORE_HISTORY_DIR_NAME);
  }

  resolveWorkspaceRoot(payload = {}) {
    const currentWorkspace = this.getWorkspaceRoot();
    const requested = String(payload.workspacePath || currentWorkspace || "").trim();
    if (!currentWorkspace || !requested) {
      throw new Error("Open a workspace before using agent restore points.");
    }

    const resolvedCurrent = path.resolve(currentWorkspace);
    const resolvedRequested = path.resolve(requested);
    if (resolvedCurrent !== resolvedRequested) {
      throw new Error("Agent restore points are only available for the active workspace.");
    }

    return resolvedCurrent;
  }

  historyPath(workspaceRoot, threadId) {
    const digest = crypto.createHash("sha256").update(`${path.resolve(workspaceRoot)}\0${threadId}`).digest("hex");
    return path.join(this.restoreRoot(), `${digest}.json`);
  }

  async readHistory(workspaceRoot, threadId) {
    const filePath = this.historyPath(workspaceRoot, threadId);
    try {
      const parsed = JSON.parse(await fsPromises.readFile(filePath, "utf8"));
      if (!parsed || parsed.version !== RESTORE_HISTORY_VERSION || parsed.threadId !== threadId) {
        return {
          version: RESTORE_HISTORY_VERSION,
          workspaceRoot,
          threadId,
          updatedAt: new Date().toISOString(),
          changesets: [],
        };
      }

      return {
        version: RESTORE_HISTORY_VERSION,
        workspaceRoot,
        threadId,
        updatedAt: normalizeIso(parsed.updatedAt) || new Date().toISOString(),
        changesets: Array.isArray(parsed.changesets)
          ? parsed.changesets
              .map((changeset) => this.normalizeChangeset(changeset))
              .filter(Boolean)
          : [],
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("Unable to read agent restore history:", error instanceof Error ? error.message : error);
      }

      return {
        version: RESTORE_HISTORY_VERSION,
        workspaceRoot,
        threadId,
        updatedAt: new Date().toISOString(),
        changesets: [],
      };
    }
  }

  async writeHistory(history) {
    const filePath = this.historyPath(history.workspaceRoot, history.threadId);
    const nextHistory = {
      version: RESTORE_HISTORY_VERSION,
      workspaceRoot: history.workspaceRoot,
      threadId: history.threadId,
      updatedAt: new Date().toISOString(),
      changesets: sortChangesets(history.changesets || []),
    };

    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify(nextHistory), "utf8");
    return nextHistory;
  }

  normalizeChangeset(changeset) {
    if (!changeset || typeof changeset !== "object") {
      return null;
    }

    const id = String(changeset.id || "").trim();
    const threadId = String(changeset.threadId || "").trim();
    const userMessageId = String(changeset.userMessageId || "").trim();
    const files = normalizeRestoreFiles(changeset.files);
    if (!id || !threadId || !userMessageId || files.length === 0) {
      return null;
    }

    return {
      id,
      threadId,
      userMessageId,
      userMessageCreatedAt: normalizeIso(changeset.userMessageCreatedAt),
      reviewId: String(changeset.reviewId || "").trim() || null,
      status: normalizeRestoreStatus(changeset.status),
      createdAt: normalizeIso(changeset.createdAt) || new Date().toISOString(),
      updatedAt: normalizeIso(changeset.updatedAt) || normalizeIso(changeset.createdAt) || new Date().toISOString(),
      restoredAt: normalizeIso(changeset.restoredAt),
      files,
    };
  }

  async record(payload = {}) {
    const workspaceRoot = this.resolveWorkspaceRoot(payload);
    const threadId = String(payload.threadId || "").trim();
    const userMessageId = String(payload.userMessageId || "").trim();
    const files = normalizeRestoreFiles(payload.files);
    if (!threadId || !userMessageId) {
      throw new Error("threadId and userMessageId are required for agent restore points.");
    }

    if (files.length === 0) {
      throw new Error("At least one changed file is required for an agent restore point.");
    }

    const now = new Date().toISOString();
    const changeset = {
      id: String(payload.id || "").trim() || crypto.randomUUID(),
      threadId,
      userMessageId,
      userMessageCreatedAt: normalizeIso(payload.userMessageCreatedAt),
      reviewId: String(payload.reviewId || "").trim() || null,
      status: normalizeRestoreStatus(payload.status),
      createdAt: normalizeIso(payload.createdAt) || now,
      updatedAt: now,
      restoredAt: null,
      files,
    };

    const history = await this.readHistory(workspaceRoot, threadId);
    history.changesets = [...history.changesets.filter((entry) => entry.id !== changeset.id), changeset];
    await this.writeHistory(history);

    return {
      changeset: summarizeChangeset(changeset),
      restorePoints: await this.list({ workspacePath: workspaceRoot }),
    };
  }

  async list(payload = {}) {
    const workspaceRoot = this.resolveWorkspaceRoot(payload);
    const threadId = String(payload.threadId || "").trim();
    const histories = [];

    if (threadId) {
      histories.push(await this.readHistory(workspaceRoot, threadId));
    } else {
      await fsPromises.mkdir(this.restoreRoot(), { recursive: true });
      const entries = await fsPromises.readdir(this.restoreRoot(), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        try {
          const parsed = JSON.parse(await fsPromises.readFile(path.join(this.restoreRoot(), entry.name), "utf8"));
          if (path.resolve(parsed.workspaceRoot || "") !== workspaceRoot || !parsed.threadId) {
            continue;
          }
          histories.push(await this.readHistory(workspaceRoot, parsed.threadId));
        } catch {
          // Ignore malformed restore history files.
        }
      }
    }

    return histories.flatMap((history) => activeChangesets(history).map(summarizeChangeset));
  }

  async updateReviewStatus(payload = {}) {
    const workspaceRoot = this.resolveWorkspaceRoot(payload);
    const reviewId = String(payload.reviewId || "").trim();
    const status = normalizeRestoreStatus(payload.status, "");
    if (!reviewId || !status) {
      throw new Error("reviewId and a valid restore status are required.");
    }

    const restorePoints = await this.list({ workspacePath: workspaceRoot });
    const threadIds = [...new Set(restorePoints.map((point) => point.threadId))];
    for (const threadId of threadIds) {
      const history = await this.readHistory(workspaceRoot, threadId);
      let changed = false;
      history.changesets = history.changesets.map((changeset) => {
        if (changeset.reviewId !== reviewId) {
          return changeset;
        }

        changed = true;
        return {
          ...changeset,
          status,
          updatedAt: new Date().toISOString(),
        };
      });

      if (changed) {
        await this.writeHistory(history);
      }
    }

    return {
      restorePoints: await this.list({ workspacePath: workspaceRoot }),
    };
  }

  changesetsToRestore(history, messageId, messageIdsInOrder) {
    const active = activeChangesets(history);
    const anchorIndex = messageOrderIndex(messageIdsInOrder, messageId);

    if (anchorIndex >= 0) {
      return active.filter((changeset) => {
        const changesetIndex = messageOrderIndex(messageIdsInOrder, changeset.userMessageId);
        return changesetIndex >= anchorIndex;
      });
    }

    return active.filter((changeset) => changeset.userMessageId === messageId);
  }

  async restoreToMessage(payload = {}) {
    const workspaceRoot = this.resolveWorkspaceRoot(payload);
    const threadId = String(payload.threadId || "").trim();
    const messageId = String(payload.messageId || payload.userMessageId || "").trim();
    const messageIdsInOrder = Array.isArray(payload.messageIdsInOrder)
      ? payload.messageIdsInOrder.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];

    if (!threadId || !messageId) {
      throw new Error("threadId and messageId are required for agent restore.");
    }

    const history = await this.readHistory(workspaceRoot, threadId);
    const targets = this.changesetsToRestore(history, messageId, messageIdsInOrder);
    if (targets.length === 0) {
      return {
        restoredFiles: [],
        restoredChangeSetIds: [],
        restorePoints: await this.list({ workspacePath: workspaceRoot }),
      };
    }

    const touchedPaths = new Set();
    const reverseTargets = [...targets].sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || "") || 0;
      const rightTime = Date.parse(right.createdAt || "") || 0;
      return rightTime - leftTime || String(right.id).localeCompare(String(left.id));
    });

    for (const changeset of reverseTargets) {
      const files = [...changeset.files].reverse();
      for (const file of files) {
        await this.applyReverseFileChange(workspaceRoot, file);
        touchedPaths.add(file.path);
      }
    }

    const restoredAt = new Date().toISOString();
    const restoredIds = new Set(targets.map((changeset) => changeset.id));
    history.changesets = history.changesets.map((changeset) =>
      restoredIds.has(changeset.id)
        ? {
            ...changeset,
            status: "restored",
            restoredAt,
            updatedAt: restoredAt,
          }
        : changeset,
    );
    await this.writeHistory(history);

    return {
      restoredFiles: await Promise.all([...touchedPaths].sort().map((relativePath) => this.readRestoredFile(workspaceRoot, relativePath))),
      restoredChangeSetIds: [...restoredIds],
      restorePoints: await this.list({ workspacePath: workspaceRoot }),
    };
  }

  absolutePathFor(workspaceRoot, relativePath) {
    const normalized = normalizeAgentRestoreRelativePath(relativePath);
    if (!normalized) {
      throw new Error(`Blocked unsafe agent restore path: ${relativePath || "(missing)"}`);
    }

    const targetPath = path.resolve(workspaceRoot, ...normalized.split("/"));
    if (!isInsideRoot(targetPath, workspaceRoot)) {
      throw new Error(`Blocked unsafe agent restore path: ${relativePath}`);
    }

    return { targetPath, relativePath: normalized };
  }

  async assertNoDirectoryConflict(targetPath, relativePath) {
    try {
      const stat = await fsPromises.stat(targetPath);
      if (stat.isDirectory()) {
        throw new Error(`${relativePath} is now a directory. Resolve it manually before restoring this agent point.`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async applyReverseFileChange(workspaceRoot, file) {
    const { targetPath, relativePath } = this.absolutePathFor(workspaceRoot, file.path);
    await this.assertNoDirectoryConflict(targetPath, relativePath);

    if (file.changeType === "create") {
      if (fs.existsSync(targetPath)) {
        await fsPromises.unlink(targetPath);
      }
      this.markWorkspaceDirty(targetPath);
      return;
    }

    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, file.originalContent, "utf8");
    this.addRecentFile(targetPath);
    this.markWorkspaceDirty(targetPath);
  }

  async readRestoredFile(workspaceRoot, relativePath) {
    const { targetPath } = this.absolutePathFor(workspaceRoot, relativePath);
    try {
      const stat = await fsPromises.stat(targetPath);
      if (stat.isDirectory()) {
        return {
          path: relativePath,
          absolutePath: targetPath,
          exists: true,
          isDirectory: true,
          content: null,
        };
      }

      return {
        path: relativePath,
        absolutePath: targetPath,
        exists: true,
        isDirectory: false,
        content: await fsPromises.readFile(targetPath, "utf8"),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }

      return {
        path: relativePath,
        absolutePath: targetPath,
        exists: false,
        isDirectory: false,
        content: null,
      };
    }
  }
}

module.exports = {
  AgentRestorePointStore,
  normalizeAgentRestoreRelativePath,
};

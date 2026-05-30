const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { AgentRestorePointStore } = require("../src/agent/restorePointStore");

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(targetPath) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function withStore(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tantalum-agent-restore-smoke-"));
  const workspaceRoot = path.join(root, "workspace");
  const userDataRoot = path.join(root, "user-data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(userDataRoot, { recursive: true });

  const dirtyPaths = [];
  const recentFiles = [];
  const store = new AgentRestorePointStore({
    app: {
      getPath(name) {
        return name === "userData" ? userDataRoot : root;
      },
    },
    getWorkspaceRoot: () => workspaceRoot,
    markWorkspaceDirty: (changedPath) => dirtyPaths.push(changedPath),
    addRecentFile: (filePath) => recentFiles.push(filePath),
  });

  try {
    await callback({ workspaceRoot, store, dirtyPaths, recentFiles });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function runRestoreSemanticsSmoke() {
  await withStore(async ({ workspaceRoot, store }) => {
    await fs.writeFile(path.join(workspaceRoot, "updated.txt"), "before\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "deleted.txt"), "delete me\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "old-name.txt"), "renamed content\n", "utf8");

    await store.record({
      workspacePath: workspaceRoot,
      threadId: "thread-1",
      userMessageId: "msg-1",
      files: [
        { path: "updated.txt", changeType: "update", originalContent: "before\n", nextContent: "after\n" },
        { path: "created.txt", changeType: "create", originalContent: "", nextContent: "created\n" },
        { path: "deleted.txt", changeType: "delete", originalContent: "delete me\n", nextContent: "" },
        { path: "old-name.txt", changeType: "delete", originalContent: "renamed content\n", nextContent: "" },
        { path: "new-name.txt", changeType: "create", originalContent: "", nextContent: "renamed content\n" },
      ],
    });

    await fs.writeFile(path.join(workspaceRoot, "updated.txt"), "manual after agent\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "created.txt"), "manual after create\n", "utf8");
    await fs.rm(path.join(workspaceRoot, "deleted.txt"));
    await fs.rm(path.join(workspaceRoot, "old-name.txt"));
    await fs.writeFile(path.join(workspaceRoot, "new-name.txt"), "manual after rename\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "manual-only.txt"), "leave alone\n", "utf8");

    const result = await store.restoreToMessage({
      workspacePath: workspaceRoot,
      threadId: "thread-1",
      messageId: "msg-1",
      messageIdsInOrder: ["msg-1"],
    });

    assert.deepEqual(result.restoredChangeSetIds.length, 1);
    assert.equal(await readIfExists(path.join(workspaceRoot, "updated.txt")), "before\n");
    assert.equal(await exists(path.join(workspaceRoot, "created.txt")), false);
    assert.equal(await readIfExists(path.join(workspaceRoot, "deleted.txt")), "delete me\n");
    assert.equal(await readIfExists(path.join(workspaceRoot, "old-name.txt")), "renamed content\n");
    assert.equal(await exists(path.join(workspaceRoot, "new-name.txt")), false);
    assert.equal(await readIfExists(path.join(workspaceRoot, "manual-only.txt")), "leave alone\n");
    assert.equal(result.restorePoints.length, 0);
  });
}

async function runMessageOrderSmoke() {
  await withStore(async ({ workspaceRoot, store }) => {
    await fs.writeFile(path.join(workspaceRoot, "ordered.txt"), "v1\n", "utf8");

    await store.record({
      workspacePath: workspaceRoot,
      threadId: "thread-2",
      userMessageId: "msg-1",
      files: [{ path: "ordered.txt", changeType: "update", originalContent: "v1\n", nextContent: "v2\n" }],
    });
    await store.record({
      workspacePath: workspaceRoot,
      threadId: "thread-2",
      userMessageId: "msg-2",
      files: [
        { path: "ordered.txt", changeType: "update", originalContent: "v2\n", nextContent: "v3\n" },
        { path: "later-created.txt", changeType: "create", originalContent: "", nextContent: "later\n" },
      ],
    });

    await fs.writeFile(path.join(workspaceRoot, "ordered.txt"), "manual v4\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "later-created.txt"), "manual later\n", "utf8");

    const restoreSecond = await store.restoreToMessage({
      workspacePath: workspaceRoot,
      threadId: "thread-2",
      messageId: "msg-2",
      messageIdsInOrder: ["msg-1", "msg-2"],
    });

    assert.equal(await readIfExists(path.join(workspaceRoot, "ordered.txt")), "v2\n");
    assert.equal(await exists(path.join(workspaceRoot, "later-created.txt")), false);
    assert.equal(restoreSecond.restorePoints.length, 1);
    assert.equal(restoreSecond.restorePoints[0].userMessageId, "msg-1");

    await store.restoreToMessage({
      workspacePath: workspaceRoot,
      threadId: "thread-2",
      messageId: "msg-1",
      messageIdsInOrder: ["msg-1", "msg-2"],
    });
    assert.equal(await readIfExists(path.join(workspaceRoot, "ordered.txt")), "v1\n");
  });
}

async function runDirectoryConflictSmoke() {
  await withStore(async ({ workspaceRoot, store }) => {
    await store.record({
      workspacePath: workspaceRoot,
      threadId: "thread-3",
      userMessageId: "msg-1",
      files: [{ path: "agent-created.txt", changeType: "create", originalContent: "", nextContent: "created\n" }],
    });
    await fs.mkdir(path.join(workspaceRoot, "agent-created.txt"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "agent-created.txt", "manual.txt"), "manual\n", "utf8");

    await assert.rejects(
      () =>
        store.restoreToMessage({
          workspacePath: workspaceRoot,
          threadId: "thread-3",
          messageId: "msg-1",
          messageIdsInOrder: ["msg-1"],
        }),
      /now a directory/i,
    );
    assert.equal(await readIfExists(path.join(workspaceRoot, "agent-created.txt", "manual.txt")), "manual\n");
  });
}

async function main() {
  await runRestoreSemanticsSmoke();
  await runMessageOrderSmoke();
  await runDirectoryConflictSmoke();
  console.log("agent restore point smoke checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CloudSyncService } = require("../src/services/cloudSyncService");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
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

async function writeFile(root, relativePath, content = "") {
  const targetPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}

async function exists(root, relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function createStore() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  };
}

function createService(userDataPath, store = createStore(), options = {}) {
  return new CloudSyncService({
    userDataPath,
    getPreferenceStore: () => store,
    ...options,
  });
}

async function runNonGitExclusionSmoke(root) {
  const workspace = path.join(root, "plain-workspace");
  const userData = path.join(root, "plain-user-data");
  await fs.mkdir(workspace, { recursive: true });

  await writeFile(workspace, "src/app.js", "console.log('sync me');\n");
  await fs.mkdir(path.join(workspace, "src/empty"), { recursive: true });
  await writeFile(workspace, ".tantalumignore", "custom-cache/\n*.secret\n");
  await writeFile(workspace, "node_modules/pkg/index.js", "excluded");
  await writeFile(workspace, ".venv/lib/python/site.py", "excluded");
  await writeFile(workspace, "vendor/autoload.php", "excluded");
  await writeFile(workspace, "build/output.bin", "excluded");
  await writeFile(workspace, "target/debug/app", "excluded");
  await writeFile(workspace, "bin/app.dll", "excluded");
  await writeFile(workspace, "obj/app.o", "excluded");
  await writeFile(workspace, ".dart_tool/package_config.json", "excluded");
  await writeFile(workspace, "Pods/Manifest.lock", "excluded");
  await writeFile(workspace, "logs/app.log", "excluded");
  await writeFile(workspace, ".env", "SECRET=1\n");
  await writeFile(workspace, ".env.local", "SECRET=2\n");
  await writeFile(workspace, "private.pem", "excluded");
  await writeFile(workspace, ".npmrc", "//registry.example/:_authToken=secret\n");
  await writeFile(workspace, ".aws/credentials", "excluded");
  await writeFile(workspace, "custom-cache/item.txt", "excluded");
  await writeFile(workspace, "note.secret", "excluded");

  const service = createService(userData);
  const scan = await service.scanWorkspace(workspace);
  const included = scan.files.map((file) => file.relativePath);
  assert.deepEqual(included.sort(), [".tantalumignore", "src/app.js"]);
  assert.ok(scan.emptyDirectories.includes("src/empty"));
  assert.ok(scan.excluded.some((entry) => entry.path === ".env" && entry.core));
  assert.ok(scan.excluded.some((entry) => entry.path === ".aws/credentials" && entry.core));
  assert.ok(scan.excluded.some((entry) => entry.path === "node_modules"));
  assert.ok(scan.excluded.some((entry) => entry.path === "custom-cache"));

  const snapshot = await service.snapshotWorkspace({
    workspacePath: workspace,
    projectId: "plain-project",
    message: "Smoke snapshot",
  });
  const shadow = snapshot.shadowRepoPath;
  assert.equal(await exists(shadow, "src/app.js"), true);
  assert.equal(await exists(shadow, ".tantalumignore"), true);
  assert.equal(await exists(shadow, "node_modules/pkg/index.js"), false);
  assert.equal(await exists(shadow, ".venv/lib/python/site.py"), false);
  assert.equal(await exists(shadow, "vendor/autoload.php"), false);
  assert.equal(await exists(shadow, ".env"), false);
  assert.equal(await exists(shadow, ".aws/credentials"), false);

  const manifest = JSON.parse(await fs.readFile(path.join(shadow, ".tantalum-sync", "manifest.json"), "utf8"));
  assert.ok(manifest.emptyDirectories.includes("src/empty"));
}

async function runExistingGitSmoke(root) {
  const workspace = path.join(root, "git-workspace");
  const userData = path.join(root, "git-user-data");
  await fs.mkdir(workspace, { recursive: true });
  await run("git", ["init", "-b", "main"], workspace).catch(() => run("git", ["init"], workspace));
  await run("git", ["config", "user.name", "Smoke User"], workspace);
  await run("git", ["config", "user.email", "smoke@example.com"], workspace);
  await run("git", ["remote", "add", "origin", "git@example.com:user/existing.git"], workspace);

  await writeFile(workspace, "README.md", "# Existing repo\n");
  await writeFile(workspace, "src/app.js", "console.log('tracked');\n");
  await fs.mkdir(path.join(workspace, "src/empty-git"), { recursive: true });
  await writeFile(workspace, ".gitignore", "ignored-empty/\ntracked-ignored.txt\n");
  await fs.mkdir(path.join(workspace, "ignored-empty"), { recursive: true });
  await writeFile(workspace, "tracked-ignored.txt", "tracked despite gitignore\n");
  await writeFile(workspace, ".env", "SECRET=tracked\n");
  await writeFile(workspace, "vendor/library.php", "<?php\n");
  await run("git", ["add", "README.md", "src/app.js", ".gitignore", ".env", "vendor/library.php"], workspace);
  await run("git", ["add", "-f", "tracked-ignored.txt"], workspace);
  await run("git", ["commit", "-m", "Initial"], workspace);
  await writeFile(workspace, "node_modules/pkg/index.js", "untracked excluded");
  await writeFile(workspace, "build/output.js", "untracked excluded");

  const beforeBranch = (await run("git", ["branch", "--show-current"], workspace)).stdout.trim();
  const beforeRemotes = (await run("git", ["remote", "-v"], workspace)).stdout;
  const beforeStatus = (await run("git", ["status", "--porcelain"], workspace)).stdout;

  const service = createService(userData);
  const snapshot = await service.snapshotWorkspace({
    workspacePath: workspace,
    projectId: "existing-git-project",
    message: "Existing Git smoke snapshot",
  });

  assert.equal(snapshot.scan.hasExistingGit, true);
  assert.equal(snapshot.scan.usedReadOnlyGitScan, true);
  const shadow = snapshot.shadowRepoPath;
  assert.equal(await exists(shadow, "README.md"), true);
  assert.equal(await exists(shadow, "src/app.js"), true);
  assert.equal(await exists(shadow, "tracked-ignored.txt"), true);
  assert.equal(await exists(shadow, ".env"), false);
  assert.equal(await exists(shadow, "vendor/library.php"), false);
  assert.equal(await exists(shadow, "node_modules/pkg/index.js"), false);
  assert.equal(await exists(shadow, "build/output.js"), false);
  const manifest = JSON.parse(await fs.readFile(path.join(shadow, ".tantalum-sync", "manifest.json"), "utf8"));
  assert.ok(manifest.emptyDirectories.includes("src/empty-git"));
  assert.ok(!manifest.emptyDirectories.includes("ignored-empty"));

  const afterBranch = (await run("git", ["branch", "--show-current"], workspace)).stdout.trim();
  const afterRemotes = (await run("git", ["remote", "-v"], workspace)).stdout;
  const afterStatus = (await run("git", ["status", "--porcelain"], workspace)).stdout;
  assert.equal(afterBranch, beforeBranch);
  assert.equal(afterRemotes, beforeRemotes);
  assert.equal(afterStatus, beforeStatus);
}

async function runShadowRemoteSmoke(root) {
  const workspace = path.join(root, "remote-workspace");
  const userData = path.join(root, "remote-user-data");
  const remote = path.join(root, "cloud-remote.git");
  const clone = path.join(root, "cloud-clone");
  await fs.mkdir(workspace, { recursive: true });
  await run("git", ["init", "--bare", remote], root);
  await writeFile(workspace, "src/app.js", "console.log('v1');\n");
  await writeFile(workspace, ".env", "SECRET=1\n");

  const remoteUrl = remote.replace(/\\/g, "/");
  const service = createService(userData, createStore(), {
    executeProjectSync: async () => ({
      project: {
        $id: "cp_remote_smoke",
        name: "Remote smoke",
        repoOwner: "local",
        repoName: "cloud-remote",
        sshCloneUrl: remoteUrl,
        defaultBranch: "main",
      },
      git: {
        sshCloneUrl: remoteUrl,
        branch: "main",
      },
    }),
  });

  const created = await service.createProject({ workspacePath: workspace, name: "Remote smoke" });
  assert.equal(created.project.cloudProjectId, "cp_remote_smoke");
  await writeFile(workspace, "src/app.js", "console.log('v2');\n");
  const synced = await service.syncNow("cp_remote_smoke");
  assert.equal(synced.project.syncStatus, "idle");

  await run("git", ["clone", "--branch", "main", remoteUrl, clone], root);
  const clonedContent = await fs.readFile(path.join(clone, "src/app.js"), "utf8");
  assert.equal(clonedContent.replace(/\r\n/g, "\n"), "console.log('v2');\n");
  assert.equal(await exists(clone, ".env"), false);
  assert.equal(await exists(clone, ".tantalum-sync/manifest.json"), false);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tantalum-cloud-sync-smoke-"));
  try {
    await runNonGitExclusionSmoke(root);
    await runExistingGitSmoke(root);
    await runShadowRemoteSmoke(root);
    console.log("Cloud sync smoke passed.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

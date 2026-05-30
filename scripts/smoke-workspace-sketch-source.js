const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { __testing } = require("../arduinoHandler");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function relativeList(files) {
  return files.map((file) => file.relativePath).sort((left, right) => left.localeCompare(right));
}

const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "tantalum-workspace-sketch-"));
const caseWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "tantalum-workspace-sketch-case-"));
let normalSketch = null;
let cloudSketch = null;
let caseSketch = null;
let alternateEntrySketch = null;

try {
  writeFile(path.join(workspacePath, "main.ino"), "void setup() {}\nvoid loop() {}\n");
  writeFile(path.join(workspacePath, "controls.ino"), "void helperFromIno() {}\n");
  writeFile(path.join(workspacePath, "standalone.ino"), "void setup() {}\nvoid loop() {}\n");
  writeFile(path.join(workspacePath, "root.cpp"), "#include \"defs.h\"\nint rootValue() { return 1; }\n");
  writeFile(path.join(workspacePath, "defs.h"), "#pragma once\nint rootValue();\n");
  writeFile(path.join(workspacePath, "notes.txt"), "not compiled\n");
  writeFile(path.join(workspacePath, "ignored", "ignored.cpp"), "int ignored() { return 0; }\n");
  writeFile(path.join(workspacePath, ".tentalum", "project.json"), JSON.stringify({ schemaVersion: 1, entryFile: "main.ino" }));
  writeFile(path.join(workspacePath, ".tentalum", "hidden.cpp"), "int hiddenProjectMetadata() { return 0; }\n");
  writeFile(path.join(workspacePath, "src", "helper.cpp"), "int helper() { return 2; }\n");
  writeFile(path.join(workspacePath, "src", "include-me.inc"), "#define INCLUDED_FROM_SRC 1\n");
  writeFile(path.join(workspacePath, "src", "unsupported.ino"), "void unsupportedIno() {}\n");

  normalSketch = __testing.createTemporaryWorkspaceSketch({
    kind: "workspace",
    workspacePath,
    entryFileName: "main.ino",
    dirtyFiles: [
      {
        path: path.join(workspacePath, "main.ino"),
        content: "void setup() { pinMode(7, OUTPUT); }\nvoid loop() {}\n"
      },
      {
        path: path.join(workspacePath, "unsaved.ino"),
        content: "void dirtySketchTab() {}\n"
      },
      {
        path: path.join(workspacePath, "src", "unsaved.cpp"),
        content: "int dirtySourceTab() { return 3; }\n"
      },
      {
        path: path.join(workspacePath, "dirty-standalone.ino"),
        content: "void setup() {}\nvoid loop() {}\n"
      }
    ]
  });

  assert.deepStrictEqual(relativeList(normalSketch.files), [
    "controls.ino",
    "defs.h",
    "main.ino",
    "root.cpp",
    "src/helper.cpp",
    "src/include-me.inc",
    "src/unsaved.cpp",
    "unsaved.ino"
  ]);
  assert.strictEqual(
    fs.readFileSync(path.join(normalSketch.tmpDir, "main.ino"), "utf8"),
    "void setup() { pinMode(7, OUTPUT); }\nvoid loop() {}\n"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(normalSketch.tmpDir, "unsaved.ino"), "utf8"),
    "void dirtySketchTab() {}\n"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(normalSketch.tmpDir, "src", "unsaved.cpp"), "utf8"),
    "int dirtySourceTab() { return 3; }\n"
  );
  assert.ok(!fs.existsSync(path.join(normalSketch.tmpDir, "ignored", "ignored.cpp")));
  assert.ok(!fs.existsSync(path.join(normalSketch.tmpDir, ".tentalum", "project.json")));
  assert.ok(!fs.existsSync(path.join(normalSketch.tmpDir, ".tentalum", "hidden.cpp")));
  assert.ok(!fs.existsSync(path.join(normalSketch.tmpDir, "notes.txt")));
  assert.ok(!fs.existsSync(path.join(normalSketch.tmpDir, "src", "unsupported.ino")));
  assert.ok(!fs.existsSync(path.join(normalSketch.tmpDir, "standalone.ino")));
  assert.ok(!fs.existsSync(path.join(normalSketch.tmpDir, "dirty-standalone.ino")));

  alternateEntrySketch = __testing.createTemporaryWorkspaceSketch({
    kind: "workspace",
    workspacePath,
    entryFileName: "standalone.ino",
    dirtyFiles: []
  });
  assert.strictEqual(path.basename(alternateEntrySketch.tmpDir), "standalone");
  assert.ok(fs.existsSync(path.join(alternateEntrySketch.tmpDir, "standalone.ino")));
  assert.ok(!fs.existsSync(path.join(alternateEntrySketch.tmpDir, "main.ino")));
  assert.deepStrictEqual(relativeList(alternateEntrySketch.files), [
    "controls.ino",
    "defs.h",
    "root.cpp",
    "src/helper.cpp",
    "src/include-me.inc",
    "standalone.ino"
  ]);

  cloudSketch = __testing.createTemporaryWorkspaceSketch({
    kind: "workspace",
    workspacePath,
    entryFileName: "main.ino",
    dirtyFiles: []
  }, {}, {
    cloudRuntime: {
      boardId: "board_12345678",
      apiToken: "token",
      commandSecret: "secret",
      mqttTopic: "topic",
      provisioningPop: "pop"
    }
  });
  const cloudMain = fs.readFileSync(path.join(cloudSketch.tmpDir, "main.ino"), "utf8");
  assert.ok(cloudMain.includes("#include \"TantalumCloudRuntime.h\""));
  assert.ok(cloudMain.includes("void tantalumUserSetup()"));
  assert.ok(cloudMain.includes("TantalumCloud.begin();"));

  writeFile(path.join(caseWorkspacePath, "MAIN.INO"), "void setup() {}\nvoid loop() {}\n");
  caseSketch = __testing.createTemporaryWorkspaceSketch({
    kind: "workspace",
    workspacePath: caseWorkspacePath,
    entryFileName: "main.ino",
    dirtyFiles: []
  });
  assert.deepStrictEqual(caseSketch.files.map((file) => file.relativePath), ["main.ino"]);

  console.log("Project source smoke test passed.");
} finally {
  if (normalSketch?.tempRoot) {
    fs.rmSync(normalSketch.tempRoot, { recursive: true, force: true });
  }
  if (cloudSketch?.tempRoot) {
    fs.rmSync(cloudSketch.tempRoot, { recursive: true, force: true });
  }
  if (caseSketch?.tempRoot) {
    fs.rmSync(caseSketch.tempRoot, { recursive: true, force: true });
  }
  if (alternateEntrySketch?.tempRoot) {
    fs.rmSync(alternateEntrySketch.tempRoot, { recursive: true, force: true });
  }
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.rmSync(caseWorkspacePath, { recursive: true, force: true });
}

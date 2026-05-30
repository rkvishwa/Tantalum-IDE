const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const boardCodeService = require("../src/services/boardCodeService");
const arduinoHandler = require("../arduinoHandler");

const {
  boardFamilyFromFqbn,
  espFlashSizeBytes,
  espObjdumpNames,
  normalizeSnapshotFiles,
  parseEspImage,
  parseEspPartitionTable,
  extractSourceRestoreMarkersFromBuffer,
  extractSourceRestoreMarkersFromEvidence,
  parseProperties,
  planEspAppReadback,
  selectEspAppPartition,
} = boardCodeService._test;

const {
  buildSourceRestoreMarkerFile,
  scanCompiledArtifactsForSourceRestoreMarker,
  sourceRestoreMarkerLiteral,
} = arduinoHandler.__testing;

function espPartitionEntry({ type, subtype, offset, size, label }) {
  const entry = Buffer.alloc(32, 0);
  entry.writeUInt16LE(0x50aa, 0);
  entry.writeUInt8(type, 2);
  entry.writeUInt8(subtype, 3);
  entry.writeUInt32LE(offset, 4);
  entry.writeUInt32LE(size, 8);
  Buffer.from(label || "", "ascii").copy(entry, 12, 0, 16);
  return entry;
}

function writeEspImage(buffer, offset, { loadAddress = 0x42000000, data = Buffer.from("APP-STRING-MARKER\0", "ascii") } = {}) {
  buffer.writeUInt8(0xe9, offset);
  buffer.writeUInt8(1, offset + 1);
  buffer.writeUInt8(0, offset + 2);
  buffer.writeUInt8(0, offset + 3);
  buffer.writeUInt32LE(loadAddress, offset + 4);
  buffer.writeUInt32LE(loadAddress, offset + 24);
  buffer.writeUInt32LE(data.length, offset + 28);
  data.copy(buffer, offset + 32);
}

function intelHexRecord(address, type, data = Buffer.alloc(0)) {
  const bytes = [
    data.length,
    (address >> 8) & 0xff,
    address & 0xff,
    type,
    ...data,
  ];
  const checksum = ((~bytes.reduce((sum, byte) => sum + byte, 0) + 1) & 0xff);
  return `:${data.length.toString(16).padStart(2, "0")}${address.toString(16).padStart(4, "0")}${type.toString(16).padStart(2, "0")}${data.toString("hex")}${checksum.toString(16).padStart(2, "0")}`.toUpperCase();
}

(async () => {
  const properties = parseProperties([
    "build.arch=avr",
    "upload.tool=avrdude",
    "upload.maximum_size=32256",
  ]);
  assert.equal(properties["build.arch"], "avr");
  assert.equal(boardFamilyFromFqbn("arduino:avr:uno", properties), "avr");
  assert.equal(boardFamilyFromFqbn("esp32:esp32:esp32", { "build.arch": "esp32" }), "esp");
  assert.equal(espFlashSizeBytes({ "build.flash_size": "4MB" }), 4 * 1024 * 1024);
  assert.equal(espFlashSizeBytes({ "build.flash_size": "64MB" }), boardCodeService.MAX_FLASH_BYTES);
  const decodedHex = boardCodeService.parseIntelHexToBinary(":100000000C945C000C946E000C946E000C946E00CA\n:00000001FF\n");
  assert.equal(decodedHex.baseAddress, 0);
  assert.equal(decodedHex.buffer.length, 16);
  assert.equal(decodedHex.buffer[0], 0x0c);
  assert.equal(boardCodeService.validateSourceSnapshotManifestForIdentity({
    metadata: {
      manifestVersion: 2,
      boardType: "arduino:avr:uno",
      profileId: "profile-a",
      sketchRoot: "Sketch",
    },
  }, {
    fqbn: "arduino:avr:uno",
    profileId: "profile-a",
  }).accepted, true);
  assert.equal(boardCodeService.validateSourceSnapshotManifestForIdentity({
    metadata: {
      manifestVersion: 2,
      boardType: "arduino:avr:uno",
      profileId: "profile-a",
    },
  }, {
    fqbn: "arduino:avr:nano",
    profileId: "profile-a",
  }).accepted, false);
  assert.equal(boardCodeService.validateSourceSnapshotManifestForIdentity({
    metadata: {
      boardType: "arduino:avr:uno",
      profileId: "profile-a",
    },
  }, {
    fqbn: "arduino:avr:uno",
    profileId: "profile-a",
  }).accepted, false);
  const broadSnapshotValidation = boardCodeService.validateSourceSnapshotManifestForIdentity({
    metadata: {
      manifestVersion: 2,
      boardType: "esp32:esp32:esp32s3",
      profileId: "profile-a",
      workspacePath: "D:/project",
      sketchRoot: "D:/project",
      activeFileRelativePath: "blink.ino",
    },
    files: [
      { path: "blink.ino" },
      { path: "other.ino" },
      { path: "package.json" },
    ],
  }, {
    fqbn: "esp32:esp32:esp32s3",
    profileId: "profile-a",
  });
  assert.equal(broadSnapshotValidation.accepted, false);
  assert.equal(broadSnapshotValidation.unsafeScope, true);
  assert.match(broadSnapshotValidation.reason, /whole workspace/);
  const workspaceCompiledValidation = boardCodeService.validateSourceSnapshotManifestForIdentity({
    metadata: {
      manifestVersion: 2,
      snapshotScope: "workspace-compiled",
      boardType: "esp32:esp32:esp32s3",
      profileId: "profile-a",
      workspacePath: "D:/project",
      sketchRoot: "D:/project",
      activeFileRelativePath: "README.md",
      entryFileName: "main.ino",
      compiledRootFiles: [".ino", ".pde", ".c", ".cpp", ".s", ".h", ".hh", ".hpp", ".ipp", ".tpp"],
      compiledDirectories: ["src"],
    },
    files: [
      { path: "main.ino" },
      { path: "blink.ino" },
      { path: "helper.cpp" },
      { path: "driver.c" },
      { path: "startup.s" },
      { path: "config.h" },
      { path: "templates.tpp" },
      { path: "src/led.cpp" },
      { path: "src/nested/util.hpp" },
    ],
  }, {
    fqbn: "esp32:esp32:esp32s3",
    profileId: "profile-a",
  });
  assert.equal(workspaceCompiledValidation.accepted, true);
  const unsafeWorkspaceCompiledValidation = boardCodeService.validateSourceSnapshotManifestForIdentity({
    metadata: {
      manifestVersion: 2,
      snapshotScope: "workspace-compiled",
      boardType: "esp32:esp32:esp32s3",
      profileId: "profile-a",
      workspacePath: "D:/project",
      sketchRoot: "D:/project",
    },
    files: [
      { path: "main.ino" },
      { path: "package.json" },
    ],
  }, {
    fqbn: "esp32:esp32:esp32s3",
    profileId: "profile-a",
  });
  assert.equal(unsafeWorkspaceCompiledValidation.accepted, false);
  assert.equal(unsafeWorkspaceCompiledValidation.unsafeScope, true);

  const files = normalizeSnapshotFiles([
    { path: "../Sketch/Sketch.ino", content: "void setup() {}\nvoid loop() {}\n" },
    { path: "Sketch/Sketch.ino", content: "duplicate ignored" },
    { path: "secret.bin", content: "ignored" },
    { path: "package.json", content: "{\"private\":true}\n" },
    { path: "lib/helper.hpp", content: "#pragma once\n" },
    { path: "templates/detail.tpp", content: "template <typename T> void use(T value) {}\n" },
  ]);
  assert.deepEqual(files.map((file) => file.path), ["Sketch/Sketch.ino", "lib/helper.hpp", "templates/detail.tpp"]);

  const snapshot = await boardCodeService.createSourceSnapshotZipBuffer({
    files: [
      { path: "Sketch/Sketch.ino", content: "void setup() {}\nvoid loop() {}\n" },
      { path: "Sketch/dirty.cpp", content: "int dirty = 1;\n" },
      { path: "unsaved.ino", content: "void setup() {}\n" },
    ],
    metadata: { boardName: "Smoke board" },
  });
  const restored = await boardCodeService.readZipEntriesFromBuffer(snapshot.buffer);
  assert.equal(restored.manifest.metadata.boardName, "Smoke board");
  assert.deepEqual(restored.files.map((file) => file.path).sort(), ["Sketch/Sketch.ino", "Sketch/dirty.cpp", "unsaved.ino"]);

  assert.equal(boardCodeService.sanitizeRelativePath("../../bad/name?.ino"), "bad/name-.ino");
  assert.match(boardCodeService.defaultExtractionFolderName("My Board/One"), /^My-Board-One-\d{8}T\d{6}Z$/);

  const espBuffer = Buffer.alloc(0x24000, 0xff);
  espPartitionEntry({ type: 0x01, subtype: 0x02, offset: 0x9000, size: 0x5000, label: "nvs" }).copy(espBuffer, 0x8000);
  espPartitionEntry({ type: 0x01, subtype: 0x00, offset: 0xe000, size: 0x2000, label: "otadata" }).copy(espBuffer, 0x8020);
  espPartitionEntry({ type: 0x00, subtype: 0x10, offset: 0x10000, size: 0x10000, label: "ota_0" }).copy(espBuffer, 0x8040);
  espPartitionEntry({ type: 0x00, subtype: 0x11, offset: 0x20000, size: 0x10000, label: "ota_1" }).copy(espBuffer, 0x8060);
  espBuffer.writeUInt32LE(2, 0xe000);
  espBuffer.writeUInt32LE(2, 0xe000 + 24);
  espBuffer.writeUInt32LE(0, 0xe000 + 28);
  writeEspImage(espBuffer, 0x20000);

  const partitionTable = parseEspPartitionTable(espBuffer, 0x8000);
  assert.equal(partitionTable.entries.length, 4);
  assert.equal(partitionTable.entries[2].subtypeName, "ota_0");
  const selection = selectEspAppPartition(espBuffer, partitionTable.entries);
  assert.equal(selection.selected.label, "ota_1");
  assert.match(selection.reason, /otadata sequence 2/);
  const appImage = parseEspImage(espBuffer, selection.selected);
  assert.equal(appImage.valid, true);
  assert.equal(appImage.header.segmentCount, 1);
  assert.equal(appImage.segments[0].executable, true);
  assert.equal(appImage.segments[0].loadAddress, 0x42000000);

  const markerChecksum = "a".repeat(64);
  const markerLiteral = `TANTALUM_SOURCE_SNAPSHOT_V1::source_marker1234::${markerChecksum}::END`;
  const markerInput = { markerId: "source_marker1234", snapshotChecksum: markerChecksum };
  assert.equal(sourceRestoreMarkerLiteral(markerInput), markerLiteral);
  const markerFile = buildSourceRestoreMarkerFile(markerInput);
  assert.match(markerFile, /TANTALUM_SOURCE_SNAPSHOT_MARKER_SINK/);
  assert.match(markerFile, /const volatile char \*marker/);
  assert.match(markerFile, /marker\[index\] != '\\0'/);

  const markerBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "tantalum-marker-smoke-"));
  try {
    fs.writeFileSync(path.join(markerBuildDir, "sketch.bin"), Buffer.concat([
      Buffer.from("noise\0", "ascii"),
      Buffer.from(markerLiteral, "ascii"),
      Buffer.from("\0tail", "ascii"),
    ]));
    const compiledMarkerScan = scanCompiledArtifactsForSourceRestoreMarker(markerBuildDir, markerInput);
    assert.equal(compiledMarkerScan.requested, true);
    assert.equal(compiledMarkerScan.embedded, true);
    fs.writeFileSync(path.join(markerBuildDir, "missing.bin"), Buffer.from("without marker", "ascii"));
    fs.rmSync(path.join(markerBuildDir, "sketch.bin"), { force: true });
    const missingCompiledMarkerScan = scanCompiledArtifactsForSourceRestoreMarker(markerBuildDir, markerInput);
    assert.equal(missingCompiledMarkerScan.embedded, false);
    fs.writeFileSync(path.join(markerBuildDir, "sketch.hex"), [
      intelHexRecord(0, 0, Buffer.from(markerLiteral, "ascii")),
      intelHexRecord(0, 1),
      "",
    ].join("\n"));
    const hexMarkerScan = scanCompiledArtifactsForSourceRestoreMarker(markerBuildDir, markerInput);
    assert.equal(hexMarkerScan.embedded, true);
  } finally {
    fs.rmSync(markerBuildDir, { recursive: true, force: true });
  }

  const markerScan = extractSourceRestoreMarkersFromBuffer(Buffer.from(`noise ${markerLiteral} tail`, "latin1"), { scope: "unit" });
  assert.equal(markerScan.status, "found");
  assert.equal(markerScan.marker.markerId, "source_marker1234");
  assert.equal(markerScan.marker.snapshotChecksum, markerChecksum);
  const ambiguousMarkerScan = extractSourceRestoreMarkersFromBuffer(Buffer.from([
    markerLiteral,
    `TANTALUM_SOURCE_SNAPSHOT_V1::source_other1234::${"b".repeat(64)}::END`,
  ].join("\n"), "latin1"));
  assert.equal(ambiguousMarkerScan.status, "ambiguous");

  const shortEspBuffer = espBuffer.subarray(0, 0x12000);
  const readbackPlan = planEspAppReadback(shortEspBuffer, {});
  assert.equal(readbackPlan.selection.selected.label, "ota_1");
  assert.equal(readbackPlan.requiredBytes, 0x30000);
  const invalidImage = parseEspImage(Buffer.alloc(0x12000, 0xff), { offset: 0x10000, size: 0x10000, end: 0x20000, label: "factory" });
  assert.equal(invalidImage.valid, false);
  assert.equal(espObjdumpNames({}, "esp32:esp32:esp32s3")[0], process.platform === "win32" ? "xtensa-esp32s3-elf-objdump.exe" : "xtensa-esp32s3-elf-objdump");

  const staleMarkerBuffer = Buffer.alloc(0x24000, 0xff);
  espPartitionEntry({ type: 0x00, subtype: 0x00, offset: 0x10000, size: 0x10000, label: "factory" }).copy(staleMarkerBuffer, 0x8000);
  writeEspImage(staleMarkerBuffer, 0x10000, { data: Buffer.from("APP-WITHOUT-MARKER\0", "ascii") });
  Buffer.from(markerLiteral, "ascii").copy(staleMarkerBuffer, 0x10100);
  const staleEsp = boardCodeService._test.createEspAnalysis(staleMarkerBuffer, {});
  const staleScan = extractSourceRestoreMarkersFromEvidence({ buffer: staleMarkerBuffer, family: "esp", esp: staleEsp });
  assert.equal(staleScan.status, "missing");
  const activeMarkerBuffer = Buffer.alloc(0x24000, 0xff);
  espPartitionEntry({ type: 0x00, subtype: 0x00, offset: 0x10000, size: 0x10000, label: "factory" }).copy(activeMarkerBuffer, 0x8000);
  writeEspImage(activeMarkerBuffer, 0x10000, { data: Buffer.from(`${markerLiteral}\0`, "ascii") });
  const activeEsp = boardCodeService._test.createEspAnalysis(activeMarkerBuffer, {});
  const activeScan = extractSourceRestoreMarkersFromEvidence({ buffer: activeMarkerBuffer, family: "esp", esp: activeEsp });
  assert.equal(activeScan.status, "found");
  assert.equal(activeScan.marker.markerId, "source_marker1234");

  const artifactReadme = boardCodeService.createExtractionReadme({
    boardName: "ESP board",
    board: "esp32:esp32:esp32s3",
    source: "hardware-binary",
    warnings: ["Compiled firmware cannot be converted back into exact Arduino source."],
    notes: "Firmware readback succeeded.",
    limitations: "Exact source cannot be recovered from a binary dump.",
  });
  assert.match(artifactReadme, /Compiled firmware cannot be converted back into exact source/);
  assert.match(artifactReadme, /Compiled firmware cannot be converted back into exact Arduino source/);

  console.log("board-code service smoke passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

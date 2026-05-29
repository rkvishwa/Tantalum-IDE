const assert = require("node:assert/strict");

const boardCodeService = require("../src/services/boardCodeService");

const { boardFamilyFromFqbn, espFlashSizeBytes, normalizeSnapshotFiles, parseProperties } = boardCodeService._test;

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

  const files = normalizeSnapshotFiles([
    { path: "../Sketch/Sketch.ino", content: "void setup() {}\nvoid loop() {}\n" },
    { path: "Sketch/Sketch.ino", content: "duplicate ignored" },
    { path: "secret.bin", content: "ignored" },
    { path: "lib/helper.hpp", content: "#pragma once\n" },
  ]);
  assert.deepEqual(files.map((file) => file.path), ["Sketch/Sketch.ino", "lib/helper.hpp"]);

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

  console.log("board-code service smoke passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

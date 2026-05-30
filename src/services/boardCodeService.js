const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const yauzl = require("yauzl");
const yazl = require("yazl");

const { getArduinoCliEnv, getCliPath } = require("../../arduinoHandler");

const SOURCE_HISTORY_KEY = "boardCodeSourceHistory";
const SOURCE_HISTORY_LIMIT = 100;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_FILE_BYTES = 512 * 1024;
const MAX_AI_FILES = 20;
const MAX_FLASH_BYTES = 16 * 1024 * 1024;
const DEFAULT_ESP_FLASH_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const PRINTABLE_STRING_LIMIT = 400;
const PRINTABLE_STRING_MAX_CHARS = 24000;
const MAX_DISASSEMBLY_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DISASSEMBLY_EXCERPT_CHARS = 64000;
const MAX_HEXDUMP_EXCERPT_BYTES = 16 * 1024;
const ESP_DISASSEMBLY_SLICE_BYTES = 128 * 1024;
const ESP_PARTITION_TABLE_DEFAULT_OFFSET = 0x8000;
const ESP_PARTITION_TABLE_BYTES = 0x1000;
const ESP_PARTITION_ENTRY_SIZE = 32;
const ESP_PARTITION_MAGIC = 0x50aa;
const ESP_PARTITION_MD5_MAGIC = 0xebeb;
const ESP_IMAGE_MAGIC = 0xe9;
const ESP_IMAGE_MAX_SEGMENTS = 16;
const SOURCE_RESTORE_MARKER_PREFIX = "TANTALUM_SOURCE_SNAPSHOT_V1";
const SOURCE_RESTORE_MARKER_REGEX = /TANTALUM_SOURCE_SNAPSHOT_V1::(source_[A-Za-z0-9_-]{8,80})::([a-fA-F0-9]{64})::END/g;

const SOURCE_EXTENSIONS = new Set([
  ".ino",
  ".pde",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".ipp",
  ".tpp",
  ".s",
  ".asm",
]);

const WORKSPACE_COMPILED_SNAPSHOT_ROOT_EXTENSIONS = new Set([
  ".ino",
  ".pde",
  ".c",
  ".cpp",
  ".s",
  ".h",
  ".hh",
  ".hpp",
  ".ipp",
  ".tpp",
]);
const WORKSPACE_COMPILED_SNAPSHOT_DIRECTORIES = new Set(["src"]);
const SOURCE_SNAPSHOT_PROJECT_ROOT_MARKERS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.main.json",
  "tsconfig.preload.json",
  "vite.config.ts",
  "vite.config.js",
  "appwrite.config.json",
  "electron-builder.json",
]);
const SOURCE_SNAPSHOT_SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".tantalum-trash",
  ".tantalum-file-tree-trash",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".vite",
  "out",
  "target",
  "extracted-board-code",
]);

function normalizeText(value, maxLength = 512) {
  return String(value || "").trim().slice(0, maxLength);
}

function sanitizeName(value, fallback = "board-code") {
  const normalized = normalizeText(value, 120)
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function defaultExtractionFolderName(boardName) {
  return `${sanitizeName(boardName || "board")}-${timestampSlug()}`;
}

function sanitizeRelativePath(value, fallback = "sketch.ino") {
  const raw = normalizeText(value, 512).replace(/\\/g, "/");
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "." && part !== "..")
    .map((part) => sanitizeName(part, "file"));
  const joined = parts.join("/");
  return joined || fallback;
}

function isSupportedSourcePath(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension);
}

function normalizeSnapshotFiles(files = []) {
  const seen = new Set();
  const normalized = [];
  let totalBytes = 0;

  for (const file of Array.isArray(files) ? files : []) {
    const relativePath = sanitizeRelativePath(file?.path || file?.relativePath || file?.name);
    if (!isSupportedSourcePath(relativePath)) {
      continue;
    }

    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    const content = String(file?.content ?? "");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SOURCE_FILE_BYTES || totalBytes + bytes > MAX_SOURCE_SNAPSHOT_BYTES) {
      continue;
    }

    seen.add(key);
    totalBytes += bytes;
    normalized.push({
      path: relativePath,
      content,
      size: bytes,
      checksum: sha256Hex(Buffer.from(content, "utf8")),
    });
  }

  return normalized;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseSourceRestoreMarkersFromText(text = "") {
  const markers = [];
  const seen = new Set();
  SOURCE_RESTORE_MARKER_REGEX.lastIndex = 0;
  let match;
  while ((match = SOURCE_RESTORE_MARKER_REGEX.exec(String(text || "")))) {
    const marker = {
      markerId: match[1],
      snapshotChecksum: match[2].toLowerCase(),
      index: match.index,
      literal: match[0],
    };
    const key = `${marker.markerId}:${marker.snapshotChecksum}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    markers.push(marker);
  }
  return markers;
}

function extractSourceRestoreMarkersFromBuffer(buffer, context = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      status: "missing",
      reason: "No firmware bytes were available to scan for a Tantalum source marker.",
      markers: [],
      marker: null,
      scannedBytes: 0,
      scope: context.scope || "unknown",
      baseAddress: context.baseAddress ?? null,
    };
  }

  const markers = parseSourceRestoreMarkersFromText(buffer.toString("latin1"));
  if (markers.length === 0) {
    return {
      status: "missing",
      reason: "No Tantalum source marker was found in the active firmware image.",
      markers,
      marker: null,
      scannedBytes: buffer.length,
      scope: context.scope || "unknown",
      baseAddress: context.baseAddress ?? null,
    };
  }
  if (markers.length > 1) {
    return {
      status: "ambiguous",
      reason: "Multiple different Tantalum source markers were found in the active firmware image.",
      markers,
      marker: null,
      scannedBytes: buffer.length,
      scope: context.scope || "unknown",
      baseAddress: context.baseAddress ?? null,
    };
  }
  return {
    status: "found",
    reason: "Tantalum source marker found in the active firmware image.",
    markers,
    marker: markers[0],
    scannedBytes: buffer.length,
    scope: context.scope || "unknown",
    baseAddress: context.baseAddress ?? null,
  };
}

function extractSourceRestoreMarkersFromEvidence({ buffer, family = "", esp = null, baseAddress = 0 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return extractSourceRestoreMarkersFromBuffer(Buffer.alloc(0), { scope: "none", baseAddress });
  }

  if (family === "esp") {
    const selected = esp?.selectedAppPartition;
    const image = esp?.appImage;
    if (!selected || !image?.valid || !Number.isFinite(Number(image.imageLength))) {
      return {
        status: "missing",
        reason: "No valid ESP app image was available for source marker scanning.",
        markers: [],
        marker: null,
        scannedBytes: 0,
        scope: "esp-app-image",
        baseAddress: selected?.offset ?? null,
      };
    }
    const imageStart = Math.max(0, Number(selected.offset) || 0);
    const imageEnd = Math.min(buffer.length, imageStart + Math.max(0, Number(image.imageLength) || 0));
    if (imageEnd <= imageStart) {
      return {
        status: "missing",
        reason: "The selected ESP app image was outside the firmware dump.",
        markers: [],
        marker: null,
        scannedBytes: 0,
        scope: "esp-app-image",
        baseAddress: imageStart,
      };
    }
    return extractSourceRestoreMarkersFromBuffer(buffer.subarray(imageStart, imageEnd), {
      scope: "esp-app-image",
      baseAddress: imageStart,
    });
  }

  return extractSourceRestoreMarkersFromBuffer(buffer, {
    scope: family === "avr" ? "avr-flash-image" : "firmware-image",
    baseAddress,
  });
}

async function createSourceSnapshotZipBuffer({ files, metadata = {} }) {
  const normalizedFiles = normalizeSnapshotFiles(files);
  if (normalizedFiles.length === 0) {
    throw new Error("No supported source files were available for the snapshot.");
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    metadata,
    files: normalizedFiles.map(({ path: filePath, size, checksum }) => ({ path: filePath, size, checksum })),
  };

  const zipBuffer = await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    let totalBytes = 0;

    zip.outputStream.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_SOURCE_SNAPSHOT_BYTES * 1.25) {
        reject(new Error("Source snapshot archive is too large."));
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);

    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "tantalum-source-manifest.json");
    for (const file of normalizedFiles) {
      zip.addBuffer(Buffer.from(file.content, "utf8"), file.path);
    }
    zip.end();
  });

  return {
    buffer: zipBuffer,
    manifest,
    checksum: sha256Hex(zipBuffer),
  };
}

async function readZipEntriesFromBuffer(buffer) {
  return await new Promise((resolve, reject) => {
    const files = [];
    let manifest = null;
    let totalBytes = 0;

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }

      zipFile.readEntry();
      zipFile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }

        const relativePath = sanitizeRelativePath(entry.fileName);
        zipFile.openReadStream(entry, (streamError, readStream) => {
          if (streamError) {
            reject(streamError);
            return;
          }

          const chunks = [];
          readStream.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_SOURCE_SNAPSHOT_BYTES) {
              reject(new Error("Source snapshot archive is too large to restore."));
              readStream.destroy();
              return;
            }
            chunks.push(chunk);
          });
          readStream.on("end", () => {
            const content = Buffer.concat(chunks).toString("utf8");
            if (relativePath === "tantalum-source-manifest.json") {
              try {
                manifest = JSON.parse(content);
              } catch {
                manifest = null;
              }
            } else if (isSupportedSourcePath(relativePath)) {
              files.push({ path: relativePath, content });
            }
            zipFile.readEntry();
          });
          readStream.on("error", reject);
        });
      });
      zipFile.on("end", () => resolve({ files, manifest }));
      zipFile.on("error", reject);
    });
  });
}

function parseProperties(properties = []) {
  const result = {};
  for (const line of Array.isArray(properties) ? properties : []) {
    const text = String(line || "");
    const separator = text.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    result[text.slice(0, separator)] = text.slice(separator + 1);
  }
  return result;
}

function boardFamilyFromFqbn(fqbn = "", properties = {}) {
  const normalized = String(fqbn || "").toLowerCase();
  const arch = String(properties["build.arch"] || "").toLowerCase();
  if (normalized.startsWith("esp32:") || normalized.startsWith("esp8266:") || arch.includes("esp")) {
    return "esp";
  }
  if (normalized.includes(":avr:") || arch === "avr" || properties["upload.tool"] === "avrdude") {
    return "avr";
  }
  return "unknown";
}

function parseByteSize(value, fallback = 0) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return fallback;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }

  const match = text.match(/(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb)?/i);
  if (!match) {
    return fallback;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallback;
  }

  const unit = match[2] || "";
  if (unit.startsWith("g")) {
    return Math.floor(amount * 1024 * 1024 * 1024);
  }
  if (unit.startsWith("m")) {
    return Math.floor(amount * 1024 * 1024);
  }
  if (unit.startsWith("k")) {
    return Math.floor(amount * 1024);
  }
  return Math.floor(amount);
}

function espFlashSizeBytes(properties = {}) {
  const candidates = [
    properties["upload.flash_size"],
    properties["build.flash_size"],
    properties["build.partitions"],
    properties["upload.maximum_size"],
  ];

  for (const candidate of candidates) {
    const parsed = parseByteSize(candidate, 0);
    if (parsed > 0) {
      return Math.min(Math.max(parsed, 512 * 1024), MAX_FLASH_BYTES);
    }
  }

  return DEFAULT_ESP_FLASH_BYTES;
}

function runExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeout || COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
      env: options.env || getArduinoCliEnv(),
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readBoardDetails(fqbn) {
  const { stdout } = await runExecFile(getCliPath(), [
    "board",
    "details",
    "--fqbn",
    fqbn,
    "--show-properties=expanded",
    "--json",
  ], { timeout: 60000 });

  const details = JSON.parse(stdout || "{}");
  const properties = parseProperties(details.build_properties);
  return {
    details,
    properties,
    family: boardFamilyFromFqbn(fqbn, properties),
  };
}

function findToolExecutable(toolRoot, names) {
  const root = normalizeText(toolRoot, 1024);
  if (!root || !fs.existsSync(root)) {
    return "";
  }

  const queue = [root];
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
      if (names.some((name) => entry.name.toLowerCase() === name.toLowerCase())) {
        return entryPath;
      }
    }
  }

  return "";
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 1024)).filter(Boolean)));
}

function toolRootsFromProperties(properties = {}, preferredKeys = []) {
  const preferred = preferredKeys.map((key) => properties[key]);
  const discovered = Object.entries(properties)
    .filter(([key, value]) => value && (/^runtime\.tools\..*\.path$/.test(key) || /^tools\..*\.path$/.test(key)))
    .map(([, value]) => value);
  return uniqueValues([...preferred, ...discovered]);
}

function findToolExecutableInRoots(roots = [], names = []) {
  const normalizedRoots = uniqueValues(roots);
  for (const name of names) {
    for (const root of normalizedRoots) {
      const executable = findToolExecutable(root, [name]);
      if (executable) {
        return executable;
      }
    }
  }
  return "";
}

function espObjdumpNames(properties = {}, fqbn = "") {
  const normalized = String(fqbn || "").toLowerCase();
  const arch = String(properties["build.arch"] || "").toLowerCase();
  const isRiscv = /\b(?:riscv|esp32c2|esp32c3|esp32c5|esp32c6|esp32h2|esp32p4)\b/.test(`${normalized} ${arch}`);
  const isS3 = /\besp32s3\b/.test(`${normalized} ${arch}`);
  const isS2 = /\besp32s2\b/.test(`${normalized} ${arch}`);
  const baseNames = isRiscv
    ? ["riscv32-esp-elf-objdump"]
    : normalized.startsWith("esp8266:")
      ? ["xtensa-lx106-elf-objdump"]
      : isS3
        ? ["xtensa-esp32s3-elf-objdump", "xtensa-esp32-elf-objdump", "xtensa-esp32s2-elf-objdump", "xtensa-lx106-elf-objdump", "riscv32-esp-elf-objdump"]
        : isS2
          ? ["xtensa-esp32s2-elf-objdump", "xtensa-esp32-elf-objdump", "xtensa-esp32s3-elf-objdump", "xtensa-lx106-elf-objdump", "riscv32-esp-elf-objdump"]
          : ["xtensa-esp32-elf-objdump", "xtensa-esp32s3-elf-objdump", "xtensa-esp32s2-elf-objdump", "xtensa-lx106-elf-objdump", "riscv32-esp-elf-objdump"];
  return process.platform === "win32"
    ? baseNames.flatMap((name) => [`${name}.exe`, name])
    : baseNames;
}

function findObjdumpTool(properties = {}, family = "unknown", fqbn = "") {
  if (family === "avr") {
    return findToolExecutableInRoots(toolRootsFromProperties(properties, [
      "runtime.tools.avr-gcc.path",
      "tools.avr-gcc.path",
    ]), process.platform === "win32" ? ["avr-objdump.exe", "avr-objdump"] : ["avr-objdump"]);
  }

  if (family === "esp") {
    return findToolExecutableInRoots(toolRootsFromProperties(properties, [
      "runtime.tools.xtensa-esp32-elf-gcc.path",
      "runtime.tools.xtensa-esp32s2-elf-gcc.path",
      "runtime.tools.xtensa-esp32s3-elf-gcc.path",
      "runtime.tools.xtensa-lx106-elf-gcc.path",
      "runtime.tools.riscv32-esp-elf-gcc.path",
      "tools.xtensa-esp32-elf-gcc.path",
      "tools.xtensa-esp32s2-elf-gcc.path",
      "tools.xtensa-esp32s3-elf-gcc.path",
      "tools.xtensa-lx106-elf-gcc.path",
      "tools.riscv32-esp-elf-gcc.path",
    ]), espObjdumpNames(properties, fqbn));
  }

  return "";
}

function objdumpMachineCandidates(objdumpPath = "", properties = {}, fqbn = "") {
  const name = path.basename(objdumpPath).toLowerCase();
  const normalized = `${String(fqbn || "").toLowerCase()} ${String(properties["build.arch"] || "").toLowerCase()}`;
  if (name.includes("riscv") || /\b(?:riscv|esp32c2|esp32c3|esp32c5|esp32c6|esp32h2|esp32p4)\b/.test(normalized)) {
    return ["riscv:rv32", "riscv"];
  }
  if (name.includes("xtensa") || /esp32|esp8266/.test(normalized)) {
    return ["xtensa"];
  }
  return ["binary"];
}

function findEspTool(properties = {}) {
  const candidates = [
    properties["runtime.tools.esptool_py.path"],
    properties["runtime.tools.esptool.path"],
    properties["tools.esptool_py.path"],
  ];
  const binaryNames = process.platform === "win32"
    ? ["esptool.exe", "esptool.py", "esptool"]
    : ["esptool", "esptool.py"];

  for (const candidate of candidates) {
    const executable = findToolExecutable(candidate, binaryNames);
    if (executable) {
      return executable;
    }
  }

  return "";
}

async function readEspFlash({ port, properties, outputDir, onProgress }) {
  const esptool = findEspTool(properties);
  if (!esptool) {
    throw new Error("ESP readback requires the ESP board package tool esptool to be installed.");
  }

  const flashBytes = espFlashSizeBytes(properties);
  const dumpPath = path.join(outputDir, "firmware-dump.bin");
  const readbackRanges = [];
  onProgress?.({ phase: "read-flash", message: `Reading ${flashBytes} bytes with esptool...`, progress: 35 });
  const args = ["--port", port, "--baud", "921600", "read_flash", "0x0", String(flashBytes), dumpPath];
  const { stdout, stderr } = await runExecFile(esptool, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
  let commandOutput = `${stdout || ""}\n${stderr || ""}`.trim();
  let buffer = await fsPromises.readFile(dumpPath);
  readbackRanges.push({ offset: 0, size: buffer.length, reason: "initial" });

  const partitionPlan = planEspAppReadback(buffer, properties);
  if (partitionPlan.requiredBytes > buffer.length && partitionPlan.requiredBytes <= MAX_FLASH_BYTES) {
    onProgress?.({ phase: "read-flash", message: `Reading ESP app partition range (${partitionPlan.requiredBytes} bytes)...`, progress: 45 });
    const appArgs = ["--port", port, "--baud", "921600", "read_flash", "0x0", String(partitionPlan.requiredBytes), dumpPath];
    const secondRead = await runExecFile(esptool, appArgs, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    commandOutput = [commandOutput, secondRead.stdout || "", secondRead.stderr || ""].filter(Boolean).join("\n").trim();
    buffer = await fsPromises.readFile(dumpPath);
    readbackRanges.push({ offset: 0, size: buffer.length, reason: "selected-app-partition" });
  }

  return {
    format: "bin",
    path: dumpPath,
    filename: "firmware-dump.bin",
    size: buffer.length,
    checksum: sha256Hex(buffer),
    commandOutput,
    readbackRanges,
  };
}

function espPartitionTableOffset(properties = {}) {
  const candidates = [
    properties["build.partitions_offset"],
    properties["build.partition_table_offset"],
    properties["partition_table.offset"],
    properties["upload.partition_table_offset"],
  ];
  for (const candidate of candidates) {
    const parsed = parseByteSize(candidate, 0);
    if (parsed > 0 && parsed < MAX_FLASH_BYTES) {
      return parsed;
    }
  }
  return ESP_PARTITION_TABLE_DEFAULT_OFFSET;
}

function readNullTerminatedAscii(buffer) {
  const zeroIndex = buffer.indexOf(0);
  const end = zeroIndex >= 0 ? zeroIndex : buffer.length;
  return buffer.subarray(0, end).toString("ascii").replace(/[^\x20-\x7E]/g, "").trim();
}

function espPartitionSubtypeName(type, subtype, label = "") {
  if (type === 0x00) {
    if (subtype === 0x00) {
      return "factory";
    }
    if (subtype >= 0x10 && subtype <= 0x1f) {
      return `ota_${subtype - 0x10}`;
    }
    if (subtype === 0x20) {
      return "test";
    }
    return label || `app_0x${subtype.toString(16)}`;
  }
  if (type === 0x01) {
    if (subtype === 0x00 || label === "otadata") {
      return "otadata";
    }
    if (subtype === 0x01) {
      return "phy";
    }
    if (subtype === 0x02) {
      return "nvs";
    }
    return label || `data_0x${subtype.toString(16)}`;
  }
  return label || `type_0x${type.toString(16)}_0x${subtype.toString(16)}`;
}

function parseEspPartitionTable(buffer, tableOffset = ESP_PARTITION_TABLE_DEFAULT_OFFSET) {
  const entries = [];
  const errors = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < tableOffset + ESP_PARTITION_ENTRY_SIZE) {
    return { offset: tableOffset, entries, errors: ["Partition table is outside the firmware dump."] };
  }

  const end = Math.min(buffer.length, tableOffset + ESP_PARTITION_TABLE_BYTES);
  for (let cursor = tableOffset; cursor + ESP_PARTITION_ENTRY_SIZE <= end; cursor += ESP_PARTITION_ENTRY_SIZE) {
    const entryBuffer = buffer.subarray(cursor, cursor + ESP_PARTITION_ENTRY_SIZE);
    if (entryBuffer.every((byte) => byte === 0xff) || entryBuffer.every((byte) => byte === 0x00)) {
      break;
    }

    const magic = entryBuffer.readUInt16LE(0);
    if (magic === ESP_PARTITION_MD5_MAGIC) {
      break;
    }
    if (magic !== ESP_PARTITION_MAGIC) {
      if (entries.length === 0) {
        errors.push(`Invalid partition table magic 0x${magic.toString(16)} at 0x${cursor.toString(16)}.`);
      }
      break;
    }

    const type = entryBuffer.readUInt8(2);
    const subtype = entryBuffer.readUInt8(3);
    const offset = entryBuffer.readUInt32LE(4);
    const size = entryBuffer.readUInt32LE(8);
    const label = readNullTerminatedAscii(entryBuffer.subarray(12, 28));
    const flags = entryBuffer.readUInt32LE(28);
    if (offset <= 0 || size <= 0 || offset > MAX_FLASH_BYTES * 2) {
      errors.push(`Ignored invalid ESP partition ${label || entries.length} at table offset 0x${cursor.toString(16)}.`);
      continue;
    }
    entries.push({
      index: entries.length,
      tableOffset: cursor,
      type,
      subtype,
      typeName: type === 0x00 ? "app" : type === 0x01 ? "data" : `0x${type.toString(16)}`,
      subtypeName: espPartitionSubtypeName(type, subtype, label),
      label,
      offset,
      size,
      end: offset + size,
      flags,
    });
  }

  return { offset: tableOffset, entries, errors };
}

function isEspAppPartition(partition) {
  return partition?.type === 0x00
    && (partition.subtype === 0x00 || (partition.subtype >= 0x10 && partition.subtype <= 0x1f) || partition.subtype === 0x20);
}

function isEspOtaDataPartition(partition) {
  return partition?.type === 0x01 && (partition.subtype === 0x00 || partition.label === "otadata" || partition.subtypeName === "otadata");
}

function parseEspOtaSelectEntries(buffer, partition) {
  if (!partition || buffer.length < partition.offset + 32) {
    return [];
  }
  const entries = [];
  const sectorSize = 0x1000;
  const sectors = Math.max(1, Math.min(2, Math.floor(partition.size / sectorSize) || 1));
  for (let index = 0; index < sectors; index += 1) {
    const offset = partition.offset + index * sectorSize;
    if (offset + 32 > buffer.length) {
      continue;
    }
    const otaSeq = buffer.readUInt32LE(offset);
    const otaState = buffer.readUInt32LE(offset + 24);
    const crc = buffer.readUInt32LE(offset + 28);
    const erased = otaSeq === 0xffffffff && otaState === 0xffffffff && crc === 0xffffffff;
    const usable = !erased && otaSeq > 0 && otaSeq !== 0xffffffff && ![3, 4].includes(otaState);
    entries.push({
      index,
      offset,
      otaSeq,
      otaState,
      crc,
      usable,
    });
  }
  return entries;
}

function selectEspAppPartition(buffer, partitions) {
  const appPartitions = partitions.filter(isEspAppPartition).sort((left, right) => left.offset - right.offset);
  const otaPartitions = appPartitions.filter((partition) => partition.subtype >= 0x10 && partition.subtype <= 0x1f);
  const otaDataPartition = partitions.find(isEspOtaDataPartition) || null;
  const otaEntries = parseEspOtaSelectEntries(buffer, otaDataPartition);
  const usableOta = otaEntries.filter((entry) => entry.usable).sort((left, right) => right.otaSeq - left.otaSeq);
  if (usableOta.length > 0 && otaPartitions.length > 0) {
    const otaIndex = (usableOta[0].otaSeq - 1) % otaPartitions.length;
    const selected = otaPartitions.find((partition) => partition.subtype === 0x10 + otaIndex) || otaPartitions[otaIndex] || null;
    if (selected) {
      return {
        selected,
        appPartitions,
        otaDataPartition,
        otaEntries,
        reason: `Selected ${selected.subtypeName} from otadata sequence ${usableOta[0].otaSeq}.`,
      };
    }
  }

  for (const partition of appPartitions) {
    const image = parseEspImage(buffer, partition);
    if (image.valid) {
      return {
        selected: partition,
        appPartitions,
        otaDataPartition,
        otaEntries,
        reason: `Selected first valid ESP app image: ${partition.label || partition.subtypeName}.`,
      };
    }
  }

  return {
    selected: appPartitions[0] || null,
    appPartitions,
    otaDataPartition,
    otaEntries,
    reason: appPartitions.length ? "No valid ESP app image was found; selected first app partition for diagnostics." : "No ESP app partition was found.",
  };
}

function planEspAppReadback(buffer, properties = {}) {
  const tableOffset = espPartitionTableOffset(properties);
  const partitionTable = parseEspPartitionTable(buffer, tableOffset);
  const selection = selectEspAppPartition(buffer, partitionTable.entries);
  const selected = selection.selected;
  const requiredBytes = selected ? Math.min(Math.max(buffer.length, selected.end), MAX_FLASH_BYTES) : buffer.length;
  return {
    tableOffset,
    partitionTable,
    selection,
    requiredBytes,
  };
}

function isEspExecutableAddress(address) {
  return (address >= 0x40000000 && address < 0x50000000) || (address >= 0x42000000 && address < 0x43000000);
}

function parseEspImageWithHeaderLength(buffer, partition, headerLength) {
  const baseOffset = partition?.offset || 0;
  if (!partition || !Buffer.isBuffer(buffer) || buffer.length < baseOffset + headerLength) {
    return { valid: false, error: "ESP app image is outside the firmware dump." };
  }
  if (buffer.readUInt8(baseOffset) !== ESP_IMAGE_MAGIC) {
    return { valid: false, error: `ESP app image magic was not 0x${ESP_IMAGE_MAGIC.toString(16)}.` };
  }

  const segmentCount = buffer.readUInt8(baseOffset + 1);
  if (segmentCount <= 0 || segmentCount > ESP_IMAGE_MAX_SEGMENTS) {
    return { valid: false, error: `ESP app image segment count ${segmentCount} is invalid.` };
  }

  const segments = [];
  let cursor = baseOffset + headerLength;
  const partitionEnd = Math.min(buffer.length, partition.offset + partition.size);
  for (let index = 0; index < segmentCount; index += 1) {
    if (cursor + 8 > partitionEnd) {
      return { valid: false, error: "ESP app image segment header exceeds partition bounds." };
    }
    const loadAddress = buffer.readUInt32LE(cursor);
    const length = buffer.readUInt32LE(cursor + 4);
    const dataOffset = cursor + 8;
    const dataEnd = dataOffset + length;
    if (length <= 0 || dataEnd > partitionEnd || dataEnd > buffer.length) {
      return { valid: false, error: "ESP app image segment data exceeds partition bounds." };
    }
    segments.push({
      index,
      loadAddress,
      length,
      fileOffset: dataOffset - baseOffset,
      flashOffset: dataOffset,
      executable: isEspExecutableAddress(loadAddress),
      classification: isEspExecutableAddress(loadAddress) ? "executable" : "data",
    });
    cursor = dataEnd;
  }

  return {
    valid: true,
    partition: {
      label: partition.label,
      subtypeName: partition.subtypeName,
      offset: partition.offset,
      size: partition.size,
      end: partition.end,
    },
    header: {
      magic: ESP_IMAGE_MAGIC,
      segmentCount,
      flashMode: buffer.readUInt8(baseOffset + 2),
      flashSizeFrequency: buffer.readUInt8(baseOffset + 3),
      entryPoint: buffer.readUInt32LE(baseOffset + 4),
      headerLength,
    },
    segments,
    executableSegmentCount: segments.filter((segment) => segment.executable).length,
    imageLength: cursor - baseOffset,
  };
}

function parseEspImage(buffer, partition) {
  const modern = parseEspImageWithHeaderLength(buffer, partition, 24);
  if (modern.valid) {
    return modern;
  }
  const legacy = parseEspImageWithHeaderLength(buffer, partition, 8);
  if (legacy.valid) {
    return legacy;
  }
  return {
    valid: false,
    error: modern.error || legacy.error || "ESP app image could not be parsed.",
    partition: partition
      ? {
          label: partition.label,
          subtypeName: partition.subtypeName,
          offset: partition.offset,
          size: partition.size,
          end: partition.end,
        }
      : null,
  };
}

function createEspAnalysis(buffer, properties = {}) {
  const tableOffset = espPartitionTableOffset(properties);
  const partitionTable = parseEspPartitionTable(buffer, tableOffset);
  const selection = selectEspAppPartition(buffer, partitionTable.entries);
  const selected = selection.selected;
  const appImage = selected ? parseEspImage(buffer, selected) : { valid: false, error: "No ESP app partition was selected." };
  const appPartitionBuffer = selected && buffer.length > selected.offset
    ? buffer.subarray(selected.offset, Math.min(buffer.length, selected.end))
    : Buffer.alloc(0);
  const appStrings = appImage.valid ? extractPrintableStrings(appPartitionBuffer) : [];

  return {
    partitionTableOffset: tableOffset,
    partitions: partitionTable.entries,
    partitionErrors: partitionTable.errors,
    appPartitions: selection.appPartitions,
    otaDataPartition: selection.otaDataPartition,
    otaEntries: selection.otaEntries,
    selectedAppPartition: selected,
    selectedAppReason: selection.reason,
    appImage,
    appPartitionSizeRead: appPartitionBuffer.length,
    appStrings,
    appEvidenceAvailable: Boolean(appImage.valid && (appImage.executableSegmentCount > 0 || appStrings.length > 0)),
  };
}

function findAvrDude(properties = {}) {
  const cmdPath = properties["tools.avrdude.cmd.path"];
  if (cmdPath && fs.existsSync(cmdPath)) {
    return cmdPath;
  }
  return findToolExecutable(properties["runtime.tools.avrdude.path"], [process.platform === "win32" ? "avrdude.exe" : "avrdude"]);
}

async function readAvrFlash({ port, properties, outputDir, onProgress }) {
  const avrdude = findAvrDude(properties);
  const configPath = properties["tools.avrdude.config.path"];
  const mcu = properties["build.mcu"];
  const protocol = properties["upload.protocol"] || "arduino";
  const speed = properties["upload.speed"];
  if (!avrdude || !configPath || !mcu || !protocol) {
    throw new Error("AVR readback requires avrdude, config path, MCU, and upload protocol properties.");
  }

  const dumpPath = path.join(outputDir, "firmware-dump.hex");
  const args = [
    `-C${configPath}`,
    `-p${mcu}`,
    `-c${protocol}`,
    `-P${port}`,
    ...(speed ? [`-b${speed}`] : []),
    "-D",
    `-Uflash:r:${dumpPath}:i`,
  ];
  onProgress?.({ phase: "read-flash", message: "Reading AVR flash with avrdude...", progress: 35 });
  const { stdout, stderr } = await runExecFile(avrdude, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
  const buffer = await fsPromises.readFile(dumpPath);
  return {
    format: "hex",
    path: dumpPath,
    filename: "firmware-dump.hex",
    size: buffer.length,
    checksum: sha256Hex(buffer),
    commandOutput: `${stdout || ""}\n${stderr || ""}`.trim(),
  };
}

function parseIntelHexToBinary(hexInput) {
  const text = Buffer.isBuffer(hexInput) ? hexInput.toString("utf8") : String(hexInput || "");
  const records = [];
  let baseAddress = 0;
  let minAddress = Number.POSITIVE_INFINITY;
  let maxAddress = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!line.startsWith(":") || line.length < 11) {
      throw new Error("Invalid Intel HEX record.");
    }

    const byteCount = Number.parseInt(line.slice(1, 3), 16);
    const offset = Number.parseInt(line.slice(3, 7), 16);
    const recordType = Number.parseInt(line.slice(7, 9), 16);
    const dataHex = line.slice(9, 9 + byteCount * 2);
    const checksum = Number.parseInt(line.slice(9 + byteCount * 2, 11 + byteCount * 2), 16);
    if (!Number.isFinite(byteCount) || !Number.isFinite(offset) || !Number.isFinite(recordType) || dataHex.length !== byteCount * 2 || !Number.isFinite(checksum)) {
      throw new Error("Invalid Intel HEX record.");
    }

    let sum = byteCount + (offset >> 8) + (offset & 0xff) + recordType + checksum;
    const data = Buffer.from(dataHex, "hex");
    for (const byte of data) {
      sum += byte;
    }
    if ((sum & 0xff) !== 0) {
      throw new Error("Intel HEX checksum mismatch.");
    }

    if (recordType === 0x00) {
      const absoluteAddress = baseAddress + offset;
      records.push({ address: absoluteAddress, data });
      minAddress = Math.min(minAddress, absoluteAddress);
      maxAddress = Math.max(maxAddress, absoluteAddress + data.length);
    } else if (recordType === 0x01) {
      break;
    } else if (recordType === 0x02 && data.length === 2) {
      baseAddress = data.readUInt16BE(0) << 4;
    } else if (recordType === 0x04 && data.length === 2) {
      baseAddress = data.readUInt16BE(0) << 16;
    }
  }

  if (!records.length || !Number.isFinite(minAddress) || maxAddress <= minAddress) {
    return { buffer: Buffer.alloc(0), baseAddress: 0 };
  }

  const buffer = Buffer.alloc(maxAddress - minAddress, 0xff);
  for (const record of records) {
    record.data.copy(buffer, record.address - minAddress);
  }
  return { buffer, baseAddress: minAddress };
}

async function firmwareEvidenceBuffer(dump = {}) {
  const rawBuffer = await fsPromises.readFile(dump.path);
  if (dump.format === "hex") {
    try {
      const parsed = parseIntelHexToBinary(rawBuffer);
      if (parsed.buffer.length > 0) {
        return {
          buffer: parsed.buffer,
          baseAddress: parsed.baseAddress,
          decoded: true,
          sourceFormat: "intel-hex",
        };
      }
    } catch {
      // Fall back to the raw file so artifacts still get written for inspection.
    }
  }
  return {
    buffer: rawBuffer,
    baseAddress: 0,
    decoded: false,
    sourceFormat: dump.format || "binary",
  };
}

function extractPrintableStrings(buffer) {
  const strings = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      continue;
    }

    if (current.length >= 4) {
      strings.push(current);
      if (strings.length >= PRINTABLE_STRING_LIMIT) {
        break;
      }
    }
    current = "";
  }
  if (current.length >= 4 && strings.length < PRINTABLE_STRING_LIMIT) {
    strings.push(current);
  }

  let totalChars = 0;
  const unique = [];
  const seen = new Set();
  for (const value of strings) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    totalChars += trimmed.length + 1;
    if (totalChars > PRINTABLE_STRING_MAX_CHARS) {
      break;
    }
    unique.push(trimmed);
  }
  return unique;
}

function createHexdumpExcerpt(buffer, baseAddress = 0, maxBytes = MAX_HEXDUMP_EXCERPT_BYTES) {
  const bytes = buffer.subarray(0, Math.min(buffer.length, maxBytes));
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hex = Array.from(chunk).map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = Array.from(chunk).map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${(baseAddress + offset).toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (buffer.length > bytes.length) {
    lines.push(`... truncated ${buffer.length - bytes.length} additional bytes`);
  }
  return lines.join("\n");
}

function compactDisassemblyText(text, maxChars = MAX_DISASSEMBLY_EXCERPT_CHARS) {
  const normalizedLines = [];
  let totalChars = 0;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/g, "");
    if (!line.trim()) {
      continue;
    }
    const lowered = line.toLowerCase();
    if (lowered.includes("file format") || lowered.startsWith("disassembly of section")) {
      normalizedLines.push(line);
      totalChars += line.length + 1;
      continue;
    }
    if (!/^\s*(?:[0-9a-f]+:|[0-9a-f]+\s+<[^>]+>:|;|[._$a-zA-Z][\w.$-]*:)/.test(line)) {
      continue;
    }
    if (totalChars + line.length + 1 > maxChars) {
      normalizedLines.push("... truncated disassembly excerpt");
      break;
    }
    normalizedLines.push(line);
    totalChars += line.length + 1;
  }
  return normalizedLines.join("\n");
}

function avrObjdumpArgSets(properties = {}, dumpPath) {
  const mcu = String(properties["build.mcu"] || "").toLowerCase();
  const likelyMachine = /atmega256|atmega1280|atmega640/.test(mcu)
    ? "avr6"
    : /attiny/.test(mcu)
      ? "avr25"
      : "avr5";
  const machines = uniqueValues([likelyMachine, "avr5", "avr", "avrxmega2"]);
  return machines.map((machine) => ["-D", "-b", "ihex", "-m", machine, dumpPath]);
}

async function createAvrDisassembly({ dump, boardDetails, objdump }) {
  const attempts = [];
  for (const args of avrObjdumpArgSets(boardDetails.properties, dump.path)) {
    try {
      const { stdout, stderr } = await runExecFile(objdump, args, {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_DISASSEMBLY_OUTPUT_BYTES,
      });
      const text = compactDisassemblyText(stdout);
      if (text) {
        return {
          text,
          tool: objdump,
          command: `${path.basename(objdump)} ${args.join(" ")}`,
          stderr: normalizeText(stderr, 2000),
          truncated: stdout.length > text.length,
        };
      }
    } catch (error) {
      attempts.push(error instanceof Error ? error.message : "AVR objdump failed.");
    }
  }
  return {
    text: "",
    tool: objdump,
    error: attempts.filter(Boolean).slice(-1)[0] || "Unable to disassemble AVR firmware.",
  };
}

function espDisassemblyOffsets(buffer) {
  return [0x0, 0x1000, 0x8000, 0x10000]
    .filter((offset, index, offsets) => offset < buffer.length && offsets.indexOf(offset) === index);
}

async function createEspDisassembly({ dump, boardDetails, objdump, evidenceBuffer, outputDir }) {
  const machines = objdumpMachineCandidates(objdump, boardDetails.properties, boardDetails.details?.fqbn || "");
  const esp = createEspAnalysis(evidenceBuffer, boardDetails.properties);
  if (esp.appImage?.valid) {
    const appSections = [];
    const attempts = [];
    for (const segment of esp.appImage.segments.filter((entry) => entry.executable)) {
      const segmentPath = path.join(outputDir, `esp-app-segment-${segment.index}-0x${segment.loadAddress.toString(16)}.bin`);
      await fsPromises.writeFile(segmentPath, evidenceBuffer.subarray(segment.flashOffset, segment.flashOffset + segment.length));
      let segmentText = "";
      let command = "";
      for (const machine of machines) {
        const args = ["-D", "-b", "binary", "-m", machine, `--adjust-vma=0x${segment.loadAddress.toString(16)}`, segmentPath];
        try {
          const { stdout } = await runExecFile(objdump, args, {
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_DISASSEMBLY_OUTPUT_BYTES,
          });
          segmentText = compactDisassemblyText(stdout, Math.floor(MAX_DISASSEMBLY_EXCERPT_CHARS / Math.max(1, esp.appImage.executableSegmentCount)));
          command = `${path.basename(objdump)} ${args.join(" ")}`;
          if (segmentText) {
            break;
          }
        } catch (error) {
          attempts.push(error instanceof Error ? error.message : `ESP app segment objdump failed for ${machine}.`);
        }
      }
      if (segmentText) {
        appSections.push([
          `; ESP app ${esp.selectedAppPartition?.label || esp.selectedAppPartition?.subtypeName || "partition"} segment ${segment.index}`,
          `; load address 0x${segment.loadAddress.toString(16)} length ${segment.length} bytes file offset 0x${segment.fileOffset.toString(16)}`,
          segmentText,
        ].join("\n"));
      } else if (!command) {
        attempts.push(`No disassembly produced for ESP app segment ${segment.index}.`);
      }
      if (appSections.join("\n\n").length >= MAX_DISASSEMBLY_EXCERPT_CHARS) {
        break;
      }
    }

    const text = compactDisassemblyText(appSections.join("\n\n"), MAX_DISASSEMBLY_EXCERPT_CHARS);
    return {
      text,
      tool: objdump,
      command: text ? `${path.basename(objdump)} -D -b binary --adjust-vma=<segment-load-address>` : "",
      error: text ? "" : attempts.filter(Boolean).slice(-1)[0] || "No executable ESP app segments could be disassembled.",
      truncated: appSections.join("\n\n").length > text.length,
      esp,
      source: "esp-app",
    };
  }

  const fallback = await createEspRawDisassembly({ dump, boardDetails, objdump, evidenceBuffer, outputDir, machines });
  return {
    ...fallback,
    esp,
    source: "raw-flash-fallback",
    error: fallback.error || esp.appImage?.error || "ESP app image was not available; used raw flash fallback.",
  };
}

async function createEspRawDisassembly({ dump, objdump, evidenceBuffer, outputDir, machines }) {
  const sections = [];
  const attempts = [];
  for (const offset of espDisassemblyOffsets(evidenceBuffer)) {
    const sliceLength = Math.min(ESP_DISASSEMBLY_SLICE_BYTES, evidenceBuffer.length - offset);
    if (sliceLength <= 0) {
      continue;
    }
    const slicePath = path.join(outputDir, `disassembly-slice-0x${offset.toString(16)}.bin`);
    await fsPromises.writeFile(slicePath, evidenceBuffer.subarray(offset, offset + sliceLength));
    let sectionText = "";
    let command = "";
    for (const machine of machines) {
      const args = ["-D", "-b", "binary", "-m", machine, `--adjust-vma=0x${offset.toString(16)}`, slicePath];
      try {
        const { stdout } = await runExecFile(objdump, args, {
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_DISASSEMBLY_OUTPUT_BYTES,
        });
        sectionText = compactDisassemblyText(stdout, Math.floor(MAX_DISASSEMBLY_EXCERPT_CHARS / 4));
        command = `${path.basename(objdump)} ${args.join(" ")}`;
        if (sectionText) {
          break;
        }
      } catch (error) {
        attempts.push(error instanceof Error ? error.message : `ESP objdump failed for ${machine}.`);
      }
    }
    if (sectionText) {
      sections.push([
        `; ESP flash excerpt offset 0x${offset.toString(16)} length ${sliceLength} bytes`,
        sectionText,
      ].join("\n"));
      if (sections.join("\n").length >= MAX_DISASSEMBLY_EXCERPT_CHARS) {
        break;
      }
    } else if (!command) {
      attempts.push(`No disassembly produced for ${dump.filename || "firmware dump"} offset 0x${offset.toString(16)}.`);
    }
  }

  const text = compactDisassemblyText(sections.join("\n\n"), MAX_DISASSEMBLY_EXCERPT_CHARS);
  return {
    text,
    tool: objdump,
    command: text ? `${path.basename(objdump)} -D -b binary` : "",
    error: text ? "" : attempts.filter(Boolean).slice(-1)[0] || "Unable to disassemble ESP firmware.",
    truncated: sections.join("\n\n").length > text.length,
  };
}

async function createDisassemblyExcerpt({ dump, boardDetails, evidenceBuffer, outputDir, onProgress }) {
  const objdump = findObjdumpTool(boardDetails.properties, boardDetails.family, boardDetails.details?.fqbn || "");
  if (!objdump) {
    return {
      text: "",
      tool: "",
      error: `No ${boardDetails.family === "avr" ? "avr-objdump" : "ESP objdump"} tool was found in the installed Arduino core tools.`,
    };
  }

  onProgress?.({ phase: "disassemble", message: "Building firmware disassembly evidence...", progress: 55 });
  if (boardDetails.family === "avr") {
    return createAvrDisassembly({ dump, boardDetails, objdump });
  }
  if (boardDetails.family === "esp") {
    return createEspDisassembly({ dump, boardDetails, objdump, evidenceBuffer, outputDir });
  }
  return {
    text: "",
    tool: objdump,
    error: "Disassembly is only configured for ESP and AVR readback in this release.",
  };
}

function classifyEvidenceQuality({ strings = [], disassembly = null, evidenceBuffer = Buffer.alloc(0) }) {
  const hasDisassembly = Boolean(disassembly?.text);
  const stringCount = Array.isArray(strings) ? strings.length : 0;
  if (hasDisassembly && stringCount >= 20) {
    return "high";
  }
  if (hasDisassembly || stringCount >= 10 || evidenceBuffer.length >= 4096) {
    return "medium";
  }
  if (stringCount > 0 || evidenceBuffer.length > 0) {
    return "low";
  }
  return "none";
}

async function readHardwareFirmware({ board, port, outputDir, onProgress }) {
  if (!board) {
    throw new Error("A board FQBN is required before reading firmware.");
  }
  if (!port) {
    throw new Error("A serial port is required before reading firmware.");
  }

  onProgress?.({ phase: "board-details", message: "Resolving board readback tools...", progress: 20 });
  const boardDetails = await readBoardDetails(board);
  await fsPromises.mkdir(outputDir, { recursive: true });

  let dump;
  if (boardDetails.family === "esp") {
    dump = await readEspFlash({ port, properties: boardDetails.properties, outputDir, onProgress });
  } else if (boardDetails.family === "avr") {
    dump = await readAvrFlash({ port, properties: boardDetails.properties, outputDir, onProgress });
  } else {
    throw new Error(`Readback is not available for ${board}. This board core does not expose a known read-capable tool.`);
  }

  const evidence = await firmwareEvidenceBuffer(dump);
  const flashStrings = extractPrintableStrings(evidence.buffer);
  const flashHexdump = createHexdumpExcerpt(evidence.buffer, evidence.baseAddress);
  const disassembly = await createDisassemblyExcerpt({
    dump,
    boardDetails: {
      ...boardDetails,
      details: {
        ...boardDetails.details,
        fqbn: board,
      },
    },
    evidenceBuffer: evidence.buffer,
    outputDir,
    onProgress,
  });
  const esp = boardDetails.family === "esp" ? disassembly.esp || createEspAnalysis(evidence.buffer, boardDetails.properties) : null;
  const strings = esp?.appStrings?.length ? esp.appStrings : flashStrings;
  const artifacts = [];
  let appPartitionBuffer = Buffer.alloc(0);
  if (esp?.selectedAppPartition && esp.appPartitionSizeRead > 0) {
    appPartitionBuffer = evidence.buffer.subarray(esp.selectedAppPartition.offset, Math.min(evidence.buffer.length, esp.selectedAppPartition.end));
    const appPartitionPath = path.join(outputDir, "esp-app-partition.bin");
    await fsPromises.writeFile(appPartitionPath, appPartitionBuffer);
    artifacts.push({
      path: appPartitionPath,
      filename: "esp-app-partition.bin",
      type: "esp-app-partition",
      format: "bin",
    });
  }
  const hexdump = esp?.appImage?.valid && appPartitionBuffer.length > 0
    ? createHexdumpExcerpt(appPartitionBuffer, esp.selectedAppPartition.offset)
    : flashHexdump;
  return {
    boardDetails,
    dump,
    evidence: {
      baseAddress: evidence.baseAddress,
      decoded: evidence.decoded,
      sourceFormat: evidence.sourceFormat,
      size: evidence.buffer.length,
    },
    strings,
    flashStrings,
    hexdump,
    flashHexdump,
    disassembly,
    esp,
    artifacts,
    sourceMarkers: extractSourceRestoreMarkersFromEvidence({
      buffer: evidence.buffer,
      family: boardDetails.family,
      esp,
      baseAddress: evidence.baseAddress,
    }),
    evidenceQuality: classifyEvidenceQuality({ strings, disassembly, evidenceBuffer: esp?.appEvidenceAvailable ? Buffer.alloc(Math.max(4096, esp.appPartitionSizeRead || 0)) : evidence.buffer }),
  };
}

function normalizeGeneratedFiles(files = []) {
  const normalized = [];
  const seen = new Set();
  let totalBytes = 0;

  for (const file of Array.isArray(files) ? files : []) {
    const relativePath = sanitizeRelativePath(file?.path || file?.name, normalized.length === 0 ? "README.md" : `file-${normalized.length + 1}.txt`);
    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    const content = String(file?.content ?? "");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_OUTPUT_FILE_BYTES || totalBytes + bytes > MAX_SOURCE_SNAPSHOT_BYTES) {
      continue;
    }

    seen.add(key);
    totalBytes += bytes;
    normalized.push({ path: relativePath, content });
    if (normalized.length >= MAX_AI_FILES) {
      break;
    }
  }

  return normalized;
}

async function writeTextFiles(rootDir, files = []) {
  const written = [];
  const root = path.resolve(rootDir);
  await fsPromises.mkdir(root, { recursive: true });

  for (const file of files) {
    const relativePath = sanitizeRelativePath(file.path);
    const targetPath = path.resolve(root, relativePath);
    if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
      continue;
    }

    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, String(file.content ?? ""), "utf8");
    written.push({ path: targetPath, relativePath });
  }

  return written;
}

async function copyArtifact(rootDir, sourcePath, relativePath) {
  const root = path.resolve(rootDir);
  const targetPath = path.resolve(root, sanitizeRelativePath(relativePath));
  if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Blocked artifact path outside extraction folder.");
  }
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await fsPromises.copyFile(sourcePath, targetPath);
  return { path: targetPath, relativePath: path.relative(root, targetPath) };
}

function createExtractionReadme({ boardName, board, source, warnings = [], notes = "", limitations = "", confidence = null, model = "" }) {
  return [
    `# ${boardName || "Board"} Code View`,
    "",
    `Source: ${source}`,
    board ? `Board: ${board}` : "",
    confidence === null || confidence === undefined ? "" : `Confidence: ${Math.round(Number(confidence || 0) * 100)}%`,
    model ? `Model: ${model}` : "",
    "",
    source === "snapshot" || source === "local-history"
      ? "These files came from a source snapshot saved by Tantalum IDE."
      : source === "hardware-binary"
        ? "Compiled firmware cannot be converted back into exact source. This folder contains diagnostic firmware artifacts only; no source was reconstructed."
        : "Compiled firmware cannot be converted back into exact source. Any generated code in this folder is an approximation derived from firmware metadata, decoded strings, disassembly excerpts, and model inference.",
    "",
    notes ? `## Notes\n${notes}` : "",
    limitations ? `## Limitations\n${limitations}` : "",
    warnings.length ? `## Warnings\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    "",
  ].filter(Boolean).join("\n");
}

function sourceHistoryKeys(identity = {}) {
  return [
    identity.profileId ? `profile:${identity.profileId}` : "",
    identity.fingerprint ? `fingerprint:${identity.fingerprint}` : "",
    identity.cloudBoardId ? `cloud:${identity.cloudBoardId}` : "",
    identity.port && identity.fqbn ? `port:${identity.port}|${identity.fqbn}` : "",
  ].filter(Boolean);
}

function snapshotMetadata(manifest = {}) {
  return manifest && typeof manifest === "object" && manifest.metadata && typeof manifest.metadata === "object"
    ? manifest.metadata
    : {};
}

function normalizeIdentityValue(value) {
  return normalizeText(value, 512).toLowerCase();
}

function valuesMatch(left, right) {
  const normalizedLeft = normalizeIdentityValue(left);
  const normalizedRight = normalizeIdentityValue(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function snapshotIdentityValue(metadata, keys = []) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (normalizeText(value)) {
      return value;
    }
  }
  return "";
}

function snapshotPathParts(filePath = "") {
  return String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
}

function isSketchSourcePath(filePath = "") {
  return /\.(ino|pde)$/i.test(path.basename(String(filePath || "")));
}

function isSnapshotSkippedDirectoryName(name = "") {
  const normalized = String(name || "").toLowerCase();
  return normalized.startsWith(".") || SOURCE_SNAPSHOT_SKIPPED_DIRECTORIES.has(normalized);
}

function isWorkspaceCompiledRootFilePath(filePath = "") {
  return WORKSPACE_COMPILED_SNAPSHOT_ROOT_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function isWorkspaceCompiledDirectoryFilePath(filePath = "") {
  return !isSketchSourcePath(filePath) && isWorkspaceCompiledRootFilePath(filePath);
}

function isWorkspaceCompiledSnapshotPath(filePath = "") {
  const parts = snapshotPathParts(filePath);
  if (parts.length === 0 || parts.some((part) => isSnapshotSkippedDirectoryName(part))) {
    return false;
  }
  if (parts.length === 1) {
    return isWorkspaceCompiledRootFilePath(parts[0]);
  }
  return WORKSPACE_COMPILED_SNAPSHOT_DIRECTORIES.has(parts[0].toLowerCase()) && isWorkspaceCompiledDirectoryFilePath(parts[parts.length - 1]);
}

function isLikelyBroadWorkspaceSnapshot(manifest = {}, metadata = {}) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const filePaths = files.map((file) => String(file?.path || "")).filter(Boolean);
  const rootFiles = files
    .map((file) => String(file?.path || ""))
    .filter((filePath) => snapshotPathParts(filePath).length === 1);
  const rootNames = new Set(rootFiles.map((filePath) => path.basename(filePath).toLowerCase()));
  if ([...SOURCE_SNAPSHOT_PROJECT_ROOT_MARKERS].some((name) => rootNames.has(name))) {
    return true;
  }

  const snapshotScope = String(metadata.snapshotScope || "").toLowerCase();
  if (snapshotScope === "workspace-compiled") {
    return filePaths.some((filePath) => !isWorkspaceCompiledSnapshotPath(filePath));
  }

  const activeRelativePath = String(metadata.activeFileRelativePath || "").replace(/\\/g, "/");
  const activeIsRootSketch = activeRelativePath && snapshotPathParts(activeRelativePath).length === 1 && isSketchSourcePath(activeRelativePath);
  const workspacePath = normalizeIdentityValue(metadata.workspacePath);
  const sketchRoot = normalizeIdentityValue(metadata.sketchRoot);
  if (activeIsRootSketch && workspacePath && sketchRoot && workspacePath === sketchRoot && rootFiles.some((filePath) => !isWorkspaceCompiledSnapshotPath(filePath))) {
    return true;
  }

  return false;
}

function validateSourceSnapshotManifestForIdentity(manifest = {}, identity = {}, options = {}) {
  const metadata = snapshotMetadata(manifest);
  const source = options.source || "snapshot";
  const manifestVersion = Number(metadata.manifestVersion || 0);
  const snapshotBoardType = snapshotIdentityValue(metadata, ["boardType", "fqbn", "board"]);
  const snapshotCloudBoardId = snapshotIdentityValue(metadata, ["cloudBoardId", "boardId"]);
  const snapshotProfileId = snapshotIdentityValue(metadata, ["profileId"]);
  const snapshotFingerprint = snapshotIdentityValue(metadata, ["fingerprint"]);
  const snapshotPort = snapshotIdentityValue(metadata, ["port"]);
  const expectedBoardType = identity.fqbn || identity.boardType || "";
  const expectedCloudBoardId = identity.cloudBoardId || identity.id || "";
  const expectedProfileId = identity.profileId || "";
  const expectedFingerprint = identity.fingerprint || "";
  const expectedPort = identity.port || "";

  const report = {
    accepted: false,
    reason: "",
    source,
    manifestVersion,
    matches: {
      boardType: valuesMatch(snapshotBoardType, expectedBoardType),
      cloudBoardId: valuesMatch(snapshotCloudBoardId, expectedCloudBoardId),
      profileId: valuesMatch(snapshotProfileId, expectedProfileId),
      fingerprint: valuesMatch(snapshotFingerprint, expectedFingerprint),
      port: valuesMatch(snapshotPort, expectedPort),
    },
    manifestSummary: {
      boardType: normalizeText(snapshotBoardType),
      cloudBoardId: normalizeText(snapshotCloudBoardId),
      profileId: normalizeText(snapshotProfileId),
      fingerprint: normalizeText(snapshotFingerprint),
      port: normalizeText(snapshotPort),
      snapshotScope: normalizeText(metadata.snapshotScope, 64),
      sketchRoot: normalizeText(metadata.sketchRoot, 1024),
      activeFile: normalizeText(metadata.activeFile, 1024),
      collectedAt: normalizeText(metadata.collectedAt, 64),
    },
  };

  if (manifestVersion < 2) {
    report.reason = "Source snapshot was created before scoped board-code manifests. Upload this sketch again to replace it.";
    return report;
  }

  if (isLikelyBroadWorkspaceSnapshot(manifest, metadata)) {
    report.unsafeScope = true;
    report.reason = "Source snapshot appears to contain a whole workspace instead of the uploaded sketch. Upload this sketch again to replace the stale broad snapshot.";
    return report;
  }

  if (snapshotBoardType && expectedBoardType && !report.matches.boardType) {
    report.reason = `Source snapshot board type ${snapshotBoardType} does not match ${expectedBoardType}.`;
    return report;
  }

  if (snapshotCloudBoardId && expectedCloudBoardId && !report.matches.cloudBoardId) {
    report.reason = "Source snapshot belongs to a different cloud board.";
    return report;
  }

  if (snapshotProfileId && expectedProfileId && !report.matches.profileId) {
    report.reason = "Source snapshot belongs to a different local board profile.";
    return report;
  }

  if (snapshotFingerprint && expectedFingerprint && !report.matches.fingerprint) {
    report.reason = "Source snapshot belongs to a different physical board fingerprint.";
    return report;
  }

  const strongIdentityMatch = report.matches.cloudBoardId || report.matches.profileId || report.matches.fingerprint;
  const fallbackPortMatch = report.matches.boardType && report.matches.port;
  if (strongIdentityMatch || fallbackPortMatch) {
    report.accepted = true;
    report.reason = strongIdentityMatch ? "Snapshot identity matched." : "Snapshot board type and port matched.";
    return report;
  }

  if (snapshotPort && expectedPort && !report.matches.port && !strongIdentityMatch) {
    report.reason = "Source snapshot was uploaded from a different serial port and no stronger board identity matched.";
    return report;
  }

  report.reason = "Source snapshot identity is incomplete for this board. Upload the sketch again to save a scoped snapshot.";
  return report;
}

function getSourceHistory(store) {
  const current = store?.get(SOURCE_HISTORY_KEY);
  return current && typeof current === "object" && !Array.isArray(current) ? current : {};
}

function findSourceHistoryEntries(store, identity = {}) {
  const history = getSourceHistory(store);
  const entries = [];
  const seen = new Set();
  for (const key of sourceHistoryKeys(identity)) {
    const entry = history[key];
    const entryKey = entry?.snapshotPath || entry?.id || "";
    if (entry?.snapshotPath && fs.existsSync(entry.snapshotPath) && !seen.has(entryKey)) {
      seen.add(entryKey);
      entries.push({ ...entry, matchedKey: key });
    }
  }
  return entries;
}

function findSourceHistoryEntry(store, identity = {}) {
  return findSourceHistoryEntries(store, identity)[0] || null;
}

async function saveLocalSourceHistory(store, userDataDir, identity = {}, snapshot = {}) {
  const keys = sourceHistoryKeys(identity);
  if (keys.length === 0 || !snapshot?.files?.length) {
    return null;
  }

  const { buffer, manifest, checksum } = await createSourceSnapshotZipBuffer({
    files: snapshot.files,
    metadata: {
      ...snapshot.metadata,
      board: identity.fqbn,
      port: identity.port,
      profileId: identity.profileId,
      fingerprint: identity.fingerprint,
      cloudBoardId: identity.cloudBoardId,
    },
  });
  const historyDir = path.join(userDataDir, "source-history");
  await fsPromises.mkdir(historyDir, { recursive: true });
  const snapshotId = `source_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const snapshotPath = path.join(historyDir, `${snapshotId}.zip`);
  await fsPromises.writeFile(snapshotPath, buffer);

  const entry = {
    id: snapshotId,
    snapshotPath,
    checksum,
    manifest,
    boardName: identity.boardName || snapshot.metadata?.boardName || "",
    board: identity.fqbn || "",
    port: identity.port || "",
    profileId: identity.profileId || "",
    fingerprint: identity.fingerprint || "",
    cloudBoardId: identity.cloudBoardId || "",
    createdAt: new Date().toISOString(),
  };

  const history = getSourceHistory(store);
  for (const key of keys) {
    history[key] = entry;
  }

  const entries = Object.entries(history).sort((left, right) => String(right[1]?.createdAt || "").localeCompare(String(left[1]?.createdAt || "")));
  store?.set(SOURCE_HISTORY_KEY, Object.fromEntries(entries.slice(0, SOURCE_HISTORY_LIMIT)));
  return entry;
}

async function readLocalSourceHistory(entry) {
  const buffer = await fsPromises.readFile(entry.snapshotPath);
  return readZipEntriesFromBuffer(buffer);
}

function tempExtractionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tantalum-board-code-"));
}

module.exports = {
  MAX_FLASH_BYTES,
  SOURCE_HISTORY_KEY,
  SOURCE_RESTORE_MARKER_PREFIX,
  createExtractionReadme,
  createSourceSnapshotZipBuffer,
  defaultExtractionFolderName,
  extractSourceRestoreMarkersFromBuffer,
  extractSourceRestoreMarkersFromEvidence,
  findSourceHistoryEntries,
  findSourceHistoryEntry,
  normalizeGeneratedFiles,
  parseIntelHexToBinary,
  readHardwareFirmware,
  readLocalSourceHistory,
  readZipEntriesFromBuffer,
  saveLocalSourceHistory,
  sanitizeName,
  sanitizeRelativePath,
  tempExtractionDir,
  validateSourceSnapshotManifestForIdentity,
  writeTextFiles,
  copyArtifact,
  _test: {
    boardFamilyFromFqbn,
    classifyEvidenceQuality,
    createHexdumpExcerpt,
    createEspAnalysis,
    extractSourceRestoreMarkersFromBuffer,
    extractSourceRestoreMarkersFromEvidence,
    espFlashSizeBytes,
    espObjdumpNames,
    findObjdumpTool,
    normalizeSnapshotFiles,
    parseEspImage,
    parseEspPartitionTable,
    parseProperties,
    parseSourceRestoreMarkersFromText,
    planEspAppReadback,
    selectEspAppPartition,
    sourceHistoryKeys,
    validateSourceSnapshotManifestForIdentity,
  },
};

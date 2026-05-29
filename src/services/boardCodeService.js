const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const yauzl = require("yauzl");
const yazl = require("yazl");

const { getArduinoCliEnv, getCliPath } = require("../../arduinoHandler");

const BOARD_CODE_TASK_TAG = "code-extract";
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
  ".s",
  ".S",
  ".asm",
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".properties",
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
  onProgress?.({ phase: "read-flash", message: `Reading ${flashBytes} bytes with esptool...`, progress: 35 });
  const args = ["--port", port, "--baud", "921600", "read_flash", "0x0", String(flashBytes), dumpPath];
  const { stdout, stderr } = await runExecFile(esptool, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
  const buffer = await fsPromises.readFile(dumpPath);
  return {
    format: "bin",
    path: dumpPath,
    filename: "firmware-dump.bin",
    size: buffer.length,
    checksum: sha256Hex(buffer),
    commandOutput: `${stdout || ""}\n${stderr || ""}`.trim(),
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

  const dumpBuffer = await fsPromises.readFile(dump.path);
  const strings = extractPrintableStrings(dumpBuffer);
  return {
    boardDetails,
    dump,
    strings,
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
      : "Compiled firmware cannot be converted back into exact source. Any generated code in this folder is an approximation derived from firmware metadata, strings, and model inference.",
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

function getSourceHistory(store) {
  const current = store?.get(SOURCE_HISTORY_KEY);
  return current && typeof current === "object" && !Array.isArray(current) ? current : {};
}

function findSourceHistoryEntry(store, identity = {}) {
  const history = getSourceHistory(store);
  for (const key of sourceHistoryKeys(identity)) {
    const entry = history[key];
    if (entry?.snapshotPath && fs.existsSync(entry.snapshotPath)) {
      return entry;
    }
  }
  return null;
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
  BOARD_CODE_TASK_TAG,
  MAX_FLASH_BYTES,
  SOURCE_HISTORY_KEY,
  createExtractionReadme,
  createSourceSnapshotZipBuffer,
  defaultExtractionFolderName,
  findSourceHistoryEntry,
  normalizeGeneratedFiles,
  readHardwareFirmware,
  readLocalSourceHistory,
  readZipEntriesFromBuffer,
  saveLocalSourceHistory,
  sanitizeName,
  sanitizeRelativePath,
  tempExtractionDir,
  writeTextFiles,
  copyArtifact,
  _test: {
    boardFamilyFromFqbn,
    espFlashSizeBytes,
    normalizeSnapshotFiles,
    parseProperties,
  },
};

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { exec, execFile, spawn } = require("child_process");
const yauzl = require("yauzl");

const DEFAULT_ARDUINO_NETWORK_CONNECTION_TIMEOUT = "600s";
const BOARD_INDEX_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const BOARD_PACKAGE_INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const BYTES_PER_MIB = 1024 * 1024;
const ARDUINO_CLI_OUTPUT_MAX_BUFFER = 50 * BYTES_PER_MIB;
const MIN_LIBRARY_INSTALL_SPACE_BYTES = 50 * BYTES_PER_MIB;
const MIN_BOARD_PACKAGE_INSTALL_SPACE_BYTES = 512 * BYTES_PER_MIB;
const LIBRARY_INSTALL_SPACE_MULTIPLIER = 3;
const BOARD_PLATFORM_ARCHIVE_SPACE_MULTIPLIER = 4;
const BOARD_TOOL_ARCHIVE_SPACE_MULTIPLIER = 3;
const TANTALUM_RUNTIME_VERSION = "1.1.10";
const TANTALUM_RUNTIME_HEADER_NAME = "TantalumCloudRuntime.h";
const TANTALUM_RUNTIME_HEADER_PATH = path.join(__dirname, "resources", "firmware", TANTALUM_RUNTIME_HEADER_NAME);
const TANTALUM_SOURCE_MARKER_FILE_NAME = "TantalumSourceMarker.cpp";
const TANTALUM_SOURCE_MARKER_PREFIX = "TANTALUM_SOURCE_SNAPSHOT_V1";
const TANTALUM_WIFI_HOSTNAME_MAX_LENGTH = 31;
const TANTALUM_OTA_UPDATE_MODES = new Set(["polling", "mqtt", "both"]);
const TANTALUM_CLOUD_RUNTIME_BASE_LIBRARIES = ["ArduinoJson"];
const TANTALUM_CLOUD_RUNTIME_MQTT_LIBRARIES = ["PubSubClient"];
const ARDUINO_WORKSPACE_ENTRY_FILE_NAME = "main.ino";
const ARDUINO_ROOT_SKETCH_EXTENSIONS = new Set([".ino", ".pde"]);
const ARDUINO_ROOT_SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".s"]);
const ARDUINO_ROOT_HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx", ".ipp", ".tpp"]);
const ARDUINO_ROOT_BUILD_EXTENSIONS = new Set([
  ...ARDUINO_ROOT_SKETCH_EXTENSIONS,
  ...ARDUINO_ROOT_SOURCE_EXTENSIONS,
  ...ARDUINO_ROOT_HEADER_EXTENSIONS
]);
const ARDUINO_WORKSPACE_INCLUDED_DIRS = new Set(["src"]);
const ARDUINO_WORKSPACE_SKIPPED_DIRS = new Set([
  ".git",
  ".tantalum-file-tree-trash",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".vite",
  "out",
  "target"
]);
let configuredArduinoStorageRoot = null;

function createCanceledError(message = "Operation stopped by user.") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.canceled = true;
  return error;
}

function isCanceledError(error) {
  return Boolean(error?.canceled || error?.name === "AbortError" || error?.code === "ABORT_ERR");
}

function throwIfCanceled(signal, message) {
  if (signal?.aborted) {
    throw createCanceledError(message);
  }
}

function normalizeStorageRoot(value) {
  const normalized = normalizeCliConfigValue(value);
  return normalized ? path.resolve(normalized) : null;
}

function getConfiguredArduinoStorageRoot() {
  return configuredArduinoStorageRoot || normalizeStorageRoot(process.env.TANTALUM_ARDUINO_STORAGE_ROOT);
}

function getArduinoStorageLayout(root = getConfiguredArduinoStorageRoot()) {
  const storageRoot = normalizeStorageRoot(root);
  if (!storageRoot) {
    return null;
  }

  const userDir = path.join(storageRoot, "sketchbook");
  return {
    storageRoot,
    dataDir: path.join(storageRoot, "Arduino15"),
    downloadsDir: path.join(storageRoot, "downloads"),
    userDir,
    librariesDir: path.join(userDir, "libraries"),
    buildCacheDir: path.join(storageRoot, "build-cache"),
    tempDir: path.join(storageRoot, "tmp")
  };
}

function ensureDirectoryWritable(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const probePath = path.join(dirPath, `.tantalum-write-probe-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(probePath, "probe");
  fs.rmSync(probePath, { force: true });
}

function ensureArduinoStorageLayout(layout = getArduinoStorageLayout()) {
  if (!layout) {
    return null;
  }

  for (const dirPath of [layout.storageRoot, layout.dataDir, layout.downloadsDir, layout.userDir, layout.librariesDir, layout.buildCacheDir, layout.tempDir]) {
    ensureDirectoryWritable(dirPath);
  }

  return layout;
}

function configureArduinoStorageRoot(root) {
  configuredArduinoStorageRoot = normalizeStorageRoot(root);
  return getArduinoStorageInfo();
}

function getArduinoStorageInfo() {
  const layout = ensureArduinoStorageLayout();
  if (!layout) {
    return {
      configured: false,
      storageRoot: null,
      dataDir: null,
      downloadsDir: null,
      userDir: null,
      librariesDir: null,
      buildCacheDir: null,
      tempDir: null
    };
  }

  return {
    configured: true,
    ...layout
  };
}

function getArduinoTempDir() {
  const layout = ensureArduinoStorageLayout();
  return layout?.tempDir || os.tmpdir();
}

function getFallbackArduinoDataDir() {
  const homeDir = os.homedir();

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "Arduino15");
  }

  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Arduino15");
  }

  return path.join(homeDir, ".arduino15");
}

async function resolveArduinoDataDir() {
  const storageLayout = ensureArduinoStorageLayout();
  if (storageLayout) {
    return storageLayout.dataDir;
  }

  const envDataDir = normalizeCliConfigValue(process.env.ARDUINO_DIRECTORIES_DATA);
  if (envDataDir) {
    return envDataDir;
  }

  const configuredDataDir = await getArduinoCliConfigValue("directories.data");
  return configuredDataDir || getFallbackArduinoDataDir();
}

function toByteCount(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function formatStorageBytes(value) {
  const bytes = toByteCount(value);
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KiB", "MiB", "GiB", "TiB"];
  let unitIndex = -1;
  let amount = bytes;
  do {
    amount /= 1024;
    unitIndex += 1;
  } while (amount >= 1024 && unitIndex < units.length - 1);

  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unitIndex]}`;
}

function getAvailableStorageBytes(targetDir) {
  const resolvedTargetDir = path.resolve(targetDir || getArduinoTempDir());
  fs.mkdirSync(resolvedTargetDir, { recursive: true });

  if (typeof fs.statfsSync !== "function") {
    return null;
  }

  const stats = fs.statfsSync(resolvedTargetDir);
  const blockSize = Number(stats.bsize || stats.frsize);
  const availableBlocks = Number(stats.bavail ?? stats.bfree);

  if (!Number.isFinite(blockSize) || blockSize <= 0 || !Number.isFinite(availableBlocks) || availableBlocks < 0) {
    return null;
  }

  return {
    targetDir: resolvedTargetDir,
    availableBytes: blockSize * availableBlocks
  };
}

function createInsufficientStorageError({ label, targetDir, requiredBytes, availableBytes }) {
  const shortfallBytes = Math.max(0, requiredBytes - availableBytes);
  const error = new Error(
    `Not enough storage to install ${label}. ` +
    `Estimated required: ${formatStorageBytes(requiredBytes)}; available: ${formatStorageBytes(availableBytes)} on ${targetDir}. ` +
    `Free at least ${formatStorageBytes(shortfallBytes)} or choose a larger folder in Settings > Arduino Storage, then retry.`
  );
  error.code = "TANTALUM_INSUFFICIENT_STORAGE";
  error.storage = {
    label,
    targetDir,
    requiredBytes,
    availableBytes,
    shortfallBytes
  };
  return error;
}

function assertEnoughStorage({ label, targetDir, requiredBytes }) {
  const normalizedRequiredBytes = Math.ceil(toByteCount(requiredBytes));
  if (!normalizedRequiredBytes) {
    return null;
  }

  const storage = getAvailableStorageBytes(targetDir);
  if (!storage) {
    return null;
  }

  if (storage.availableBytes < normalizedRequiredBytes) {
    throw createInsufficientStorageError({
      label,
      targetDir: storage.targetDir,
      requiredBytes: normalizedRequiredBytes,
      availableBytes: storage.availableBytes
    });
  }

  return {
    ...storage,
    requiredBytes: normalizedRequiredBytes
  };
}

function estimateLibraryInstallSpaceBytes(archiveSize) {
  const archiveBytes = toByteCount(archiveSize);
  if (!archiveBytes) {
    return MIN_LIBRARY_INSTALL_SPACE_BYTES;
  }

  return Math.max(
    Math.ceil(archiveBytes * LIBRARY_INSTALL_SPACE_MULTIPLIER),
    archiveBytes + MIN_LIBRARY_INSTALL_SPACE_BYTES
  );
}

function parseBoardPackageSpec(packageName) {
  const rawValue = String(packageName || "").trim();
  if (!rawValue) {
    return null;
  }

  const versionSeparatorIndex = rawValue.lastIndexOf("@");
  const id = versionSeparatorIndex > 0 ? rawValue.slice(0, versionSeparatorIndex) : rawValue;
  const rawVersion = versionSeparatorIndex > 0 ? rawValue.slice(versionSeparatorIndex + 1).trim() : "";
  const parts = id.split(":");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  return {
    id,
    packager: parts[0],
    architecture: parts[1],
    version: rawVersion && rawVersion !== "latest" ? rawVersion : null
  };
}

function getKnownBoardPackageUrl(packageName) {
  const spec = parseBoardPackageSpec(packageName);
  if (!spec) {
    return null;
  }

  const knownPackage = Object.values(BOARD_PACKAGES).find((entry) => entry?.name === spec.id && entry?.url);
  return knownPackage?.url || null;
}

function getArduinoHostCandidates() {
  if (process.platform === "win32") {
    return process.arch === "ia32"
      ? ["i686-mingw32", "x86_64-mingw32"]
      : ["x86_64-mingw32", "i686-mingw32"];
  }

  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? ["arm64-apple-darwin", "aarch64-apple-darwin", "x86_64-apple-darwin"]
      : ["x86_64-apple-darwin"];
  }

  if (process.arch === "arm64") {
    return ["aarch64-linux-gnu", "arm64-linux-gnu", "x86_64-pc-linux-gnu"];
  }

  if (process.arch.startsWith("arm")) {
    return ["arm-linux-gnueabihf", "arm-linux-gnueabi", "aarch64-linux-gnu"];
  }

  return ["x86_64-pc-linux-gnu", "x86_64-linux-gnu", "i686-pc-linux-gnu"];
}

function readArduinoPackageIndexes(dataDir) {
  if (!dataDir || !fs.existsSync(dataDir)) {
    return [];
  }

  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^package.*\.json$/i.test(entry.name))
    .map((entry) => path.join(dataDir, entry.name))
    .flatMap((indexPath) => {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        return Array.isArray(index.packages)
          ? index.packages.map((packageEntry) => ({ packageEntry, indexPath }))
          : [];
      } catch (error) {
        console.warn(`Failed to read Arduino package index ${indexPath}:`, error.message);
        return [];
      }
    });
}

function chooseArduinoToolSystem(systems) {
  if (!Array.isArray(systems) || systems.length === 0) {
    return null;
  }

  const candidates = getArduinoHostCandidates();
  return candidates
    .map((candidate) => systems.find((system) => system?.host === candidate))
    .find(Boolean) || systems[0];
}

function findArduinoToolSystem(indexPackages, dependency) {
  const packager = dependency?.packager;
  const name = dependency?.name;
  const version = dependency?.version;
  if (!packager || !name || !version) {
    return null;
  }

  for (const { packageEntry } of indexPackages) {
    if (packageEntry?.name !== packager || !Array.isArray(packageEntry.tools)) {
      continue;
    }

    const tool = packageEntry.tools.find((entry) => entry?.name === name && entry?.version === version);
    const system = chooseArduinoToolSystem(tool?.systems);
    if (system) {
      return {
        packager,
        name,
        version,
        host: system.host,
        archiveFileName: system.archiveFileName,
        url: system.url,
        sizeBytes: toByteCount(system.size)
      };
    }
  }

  return null;
}

async function resolveBoardPackageInstallPlan(packageName) {
  const spec = parseBoardPackageSpec(packageName);
  if (!spec) {
    return null;
  }

  const dataDir = await resolveArduinoDataDir();
  const indexPackages = readArduinoPackageIndexes(dataDir);
  const platformPackageEntries = indexPackages.filter(({ packageEntry }) => packageEntry?.name === spec.packager);
  const platforms = platformPackageEntries.flatMap(({ packageEntry, indexPath }) =>
    Array.isArray(packageEntry.platforms)
      ? packageEntry.platforms
        .filter((platform) => platform?.architecture === spec.architecture)
        .map((platform) => ({ platform, indexPath }))
      : []
  );

  if (platforms.length === 0) {
    return null;
  }

  const availableVersions = sortVersionsDescending(platforms.map(({ platform }) => platform.version).filter(Boolean));
  const selectedVersion = spec.version || availableVersions[0];
  const selectedPlatform = spec.version
    ? platforms.find(({ platform }) => platform.version === selectedVersion)
    : platforms.find(({ platform }) => platform.version === selectedVersion) || platforms[0];
  if (!selectedPlatform?.platform) {
    return null;
  }

  const tools = [];
  const seenToolKeys = new Set();
  for (const dependency of selectedPlatform.platform.toolsDependencies || []) {
    const key = `${dependency?.packager || ""}:${dependency?.name || ""}@${dependency?.version || ""}`;
    if (seenToolKeys.has(key)) {
      continue;
    }
    seenToolKeys.add(key);

    const tool = findArduinoToolSystem(indexPackages, dependency);
    if (tool) {
      tools.push(tool);
    }
  }

  const platformBytes = toByteCount(selectedPlatform.platform.size);
  const toolBytes = tools.reduce((total, tool) => total + toByteCount(tool.sizeBytes), 0);
  const requiredBytes = Math.max(
    Math.ceil(platformBytes * BOARD_PLATFORM_ARCHIVE_SPACE_MULTIPLIER + toolBytes * BOARD_TOOL_ARCHIVE_SPACE_MULTIPLIER),
    platformBytes + toolBytes + MIN_BOARD_PACKAGE_INSTALL_SPACE_BYTES
  );

  return {
    id: spec.id,
    name: selectedPlatform.platform.name || spec.id,
    version: selectedPlatform.platform.version || selectedVersion || "latest",
    dataDir,
    indexPath: selectedPlatform.indexPath,
    platform: {
      archiveFileName: selectedPlatform.platform.archiveFileName,
      url: selectedPlatform.platform.url,
      sizeBytes: platformBytes
    },
    tools,
    archiveBytes: platformBytes + toolBytes,
    requiredBytes
  };
}

async function assertEnoughBoardPackageStorage(packageName, onProgress) {
  const plan = await resolveBoardPackageInstallPlan(packageName);
  if (!plan) {
    return null;
  }

  const check = assertEnoughStorage({
    label: `${plan.id}@${plan.version}`,
    targetDir: plan.dataDir,
    requiredBytes: plan.requiredBytes
  });

  if (check && onProgress) {
    onProgress(
      `Storage check passed: ${formatStorageBytes(check.availableBytes)} available on ${check.targetDir}; ` +
      `${formatStorageBytes(check.requiredBytes)} estimated required for ${plan.id}@${plan.version}.\n`
    );
  }

  return {
    ...plan,
    storage: check
  };
}

function getArduinoCliEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const storageLayout = ensureArduinoStorageLayout();
  const configuredTimeout =
    normalizeCliConfigValue(env.ARDUINO_NETWORK_CONNECTION_TIMEOUT) ||
    normalizeCliConfigValue(env.TANTALUM_ARDUINO_NETWORK_CONNECTION_TIMEOUT);

  env.ARDUINO_NETWORK_CONNECTION_TIMEOUT =
    configuredTimeout || DEFAULT_ARDUINO_NETWORK_CONNECTION_TIMEOUT;

  if (storageLayout) {
    env.ARDUINO_DIRECTORIES_DATA = storageLayout.dataDir;
    env.ARDUINO_DIRECTORIES_DOWNLOADS = storageLayout.downloadsDir;
    env.ARDUINO_DIRECTORIES_USER = storageLayout.userDir;
    env.ARDUINO_BUILD_CACHE_PATH = storageLayout.buildCacheDir;
    env.TEMP = storageLayout.tempDir;
    env.TMP = storageLayout.tempDir;
    env.TMPDIR = storageLayout.tempDir;
  }

  return env;
}

function withArduinoCliEnv(options = {}) {
  return {
    ...options,
    env: getArduinoCliEnv(options.env)
  };
}

/**
 * Get path to bundled arduino-cli binary based on OS and architecture
 * Works with Electron packaged apps using extraResources
 */
function getCliPath() {
  const platform = process.platform; // "darwin", "win32", "linux"
  const arch = process.arch;         // "x64", "arm64", etc.

  // Determine the CLI binary name based on platform
  let cliBinaryName;
  if (platform === "darwin") {
    cliBinaryName = arch === "arm64" ? "arduino-cli-arm64" : "arduino-cli-x64";
  } else if (platform === "win32") {
    cliBinaryName = "arduino-cli.exe";
  } else if (platform === "linux") {
    cliBinaryName = "arduino-cli";
  } else {
    throw new Error("Unsupported OS for Arduino CLI");
  }

  // Platform folder name
  const platformFolder = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";

  // Check multiple possible paths for the CLI binary
  const possiblePaths = [
    // Development path (direct project folder)
    path.join(__dirname, "resources", platformFolder, cliBinaryName),
    // Alternative development path (if arduino-cli subfolder exists)
    path.join(__dirname, "resources", "arduino-cli", platformFolder, cliBinaryName),
    // Production path (packaged app)
    process.resourcesPath ? path.join(process.resourcesPath, "arduino-cli", platformFolder, cliBinaryName) : null,
    // Another production variant
    process.resourcesPath ? path.join(process.resourcesPath, platformFolder, cliBinaryName) : null,
  ].filter(Boolean);

  // Find the first path that exists
  let cliPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      cliPath = p;
      break;
    }
  }

  if (!cliPath) {
    console.error('Arduino CLI not found! Checked paths:', possiblePaths);
    throw new Error(`Arduino CLI binary not found. Checked: ${possiblePaths.join(', ')}`);
  }

  console.log('Arduino CLI path:', cliPath);

  // Ensure executable permission on macOS/Linux
  if (platform !== "win32") {
    try {
      fs.chmodSync(cliPath, 0o755);
    } catch (err) {
      console.warn("Could not set executable permission:", err.message);
    }
  }

  return cliPath;
}

const libraryInstallQueues = new Map();
const LIBRARY_PROPERTIES_FILE = "library.properties";
const FEATURED_LIBRARY_NAMES = [
  "ArduinoJson",
  "Adafruit NeoPixel",
  "DHT sensor library",
  "Adafruit GFX Library",
  "Adafruit SSD1306",
  "Adafruit BusIO",
  "FastLED",
  "PubSubClient",
  "OneWire",
  "DallasTemperature",
  "AccelStepper",
  "ArduinoHttpClient",
  "ArduinoMqttClient",
  "NTPClient",
  "IRremote",
  "MFRC522",
  "RTClib",
  "Adafruit BMP280 Library",
  "Adafruit BME280 Library",
  "ESP32Servo"
];



/**
 * Helper to run a command with progress tracking
 * @param {Array} args - Command arguments
 * @param {Function} onProgress - Progress callback
 * @param {number} timeout - Timeout in ms (default 15 minutes for large downloads)
 */
function runSpawnCommand(args, onProgress, timeout = 900000, options = {}) {
  const cliPath = getCliPath();
  const { signal, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCanceledError());
      return;
    }

    const child = spawn(cliPath, args, withArduinoCliEnv(spawnOptions));
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
      callback();
    };

    const abortHandler = () => {
      child.kill("SIGTERM");
      settle(() => reject(createCanceledError()));
    };

    // Set timeout for the entire operation
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new Error(`Client.Timeout: Operation timed out after ${Math.round(timeout / 60000)} minutes. The download may resume on retry.`)));
    }, timeout);

    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (onProgress) onProgress(chunk);
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (onProgress) onProgress(chunk); // Arduino CLI often sends progress to stderr
    });

    child.on("close", (code) => {
      if (code === 0) {
        settle(() => resolve({ success: true, output: stdout }));
      } else {
        settle(() => reject(new Error(stderr || stdout || `Command failed with code ${code}`)));
      }
    });

    child.on("error", (err) => {
      settle(() => reject(isCanceledError(err) ? createCanceledError() : err));
    });
  });
}

function runExecCommand(command, options = {}) {
  const { signal, ...execOptions } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCanceledError());
      return;
    }

    const child = exec(command, withArduinoCliEnv(execOptions), (error, stdout, stderr) => {
      signal?.removeEventListener("abort", abortHandler);
      if (error) {
        reject(signal?.aborted || isCanceledError(error) ? createCanceledError() : new Error(stderr || stdout || error.message));
        return;
      }

      resolve({ stdout, stderr });
    });

    const abortHandler = () => {
      child.kill("SIGTERM");
      reject(createCanceledError());
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

function normalizeCliConfigValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "\"\"" || normalized === "''") {
    return null;
  }

  if (
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1).trim() || null;
  }

  return normalized;
}

function getFallbackArduinoUserDir() {
  const homeDir = os.homedir();

  if (process.platform === "win32") {
    return path.join(process.env.USERPROFILE || homeDir, "Documents", "Arduino");
  }

  if (process.platform === "darwin") {
    return path.join(homeDir, "Documents", "Arduino");
  }

  return path.join(homeDir, "Arduino");
}

function getAppManagedArduinoUserDir() {
  const homeDir = os.homedir();

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "Tantalum IDE", "Arduino");
  }

  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Tantalum IDE", "Arduino");
  }

  return path.join(process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "tantalum-ide", "Arduino");
}

function getArduinoCliConfigValue(key) {
  const cliPath = getCliPath();

  return new Promise((resolve) => {
    execFile(cliPath, ["config", "get", key], withArduinoCliEnv({ timeout: 30000 }), (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }

      resolve(normalizeCliConfigValue(stdout));
    });
  });
}

async function resolveArduinoUserDir() {
  const storageLayout = ensureArduinoStorageLayout();
  if (storageLayout) {
    return storageLayout.userDir;
  }

  const envUserDir = normalizeCliConfigValue(process.env.ARDUINO_DIRECTORIES_USER);
  if (envUserDir) {
    return envUserDir;
  }

  const configuredUserDir = await getArduinoCliConfigValue("directories.user");
  return configuredUserDir || getFallbackArduinoUserDir();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureWritableArduinoDirectories(userDir) {
  const librariesDir = path.join(userDir, "libraries");
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.mkdirSync(userDir, { recursive: true });
      fs.mkdirSync(librariesDir, { recursive: true });

      const stat = fs.statSync(librariesDir);
      if (!stat.isDirectory()) {
        throw new Error(`Arduino libraries path is not a directory: ${librariesDir}`);
      }

      const probePath = path.join(librariesDir, `.tantalum-write-probe-${process.pid}-${Date.now()}-${attempt}.tmp`);
      fs.writeFileSync(probePath, "probe");
      fs.rmSync(probePath, { force: true });

      return { userDir, librariesDir };
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await delay(80 * attempt);
      }
    }
  }

  throw new Error(`Arduino libraries folder is not writable: ${librariesDir}. ${lastError?.message || "Unknown error"}`);
}

async function ensureArduinoLibraryDirectory() {
  const configuredUserDir = await resolveArduinoUserDir();
  const fallbackUserDir = getFallbackArduinoUserDir();
  const appManagedUserDir = getAppManagedArduinoUserDir();
  const candidates = Array.from(new Set([configuredUserDir, fallbackUserDir, appManagedUserDir].filter(Boolean).map((candidate) => path.resolve(candidate))));
  const failures = [];

  for (const candidate of candidates) {
    try {
      const resolved = await ensureWritableArduinoDirectories(candidate);
      return {
        ...resolved,
        fallback: candidate !== path.resolve(configuredUserDir),
        configuredUserDir,
        failures
      };
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(`Unable to create a writable Arduino libraries folder. Tried: ${failures.join(" | ")}`);
}

async function getArduinoLibraryDirectory() {
  const sketchbook = await ensureArduinoLibraryDirectory();
  return {
    success: true,
    userDir: sketchbook.userDir,
    librariesDir: sketchbook.librariesDir,
    fallback: Boolean(sketchbook.fallback),
    configuredUserDir: sketchbook.configuredUserDir || null,
    failures: sketchbook.failures || []
  };
}

function escapeYamlSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function createArduinoCliConfig(userDir) {
  const configDir = fs.mkdtempSync(path.join(getArduinoTempDir(), "tantalum-arduino-cli-"));
  const configFile = path.join(configDir, "arduino-cli.yaml");
  const storageLayout = ensureArduinoStorageLayout();
  const config = storageLayout
    ? [
        "directories:",
        `  data: '${escapeYamlSingleQuoted(storageLayout.dataDir)}'`,
        `  downloads: '${escapeYamlSingleQuoted(storageLayout.downloadsDir)}'`,
        `  user: '${escapeYamlSingleQuoted(storageLayout.userDir)}'`,
        "build_cache:",
        `  path: '${escapeYamlSingleQuoted(storageLayout.buildCacheDir)}'`,
        ""
      ].join("\n")
    : `directories:\n  user: '${escapeYamlSingleQuoted(userDir)}'\n`;
  fs.writeFileSync(configFile, config, "utf8");
  return { configDir, configFile };
}

function isPathInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeLibraryKey(value) {
  return String(value || "").trim().toLowerCase();
}

function parseLibraryProperties(content) {
  const properties = {};
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    properties[key] = value;
  }

  return properties;
}

function readLibraryPropertiesFile(propertiesPath) {
  try {
    return parseLibraryProperties(fs.readFileSync(propertiesPath, "utf8"));
  } catch {
    return null;
  }
}

function sanitizeArduinoLibraryFolderName(value) {
  let sanitized = String(value || "ArduinoLibrary")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/^_+|_+$/g, "");

  if (!sanitized) {
    sanitized = "ArduinoLibrary";
  }

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  return sanitized.slice(0, 96);
}

function checksumMatches(checksum, filePath) {
  if (!checksum) {
    return true;
  }

  const match = String(checksum).match(/^SHA-256:([a-f0-9]{64})$/i);
  if (!match) {
    throw new Error(`Unsupported library checksum format: ${checksum}`);
  }

  const hash = crypto.createHash("sha256");
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest("hex").toLowerCase() === match[1].toLowerCase();
}

function formatExampleDisplayName(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] || normalized;
  const sketchName = fileName.replace(/\.ino$/i, "");
  const parentName = parts.length > 1 ? parts[parts.length - 2] : "";

  if (parentName && parentName.toLowerCase() === sketchName.toLowerCase()) {
    return parts.slice(0, -1).join(" / ");
  }

  return normalized.replace(/\.ino$/i, "").replace(/\//g, " / ");
}

function scanLibraryExamples(installDir) {
  const examplesDir = path.join(installDir, "examples");
  if (!fs.existsSync(examplesDir)) {
    return [];
  }

  const examples = [];
  const queue = [{ dir: examplesDir, depth: 0 }];
  const maxDepth = 4;
  const maxExamples = 80;

  while (queue.length > 0 && examples.length < maxExamples) {
    const current = queue.shift();
    let entries = [];

    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: entryPath, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".ino")) {
        continue;
      }

      const relativePath = path.relative(examplesDir, entryPath);
      examples.push({
        name: formatExampleDisplayName(relativePath),
        relativePath: relativePath.replace(/\\/g, "/"),
        sketchPath: entryPath
      });

      if (examples.length >= maxExamples) {
        break;
      }
    }
  }

  return examples.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function scanInstalledLibrariesSync(librariesDir) {
  if (!fs.existsSync(librariesDir)) {
    return [];
  }

  const entries = fs.readdirSync(librariesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tantalum-"))
    .map((entry) => {
      const installDir = path.join(librariesDir, entry.name);
      const properties = readLibraryPropertiesFile(path.join(installDir, LIBRARY_PROPERTIES_FILE));
      if (!properties?.name) {
        return null;
      }

      return {
        name: properties.name,
        version: properties.version,
        installedVersion: properties.version,
        author: properties.author,
        maintainer: properties.maintainer,
        sentence: properties.sentence || "",
        paragraph: properties.paragraph || "",
        website: properties.url || properties.website,
        category: properties.category,
        architectures: properties.architectures ? properties.architectures.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
        installDir,
        sourceDir: path.join(installDir, "src"),
        examples: scanLibraryExamples(installDir),
        installed: true
      };
    })
    .filter(Boolean);
}

function getInstalledLibraryMap(librariesDir) {
  return new Map(scanInstalledLibrariesSync(librariesDir).map((library) => [normalizeLibraryKey(library.name), library]));
}

function runCliJson(args, timeout = 60000, options = {}) {
  const cliPath = getCliPath();
  return new Promise((resolve, reject) => {
    execFile(cliPath, args, withArduinoCliEnv({ timeout, maxBuffer: 50 * 1024 * 1024, signal: options.signal }), (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(isCanceledError(error) ? createCanceledError() : new Error(stderr || error.message));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`Failed to parse Arduino CLI JSON output: ${parseError.message}`));
      }
    });
  });
}

function sortVersionsDescending(versions) {
  return [...versions].sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }));
}

function asHttpUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    const parsedUrl = new URL(value.trim());
    return ["http:", "https:"].includes(parsedUrl.protocol) ? parsedUrl.toString() : null;
  } catch {
    return null;
  }
}

function inferGithubUrlFromResource(resourceUrl, version) {
  const parsedUrl = asHttpUrl(resourceUrl);
  if (!parsedUrl) {
    return null;
  }

  try {
    const url = new URL(parsedUrl);
    const segments = url.pathname.split("/").map((segment) => decodeURIComponent(segment)).filter(Boolean);
    const githubIndex = segments.findIndex((segment) => segment.toLowerCase() === "github.com");

    if (githubIndex >= 0 && segments.length > githubIndex + 2) {
      const owner = segments[githubIndex + 1];
      let repository = segments[githubIndex + 2].replace(/\.zip$/i, "");
      const suffix = version ? `-${version}` : "";
      if (suffix && repository.toLowerCase().endsWith(suffix.toLowerCase())) {
        repository = repository.slice(0, -suffix.length);
      }
      return asHttpUrl(`https://github.com/${owner}/${repository}`);
    }

    if (url.hostname.toLowerCase() === "github.com" && segments.length >= 2) {
      return asHttpUrl(`https://github.com/${segments[0]}/${segments[1]}`);
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeLibraryWebsite(library, release, version) {
  const resourceUrl = release?.resources?.url || library?.resources?.url;
  const candidates = [
    release?.website,
    release?.url,
    release?.repository,
    library?.website,
    library?.url,
    library?.repository,
    inferGithubUrlFromResource(resourceUrl, version)
  ];

  for (const candidate of candidates) {
    const url = asHttpUrl(candidate);
    if (url) {
      return url;
    }
  }

  return undefined;
}

function summarizeLibraryReleases(library) {
  if (!library?.releases || typeof library.releases !== "object") {
    if (Array.isArray(library?.available_versions)) {
      return sortVersionsDescending(library.available_versions).map((version) => ({ version }));
    }

    if (library?.latest?.version) {
      return [{ version: library.latest.version }];
    }

    return [];
  }

  return Object.entries(library.releases)
    .map(([version, release]) => ({
      version: release?.version || version,
      archiveFileName: release?.resources?.archive_filename,
      downloadSize: release?.resources?.size,
      resourceUrl: release?.resources?.url,
      checksum: release?.resources?.checksum,
      dependencies: Array.isArray(release?.dependencies) ? release.dependencies : []
    }))
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: "base" }));
}

function normalizeLibrarySummary(library) {
  let allVersions = [];

  if (library.releases) {
    allVersions = Object.keys(library.releases).sort((a, b) => {
      return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
    });
  } else if (Array.isArray(library.available_versions)) {
    allVersions = [...library.available_versions].sort((a, b) => {
      return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
    });
  } else if (library.latest?.version) {
    allVersions = [library.latest.version];
  }

  let latest = library.latest;
  if (!latest && allVersions.length > 0 && library.releases) {
    latest = library.releases[allVersions[0]];
  }

  const latestVersion = latest?.version || allVersions[0];
  const resources = latest ? latest.resources : library.resources;

  return {
    name: library.name,
    version: latestVersion || "Unknown",
    versions: allVersions,
    author: latest ? latest.author : library.author,
    maintainer: latest ? latest.maintainer : library.maintainer,
    sentence: latest ? latest.sentence : (library.sentence || ""),
    paragraph: latest ? latest.paragraph : (library.paragraph || ""),
    website: normalizeLibraryWebsite(library, latest, latestVersion),
    category: latest ? latest.category : library.category,
    architecture: latest ? latest.architecture : library.architecture,
    architectures: latest ? latest.architectures : library.architectures,
    types: latest ? latest.types : library.types,
    resources,
    resourceUrl: resources ? resources.url : undefined,
    archiveFileName: resources ? resources.archive_filename : undefined,
    downloadSize: resources ? resources.size : undefined,
    dependencies: latest ? latest.dependencies : library.dependencies,
    releases: summarizeLibraryReleases(library),
    installed: false
  };
}

async function resolveLibraryRelease(name, version, options = {}) {
  throwIfCanceled(options.signal);
  const searchArgs = ["lib", "search", `name=${name}`, "--format", "json"];
  if (!version || version === "latest") {
    searchArgs.push("--omit-releases-details");
  }
  const result = await runCliJson(searchArgs, 60000, { signal: options.signal });
  throwIfCanceled(options.signal);
  const libraries = Array.isArray(result.libraries) ? result.libraries : [];
  const library =
    libraries.find((entry) => normalizeLibraryKey(entry.name) === normalizeLibraryKey(name)) ||
    (libraries.length === 1 ? libraries[0] : null);

  if (!library) {
    throw new Error(`Library '${name}' was not found in Arduino Library Manager.`);
  }

  const releases = library.releases || {};
  const availableVersions = Object.keys(releases).length
    ? sortVersionsDescending(Object.keys(releases))
    : Array.isArray(library.available_versions)
      ? sortVersionsDescending(library.available_versions)
      : library.latest?.version
        ? [library.latest.version]
        : [];

  const selectedVersion = version && version !== "latest" ? version : library.latest?.version || availableVersions[0];
  const release = selectedVersion && releases[selectedVersion] ? releases[selectedVersion] : library.latest;

  if (!release) {
    throw new Error(`No installable release metadata found for ${library.name}${selectedVersion ? `@${selectedVersion}` : ""}.`);
  }

  if (version && version !== "latest" && release.version !== version) {
    throw new Error(`${library.name}@${version} was not found. Available versions: ${availableVersions.join(", ") || "none"}.`);
  }

  if (!release.resources?.url) {
    throw new Error(`${library.name}@${release.version || "latest"} does not provide a downloadable archive.`);
  }

  return { library, release, version: release.version || selectedVersion || "latest" };
}

function downloadFile(url, destinationPath, expectedSize, onProgress, options = {}) {
  const { signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCanceledError("Download stopped by user."));
      return;
    }

    const requestUrl = new URL(url);
    const client = requestUrl.protocol === "http:" ? http : https;
    let fileStream = null;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (isCanceledError(error)) {
        safeRemovePath(destinationPath);
      }
      reject(error);
    };

    const resolveOnce = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const request = client.get(requestUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirectUrl = new URL(response.headers.location, requestUrl).toString();
        cleanup();
        downloadFile(redirectUrl, destinationPath, expectedSize, onProgress, options).then(resolveOnce, rejectOnce);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        rejectOnce(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      const totalBytes = Number(response.headers["content-length"]) || Number(expectedSize) || 0;
      let downloadedBytes = 0;
      fileStream = fs.createWriteStream(destinationPath);

      response.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.min(100, (downloadedBytes / totalBytes) * 100), downloadedBytes, totalBytes);
        }
      });

      response.pipe(fileStream);
      fileStream.on("finish", () => {
        fileStream.close(() => resolveOnce({ downloadedBytes, totalBytes }));
      });
      fileStream.on("error", rejectOnce);
    });

    const abortHandler = () => {
      request.destroy(createCanceledError("Download stopped by user."));
      if (fileStream) {
        fileStream.destroy(createCanceledError("Download stopped by user."));
      }
      rejectOnce(createCanceledError("Download stopped by user."));
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    request.on("error", (error) => {
      rejectOnce(signal?.aborted || isCanceledError(error) ? createCanceledError("Download stopped by user.") : error);
    });
  });
}

function validateZipEntryPath(entryName, destinationDir) {
  const normalizedName = String(entryName || "").replace(/\\/g, "/");
  if (!normalizedName || normalizedName.includes("\0") || normalizedName.startsWith("/") || /^[a-z]:/i.test(normalizedName)) {
    throw new Error(`Unsafe ZIP entry path: ${entryName}`);
  }

  const destinationPath = path.resolve(destinationDir, normalizedName);
  if (!isPathInsideRoot(destinationPath, destinationDir)) {
    throw new Error(`Blocked ZIP entry outside extraction directory: ${entryName}`);
  }

  return destinationPath;
}

function extractZip(zipPath, destinationDir, onProgress, options = {}) {
  const { signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCanceledError("Install stopped by user."));
      return;
    }

    let settled = false;
    let entryCount = 0;
    let extractedCount = 0;
    let activeZipFile = null;
    let activeReadStream = null;
    let activeWriteStream = null;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abortHandler);
      reject(error);
    };

    const complete = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abortHandler);
      resolve();
    };

    const abortHandler = () => {
      activeReadStream?.destroy(createCanceledError("Install stopped by user."));
      activeWriteStream?.destroy(createCanceledError("Install stopped by user."));
      try {
        activeZipFile?.close();
      } catch { }
      fail(createCanceledError("Install stopped by user."));
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) {
        fail(openError);
        return;
      }

      activeZipFile = zipFile;
      entryCount = zipFile.entryCount || 0;

      zipFile.on("error", fail);
      zipFile.on("end", () => {
        complete();
      });

      zipFile.on("entry", (entry) => {
        if (signal?.aborted) {
          fail(createCanceledError("Install stopped by user."));
          return;
        }

        let destinationPath;
        try {
          destinationPath = validateZipEntryPath(entry.fileName, destinationDir);
        } catch (error) {
          fail(error);
          return;
        }

        const isDirectory = /\/$/.test(entry.fileName);
        if (isDirectory) {
          fs.mkdirSync(destinationPath, { recursive: true });
          extractedCount += 1;
          if (entryCount > 0 && onProgress) {
            onProgress(Math.min(100, (extractedCount / entryCount) * 100));
          }
          zipFile.readEntry();
          return;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        zipFile.openReadStream(entry, (streamError, readStream) => {
          if (streamError) {
            fail(streamError);
            return;
          }

          activeReadStream = readStream;
          const entryMode = entry.externalFileAttributes >>> 16;
          const writeStream = fs.createWriteStream(destinationPath, entryMode ? { mode: entryMode } : undefined);
          activeWriteStream = writeStream;
          writeStream.on("close", () => {
            if (settled) {
              return;
            }

            activeReadStream = null;
            activeWriteStream = null;
            extractedCount += 1;
            if (entryCount > 0 && onProgress) {
              onProgress(Math.min(100, (extractedCount / entryCount) * 100));
            }
            zipFile.readEntry();
          });
          writeStream.on("error", fail);
          readStream.on("error", fail);
          readStream.pipe(writeStream);
        });
      });

      zipFile.readEntry();
    });
  });
}

function findLibraryPropertiesPath(rootDir) {
  const directPath = path.join(rootDir, LIBRARY_PROPERTIES_FILE);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.shift();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isFile() && entry.name === LIBRARY_PROPERTIES_FILE) {
        return entryPath;
      }
      if (entry.isDirectory()) {
        queue.push(entryPath);
      }
    }
  }

  return null;
}

function enqueueLibraryInstall(userDir, task) {
  const key = path.resolve(userDir).toLowerCase();
  const previous = libraryInstallQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const cleanup = run.finally(() => {
    if (libraryInstallQueues.get(key) === cleanup) {
      libraryInstallQueues.delete(key);
    }
  });
  libraryInstallQueues.set(key, cleanup);
  return run;
}

function safeRemovePath(targetPath) {
  if (!targetPath) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function installExtractedLibrary({ extractDir, librariesDir, releaseMetadata, installedMap }) {
  const propertiesPath = findLibraryPropertiesPath(extractDir);
  if (!propertiesPath) {
    throw new Error("Downloaded archive is not a valid Arduino library: missing library.properties.");
  }

  const libraryRoot = path.dirname(propertiesPath);
  const properties = readLibraryPropertiesFile(propertiesPath);
  if (!properties?.name) {
    throw new Error("Downloaded archive is not a valid Arduino library: library.properties has no name.");
  }

  const libraryKey = normalizeLibraryKey(properties.name);
  const existingLibrary = installedMap.get(libraryKey);
  const targetDir = existingLibrary?.installDir || path.join(librariesDir, sanitizeArduinoLibraryFolderName(properties.name));

  if (!isPathInsideRoot(targetDir, librariesDir)) {
    throw new Error(`Refusing to install library outside Arduino libraries folder: ${targetDir}`);
  }

  const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stagingDir = path.join(librariesDir, `.tantalum-stage-${operationId}`);
  const backupDir = path.join(librariesDir, `.tantalum-backup-${operationId}`);
  let backupCreated = false;

  try {
    if (fs.existsSync(stagingDir)) {
      safeRemovePath(stagingDir);
    }

    fs.renameSync(libraryRoot, stagingDir);

    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      backupCreated = true;
    }

    fs.renameSync(stagingDir, targetDir);

    if (backupCreated) {
      safeRemovePath(backupDir);
    }

    const installed = {
      name: properties.name,
      version: properties.version || releaseMetadata.version,
      installedVersion: properties.version || releaseMetadata.version,
      author: properties.author || releaseMetadata.author,
      maintainer: properties.maintainer || releaseMetadata.maintainer,
      sentence: properties.sentence || releaseMetadata.sentence || "",
      paragraph: properties.paragraph || releaseMetadata.paragraph || "",
      website: properties.url || releaseMetadata.website,
      category: properties.category || releaseMetadata.category,
      architectures: properties.architectures ? properties.architectures.split(",").map((item) => item.trim()).filter(Boolean) : releaseMetadata.architectures,
      installDir: targetDir,
      sourceDir: path.join(targetDir, "src"),
      examples: scanLibraryExamples(targetDir),
      installed: true
    };

    installedMap.set(libraryKey, installed);
    return installed;
  } catch (error) {
    safeRemovePath(stagingDir);
    if (backupCreated && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, targetDir);
    } else {
      safeRemovePath(backupDir);
    }
    throw error;
  }
}

function listValidLibraryFolders(librariesDir) {
  if (!fs.existsSync(librariesDir)) {
    return [];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(librariesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const sourceDir = path.join(librariesDir, entry.name);
      const propertiesPath = path.join(sourceDir, LIBRARY_PROPERTIES_FILE);
      const properties = readLibraryPropertiesFile(propertiesPath);
      if (!properties?.name) {
        return null;
      }

      return {
        name: properties.name,
        version: properties.version,
        sourceDir,
        properties
      };
    })
    .filter(Boolean);
}

function resolveLibraryMigrationSource(selectedPath) {
  if (!selectedPath || typeof selectedPath !== "string") {
    throw new Error("Select an Arduino sketchbook folder or a libraries folder to migrate from.");
  }

  const absolutePath = path.resolve(selectedPath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
    throw new Error("The selected Arduino library source folder does not exist.");
  }

  const selectedLibraries = listValidLibraryFolders(absolutePath);
  if (path.basename(absolutePath).toLowerCase() === "libraries" && selectedLibraries.length > 0) {
    return { sourceLibrariesDir: absolutePath, libraries: selectedLibraries };
  }

  const nestedLibrariesDir = path.join(absolutePath, "libraries");
  if (fs.existsSync(nestedLibrariesDir) && fs.statSync(nestedLibrariesDir).isDirectory()) {
    const nestedLibraries = listValidLibraryFolders(nestedLibrariesDir);
    if (nestedLibraries.length > 0) {
      return { sourceLibrariesDir: nestedLibrariesDir, libraries: nestedLibraries };
    }
  }

  if (selectedLibraries.length > 0) {
    return { sourceLibrariesDir: absolutePath, libraries: selectedLibraries };
  }

  throw new Error("No Arduino libraries were found. Select the official IDE sketchbook folder or its libraries folder.");
}

function createUniqueLibraryTargetDir(librariesDir, preferredName) {
  const baseName = sanitizeArduinoLibraryFolderName(preferredName);
  let candidate = path.join(librariesDir, baseName);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  for (let index = 2; index < 1000; index += 1) {
    candidate = path.join(librariesDir, `${baseName}_${index}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to choose a destination folder for ${preferredName}.`);
}

function resolveMigratedLibraryTarget({ librariesDir, installedMap, properties }) {
  const libraryKey = normalizeLibraryKey(properties.name);
  const existingLibrary = installedMap.get(libraryKey);
  if (existingLibrary?.installDir) {
    return existingLibrary.installDir;
  }

  const preferredTarget = path.join(librariesDir, sanitizeArduinoLibraryFolderName(properties.name));
  if (!fs.existsSync(preferredTarget)) {
    return preferredTarget;
  }

  const preferredProperties = readLibraryPropertiesFile(path.join(preferredTarget, LIBRARY_PROPERTIES_FILE));
  if (normalizeLibraryKey(preferredProperties?.name) === libraryKey) {
    return preferredTarget;
  }

  return createUniqueLibraryTargetDir(librariesDir, properties.name);
}

function copyMigratedLibrary({ sourceDir, librariesDir, installedMap }) {
  const properties = readLibraryPropertiesFile(path.join(sourceDir, LIBRARY_PROPERTIES_FILE));
  if (!properties?.name) {
    throw new Error(`Skipped invalid library folder: ${sourceDir}`);
  }

  const libraryKey = normalizeLibraryKey(properties.name);
  const targetDir = resolveMigratedLibraryTarget({ librariesDir, installedMap, properties });
  const sourceResolved = path.resolve(sourceDir);
  const targetResolved = path.resolve(targetDir);

  if (!isPathInsideRoot(targetResolved, librariesDir)) {
    throw new Error(`Refusing to migrate library outside Arduino libraries folder: ${targetDir}`);
  }

  if (sourceResolved.toLowerCase() === targetResolved.toLowerCase()) {
    return {
      action: "skipped",
      name: properties.name,
      version: properties.version,
      sourcePath: sourceDir,
      targetPath: targetDir,
      reason: "Already in Tantalum's active libraries folder."
    };
  }

  const existingLibrary = installedMap.get(libraryKey);
  if (existingLibrary && normalizeLibraryKey(existingLibrary.version) === normalizeLibraryKey(properties.version)) {
    return {
      action: "skipped",
      name: properties.name,
      version: properties.version,
      sourcePath: sourceDir,
      targetPath: existingLibrary.installDir,
      reason: "Same version is already installed."
    };
  }

  const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stagingDir = path.join(librariesDir, `.tantalum-migrate-${operationId}`);
  const backupDir = path.join(librariesDir, `.tantalum-backup-${operationId}`);
  let backupCreated = false;

  try {
    safeRemovePath(stagingDir);
    fs.cpSync(sourceDir, stagingDir, { recursive: true, force: true });

    if (!fs.existsSync(path.join(stagingDir, LIBRARY_PROPERTIES_FILE))) {
      throw new Error(`${properties.name} is missing library.properties after copy.`);
    }

    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      backupCreated = true;
    }

    fs.renameSync(stagingDir, targetDir);

    if (backupCreated) {
      safeRemovePath(backupDir);
    }

    const installed = {
      name: properties.name,
      version: properties.version,
      installedVersion: properties.version,
      author: properties.author,
      maintainer: properties.maintainer,
      sentence: properties.sentence || "",
      paragraph: properties.paragraph || "",
      website: properties.url || properties.website,
      category: properties.category,
      architectures: properties.architectures ? properties.architectures.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
      installDir: targetDir,
      sourceDir: path.join(targetDir, "src"),
      examples: scanLibraryExamples(targetDir),
      installed: true
    };

    installedMap.set(libraryKey, installed);
    return {
      action: "migrated",
      name: properties.name,
      version: properties.version,
      sourcePath: sourceDir,
      targetPath: targetDir
    };
  } catch (error) {
    safeRemovePath(stagingDir);
    if (backupCreated && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, targetDir);
    } else {
      safeRemovePath(backupDir);
    }
    throw error;
  }
}

async function migrateLibrariesFrom(sourcePath, onProgress) {
  const sketchbook = await ensureArduinoLibraryDirectory();
  const source = resolveLibraryMigrationSource(sourcePath);
  const sourceLibrariesDir = path.resolve(source.sourceLibrariesDir);
  const targetLibrariesDir = path.resolve(sketchbook.librariesDir);

  return enqueueLibraryInstall(sketchbook.userDir, async () => {
    const installedMap = getInstalledLibraryMap(targetLibrariesDir);
    const migrated = [];
    const skipped = [];
    const failed = [];
    const total = source.libraries.length;

    for (let index = 0; index < source.libraries.length; index += 1) {
      const library = source.libraries[index];
      const baseProgress = total > 0 ? Math.round((index / total) * 100) : 100;
      if (onProgress) {
        onProgress({
          phase: "Migrating",
          message: `Migrating ${library.name}${library.version ? `@${library.version}` : ""}...`,
          progress: baseProgress,
          migrated: migrated.length,
          skipped: skipped.length,
          failed: failed.length,
          total
        });
      }

      try {
        const result = copyMigratedLibrary({
          sourceDir: library.sourceDir,
          librariesDir: targetLibrariesDir,
          installedMap
        });

        if (result.action === "migrated") {
          migrated.push(result);
        } else {
          skipped.push(result);
        }
      } catch (error) {
        failed.push({
          action: "failed",
          name: library.name,
          version: library.version,
          sourcePath: library.sourceDir,
          reason: error instanceof Error ? error.message : "Unexpected migration error"
        });
      }
    }

    if (onProgress) {
      onProgress({
        phase: "Complete",
        message: `Migration complete: ${migrated.length} migrated, ${skipped.length} skipped, ${failed.length} failed.`,
        progress: 100,
        migrated: migrated.length,
        skipped: skipped.length,
        failed: failed.length,
        total
      });
    }

    return {
      success: true,
      sourceLibrariesDir,
      targetLibrariesDir,
      userDir: sketchbook.userDir,
      migrated,
      skipped,
      failed,
      total
    };
  });
}

/**
 * Compile Arduino code using the bundled Arduino CLI
 * @param {string} code - Arduino source code
 * @param {string} board - Fully qualified board name (default: arduino:avr:uno)
 * @returns {Promise<Object>} Compilation result with binary data
 */
function createTemporarySketch(code, extraFiles = {}) {
  const tmpDir = fs.mkdtempSync(path.join(getArduinoTempDir(), "arduino-"));
  const folderName = path.basename(tmpDir);
  const sketchPath = path.join(tmpDir, `${folderName}.ino`);

  fs.writeFileSync(sketchPath, code);
  for (const [fileName, contents] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(tmpDir, fileName), contents);
  }
  return { tmpDir, sketchPath, outputDir: tmpDir };
}

function normalizeSketchRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "." && part !== "..")
    .join("/");
}

function shouldSkipWorkspaceSketchDirectory(name) {
  const normalized = String(name || "").toLowerCase();
  return normalized.startsWith(".") || ARDUINO_WORKSPACE_SKIPPED_DIRS.has(normalized);
}

function isArduinoRootBuildFileName(fileName) {
  return ARDUINO_ROOT_BUILD_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isArduinoSketchFileName(fileName) {
  return ARDUINO_ROOT_SKETCH_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function stripArduinoCodeForLifecycleScan(code) {
  return String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function hasArduinoLifecycleFunction(code) {
  return /\bvoid\s+(setup|loop)\s*\(/.test(stripArduinoCodeForLifecycleScan(code));
}

function isWorkspaceEntrySketchRelativePath(relativePath, entryFileName = ARDUINO_WORKSPACE_ENTRY_FILE_NAME) {
  return normalizeSketchRelativePath(relativePath).toLowerCase() === normalizeSketchRelativePath(entryFileName).toLowerCase();
}

function isStandaloneWorkspaceSketchTab(relativePath, content, entryFileName = ARDUINO_WORKSPACE_ENTRY_FILE_NAME) {
  return isArduinoSketchFileName(relativePath)
    && !isWorkspaceEntrySketchRelativePath(relativePath, entryFileName)
    && hasArduinoLifecycleFunction(content);
}

function arduinoWorkspaceSourceOrder(entryFileName = ARDUINO_WORKSPACE_ENTRY_FILE_NAME) {
  const normalizedEntryFileName = normalizeSketchRelativePath(entryFileName).toLowerCase();
  return (left, right) => {
    const leftName = path.basename(left.relativePath);
    const rightName = path.basename(right.relativePath);
    const leftPrimary = left.relativePath.toLowerCase() === normalizedEntryFileName;
    const rightPrimary = right.relativePath.toLowerCase() === normalizedEntryFileName;
    if (leftPrimary !== rightPrimary) {
      return leftPrimary ? -1 : 1;
    }
    const leftSketch = isArduinoSketchFileName(leftName);
    const rightSketch = isArduinoSketchFileName(rightName);
    if (leftSketch !== rightSketch) {
      return leftSketch ? -1 : 1;
    }
    return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
  };
}

function normalizeWorkspaceSketchSource(source = {}) {
  const workspacePath = path.resolve(String(source.workspacePath || ""));
  const entryFileName = normalizeSketchRelativePath(source.entryFileName || ARDUINO_WORKSPACE_ENTRY_FILE_NAME) || ARDUINO_WORKSPACE_ENTRY_FILE_NAME;
  if (entryFileName.includes("/") || !isArduinoSketchFileName(entryFileName)) {
    throw new Error("Project builds must use a root .ino or .pde file as the entry file.");
  }
  const dirtyFiles = Array.isArray(source.dirtyFiles) ? source.dirtyFiles : [];
  return { kind: "workspace", workspacePath, entryFileName, dirtyFiles };
}

function getArduinoSketchFolderName(entryFileName = ARDUINO_WORKSPACE_ENTRY_FILE_NAME) {
  const stem = path.basename(entryFileName, path.extname(entryFileName)).trim();
  const normalizedStem = stem.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 63).replace(/[.]+$/g, "");
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(normalizedStem)) {
    return normalizedStem;
  }
  return path.basename(ARDUINO_WORKSPACE_ENTRY_FILE_NAME, ".ino");
}

function normalizeDirtyWorkspaceFiles(workspacePath, dirtyFiles = []) {
  const dirtyFileMap = new Map();
  for (const dirtyFile of dirtyFiles) {
    if (!dirtyFile || typeof dirtyFile !== "object") {
      continue;
    }
    const rawPath = String(dirtyFile.path || "").trim();
    if (!rawPath) {
      continue;
    }
    const absolutePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(workspacePath, rawPath);
    if (!isPathInsideRoot(absolutePath, workspacePath)) {
      continue;
    }
    const relativePath = normalizeSketchRelativePath(path.relative(workspacePath, absolutePath));
    if (!relativePath) {
      continue;
    }
    dirtyFileMap.set(relativePath.toLowerCase(), {
      absolutePath,
      relativePath,
      content: String(dirtyFile.content ?? "")
    });
  }
  return dirtyFileMap;
}

function readWorkspaceSketchFile(filePath, dirtyFileMap, relativePath) {
  const dirtyFile = dirtyFileMap.get(relativePath.toLowerCase());
  if (dirtyFile) {
    return dirtyFile.content;
  }
  return fs.readFileSync(filePath, "utf8");
}

function collectWorkspaceSketchFiles(source = {}) {
  const normalizedSource = normalizeWorkspaceSketchSource(source);
  const { workspacePath, entryFileName } = normalizedSource;
  const workspaceStats = fs.statSync(workspacePath);
  if (!workspaceStats.isDirectory()) {
    throw new Error("Project source must be a directory.");
  }

  const dirtyFileMap = normalizeDirtyWorkspaceFiles(workspacePath, normalizedSource.dirtyFiles);
  const files = [];
  const addFileWithContent = (absolutePath, relativePath, content) => {
    const normalizedRelativePath = normalizeSketchRelativePath(relativePath);
    if (!normalizedRelativePath) {
      return;
    }
    const canonicalRelativePath = normalizedRelativePath.toLowerCase() === entryFileName.toLowerCase()
      ? entryFileName
      : normalizedRelativePath;
    files.push({
      path: absolutePath,
      relativePath: canonicalRelativePath,
      content
    });
  };
  const addFile = (absolutePath, relativePath) => {
    const normalizedRelativePath = normalizeSketchRelativePath(relativePath);
    const canonicalRelativePath = normalizedRelativePath.toLowerCase() === entryFileName.toLowerCase()
      ? entryFileName
      : normalizedRelativePath;
    const content = readWorkspaceSketchFile(absolutePath, dirtyFileMap, canonicalRelativePath);
    addFileWithContent(absolutePath, canonicalRelativePath, content);
  };

  const rootEntries = fs.readdirSync(workspacePath, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(workspacePath, entry.name);
    if (entry.isFile() && isArduinoRootBuildFileName(entry.name)) {
      const content = readWorkspaceSketchFile(entryPath, dirtyFileMap, entry.name);
      if (isStandaloneWorkspaceSketchTab(entry.name, content, entryFileName)) {
        continue;
      }
      addFileWithContent(entryPath, entry.name, content);
    }
  }

  const visitIncludedDirectory = (dirPath, relativeDir) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldSkipWorkspaceSketchDirectory(entry.name)) {
          continue;
        }
        visitIncludedDirectory(path.join(dirPath, entry.name), `${relativeDir}/${entry.name}`);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (isArduinoSketchFileName(entry.name)) {
        continue;
      }
      const relativePath = normalizeSketchRelativePath(`${relativeDir}/${entry.name}`);
      addFile(path.join(dirPath, entry.name), relativePath);
    }
  };

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const normalizedName = entry.name.toLowerCase();
    if (!ARDUINO_WORKSPACE_INCLUDED_DIRS.has(normalizedName)) {
      continue;
    }
    visitIncludedDirectory(path.join(workspacePath, entry.name), normalizedName);
  }

  const includedFileKeys = new Set(files.map((file) => file.relativePath.toLowerCase()));
  for (const dirtyFile of dirtyFileMap.values()) {
    const parts = dirtyFile.relativePath.split("/").filter(Boolean);
    if (parts.length === 0 || includedFileKeys.has(dirtyFile.relativePath.toLowerCase())) {
      continue;
    }
    const isRootBuildFile = parts.length === 1 && isArduinoRootBuildFileName(dirtyFile.relativePath);
    const isSrcFile = parts.length > 1
      && ARDUINO_WORKSPACE_INCLUDED_DIRS.has(parts[0].toLowerCase())
      && !isArduinoSketchFileName(dirtyFile.relativePath)
      && !parts.some((part) => shouldSkipWorkspaceSketchDirectory(part));
    if (!isRootBuildFile && !isSrcFile) {
      continue;
    }
    if (isRootBuildFile && isStandaloneWorkspaceSketchTab(dirtyFile.relativePath, dirtyFile.content, entryFileName)) {
      continue;
    }
    const canonicalDirtyParts = [...parts];
    if (canonicalDirtyParts.length > 1 && ARDUINO_WORKSPACE_INCLUDED_DIRS.has(canonicalDirtyParts[0].toLowerCase())) {
      canonicalDirtyParts[0] = canonicalDirtyParts[0].toLowerCase();
    }
    const canonicalDirtyRelativePath = canonicalDirtyParts.join("/");
    const canonicalRelativePath = canonicalDirtyRelativePath.toLowerCase() === entryFileName.toLowerCase()
      ? entryFileName
      : canonicalDirtyRelativePath;
    files.push({
      path: dirtyFile.absolutePath,
      relativePath: canonicalRelativePath,
      content: dirtyFile.content
    });
    includedFileKeys.add(canonicalRelativePath.toLowerCase());
  }

  files.sort(arduinoWorkspaceSourceOrder(entryFileName));
  if (!files.some((file) => file.relativePath.toLowerCase() === entryFileName.toLowerCase())) {
    const dirtyEntry = dirtyFileMap.get(entryFileName.toLowerCase());
    if (dirtyEntry) {
      files.unshift({
        path: dirtyEntry.absolutePath,
        relativePath: entryFileName,
        content: dirtyEntry.content
      });
    } else {
      throw new Error(`Project builds require a root ${entryFileName} file.`);
    }
  }
  return files;
}

function buildCloudRuntimePrefix(cloudRuntime = {}) {
  const serviceName = cloudRuntime.provisioningServiceName || `Tantalum-${String(cloudRuntime.boardId || "board").slice(-8)}`;
  const wifiHostname = buildTantalumWifiHostname(
    cloudRuntime.wifiHostname || cloudRuntime.boardName || cloudRuntime.name,
    cloudRuntime.boardId
  );
  const buildEpoch = Math.max(
    1700000000,
    Number.parseInt(cloudRuntime.buildEpoch || Math.floor(Date.now() / 1000), 10) || 1700000000
  );
  const otaUpdateMode = normalizeCloudOtaUpdateMode(cloudRuntime.otaUpdateMode);
  const mqttEnabled = cloudRuntimeUsesMqtt({ ...cloudRuntime, otaUpdateMode });

  return [
    "/* Generated by Tantalum IDE for cloud-board OTA builds. */",
    `#define TANTALUM_BOARD_ID ${cStringLiteral(cloudRuntime.boardId)}`,
    `#define TANTALUM_API_TOKEN ${cStringLiteral(cloudRuntime.apiToken)}`,
    `#define TANTALUM_APPWRITE_ENDPOINT ${cStringLiteral(cloudRuntime.appwriteEndpoint)}`,
    `#define TANTALUM_APPWRITE_PROJECT_ID ${cStringLiteral(cloudRuntime.appwriteProjectId)}`,
    `#define TANTALUM_DEVICE_GATEWAY_FUNCTION_ID ${cStringLiteral(cloudRuntime.deviceGatewayFunctionId)}`,
    `#define TANTALUM_FIRMWARE_VERSION ${cStringLiteral(cloudRuntime.firmwareVersion || "1.0.0")}`,
    `#define TANTALUM_FIRMWARE_ID ${cStringLiteral(cloudRuntime.firmwareId)}`,
    `#define TANTALUM_RUNTIME_VERSION ${cStringLiteral(TANTALUM_RUNTIME_VERSION)}`,
    `#define TANTALUM_BUILD_EPOCH ${cNumberLiteral(buildEpoch, 1700000000)}`,
    `#define TANTALUM_OTA_UPDATE_MODE ${cStringLiteral(otaUpdateMode)}`,
    `#define TANTALUM_MQTT_REQUIRED ${mqttEnabled ? "1" : "0"}`,
    `#define TANTALUM_MQTT_HOST ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttHost : "")}`,
    `#define TANTALUM_MQTT_PORT ${cNumberLiteral(mqttEnabled ? cloudRuntime.mqttPort : "", 8883)}`,
    `#define TANTALUM_MQTT_USERNAME ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttUsername : "")}`,
    `#define TANTALUM_MQTT_PASSWORD ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttPassword : "")}`,
    `#define TANTALUM_MQTT_TOPIC ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttTopic : "")}`,
    `#define TANTALUM_COMMAND_SECRET ${cStringLiteral(cloudRuntime.commandSecret)}`,
    `#define TANTALUM_TLS_CA_CERT ${cPemLiteral(cloudRuntime.tlsCaCert)}`,
    `#define TANTALUM_MQTT_CA_CERT ${cPemLiteral(mqttEnabled ? cloudRuntime.mqttCaCert : "")}`,
    `#define TANTALUM_PROVISIONING_POP ${cStringLiteral(cloudRuntime.provisioningPop)}`,
    `#define TANTALUM_PROVISIONING_SERVICE_NAME ${cStringLiteral(serviceName)}`,
    `#define TANTALUM_WIFI_HOSTNAME ${cStringLiteral(wifiHostname)}`,
    mqttEnabled ? "#include <PubSubClient.h>" : "",
    `#include "${TANTALUM_RUNTIME_HEADER_NAME}"`,
    ""
  ].join("\n");
}

function buildCloudRuntimeSuffix() {
  return [
    "",
    "void setup() {",
    "  TantalumCloud.begin();",
    "  tantalumUserSetup();",
    "}",
    "",
    "void loop() {",
    "  TantalumCloud.loop();",
    "  tantalumUserLoop();",
    "}"
  ].join("\n");
}

function replaceSketchLifecycleFunctionDefinition(code, name, replacement) {
  const pattern = new RegExp(`\\bvoid\\s+${name}\\s*\\(`);
  if (!pattern.test(code)) {
    return {
      code,
      replaced: false
    };
  }
  return {
    code: code.replace(pattern, `void ${replacement}(`),
    replaced: true
  };
}

function applyCloudRuntimeToWorkspaceSketchFiles(files, cloudRuntime = {}, entryFileName = ARDUINO_WORKSPACE_ENTRY_FILE_NAME) {
  let setupReplaced = false;
  let loopReplaced = false;
  const transformedFiles = files.map((file) => {
    if (!isArduinoSketchFileName(file.relativePath)) {
      return file;
    }
    let content = file.content;
    const setupResult = replaceSketchLifecycleFunctionDefinition(content, "setup", "tantalumUserSetup");
    content = setupResult.code;
    setupReplaced = setupReplaced || setupResult.replaced;
    const loopResult = replaceSketchLifecycleFunctionDefinition(content, "loop", "tantalumUserLoop");
    content = loopResult.code;
    loopReplaced = loopReplaced || loopResult.replaced;
    return { ...file, content };
  });

  const primaryIndex = transformedFiles.findIndex((file) => file.relativePath.toLowerCase() === entryFileName.toLowerCase());
  if (primaryIndex >= 0) {
    const primaryFile = transformedFiles[primaryIndex];
    const lifecycleFallbacks = [
      setupReplaced ? "" : "void tantalumUserSetup() {}",
      loopReplaced ? "" : "void tantalumUserLoop() {}"
    ].filter(Boolean).join("\n");
    transformedFiles[primaryIndex] = {
      ...primaryFile,
      content: [
        buildCloudRuntimePrefix(cloudRuntime),
        lifecycleFallbacks,
        primaryFile.content,
        buildCloudRuntimeSuffix()
      ].filter(Boolean).join("\n\n")
    };
  }

  return transformedFiles;
}

function writeTemporarySketchFile(sketchDir, relativePath, content) {
  const destinationPath = path.join(sketchDir, ...normalizeSketchRelativePath(relativePath).split("/"));
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, content, "utf8");
}

function createTemporaryWorkspaceSketch(source, extraFiles = {}, options = {}) {
  const normalizedSource = normalizeWorkspaceSketchSource(source);
  const tempRoot = fs.mkdtempSync(path.join(getArduinoTempDir(), "arduino-workspace-"));
  const sketchFolderName = getArduinoSketchFolderName(normalizedSource.entryFileName);
  const sketchDir = path.join(tempRoot, sketchFolderName);
  fs.mkdirSync(sketchDir, { recursive: true });
  const collectedFiles = collectWorkspaceSketchFiles(normalizedSource);
  const files = options.cloudRuntime
    ? applyCloudRuntimeToWorkspaceSketchFiles(collectedFiles, options.cloudRuntime, normalizedSource.entryFileName)
    : collectedFiles;

  for (const file of files) {
    writeTemporarySketchFile(sketchDir, file.relativePath, file.content);
  }
  for (const [fileName, contents] of Object.entries(extraFiles)) {
    writeTemporarySketchFile(sketchDir, fileName, contents);
  }

  return {
    tmpDir: sketchDir,
    tempRoot,
    sketchPath: path.join(sketchDir, normalizedSource.entryFileName),
    outputDir: tempRoot,
    entryFileName: normalizedSource.entryFileName,
    files: files.map((file) => ({
      path: file.path,
      relativePath: file.relativePath
    }))
  };
}

function normalizeSourceRestoreMarker(marker = null) {
  if (!marker || typeof marker !== "object") {
    return null;
  }
  const markerId = String(marker.markerId || "").trim();
  const snapshotChecksum = String(marker.snapshotChecksum || marker.sourceSnapshotChecksum || "").trim().toLowerCase();
  if (!/^source_[a-z0-9_-]{8,80}$/i.test(markerId) || !/^[a-f0-9]{64}$/.test(snapshotChecksum)) {
    return null;
  }
  return { markerId, snapshotChecksum };
}

function sourceRestoreMarkerLiteral(marker) {
  return `${TANTALUM_SOURCE_MARKER_PREFIX}::${marker.markerId}::${marker.snapshotChecksum}::END`;
}

function findBuildArtifacts(outputDir) {
  const artifacts = [];
  const root = path.resolve(outputDir || "");
  if (!root || !fs.existsSync(root)) {
    return artifacts;
  }

  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (/\.(?:bin|hex)$/i.test(entry.name)) {
        artifacts.push(entryPath);
      }
    }
  };
  visit(root);
  return artifacts;
}

function parseIntelHexToBuffer(hexInput) {
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
      continue;
    }

    const byteCount = Number.parseInt(line.slice(1, 3), 16);
    const offset = Number.parseInt(line.slice(3, 7), 16);
    const recordType = Number.parseInt(line.slice(7, 9), 16);
    const dataHex = line.slice(9, 9 + byteCount * 2);
    if (!Number.isFinite(byteCount) || !Number.isFinite(offset) || !Number.isFinite(recordType) || dataHex.length !== byteCount * 2) {
      continue;
    }

    if (recordType === 0x00) {
      const absoluteAddress = baseAddress + offset;
      const data = Buffer.from(dataHex, "hex");
      records.push({ address: absoluteAddress, data });
      minAddress = Math.min(minAddress, absoluteAddress);
      maxAddress = Math.max(maxAddress, absoluteAddress + data.length);
    } else if (recordType === 0x01) {
      break;
    } else if (recordType === 0x02 && dataHex.length === 4) {
      baseAddress = Buffer.from(dataHex, "hex").readUInt16BE(0) << 4;
    } else if (recordType === 0x04 && dataHex.length === 4) {
      baseAddress = Buffer.from(dataHex, "hex").readUInt16BE(0) << 16;
    }
  }

  if (!records.length || !Number.isFinite(minAddress) || maxAddress <= minAddress) {
    return Buffer.alloc(0);
  }

  const buffer = Buffer.alloc(maxAddress - minAddress, 0xff);
  for (const record of records) {
    record.data.copy(buffer, record.address - minAddress);
  }
  return buffer;
}

function readBuildArtifactBuffer(filePath) {
  const raw = fs.readFileSync(filePath);
  if (/\.hex$/i.test(filePath)) {
    return parseIntelHexToBuffer(raw);
  }
  return raw;
}

function scanCompiledArtifactsForSourceRestoreMarker(outputDir, markerInput) {
  const marker = normalizeSourceRestoreMarker(markerInput);
  if (!marker) {
    return {
      requested: false,
      embedded: false,
      artifacts: [],
      marker: null,
    };
  }

  const literal = sourceRestoreMarkerLiteral(marker);
  const needle = Buffer.from(literal, "ascii");
  const artifacts = findBuildArtifacts(outputDir).map((artifactPath) => {
    let size = 0;
    let embedded = false;
    try {
      const buffer = readBuildArtifactBuffer(artifactPath);
      size = buffer.length;
      embedded = buffer.indexOf(needle) >= 0;
    } catch {
      embedded = false;
    }
    return {
      path: artifactPath,
      filename: path.basename(artifactPath),
      size,
      embedded,
    };
  });

  return {
    requested: true,
    embedded: artifacts.some((artifact) => artifact.embedded),
    artifacts,
    marker,
    literal,
  };
}

function assertSourceRestoreMarkerEmbedded(outputDir, markerInput) {
  const scan = scanCompiledArtifactsForSourceRestoreMarker(outputDir, markerInput);
  if (!scan.requested) {
    return scan;
  }
  if (!scan.embedded) {
    const artifactList = scan.artifacts.length
      ? scan.artifacts.map((artifact) => `${artifact.filename} (${artifact.size} bytes)`).join(", ")
      : "no .bin/.hex artifacts";
    throw new Error(`Source restore marker was removed from the compiled firmware. Tantalum stopped before flashing because View Code would not be able to find this upload later. Checked ${artifactList}.`);
  }
  return scan;
}

function buildSourceRestoreMarkerFile(markerInput) {
  const marker = normalizeSourceRestoreMarker(markerInput);
  if (!marker) {
    return null;
  }
  const literal = sourceRestoreMarkerLiteral(marker);
  return [
    "/* Generated by Tantalum IDE. Do not edit. */",
    "#include <stdint.h>",
    "",
    "extern \"C\" {",
    "#if defined(__GNUC__)",
    "__attribute__((used, section(\".rodata.tantalum_source_marker\")))",
    "#endif",
    `const char TANTALUM_SOURCE_SNAPSHOT_MARKER[] = ${JSON.stringify(literal)};`,
    "#if defined(__GNUC__)",
    "__attribute__((used))",
    "#endif",
    "volatile uint32_t TANTALUM_SOURCE_SNAPSHOT_MARKER_SINK = 0;",
    "}",
    "",
    "#if defined(__GNUC__)",
    "__attribute__((used, constructor))",
    "#endif",
    "static void tantalumSourceSnapshotMarkerAnchor(void) {",
    "  const volatile char *marker = TANTALUM_SOURCE_SNAPSHOT_MARKER;",
    "  uint32_t hash = 2166136261u;",
    "  for (uint32_t index = 0; marker[index] != '\\0'; ++index) {",
    "    hash = (hash ^ (uint8_t)marker[index]) * 16777619u;",
    "  }",
    "  TANTALUM_SOURCE_SNAPSHOT_MARKER_SINK = hash;",
    "}",
    "",
  ].join("\n");
}

function buildGeneratedExtraFiles({ cloudRuntime = null, sourceRestoreMarker = null } = {}) {
  const extraFiles = {};
  if (cloudRuntime) {
    extraFiles[TANTALUM_RUNTIME_HEADER_NAME] = fs.readFileSync(TANTALUM_RUNTIME_HEADER_PATH, "utf8");
  }
  const markerFile = buildSourceRestoreMarkerFile(sourceRestoreMarker);
  if (markerFile) {
    extraFiles[TANTALUM_SOURCE_MARKER_FILE_NAME] = markerFile;
  }
  return extraFiles;
}

function cleanupPath(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) { }
}

function normalizeArduinoCliOutput(value) {
  return String(value || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function joinArduinoCliOutput(stdout, stderr) {
  return [stdout, stderr]
    .map(normalizeArduinoCliOutput)
    .filter(Boolean)
    .join("\n");
}

function appendArduinoCliDiagnosticHint(message) {
  const normalized = normalizeArduinoCliOutput(message);
  const portMatch = normalized.match(/Could not open\s+([A-Za-z0-9/._-]+)/i) ||
    normalized.match(/port\s+'([^']+)'/i) ||
    normalized.match(/Serial port\s+([A-Za-z0-9/._-]+)\s*:/i);
  const portLabel = portMatch?.[1] || "the selected port";
  const accessDenied = /Access is denied|port is busy/i.test(normalized);
  const cannotConfigurePort = /Cannot configure port|device attached to the system is not functioning/i.test(normalized);
  const permissionDenied = /PermissionError/i.test(normalized);
  const portUnavailable = /FileNotFoundError|cannot find the file specified|doesn't exist|not currently available|No such file|ENOENT/i.test(normalized);

  if (portUnavailable && !permissionDenied) {
    return `${normalized}\n\nTantalum hint: ${portLabel} is not currently available. ESP boards can change COM ports when they reset for upload. Reconnect the board or run Auto scan, then try Upload again.`;
  }

  if (cannotConfigurePort) {
    return `${normalized}\n\nTantalum hint: ${portLabel} could not be configured. The board may have reset onto another COM port, the USB driver may be stuck, or another app may be holding the port. Run Auto scan or Find blockers, then try Upload again.`;
  }

  if (accessDenied) {
    return `${normalized}\n\nTantalum hint: ${portLabel} looks busy. Close Arduino IDE Serial Monitor, Arduino IDE Plotter, or any other serial terminal using that port, or use Find blockers in Tantalum IDE.`;
  }

  if (permissionDenied) {
    return `${normalized}\n\nTantalum hint: ${portLabel} could not be opened. Another app may be holding the port, or the board may have reset onto a different COM port. Run Auto scan or Find blockers, then try Upload again.`;
  }

  return normalized;
}

function createArduinoCliError(error, stdout, stderr) {
  const output = joinArduinoCliOutput(stdout, stderr);
  const fallback = error?.message || "Arduino CLI command failed.";
  const message = appendArduinoCliDiagnosticHint(output
    ? /maxBuffer|timed out/i.test(fallback)
      ? `${output}\n\n${fallback}`
      : output
    : fallback);
  const cliError = new Error(message);
  cliError.stdout = stdout;
  cliError.stderr = stderr;
  cliError.code = error?.code;
  return cliError;
}

function isGenericBuildFailure(error) {
  const message = normalizeArduinoCliOutput(error instanceof Error ? error.message : error);
  return /Error during build:\s*exit status \d+/i.test(message);
}

async function enrichGenericBuildFailure(error, verboseArgs, options) {
  if (!isGenericBuildFailure(error)) {
    throw error;
  }

  try {
    await runArduinoCli(verboseArgs, options);
  } catch (verboseError) {
    const detailedMessage = verboseError instanceof Error ? verboseError.message : String(verboseError || "");
    if (detailedMessage && detailedMessage !== error.message) {
      throw new Error(detailedMessage);
    }
  }

  throw error;
}

function withVerboseCompileArgs(args) {
  const compileIndex = args.indexOf("compile");
  if (compileIndex < 0 || args.includes("--verbose")) {
    return args;
  }

  return [...args.slice(0, compileIndex + 1), "--verbose", ...args.slice(compileIndex + 1)];
}

function runArduinoCli(args, options = {}) {
  const cliPath = getCliPath();

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createCanceledError());
      return;
    }

    execFile(cliPath, args, withArduinoCliEnv({ maxBuffer: ARDUINO_CLI_OUTPUT_MAX_BUFFER, ...options }), (error, stdout, stderr) => {
      if (error) {
        if (options.signal?.aborted || isCanceledError(error)) {
          reject(createCanceledError());
          return;
        }
        reject(createArduinoCliError(error, stdout, stderr));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function runArduinoCliStreaming(args, options = {}, onProgress) {
  const cliPath = getCliPath();
  const { timeout = 300000, signal, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCanceledError());
      return;
    }

    const child = spawn(cliPath, args, withArduinoCliEnv(spawnOptions));
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
      callback();
    };

    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => reject(createArduinoCliError(new Error(`Arduino CLI command timed out after ${Math.round(timeout / 1000)} seconds.`), stdout, stderr)));
    }, timeout);

    const abortHandler = () => {
      child.kill("SIGTERM");
      settle(() => reject(createCanceledError()));
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      onProgress?.(chunk, "stdout");
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      onProgress?.(chunk, "stderr");
    });

    child.on("close", (code) => {
      if (code === 0) {
        settle(() => resolve({ stdout, stderr }));
        return;
      }

      settle(() => reject(createArduinoCliError(new Error(`Arduino CLI exited with code ${code}`), stdout, stderr)));
    });

    child.on("error", (error) => {
      settle(() => reject(createArduinoCliError(error, stdout, stderr)));
    });
  });
}

async function withTemporarySketch(code, callback, extraFiles = {}) {
  const sketch = createTemporarySketch(code, extraFiles);
  const { userDir } = await ensureArduinoLibraryDirectory();
  const { configDir, configFile } = createArduinoCliConfig(userDir);

  try {
    return await callback({
      ...sketch,
      userDir,
      configFile,
      env: getArduinoCliEnv({ ARDUINO_DIRECTORIES_USER: userDir })
    });
  } finally {
    cleanupPath(sketch.tmpDir);
    cleanupPath(configDir);
  }
}

async function withTemporaryToolchainSketch({ code, sketchSource = null, extraFiles = {}, cloudRuntime = null }, callback) {
  const workspaceSource = sketchSource?.kind === "workspace" ? normalizeWorkspaceSketchSource(sketchSource) : null;
  if (!workspaceSource) {
    return withTemporarySketch(code, callback, extraFiles);
  }

  const sketch = createTemporaryWorkspaceSketch(workspaceSource, extraFiles, { cloudRuntime });
  const { userDir } = await ensureArduinoLibraryDirectory();
  const { configDir, configFile } = createArduinoCliConfig(userDir);

  try {
    return await callback({
      ...sketch,
      userDir,
      configFile,
      env: getArduinoCliEnv({ ARDUINO_DIRECTORIES_USER: userDir })
    });
  } finally {
    cleanupPath(sketch.tempRoot || sketch.tmpDir);
    cleanupPath(configDir);
  }
}

function cStringLiteral(value) {
  return JSON.stringify(String(value ?? ""));
}

function normalizePemLiteral(value) {
  return String(value ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n");
}

function cPemLiteral(value) {
  return cStringLiteral(normalizePemLiteral(value));
}

function cNumberLiteral(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : String(fallback);
}

function normalizeCloudOtaUpdateMode(value, fallback = "polling") {
  const mode = String(value || "").trim().toLowerCase();
  return TANTALUM_OTA_UPDATE_MODES.has(mode) ? mode : fallback;
}

function cloudRuntimeUsesMqtt(cloudRuntime = {}) {
  const mode = normalizeCloudOtaUpdateMode(cloudRuntime.otaUpdateMode);
  return mode === "mqtt" || mode === "both";
}

function getCloudRuntimeRequiredLibraries(cloudRuntime = {}) {
  return [
    ...TANTALUM_CLOUD_RUNTIME_BASE_LIBRARIES,
    ...(cloudRuntimeUsesMqtt(cloudRuntime) ? TANTALUM_CLOUD_RUNTIME_MQTT_LIBRARIES : [])
  ];
}

function buildTantalumWifiHostname(name, boardId = "") {
  const fallbackSuffix = String(boardId || "board")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8) || "board";
  const fallback = `tantalum-${fallbackSuffix}`;
  const normalized = String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const candidate = normalized || fallback;
  const clipped = candidate
    .slice(0, TANTALUM_WIFI_HOSTNAME_MAX_LENGTH)
    .replace(/-+$/g, "");

  return clipped || fallback.slice(0, TANTALUM_WIFI_HOSTNAME_MAX_LENGTH).replace(/-+$/g, "") || "tantalum-board";
}

function replaceSketchLifecycleFunction(code, name, replacement) {
  const pattern = new RegExp(`\\bvoid\\s+${name}\\s*\\(`);
  if (!pattern.test(code)) {
    return {
      code: `${code}\n\nvoid ${replacement}() {}\n`,
      replaced: false
    };
  }

  return {
    code: code.replace(pattern, `void ${replacement}(`),
    replaced: true
  };
}

function buildCloudRuntimeSketch(code, cloudRuntime = {}) {
  let transformed = String(code || "");
  transformed = replaceSketchLifecycleFunction(transformed, "setup", "tantalumUserSetup").code;
  transformed = replaceSketchLifecycleFunction(transformed, "loop", "tantalumUserLoop").code;

  const serviceName = cloudRuntime.provisioningServiceName || `Tantalum-${String(cloudRuntime.boardId || "board").slice(-8)}`;
  const wifiHostname = buildTantalumWifiHostname(
    cloudRuntime.wifiHostname || cloudRuntime.boardName || cloudRuntime.name,
    cloudRuntime.boardId
  );
  const buildEpoch = Math.max(
    1700000000,
    Number.parseInt(cloudRuntime.buildEpoch || Math.floor(Date.now() / 1000), 10) || 1700000000
  );
  const otaUpdateMode = normalizeCloudOtaUpdateMode(cloudRuntime.otaUpdateMode);
  const mqttEnabled = cloudRuntimeUsesMqtt({ ...cloudRuntime, otaUpdateMode });

  return [
    "/* Generated by Tantalum IDE for cloud-board OTA builds. */",
    `#define TANTALUM_BOARD_ID ${cStringLiteral(cloudRuntime.boardId)}`,
    `#define TANTALUM_API_TOKEN ${cStringLiteral(cloudRuntime.apiToken)}`,
    `#define TANTALUM_APPWRITE_ENDPOINT ${cStringLiteral(cloudRuntime.appwriteEndpoint)}`,
    `#define TANTALUM_APPWRITE_PROJECT_ID ${cStringLiteral(cloudRuntime.appwriteProjectId)}`,
    `#define TANTALUM_DEVICE_GATEWAY_FUNCTION_ID ${cStringLiteral(cloudRuntime.deviceGatewayFunctionId)}`,
    `#define TANTALUM_FIRMWARE_VERSION ${cStringLiteral(cloudRuntime.firmwareVersion || "1.0.0")}`,
    `#define TANTALUM_FIRMWARE_ID ${cStringLiteral(cloudRuntime.firmwareId)}`,
    `#define TANTALUM_RUNTIME_VERSION ${cStringLiteral(TANTALUM_RUNTIME_VERSION)}`,
    `#define TANTALUM_BUILD_EPOCH ${cNumberLiteral(buildEpoch, 1700000000)}`,
    `#define TANTALUM_OTA_UPDATE_MODE ${cStringLiteral(otaUpdateMode)}`,
    `#define TANTALUM_MQTT_REQUIRED ${mqttEnabled ? "1" : "0"}`,
    `#define TANTALUM_MQTT_HOST ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttHost : "")}`,
    `#define TANTALUM_MQTT_PORT ${cNumberLiteral(mqttEnabled ? cloudRuntime.mqttPort : "", 8883)}`,
    `#define TANTALUM_MQTT_USERNAME ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttUsername : "")}`,
    `#define TANTALUM_MQTT_PASSWORD ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttPassword : "")}`,
    `#define TANTALUM_MQTT_TOPIC ${cStringLiteral(mqttEnabled ? cloudRuntime.mqttTopic : "")}`,
    `#define TANTALUM_COMMAND_SECRET ${cStringLiteral(cloudRuntime.commandSecret)}`,
    `#define TANTALUM_TLS_CA_CERT ${cPemLiteral(cloudRuntime.tlsCaCert)}`,
    `#define TANTALUM_MQTT_CA_CERT ${cPemLiteral(mqttEnabled ? cloudRuntime.mqttCaCert : "")}`,
    `#define TANTALUM_PROVISIONING_POP ${cStringLiteral(cloudRuntime.provisioningPop)}`,
    `#define TANTALUM_PROVISIONING_SERVICE_NAME ${cStringLiteral(serviceName)}`,
    `#define TANTALUM_WIFI_HOSTNAME ${cStringLiteral(wifiHostname)}`,
    mqttEnabled ? "#include <PubSubClient.h>" : "",
    `#include "${TANTALUM_RUNTIME_HEADER_NAME}"`,
    "",
    transformed,
    "",
    "void setup() {",
    "  TantalumCloud.begin();",
    "  tantalumUserSetup();",
    "}",
    "",
    "void loop() {",
    "  TantalumCloud.loop();",
    "  tantalumUserLoop();",
    "}"
  ].join("\n");
}

function hasStrictMqttRuntimeConfig(cloudRuntime = {}) {
  return Boolean(
    cloudRuntime &&
    cloudRuntimeUsesMqtt(cloudRuntime) &&
    String(cloudRuntime.mqttHost || "").trim() &&
    String(cloudRuntime.mqttTopic || "").trim() &&
    String(cloudRuntime.mqttCaCert || "").trim()
  );
}

async function ensureCloudRuntimeDependencies(cloudRuntime, onProgress, options = {}) {
  if (!cloudRuntime) {
    return;
  }

  for (const libraryName of getCloudRuntimeRequiredLibraries(cloudRuntime)) {
    if (onProgress) {
      onProgress({
        phase: "Installing dependencies",
        message: `Ensuring ${libraryName} library is installed for Tantalum Cloud OTA...`,
        progress: libraryName === "ArduinoJson" ? 2 : 6
      });
    }
    await installLibrary(libraryName, "latest", onProgress, { signal: options.signal });
  }
}

/**
 * Compile Arduino code using the bundled Arduino CLI
 * @param {string} code - Arduino source code
 * @param {string} board - Fully qualified board name (default: arduino:avr:uno)
 * @returns {Promise<Object>} Compilation result with binary data
 */
async function compileArduino(code, board = "arduino:avr:uno", options = {}) {
  const cloudRuntime = options.cloudRuntime || null;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : undefined;
  await ensureCloudRuntimeDependencies(cloudRuntime, onProgress, { signal: options.signal });
  const sketchSource = options.sketchSource || null;
  const usesWorkspaceSource = sketchSource?.kind === "workspace";
  const inlineCode = sketchSource?.kind === "inline" ? String(sketchSource.code ?? code) : code;
  const sketchCode = cloudRuntime && !usesWorkspaceSource ? buildCloudRuntimeSketch(inlineCode, cloudRuntime) : inlineCode;
  const sourceRestoreMarker = normalizeSourceRestoreMarker(options.sourceRestoreMarker);
  if (options.sourceRestoreMarker && !sourceRestoreMarker) {
    throw new Error("Source restore marker is invalid.");
  }
  const extraFiles = buildGeneratedExtraFiles({
    cloudRuntime,
    sourceRestoreMarker,
  });

  return withTemporaryToolchainSketch({
    code: sketchCode,
    sketchSource,
    extraFiles,
    cloudRuntime,
  }, async ({ tmpDir, outputDir, configFile, env }) => {
    const buildOutputDir = outputDir || tmpDir;
    const compileOptions = { timeout: 300000, env, signal: options.signal };
    const compileArgs = ["--config-file", configFile, "compile", "--fqbn", board, tmpDir, "--output-dir", buildOutputDir];
    let cliResult;

    try {
      cliResult = onProgress
        ? await runArduinoCliStreaming(compileArgs, compileOptions, onProgress)
        : await runArduinoCli(compileArgs, compileOptions);
    } catch (error) {
      await enrichGenericBuildFailure(error, withVerboseCompileArgs(compileArgs), compileOptions);
    }

    const { stdout, stderr } = cliResult;

    const files = fs.readdirSync(buildOutputDir);
    const binFile = files.find(f => f.endsWith(".bin") || f.endsWith(".hex"));

    if (!binFile) {
      throw new Error("No binary file generated.");
    }

    const markerScan = assertSourceRestoreMarkerEmbedded(buildOutputDir, sourceRestoreMarker);
    const binPath = path.join(buildOutputDir, binFile);
    const binData = fs.readFileSync(binPath, "base64");
    const binSize = fs.statSync(binPath).size;

    return {
      success: true,
      message: "Compilation successful!",
      filename: binFile,
      binData,
      binSize,
      board,
      cloudRuntime: Boolean(cloudRuntime),
      sourceRestoreMarkerEmbedded: Boolean(markerScan.requested && markerScan.embedded),
      output: joinArduinoCliOutput(stdout, stderr)
    };
  });
}

async function uploadLocalSketch(code, board, port, onProgress, options = {}) {
  if (!board) {
    throw new Error("A board FQBN is required before uploading.");
  }

  if (!port) {
    throw new Error("A serial port is required before uploading.");
  }

  const cloudRuntime = options.cloudRuntime || null;
  await ensureCloudRuntimeDependencies(cloudRuntime, onProgress, { signal: options.signal });
  const sketchSource = options.sketchSource || null;
  const usesWorkspaceSource = sketchSource?.kind === "workspace";
  const inlineCode = sketchSource?.kind === "inline" ? String(sketchSource.code ?? code) : code;
  const sketchCode = cloudRuntime && !usesWorkspaceSource ? buildCloudRuntimeSketch(inlineCode, cloudRuntime) : inlineCode;
  const sourceRestoreMarker = normalizeSourceRestoreMarker(options.sourceRestoreMarker);
  if (options.sourceRestoreMarker && !sourceRestoreMarker) {
    throw new Error("Source restore marker is invalid.");
  }
  const extraFiles = buildGeneratedExtraFiles({
    cloudRuntime,
    sourceRestoreMarker,
  });

  return withTemporaryToolchainSketch({
    code: sketchCode,
    sketchSource,
    extraFiles,
    cloudRuntime,
  }, async ({ tmpDir, outputDir, configFile, env }) => {
    const buildOutputDir = outputDir || tmpDir;
    const uploadOptions = { timeout: 300000, env, signal: options.signal };
    let cliResult;
    let markerScan = {
      requested: false,
      embedded: false,
    };

    if (sourceRestoreMarker) {
      const compileArgs = ["--config-file", configFile, "compile", "--fqbn", board, tmpDir, "--output-dir", buildOutputDir];
      let compileResult;
      try {
        compileResult = onProgress
          ? await runArduinoCliStreaming(compileArgs, uploadOptions, onProgress)
          : await runArduinoCli(compileArgs, uploadOptions);
      } catch (error) {
        await enrichGenericBuildFailure(error, withVerboseCompileArgs(compileArgs), uploadOptions);
      }

      markerScan = assertSourceRestoreMarkerEmbedded(buildOutputDir, sourceRestoreMarker);
      const uploadArgs = ["--config-file", configFile, "upload", "--fqbn", board, "--port", port, "--input-dir", buildOutputDir, tmpDir];
      let uploadResult;
      try {
        uploadResult = onProgress
          ? await runArduinoCliStreaming(uploadArgs, uploadOptions, onProgress)
          : await runArduinoCli(uploadArgs, uploadOptions);
      } catch (error) {
        throw error;
      }
      cliResult = {
        stdout: [compileResult.stdout, uploadResult.stdout].filter(Boolean).join("\n"),
        stderr: [compileResult.stderr, uploadResult.stderr].filter(Boolean).join("\n"),
      };
    } else {
      const uploadArgs = ["--config-file", configFile, "compile", "--upload", "--fqbn", board, "--port", port, tmpDir, "--output-dir", buildOutputDir];
      try {
        cliResult = onProgress
          ? await runArduinoCliStreaming(uploadArgs, uploadOptions, onProgress)
          : await runArduinoCli(uploadArgs, uploadOptions);
      } catch (error) {
        await enrichGenericBuildFailure(error, withVerboseCompileArgs(uploadArgs), uploadOptions);
      }
    }

    const { stdout, stderr } = cliResult;

    return {
      success: true,
      message: "Upload successful!",
      board,
      port,
      cloudRuntime: Boolean(cloudRuntime),
      sourceRestoreMarkerEmbedded: Boolean(markerScan.requested && markerScan.embedded),
      output: joinArduinoCliOutput(stdout, stderr)
    };
  });
}

/**
 * Install a board package (e.g., ESP32, ESP8266) with automatic retry
 * @param {string} packageUrl - Additional board manager URL
 * @param {string} packageName - Package name (e.g., esp32:esp32)
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Object>} Installation result
 */
async function installBoardPackage(packageUrl, packageName, onProgress, options = {}) {
  const cliPath = getCliPath();
  const MAX_RETRIES = 5;
  const { signal } = options;
  const effectivePackageUrl = packageUrl || getKnownBoardPackageUrl(packageName);

  throwIfCanceled(signal);

  const updateCoreIndex = async (command) => {
    try {
      await runExecCommand(command, {
        timeout: BOARD_INDEX_UPDATE_TIMEOUT_MS,
        signal
      });
    } catch (error) {
      if (isCanceledError(error)) {
        throw error;
      }

      if (onProgress) {
        onProgress(`Core index update warning: ${error.message}\n`);
      }
    }
  };

  // Update index first
  if (effectivePackageUrl) {
    if (onProgress) onProgress("Updating core index...\n");
    await updateCoreIndex(`"${cliPath}" core update-index --additional-urls "${effectivePackageUrl}"`);
  } else {
    if (onProgress) onProgress("Updating core index...\n");
    await updateCoreIndex(`"${cliPath}" core update-index`);
  }

  throwIfCanceled(signal);

  if (onProgress) {
    onProgress("Checking available storage before downloading board core...\n");
  }
  await assertEnoughBoardPackageStorage(packageName, onProgress);

  // Install package with retry logic for network timeouts
  const args = ["core", "install", packageName];
  if (effectivePackageUrl) {
    args.push("--additional-urls", effectivePackageUrl);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    throwIfCanceled(signal);

    if (attempt > 1) {
      if (onProgress) onProgress(`\nRetry attempt ${attempt}/${MAX_RETRIES} (download will resume)...\n`);
    }

    try {
      const result = await runSpawnCommand(args, onProgress, BOARD_PACKAGE_INSTALL_TIMEOUT_MS, { signal });

      // Check if the result contains a timeout error
      if (result.success === false && result.error &&
        (result.error.includes('Client.Timeout') || result.error.includes('context deadline'))) {
        lastError = result.error;
        if (onProgress) onProgress(`\nNetwork timeout on attempt ${attempt}. Retrying...\n`);
        continue; // Retry
      }

      return result; // Success or non-timeout error
    } catch (err) {
      if (isCanceledError(err)) {
        throw err;
      }

      if (err.message && (err.message.includes('Client.Timeout') || err.message.includes('context deadline'))) {
        lastError = err.message;
        if (onProgress) onProgress(`\nNetwork timeout on attempt ${attempt}. Retrying...\n`);
        continue; // Retry
      }
      throw err; // Non-timeout error, don't retry
    }
  }

  // All retries exhausted
  return {
    success: false,
    error: `Failed after ${MAX_RETRIES} attempts. Last error: ${lastError}`
  };
}

/**
 * Remove a board package (core)
 * @param {string} packageName - Package name (e.g., esp32:esp32)
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Object>} Removal result
 */
async function removeBoardPackage(packageName, onProgress) {
  const args = ["core", "uninstall", packageName];
  return runSpawnCommand(args, onProgress);
}

/**
 * List all installed board packages
 * @returns {Promise<Object>} List of installed boards
 */
async function listInstalledBoards() {
  const cliPath = getCliPath();

  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ["board", "listall", "--format", "json"], withArduinoCliEnv({ windowsHide: true }));
    const chunks = [];
    const errorChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      callback();
    };

    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => reject(new Error("Arduino board catalog load timed out.")));
    }, 30000);

    child.stdout.on("data", (data) => {
      stdoutBytes += data.length;
      if (stdoutBytes > ARDUINO_CLI_OUTPUT_MAX_BUFFER) {
        child.kill("SIGTERM");
        settle(() => reject(new Error("Arduino board catalog output is too large to load.")));
        return;
      }

      chunks.push(data);
    });

    child.stderr.on("data", (data) => {
      stderrBytes += data.length;
      if (stderrBytes <= BYTES_PER_MIB) {
        errorChunks.push(data);
      }
    });

    child.on("error", (error) => {
      settle(() => reject(error));
    });

    child.on("close", (code) => {
      settle(() => {
        const stderr = Buffer.concat(errorChunks).toString("utf8").trim();
        if (code !== 0) {
          reject(new Error(stderr || `Arduino board catalog load failed with exit code ${code}.`));
          return;
        }

        const stdout = Buffer.concat(chunks).toString("utf8");
        if (!stdout.trim()) {
          resolve({ success: true, boards: [] });
          return;
        }

        try {
          const boards = JSON.parse(stdout);
          resolve({
            success: true,
            boards: boards.boards || []
          });
        } catch (e) {
          reject(new Error("Failed to parse board list"));
        }
      });
    });
  });
}

/**
 * Upload compiled code to a board via USB
 * @param {string} sketchPath - Path to compiled sketch directory
 * @param {string} port - Serial port
 * @param {string} board - Board FQBN
 * @returns {Promise<Object>} Upload result
 */
async function uploadToBoard(sketchPath, port, board) {
  const cliPath = getCliPath();
  const cmd = `"${cliPath}" upload --fqbn ${board} --port ${port} "${sketchPath}"`;

  return new Promise((resolve, reject) => {
    exec(cmd, withArduinoCliEnv({ timeout: 120000 }), (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
      } else {
        resolve({
          success: true,
          message: "Upload successful!",
          output: stdout
        });
      }
    });
  });
}

/**
 * Get list of connected boards
 * @returns {Promise<Object>} Connected boards info
 */
async function listConnectedBoards() {
  const cliPath = getCliPath();
  const cmd = `"${cliPath}" board list --format json`;

  return new Promise((resolve, reject) => {
    exec(cmd, withArduinoCliEnv({ timeout: 15000 }), (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve({
          success: true,
          ports: result.detected_ports || []
        });
      } catch (e) {
        reject(new Error("Failed to parse connected boards"));
      }
    });
  });
}

// Board package configurations for common boards
const BOARD_PACKAGES = {
  esp32: {
    url: "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json",
    name: "esp32:esp32",
    fqbn: "esp32:esp32:esp32"
  },
  esp8266: {
    url: "http://arduino.esp8266.com/stable/package_esp8266com_index.json",
    name: "esp8266:esp8266",
    fqbn: "esp8266:esp8266:generic"
  },
  arduino_uno: {
    url: null,
    name: "arduino:avr",
    fqbn: "arduino:avr:uno"
  },
  arduino_nano: {
    url: null,
    name: "arduino:avr",
    fqbn: "arduino:avr:nano"
  },
  arduino_mega: {
    url: null,
    name: "arduino:avr",
    fqbn: "arduino:avr:mega"
  }
};

module.exports = {
  compileArduino,
  uploadLocalSketch,
  installBoardPackage,
  listInstalledBoards,
  uploadToBoard,
  listConnectedBoards,
  searchLibraries,
  installLibrary,
  removeLibrary,
  listInstalledLibraries,
  searchBoardPlatforms,
  getCliPath,
  createArduinoCliConfig,
  buildTantalumWifiHostname,
  BOARD_PACKAGES
};

/**
 * Search for libraries in the Arduino Library Manager
 * @param {string} query - Search query
 * @returns {Promise<Object>} Search results
 */
async function searchLibraries(query) {
  const cliPath = getCliPath();
  const cmd = `"${cliPath}" lib search "${query}" --format json`;

  return new Promise((resolve, reject) => {
    // Increase maxBuffer to 50MB to handle large library lists
    exec(cmd, withArduinoCliEnv({ timeout: 60000, maxBuffer: 50 * 1024 * 1024 }), (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(new Error(stderr || error.message));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        // Post-process libraries to extract latest version and description
        const libraries = (result.libraries || []).map((lib) => normalizeLibrarySummary(lib));

        resolve({
          success: true,
          libraries: libraries
        });
      } catch (e) {
        console.error("Library search parse error:", e);
        // console.log("Stdout was:", stdout); // Commenting out to avoid clutter if stdout is huge
        reject(new Error("Failed to parse library search results: " + e.message));
      }
    });
  });
}

/**
 * Get a list of featured/popular libraries
 * @returns {Promise<Object>} List of featured libraries
 */
async function getFeaturedLibraries() {
  try {
    const libraries = [];
    const concurrency = 8;

    for (let index = 0; index < FEATURED_LIBRARY_NAMES.length; index += concurrency) {
      const batch = FEATURED_LIBRARY_NAMES.slice(index, index + concurrency);
      const batchResults = await Promise.all(batch.map(async (libraryName) => {
        try {
          const result = await searchLibraries(libraryName);
          if (!result.success || !Array.isArray(result.libraries)) {
            return null;
          }

          return result.libraries.find((library) => normalizeLibraryKey(library.name) === normalizeLibraryKey(libraryName)) || result.libraries[0] || null;
        } catch {
          return null;
        }
      }));

      for (const library of batchResults) {
        if (library) {
          libraries.push(library);
        }
      }
    }

    return {
      success: true,
      libraries
    };
  } catch (e) {
    console.error('getFeaturedLibraries error:', e);
    return { success: false, error: e.message, libraries: [] };
  }
}

/**
 * Install a library
 * @param {string} name - Library name
 * @param {string} version - Optional version (defaults to latest)
 * @param {function} onProgress - Callback for progress output
 * @returns {Promise<Object>} Installation result
 */
async function installLibrary(name, version, onProgress, options = {}) {
  if (!name) {
    throw new Error("Library name is required.");
  }

  const { signal } = options;
  throwIfCanceled(signal);

  const sketchbook = await ensureArduinoLibraryDirectory();
  throwIfCanceled(signal);

  if (onProgress) {
    onProgress({
      phase: "Resolving",
      message: sketchbook.fallback
        ? `Using fallback Arduino libraries folder: ${sketchbook.librariesDir}`
        : `Using Arduino libraries folder: ${sketchbook.librariesDir}`,
      progress: 2
    });
  }
  return enqueueLibraryInstall(sketchbook.userDir, async () => {
    throwIfCanceled(signal);

    const installedMap = getInstalledLibraryMap(sketchbook.librariesDir);
    const dependenciesInstalled = [];
    const visited = new Set();

    const installResolvedLibrary = async (libraryName, requestedVersion, isDependency = false) => {
      throwIfCanceled(signal);

      const visitKey = `${normalizeLibraryKey(libraryName)}@${requestedVersion || "latest"}`;
      if (visited.has(visitKey)) {
        return null;
      }
      visited.add(visitKey);

      const requestedKey = normalizeLibraryKey(libraryName);
      const preinstalledLibrary = installedMap.get(requestedKey);
      if (preinstalledLibrary && (!requestedVersion || requestedVersion === "latest")) {
        if (isDependency) {
          dependenciesInstalled.push(`${preinstalledLibrary.name}@${preinstalledLibrary.version || "installed"} (already installed)`);
        }
        return preinstalledLibrary;
      }

      if (onProgress) {
        onProgress({
          phase: isDependency ? "Installing dependencies" : "Resolving",
          message: isDependency ? `Resolving dependency ${libraryName}...` : `Resolving ${libraryName}...`,
          progress: isDependency ? 8 : 4
        });
      }

      const { library, release, version: releaseVersion } = await resolveLibraryRelease(libraryName, requestedVersion, { signal });
      throwIfCanceled(signal);

      const libraryKey = normalizeLibraryKey(library.name);
      const existingLibrary = installedMap.get(libraryKey);
      if (existingLibrary && (isDependency || !requestedVersion || requestedVersion === "latest" || existingLibrary.version === releaseVersion)) {
        if (isDependency) {
          dependenciesInstalled.push(`${existingLibrary.name}@${existingLibrary.version || "installed"} (already installed)`);
        }
        return existingLibrary;
      }

      if (onProgress) {
        onProgress({
          phase: "Checking storage",
          message: `Checking available storage for ${library.name}@${releaseVersion}...`,
          progress: isDependency ? 10 : 6
        });
      }

      const requiredBytes = estimateLibraryInstallSpaceBytes(release.resources?.size);
      const storageCheck = assertEnoughStorage({
        label: `${library.name}@${releaseVersion}`,
        targetDir: sketchbook.librariesDir,
        requiredBytes
      });

      if (storageCheck && onProgress) {
        onProgress({
          phase: "Checking storage",
          message: `Storage check passed: ${formatStorageBytes(storageCheck.availableBytes)} available; ${formatStorageBytes(storageCheck.requiredBytes)} estimated required.`,
          progress: isDependency ? 11 : 7
        });
      }

      const dependencies = Array.isArray(release.dependencies) ? release.dependencies : [];
      for (const dependency of dependencies) {
        const dependencyName = typeof dependency === "string" ? dependency : dependency?.name;
        if (!dependencyName) {
          continue;
        }

        const dependencyKey = normalizeLibraryKey(dependencyName);
        if (installedMap.has(dependencyKey)) {
          dependenciesInstalled.push(`${dependencyName} (already installed)`);
          continue;
        }

        throwIfCanceled(signal);

        if (onProgress) {
          onProgress({
            phase: "Installing dependencies",
            message: `Installing dependency ${dependencyName} for ${library.name}...`,
            progress: 12
          });
        }
        await installResolvedLibrary(dependencyName, undefined, true);
        throwIfCanceled(signal);
      }

      const operationDir = fs.mkdtempSync(path.join(sketchbook.librariesDir, ".tantalum-install-"));
      const archiveName = release.resources.archive_filename || `${sanitizeArduinoLibraryFolderName(library.name)}-${releaseVersion}.zip`;
      const archivePath = path.join(operationDir, archiveName);
      const extractDir = path.join(operationDir, "extract");
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        if (onProgress) {
          onProgress({
            phase: "Downloading",
            message: `Downloading ${library.name}@${releaseVersion}...`,
            progress: 18
          });
        }

        await downloadFile(release.resources.url, archivePath, release.resources.size, (downloadProgress) => {
          if (onProgress) {
            onProgress({
              phase: "Downloading",
              message: `Downloading ${library.name}@${releaseVersion}...`,
              progress: 18 + downloadProgress * 0.42
            });
          }
        }, { signal });

        throwIfCanceled(signal);

        if (onProgress) {
          onProgress({
            phase: "Verifying",
            message: `Verifying ${library.name}@${releaseVersion}...`,
            progress: 64
          });
        }

        if (!checksumMatches(release.resources.checksum, archivePath)) {
          throw new Error(`Checksum verification failed for ${library.name}@${releaseVersion}.`);
        }

        throwIfCanceled(signal);

        if (onProgress) {
          onProgress({
            phase: "Extracting",
            message: `Extracting ${library.name}@${releaseVersion}...`,
            progress: 70
          });
        }

        await extractZip(archivePath, extractDir, (extractProgress) => {
          if (onProgress) {
            onProgress({
              phase: "Extracting",
              message: `Extracting ${library.name}@${releaseVersion}...`,
              progress: 70 + extractProgress * 0.18
            });
          }
        }, { signal });

        throwIfCanceled(signal);

        if (onProgress) {
          onProgress({
            phase: "Installing",
            message: `Installing ${library.name}@${releaseVersion}...`,
            progress: 92
          });
        }

        throwIfCanceled(signal);

        const installedLibrary = installExtractedLibrary({
          extractDir,
          librariesDir: sketchbook.librariesDir,
          releaseMetadata: {
            ...release,
            version: releaseVersion,
            website: normalizeLibraryWebsite(library, release, releaseVersion)
          },
          installedMap
        });

        if (isDependency) {
          dependenciesInstalled.push(`${installedLibrary.name}@${installedLibrary.version || releaseVersion}`);
        }

        return installedLibrary;
      } finally {
        safeRemovePath(operationDir);
      }
    };

    const installedLibrary = await installResolvedLibrary(name, version, false);
    throwIfCanceled(signal);

    if (onProgress) {
      onProgress({
        phase: "Installed",
        message: `${installedLibrary.name}@${installedLibrary.version || version || "latest"} installed.`,
        progress: 100
      });
    }

    return {
      success: true,
      output: `${installedLibrary.name}@${installedLibrary.version || version || "latest"} installed in ${installedLibrary.installDir}`,
      installedPath: installedLibrary.installDir,
      installedVersion: installedLibrary.version,
      dependenciesInstalled
    };
  });
}

/**
 * List installed libraries
 * @returns {Promise<Object>} List of installed libraries
 */
async function listInstalledLibraries() {
  const { librariesDir } = await ensureArduinoLibraryDirectory();
  return {
    success: true,
    libraries: scanInstalledLibrariesSync(librariesDir)
  };
}

/**
 * Remove one installed library folder.
 * @param {string} name - Library name
 * @returns {Promise<Object>} Removal result
 */
async function removeLibrary(name) {
  if (!name) {
    throw new Error("Library name is required.");
  }

  const { librariesDir } = await ensureArduinoLibraryDirectory();
  const installedMap = getInstalledLibraryMap(librariesDir);
  const library = installedMap.get(normalizeLibraryKey(name));
  if (!library) {
    throw new Error(`Library '${name}' is not installed.`);
  }

  const librariesRoot = path.resolve(librariesDir);
  const targetDir = path.resolve(library.installDir);

  if (targetDir === librariesRoot || !isPathInsideRoot(targetDir, librariesRoot)) {
    throw new Error(`Refusing to remove library outside Arduino libraries folder: ${targetDir}`);
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new Error(`Installed library folder was not found: ${targetDir}`);
  }

  const realLibrariesRoot = fs.realpathSync(librariesRoot);
  const realTargetDir = fs.realpathSync(targetDir);
  if (realTargetDir === realLibrariesRoot || !isPathInsideRoot(realTargetDir, realLibrariesRoot)) {
    throw new Error(`Refusing to remove library outside Arduino libraries folder: ${targetDir}`);
  }

  safeRemovePath(targetDir);

  return {
    success: true,
    output: `${library.name} removed from ${targetDir}`,
    removedPath: targetDir
  };
}

/**
 * Search for board platforms (cores)
 * @param {string} query - Search query
 * @returns {Promise<Object>} Search results
 */
async function searchBoardPlatforms(query) {
  const cliPath = getCliPath();
  const cmd = `"${cliPath}" core search "${query}" --format json`;

  return new Promise((resolve, reject) => {
    exec(cmd, withArduinoCliEnv({ timeout: 30000 }), (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(new Error(stderr || error.message));
        return;
      }

      try {
        const result = JSON.parse(stdout);

        let rawPlatforms = [];
        if (Array.isArray(result)) {
          rawPlatforms = result;
        } else if (result && Array.isArray(result.platforms)) {
          rawPlatforms = result.platforms;
        } else if (result && typeof result === 'object') {
          // Try values if it's a map
          rawPlatforms = Object.values(result).filter(p => p.id); // heuristics
        }

        // Post process platforms
        const platforms = rawPlatforms.map(p => {
          // Extract all versions from releases
          let versions = [];
          if (p.releases) {
            versions = Object.keys(p.releases).sort((a, b) => {
              // Sort descending (newest first)
              return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
            });
          } else if (p.latest) {
            versions = [p.latest];
          }

          const latestVer = p.latest || versions[0];
          let releaseObj = null;
          if (p.releases && latestVer) {
            releaseObj = p.releases[latestVer];
          }

          // Get human readable name from release object, fallback to id
          const prettyName = releaseObj ? releaseObj.name : (p.name || p.id);

          // Generate description from boards list
          let description = '';
          if (releaseObj && releaseObj.boards) {
            const boardNames = releaseObj.boards.map(b => b.name).join(', ');
            description = `Boards included in this package: ${boardNames}`;
          }

          return {
            id: p.id,
            name: prettyName,
            latest: latestVer || 'Unknown',
            versions: versions,
            website: p.website || '',
            maintainer: p.maintainer || 'Unknown',
            description: description,
            installed: false
          };
        });

        resolve({
          success: true,
          platforms: platforms
        });
      } catch (e) {
        console.error('Search parsing error:', e);
        reject(new Error("Failed to parse board search results: " + e.message));
      }
    });
  });
}

/**
 * List installed board platforms (cores)
 * @returns {Promise<Object>} List of installed platforms
 */
async function listInstalledPlatforms() {
  const cliPath = getCliPath();
  const cmd = `"${cliPath}" core list --format json`;

  return new Promise((resolve, reject) => {
    exec(cmd, withArduinoCliEnv({ timeout: 30000 }), (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(new Error(stderr || error.message));
        return;
      }

      try {
        const result = JSON.parse(stdout);

        let platforms = [];
        if (Array.isArray(result)) {
          platforms = result.map(p => ({
            id: p.id,
            name: p.name || p.id,
            version: p.installed_version || p.installed,
            latest: p.latest_version || p.latest
          }));
        } else if (result && typeof result === 'object') {
          // Handle case where it might be wrapped or an object map
          // Some CLI versions might return { "arduino:avr": { ... } } or { "platforms": [...] }
          const list = result.platforms || Object.values(result);
          if (Array.isArray(list)) {
            platforms = list.map(p => ({
              id: p.id,
              name: p.name || p.id,
              version: p.installed_version || p.installed,
              latest: p.latest_version || p.latest
            }));
          }
        }

        resolve({
          success: true,
          platforms: platforms
        });
      } catch (e) {
        console.error('Error parsing installed platforms:', e);
        // If no cores installed, it might return empty array or null
        resolve({ success: true, platforms: [] });
      }
    });
  });
}

module.exports = {
  compileArduino,
  uploadLocalSketch,
  installBoardPackage,
  listInstalledBoards,
  uploadToBoard,
  listConnectedBoards,
  searchLibraries,
  installLibrary,
  removeLibrary,
  getArduinoLibraryDirectory,
  migrateLibrariesFrom,
  listInstalledLibraries,
  searchBoardPlatforms,
  listInstalledPlatforms,
  removeBoardPackage,
  getCliPath,
  getArduinoCliEnv,
  createArduinoCliConfig,
  configureArduinoStorageRoot,
  getArduinoStorageInfo,
  buildTantalumWifiHostname,
  BOARD_PACKAGES,
  getFeaturedLibraries,
  __testing: {
    assertSourceRestoreMarkerEmbedded,
    buildSourceRestoreMarkerFile,
    buildCloudRuntimePrefix,
    buildCloudRuntimeSketch,
    getCloudRuntimeRequiredLibraries,
    hasStrictMqttRuntimeConfig,
    normalizePemLiteral,
    collectWorkspaceSketchFiles,
    createTemporaryWorkspaceSketch,
    applyCloudRuntimeToWorkspaceSketchFiles,
    scanCompiledArtifactsForSourceRestoreMarker,
    sourceRestoreMarkerLiteral
  }
};

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");

const { getArduinoCliEnv, getCliPath } = require("../../arduinoHandler");

const HIGH_CONFIDENCE = 0.9;
const MEDIUM_CONFIDENCE = 0.55;
const LOW_CONFIDENCE = 0.25;
const ESPTOOL_PROBE_TIMEOUT_MS = 25000;
const ESPTOOL_PROBE_RETRY_DELAY_MS = 750;
const ESPTOOL_PROBE_ATTEMPTS = 2;
const ESP_CHIP_TARGETS = {
  "ESP32-C2": { fqbn: "esp32:esp32:esp32c2", label: "ESP32-C2 Dev Module" },
  "ESP32-C3": { fqbn: "esp32:esp32:esp32c3", label: "ESP32-C3 Dev Module" },
  "ESP32-C5": { fqbn: "esp32:esp32:esp32c5", label: "ESP32-C5 Dev Module" },
  "ESP32-C6": { fqbn: "esp32:esp32:esp32c6", label: "ESP32-C6 Dev Module" },
  "ESP32-H2": { fqbn: "esp32:esp32:esp32h2", label: "ESP32-H2 Dev Module" },
  "ESP32-P4": { fqbn: "esp32:esp32:esp32p4", label: "ESP32-P4 Dev Module" },
  "ESP32-S2": { fqbn: "esp32:esp32:esp32s2", label: "ESP32-S2 Dev Module" },
  "ESP32-S3": { fqbn: "esp32:esp32:esp32s3", label: "ESP32-S3 Dev Module" },
  ESP32: { fqbn: "esp32:esp32:esp32", label: "ESP32 Dev Module" },
};

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeId(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeUsbId(value) {
  return normalizeString(value).replace(/^0x/i, "").toUpperCase();
}

function safeArduinoCliEnv() {
  return typeof getArduinoCliEnv === "function" ? getArduinoCliEnv() : process.env;
}

function runCliJson(args) {
  return new Promise((resolve, reject) => {
    execFile(getCliPath(), args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, env: safeArduinoCliEnv(), windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (parseError) {
        reject(new Error(parseError instanceof Error ? parseError.message : "Unable to parse Arduino CLI JSON."));
      }
    });
  });
}

async function readArduinoBoardList() {
  try {
    return await runCliJson(["board", "list", "--format", "json"]);
  } catch (formatError) {
    try {
      return await runCliJson(["board", "list", "--json"]);
    } catch {
      throw formatError;
    }
  }
}

async function listSerialPorts() {
  try {
    const { SerialPort } = require("serialport");
    return await SerialPort.list();
  } catch {
    return [];
  }
}

function getPortPath(port) {
  if (!port || typeof port !== "object") {
    return "";
  }

  return normalizeString(port.address || port.path || port.port || port.name || port.label);
}

function darwinCalloutPortPath(portPath) {
  const normalized = normalizeString(portPath);
  if (process.platform !== "darwin" || !normalized.startsWith("/dev/tty.")) {
    return normalized;
  }

  const calloutPath = `/dev/cu.${normalized.slice("/dev/tty.".length)}`;
  return fs.existsSync(calloutPath) ? calloutPath : normalized;
}

function physicalPortPathKey(portPath) {
  const normalized = normalizeString(portPath).toLowerCase();
  if (process.platform === "darwin") {
    return normalized.replace(/^\/dev\/(?:cu|tty)\./, "/dev/serial.");
  }

  return normalized;
}

function portLookupKeys(portPath) {
  const keys = new Set();
  const rawPath = normalizeString(portPath);
  const uploadPath = darwinCalloutPortPath(rawPath);

  for (const key of [rawPath, uploadPath, physicalPortPathKey(rawPath), physicalPortPathKey(uploadPath)]) {
    const normalized = normalizeId(key);
    if (normalized) {
      keys.add(normalized);
    }
  }

  return Array.from(keys);
}

function normalizeSerialPort(port) {
  const properties = port?.properties && typeof port.properties === "object" ? port.properties : {};
  const rawPath = getPortPath(port);
  const path = darwinCalloutPortPath(rawPath);
  const rawLabel = normalizeString(port.label || port.friendlyName || rawPath || path);
  const label = rawLabel && rawLabel !== rawPath ? rawLabel : path;
  return {
    path,
    label,
    protocol: normalizeString(port.protocol || "serial") || "serial",
    protocolLabel: normalizeString(port.protocol_label || port.protocolLabel || "Serial"),
    manufacturer: normalizeString(port.manufacturer || port.friendlyName),
    vendorId: normalizeUsbId(port.vendorId || port.vid || properties.vid),
    productId: normalizeUsbId(port.productId || port.pid || properties.pid),
    serialNumber: normalizeString(port.serialNumber || port.serial_number || properties.serialNumber || properties.serial_number),
    pnpId: normalizeString(port.pnpId || port.pnpID),
    locationId: normalizeString(port.locationId),
  };
}

function buildSerialPortMap(serialPorts) {
  const serialPortMap = new Map();

  for (const serialPort of serialPorts) {
    const normalized = normalizeSerialPort(serialPort);
    for (const key of [...portLookupKeys(getPortPath(serialPort)), ...portLookupKeys(normalized.path)]) {
      if (!serialPortMap.has(key)) {
        serialPortMap.set(key, normalized);
      }
    }
  }

  return serialPortMap;
}

function findSerialPortMetadata(serialPortMap, portPath) {
  for (const key of portLookupKeys(portPath)) {
    const metadata = serialPortMap.get(key);
    if (metadata) {
      return metadata;
    }
  }

  return {};
}

function normalizeMatchingBoard(board) {
  if (!board || typeof board !== "object") {
    return null;
  }

  const fqbn = normalizeString(board.fqbn || board.FQBN);
  const name = normalizeString(board.name || board.label || fqbn);
  if (!fqbn && !name) {
    return null;
  }

  return {
    name,
    fqbn,
    isHidden: Boolean(board.is_hidden || board.isHidden || board.hidden),
  };
}

function isEsp32FamilyBoard(board) {
  const fqbn = normalizeId(board?.fqbn);
  return fqbn === "esp32:esp32:esp32_family" || fqbn.endsWith(":esp32_family");
}

function isConcreteUploadBoard(board) {
  return Boolean(board?.fqbn && !board.isHidden && !isEsp32FamilyBoard(board));
}

function hasEspressifFamilyMatch(matches) {
  return matches.some((board) => isEsp32FamilyBoard(board) || normalizeId(board?.name).includes("esp32 family"));
}

function getDetectedPorts(cliPayload) {
  if (Array.isArray(cliPayload?.detected_ports)) {
    return cliPayload.detected_ports;
  }

  if (Array.isArray(cliPayload?.ports)) {
    return cliPayload.ports;
  }

  if (Array.isArray(cliPayload)) {
    return cliPayload;
  }

  return [];
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

function uniqueExistingDirectories(paths) {
  const seen = new Set();
  return paths
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key) || !fs.existsSync(entry)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

function compareVersionNamesDescending(left, right) {
  const leftParts = String(left || "").split(/[^\d]+/).filter(Boolean).map(Number);
  const rightParts = String(right || "").split(/[^\d]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return String(right || "").localeCompare(String(left || ""));
}

function getArduinoDataDirCandidates() {
  const cliEnv = safeArduinoCliEnv();
  return uniqueExistingDirectories([
    cliEnv.ARDUINO_DIRECTORIES_DATA,
    process.env.ARDUINO_DIRECTORIES_DATA,
    getFallbackArduinoDataDir(),
  ]);
}

function findEspToolExecutable() {
  const binaryName = process.platform === "win32" ? "esptool.exe" : "esptool";
  for (const dataDir of getArduinoDataDirCandidates()) {
    const esptoolRoot = path.join(dataDir, "packages", "esp32", "tools", "esptool_py");
    if (!fs.existsSync(esptoolRoot)) {
      continue;
    }

    const versionDirs = fs.readdirSync(esptoolRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionNamesDescending);

    for (const versionDir of versionDirs) {
      const candidate = path.join(esptoolRoot, versionDir, binaryName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

function parseEspChipTarget(output) {
  const normalized = normalizeString(output).toUpperCase().replace(/\s+/g, " ");
  for (const chipName of Object.keys(ESP_CHIP_TARGETS)) {
    const pattern = chipName.replace("-", "[- ]?");
    if (new RegExp(`\\b${pattern}\\b`).test(normalized)) {
      return {
        chipName,
        ...ESP_CHIP_TARGETS[chipName],
      };
    }
  }

  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldProbeEspChip(candidate) {
  if (!candidate?.port) {
    return false;
  }

  if (candidate.fqbn && Number(candidate.confidence || 0) >= HIGH_CONFIDENCE) {
    return false;
  }

  const text = [
    candidate.boardLabel,
    candidate.manufacturer,
    candidate.vendorId,
    candidate.productId,
    candidate.pnpId,
    candidate.label,
    ...(candidate.matchingBoards || []).flatMap((board) => [board.name, board.fqbn]),
  ]
    .join(" ")
    .toLowerCase();

  return (
    hasEspressifFamilyMatch(candidate.matchingBoards || []) ||
    text.includes("espressif") ||
    text.includes("esp32") ||
    text.includes("303a") ||
    (!candidate.fqbn &&
      (text.includes("wch") ||
        text.includes("ch340") ||
        text.includes("ch341") ||
        text.includes("silicon") ||
        text.includes("cp210") ||
        text.includes("ftdi")))
  );
}

function runEspToolProbeOnce(port) {
  const esptoolPath = findEspToolExecutable();
  if (!esptoolPath) {
    return Promise.resolve({ chipTarget: null, timedOut: false });
  }

  return new Promise((resolve) => {
    execFile(
      esptoolPath,
      ["--port", port, "--baud", "115200", "chip_id"],
      { timeout: ESPTOOL_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: safeArduinoCliEnv(), windowsHide: true },
      (error, stdout, stderr) => {
        const output = `${stdout || ""}\n${stderr || ""}`;
        const chipTarget = parseEspChipTarget(output);
        if (error || !chipTarget) {
          const message = String(error?.message || "");
          resolve({ chipTarget: null, timedOut: Boolean(error?.killed || error?.signal || /timed out/i.test(message)) });
          return;
        }

        resolve({
          chipTarget: {
            ...chipTarget,
            output,
          },
          timedOut: false,
        });
      },
    );
  });
}

async function runEspToolProbe(port) {
  for (let attempt = 0; attempt < ESPTOOL_PROBE_ATTEMPTS; attempt += 1) {
    const result = await runEspToolProbeOnce(port);
    if (result.chipTarget || result.timedOut || attempt === ESPTOOL_PROBE_ATTEMPTS - 1) {
      return result.chipTarget;
    }

    await delay(ESPTOOL_PROBE_RETRY_DELAY_MS);
  }

  return null;
}

async function applyEspChipProbe(candidate) {
  if (!shouldProbeEspChip(candidate)) {
    return candidate;
  }

  const chipTarget = await runEspToolProbe(candidate.port);
  if (!chipTarget) {
    return candidate;
  }

  const matchingBoards = candidate.matchingBoards || [];
  const hasTargetMatch = matchingBoards.some((board) => normalizeId(board.fqbn) === normalizeId(chipTarget.fqbn));
  return {
    ...candidate,
    fqbn: chipTarget.fqbn,
    boardLabel: chipTarget.label,
    confidence: 0.98,
    confidenceLabel: "high",
    detectionSource: "esptool-chip-probe",
    matchingBoards: hasTargetMatch
      ? matchingBoards
      : [
          ...matchingBoards,
          {
            name: chipTarget.label,
            fqbn: chipTarget.fqbn,
            isHidden: false,
          },
        ],
    ai: null,
  };
}

function candidateHardwareKey(port) {
  const serialNumber = normalizeId(port?.serialNumber);
  const vendorId = normalizeId(port?.vendorId);
  if (serialNumber) {
    return ["usb-serial", vendorId, serialNumber].filter(Boolean).join(":");
  }

  const pnpId = normalizeId(port?.pnpId);
  if (pnpId) {
    return `pnp:${pnpId}`;
  }

  const locationId = normalizeId(port?.locationId);
  if (locationId) {
    return ["usb-location", vendorId, normalizeId(port?.productId), locationId].filter(Boolean).join(":");
  }

  return physicalPortPathKey(port?.path || port?.port);
}

function candidateFingerprint(port) {
  const stable = candidateHardwareKey(port);
  return crypto.createHash("sha256").update(stable || port.path || crypto.randomUUID()).digest("hex");
}

function inferUsbSerialHint(port) {
  const text = [port.manufacturer, port.pnpId, port.label, port.path, port.vendorId, port.productId].join(" ").toLowerCase();
  if (text.includes("303a") || text.includes("espressif")) {
    return "Espressif USB serial device";
  }
  if (text.includes("arduino")) {
    return "Arduino-compatible USB device";
  }
  if (text.includes("wch") || text.includes("ch340") || text.includes("ch341")) {
    return "CH340/CH341 USB serial adapter";
  }
  if (text.includes("silicon") || text.includes("cp210")) {
    return "CP210x USB serial adapter";
  }
  if (text.includes("ftdi")) {
    return "FTDI USB serial adapter";
  }
  if (text.includes("usb")) {
    return "USB serial device";
  }
  return "Serial device";
}

function confidenceFor(matches) {
  if (matches.length === 1 && isConcreteUploadBoard(matches[0])) {
    return HIGH_CONFIDENCE;
  }

  if (matches.length > 1) {
    return MEDIUM_CONFIDENCE;
  }

  return LOW_CONFIDENCE;
}

function buildCandidate(rawDetectedPort, serialPortMap) {
  const cliPort = normalizeSerialPort(rawDetectedPort?.port || rawDetectedPort);
  const path = cliPort.path;
  const serialPort = findSerialPortMetadata(serialPortMap, path);
  const mergedPort = {
    ...cliPort,
    manufacturer: normalizeString(cliPort.manufacturer || serialPort.manufacturer),
    vendorId: normalizeString(cliPort.vendorId || serialPort.vendorId),
    productId: normalizeString(cliPort.productId || serialPort.productId),
    serialNumber: normalizeString(cliPort.serialNumber || serialPort.serialNumber),
    pnpId: normalizeString(cliPort.pnpId || serialPort.pnpId),
    locationId: normalizeString(cliPort.locationId || serialPort.locationId),
  };
  const matchingBoards = (rawDetectedPort?.matching_boards || rawDetectedPort?.matchingBoards || rawDetectedPort?.boards || [])
    .map(normalizeMatchingBoard)
    .filter(Boolean);
  const concreteMatches = matchingBoards.filter(isConcreteUploadBoard);
  const selectedBoard = matchingBoards.length === 1 && concreteMatches.length === 1 ? concreteMatches[0] : null;
  const confidence = confidenceFor(matchingBoards);
  const fingerprint = candidateFingerprint(mergedPort);
  const detectedLabel = selectedBoard?.name || (hasEspressifFamilyMatch(matchingBoards) ? "Espressif USB serial device" : matchingBoards[0]?.name);

  return {
    id: `detected:${fingerprint}`,
    fingerprint,
    path,
    port: path,
    label: mergedPort.label || path,
    protocol: mergedPort.protocol,
    protocolLabel: mergedPort.protocolLabel,
    manufacturer: mergedPort.manufacturer || "Unknown",
    vendorId: mergedPort.vendorId || null,
    productId: mergedPort.productId || null,
    serialNumber: mergedPort.serialNumber || null,
    pnpId: mergedPort.pnpId || null,
    locationId: mergedPort.locationId || null,
    boardLabel: detectedLabel || inferUsbSerialHint(mergedPort),
    fqbn: selectedBoard?.fqbn || "",
    matchingBoards,
    confidence,
    confidenceLabel: confidence >= HIGH_CONFIDENCE ? "high" : confidence >= MEDIUM_CONFIDENCE ? "medium" : "low",
    detectionSource: selectedBoard ? "arduino-cli" : matchingBoards.length > 1 ? "arduino-cli-candidates" : "serialport",
    connected: true,
    ai: null,
  };
}

function isKnownText(value) {
  const normalized = normalizeString(value);
  return Boolean(normalized && normalized.toLowerCase() !== "unknown");
}

function preferKnownText(primary, fallback) {
  return isKnownText(primary) ? normalizeString(primary) : normalizeString(fallback || primary);
}

function sourceRank(source) {
  switch (source) {
    case "esptool-chip-probe":
      return 5;
    case "board-detection-ai":
      return 4;
    case "arduino-cli":
      return 3;
    case "arduino-cli-candidates":
      return 2;
    case "serialport":
      return 1;
    default:
      return 0;
  }
}

function boardCandidateScore(candidate) {
  return (
    Number(candidate?.confidence || 0) * 100 +
    (candidate?.fqbn ? 100 : 0) +
    sourceRank(candidate?.detectionSource) * 10 +
    (candidate?.matchingBoards?.length || 0)
  );
}

function portCandidateScore(candidate) {
  const path = normalizeString(candidate?.path || candidate?.port).toLowerCase();
  return (
    (process.platform === "darwin" && path.startsWith("/dev/cu.") ? 100 : 0) +
    (normalizeString(candidate?.protocolLabel).toLowerCase().includes("usb") ? 20 : 0) +
    (isKnownText(candidate?.manufacturer) ? 10 : 0) +
    (candidate?.serialNumber ? 8 : 0) +
    (candidate?.vendorId ? 4 : 0) +
    (candidate?.productId ? 4 : 0) +
    (candidate?.locationId ? 2 : 0)
  );
}

function mergeMatchingBoards(leftBoards = [], rightBoards = []) {
  const byKey = new Map();
  for (const board of [...leftBoards, ...rightBoards]) {
    const normalized = normalizeMatchingBoard(board);
    if (!normalized) {
      continue;
    }

    const key = normalizeId(normalized.fqbn || normalized.name);
    if (!byKey.has(key)) {
      byKey.set(key, normalized);
    }
  }

  return Array.from(byKey.values());
}

function mergeBoardCandidates(left, right) {
  const boardPrimary = boardCandidateScore(right) > boardCandidateScore(left) ? right : left;
  const boardSecondary = boardPrimary === left ? right : left;
  const portPrimary = portCandidateScore(right) > portCandidateScore(left) ? right : left;
  const portSecondary = portPrimary === left ? right : left;
  const matchingBoards = mergeMatchingBoards(left.matchingBoards, right.matchingBoards);
  const confidence = Math.max(Number(left.confidence || 0), Number(right.confidence || 0));
  const merged = {
    ...boardPrimary,
    path: portPrimary.path || boardPrimary.path,
    port: portPrimary.port || portPrimary.path || boardPrimary.port,
    label: portPrimary.label || portPrimary.path || boardPrimary.label,
    protocol: portPrimary.protocol || portSecondary.protocol || "serial",
    protocolLabel: portPrimary.protocolLabel || portSecondary.protocolLabel || "Serial",
    manufacturer: preferKnownText(left.manufacturer, right.manufacturer) || "Unknown",
    vendorId: left.vendorId || right.vendorId || null,
    productId: left.productId || right.productId || null,
    serialNumber: left.serialNumber || right.serialNumber || null,
    pnpId: left.pnpId || right.pnpId || null,
    locationId: left.locationId || right.locationId || null,
    boardLabel: boardPrimary.boardLabel || boardSecondary.boardLabel,
    fqbn: boardPrimary.fqbn || boardSecondary.fqbn || "",
    matchingBoards,
    confidence,
    confidenceLabel: confidence >= HIGH_CONFIDENCE ? "high" : confidence >= MEDIUM_CONFIDENCE ? "medium" : "low",
    detectionSource: boardPrimary.detectionSource || boardSecondary.detectionSource,
    connected: true,
    ai: boardPrimary.ai || boardSecondary.ai || null,
  };
  merged.fingerprint = candidateFingerprint(merged);
  merged.id = `detected:${merged.fingerprint}`;
  return merged;
}

function rememberCandidate(candidateMap, candidate) {
  if (!candidate.path || !isLikelyBoardPort(candidate)) {
    return;
  }

  const key = candidateHardwareKey(candidate) || normalizeId(candidate.path);
  const existing = candidateMap.get(key);
  candidateMap.set(key, existing ? mergeBoardCandidates(existing, candidate) : candidate);
}

function isLikelyBoardPort(candidate) {
  if (!candidate) {
    return false;
  }

  if ((candidate.matchingBoards?.length || 0) > 0 || candidate.vendorId || candidate.productId) {
    return true;
  }

  const text = [
    candidate.manufacturer,
    candidate.label,
    candidate.path,
    candidate.pnpId,
    candidate.protocolLabel,
    candidate.vendorId,
    candidate.productId,
  ]
    .join(" ")
    .toLowerCase();

  return (
    text.includes("usb") ||
    text.includes("arduino") ||
    text.includes("wch") ||
    text.includes("ch340") ||
    text.includes("ch341") ||
    text.includes("cp210") ||
    text.includes("silicon") ||
    text.includes("ftdi") ||
    text.includes("303a") ||
    text.includes("ttyacm") ||
    text.includes("ttyusb") ||
    text.includes("cu.usb")
  );
}

function toDetectedPort(candidate) {
  return {
    path: candidate.path,
    label: candidate.label || candidate.path,
    protocol: candidate.protocol || "serial",
    protocolLabel: candidate.protocolLabel || "Serial",
    manufacturer: candidate.manufacturer || "Unknown",
    vendorId: candidate.vendorId || null,
    productId: candidate.productId || null,
    serialNumber: candidate.serialNumber || null,
    pnpId: candidate.pnpId || null,
    locationId: candidate.locationId || null,
    likelyBoard: isLikelyBoardPort(candidate),
  };
}

function comparePortPaths(left, right) {
  if (left.likelyBoard !== right.likelyBoard) {
    return left.likelyBoard ? -1 : 1;
  }

  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
}

async function detectLocalBoardsDeterministic(options = {}) {
  if (options.portsOnly) {
    const serialPorts = await listSerialPorts();
    const candidates = [];
    const ports = [];
    const seen = new Set();

    for (const serialPort of serialPorts) {
      const normalized = normalizeSerialPort(serialPort);
      if (!normalized.path || seen.has(normalizeId(normalized.path))) {
        continue;
      }

      seen.add(normalizeId(normalized.path));
      const candidate = buildCandidate({ port: normalized, matching_boards: [] }, new Map());
      ports.push(toDetectedPort(candidate));
      if (isLikelyBoardPort(candidate)) {
        candidates.push(candidate);
      }
    }

    return {
      success: true,
      boards: candidates,
      ports: ports.sort(comparePortPaths),
      detectedAt: new Date().toISOString(),
    };
  }

  const [cliPayload, serialPorts] = await Promise.all([
    readArduinoBoardList().catch(() => ({ detected_ports: [] })),
    listSerialPorts(),
  ]);
  const serialPortMap = buildSerialPortMap(serialPorts);
  const seenPorts = new Set();
  const candidateMap = new Map();
  const ports = [];

  function rememberPort(candidate) {
    const key = normalizeId(candidate?.path);
    if (!key || seenPorts.has(key)) {
      return;
    }

    seenPorts.add(key);
    ports.push(toDetectedPort(candidate));
  }

  for (const detectedPort of getDetectedPorts(cliPayload)) {
    const candidate = buildCandidate(detectedPort, serialPortMap);
    rememberPort(candidate);
    rememberCandidate(candidateMap, candidate);
  }

  for (const serialPort of serialPorts) {
    const normalized = normalizeSerialPort(serialPort);
    if (!normalized.path) {
      continue;
    }

    const candidate = buildCandidate({ port: normalized, matching_boards: [] }, serialPortMap);
    rememberPort(candidate);
    rememberCandidate(candidateMap, candidate);
  }

  const boards = [];
  for (const candidate of candidateMap.values()) {
    boards.push(options.probeEsp ? await applyEspChipProbe(candidate) : candidate);
  }

  return {
    success: true,
    boards,
    ports: ports.sort(comparePortPaths),
    detectedAt: new Date().toISOString(),
  };
}

module.exports = {
  detectLocalBoardsDeterministic,
};

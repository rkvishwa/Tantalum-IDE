const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");

const { getArduinoCliEnv, getCliPath } = require("../../arduinoHandler");

const HIGH_CONFIDENCE = 0.9;
const MEDIUM_CONFIDENCE = 0.55;
const LOW_CONFIDENCE = 0.25;
const ESPTOOL_PROBE_TIMEOUT_MS = 8000;
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

function normalizeSerialPort(port) {
  const properties = port?.properties && typeof port.properties === "object" ? port.properties : {};
  const path = getPortPath(port);
  return {
    path,
    label: normalizeString(port.label || port.friendlyName || path),
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

function runEspToolProbe(port) {
  const esptoolPath = findEspToolExecutable();
  if (!esptoolPath) {
    return Promise.resolve(null);
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
          resolve(null);
          return;
        }

        resolve({
          ...chipTarget,
          output,
        });
      },
    );
  });
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

function candidateFingerprint(port) {
  const stable = [
    port.serialNumber,
    port.vendorId,
    port.productId,
    port.pnpId,
    port.locationId,
    port.manufacturer,
    port.path,
  ]
    .map(normalizeString)
    .filter(Boolean)
    .join("|")
    .toLowerCase();

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
  const serialPort = serialPortMap.get(normalizeId(path)) || {};
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
  const serialPortMap = new Map(serialPorts.map((port) => [normalizeId(getPortPath(port)), normalizeSerialPort(port)]));
  const seen = new Set();
  const seenPorts = new Set();
  const candidates = [];
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
    if (!candidate.path || seen.has(normalizeId(candidate.path)) || !isLikelyBoardPort(candidate)) {
      continue;
    }

    seen.add(normalizeId(candidate.path));
    candidates.push(candidate);
  }

  for (const serialPort of serialPorts) {
    const normalized = normalizeSerialPort(serialPort);
    if (!normalized.path || seen.has(normalizeId(normalized.path))) {
      if (normalized.path) {
        rememberPort(buildCandidate({ port: normalized, matching_boards: [] }, serialPortMap));
      }
      continue;
    }

    const candidate = buildCandidate({ port: normalized, matching_boards: [] }, serialPortMap);
    rememberPort(candidate);
    if (!isLikelyBoardPort(candidate)) {
      continue;
    }

    seen.add(normalizeId(normalized.path));
    candidates.push(candidate);
  }

  const boards = [];
  for (const candidate of candidates) {
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

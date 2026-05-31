/**
 * Provisioning Service
 * Handles initial board setup via USB with OTA-ready firmware.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

const {
  buildTantalumWifiHostname,
  createArduinoCliConfig,
  getArduinoCliEnv,
  getArduinoLibraryDirectory,
  getCliPath,
  installLibrary,
} = require("../../arduinoHandler");

const ARDUINO_CLI_OUTPUT_MAX_BUFFER = 50 * 1024 * 1024;
const ESP32_NATIVE_USB_CDC_BOARD_MARKERS = ["esp32c3", "esp32s2", "esp32s3"];

function formatUsbWifiSerialError(error, port) {
  const message = String(error?.message || error || "Serial port error.");
  const writePortLabel = port ? ` to ${port}` : "";
  const usePortLabel = port ? ` on ${port}` : "";

  if (/GetOverlappedResult|operation aborted|aborted|cancelled|canceled/i.test(message)) {
    return `USB WiFi provisioning was interrupted while writing${writePortLabel}. The board may have reset, disconnected, or changed COM ports. Reconnect the board, close any Serial Monitor using the port, run Auto detect if the COM port changed, then try again.`;
  }

  if (/access denied|busy|permission|in use|cannot open|failed to open/i.test(message)) {
    return `Could not use the USB serial port${usePortLabel}. Close any Serial Monitor or other serial tool using the port, then try again.`;
  }

  return message;
}

function isEsp32NativeUsbCdcBoardId(boardId) {
  const normalized = String(boardId || "").trim().toLowerCase();
  return ESP32_NATIVE_USB_CDC_BOARD_MARKERS.some((marker) => normalized === marker || normalized.includes(marker));
}

function withEsp32CloudRuntimeUploadOptions(fqbn) {
  const value = String(fqbn || "").trim();
  if (!value.startsWith("esp32:")) {
    return value;
  }

  const parts = value.split(":");
  const boardId = String(parts[2] || "").trim().toLowerCase();
  const enableUsbCdcOnBoot = isEsp32NativeUsbCdcBoardId(boardId);
  const baseFqbn = parts.slice(0, 3).join(":");
  const options = parts.length >= 4 ? parts.slice(3).join(":") : "";
  const optionList = options
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !entry.toLowerCase().startsWith("eraseflash="))
    .filter((entry) => !enableUsbCdcOnBoot || !entry.toLowerCase().startsWith("cdconboot="));

  if (enableUsbCdcOnBoot) {
    optionList.push("CDCOnBoot=cdc");
  }

  optionList.push("EraseFlash=all");
  return `${baseFqbn}:${optionList.join(",")}`;
}

class ProvisioningService {
  constructor() {
    this.firmwareTemplatePath = path.join(__dirname, "../../resources/firmware/esp32_ota_client.ino");
    this.runtimeHeaderPath = path.join(__dirname, "../../resources/firmware/TantalumCloudRuntime.h");
  }

  runCliCommand(args, options = {}) {
    if (typeof options.onProgress === "function") {
      return this.runCliCommandStreaming(args, options);
    }

    return new Promise((resolve) => {
      try {
        execFile(getCliPath(), args, { maxBuffer: ARDUINO_CLI_OUTPUT_MAX_BUFFER, ...options, env: getArduinoCliEnv(options.env) }, (error, stdout, stderr) => {
          if (error) {
            const output = [stderr, stdout, error.message].filter(Boolean).join("\n");
            resolve({
              success: false,
              error: output || "Arduino CLI command failed.",
              output: stdout,
            });
            return;
          }

          resolve({
            success: true,
            output: stdout,
          });
        });
      } catch (error) {
        resolve({ success: false, error: error.message });
      }
    });
  }

  runCliCommandStreaming(args, options = {}) {
    const { onProgress, timeout = 300000, env, ...spawnOptions } = options;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutId = null;

      const settle = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(result);
      };

      let child;
      try {
        child = spawn(getCliPath(), args, {
          ...spawnOptions,
          env: getArduinoCliEnv(env),
          windowsHide: true,
        });
      } catch (error) {
        settle({ success: false, error: error.message || "Arduino CLI command failed." });
        return;
      }

      const appendOutput = (chunk, stream) => {
        const text = chunk.toString("utf8");
        if (stream === "stderr") {
          stderr += text;
        } else {
          stdout += text;
        }

        if (stdout.length + stderr.length > ARDUINO_CLI_OUTPUT_MAX_BUFFER) {
          stdout = stdout.slice(-ARDUINO_CLI_OUTPUT_MAX_BUFFER / 2);
          stderr = stderr.slice(-ARDUINO_CLI_OUTPUT_MAX_BUFFER / 2);
        }

        onProgress?.(text, stream);
      };

      child.stdout?.on("data", (chunk) => appendOutput(chunk, "stdout"));
      child.stderr?.on("data", (chunk) => appendOutput(chunk, "stderr"));

      child.on("error", (error) => {
        const output = [stderr, stdout, error.message].filter(Boolean).join("\n");
        settle({ success: false, error: output || "Arduino CLI command failed.", output: stdout });
      });

      child.on("close", (code) => {
        if (code === 0) {
          settle({ success: true, output: stdout });
          return;
        }

        const output = [stderr, stdout, `Arduino CLI exited with code ${code}.`].filter(Boolean).join("\n");
        settle({ success: false, error: output || "Arduino CLI command failed.", output: stdout });
      });

      timeoutId = setTimeout(() => {
        try {
          child.kill();
        } catch { }
        const output = [stderr, stdout, `Arduino CLI command timed out after ${Math.round(timeout / 1000)} seconds.`].filter(Boolean).join("\n");
        settle({ success: false, error: output, output: stdout });
      }, timeout);
    });
  }

  async generateProvisioningFirmware(config) {
    const {
      boardId,
      apiToken,
      commandSecret,
      mqttTopic,
      provisioningPop,
      appwriteEndpoint,
      appwriteProjectId,
      deviceGatewayFunctionId,
      mqttHost,
      mqttPort,
      mqttUsername,
      mqttPassword,
      mqttCaCert,
      tlsCaCert,
      boardName,
      wifiHostname,
    } = config;

    try {
      let firmware = fs.readFileSync(this.firmwareTemplatePath, "utf8");
      const runtimeHeader = fs.readFileSync(this.runtimeHeaderPath, "utf8");
      const provisioningServiceName = `Tantalum-${String(boardId || "board").slice(-8)}`;
      const resolvedWifiHostname = buildTantalumWifiHostname(wifiHostname || boardName, boardId);
      const buildEpoch = Math.max(1700000000, Math.floor(Date.now() / 1000));
      const literal = (value) => JSON.stringify(String(value ?? ""));
      const numericLiteral = (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : String(fallback);
      };

      firmware = firmware
        .replace(/{{API_TOKEN_LITERAL}}/g, literal(apiToken))
        .replace(/{{BOARD_ID_LITERAL}}/g, literal(boardId))
        .replace(/{{APPWRITE_ENDPOINT_LITERAL}}/g, literal(appwriteEndpoint))
        .replace(/{{APPWRITE_PROJECT_ID_LITERAL}}/g, literal(appwriteProjectId))
        .replace(/{{DEVICE_GATEWAY_FUNCTION_ID_LITERAL}}/g, literal(deviceGatewayFunctionId))
        .replace(/{{BUILD_EPOCH_LITERAL}}/g, numericLiteral(buildEpoch, 1700000000))
        .replace(/{{MQTT_HOST_LITERAL}}/g, literal(mqttHost))
        .replace(/{{MQTT_PORT_LITERAL}}/g, numericLiteral(mqttPort, 8883))
        .replace(/{{MQTT_USERNAME_LITERAL}}/g, literal(mqttUsername))
        .replace(/{{MQTT_PASSWORD_LITERAL}}/g, literal(mqttPassword))
        .replace(/{{MQTT_TOPIC_LITERAL}}/g, literal(mqttTopic))
        .replace(/{{COMMAND_SECRET_LITERAL}}/g, literal(commandSecret))
        .replace(/{{TLS_CA_CERT_LITERAL}}/g, literal(tlsCaCert))
        .replace(/{{MQTT_CA_CERT_LITERAL}}/g, literal(mqttCaCert))
        .replace(/{{PROVISIONING_POP_LITERAL}}/g, literal(provisioningPop))
        .replace(/{{PROVISIONING_SERVICE_NAME_LITERAL}}/g, literal(provisioningServiceName))
        .replace(/{{WIFI_HOSTNAME_LITERAL}}/g, literal(resolvedWifiHostname));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tantalum-provision-"));
      const sketchDir = path.join(tmpDir, "esp32_ota_client");
      fs.mkdirSync(sketchDir);

      const sketchPath = path.join(sketchDir, "esp32_ota_client.ino");
      fs.writeFileSync(sketchPath, firmware, "utf8");
      fs.writeFileSync(path.join(sketchDir, "TantalumCloudRuntime.h"), runtimeHeader, "utf8");

      return { success: true, tmpDir, sketchDir, sketchPath };
    } catch (error) {
      console.error("Generate provisioning firmware error:", error);
      return { success: false, error: error.message };
    }
  }

  async listPorts() {
    try {
      const { SerialPort } = require("serialport");
      const ports = await SerialPort.list();

      const filteredPorts = ports.filter((port) => {
        const manufacturer = (port.manufacturer || "").toLowerCase();
        const portPath = (port.path || "").toLowerCase();

        return (
          manufacturer.includes("silicon") ||
          manufacturer.includes("ftdi") ||
          manufacturer.includes("ch340") ||
          manufacturer.includes("cp210") ||
          manufacturer.includes("usb") ||
          portPath.includes("com") ||
          portPath.includes("tty")
        );
      });

      return {
        success: true,
        ports: filteredPorts.map((port) => ({
          path: port.path,
          manufacturer: port.manufacturer || "Unknown",
          vendorId: port.vendorId,
          productId: port.productId,
        })),
      };
    } catch (error) {
      console.error("List ports error:", error);
      return { success: false, error: error.message };
    }
  }

  async validatePortAvailable(port) {
    const normalizedPort = String(port || "").trim();
    if (!normalizedPort) {
      return { success: false, error: "Select a USB port before installing Tantalum Cloud." };
    }

    const portsResult = await this.listPorts();
    if (!portsResult.success) {
      return { success: false, error: portsResult.error || "Unable to list serial ports before uploading." };
    }

    const availablePorts = portsResult.ports || [];
    const portExists = availablePorts.some((entry) => String(entry.path || "").trim().toLowerCase() === normalizedPort.toLowerCase());
    if (!portExists) {
      const availableText = availablePorts.map((entry) => entry.path).filter(Boolean).join(", ");
      return {
        success: false,
        error: `${normalizedPort} is no longer available. The board may have reconnected as another COM port.${availableText ? ` Available ports: ${availableText}.` : ""}`,
      };
    }

    return { success: true };
  }

  async uploadToBoard(sketchDir, port, boardType = "esp32:esp32:esp32", onProgress) {
    const portCheck = await this.validatePortAvailable(port);
    if (!portCheck.success) {
      return portCheck;
    }

    const arduinoDirectory = await getArduinoLibraryDirectory();
    const { configDir, configFile } = createArduinoCliConfig(arduinoDirectory.userDir);
    let result;

    try {
      const uploadBoardType = withEsp32CloudRuntimeUploadOptions(boardType);
      const uploadArgs = ["--config-file", configFile, "compile", "--upload", "--fqbn", uploadBoardType, "--port", port, sketchDir];
      if (uploadBoardType !== String(boardType || "").trim()) {
        onProgress?.("Erasing ESP32 flash before installing Tantalum Cloud so stale OTA slots cannot boot old firmware.\n", "stdout");
      }

      result = await this.runCliCommand(
        uploadArgs,
        {
          timeout: 300000,
          env: {
            ARDUINO_DIRECTORIES_USER: arduinoDirectory.userDir,
          },
          onProgress,
        }
      );
    } finally {
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch { }
    }

    if (!result.success) {
      return result;
    }

    return {
      success: true,
      message: "Tantalum Cloud runtime uploaded successfully. The bootstrap runtime should print its version on Serial Monitor after reboot.",
      output: result.output,
    };
  }

  async ensureCloudRuntimeDependencies(config, onProgress) {
    onProgress?.("Ensuring ArduinoJson library is installed...\n", "stdout");
    await installLibrary("ArduinoJson", "latest");

    const hasStrictMqttConfig = Boolean(
      String(config?.mqttHost || "").trim() &&
      String(config?.mqttTopic || "").trim() &&
      String(config?.mqttCaCert || "").trim()
    );

    if (hasStrictMqttConfig) {
      onProgress?.("Ensuring PubSubClient library is installed...\n", "stdout");
      await installLibrary("PubSubClient", "latest");
    }
  }

  async provisionBoard(board, port, appwriteConfig, onProgress) {
    try {
      const portCheck = await this.validatePortAvailable(port);
      if (!portCheck.success) {
        return portCheck;
      }

      const runtimeConfig = {
        boardId: board.$id,
        boardName: board.name,
        wifiHostname: buildTantalumWifiHostname(board.name, board.$id),
        apiToken: board.apiToken,
        commandSecret: board.commandSecret,
        mqttTopic: board.mqttTopic,
        provisioningPop: board.provisioningPop,
        appwriteEndpoint: appwriteConfig.endpoint,
        appwriteProjectId: appwriteConfig.projectId,
        deviceGatewayFunctionId: appwriteConfig.deviceGatewayFunctionId,
        mqttHost: appwriteConfig.mqttHost || process.env.TANTALUM_MQTT_HOST || "",
        mqttPort: appwriteConfig.mqttPort || process.env.TANTALUM_MQTT_PORT || 8883,
        mqttUsername: appwriteConfig.mqttUsername || process.env.TANTALUM_MQTT_DEVICE_USERNAME || "",
        mqttPassword: appwriteConfig.mqttPassword || process.env.TANTALUM_MQTT_DEVICE_PASSWORD || "",
        mqttCaCert: appwriteConfig.mqttCaCert || process.env.TANTALUM_MQTT_CA_CERT || "",
        tlsCaCert: appwriteConfig.tlsCaCert || process.env.TANTALUM_TLS_CA_CERT || "",
      };

      await this.ensureCloudRuntimeDependencies(runtimeConfig, onProgress);
      onProgress?.("Generating Tantalum Cloud runtime sketch...\n", "stdout");
      const firmwareResult = await this.generateProvisioningFirmware(runtimeConfig);

      if (!firmwareResult.success) {
        return firmwareResult;
      }

      onProgress?.(`Uploading Tantalum Cloud runtime to ${port}...\n`, "stdout");
      const uploadResult = await this.uploadToBoard(
        firmwareResult.sketchDir,
        port,
        board.boardType,
        onProgress
      );

      try {
        fs.rmSync(firmwareResult.tmpDir, { recursive: true, force: true });
      } catch (error) {
        console.warn("Cleanup warning:", error.message);
      }

      return uploadResult;
    } catch (error) {
      console.error("Provision board error:", error);
      return { success: false, error: error.message };
    }
  }

  signWifiProvisioningCommand({ boardId, ssid, password, nonce, commandSecret }) {
    return crypto
      .createHmac("sha256", commandSecret)
      .update(["wifi-provision", boardId, ssid, password, nonce].join("\n"))
      .digest("hex");
  }

  async provisionBoardWifiUsb({ boardId, commandSecret, port, ssid, password }) {
    const normalizedBoardId = String(boardId || "").trim();
    const normalizedPort = String(port || "").trim();
    const normalizedSsid = String(ssid || "").trim();

    if (!normalizedBoardId) {
      return { success: false, error: "A cloud board ID is required." };
    }

    if (!commandSecret) {
      return { success: false, error: "Local command secret is missing. Rotate the board token, then flash the cloud runtime again." };
    }

    if (!normalizedPort) {
      return { success: false, error: "Select a USB port before provisioning WiFi." };
    }

    const portCheck = await this.validatePortAvailable(normalizedPort);
    if (!portCheck.success) {
      return portCheck;
    }

    if (!normalizedSsid) {
      return { success: false, error: "WiFi SSID is required." };
    }

    let SerialPort;
    try {
      ({ SerialPort } = require("serialport"));
    } catch (error) {
      return { success: false, error: `Serial port support is unavailable: ${error.message}` };
    }

    const nonce = crypto.randomBytes(12).toString("hex");
    const request = {
      type: "wifi-provision",
      boardId: normalizedBoardId,
      ssid: normalizedSsid,
      password: String(password || ""),
      nonce,
      signature: this.signWifiProvisioningCommand({
        boardId: normalizedBoardId,
        ssid: normalizedSsid,
        password: String(password || ""),
        nonce,
        commandSecret,
      }),
    };

    return await new Promise((resolve) => {
      const serial = new SerialPort({ path: normalizedPort, baudRate: 115200, autoOpen: false });
      let settled = false;
      let lineBuffer = "";
      let sendIntervalId = null;
      let sendDelayId = null;
      let timeoutId = null;
      const requestLine = `${JSON.stringify(request)}\n`;
      request.password = "";

      const settle = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (sendDelayId) {
          clearTimeout(sendDelayId);
          sendDelayId = null;
        }
        if (sendIntervalId) {
          clearInterval(sendIntervalId);
          sendIntervalId = null;
        }
        serial.removeAllListeners("data");
        if (serial.isOpen) {
          serial.close(() => resolve(result));
          return;
        }
        resolve(result);
      };

      timeoutId = setTimeout(() => {
        settle({
          success: false,
          error: "The board did not confirm WiFi provisioning over USB. Make sure the Tantalum cloud runtime is flashed, Serial Monitor is closed, and ESP32-S3/C3 boards were installed with USB CDC On Boot enabled.",
        });
      }, 60000);

      serial.on("error", (error) => {
        if (settled) {
          return;
        }

        settle({
          success: false,
          error: formatUsbWifiSerialError(error, normalizedPort),
        });
      });

      serial.on("data", (chunk) => {
        lineBuffer += chunk.toString("utf8");
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("{")) {
            continue;
          }

          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }

          if (message?.type !== "wifi-provision") {
            continue;
          }

          if (message.status === "accepted") {
            if (sendIntervalId) {
              clearInterval(sendIntervalId);
              sendIntervalId = null;
            }
            continue;
          }

          if (message.status === "connected") {
            settle({
              success: true,
              boardId: normalizedBoardId,
              port: normalizedPort,
              status: "connected",
              message: "WiFi credentials were sent directly to the board and the board connected.",
            });
            return;
          }

          settle({
            success: false,
            error: String(message.error || "The board could not connect to WiFi with the provided credentials."),
          });
        }
      });

      serial.open((error) => {
        if (error) {
          settle({ success: false, error: formatUsbWifiSerialError(error, normalizedPort) });
          return;
        }

        const writeRequest = () => {
          if (settled) {
            return;
          }

          try {
            serial.write(requestLine, (writeError) => {
              if (settled) {
                return;
              }

              if (writeError) {
                settle({ success: false, error: formatUsbWifiSerialError(writeError, normalizedPort) });
                return;
              }

              try {
                serial.drain((drainError) => {
                  if (settled) {
                    return;
                  }

                  if (drainError) {
                    settle({ success: false, error: formatUsbWifiSerialError(drainError, normalizedPort) });
                  }
                });
              } catch (drainError) {
                settle({ success: false, error: formatUsbWifiSerialError(drainError, normalizedPort) });
              }
            });
          } catch (writeError) {
            settle({ success: false, error: formatUsbWifiSerialError(writeError, normalizedPort) });
          }
        };

        sendDelayId = setTimeout(() => {
          sendDelayId = null;
          if (settled) {
            return;
          }
          writeRequest();
          sendIntervalId = setInterval(writeRequest, 4000);
        }, 2500);
      });
    });
  }

  async installBoardSupport() {
    const updateResult = await this.runCliCommand(
      [
        "core",
        "update-index",
        "--additional-urls",
        "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json",
      ],
      { timeout: 10 * 60 * 1000 }
    );

    if (!updateResult.success) {
      return updateResult;
    }

    const installResult = await this.runCliCommand(
      [
        "core",
        "install",
        "esp32:esp32",
        "--additional-urls",
        "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json",
      ],
      { timeout: 2 * 60 * 60 * 1000 }
    );

    if (!installResult.success) {
      return installResult;
    }

    return {
      success: true,
      message: "ESP32 board support installed successfully!",
      output: installResult.output,
    };
  }
}

const provisioningService = new ProvisioningService();
provisioningService._test = {
  withEsp32CloudRuntimeUploadOptions,
};

module.exports = provisioningService;

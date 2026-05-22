/**
 * Provisioning Service
 * Handles initial board setup via USB with OTA-ready firmware.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const { getArduinoCliEnv, getCliPath } = require("../../arduinoHandler");

class ProvisioningService {
  constructor() {
    this.firmwareTemplatePath = path.join(__dirname, "../../resources/firmware/esp32_ota_client.ino");
  }

  runCliCommand(args, options = {}) {
    return new Promise((resolve) => {
      try {
        execFile(getCliPath(), args, { ...options, env: getArduinoCliEnv(options.env) }, (error, stdout, stderr) => {
          if (error) {
            resolve({
              success: false,
              error: stderr || stdout || error.message,
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

  async generateProvisioningFirmware(config) {
    const {
      boardId,
      apiToken,
      wifiSSID,
      wifiPassword,
      appwriteEndpoint,
      appwriteProjectId,
      deviceGatewayFunctionId,
    } = config;

    try {
      let firmware = fs.readFileSync(this.firmwareTemplatePath, "utf8");

      firmware = firmware
        .replace(/{{WIFI_SSID}}/g, wifiSSID)
        .replace(/{{WIFI_PASSWORD}}/g, wifiPassword)
        .replace(/{{API_TOKEN}}/g, apiToken)
        .replace(/{{BOARD_ID}}/g, boardId)
        .replace(/{{APPWRITE_ENDPOINT}}/g, appwriteEndpoint)
        .replace(/{{APPWRITE_PROJECT_ID}}/g, appwriteProjectId)
        .replace(/{{DEVICE_GATEWAY_FUNCTION_ID}}/g, deviceGatewayFunctionId);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tantalum-provision-"));
      const sketchDir = path.join(tmpDir, "esp32_ota_client");
      fs.mkdirSync(sketchDir);

      const sketchPath = path.join(sketchDir, "esp32_ota_client.ino");
      fs.writeFileSync(sketchPath, firmware, "utf8");

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

  async uploadToBoard(sketchDir, port, boardType = "esp32:esp32:esp32") {
    const result = await this.runCliCommand(
      ["compile", "--upload", "--fqbn", boardType, "--port", port, sketchDir],
      { timeout: 120000 }
    );

    if (!result.success) {
      return result;
    }

    return {
      success: true,
      message: "Provisioning firmware uploaded successfully!",
      output: result.output,
    };
  }

  async provisionBoard(board, port, appwriteConfig) {
    try {
      const firmwareResult = await this.generateProvisioningFirmware({
        boardId: board.$id,
        apiToken: board.apiToken,
        wifiSSID: board.wifiSSID,
        wifiPassword: board.wifiPassword,
        appwriteEndpoint: appwriteConfig.endpoint,
        appwriteProjectId: appwriteConfig.projectId,
        deviceGatewayFunctionId: appwriteConfig.deviceGatewayFunctionId,
      });

      if (!firmwareResult.success) {
        return firmwareResult;
      }

      const uploadResult = await this.uploadToBoard(
        firmwareResult.sketchDir,
        port,
        board.boardType
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

module.exports = new ProvisioningService();

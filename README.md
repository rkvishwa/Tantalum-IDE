# <img src="resources/icons/tantalum-icon.png" width="32" height="32" alt="Tantalum Icon" /> Tantalum IDE

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-1.0.0-green.svg)
![Electron](https://img.shields.io/badge/Electron-Desktop-blue)
![React](https://img.shields.io/badge/React-UI-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6)

Tantalum IDE is a desktop application built with Electron, React, and TypeScript. It provides a robust environment for editing Arduino sketches, managing local workspaces, compiling firmware, and shipping Over-The-Air (OTA) firmware updates via Appwrite. Tantalum IDE also features an integrated **Agentic AI coding assistant** to supercharge your hardware development workflow.

---

## 📸 Screenshots

| Workspace & Editor | AI Assistant | Firmware OTA |
|:---:|:---:|:---:|
| <img src="./images/1.jpeg" alt="Workspace" width="250"/> | <img src="./images/2.jpeg" alt="AI Assistant" width="250"/> | <img src="./images/3.jpeg" alt="OTA Updates" width="250"/> |

---

## ✨ Features

- **Arduino Sketch Editing:** Full-featured code editor powered by Monaco Editor, tuned for C/C++.
- **Local Workspace Management:** Organize your projects, libraries, and sketches easily from an intuitive UI.
- **Firmware Compilation:** Seamless integration with Arduino CLI for compiling and building firmware locally.
- **OTA Firmware Delivery:** Ship and deploy firmware updates directly to your boards over-the-air using Appwrite cloud synchronization.
- **Agentic AI Coding Assistant:** Built-in AI helper powered by OpenCode SDK to assist with code generation, debugging, and project structuring.
- **Cross-Platform:** Available for macOS, Windows, and Linux.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/) (v9 or higher)
- [Arduino CLI](https://arduino.github.io/arduino-cli/) (installed and accessible in PATH or bundled in `resources/arduino-cli`)

### Installation & Local Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/tantalum-ide.git
   cd tantalum-ide
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```
   This command starts both the React renderer (via Vite) and the Electron main process concurrently.

4. **Build for production:**
   ```bash
   # Build for your current OS
   npm run dist
   
   # Or explicitly build for macOS
   npm run build:mac
   ```

---

## 🛠 Scripts

Here are the primary scripts available in `package.json`:

- `npm run dev` - Start the development environment (React + Electron).
- `npm run start` - Start the built Electron app.
- `npm run build:renderer` - Build the React frontend.
- `npm run dist` - Build and package the application using electron-builder.
- `npm run selfhost:seed` - Seed Appwrite collections for self-hosting.
- `npm run secret:encrypt-api-key` - Encrypt API keys for Appwrite functions.
- `npm run smoke:*` - Various smoke tests for integration and functionality.

---

## 🌍 Self-Hosting Guide

Tantalum IDE uses Appwrite as its backend for OTA firmware updates, authentication, and cloud synchronization. Follow these steps to self-host the Appwrite backend.

### 1. Appwrite CLI Setup

For the self-hosted Azure deployment path, use `docs/azure-selfhost-appwrite.md` (if available). That runbook provisions the Azure VM, mounts a 256 GB Appwrite data disk, installs backup/restore scripts, updates the app target, and seeds only the important clean-environment config.

The Appwrite CLI for production should target:
- **endpoint:** `https://fra.cloud.appwrite.io/v1`
- **project:** `tantalum`

### 2. Project Migration (If Applicable)

If you are migrating from an older project, use Appwrite Console migration first for Auth users, databases, rows, storage files, functions, and sites. 

After the Console migration, verify counts from this repo without printing secrets:
```powershell
$env:SOURCE_APPWRITE_API_KEY = "<old project admin key>"
$env:TARGET_APPWRITE_API_KEY = "<new project admin key>"
npm run migrate:appwrite-project
```

Fallback copy (dry-run first):
```powershell
npm run migrate:appwrite-project -- --copy-all
# Apply if dry-run is correct:
npm run migrate:appwrite-project -- --copy-all --yes
```

### 3. Deploy Functions

Appwrite Functions are scaffolded under `functions/`:
- `board-admin`
- `device-gateway`
- `agent-settings`
- `agent-gateway`
- `board-detection`

Deploy these using the Appwrite CLI. Ensure that function variables are set correctly:
- `board-admin`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`, `APPWRITE_FIRMWARE_COLLECTION_ID`
- `device-gateway`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`, `APPWRITE_FIRMWARE_COLLECTION_ID`, `APPWRITE_FIRMWARE_BUCKET_ID`, `TANTALUM_APPWRITE_PUBLIC_ENDPOINT`
- `agent-settings` & `agent-gateway`: `APPWRITE_DATABASE_ID` plus agent collection IDs and `AGENT_DEFAULT_MONTHLY_CREDITS`
- `board-detection`: `APPWRITE_DATABASE_ID`, `APPWRITE_UTILITY_AI_MODEL_POOL_COLLECTION_ID`, and board-detection cache/usage collection IDs

### 4. Advanced Setup: MQTT & AI Keys

<details>
<summary>Click to expand MQTT & AI Key Configuration</summary>

**MQTT OTA VPS setup:**
1. Create DNS: `mqtt.yourdomain.com` pointing to the VPS public IP.
2. Install Mosquitto:
   ```bash
   sudo apt update
   sudo apt install -y mosquitto mosquitto-clients openssl
   sudo systemctl enable --now mosquitto
   sudo ufw allow 8883/tcp
   ```
3. Create a TLS CA and server certificate for `mqtt.yourdomain.com`, configure Mosquitto listener `8883` with `allow_anonymous false`, password and ACL files, and TLS version `tlsv1.2`.
4. Create users:
   ```bash
   sudo mosquitto_passwd -b -c /etc/mosquitto/passwd tantalum_publisher '<publisher-password>'
   sudo mosquitto_passwd -b /etc/mosquitto/passwd tantalum_device '<device-password>'
   ```
5. Set `/etc/mosquitto/acl`:
   ```text
   user tantalum_publisher
   topic write tantalum/boards/+/+/cmd

   user tantalum_device
   topic read tantalum/boards/+/+/cmd
   ```
6. Set Appwrite `board-admin` variables:
   - `TANTALUM_BOARD_SECRET_KEK_V1`
   - `TANTALUM_MQTT_URL=mqtts://mqtt.yourdomain.com:8883`
   - `TANTALUM_MQTT_PUBLISHER_USERNAME=tantalum_publisher`
   - `TANTALUM_MQTT_PUBLISHER_PASSWORD`
   - `TANTALUM_MQTT_CA_CERT`
7. Set desktop/runtime build variables: `TANTALUM_MQTT_HOST=mqtt.yourdomain.com`, `TANTALUM_MQTT_PORT=8883`, `TANTALUM_MQTT_DEVICE_USERNAME=tantalum_device`, `TANTALUM_MQTT_DEVICE_PASSWORD`, and `TANTALUM_MQTT_CA_CERT`.

**AI Keys Setup:**
Generate a Master Key (KEK) for encrypting AI Provider API keys:
```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```
Set `TANTALUM_SECRET_KEK_V1` in the AI functions (`agent-settings`, `agent-gateway`, `board-detection`).

API key records now store encrypted `apiKeyEnvelope` values. To migrate or apply manually:
```bash
npm run migrate:api-key-envelopes
npm run migrate:api-key-envelopes -- --apply
```
To encrypt API keys manually:
```bash
npm run secret:encrypt-api-key
```
</details>

### 5. Database & Storage Structure

**Database ID:** `697b8f660033fffde4be`

Expected `boards` attributes:
`userId`, `name`, `boardType`, `wifiSSID`, `tokenHash`, `tokenPreview`, `firmwareVersion`, `commandSecretEnvelope`, `mqttTopicSuffix`, `provisioningPop`, `desiredFirmwareId`, `desiredVersion`, `desiredDeploymentId`, `lastAppliedDeploymentId`, `runtimeVersion`, `lastUpdateCheckAt`, `otaStatus`, `otaUpdateMode`, `provisioningStatus`, `provisioningRequestedAt`, `provisioningMode`, `lastOtaError`, `status`, `lastSeen`, `lastProvisionedAt`, `createdAt`, `updatedAt`

Expected `firmwares` attributes:
`userId`, `boardId`, `version`, `fileId`, `filename`, `size`, `checksum`, `uploadedAt`, `deployed`, `notes`

*(Document security is enabled on `boards`, `firmwares`, and `sketches`)*

**Storage Bucket:** `firmware_bucket` (with file security enabled). The renderer uploads firmware files with public read permission so the device gateway can hand boards a direct download URL.

---

## 📖 Documentation Links

- [Architecture Overview](ARCHITECTURE.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🛡️ Security

For security concerns, please refer to our [Security Policy](SECURITY.md) or contact `hello@knurdz.org` directly.

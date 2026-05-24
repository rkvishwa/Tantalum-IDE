# Tantalum IDE

Tantalum IDE is an Electron desktop app with a React + TypeScript renderer for editing Arduino sketches, managing local workspaces, compiling firmware with the bundled `arduino-cli`, and shipping OTA releases through Appwrite. The IDE powered by agentic AI for coding also.

## What changed

- React + TypeScript renderer under `renderer-react/`
- Secure Electron preload bridge for native-only capabilities
- Appwrite auth, database, storage, and function-backed board workflows
- Local-only storage for raw board tokens and provisioning command secrets
- OTA provisioning firmware updated to use runtime WiFi provisioning, heartbeat fallback, and optional MQTT triggers

## Local scripts

From the project root:

```bash
npm install
npm run dev
```

The root package uses npm workspaces, so one `npm install` installs both the Electron app dependencies and the `renderer-react/` Vite dependencies.

To package:

```bash
npm run dist
```

## Renderer env

`renderer-react/.env` is configured for this Appwrite project. The checked-in example file matches the live IDs:

- endpoint: `https://sgp.cloud.appwrite.io/v1`
- project: `697b8f42002a34ba04b3`
- database: `697b8f660033fffde4be`
- collections: `boards`, `firmwares`, `sketches`
- bucket: `firmware_bucket`
- functions: `board-admin`, `device-gateway`

## Appwrite CLI steps

The Appwrite CLI on this machine was configured to:

- endpoint: `https://sgp.cloud.appwrite.io/v1`
- project: `697b8f42002a34ba04b3`

Cloud resources were updated on `2026-04-07` and are live now.

### Functions

Two Appwrite Functions are scaffolded and deployed:

- `appwrite/functions/board-admin`
- `appwrite/functions/device-gateway`

Live function IDs:

- `board-admin`
- `device-gateway`

Function variables:

- `board-admin`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`, `APPWRITE_FIRMWARE_COLLECTION_ID`
- `device-gateway`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`, `APPWRITE_FIRMWARE_COLLECTION_ID`, `APPWRITE_FIRMWARE_BUCKET_ID`
- MQTT command variables for `board-admin`: `TANTALUM_MQTT_URL` or `TANTALUM_MQTT_HOST`/`TANTALUM_MQTT_PORT`, `TANTALUM_MQTT_PUBLISHER_USERNAME`, `TANTALUM_MQTT_PUBLISHER_PASSWORD`, and `TANTALUM_MQTT_CA_CERT`. MQTT requires `mqtts://` plus a CA certificate; if these are missing, HTTPS heartbeat fallback remains active.
- MQTT device subscribe variables for desktop/runtime builds: `TANTALUM_MQTT_HOST`, `TANTALUM_MQTT_PORT`, `TANTALUM_MQTT_DEVICE_USERNAME`, `TANTALUM_MQTT_DEVICE_PASSWORD`, and `TANTALUM_MQTT_CA_CERT`.
- Set `TANTALUM_BOARD_SECRET_KEK_V1` on `board-admin` to encrypt per-board MQTT command secrets. Generate it with the same 32-byte base64 command shown below.
- AI key functions (`agent-settings`, `agent-gateway`, `board-detection`) also require `TANTALUM_SECRET_KEK_V1` as an Appwrite secret variable. Generate it with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Optional AI key variables:

- `TANTALUM_SECRET_ACTIVE_KEK_VERSION`: defaults to `v1`
- `TANTALUM_ALLOW_LEGACY_RAW_KEYS`: set to `true` only during migration if functions must temporarily read legacy raw `apiKey` fields

API key records now store encrypted `apiKeyEnvelope` values and keep legacy `apiKey` as a sentinel placeholder. After adding the `apiKeyEnvelope` attributes and setting the KEK secret on the functions, run a dry-run migration:

```bash
npm run migrate:api-key-envelopes
```

Then run the write migration with `APPWRITE_API_KEY` and the same `TANTALUM_SECRET_KEK_V1` value in the shell:

```bash
npm run migrate:api-key-envelopes -- --apply
```

For new managed-pool or board-detection provider keys without an admin UI, generate an encrypted document fragment with:

```bash
npm run secret:encrypt-api-key
```

Rotate provider keys that were visible in Appwrite Console before this migration.

If you redeploy later, package each function directory as a `tar.gz` archive and upload that archive to Appwrite. The source folders in `appwrite/functions/` are the canonical copies.

### Database collections

Using database `697b8f660033fffde4be`.

Expected `boards` attributes:

- `userId` string
- `name` string
- `boardType` string
- `wifiSSID` string
- `tokenHash` string
- `tokenPreview` string
- `firmwareVersion` string
- `commandSecretEnvelope` string
- `mqttTopicSuffix` string
- `provisioningPop` string
- `desiredFirmwareId` string
- `desiredVersion` string
- `desiredDeploymentId` string
- `lastAppliedDeploymentId` string
- `runtimeVersion` string
- `lastUpdateCheckAt` string or datetime
- `otaStatus` string
- `provisioningStatus` string
- `provisioningRequestedAt` string or datetime
- `provisioningMode` string
- `lastOtaError` string
- `status` string
- `lastSeen` string or datetime
- `lastProvisionedAt` string or datetime
- `createdAt` string or datetime
- `updatedAt` string or datetime

Expected `firmwares` attributes:

- `userId` string
- `boardId` string
- `version` string
- `fileId` string
- `filename` string
- `size` integer
- `checksum` string
- `uploadedAt` string or datetime
- `deployed` boolean
- `notes` string

Document security is enabled on `boards`, `firmwares`, and `sketches`.

### Storage bucket

Using bucket `firmware_bucket` with file security enabled.

The renderer uploads firmware files with public read permission so the device gateway can hand boards a direct download URL.

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

- endpoint: `https://fra.cloud.appwrite.io/v1`
- project: `tantalum`
- database: `697b8f660033fffde4be`
- collections: `boards`, `firmwares`, `sketches`
- bucket: `firmware_bucket`
- functions: `board-admin`, `device-gateway`, `agent-settings`, `agent-gateway`, `board-detection`

## Appwrite CLI steps

For the self-hosted Azure deployment path, use [docs/azure-selfhost-appwrite.md](docs/azure-selfhost-appwrite.md). That runbook provisions the Azure VM, mounts a 256 GB Appwrite data disk, installs backup/restore scripts, updates the app target, and seeds only the important clean-environment config.

The Appwrite CLI for production should target:

- endpoint: `https://fra.cloud.appwrite.io/v1`
- project: `tantalum`

The old SGP project was `697b8f42002a34ba04b3`. Keep it read-only during migration and do not point desktop/runtime builds back at it after cutover.

### Project migration

Use Appwrite Console migration first for Auth users, databases, rows, storage files, functions, and sites. Select the old SGP project as the source and the FRA `tantalum` project as the target. Preserve database, table, bucket, function, row, and file IDs wherever Appwrite allows.

After the Console migration, verify counts from this repo without printing secrets:

```powershell
$env:SOURCE_APPWRITE_API_KEY = "<old project admin key>"
$env:TARGET_APPWRITE_API_KEY = "<new project admin key>"
npm run migrate:appwrite-project
```

If the Console migration misses database rows or storage files after the target schema exists, dry-run the fallback copy first:

```powershell
npm run migrate:appwrite-project -- --copy-all
```

Apply the fallback copy only after the dry-run summary is correct:

```powershell
npm run migrate:appwrite-project -- --copy-all --yes
```

### Functions

Appwrite Functions are scaffolded under `functions/`:

- `functions/board-admin`
- `functions/device-gateway`
- `functions/agent-settings`
- `functions/agent-gateway`
- `functions/board-detection`

The legacy mirrors under `appwrite/functions/board-admin` and `appwrite/functions/device-gateway` should stay in sync while both trees exist.

Live function IDs:

- `board-admin`
- `device-gateway`
- `agent-settings`
- `agent-gateway`
- `board-detection`

Function variables:

- `board-admin`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`, `APPWRITE_FIRMWARE_COLLECTION_ID`
- `device-gateway`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`, `APPWRITE_FIRMWARE_COLLECTION_ID`, `APPWRITE_FIRMWARE_BUCKET_ID`
- `agent-settings`: `APPWRITE_DATABASE_ID` plus agent collection IDs and `AGENT_DEFAULT_MONTHLY_CREDITS`
- `agent-gateway`: `APPWRITE_DATABASE_ID` plus agent collection IDs and `AGENT_DEFAULT_MONTHLY_CREDITS`
- `board-detection`: `APPWRITE_DATABASE_ID` plus board-detection collection IDs
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

If you redeploy later, deploy from `functions/*`, then mirror `board-admin` and `device-gateway` into `appwrite/functions/*` while those duplicated folders remain in the repo.

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

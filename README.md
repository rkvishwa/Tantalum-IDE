# Tantalum IDE

Tantalum IDE is an Electron desktop app with a React + TypeScript renderer for editing Arduino sketches, managing local workspaces, compiling firmware with the bundled `arduino-cli`, and shipping OTA releases through Appwrite. The IDE powered by agentic AI for coding also.

## What changed

- React + TypeScript renderer under `renderer-react/`
- Secure Electron preload bridge for native-only capabilities
- Appwrite auth, database, storage, and function-backed board workflows
- Local-only storage for WiFi passwords and raw board tokens
- OTA provisioning firmware updated to call an Appwrite Function execution endpoint

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

- `board-admin`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`
- `device-gateway`: `APPWRITE_DATABASE_ID`, `APPWRITE_BOARDS_COLLECTION_ID`, `APPWRITE_FIRMWARE_COLLECTION_ID`, `APPWRITE_FIRMWARE_BUCKET_ID`

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

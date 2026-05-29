# Azure Self-Hosted Appwrite Runbook

This setup keeps production on self-hosted Appwrite while using Azure only as the VM provider. The Appwrite stack, data, files, and backups live under `/srv/tantalum` so the same workload can be restored onto another Azure VM or a different cloud provider later.

## Target Shape

- Region: `southeastasia` by default for Asia latency.
- VM: `Standard_B2s_v2` by default for the MVP.
- Disk: 64 GB OS disk plus a 256 GB attached data disk mounted at `/srv/tantalum`.
- Network: SSH restricted to your current public IP or an explicit CIDR; ports 80 and 443 open.
- Backup: daily local archive timer plus manual download/upload scripts.
- Scale path: resize VM first, then split storage/database, then move Appwrite behind a load balancer only after real usage proves it is needed.

The default VM is intentionally a single-node budget setup. It is not highly available. It is the right first commercial staging/early-production step when cost matters and you want portability.

## 1. Prerequisites

Install and sign in to Azure CLI:

```powershell
az login
az account show
```

Create or confirm an SSH key:

```powershell
ssh-keygen -t ed25519 -f "$HOME\.ssh\tantalum_azure_ed25519"
```

You also need a DNS record for your Appwrite API host, for example `api.yourdomain.com`.

## 2. Create the VM

From the repo root:

```powershell
.\infra\azure\deploy-appwrite-vm.ps1 `
  -SshPublicKeyPath "$HOME\.ssh\tantalum_azure_ed25519.pub" `
  -DataDiskSizeGb 256
```

The script auto-detects your current public IP and allows SSH only from that `/32`. If that fails, pass it explicitly:

```powershell
.\infra\azure\deploy-appwrite-vm.ps1 `
  -SshPublicKeyPath "$HOME\.ssh\tantalum_azure_ed25519.pub" `
  -SshSourceCidr "203.0.113.10/32" `
  -DataDiskSizeGb 256
```

Use a larger data disk only when firmware/storage growth requires it:

```powershell
.\infra\azure\deploy-appwrite-vm.ps1 -DataDiskSizeGb 512
```

After the script prints the public IP, point your DNS A record to it.

## 3. Upload Host Scripts And Start Installer

After DNS resolves to the VM:

```powershell
.\infra\azure\configure-appwrite.ps1 `
  -SshPrivateKeyPath "$HOME\.ssh\tantalum_azure_ed25519" `
  -AppDomain "api.yourdomain.com" `
  -StartInstaller
```

Open the installer through an SSH tunnel:

```powershell
ssh -i "$HOME\.ssh\tantalum_azure_ed25519" -L 20080:127.0.0.1:20080 azureuser@<vm-public-ip>
```

Then open `http://127.0.0.1:20080` and complete the Appwrite installer. Use the same domain, `api.yourdomain.com`, during setup.

The installer creates Appwrite's `docker-compose.yml` and `.env` under `/srv/tantalum/appwrite`.

## 4. Create Project And Push Schema

Create the Appwrite project in the self-hosted Console with project ID:

```text
tantalum
```

Then create an admin API key with database, storage, functions, users, and project scopes for setup scripts and CLI pushes.

Point the local Appwrite CLI at self-hosted Appwrite:

```powershell
appwrite client --endpoint "https://api.yourdomain.com/v1"
appwrite client --project-id "tantalum"
appwrite login
```

Push the repo schema/functions from `appwrite.config.json`:

```powershell
appwrite push tables
appwrite push buckets
appwrite push functions
```

If your Appwrite CLI version still uses the older database wording, use its equivalent database/collection push command. The repo manifest keeps the existing IDs, including database `697b8f660033fffde4be` and bucket `firmware_bucket`.

## 5. Point The App At Self-Hosted Appwrite

Update the repo target:

```powershell
npm run selfhost:set-target -- --endpoint "https://api.yourdomain.com/v1" --project-id "tantalum"
```

This updates `appwrite.config.json` and renderer env files that already exist.

## 6. Configure Function Secrets

Generate KEKs locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set these as Appwrite function variables/secrets where relevant:

- `TANTALUM_SECRET_KEK_V1` on `agent-settings`, `agent-gateway`, and `board-detection`.
- `TANTALUM_SECRET_ACTIVE_KEK_VERSION=v1` on the same functions.
- `TANTALUM_BOARD_SECRET_KEK_V1` on `board-admin`.
- `APPWRITE_DATABASE_ID=697b8f660033fffde4be` on all functions that use databases.
- Existing collection/bucket/function variables from `README.md`.
- MQTT variables only when MQTT is ready; HTTPS heartbeat fallback can run without MQTT.

Do not reuse old testing boards. Create fresh boards after the self-host cutover.

## 7. Seed Important Config Only

User history and old testing boards are not required. For a clean commercial test environment, seed only:

- `app_settings`: `agent.outputStyle` if you want non-default agent output policy.
- `agent_managed_key_pool`: one managed model provider key if the app should offer managed AI.
- `board_detection_model_config`: one board detection provider key if board AI detection should be enabled.

Set environment variables in the current shell. Example:

```powershell
$env:APPWRITE_ENDPOINT = "https://api.yourdomain.com/v1"
$env:APPWRITE_PROJECT_ID = "tantalum"
$env:APPWRITE_DATABASE_ID = "697b8f660033fffde4be"
$env:APPWRITE_API_KEY = "<self-host-admin-api-key>"
$env:TANTALUM_SECRET_KEK_V1 = "<same-kek-set-on-functions>"

$env:AGENT_OUTPUT_STYLE = "compact"
$env:TANTALUM_MANAGED_PROVIDER_LABEL = "Azure AI Foundry"
$env:TANTALUM_MANAGED_BASE_URL = "https://your-resource.openai.azure.com/openai/v1"
$env:TANTALUM_MANAGED_API_KEY = "<provider-key>"
$env:TANTALUM_MANAGED_FAST_MODEL = "gpt-4.1"
$env:TANTALUM_MANAGED_POWER_MODEL = "gpt-5.5"

$env:TANTALUM_BOARD_DETECTION_BASE_URL = "https://api.openai.com/v1"
$env:TANTALUM_BOARD_DETECTION_API_KEY = "<provider-key>"
$env:TANTALUM_BOARD_DETECTION_MODEL = "gpt-4.1-mini"
```

Dry-run first:

```powershell
npm run selfhost:seed
```

Apply:

```powershell
npm run selfhost:seed -- --yes
```

The seed script never prints raw provider keys.

## 8. Backups

The VM installs a daily `tantalum-appwrite-backup.timer`. Manual backup:

```powershell
.\infra\azure\backup-now.ps1 `
  -SshPrivateKeyPath "$HOME\.ssh\tantalum_azure_ed25519" `
  -DownloadPath ".\backups"
```

Optional Azure Blob copy:

```powershell
.\infra\azure\create-backup-storage.ps1
```

```powershell
.\infra\azure\backup-now.ps1 `
  -SshPrivateKeyPath "$HOME\.ssh\tantalum_azure_ed25519" `
  -DownloadPath ".\backups" `
  -StorageAccount "<storage-account>" `
  -StorageContainer "appwrite-backups"
```

For encrypted host backups, create `/srv/tantalum/backup.passphrase` on the VM or export `BACKUP_ENCRYPTION_PASSPHRASE` before running `backup.sh`.

Restore onto the same or a replacement VM:

```powershell
.\infra\azure\restore-to-vm.ps1 `
  -SshPrivateKeyPath "$HOME\.ssh\tantalum_azure_ed25519" `
  -BackupPath ".\backups\tantalum-appwrite-20260101T000000Z.tar.gz" `
  -Force
```

Test restore before depending on backups.

## 9. Health Checks

From your machine:

```powershell
ssh -i "$HOME\.ssh\tantalum_azure_ed25519" azureuser@<vm-public-ip> "/srv/tantalum/bin/healthcheck.sh https://api.yourdomain.com/v1"
```

Local app checks:

```powershell
npm run build:renderer
npm run smoke:agent-gateway
npm run smoke:secret-envelope
```

Manual workflows to verify:

- Sign up and sign in against the self-host project.
- Board list loads empty for the clean environment.
- Create/delete/rotate/provision/deploy board flows work with new boards.
- Firmware upload/history/delete works.
- Agent bootstrap loads once and managed/custom AI calls work.
- Board detection works or returns a clean unconfigured response.

## 10. Scale And Portability Plan

For the first 1000 registered users, keep this as one VM until monitoring shows real pressure. Most early projects are limited by active users, firmware file size, and AI provider cost rather than registered user count.

Scale sequence:

1. Resize VM with `.\infra\azure\resize-vm.ps1 -Size Standard_B4s_v2`.
2. Increase the attached data disk if storage grows.
3. Move large backups to Azure Blob or another S3-compatible store.
4. Split database/storage from the VM only after CPU/RAM/disk metrics prove it is needed.
5. Add a second Appwrite node and load balancer only after you have an external database/storage plan.

Portability rules:

- Keep Appwrite resource IDs stable in `appwrite.config.json`.
- Keep endpoint/project changes controlled through `npm run selfhost:set-target`.
- Keep provider API keys encrypted with KEKs, not raw values in tables.
- Keep backup archives downloadable outside Azure.
- Avoid Azure-only backend services in app code unless wrapped behind a local module.

Switching from Appwrite to Supabase later is possible, but it should be a planned adapter migration. The current repo already centralizes most Appwrite access through main/preload/renderer wrappers and functions; the next portability improvement would be to define a `BackendGateway` interface around auth, documents, storage, and function calls before adding a second provider.

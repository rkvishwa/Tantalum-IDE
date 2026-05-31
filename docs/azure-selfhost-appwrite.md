# Azure Self-Hosted Appwrite Runbook

This runbook is written for macOS Terminal/zsh. The repo's Azure helper scripts are PowerShell files, so on macOS run them with `pwsh`.

This setup keeps production on self-hosted Appwrite while using Azure only as the VM provider. The Appwrite stack, data, files, and backups live under `/srv/tantalum` so the same workload can be restored onto another Azure VM or a different cloud provider later.

## Target Shape

- Region: `southeastasia` by default for Asia latency.
- VM: `Standard_B2s_v2` by default for the MVP.
- Disk: 64 GB OS disk plus a 256 GB attached data disk mounted at `/srv/tantalum`.
- Network: SSH restricted to your current public IP or an explicit CIDR; ports 80 and 443 open.
- Backup: daily local archive timer plus managed-identity Azure Blob upload.
- Scale path: use one-command vertical resize modes first, then split storage/database, then move Appwrite behind a load balancer only after real usage proves it is needed.

The default VM is intentionally a single-node budget setup. It is not highly available. It is the right first commercial staging/early-production step when cost matters and you want portability.

## 1. Prerequisites

Install the local tools:

```bash
brew install azure-cli node
brew install --cask powershell
npm install -g appwrite-cli
```

If `pwsh` is still not found after installing PowerShell, reload Homebrew into the current zsh session:

```bash
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
command -v pwsh
pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion'
```

If `command -v pwsh` prints nothing, close and reopen Terminal. On some macOS installs the PowerShell cask is linked only after a new shell starts.

Sign in to Azure:

```bash
az login
az account show
```

If you have multiple subscriptions:

```bash
az account set --subscription "<subscription-id>"
```

Create or confirm an SSH key:

```bash
ssh-keygen -t ed25519 -f "$HOME/.ssh/tantalum_azure_ed25519"
```

You also need a DNS record for your Appwrite API host, for example `api.yourdomain.com`.

## 2. Create the VM

From the repo root:

```bash
pwsh ./infra/azure/deploy-appwrite-vm.ps1 \
  -SshPublicKeyPath "$HOME/.ssh/tantalum_azure_ed25519.pub" \
  -DataDiskSizeGb 256
```

The script auto-detects your current public IP and allows SSH only from that `/32`. If that fails, pass it explicitly:

```bash
pwsh ./infra/azure/deploy-appwrite-vm.ps1 \
  -SshPublicKeyPath "$HOME/.ssh/tantalum_azure_ed25519.pub" \
  -SshSourceCidr "203.0.113.10/32" \
  -DataDiskSizeGb 256
```

Use a larger data disk only when firmware/storage growth requires it:

```bash
pwsh ./infra/azure/deploy-appwrite-vm.ps1 -DataDiskSizeGb 512
```

After the script prints the public IP, point your DNS A record to it.

## 3. Point DNS

Create an `A` record:

```text
api.yourdomain.com -> <vm-public-ip>
```

Check DNS from macOS:

```bash
dig +short api.yourdomain.com
```

Continue only after the domain returns the VM public IP.

## 4. Upload Host Scripts And Start Installer

After DNS resolves to the VM:

```bash
pwsh ./infra/azure/configure-appwrite.ps1 \
  -SshPrivateKeyPath "$HOME/.ssh/tantalum_azure_ed25519" \
  -AppDomain "api.yourdomain.com" \
  -StartInstaller
```

Open the installer through an SSH tunnel:

```bash
ssh -i "$HOME/.ssh/tantalum_azure_ed25519" \
  -L 20080:127.0.0.1:20080 \
  azureuser@<vm-public-ip>
```

Then open `http://127.0.0.1:20080` and complete the Appwrite installer. Use the same domain, `api.yourdomain.com`, during setup.

The installer creates Appwrite's `docker-compose.yml` and `.env` under `/srv/tantalum/appwrite`.

## 5. Create Project And Push Schema

Create the Appwrite project in the self-hosted Console with project ID:

```text
tantalum
```

Then create an admin API key with database, storage, functions, users, and project scopes for setup scripts and CLI pushes.

Point the local Appwrite CLI at self-hosted Appwrite:

```bash
appwrite client --endpoint "https://api.yourdomain.com/v1"
appwrite client --project-id "tantalum"
appwrite login
```

Push the repo schema/functions from `appwrite.config.json`:

```bash
appwrite push tables
appwrite push buckets
appwrite push functions
```

If your Appwrite CLI version still uses the older database wording, use its equivalent database/collection push command. The repo manifest keeps the existing IDs, including database `697b8f660033fffde4be` and bucket `firmware_bucket`.

## 6. Point The App At Self-Hosted Appwrite

Update the repo target:

```bash
npm run selfhost:set-target -- --endpoint "https://api.yourdomain.com/v1" --project-id "tantalum"
```

This updates `appwrite.config.json`, the `device-gateway` public endpoint variable, and renderer env files that already exist.

## 7. Configure Function Secrets

Generate KEKs locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set these as Appwrite function variables/secrets where relevant:

- `TANTALUM_SECRET_KEK_V1` on `agent-settings`, `agent-gateway`, and `board-detection`.
- `TANTALUM_SECRET_ACTIVE_KEK_VERSION=v1` on the same functions.
- `TANTALUM_BOARD_SECRET_KEK_V1` on `board-admin`.
- `APPWRITE_DATABASE_ID=697b8f660033fffde4be` on all functions that use databases.
- Existing collection/bucket/function variables from `README.md`.
- `TANTALUM_APPWRITE_PUBLIC_ENDPOINT=https://api.yourdomain.com/v1` on `device-gateway`; this must be the public HTTPS Appwrite endpoint used by boards for OTA firmware downloads.
- MQTT variables only when MQTT is ready; HTTPS heartbeat fallback can run without MQTT.

Do not reuse old testing boards. Create fresh boards after the self-host cutover.

## 8. Seed Important Config Only

User history and old testing boards are not required. For a clean commercial test environment, seed only:

- `app_settings`: `agent.outputStyle` if you want non-default agent output policy.
- `agent_managed_key_pool`: one managed model provider key if the app should offer managed AI.
- `utility_ai_model_pool`: one or more small-task AI provider keys, tagged with `board-detection` when used for board AI detection.

Set environment variables in the current macOS shell. Example:

```bash
export APPWRITE_ENDPOINT="https://api.yourdomain.com/v1"
export APPWRITE_PROJECT_ID="tantalum"
export APPWRITE_DATABASE_ID="697b8f660033fffde4be"
export APPWRITE_API_KEY="<self-host-admin-api-key>"
export TANTALUM_SECRET_KEK_V1="<same-kek-set-on-functions>"

export AGENT_OUTPUT_STYLE="compact"
export TANTALUM_MANAGED_PROVIDER_LABEL="Azure AI Foundry"
export TANTALUM_MANAGED_BASE_URL="https://your-resource.openai.azure.com/openai/v1"
export TANTALUM_MANAGED_API_KEY="<provider-key>"
export TANTALUM_MANAGED_FAST_MODEL="gpt-4.1"
export TANTALUM_MANAGED_POWER_MODEL="gpt-5.5"

export TANTALUM_UTILITY_AI_BASE_URL="https://api.openai.com/v1"
export TANTALUM_UTILITY_AI_API_KEY="<provider-key>"
export TANTALUM_UTILITY_AI_MODEL="gpt-4.1-mini"
export TANTALUM_UTILITY_AI_TASK_TAGS="board-detection"
export TANTALUM_UTILITY_AI_PRIORITY="100"
```

Dry-run first:

```bash
npm run selfhost:seed
```

Apply:

```bash
npm run selfhost:seed -- --yes
```

The seed script never prints raw provider keys.

If you are upgrading an environment that already has `board_detection_model_config` rows, run `npm run migrate:api-key-envelopes` first as a dry-run and then `npm run migrate:api-key-envelopes -- --apply`. The migration copies those rows into `utility_ai_model_pool` and keeps the legacy table in place for manual cleanup after verification.

## 9. Backups

The VM installs a daily `tantalum-appwrite-backup.timer`. In the hardened production setup this timer runs `/srv/tantalum/bin/backup-upload-azure-blob.sh`, which creates a local archive and uploads it to Azure Blob with the VM's system-assigned managed identity. No storage account key or SAS token is stored on the VM.

For scheduled off-VM backups, enable the VM identity and grant it container-scoped Blob write access:

```bash
az vm identity assign \
  --resource-group rg-tantalum-appwrite-prod \
  --name vm-tantalum-appwrite-prod

principal_id="$(az vm show \
  --resource-group rg-tantalum-appwrite-prod \
  --name vm-tantalum-appwrite-prod \
  --query identity.principalId \
  --output tsv)"

container_scope="/subscriptions/<subscription-id>/resourceGroups/rg-tantalum-appwrite-prod/providers/Microsoft.Storage/storageAccounts/<storage-account>/blobServices/default/containers/appwrite-backups"

az role assignment create \
  --assignee "$principal_id" \
  --role "Storage Blob Data Contributor" \
  --scope "$container_scope"
```

Create `/etc/tantalum/backup-upload.env` on the VM:

```bash
AZURE_STORAGE_ACCOUNT=<storage-account>
AZURE_STORAGE_CONTAINER=appwrite-backups
AZURE_STORAGE_BLOB_PREFIX=scheduled
TANTALUM_BACKUP_STATE_DIR=/var/lib/tantalum/backup
```

Manual backup from your laptop:

```bash
pwsh ./infra/azure/backup-now.ps1 \
  -SshPrivateKeyPath "$HOME/.ssh/tantalum_azure_ed25519" \
  -DownloadPath "./backups"
```

Optional Azure Blob copy:

```bash
pwsh ./infra/azure/create-backup-storage.ps1
```

```bash
pwsh ./infra/azure/backup-now.ps1 \
  -SshPrivateKeyPath "$HOME/.ssh/tantalum_azure_ed25519" \
  -DownloadPath "./backups" \
  -StorageAccount "<storage-account>" \
  -StorageContainer "appwrite-backups"
```

For encrypted host backups, create `/srv/tantalum/backup.passphrase` on the VM or export `BACKUP_ENCRYPTION_PASSPHRASE` before running `backup.sh`.

Restore onto the same or a replacement VM:

```bash
pwsh ./infra/azure/restore-to-vm.ps1 \
  -SshPrivateKeyPath "$HOME/.ssh/tantalum_azure_ed25519" \
  -BackupPath "./backups/tantalum-appwrite-20260101T000000Z.tar.gz" \
  -Force
```

Test restore before depending on backups.

## 10. Production Hardening

Keep Docker and containerd runtime data on the data disk by bind-mounting the moved directories:

```text
/srv/tantalum/docker /var/lib/docker none bind,nofail,x-systemd.requires-mounts-for=/srv/tantalum 0 0
/srv/tantalum/containerd /var/lib/containerd none bind,nofail,x-systemd.requires-mounts-for=/srv/tantalum 0 0
```

After changing `/etc/fstab`, validate with:

```bash
df -h /srv/tantalum /var/lib/docker /var/lib/containerd
docker info --format 'DockerRootDir={{.DockerRootDir}}'
```

For MongoDB, do not publish the database on all interfaces. In `/srv/tantalum/appwrite/docker-compose.yml`, bind the host port to localhost only:

```yaml
ports:
  - "127.0.0.1:27017:27017"
```

The configure script installs `/srv/tantalum/bin/tantalum-monitor.sh` and a `tantalum-monitor.timer` that runs every 5 minutes. It logs stable syslog fields for disk, memory, container health, backup age, and the `agent-settings` function warm check. The warm check calls the public non-sensitive `/warm` function route, so production runtime warming does not depend on Appwrite's own function scheduler. The container check also covers the Appwrite function worker, execution worker, build worker, function scheduler, execution scheduler, message scheduler, and openruntimes executor containers, because those are the services that must be healthy for async and scheduled executions.

For production monitoring, create a least-privilege Appwrite API key that can create and read function executions, then add it to `/srv/tantalum/appwrite/tantalum.env`:

```bash
TANTALUM_MONITOR_APPWRITE_API_KEY=<execution-read-monitor-key>
TANTALUM_MONITOR_AGENT_SETTINGS_ASYNC_WARM_ENABLED=true
```

With that key present, the monitor also emits `agent_settings_async_warm`. This creates an async `/warm` execution and polls it until completion, which catches the failure class where sync function calls still work but Appwrite's async/scheduled execution path is broken.

Azure Monitor Agent can forward monitor entries to a Log Analytics workspace through a syslog Data Collection Rule. Scheduled-query alerts should notify the production action group when any monitor metric logs `status=fail`, especially `container_health`, `agent_settings_warm`, and `agent_settings_async_warm`. On Ubuntu, confirm rsyslog is forwarding to AMA after the DCR lands; if needed, link the generated AMA forwarding config from `/etc/opt/microsoft/azuremonitoragent/syslog/rsyslogconf/` into `/etc/rsyslog.d/` and restart `rsyslog`.

Verify the timer and warm metric on the VM:

```bash
systemctl status tantalum-monitor.timer --no-pager
sudo /srv/tantalum/bin/tantalum-monitor.sh
journalctl -t tantalum-monitor -n 50 --no-pager
```

Expected warm metric:

```text
metric=agent_settings_warm value=0 threshold=0 status=pass function=agent-settings
metric=agent_settings_async_warm value=0 threshold=0 status=pass function=agent-settings
```

The repo also includes `.github/workflows/agent-settings-warm.yml`, which calls the same `/warm` route every 5 minutes from GitHub Actions. Keep that workflow enabled as an off-VM fallback so `agent-settings` is still warmed and monitored if the VM timer or Appwrite's internal scheduler stops firing. Add the same least-privilege monitor key as the repository secret `APPWRITE_MONITOR_API_KEY` if you also want GitHub Actions to fail when the async execution path stops completing.

If `agent_settings_async_warm` fails, repair and verify the function runtime path on the VM:

```bash
sudo /srv/tantalum/bin/repair-functions-runtime.sh --restart --async
```

The repair script ensures the `appwrite-worker-executions` service exists, reconciles the function worker, execution worker, build worker, scheduler, and executor containers with Docker Compose, optionally restarts them, then verifies both sync and async `/warm` executions. It prints recent runtime logs and exits non-zero if Appwrite still cannot complete the async execution.

If SSH is blocked by NSG rules or your current public IP changed, run the same repair through Azure VM Run Command from the repo root:

```bash
pwsh ./infra/azure/repair-appwrite-functions.ps1
```

That command uploads the current repo copy of `repair-functions-runtime.sh` through the Azure VM agent and runs it with `--restart --async`, so it does not depend on port 22 being reachable from your laptop.

If the Azure CLI is signed into the wrong subscription, pass the production subscription explicitly:

```bash
pwsh ./infra/azure/repair-appwrite-functions.ps1 \
  -SubscriptionId "<production-subscription-id>" \
  -ResourceGroup "rg-tantalum-appwrite-prod" \
  -VmName "vm-tantalum-appwrite-prod"
```

## 11. Health Checks

From your Mac:

```bash
ssh -i "$HOME/.ssh/tantalum_azure_ed25519" \
  azureuser@<vm-public-ip> \
  "/srv/tantalum/bin/healthcheck.sh https://api.yourdomain.com/v1"
```

Local app checks:

```bash
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

## 12. Scale And Portability Plan

For the first 1000 registered users, keep this as one VM until monitoring shows real pressure. Most early projects are limited by active users, firmware file size, function load, and AI provider cost rather than registered user count.

Use always-on vertical scaling for the current single-node Appwrite deployment. Azure VM resize is simple, but it can restart the VM for a few minutes, so run it during a quiet maintenance window.

Cost-aware modes:

| Mode | Azure size | CPU / RAM | Estimated compute |
| --- | --- | --- | --- |
| Cost | `Standard_B2ls_v2` | 2 vCPU / 4 GB | about `$38.54/mo` |
| Baseline | `Standard_B2s_v2` | 2 vCPU / 8 GB | about `$77.38/mo` |
| Growth | `Standard_B4s_v2` | 4 vCPU / 16 GB | about `$154.03/mo` |
| Surge | `Standard_B8s_v2` | 8 vCPU / 32 GB | about `$308.06/mo` |

Do not use `B1ms` or `B2ts_v2` for Appwrite production. They are below the practical self-host floor of 2 CPU cores and 4 GB RAM.

Scale sequence:

1. Ask the advisor for a non-mutating recommendation:
   ```bash
   pwsh ./infra/azure/resize-vm.ps1 -Recommend
   ```
2. Dry-run the resize checks:
   ```bash
   pwsh ./infra/azure/resize-vm.ps1 -Mode Cost -PlanOnly
   ```
3. Resize in a maintenance window:
   ```bash
   pwsh ./infra/azure/resize-vm.ps1 -Mode Cost -Yes
   ```
4. Roll back or scale up with the same script:
   ```bash
   pwsh ./infra/azure/resize-vm.ps1 -Mode Baseline -Yes
   pwsh ./infra/azure/resize-vm.ps1 -Mode Growth -Yes
   ```
5. Increase the attached data disk if `/srv/tantalum` approaches 70%.
6. Split database/storage from the VM only after CPU/RAM/disk metrics prove it is needed.
7. Add a second Appwrite node and load balancer only after you have an external database/storage plan.

Operating rules:

1. Start on `Cost` while traffic is low and monitor rows stay green.
2. Move to `Baseline` if memory stays around 70-75%, functions feel slow, or container health alerts appear.
3. Move to `Growth` if average CPU stays above 60% or memory stays above 75% during real traffic.
4. Use `Surge` for sustained launch traffic or a temporary high-load event.
5. Treat disk separately; VM size changes do not increase the 256 GB data disk.

The resize script checks target-size availability, recent Blob backup age, Appwrite health, current DNS, and post-resize recovery. After Azure resizes the VM, it uses Azure VM Run Command to run `docker compose up -d` in `/srv/tantalum/appwrite`, so it does not depend on SSH access from your current IP. If the VM public IP ever changes, the script prints the exact DNS action for `api.metl.run`.

If Azure introduces a better size later, use `-Size <AzureVmSize>` as an explicit override. The script will still run the same safety checks, but the embedded monthly estimate is available only for the named modes.

Longer-term scale sequence:

1. Stay with one VM while the app is early and traffic is modest.
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

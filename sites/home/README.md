# Tantalum Web Portal

This folder is intentionally self-contained so it can be moved into its own Git repository and connected directly to the Appwrite Site named `home`.

## Move To Separate Repo

From the current IDE repo, copy the contents of `sites/home` into the root of the new website repository:

```powershell
Copy-Item -Recurse -Force .\sites\home\* D:\Documents\projects\web\tantalum-home
```

The new repository root should contain `app`, `components`, `lib`, `public`, `package.json`, `package-lock.json`, `next.config.mjs`, and this `README.md`.

## Local Development

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The portal uses public Appwrite browser SDK variables only. Do not add API keys or OAuth provider secrets to this website repository.

## Appwrite Site Git Hosting

Use the existing Appwrite Site:

- Site ID: `69c40c1e001f39d53e15`
- Public URL: `https://tantalum.knurdz.org`
- Framework: `nextjs`
- Runtime: `node-22`
- Adapter: `ssr`
- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `./.next`
- Provider root directory: `.`

After connecting the new Git repository to the Appwrite Site, run:

```bash
npm run appwrite:configure
```

This updates the Site build settings and upserts the public environment variables through the already logged-in Appwrite CLI. If the Site is already connected and you only need to refresh variables, run:

```bash
npm run appwrite:configure:vars
```

You can override defaults before running the script:

```bash
APPWRITE_SITE_PROVIDER_ROOT_DIRECTORY=. NEXT_PUBLIC_TANTALUM_WEB_APP_URL=https://tantalum.knurdz.org npm run appwrite:configure
```

On PowerShell:

```powershell
$env:APPWRITE_SITE_PROVIDER_ROOT_DIRECTORY = "."
$env:NEXT_PUBLIC_TANTALUM_WEB_APP_URL = "https://tantalum.knurdz.org"
npm run appwrite:configure
```

If you have the Appwrite VCS installation and repository IDs, connect the Site from the CLI:

```powershell
$env:APPWRITE_SITE_INSTALLATION_ID = "<installation-id>"
$env:APPWRITE_SITE_PROVIDER_REPOSITORY_ID = "<repository-id>"
$env:APPWRITE_SITE_PROVIDER_BRANCH = "main"
$env:APPWRITE_SITE_PROVIDER_ROOT_DIRECTORY = "."
npm run appwrite:configure
```

Find available installations and repositories with:

```powershell
appwrite vcs list-installations
appwrite vcs list-repositories --installation-id <installation-id> --type framework --search tantalum
```

If `list-installations` returns zero, authorize the Git provider for the Appwrite project first. The Appwrite CLI can list and use VCS installations, but the provider authorization handshake itself is browser-based.

## Required Site Variables

The defaults are listed in `.env.example`. Keep these values configured as Appwrite Site variables so Appwrite Git deployments build with the same public settings used locally.

OAuth provider credentials are not stored here. Configure Google and GitHub OAuth credentials on the Appwrite project through the Appwrite CLI when credentials are available.

## Custom Domain

The Appwrite proxy rule for `tantalum.knurdz.org` is created against the `home` Site. Add this DNS record at the DNS provider:

```text
tantalum.knurdz.org CNAME api.metl.run
```

After DNS has propagated, verify the rule from any Appwrite CLI login with project access:

```bash
appwrite proxy update-rule-status --rule-id 6a2f4f4ae589c5d91e97
appwrite proxy get-rule --rule-id 6a2f4f4ae589c5d91e97
```

The rule must show `status` as `verified` before the public URL is expected to work with TLS.

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const siteId = process.env.APPWRITE_SITE_ID || '69c40c1e001f39d53e15';
const providerRootDirectory = process.env.APPWRITE_SITE_PROVIDER_ROOT_DIRECTORY || '.';
const installationId = process.env.APPWRITE_SITE_INSTALLATION_ID || '';
const providerRepositoryId = process.env.APPWRITE_SITE_PROVIDER_REPOSITORY_ID || '';
const providerBranch = process.env.APPWRITE_SITE_PROVIDER_BRANCH || 'main';
const varsOnly = process.argv.includes('--vars-only');
function resolveAppwriteCommand() {
  if (process.env.APPWRITE_CLI_BIN) {
    return { command: process.env.APPWRITE_CLI_BIN, prefix: [] };
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    const cliBundle = join(process.env.APPDATA, 'npm', 'node_modules', 'appwrite-cli', 'dist', 'cli.cjs');
    if (existsSync(cliBundle)) {
      return { command: process.execPath, prefix: [cliBundle] };
    }
  }

  return { command: 'appwrite', prefix: [] };
}

const appwriteCommand = resolveAppwriteCommand();

const siteVariables = {
  NEXT_PUBLIC_APPWRITE_ENDPOINT: process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || 'https://api.metl.run/v1',
  NEXT_PUBLIC_APPWRITE_PROJECT_ID: process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || 'tantalum',
  NEXT_PUBLIC_APPWRITE_DATABASE_ID: process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || '697b8f660033fffde4be',
  NEXT_PUBLIC_APPWRITE_BOARDS_COLLECTION_ID: process.env.NEXT_PUBLIC_APPWRITE_BOARDS_COLLECTION_ID || 'boards',
  NEXT_PUBLIC_APPWRITE_FIRMWARE_COLLECTION_ID: process.env.NEXT_PUBLIC_APPWRITE_FIRMWARE_COLLECTION_ID || 'firmwares',
  NEXT_PUBLIC_APPWRITE_AGENT_SETTINGS_FUNCTION_ID: process.env.NEXT_PUBLIC_APPWRITE_AGENT_SETTINGS_FUNCTION_ID || 'agent-settings',
  NEXT_PUBLIC_APPWRITE_BOARD_ADMIN_FUNCTION_ID: process.env.NEXT_PUBLIC_APPWRITE_BOARD_ADMIN_FUNCTION_ID || 'board-admin',
  NEXT_PUBLIC_APPWRITE_DESKTOP_AUTH_FUNCTION_ID: process.env.NEXT_PUBLIC_APPWRITE_DESKTOP_AUTH_FUNCTION_ID || 'desktop-auth',
  NEXT_PUBLIC_APPWRITE_WEB_ADMIN_FUNCTION_ID: process.env.NEXT_PUBLIC_APPWRITE_WEB_ADMIN_FUNCTION_ID || 'web-admin',
  NEXT_PUBLIC_APPWRITE_SUPPORT_TICKETS_COLLECTION_ID: process.env.NEXT_PUBLIC_APPWRITE_SUPPORT_TICKETS_COLLECTION_ID || 'support_tickets',
  NEXT_PUBLIC_TANTALUM_DESKTOP_SCHEME: process.env.NEXT_PUBLIC_TANTALUM_DESKTOP_SCHEME || 'tantalum',
  NEXT_PUBLIC_TANTALUM_WEB_APP_URL: process.env.NEXT_PUBLIC_TANTALUM_WEB_APP_URL || 'https://tantalum.knurdz.org',
  NEXT_PUBLIC_TANTALUM_WINDOWS_DOWNLOAD_URL: process.env.NEXT_PUBLIC_TANTALUM_WINDOWS_DOWNLOAD_URL || '',
  NEXT_PUBLIC_TANTALUM_MACOS_DOWNLOAD_URL: process.env.NEXT_PUBLIC_TANTALUM_MACOS_DOWNLOAD_URL || '',
  NEXT_PUBLIC_TANTALUM_LINUX_DOWNLOAD_URL: process.env.NEXT_PUBLIC_TANTALUM_LINUX_DOWNLOAD_URL || '',
};

function run(args, { json = false } = {}) {
  const output = execFileSync(appwriteCommand.command, [...appwriteCommand.prefix, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return json ? JSON.parse(output) : output;
}

function variableIdFor(key) {
  return key.toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 36);
}

function updateSiteSettings() {
  const args = [
    'sites',
    'update',
    '--site-id',
    siteId,
    '--name',
    'home',
    '--framework',
    'nextjs',
    '--enabled',
    'true',
    '--logging',
    'true',
    '--timeout',
    '30',
    '--install-command',
    'npm install',
    '--build-command',
    'npm run build',
    '--output-directory',
    './.next',
    '--build-runtime',
    'node-22',
    '--adapter',
    'ssr',
    '--provider-root-directory',
    providerRootDirectory,
  ];

  if (installationId) {
    args.push('--installation-id', installationId);
  }
  if (providerRepositoryId) {
    args.push('--provider-repository-id', providerRepositoryId);
  }
  if (installationId || providerRepositoryId || process.env.APPWRITE_SITE_PROVIDER_BRANCH) {
    args.push('--provider-branch', providerBranch);
  }

  run(args);
}

function upsertVariables() {
  const existing = run(['sites', 'list-variables', '--site-id', siteId, '--json'], { json: true });
  const byKey = new Map((existing.variables || []).map((variable) => [variable.key, variable]));

  for (const [key, value] of Object.entries(siteVariables)) {
    const current = byKey.get(key);
    if (current) {
      const args = [
        'sites',
        'update-variable',
        '--site-id',
        siteId,
        '--variable-id',
        current.$id,
        '--key',
        key,
        '--value',
        value,
      ];
      if (current.secret !== true && current.secret !== '[hidden]') {
        args.push('--secret=false');
      }
      run(args);
    } else {
      run([
        'sites',
        'create-variable',
        '--site-id',
        siteId,
        '--variable-id',
        variableIdFor(key),
        '--key',
        key,
        '--value',
        value,
        '--secret=false',
      ]);
    }
  }
}

if (!varsOnly) {
  updateSiteSettings();
}
upsertVariables();

console.log(`Configured Appwrite site ${siteId} for repo root "${providerRootDirectory}".`);

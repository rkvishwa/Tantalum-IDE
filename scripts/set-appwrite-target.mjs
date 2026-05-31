#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const rawArgs = process.argv.slice(2);
const args = new Map();
let jsonOutput = false;

for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === '--json') {
    jsonOutput = true;
    continue;
  }
  if (arg === '--help' || arg === '-h') {
    console.log(`
Usage:
  node scripts/set-appwrite-target.mjs --endpoint https://api.example.com/v1 --project-id tantalum

Also accepts APPWRITE_ENDPOINT and APPWRITE_PROJECT_ID from the environment.
Updates appwrite.config.json, the device-gateway public endpoint variable, plus renderer env files that already exist.
`);
    process.exit(0);
  }
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    args.set(key, next);
    index += 1;
  }
}

const endpoint = String(args.get('endpoint') || process.env.APPWRITE_ENDPOINT || '').trim().replace(/\/+$/, '');
const projectId = String(args.get('project-id') || args.get('projectId') || process.env.APPWRITE_PROJECT_ID || '').trim();

if (!endpoint || !/^https?:\/\//.test(endpoint)) {
  throw new Error('A valid --endpoint or APPWRITE_ENDPOINT is required.');
}
if (!endpoint.endsWith('/v1')) {
  throw new Error('Endpoint must include /v1, for example https://api.example.com/v1.');
}
if (!projectId) {
  throw new Error('--project-id or APPWRITE_PROJECT_ID is required.');
}

const touched = [];
const configPath = path.join(projectRoot, 'appwrite.config.json');
const manifest = JSON.parse(await fs.readFile(configPath, 'utf8'));
manifest.endpoint = endpoint;
manifest.projectId = projectId;

function upsertFunctionVariable(config, functionId, key, value) {
  const functions = Array.isArray(config.functions) ? config.functions : [];
  const targetFunction = functions.find((entry) => entry?.$id === functionId || entry?.name === functionId);
  if (!targetFunction) {
    return false;
  }

  if (!Array.isArray(targetFunction.variables)) {
    targetFunction.variables = [];
  }

  const existing = targetFunction.variables.find((entry) => entry?.key === key);
  if (existing) {
    existing.value = value;
  } else {
    targetFunction.variables.push({ key, value });
  }

  return true;
}

upsertFunctionVariable(manifest, 'device-gateway', 'TANTALUM_APPWRITE_PUBLIC_ENDPOINT', endpoint);
await fs.writeFile(configPath, `${JSON.stringify(manifest, null, 4)}\n`);
touched.push(path.relative(projectRoot, configPath));

async function updateEnvFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const replacements = {
    VITE_APPWRITE_ENDPOINT: endpoint,
    VITE_APPWRITE_PROJECT_ID: projectId,
  };

  let updated = text;
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, `${key}=${value}`);
    } else {
      updated += `${updated.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
    }
  }

  if (updated !== text) {
    await fs.writeFile(filePath, updated);
    touched.push(path.relative(projectRoot, filePath));
  }
}

await updateEnvFile(path.join(projectRoot, 'renderer-react', '.env.example'));
await updateEnvFile(path.join(projectRoot, 'renderer-react', '.env'));
await updateEnvFile(path.join(projectRoot, 'renderer-react', '.env.local'));

const result = { endpoint, projectId, touched };
if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Appwrite target set to ${endpoint} (${projectId}).`);
  for (const file of touched) {
    console.log(`- updated ${file}`);
  }
}

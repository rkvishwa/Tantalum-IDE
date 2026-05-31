function trimEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function normalizeHttpsAppwriteEndpoint(value, label) {
  const endpoint = trimEndpoint(value);
  if (!endpoint) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${label} must be a valid HTTPS Appwrite endpoint ending in /v1.`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must be a valid HTTPS Appwrite endpoint ending in /v1.`);
  }

  if (!parsed.pathname.endsWith('/v1')) {
    throw new Error(`${label} must end in /v1.`);
  }

  return endpoint;
}

export function resolveOtaDownloadEndpoint(env = process.env) {
  const publicEndpoint = trimEndpoint(env.TANTALUM_APPWRITE_PUBLIC_ENDPOINT);
  if (publicEndpoint) {
    return normalizeHttpsAppwriteEndpoint(publicEndpoint, 'TANTALUM_APPWRITE_PUBLIC_ENDPOINT');
  }

  const functionEndpoint = trimEndpoint(env.APPWRITE_FUNCTION_API_ENDPOINT);
  if (functionEndpoint.startsWith('https://')) {
    return normalizeHttpsAppwriteEndpoint(functionEndpoint, 'APPWRITE_FUNCTION_API_ENDPOINT');
  }

  throw new Error('OTA firmware downloads require TANTALUM_APPWRITE_PUBLIC_ENDPOINT to be set to a public HTTPS Appwrite endpoint.');
}

export function buildDownloadUrl(fileId, env = process.env) {
  const endpoint = resolveOtaDownloadEndpoint(env);
  const bucketId = String(env.APPWRITE_FIRMWARE_BUCKET_ID || '').trim();
  const projectId = String(env.APPWRITE_FUNCTION_PROJECT_ID || '').trim();

  if (!bucketId || !projectId) {
    throw new Error('OTA firmware downloads require APPWRITE_FIRMWARE_BUCKET_ID and APPWRITE_FUNCTION_PROJECT_ID.');
  }

  return `${endpoint}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(String(fileId || ''))}/download?project=${encodeURIComponent(projectId)}`;
}

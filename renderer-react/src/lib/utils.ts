export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function semverCompare(left: string, right: string) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

export function nextSemver(version: string) {
  const [major = 1, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

const BOARD_ONLINE_GRACE_MS = 150 * 1000;
const BOARD_FUTURE_CLOCK_SKEW_MS = 30 * 1000;

export function calculateBoardStatus(lastSeen: string | null | undefined, persistedStatus: string) {
  const normalizedStatus = String(persistedStatus || '').trim().toLowerCase();
  if (normalizedStatus === 'pending') {
    return 'pending';
  }

  if (!lastSeen) {
    return 'offline';
  }

  const lastSeenAt = new Date(lastSeen).getTime();
  if (!Number.isFinite(lastSeenAt)) {
    return 'offline';
  }

  const ageMs = Date.now() - lastSeenAt;
  if (ageMs < -BOARD_FUTURE_CLOCK_SKEW_MS) {
    return 'offline';
  }

  return ageMs <= BOARD_ONLINE_GRACE_MS ? 'online' : 'offline';
}

export function fileNameFromPath(filePath: string) {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export function parentPath(filePath: string) {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
}

export function joinPath(basePath: string, name: string) {
  const separator = basePath.includes('\\') ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${name.replace(/^[\\/]+/, '')}`;
}

export function normalizeOutput(output: string) {
  return output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function safeJsonParse<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function sha256Hex(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return digestToHex(digest);
}

function digestToHex(digest: ArrayBuffer) {
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function sha256HexBytes(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer) {
  const input = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return digestToHex(digest);
}

export async function sha256HexBase64(base64: string) {
  return sha256HexBytes(base64ToUint8Array(base64));
}

export function generateToken(prefix = 'board') {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${token}`;
}

export function isFirmwareFileName(value: string) {
  return /\.(ino|pde|cpp|c|h|hpp)$/i.test(value);
}

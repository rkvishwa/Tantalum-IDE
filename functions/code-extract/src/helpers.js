const CODE_EXTRACT_TASK_TAG = 'code-extract';
const MAX_PROMPT_BYTES = 48000;
const MAX_STRINGS = 220;
const MAX_STRING_CHARS = 18000;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024;

export function normalizeText(value, maxLength = 512) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeTaskTags(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry, 64).toLowerCase()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((entry) => normalizeText(entry, 64).toLowerCase())
      .filter(Boolean);
  }

  return [];
}

export function supportsCodeExtract(config) {
  const taskTags = normalizeTaskTags(config.taskTags);
  return taskTags.length === 0 || taskTags.includes(CODE_EXTRACT_TASK_TAG);
}

function sanitizeRelativePath(value, fallback = 'reconstructed/sketch.ino') {
  const raw = normalizeText(value, 512).replace(/\\/g, '/');
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== '.' && part !== '..')
    .map((part) => part.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file');
  return parts.join('/') || fallback;
}

export function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeStrings(strings) {
  const normalized = [];
  let totalChars = 0;
  for (const value of Array.isArray(strings) ? strings : []) {
    const text = normalizeText(value, 300);
    if (!text) {
      continue;
    }
    totalChars += text.length + 1;
    if (totalChars > MAX_STRING_CHARS) {
      break;
    }
    normalized.push(text);
    if (normalized.length >= MAX_STRINGS) {
      break;
    }
  }
  return normalized;
}

export function buildPrompt(payload) {
  const input = {
    board: payload.board || null,
    localBoard: payload.localBoard || null,
    firmware: payload.firmware || null,
    metadata: payload.metadata || null,
    strings: normalizeStrings(payload.strings),
    notes: normalizeText(payload.notes, 2000),
  };
  const prompt = [
    'Reconstruct a small Arduino/C++ project from compiled firmware evidence.',
    'The original source is usually unrecoverable; produce a best-effort approximation only.',
    'Return strict JSON only with keys: files, confidence, notes, limitations.',
    'files must be an array of { "path": "relative/path", "content": "text" }.',
    'Include a README.md explaining that this is reconstructed, and include at least one .ino or .cpp file when there is enough evidence.',
    'Do not claim exact recovery unless the provided metadata says sourceSnapshot is true.',
    JSON.stringify(input),
  ].join('\n');

  if (Buffer.byteLength(prompt, 'utf8') <= MAX_PROMPT_BYTES) {
    return prompt;
  }

  const reduced = {
    ...input,
    strings: input.strings.slice(0, 80),
  };
  return [
    'Reconstruct a small Arduino/C++ project from compiled firmware evidence. Return strict JSON only with keys files, confidence, notes, limitations.',
    JSON.stringify(reduced),
  ].join('\n').slice(0, MAX_PROMPT_BYTES);
}

export function parseModelJson(rawText, model) {
  const text = normalizeText(rawText, 2 * 1024 * 1024);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/)?.[0] || text);

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('Model did not return valid JSON.');
  }

  let totalBytes = 0;
  const files = [];
  for (const file of Array.isArray(parsed.files) ? parsed.files : []) {
    const relativePath = sanitizeRelativePath(file?.path || file?.name, files.length === 0 ? 'README.md' : `reconstructed/file-${files.length + 1}.txt`);
    const content = String(file?.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (!content || bytes > MAX_FILE_BYTES || totalBytes + bytes > MAX_TOTAL_FILE_BYTES) {
      continue;
    }
    totalBytes += bytes;
    files.push({ path: relativePath, content });
    if (files.length >= MAX_FILES) {
      break;
    }
  }

  return {
    files,
    confidence: clampConfidence(parsed.confidence),
    notes: normalizeText(parsed.notes, 4000),
    limitations: normalizeText(parsed.limitations, 4000),
    model,
  };
}

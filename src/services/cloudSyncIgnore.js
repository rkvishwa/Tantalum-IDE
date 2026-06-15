const path = require("node:path");

const CORE_DIRECTORY_SEGMENTS = new Set([
  ".git",
  ".tantalum",
  ".env",
]);

const CORE_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "application_default_credentials.json",
  "azureProfile.json",
  "accessTokens.json",
  "kubeconfig",
]);

const CORE_PATHS = new Set([
  ".aws/credentials",
  ".aws/config",
  ".azure/azureProfile.json",
  ".azure/accessTokens.json",
  ".config/gcloud/application_default_credentials.json",
  ".kube/config",
]);

const CORE_FILE_GLOBS = [
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.ppk",
  "*service-account*.json",
  "*firebase-adminsdk*.json",
  "google-credentials*.json",
];

const DEFAULT_DIRECTORY_SEGMENTS = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vite",
  ".turbo",
  ".parcel-cache",
  "bower_components",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "site-packages",
  "vendor",
  "target",
  "build",
  ".gradle",
  "bin",
  "obj",
  ".vs",
  ".bundle",
  ".dart_tool",
  "DerivedData",
  "Pods",
  "captures",
  "dist",
  "out",
  "coverage",
  ".coverage",
  ".cache",
  "tmp",
  "temp",
  "logs",
]);

const DEFAULT_PATHS = new Set([
  ".mvn/wrapper/dists",
  "vendor/bundle",
  ".idea/workspace.xml",
  ".vscode/.browse.VC.db",
]);

const DEFAULT_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

const DEFAULT_FILE_GLOBS = [
  "*.log",
];

function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function pathSegments(relativePath) {
  return normalizeRelativePath(relativePath).split("/").filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern, { anchored = false, directory = false } = {}) {
  const normalized = normalizeRelativePath(pattern.replace(/^\/+/, "").replace(/\/+$/, ""));
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }

  if (directory) {
    source = `${source}(?:/.*)?`;
  }

  if (anchored || normalized.includes("/")) {
    return new RegExp(`^${source}$`, "i");
  }

  return new RegExp(`(?:^|/)${source}$`, "i");
}

function globMatches(relativePath, pattern, options = {}) {
  if (!pattern) {
    return false;
  }
  return globToRegExp(pattern, options).test(normalizeRelativePath(relativePath));
}

function pathSetMatches(relativePath, pathSet) {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  for (const entry of pathSet) {
    const candidate = normalizeRelativePath(entry).toLowerCase();
    if (normalized === candidate || normalized.startsWith(`${candidate}/`)) {
      return entry;
    }
  }
  return "";
}

function matchCoreRule(relativePath, isDirectory = false) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = pathSegments(normalized);
  const basename = segments.at(-1) || "";

  for (const segment of segments) {
    if (CORE_DIRECTORY_SEGMENTS.has(segment)) {
      return { rule: `${segment}/`, category: "core-directory" };
    }
  }

  const corePath = pathSetMatches(normalized, CORE_PATHS);
  if (corePath) {
    return { rule: corePath, category: "core-path" };
  }

  if (!isDirectory && CORE_FILE_NAMES.has(basename)) {
    return { rule: basename, category: "core-file" };
  }

  if (!isDirectory) {
    const glob = CORE_FILE_GLOBS.find((pattern) => globMatches(basename, pattern));
    if (glob) {
      return { rule: glob, category: "core-file-glob" };
    }
  }

  return null;
}

function matchDefaultRule(relativePath, isDirectory = false) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = pathSegments(normalized);
  const basename = segments.at(-1) || "";

  for (const segment of segments) {
    if (DEFAULT_DIRECTORY_SEGMENTS.has(segment)) {
      return { rule: `${segment}/`, category: "default-directory" };
    }
  }

  const defaultPath = pathSetMatches(normalized, DEFAULT_PATHS);
  if (defaultPath) {
    return { rule: defaultPath, category: "default-path" };
  }

  if (!isDirectory && DEFAULT_FILE_NAMES.has(basename)) {
    return { rule: basename, category: "default-file" };
  }

  if (!isDirectory) {
    const glob = DEFAULT_FILE_GLOBS.find((pattern) => globMatches(basename, pattern));
    if (glob) {
      return { rule: glob, category: "default-file-glob" };
    }
  }

  return null;
}

function parseTantalumIgnore(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => !line.startsWith("!"))
    .map((line) => ({
      raw: line,
      anchored: line.startsWith("/"),
      directory: line.endsWith("/"),
      pattern: normalizeRelativePath(line),
    }))
    .filter((entry) => entry.pattern);
}

function matchUserRule(relativePath, isDirectory, userRules = []) {
  const normalized = normalizeRelativePath(relativePath);
  for (const rule of userRules) {
    if (rule.directory && !isDirectory) {
      const directoryPattern = normalizeRelativePath(rule.pattern.replace(/\/+$/, ""));
      if (globMatches(path.dirname(normalized), directoryPattern, rule)) {
        return { rule: rule.raw, category: "user-ignore" };
      }
    }
    if (globMatches(normalized, rule.pattern, rule)) {
      return { rule: rule.raw, category: "user-ignore" };
    }
  }
  return null;
}

function shouldExcludePath(relativePath, options = {}) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return { excluded: false };
  }

  const isDirectory = Boolean(options.isDirectory);
  const userRules = Array.isArray(options.userRules) ? options.userRules : [];
  const core = matchCoreRule(normalized, isDirectory);
  if (core) {
    return { excluded: true, core: true, ...core };
  }

  const defaults = matchDefaultRule(normalized, isDirectory);
  if (defaults) {
    return { excluded: true, core: false, ...defaults };
  }

  const user = matchUserRule(normalized, isDirectory, userRules);
  if (user) {
    return { excluded: true, core: false, ...user };
  }

  return { excluded: false };
}

module.exports = {
  CORE_DIRECTORY_SEGMENTS,
  CORE_FILE_GLOBS,
  CORE_FILE_NAMES,
  CORE_PATHS,
  DEFAULT_DIRECTORY_SEGMENTS,
  DEFAULT_FILE_GLOBS,
  DEFAULT_FILE_NAMES,
  DEFAULT_PATHS,
  normalizeRelativePath,
  parseTantalumIgnore,
  shouldExcludePath,
};

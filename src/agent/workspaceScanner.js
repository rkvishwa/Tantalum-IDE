const fsPromises = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_IGNORED_NAMES = new Set([
  ".DS_Store",
  ".git",
  ".next",
  ".turbo",
  ".yarn",
  "build",
  "dist",
  "node_modules",
  "out",
]);

function isPathInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.isDirectory() && !right.isDirectory()) {
      return -1;
    }

    if (!left.isDirectory() && right.isDirectory()) {
      return 1;
    }

    return left.name.localeCompare(right.name);
  });
}

class WorkspaceScanner {
  constructor(options = {}) {
    this.cache = new Map();
    this.revision = 0;
    this.maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 1600;
    this.maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 12;
    this.ignoredNames = new Set([
      ...DEFAULT_IGNORED_NAMES,
      ...(Array.isArray(options.ignoredNames) ? options.ignoredNames : []),
    ]);
  }

  getRevision() {
    return this.revision;
  }

  markDirty() {
    this.revision += 1;
    this.cache.clear();
    return this.revision;
  }

  async scan(rootPath, relativePath = ".") {
    if (!rootPath) {
      return {
        rootPath: null,
        targetPath: null,
        relativePath: ".",
        revision: this.revision,
        tree: "No Project Space is open.",
        totalEntries: 0,
        truncated: false,
      };
    }

    const absoluteRootPath = path.resolve(rootPath);
    const normalizedRelativePath = typeof relativePath === "string" && relativePath.trim().length > 0 ? relativePath.trim() : ".";
    const absoluteTargetPath = path.resolve(absoluteRootPath, normalizedRelativePath);

    if (!isPathInsideRoot(absoluteTargetPath, absoluteRootPath)) {
      throw new Error("The requested path is outside the active Project Space.");
    }

    const cacheKey = `${absoluteRootPath}:${absoluteTargetPath}:${this.revision}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const stats = await fsPromises.stat(absoluteTargetPath);
    const lines = [];
    const state = {
      totalEntries: 0,
      truncated: false,
    };

    const displayRootName = absoluteTargetPath === absoluteRootPath ? path.basename(absoluteRootPath) || absoluteRootPath : path.relative(absoluteRootPath, absoluteTargetPath);
    lines.push(`${displayRootName}${stats.isDirectory() ? "/" : ""}`);

    if (stats.isDirectory()) {
      await this.#walkDirectory(absoluteRootPath, absoluteTargetPath, lines, "", 0, state);
    }

    const result = {
      rootPath: absoluteRootPath,
      targetPath: absoluteTargetPath,
      relativePath: absoluteTargetPath === absoluteRootPath ? "." : path.relative(absoluteRootPath, absoluteTargetPath),
      revision: this.revision,
      tree: lines.join("\n"),
      totalEntries: state.totalEntries,
      truncated: state.truncated,
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  async #walkDirectory(rootPath, currentPath, lines, prefix, depth, state) {
    if (state.truncated || depth >= this.maxDepth) {
      if (!state.truncated) {
        lines.push(`${prefix}└─ ...`);
        state.truncated = true;
      }
      return;
    }

    const entries = sortEntries(
      (await fsPromises.readdir(currentPath, { withFileTypes: true })).filter((entry) => !this.ignoredNames.has(entry.name)),
    );

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const entryPath = path.join(currentPath, entry.name);
      const connector = index === entries.length - 1 ? "└─ " : "├─ ";
      const nextPrefix = `${prefix}${index === entries.length - 1 ? "   " : "│  "}`;
      const suffix = entry.isDirectory() ? "/" : "";

      lines.push(`${prefix}${connector}${entry.name}${suffix}`);
      state.totalEntries += 1;

      if (state.totalEntries >= this.maxEntries) {
        lines.push(`${nextPrefix}...`);
        state.truncated = true;
        return;
      }

      if (entry.isDirectory() && isPathInsideRoot(entryPath, rootPath)) {
        await this.#walkDirectory(rootPath, entryPath, lines, nextPrefix, depth + 1, state);

        if (state.truncated) {
          return;
        }
      }
    }
  }
}

module.exports = {
  WorkspaceScanner,
  isPathInsideRoot,
};

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function resolveWorkspacePath(workspaceRoot, targetPath) {
  if (!workspaceRoot) {
    throw new Error("Open a Project Space folder before using the AI agent.");
  }

  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error("A non-empty path inside the Project Space is required.");
  }

  const absoluteRoot = path.resolve(workspaceRoot);
  const absoluteTarget = path.resolve(absoluteRoot, targetPath);
  const relativePath = path.relative(absoluteRoot, absoluteTarget);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("The requested path is outside the active Project Space.");
  }

  return absoluteTarget;
}

function parseSearchReplaceBlocks(diffText) {
  if (typeof diffText !== "string" || diffText.trim().length === 0) {
    throw new Error("The diff payload is empty.");
  }

  const normalized = diffText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  const matches = [...normalized.matchAll(blockPattern)];

  if (matches.length === 0) {
    throw new Error(
      "The diff payload must use SEARCH/REPLACE blocks like <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE.",
    );
  }

  return matches.map((match) => ({
    search: match[1],
    replace: match[2],
  }));
}

function applySearchReplaceDiff(originalContent, diffText) {
  let nextContent = String(originalContent ?? "");
  const blocks = parseSearchReplaceBlocks(diffText);

  blocks.forEach((block, index) => {
    if (block.search.length === 0) {
      throw new Error(`Diff block ${index + 1} has an empty SEARCH section.`);
    }

    const firstIndex = nextContent.indexOf(block.search);
    if (firstIndex === -1) {
      throw new Error(`Diff block ${index + 1} could not find its SEARCH text in the file.`);
    }

    const secondIndex = nextContent.indexOf(block.search, firstIndex + block.search.length);
    if (secondIndex !== -1) {
      throw new Error(
        `Diff block ${index + 1} matches more than once. Use a more specific SEARCH block or rewrite the file.`,
      );
    }

    nextContent = nextContent.replace(block.search, block.replace);
  });

  return nextContent;
}

function summarizeFileChange(originalContent, nextContent) {
  const beforeLines = String(originalContent ?? "").split("\n");
  const afterLines = String(nextContent ?? "").split("\n");
  const maxLength = Math.max(beforeLines.length, afterLines.length);

  let changedLines = 0;
  for (let index = 0; index < maxLength; index += 1) {
    if ((beforeLines[index] ?? "") !== (afterLines[index] ?? "")) {
      changedLines += 1;
    }
  }

  return {
    changedLines,
    beforeLength: beforeLines.length,
    afterLength: afterLines.length,
  };
}

async function readUtf8IfPresent(filePath) {
  try {
    return await fsPromises.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function runWorkspaceCommand(command, workspaceRoot, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("A shell command is required.");
  }

  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 120000;
  const cwd = path.resolve(workspaceRoot);

  return await new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, windowsHide: true })
        : spawn(process.env.SHELL || "/bin/zsh", ["-lc", command], { cwd });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`The command timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : -1,
        signal: signal ?? null,
        stdout,
        stderr,
        output: [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : ""),
      });
    });
  });
}

function buildCommandPreview(command, workspaceRoot) {
  return {
    command,
    cwd: workspaceRoot,
    shell: process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "/bin/zsh",
    platform: os.platform(),
  };
}

module.exports = {
  applySearchReplaceDiff,
  buildCommandPreview,
  readUtf8IfPresent,
  resolveWorkspacePath,
  runWorkspaceCommand,
  summarizeFileChange,
};

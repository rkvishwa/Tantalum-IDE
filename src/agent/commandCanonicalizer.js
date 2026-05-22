const COMMAND_VERBS = [
  "add",
  "apply",
  "build",
  "change",
  "convert",
  "create",
  "delete",
  "edit",
  "fix",
  "implement",
  "install",
  "make",
  "modify",
  "move",
  "patch",
  "refactor",
  "remove",
  "rename",
  "replace",
  "rewrite",
  "scaffold",
  "update",
  "write",
];

const SHORT_COMMAND_ALIASES = new Map([
  ["creat", "create"],
  ["delet", "delete"],
  ["delte", "delete"],
  ["mov", "move"],
]);

const COMMAND_BOUNDARY_WORDS = new Set(["and", "then", "also"]);
const POLITE_PREFIX_WORDS = new Set(["can", "could", "kindly", "please", "pls", "u", "you"]);

function normalizeCommandToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function damerauLevenshteinDistance(left, right) {
  const a = normalizeCommandToken(left);
  const b = normalizeCommandToken(right);
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

  for (let index = 0; index <= a.length; index += 1) {
    dp[index][0] = index;
  }
  for (let index = 0; index <= b.length; index += 1) {
    dp[0][index] = index;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }

  return dp[a.length][b.length];
}

function canonicalCommandVerb(value) {
  const token = normalizeCommandToken(value);
  if (!token) {
    return "";
  }
  if (COMMAND_VERBS.includes(token)) {
    return token;
  }
  if (SHORT_COMMAND_ALIASES.has(token)) {
    return SHORT_COMMAND_ALIASES.get(token);
  }

  let best = null;
  for (const command of COMMAND_VERBS) {
    const distance = damerauLevenshteinDistance(token, command);
    const limit = command.length <= 4 ? 1 : 2;
    if (distance > limit) {
      continue;
    }
    if (!best || distance < best.distance || (distance === best.distance && command.length < best.command.length)) {
      best = { command, distance };
    }
  }

  return best?.command || "";
}

function isCommandPosition(words, index) {
  if (index === 0) {
    return true;
  }

  if (/[.!?\n;:]/.test(words[index].leadingText || "")) {
    return true;
  }

  let current = index - 1;
  while (current >= 0 && POLITE_PREFIX_WORDS.has(words[current].normalized)) {
    current -= 1;
  }

  if (current < 0) {
    return true;
  }

  return COMMAND_BOUNDARY_WORDS.has(words[current].normalized);
}

function canonicalizeCommandVerbsInText(value) {
  const text = String(value || "");
  const rawWords = [...text.matchAll(/[A-Za-z]+/g)];
  const words = rawWords.map((match, index) => {
    const start = match.index || 0;
    const previous = rawWords[index - 1];
    const previousEnd = previous ? (previous.index || 0) + previous[0].length : 0;
    return {
      value: match[0],
      normalized: normalizeCommandToken(match[0]),
      index: start,
      leadingText: text.slice(previousEnd, start),
    };
  });

  if (words.length === 0) {
    return text;
  }

  const replacements = [];
  for (let index = 0; index < words.length; index += 1) {
    if (!isCommandPosition(words, index)) {
      continue;
    }

    const canonical = canonicalCommandVerb(words[index].value);
    if (!canonical || canonical === words[index].normalized) {
      continue;
    }

    replacements.push({
      start: words[index].index,
      end: words[index].index + words[index].value.length,
      value: canonical,
    });
  }

  if (replacements.length === 0) {
    return text;
  }

  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += text.slice(cursor, replacement.start);
    output += replacement.value;
    cursor = replacement.end;
  }
  output += text.slice(cursor);
  return output;
}

module.exports = {
  canonicalCommandVerb,
  canonicalizeCommandVerbsInText,
};

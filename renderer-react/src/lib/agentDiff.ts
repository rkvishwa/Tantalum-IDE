import type { AgentChangePreview } from '@/types/electron';

export type AgentDiffRow = {
  kind: 'context' | 'add' | 'delete' | 'omitted';
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

const MAX_LCS_DIFF_CELLS = 60000;
const MAX_DIFF_ROWS = 900;

function splitDiffLines(value: string) {
  if (value.length === 0) {
    return [];
  }

  const lines = value.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') {
    return lines.slice(0, -1);
  }

  return lines;
}

function buildPrefixSuffixRows(before: string[], after: string[]): AgentDiffRow[] {
  let prefixLength = 0;
  while (prefixLength < before.length && prefixLength < after.length && before[prefixLength] === after[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength + prefixLength < before.length &&
    suffixLength + prefixLength < after.length &&
    before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const rows: AgentDiffRow[] = [];
  for (let index = 0; index < prefixLength; index += 1) {
    rows.push({ kind: 'context', oldLine: index + 1, newLine: index + 1, text: before[index] });
  }

  for (let index = prefixLength; index < before.length - suffixLength; index += 1) {
    rows.push({ kind: 'delete', oldLine: index + 1, newLine: null, text: before[index] });
  }

  for (let index = prefixLength; index < after.length - suffixLength; index += 1) {
    rows.push({ kind: 'add', oldLine: null, newLine: index + 1, text: after[index] });
  }

  for (let index = before.length - suffixLength; index < before.length; index += 1) {
    rows.push({
      kind: 'context',
      oldLine: index + 1,
      newLine: after.length - suffixLength + (index - (before.length - suffixLength)) + 1,
      text: before[index],
    });
  }

  return rows;
}

function buildLcsRows(before: string[], after: string[]): AgentDiffRow[] {
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));

  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? table[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }

  const rows: AgentDiffRow[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      rows.push({ kind: 'context', oldLine: beforeIndex + 1, newLine: afterIndex + 1, text: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (table[beforeIndex + 1][afterIndex] >= table[beforeIndex][afterIndex + 1]) {
      rows.push({ kind: 'delete', oldLine: beforeIndex + 1, newLine: null, text: before[beforeIndex] });
      beforeIndex += 1;
    } else {
      rows.push({ kind: 'add', oldLine: null, newLine: afterIndex + 1, text: after[afterIndex] });
      afterIndex += 1;
    }
  }

  while (beforeIndex < before.length) {
    rows.push({ kind: 'delete', oldLine: beforeIndex + 1, newLine: null, text: before[beforeIndex] });
    beforeIndex += 1;
  }

  while (afterIndex < after.length) {
    rows.push({ kind: 'add', oldLine: null, newLine: afterIndex + 1, text: after[afterIndex] });
    afterIndex += 1;
  }

  return rows;
}

function compactRows(rows: AgentDiffRow[]) {
  if (rows.length <= MAX_DIFF_ROWS) {
    return rows;
  }

  const headCount = Math.floor(MAX_DIFF_ROWS / 2);
  const tailCount = MAX_DIFF_ROWS - headCount - 1;
  return [
    ...rows.slice(0, headCount),
    { kind: 'omitted', oldLine: null, newLine: null, text: `${rows.length - headCount - tailCount} diff lines hidden` } satisfies AgentDiffRow,
    ...rows.slice(-tailCount),
  ];
}

export function buildAgentDiffRows(file: AgentChangePreview) {
  const before = splitDiffLines(file.originalContent);
  const after = splitDiffLines(file.nextContent);
  const rows = before.length * after.length <= MAX_LCS_DIFF_CELLS ? buildLcsRows(before, after) : buildPrefixSuffixRows(before, after);
  return compactRows(rows);
}

export function previewContentForAgentChange(file: AgentChangePreview) {
  return file.changeType === 'delete' ? file.originalContent : file.nextContent;
}

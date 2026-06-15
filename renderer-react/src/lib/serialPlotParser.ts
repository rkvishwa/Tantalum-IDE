export function parsePlotLine(line: string): number[] | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/[,\t]+/);
  const values = parts.map((part) => Number(part.trim()));
  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return values;
}

export class SerialPlotLineBuffer {
  private pending = '';

  append(chunk: string): string[] {
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.pending += normalized;

    const lines: string[] = [];
    let newlineIndex = this.pending.indexOf('\n');

    while (newlineIndex !== -1) {
      lines.push(this.pending.slice(0, newlineIndex));
      this.pending = this.pending.slice(newlineIndex + 1);
      newlineIndex = this.pending.indexOf('\n');
    }

    return lines;
  }

  clear() {
    this.pending = '';
  }
}

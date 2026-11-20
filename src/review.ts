import { diffLines } from "diff";

export interface Hunk {
  start: number;
  end: number;
  replacement: string;
}

// Offsets refer to the immutable original, including its line endings.
export function reviewHunks(original: string, proposed: string): Hunk[] {
  const eol = original.match(/\r?\n/)?.[0];
  const target = eol ? proposed.replace(/\r?\n/g, eol) : proposed;
  const hunks: Hunk[] = [];
  let offset = 0;
  let pending: Hunk | undefined;
  for (const change of diffLines(original, target)) {
    if (!change.added && !change.removed) {
      pending = undefined;
      offset += change.value.length;
      continue;
    }
    if (!pending) {
      pending = { start: offset, end: offset, replacement: "" };
      hunks.push(pending);
    }
    if (change.removed) {
      offset += change.value.length;
      pending.end = offset;
    } else {
      pending.replacement += change.value;
    }
  }
  return hunks;
}

export function previewAccepted(original: string, accepted: readonly Hunk[]): string {
  let text = original;
  for (const hunk of [...accepted].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, hunk.start) + hunk.replacement + text.slice(hunk.end);
  }
  return text;
}

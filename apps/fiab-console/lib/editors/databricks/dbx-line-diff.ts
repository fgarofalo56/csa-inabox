/**
 * Minimal LCS line diff for the notebook version side-by-side (R4-DBX-3).
 *
 * Pure + dependency-free (matches the repo's no-CDN constraint). Produces an
 * ordered list of rows tagged `equal | added | removed` so the versions dialog
 * can render a two-color side-by-side diff of two notebook SOURCE snapshots.
 */

export type LineOp = 'equal' | 'added' | 'removed';

export interface DiffLine {
  op: LineOp;
  /** 1-based line number in the OLD text (undefined for added lines). */
  oldNo?: number;
  /** 1-based line number in the NEW text (undefined for removed lines). */
  newNo?: number;
  text: string;
}

/**
 * Diff two texts line-by-line. Classic LCS backtrace — O(n*m) which is fine for
 * notebook-sized inputs (hundreds of lines).
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'equal', oldNo: i + 1, newNo: j + 1, text: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: 'removed', oldNo: i + 1, text: a[i] });
      i++;
    } else {
      out.push({ op: 'added', newNo: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) { out.push({ op: 'removed', oldNo: i + 1, text: a[i] }); i++; }
  while (j < m) { out.push({ op: 'added', newNo: j + 1, text: b[j] }); j++; }
  return out;
}

/** Count of changed (added + removed) lines — for a compact "N changes" badge. */
export function countChanges(lines: DiffLine[]): number {
  return lines.filter((l) => l.op !== 'equal').length;
}

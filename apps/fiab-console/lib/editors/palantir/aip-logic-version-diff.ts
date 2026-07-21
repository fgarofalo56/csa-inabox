/**
 * Pure version-diff for Spindle (AIP-Logic) function snapshots.
 *
 * Compares two authored-definition snapshots (typed inputs + typed block graph +
 * output contract + settings) and reports what changed between them: inputs and
 * blocks added / removed / edited, plus output-contract and settings changes.
 * No React / Azure deps → unit-testable and reused by the Versions panel.
 */

export interface SnapshotLite {
  inputs?: Array<Record<string, unknown>>;
  blocks?: Array<Record<string, unknown>>;
  outputType?: unknown;
  outputDescription?: unknown;
  settings?: Record<string, unknown>;
}

export interface DiffRow {
  key: string;          // identity (input name / block id|output)
  label: string;        // human label
  change: 'added' | 'removed' | 'edited' | 'unchanged';
  detail?: string;      // summary of what differs
}

export interface SnapshotDiff {
  inputs: DiffRow[];
  blocks: DiffRow[];
  outputChanged: boolean;
  outputDetail?: string;
  settingsChanged: boolean;
  addedCount: number;
  removedCount: number;
  editedCount: number;
}

function inputKey(i: Record<string, unknown>): string { return String(i?.name || ''); }
function blockKey(b: Record<string, unknown>): string { return String(b?.id || b?.output || ''); }

function stableJson(v: unknown): string {
  try { return JSON.stringify(v, Object.keys((v || {}) as object).sort()); } catch { return String(v); }
}

function diffList(
  a: Array<Record<string, unknown>>,
  b: Array<Record<string, unknown>>,
  keyOf: (x: Record<string, unknown>) => string,
  labelOf: (x: Record<string, unknown>) => string,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const aMap = new Map(a.map((x) => [keyOf(x), x]));
  const bMap = new Map(b.map((x) => [keyOf(x), x]));
  // present in B (new/edited/unchanged relative to A)
  for (const [k, bx] of bMap) {
    if (!k) continue;
    const ax = aMap.get(k);
    if (!ax) { rows.push({ key: k, label: labelOf(bx), change: 'added' }); continue; }
    if (stableJson(ax) !== stableJson(bx)) {
      const fields = editedFields(ax, bx);
      rows.push({ key: k, label: labelOf(bx), change: 'edited', detail: fields.join(', ') || 'changed' });
    } else {
      rows.push({ key: k, label: labelOf(bx), change: 'unchanged' });
    }
  }
  // removed (in A, not in B)
  for (const [k, ax] of aMap) {
    if (!k || bMap.has(k)) continue;
    rows.push({ key: k, label: labelOf(ax), change: 'removed' });
  }
  return rows;
}

function editedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === 'id') continue;
    if (stableJson(a[k]) !== stableJson(b[k])) out.push(k);
  }
  return out;
}

/** Diff snapshot A (older/base) → snapshot B (newer/compare). */
export function diffSnapshots(a: SnapshotLite | undefined, b: SnapshotLite | undefined): SnapshotDiff {
  const aInputs = Array.isArray(a?.inputs) ? a!.inputs! : [];
  const bInputs = Array.isArray(b?.inputs) ? b!.inputs! : [];
  const aBlocks = Array.isArray(a?.blocks) ? a!.blocks! : [];
  const bBlocks = Array.isArray(b?.blocks) ? b!.blocks! : [];

  const inputs = diffList(aInputs, bInputs, inputKey, (x) => `${x.name}${x.type ? `: ${x.type}` : ''}`);
  const blocks = diffList(aBlocks, bBlocks, blockKey, (x) => `${x.name || x.output} (${x.kind || 'block'})`);

  const outputChanged = String(a?.outputType ?? '') !== String(b?.outputType ?? '')
    || String(a?.outputDescription ?? '') !== String(b?.outputDescription ?? '');
  const outputDetail = outputChanged
    ? `${a?.outputType ?? '—'} → ${b?.outputType ?? '—'}`
    : undefined;
  const settingsChanged = stableJson(a?.settings || {}) !== stableJson(b?.settings || {});

  const all = [...inputs, ...blocks];
  return {
    inputs, blocks, outputChanged, outputDetail, settingsChanged,
    addedCount: all.filter((r) => r.change === 'added').length,
    removedCount: all.filter((r) => r.change === 'removed').length,
    editedCount: all.filter((r) => r.change === 'edited').length + (outputChanged ? 1 : 0) + (settingsChanged ? 1 : 0),
  };
}

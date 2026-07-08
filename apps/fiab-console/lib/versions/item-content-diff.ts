/**
 * Field-level structured diff for item-version content (Wave-2 W6).
 *
 * PURE / isomorphic — no Cosmos, no React, no Node built-ins — so the exact same
 * code powers the server-side change-summary (versions list route) AND the
 * client-side visual diff view (VersionHistoryDrawer), and is trivially unit
 * tested. The repo already has an item-LEVEL diff (`lib/install/pipeline-compare`
 * → "Same"/"Different") and a plan-specific `diffSnapshots`, but neither emits a
 * FIELD-level added/removed/changed list with old→new values, which is what the
 * version-history visual diff requires. This is the small, general util that gap
 * calls for (per the "reuse before adding" note — reviewed both, neither fits).
 *
 * The diff walks two arbitrary JSON values (an item's snapshot content —
 * typically `{ displayName, description, state:{…} }`) and reports every leaf
 * that was added, removed, or changed, keyed by a human dot/bracket path
 * (`state.content.tables[0].name`). Objects and arrays are recursed; leaves
 * (string/number/boolean/null and mismatched types) are compared by value.
 */

/** One field-level change between two content snapshots. */
export interface FieldChange {
  /** Dot/bracket path to the leaf, e.g. `state.content.tables[0].name`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  /** Previous value (absent for `added`). */
  oldValue?: unknown;
  /** New value (absent for `removed`). */
  newValue?: unknown;
}

/** Roll-up counts + a short human sentence describing a change set. */
export interface ChangeSummary {
  added: number;
  removed: number;
  changed: number;
  total: number;
  /** e.g. "2 changed, 1 added" or "No changes". */
  text: string;
}

/** Hard ceiling on emitted changes so a pathological blob can't produce a
 *  megabyte of diff. Beyond this we stop walking and mark truncation. */
const MAX_CHANGES = 500;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Leaf equality — same primitive value, or both `null`/`undefined`. NaN-safe. */
function leafEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  return false;
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/**
 * Recursively collect field-level changes from `oldVal` → `newVal` into `out`.
 * Recurses through objects (by key) and arrays (by index); anything else is a
 * leaf compared by value. Stops once `out` reaches MAX_CHANGES.
 */
function walk(oldVal: unknown, newVal: unknown, path: string, out: FieldChange[]): void {
  if (out.length >= MAX_CHANGES) return;

  const oldIsObj = isPlainObject(oldVal);
  const newIsObj = isPlainObject(newVal);
  const oldIsArr = Array.isArray(oldVal);
  const newIsArr = Array.isArray(newVal);

  // Object recursion: both objects, or one is an object and the other is
  // absent (undefined). Recursing into the present side against an empty
  // object emits leaf-level added/removed paths (e.g. `tables[2].name`)
  // rather than reporting the whole node. A defined leaf on the other side
  // is NOT recursed here — that is a shape change handled below as `changed`.
  if ((oldIsObj || newIsObj) && !oldIsArr && !newIsArr &&
      (oldIsObj || oldVal === undefined) && (newIsObj || newVal === undefined)) {
    const src = oldIsObj ? (oldVal as Record<string, unknown>) : {};
    const dst = newIsObj ? (newVal as Record<string, unknown>) : {};
    const keys = new Set<string>([...Object.keys(src), ...Object.keys(dst)]);
    // Stable, deterministic order so the diff (and any snapshot test) is stable.
    for (const key of [...keys].sort()) {
      walk(src[key], dst[key], joinPath(path, key), out);
      if (out.length >= MAX_CHANGES) return;
    }
    return;
  }

  // Array recursion: both arrays, or one is an array and the other is absent.
  if ((oldIsArr || newIsArr) &&
      (oldIsArr || oldVal === undefined) && (newIsArr || newVal === undefined)) {
    const src = oldIsArr ? (oldVal as unknown[]) : [];
    const dst = newIsArr ? (newVal as unknown[]) : [];
    const len = Math.max(src.length, dst.length);
    for (let i = 0; i < len; i++) {
      walk(src[i], dst[i], joinPath(path, i), out);
      if (out.length >= MAX_CHANGES) return;
    }
    return;
  }

  // Leaf (or a type-shape mismatch, e.g. object→string): compare by value.
  const oldDefined = oldVal !== undefined;
  const newDefined = newVal !== undefined;
  if (!oldDefined && !newDefined) return;
  if (!oldDefined && newDefined) {
    out.push({ path, kind: 'added', newValue: newVal });
    return;
  }
  if (oldDefined && !newDefined) {
    out.push({ path, kind: 'removed', oldValue: oldVal });
    return;
  }
  // Both defined but one side is a container and the other a leaf, or two
  // unequal leaves → a change with both values.
  if (isPlainObject(oldVal) || Array.isArray(oldVal) || isPlainObject(newVal) || Array.isArray(newVal)) {
    // Shape changed (object↔array↔leaf). Report the whole node as changed.
    out.push({ path, kind: 'changed', oldValue: oldVal, newValue: newVal });
    return;
  }
  if (!leafEqual(oldVal, newVal)) {
    out.push({ path, kind: 'changed', oldValue: oldVal, newValue: newVal });
  }
}

/**
 * Field-level diff of two item-content snapshots. Returns every added / removed
 * / changed leaf with its path and old→new values, in a stable path order.
 * `undefined`/missing on one side yields `added` or `removed`. Capped at
 * MAX_CHANGES entries.
 */
export function diffItemContent(oldContent: unknown, newContent: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  walk(oldContent, newContent, '', out);
  return out;
}

/** Roll a change list up into counts + a short human sentence. */
export function summarizeChanges(changes: readonly FieldChange[]): ChangeSummary {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const c of changes) {
    if (c.kind === 'added') added++;
    else if (c.kind === 'removed') removed++;
    else changed++;
  }
  const total = added + removed + changed;
  const parts: string[] = [];
  if (changed) parts.push(`${changed} changed`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  const noun = (n: number) => (n === 1 ? 'field' : 'fields');
  // Prefer a compact "N changed, M added" phrasing; fall back to a single
  // "N fields" when only one bucket is non-zero for slightly friendlier text.
  let text: string;
  if (total === 0) text = 'No changes';
  else if (parts.length === 1 && changed === total) text = `${changed} ${noun(changed)} changed`;
  else if (parts.length === 1 && added === total) text = `${added} ${noun(added)} added`;
  else if (parts.length === 1 && removed === total) text = `${removed} ${noun(removed)} removed`;
  else text = parts.join(', ');
  return { added, removed, changed, total, text };
}

/** Convenience: diff + summarize in one call (server change-summary path). */
export function summarizeContentDiff(oldContent: unknown, newContent: unknown): ChangeSummary {
  return summarizeChanges(diffItemContent(oldContent, newContent));
}

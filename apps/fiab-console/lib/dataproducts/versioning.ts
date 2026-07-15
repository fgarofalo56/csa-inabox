/**
 * DP-9 — data-product versioning + deprecation (PURE, framework-free).
 *
 * Semver discipline for the product's data contract with a precise breaking-
 * change taxonomy, a schema-diff that classifies a bump level, immutable version
 * history, and a humane deprecation model. No I/O — the BFF gathers the contracts
 * and calls these; the version panel + publish gate render the result.
 *
 * Breaking-change taxonomy (major = breaking) grounded in data-product semver
 * practice (rewirenow / glitni / datacontract-cli):
 *   MAJOR  — a column removed; a column type changed; a nullable→required
 *            tightening; a primary-key added/removed (key-cardinality/grain
 *            change).
 *   MINOR  — a new column added; a required→nullable relaxation; an SLO changed.
 *   PATCH  — description / classification / quality-expectation-only changes.
 *
 * A humane deprecation carries a sunset date, a replacement pointer, a migration
 * note, and a notice-lead window (parallel-run), and flips to `retired` on the
 * sunset date (evaluated lazily / by a scheduled check).
 */

import type { DataContract, ContractColumn } from './contract';

export type SemverLevel = 'patch' | 'minor' | 'major';
const LEVEL_RANK: Record<SemverLevel, number> = { patch: 0, minor: 1, major: 2 };

export type ChangeKind =
  | 'column-added' | 'column-removed' | 'type-changed'
  | 'nullable-tightened' | 'nullable-relaxed'
  | 'primary-key-changed' | 'slo-changed' | 'metadata-changed' | 'quality-changed';

export interface ContractChange {
  kind: ChangeKind;
  column?: string;
  detail: string;
  /** True when the change is breaking (forces a major bump at publish). */
  breaking: boolean;
  level: SemverLevel;
}

export interface ContractDiff {
  changes: ContractChange[];
  /** The highest bump level implied by the changes. */
  level: SemverLevel;
  breaking: boolean;
}

function colMap(c?: DataContract): Map<string, ContractColumn> {
  const m = new Map<string, ContractColumn>();
  for (const col of c?.schema ?? []) if (col?.name) m.set(col.name, col);
  return m;
}

function raise(cur: SemverLevel, next: SemverLevel): SemverLevel {
  return LEVEL_RANK[next] > LEVEL_RANK[cur] ? next : cur;
}

/**
 * Classify the diff between two contracts. `prev` is the last published/saved
 * contract; `next` is the edited one. Deterministic — same inputs, same output.
 */
export function diffContracts(prev: DataContract | undefined, next: DataContract | undefined): ContractDiff {
  const changes: ContractChange[] = [];
  const a = colMap(prev), b = colMap(next);

  // Removed / changed columns (present in prev).
  for (const [name, pc] of a) {
    const nc = b.get(name);
    if (!nc) {
      changes.push({ kind: 'column-removed', column: name, detail: `Column '${name}' removed.`, breaking: true, level: 'major' });
      continue;
    }
    if (pc.type !== nc.type) {
      changes.push({ kind: 'type-changed', column: name, detail: `Column '${name}' type ${pc.type} → ${nc.type}.`, breaking: true, level: 'major' });
    }
    const pNull = pc.nullable !== false; // default nullable=true
    const nNull = nc.nullable !== false;
    if (pNull && !nNull) {
      changes.push({ kind: 'nullable-tightened', column: name, detail: `Column '${name}' is now required (was nullable).`, breaking: true, level: 'major' });
    } else if (!pNull && nNull) {
      changes.push({ kind: 'nullable-relaxed', column: name, detail: `Column '${name}' is now nullable (was required).`, breaking: false, level: 'minor' });
    }
    if (!!pc.primaryKey !== !!nc.primaryKey) {
      changes.push({ kind: 'primary-key-changed', column: name, detail: `Column '${name}' primary-key ${pc.primaryKey ? 'removed' : 'added'} (grain/key change).`, breaking: true, level: 'major' });
    }
    if ((pc.description || '') !== (nc.description || '') || (pc.classification || '') !== (nc.classification || '')) {
      changes.push({ kind: 'metadata-changed', column: name, detail: `Column '${name}' metadata updated.`, breaking: false, level: 'patch' });
    }
  }
  // Added columns (present only in next).
  for (const [name] of b) {
    if (!a.has(name)) {
      changes.push({ kind: 'column-added', column: name, detail: `Column '${name}' added.`, breaking: false, level: 'minor' });
    }
  }
  // SLO change (any field differs) → minor.
  if (JSON.stringify(prev?.slo ?? {}) !== JSON.stringify(next?.slo ?? {})) {
    changes.push({ kind: 'slo-changed', detail: 'Service-level objectives changed.', breaking: false, level: 'minor' });
  }
  // Quality-expectation change → patch.
  if (JSON.stringify(prev?.quality ?? []) !== JSON.stringify(next?.quality ?? [])) {
    changes.push({ kind: 'quality-changed', detail: 'Data-quality expectations changed.', breaking: false, level: 'patch' });
  }

  const level = changes.reduce<SemverLevel>((acc, c) => raise(acc, c.level), 'patch');
  const breaking = changes.some((c) => c.breaking);
  return { changes, level: changes.length ? level : 'patch', breaking };
}

/** Parse an "x.y.z" semver (tolerant); missing parts default to 0. */
export function parseSemver(v: string | undefined): [number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec((v || '').trim());
  if (!m) return [1, 0, 0];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

/** Bump a semver by a level. major → x+1.0.0, minor → x.y+1.0, patch → x.y.z+1. */
export function bumpVersion(version: string | undefined, level: SemverLevel): string {
  const [maj, min, pat] = parseSemver(version);
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** Suggest the next version + level for an edited contract vs the previous one. */
export function suggestNextVersion(prev: DataContract | undefined, next: DataContract | undefined): { level: SemverLevel; version: string; diff: ContractDiff } {
  const diff = diffContracts(prev, next);
  return { level: diff.level, version: bumpVersion(prev?.version, diff.level), diff };
}

/** An immutable version-history entry persisted to `state.versions[]`. */
export interface VersionEntry {
  version: string;
  level: SemverLevel;
  contract: DataContract;
  createdAt: string;
  createdBy?: string;
  note?: string;
  /** The diff vs the immediately-prior version (empty for the first). */
  changes?: ContractChange[];
}

/** The deprecation record persisted to `state.deprecation`. */
export interface DeprecationRecord {
  deprecatedAt: string;
  deprecatedBy?: string;
  /** ISO date the product retires (parallel-run ends). */
  sunsetAt: string;
  /** Notice-lead window in days (30/60/90). */
  noticeDays: number;
  /** Replacement data-product id consumers should migrate to. */
  replacementProductId?: string;
  migrationNote?: string;
}

/** True when a deprecated product has passed its sunset date (→ retire). */
export function isPastSunset(dep: DeprecationRecord | undefined, now: Date = new Date()): boolean {
  if (!dep?.sunsetAt) return false;
  const t = Date.parse(dep.sunsetAt);
  return Number.isFinite(t) && t <= now.getTime();
}

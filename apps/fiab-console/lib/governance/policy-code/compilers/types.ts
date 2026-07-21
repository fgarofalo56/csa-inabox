/**
 * Shared compiled-artifact contract for the per-backend policy compilers.
 *
 * A compiler is a PURE function `PolicyCodeSet → CompiledArtifact`. Each emits a
 * list of `CompiledOp`s — a real, executable statement (T-SQL, Databricks SQL,
 * KQL, a Purview classification descriptor, or an API-scope grant) plus a
 * stable `key` so the reconcile loop can diff desired-vs-live deterministically.
 * No Azure imports here — pure string generation, unit-tested.
 */

import type { PolicyBackend } from '../dsl';

export type CompiledOpKind =
  | 'grant'
  | 'deny'
  | 'revoke'
  | 'rls'
  | 'mask'
  | 'classification'
  | 'scope'
  | 'principal';

export interface CompiledOp {
  /**
   * Stable identity of the op — used as the diff key by the reconcile loop.
   * Same desired op run twice → same key → idempotent. Encodes backend + kind +
   * target + principal so a drifted/removed grant is detected precisely.
   */
  key: string;
  kind: CompiledOpKind;
  /** The executable artifact (a SQL/KQL statement, or a JSON descriptor). */
  statement: string;
  /**
   * The inverse statement — run by the reconcile loop when the op is no longer
   * desired (a statement was removed from the policy set). Multi-statement undos
   * use the backend's batch separator. Absent when an op has no meaningful
   * inverse (e.g. an api-scope entry, whose registry doc is rewritten wholesale).
   */
  undo?: string;
  /** The object the op targets (schema.table / catalog.schema.table / db / route). */
  target: string;
  /** Principal ids the op affects (for audit + revoke). */
  principals: string[];
  /**
   * Structured Unity Catalog REST grant — populated by the UC compiler so the
   * OSS-UC path (no Databricks SQL warehouse) can apply the grant via the UC
   * permissions REST instead of a SQL statement. Databricks UC uses `statement`.
   */
  rest?: {
    securableType: string;
    securableName: string;
    principal: string;
    add?: string[];
    remove?: string[];
  };
  /** Source statement id. */
  from: string;
}

export interface CompiledArtifact {
  backend: PolicyBackend;
  /** True when the set has at least one op for this backend. */
  applicable: boolean;
  ops: CompiledOp[];
  warnings: string[];
  summary: string[];
}

export function emptyArtifact(backend: PolicyBackend): CompiledArtifact {
  return { backend, applicable: false, ops: [], warnings: [], summary: [] };
}

/** Dedupe ops by key (a principal listed twice, same grant from two statements). */
export function dedupeOps(ops: CompiledOp[]): CompiledOp[] {
  const seen = new Map<string, CompiledOp>();
  for (const op of ops) if (!seen.has(op.key)) seen.set(op.key, op);
  return [...seen.values()];
}

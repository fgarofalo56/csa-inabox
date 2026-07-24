/**
 * loom-transform-plans — doc shape + MIG1 versioned-migration registration (N4).
 *
 * Every `transformation-project` plan/apply is recorded as a durable artifact:
 * WHO planned WHAT against WHICH virtual environment, the exact impact rows the
 * operator saw (including the breaking classification), and whether it was
 * subsequently applied. That record is what makes plan/apply auditable —
 * "the change that broke prod" is answerable from the plan the operator
 * approved, not from a log line.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` (no cosmos-client,
 * no transform client) so `cosmos-client` can import it at module scope to
 * register the migrator chain before any read materializes — the
 * copilot-evals-model / prompt-registry-model precedent.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 *
 * Per-cloud: identical Commercial / GCC-High / IL5 — pure metadata in the
 * deployment's OWN Cosmos. SOVEREIGN MOAT: plan history never leaves the
 * boundary; there is no dbt Cloud / Tobiko Cloud run history in the path, which
 * is exactly why Loom keeps it natively.
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const TRANSFORM_PLANS_CONTAINER = 'loom-transform-plans';
export const TRANSFORM_PLANS_SCHEMA_VERSION = 1;

/** Plan-history rows self-evict after a year (the governance retention floor). */
export const TRANSFORM_PLAN_TTL_SECONDS = 365 * 24 * 60 * 60;

/** One impact row exactly as the operator saw it in the wizard grid. */
export interface TransformPlanRowDoc {
  model: string;
  changeType: 'added' | 'modified' | 'removed';
  severity: 'breaking' | 'non-breaking' | 'forward-only' | 'metadata';
  downstreamCount: number;
  columnsChanged: number;
}

/** A recorded plan (and, when applied, its apply outcome). PK /itemId. */
export interface TransformPlanDoc {
  /** Cosmos id — `plan:<itemId>:<isoTimestamp>`. */
  id: string;
  /** PK — the transformation-project item id; a project's history is one partition. */
  itemId: string;
  docType: 'transform-plan';
  schemaVersion: number;
  /** Engine that produced the plan. */
  backend: 'dbt' | 'sqlmesh';
  /** Virtual environment (SQLMesh) or dbt target the plan was built against. */
  environment: string;
  plannedAt: string;
  plannedByOid: string;
  plannedByUpn: string;
  hasChanges: boolean;
  summary: {
    added: number;
    modified: number;
    removed: number;
    breaking: number;
    nonBreaking: number;
    forwardOnly: number;
    metadata: number;
    downstreamImpacted: number;
    backfillIntervals: number;
  };
  rows: TransformPlanRowDoc[];
  /** Set when the same plan was applied. */
  applied?: {
    at: string;
    byOid: string;
    byUpn: string;
    ok: boolean;
    /** First 4k of the engine log — enough to explain a failure, bounded. */
    log?: string;
  };
  /** Cosmos TTL (seconds). */
  ttl: number;
}

/** Stable plan id — sortable by time inside the item's partition. */
export function transformPlanId(itemId: string, plannedAt: string): string {
  return `plan:${itemId}:${plannedAt}`;
}

/** Build a durable plan doc from the normalized impact the wizard rendered. */
export function buildTransformPlanDoc(input: {
  itemId: string;
  backend: 'dbt' | 'sqlmesh';
  environment: string;
  plannedByOid: string;
  plannedByUpn: string;
  hasChanges: boolean;
  summary: TransformPlanDoc['summary'];
  rows: Array<{
    model: string;
    changeType: 'added' | 'modified' | 'removed';
    severity: 'breaking' | 'non-breaking' | 'forward-only' | 'metadata';
    downstreamCount: number;
    columns: unknown[];
  }>;
  plannedAt?: string;
}): TransformPlanDoc {
  const plannedAt = input.plannedAt || new Date().toISOString();
  return {
    id: transformPlanId(input.itemId, plannedAt),
    itemId: input.itemId,
    docType: 'transform-plan',
    schemaVersion: TRANSFORM_PLANS_SCHEMA_VERSION,
    backend: input.backend,
    environment: input.environment,
    plannedAt,
    plannedByOid: input.plannedByOid,
    plannedByUpn: input.plannedByUpn,
    hasChanges: input.hasChanges,
    summary: input.summary,
    rows: input.rows.map((r) => ({
      model: r.model,
      changeType: r.changeType,
      severity: r.severity,
      downstreamCount: r.downstreamCount,
      columnsChanged: Array.isArray(r.columns) ? r.columns.length : 0,
    })),
    ttl: TRANSFORM_PLAN_TTL_SECONDS,
  };
}

// ── MIG1 registration ────────────────────────────────────────────────────────

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(TRANSFORM_PLANS_CONTAINER, 1, v1toV2);
 *
 * plus the optional backfill script
 * `scripts/csa-loom/cosmos-backfill-loom-transform-plans.mjs`.
 */
export function registerTransformPlanMigrators(): void {
  // v1 → (none yet). Keeping the registerMigrator reference live reserves the
  // wiring for the first real migration without claiming the one-owner-per-step
  // v1 slot with an inert migrator (the MIG1 convention).
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerTransformPlanMigrators();

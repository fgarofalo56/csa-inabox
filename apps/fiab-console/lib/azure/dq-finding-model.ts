/**
 * loom-dq-findings — the data-quality FINDING doc shape + MIG1 versioned-migration
 * registration + the PURE (Azure-free) finding-builders for N7d.
 *
 * ## Scope boundary (READ THIS)
 *
 * N7d DETECTS data-quality problems — a hard rule-check failure on the N4
 * transform runner, an anomaly-baseline outlier, or a data-diff regression — and
 * emits a normalized FINDING. It does **not** own the incident experience:
 * **N17's incident console OWNS the incident UX** (triage, assignment, timeline,
 * resolution). N7d is a PRODUCER; N17 is the CONSUMER. This module defines the
 * contract between them: a stable, self-describing finding row N17 can list,
 * group, and promote to an incident without re-deriving anything. Keep this
 * shape clean + additive — N17 reads it.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` (no cosmos-client,
 * no runner) so cosmos-client can import it at module scope to register the
 * migrator chain before any read materializes — the semantic-contract-model /
 * copilot-evals-model precedent.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking change bumps DQ_FINDING_SCHEMA_VERSION and registers its
 * `fromVersion: N` migrator in {@link registerDqFindingMigrators}. Per MIG1
 * there is deliberately NO inert v1 migrator today.
 *
 * Per-cloud: identical on all clouds (pure metadata in in-boundary Cosmos, no
 * Fabric). IL5 / SOVEREIGN MOAT: findings are written to in-boundary Cosmos and
 * the builders are pure — the full detect→emit→N17 loop runs DISCONNECTED in an
 * air-gapped enclave; no SaaS incident service is ever required.
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const DQ_FINDING_CONTAINER = 'loom-dq-findings';
export const DQ_FINDING_SCHEMA_VERSION = 1;

/** How the finding was detected — drives N17 grouping + the finding copy. */
export type DqFindingSource = 'rule-check' | 'anomaly' | 'data-diff';

/** Severity N17 consumes verbatim (error = page-worthy, warning = review, info = FYI). */
export type DqFindingSeverity = 'error' | 'warning' | 'info';

/** Lifecycle owned by N17 once promoted; N7d only ever WRITES `open`. */
export type DqFindingStatus = 'open' | 'acknowledged' | 'resolved' | 'muted';

/** The metric snapshot behind a finding (present for anomaly / rule-check findings). */
export interface DqFindingMetric {
  /** What the number measures, e.g. "violation-rows". */
  name: string;
  /** The observed value on this run. */
  value: number;
  /** The rolling baseline mean this was compared against (anomaly findings). */
  baselineMean?: number;
  baselineStddev?: number;
  /** The hard rule threshold that was breached (rule-check findings). */
  threshold?: number;
  /** z-score of the value vs baseline (anomaly findings). */
  zScore?: number | null;
}

/**
 * A single normalized data-quality finding. `id` is `finding:<runId>:<key>` so
 * re-running the same check on the same run is idempotent, and PK is `tenantId`
 * so N17 lists a tenant's findings with a single-partition query.
 */
export interface DqFindingDoc {
  /** Cosmos id — `finding:<runId>:<key>` (stable per run+check → idempotent upsert). */
  id: string;
  /** PK — owner oid / tenant (owner-scoped, mirrors the data-quality item scoping). */
  tenantId: string;
  docType: 'dq-finding';
  schemaVersion: number;

  source: DqFindingSource;
  severity: DqFindingSeverity;
  /** N7d always writes 'open'; N17 mutates this after promotion. */
  status: DqFindingStatus;

  /** The data-quality item this finding came from (the run's home). */
  itemId: string;
  itemType: string;
  workspaceId?: string;

  /** The run that produced it (correlates a batch of findings). */
  runId: string;
  /** The specific check id (rule-check / anomaly) or diff key. */
  checkKey: string;

  /** The dataset the finding is about. */
  target: {
    /** transform-runner engine (synapse | databricks | duckdb) or 'delta'/'duckdb' for a diff. */
    engine: string;
    table?: string;
    column?: string;
    /** For a data-diff finding: the two versions/paths compared. */
    diffScope?: string;
  };

  /** One-line human title (N17 list row). */
  title: string;
  /** Full explanation (N17 detail pane). */
  detail: string;
  metric?: DqFindingMetric;

  firstSeenAt: string;
  lastSeenAt: string;
  createdBy: string;
}

/** Deterministic, filesystem/URL-safe key for a finding id fragment. */
export function findingKey(source: DqFindingSource, checkKey: string): string {
  return `${source}:${String(checkKey || '').replace(/[^A-Za-z0-9._-]+/g, '_')}`.slice(0, 200);
}

/** Deterministic finding id — idempotent across re-emits of the same run+check. */
export function findingId(runId: string, source: DqFindingSource, checkKey: string): string {
  return `finding:${String(runId || 'run').replace(/[^A-Za-z0-9._-]+/g, '_')}:${findingKey(source, checkKey)}`.slice(0, 250);
}

/** Inputs a producer passes to {@link buildDqFinding} (everything else is derived). */
export interface BuildFindingInput {
  tenantId: string;
  itemId: string;
  itemType: string;
  workspaceId?: string;
  runId: string;
  source: DqFindingSource;
  severity: DqFindingSeverity;
  checkKey: string;
  target: DqFindingDoc['target'];
  title: string;
  detail: string;
  metric?: DqFindingMetric;
  createdBy: string;
  at?: string;
}

/**
 * Build a well-formed, schema-stamped finding doc. PURE — the store just writes
 * what this returns. `id` is deterministic so a re-run upserts rather than
 * duplicates (N17 sees a stable finding it can track across runs by checkKey).
 */
export function buildDqFinding(input: BuildFindingInput): DqFindingDoc {
  const at = input.at || new Date().toISOString();
  return {
    id: findingId(input.runId, input.source, input.checkKey),
    tenantId: input.tenantId,
    docType: 'dq-finding',
    schemaVersion: DQ_FINDING_SCHEMA_VERSION,
    source: input.source,
    severity: input.severity,
    status: 'open',
    itemId: input.itemId,
    itemType: input.itemType,
    workspaceId: input.workspaceId,
    runId: input.runId,
    checkKey: input.checkKey,
    target: input.target,
    title: input.title.slice(0, 300),
    detail: input.detail.slice(0, 4000),
    metric: input.metric,
    firstSeenAt: at,
    lastSeenAt: at,
    createdBy: input.createdBy,
  };
}

/** Map a DQ-rule severity ('error' | 'warning') to a finding severity. */
export function severityForRule(ruleSeverity: 'error' | 'warning'): DqFindingSeverity {
  return ruleSeverity === 'error' ? 'error' : 'warning';
}

// ── MIG1 registration ────────────────────────────────────────────────────────

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(DQ_FINDING_CONTAINER, 1, v1toV2);
 *
 * Keeping the `registerMigrator` reference live reserves the wiring without
 * claiming the v1 slot with an inert migrator (the MIG1 convention).
 */
export function registerDqFindingMigrators(): void {
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerDqFindingMigrators();

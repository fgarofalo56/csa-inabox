/**
 * N4 — plan → impact-row normalization for BOTH transformation backends.
 *
 * The loom-transform-runner returns ENGINE-NATIVE facts (it does not editorialize):
 *
 *   • SQLMesh — the real `SnapshotChangeCategory` per changed snapshot
 *     (BREAKING / NON_BREAKING / FORWARD_ONLY / INDIRECT_BREAKING /
 *     INDIRECT_NON_BREAKING / METADATA), the indirectly-modified downstream set,
 *     both `columns_to_types` maps, and the missing intervals to backfill.
 *   • dbt — the real state comparison: the freshly-compiled
 *     `target/manifest.json` diffed against the deployed-state manifest (the
 *     `dbt ls --select state:modified` mechanism), the manifest `child_map`
 *     downstream, and the `catalog.json` column→type maps.
 *
 * This module turns both into ONE grid of {@link ImpactRow}s with a single
 * breaking/non-breaking classification, so the plan/apply wizard renders the
 * same impact table whichever engine the project selected.
 *
 * Classification rules (contract semantics, not guesses):
 *   • SQLMesh states the category — it is honored verbatim.
 *   • When SQLMesh leaves a snapshot UNCATEGORIZED (auto-categorization off), or
 *     for dbt (which has no categorization at all), the severity is DERIVED from
 *     the column contract: a removed or type-changed column BREAKS downstream
 *     consumers; only-added columns are additive; a body change with no column
 *     change is non-breaking; a config/metadata-only change is metadata.
 *   • A removed model is always breaking.
 *
 * PURE — no imports beyond the project model's `TransformBackend` type, so the
 * BFF, the editor, and the tests all share exactly this logic.
 */

import type { TransformBackend } from './transform-project-model';

/** What happened to the model between the deployed state and the plan. */
export type ImpactChangeType = 'added' | 'modified' | 'removed';

/**
 * Contract impact on downstream consumers.
 *   breaking      — downstream must be rebuilt / may break (column removed or
 *                   retyped, model removed, SQLMesh BREAKING/INDIRECT_BREAKING).
 *   non-breaking  — additive; downstream keeps its data.
 *   forward-only  — SQLMesh FORWARD_ONLY: applies to NEW data only, no backfill.
 *   metadata      — description/owner/tag-only; nothing rebuilds.
 */
export type ImpactSeverity = 'breaking' | 'non-breaking' | 'forward-only' | 'metadata';

/** One column-level change on a model. */
export interface ColumnImpact {
  name: string;
  change: 'added' | 'removed' | 'type-changed';
  fromType?: string;
  toType?: string;
}

/** One row of the impact-diff grid. */
export interface ImpactRow {
  /** Model name / fully-qualified name as the engine reports it. */
  model: string;
  changeType: ImpactChangeType;
  severity: ImpactSeverity;
  /** True when the model itself changed; false when it is only affected downstream. */
  direct: boolean;
  /** The downstream models this change propagates to. */
  downstream: string[];
  downstreamCount: number;
  columns: ColumnImpact[];
  /** SQLMesh: intervals that would be backfilled by apply. */
  backfillIntervals?: number;
  /** The engine's own category string, kept for the row's tooltip/provenance. */
  engineCategory?: string;
}

/** Roll-up shown above the grid + used by the wizard's apply confirmation. */
export interface ImpactSummary {
  added: number;
  modified: number;
  removed: number;
  breaking: number;
  nonBreaking: number;
  forwardOnly: number;
  metadata: number;
  /** Distinct downstream models touched across every row. */
  downstreamImpacted: number;
  /** Total intervals apply would backfill (SQLMesh). */
  backfillIntervals: number;
}

/** The normalized plan the wizard renders. */
export interface PlanImpact {
  engine: TransformBackend;
  environment: string;
  hasChanges: boolean;
  rows: ImpactRow[];
  summary: ImpactSummary;
  /** True when a dbt plan had no deployed-state manifest to diff against. */
  noDeployedState?: boolean;
}

// ── column diffing ──────────────────────────────────────────────────────────

type ColumnMap = Record<string, string>;

function asColumnMap(raw: unknown): ColumnMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: ColumnMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[String(k)] = v == null ? '' : String(v);
  }
  return out;
}

/** Normalize a SQL type for comparison: case + whitespace insensitive. */
function normType(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Column-level diff between the deployed column map and the planned one.
 * An EMPTY previous map means "no column metadata available" — that is reported
 * as zero column rows, never as "every column added" (which would be a lie).
 */
export function diffColumns(previous: unknown, next: unknown): ColumnImpact[] {
  const prev = asColumnMap(previous);
  const cur = asColumnMap(next);
  const prevKeys = Object.keys(prev);
  const curKeys = Object.keys(cur);
  if (prevKeys.length === 0 && curKeys.length === 0) return [];
  if (prevKeys.length === 0) {
    // Model is new (or the deployed catalog had no entry) — additive columns.
    return curKeys.map((name) => ({ name, change: 'added' as const, toType: cur[name] || undefined }));
  }
  if (curKeys.length === 0) {
    return prevKeys.map((name) => ({ name, change: 'removed' as const, fromType: prev[name] || undefined }));
  }
  const out: ColumnImpact[] = [];
  for (const name of curKeys) {
    if (!(name in prev)) {
      out.push({ name, change: 'added', toType: cur[name] || undefined });
    } else if (prev[name] && cur[name] && normType(prev[name]) !== normType(cur[name])) {
      out.push({ name, change: 'type-changed', fromType: prev[name], toType: cur[name] });
    }
  }
  for (const name of prevKeys) {
    if (!(name in cur)) out.push({ name, change: 'removed', fromType: prev[name] || undefined });
  }
  return out;
}

/**
 * Derive a severity from the column contract when the engine did not state one.
 * `bodyChanged` distinguishes a real SQL change from a metadata-only edit.
 */
export function severityFromColumns(
  changeType: ImpactChangeType,
  columns: ColumnImpact[],
  bodyChanged: boolean,
): ImpactSeverity {
  if (changeType === 'removed') return 'breaking';
  if (changeType === 'added') return 'non-breaking';
  if (columns.some((c) => c.change === 'removed' || c.change === 'type-changed')) return 'breaking';
  if (columns.some((c) => c.change === 'added')) return 'non-breaking';
  return bodyChanged ? 'non-breaking' : 'metadata';
}

/** Map a SQLMesh SnapshotChangeCategory name onto the shared severity. */
export function severityFromSqlMeshCategory(category: string | undefined): ImpactSeverity | null {
  switch ((category || '').toLowerCase()) {
    case 'breaking':
    case 'indirect_breaking':
      return 'breaking';
    case 'non_breaking':
    case 'indirect_non_breaking':
      return 'non-breaking';
    case 'forward_only':
      return 'forward-only';
    case 'metadata':
      return 'metadata';
    default:
      return null; // uncategorized — derive from the column contract instead.
  }
}

// ── summary ─────────────────────────────────────────────────────────────────

export function summarize(rows: ImpactRow[]): ImpactSummary {
  const downstream = new Set<string>();
  let backfillIntervals = 0;
  const s: ImpactSummary = {
    added: 0, modified: 0, removed: 0,
    breaking: 0, nonBreaking: 0, forwardOnly: 0, metadata: 0,
    downstreamImpacted: 0, backfillIntervals: 0,
  };
  for (const r of rows) {
    if (r.changeType === 'added') s.added += 1;
    else if (r.changeType === 'modified') s.modified += 1;
    else s.removed += 1;
    if (r.severity === 'breaking') s.breaking += 1;
    else if (r.severity === 'non-breaking') s.nonBreaking += 1;
    else if (r.severity === 'forward-only') s.forwardOnly += 1;
    else s.metadata += 1;
    for (const d of r.downstream) downstream.add(d);
    backfillIntervals += r.backfillIntervals || 0;
  }
  s.downstreamImpacted = downstream.size;
  s.backfillIntervals = backfillIntervals;
  return s;
}

/** Breaking rows first, then modified/removed, then alphabetical — the grid order. */
export function sortImpactRows(rows: ImpactRow[]): ImpactRow[] {
  const sevRank: Record<ImpactSeverity, number> = {
    breaking: 0, 'forward-only': 1, 'non-breaking': 2, metadata: 3,
  };
  const typeRank: Record<ImpactChangeType, number> = { removed: 0, modified: 1, added: 2 };
  return [...rows].sort((a, b) =>
    sevRank[a.severity] - sevRank[b.severity]
    || typeRank[a.changeType] - typeRank[b.changeType]
    || b.downstreamCount - a.downstreamCount
    || a.model.localeCompare(b.model));
}

// ── SQLMesh ─────────────────────────────────────────────────────────────────

interface RawSqlMeshChange {
  model?: unknown;
  changeType?: unknown;
  category?: unknown;
  direct?: unknown;
  downstream?: unknown;
  columns?: unknown;
  previousColumns?: unknown;
}

function asChangeType(raw: unknown): ImpactChangeType {
  return raw === 'added' || raw === 'removed' ? raw : 'modified';
}

function asStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((x) => String(x)).filter(Boolean) : [];
}

/** Normalize the runner's `{ engine:'sqlmesh', plan:{…} }` payload. */
export function parseSqlMeshPlan(payload: unknown): PlanImpact {
  const body = (payload ?? {}) as { plan?: Record<string, unknown> };
  const plan = (body.plan ?? {}) as Record<string, unknown>;
  const environment = typeof plan.environment === 'string' ? plan.environment : 'dev';
  const backfills = new Map<string, number>();
  for (const b of (Array.isArray(plan.backfills) ? plan.backfills : [])) {
    const entry = b as { model?: unknown; intervals?: unknown };
    const name = String(entry?.model ?? '');
    if (name) backfills.set(name, Number(entry?.intervals ?? 0) || 0);
  }

  const rows: ImpactRow[] = [];
  for (const raw of (Array.isArray(plan.changes) ? plan.changes : []) as RawSqlMeshChange[]) {
    const model = String(raw?.model ?? '').trim();
    if (!model) continue;
    const changeType = asChangeType(raw?.changeType);
    const columns = diffColumns(raw?.previousColumns, raw?.columns);
    const engineCategory = raw?.category == null ? undefined : String(raw.category);
    const stated = severityFromSqlMeshCategory(engineCategory);
    const downstream = asStringList(raw?.downstream);
    rows.push({
      model,
      changeType,
      // SQLMesh's own category wins; only fall back to the column contract when
      // the snapshot is genuinely uncategorized. EXCEPTION: a newly ADDED model
      // has no prior contract to break, so SQLMesh's default BREAKING category
      // on a brand-new snapshot (it means "must be built", not "breaks
      // consumers") is reported as additive — otherwise every first plan would
      // read as an estate-wide breaking change.
      severity: changeType === 'added'
        ? (stated === 'forward-only' || stated === 'metadata' ? stated : 'non-breaking')
        : (stated ?? severityFromColumns(changeType, columns, true)),
      direct: raw?.direct !== false,
      downstream,
      downstreamCount: downstream.length,
      columns,
      backfillIntervals: backfills.get(model),
      engineCategory,
    });
  }

  const sorted = sortImpactRows(rows);
  return {
    engine: 'sqlmesh',
    environment,
    hasChanges: sorted.length > 0,
    rows: sorted,
    summary: summarize(sorted),
  };
}

// ── dbt ─────────────────────────────────────────────────────────────────────

interface RawDbtNode {
  uniqueId?: unknown;
  name?: unknown;
  schema?: unknown;
  downstream?: unknown;
  columns?: unknown;
  previousColumns?: unknown;
  sqlChanged?: unknown;
  configChanged?: unknown;
}

function dbtDisplayName(node: RawDbtNode): string {
  const name = String(node?.name ?? '').trim();
  if (name) {
    const schema = String(node?.schema ?? '').trim();
    return schema ? `${schema}.${name}` : name;
  }
  const uid = String(node?.uniqueId ?? '').trim();
  return uid ? uid.split('.').slice(-1)[0] : '';
}

function dbtDownstream(node: RawDbtNode): string[] {
  // dbt's child_map yields unique ids (`model.<project>.<name>`); show the name.
  return asStringList(node?.downstream).map((c) => c.split('.').slice(-1)[0]).filter(Boolean);
}

/**
 * Normalize the runner's `{ engine:'dbt', plan:{ added, modified, removed } }`
 * state comparison. `environment` is the dbt TARGET name (dbt has no virtual
 * environments — the wizard says so rather than pretending otherwise).
 */
export function parseDbtPlan(payload: unknown, environment = 'prod'): PlanImpact {
  const body = (payload ?? {}) as { plan?: Record<string, unknown> };
  const plan = (body.plan ?? {}) as Record<string, unknown>;
  const rows: ImpactRow[] = [];

  const push = (node: RawDbtNode, changeType: ImpactChangeType) => {
    const model = dbtDisplayName(node);
    if (!model) return;
    const columns = changeType === 'added'
      ? diffColumns({}, node?.columns)
      : changeType === 'removed'
        ? diffColumns(node?.previousColumns, {})
        : diffColumns(node?.previousColumns, node?.columns);
    const bodyChanged = node?.sqlChanged !== false;
    const downstream = dbtDownstream(node);
    rows.push({
      model,
      changeType,
      severity: severityFromColumns(changeType, columns, bodyChanged),
      direct: true,
      downstream,
      downstreamCount: downstream.length,
      columns,
    });
  };

  for (const n of (Array.isArray(plan.added) ? plan.added : []) as RawDbtNode[]) push(n, 'added');
  for (const n of (Array.isArray(plan.modified) ? plan.modified : []) as RawDbtNode[]) push(n, 'modified');
  for (const n of (Array.isArray(plan.removed) ? plan.removed : []) as RawDbtNode[]) push(n, 'removed');

  const sorted = sortImpactRows(rows);
  return {
    engine: 'dbt',
    environment,
    hasChanges: sorted.length > 0,
    rows: sorted,
    summary: summarize(sorted),
    // No deployed-state manifest to diff against → every model reads as "added".
    // Say so, so the wizard can explain the first-plan case instead of alarming.
    noDeployedState: plan.hasState === false,
  };
}

/** Dispatch on the runner's declared engine (falls back to the requested backend). */
export function parsePlanPayload(
  payload: unknown,
  backend: TransformBackend,
  environment?: string,
): PlanImpact {
  const declared = (payload as { engine?: unknown } | null)?.engine;
  const engine: TransformBackend = declared === 'sqlmesh' || declared === 'dbt'
    ? declared
    : backend;
  return engine === 'sqlmesh'
    ? parseSqlMeshPlan(payload)
    : parseDbtPlan(payload, environment || 'prod');
}

// ── column-level table diff (SQLMesh /diff) ─────────────────────────────────

export interface TableDiffResult {
  model: string;
  source: string;
  target: string;
  columns: ColumnImpact[];
  sourceRows: number | null;
  targetRows: number | null;
  joinCount: number | null;
}

/** Normalize the runner's `/diff` payload into shared column-impact rows. */
export function parseTableDiff(payload: unknown): TableDiffResult[] {
  const diffs = (payload as { diffs?: unknown } | null)?.diffs;
  if (!Array.isArray(diffs)) return [];
  return diffs.map((d) => {
    const raw = d as Record<string, unknown>;
    const columns: ColumnImpact[] = [];
    for (const [name, type] of Object.entries(asColumnMap(raw.columnsAdded))) {
      columns.push({ name, change: 'added', toType: type || undefined });
    }
    for (const [name, type] of Object.entries(asColumnMap(raw.columnsRemoved))) {
      columns.push({ name, change: 'removed', fromType: type || undefined });
    }
    const modified = (raw.columnsModified ?? {}) as Record<string, unknown>;
    for (const [name, pair] of Object.entries(modified)) {
      const types = Array.isArray(pair) ? pair.map((x) => String(x)) : [String(pair)];
      columns.push({ name, change: 'type-changed', fromType: types[0], toType: types[1] });
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      model: String(raw.model ?? ''),
      source: String(raw.source ?? ''),
      target: String(raw.target ?? ''),
      columns,
      sourceRows: num(raw.sourceRows),
      targetRows: num(raw.targetRows),
      joinCount: num(raw.joinCount),
    };
  });
}

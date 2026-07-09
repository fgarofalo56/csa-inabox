/**
 * dlt-spec.ts — the Lakeflow Declarative Pipelines (DLT) visual-model compiler
 * (Wave 10, DBX-3).
 *
 * The pipeline editor (`pipeline-editor.tsx`) authors a DLT pipeline as a typed
 * node/edge graph — Source → Streaming table / Materialized view datasets, with
 * Expectation nodes attached to a dataset. This module is the PURE, unit-tested
 * core that:
 *
 *   1. `validateDltModel(model)`  — returns a list of human-readable problems so
 *      the editor can gate Save (no vaporware: an invalid model never reaches
 *      the Databricks REST).
 *   2. `compileDltSql(model)`     — emits the real Databricks DLT SQL source
 *      (`CREATE OR REFRESH STREAMING TABLE … (CONSTRAINT … EXPECT …) AS SELECT
 *      … FROM STREAM read_files(...)` / `CREATE OR REFRESH MATERIALIZED VIEW …`)
 *      that becomes the pipeline's notebook/file library.
 *   3. `compileDltPipelineSpec(model, libraryPath)` — emits the
 *      `DltPipelineCreateSpec` (name, library, catalog/target, continuous,
 *      photon, serverless, channel, configuration) sent to
 *      `POST /api/2.0/pipelines`.
 *   4. `parseLibraryGraph(spec)`  — derives a render graph (library nodes +
 *      target) from an EXISTING pipeline's spec returned by
 *      `GET /api/2.0/pipelines/{id}` so the canvas can show a real pipeline.
 *
 * There is NO freeform JSON config anywhere: the editor drives every field via
 * dropdowns / typed inputs; only the dataset `query` and the expectation
 * `condition` are free-text SQL surfaces (a query / expression surface, which
 * loom_no_freeform_config explicitly allows — 1:1 with the Databricks editor).
 *
 * SQL-injection posture: object names are back-tick quoted through
 * `quoteIdent(name, 'databricks-sql')` and string literals (ADLS paths) are
 * escaped through `escapeSqlLiteral` from lib/sql/quoting.ts. `query` /
 * `condition` are analyst-authored SQL fragments (the same trust model as the
 * SQL editor itself) and are emitted verbatim inside the generated source.
 *
 * Backend: drives the bound Databricks workspace's Pipelines REST. No bicep, no
 * Microsoft Fabric (no-fabric-dependency): this item only applies when
 * Databricks is the chosen backend; Loom's Synapse/ADF `data-pipeline` remains
 * the Azure-native default pipeline surface.
 */

import { escapeSqlLiteral, quoteIdent } from '@/lib/sql/quoting';

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

/** A dataset kind authored on the canvas. */
export type DltDatasetKind = 'streaming_table' | 'materialized_view';

/** Canvas node kinds. */
export type DltNodeKind = 'source' | DltDatasetKind | 'expectation';

/** Auto Loader file formats supported by `read_files(...)`. */
export type DltFileFormat = 'csv' | 'json' | 'parquet' | 'avro' | 'text';
export const DLT_FILE_FORMATS: readonly DltFileFormat[] = ['csv', 'json', 'parquet', 'avro', 'text'];

/**
 * Expectation on-violation behaviour, mapped to real DLT constraint syntax:
 *   - 'warn' → `CONSTRAINT n EXPECT (cond)`                    (record + keep)
 *   - 'drop' → `CONSTRAINT n EXPECT (cond) ON VIOLATION DROP ROW`
 *   - 'fail' → `CONSTRAINT n EXPECT (cond) ON VIOLATION FAIL UPDATE`
 */
export type DltExpectationAction = 'warn' | 'drop' | 'fail';
export const DLT_EXPECTATION_ACTIONS: readonly DltExpectationAction[] = ['warn', 'drop', 'fail'];

/** How a source feeds its datasets. */
export type DltSourceKind = 'files' | 'table';

export interface DltNodePosition {
  x: number;
  y: number;
}

interface DltNodeCommon {
  /** Stable client id (canvas + edge references). */
  id: string;
  kind: DltNodeKind;
  /** Canvas position (persisted so the layout round-trips). */
  position?: DltNodePosition;
}

/** A pipeline input — Auto Loader over an ADLS path, or a UC table stream. */
export interface DltSourceNode extends DltNodeCommon {
  kind: 'source';
  /** Alias used to reference this source in an auto-generated SELECT. */
  name: string;
  sourceKind: DltSourceKind;
  /** abfss:// (or dbfs) path — required when sourceKind === 'files'. */
  path?: string;
  fileFormat?: DltFileFormat;
  /** `catalog.schema.table` — required when sourceKind === 'table'. */
  tableName?: string;
}

/** A streaming table / materialized view dataset produced by the pipeline. */
export interface DltDatasetNode extends DltNodeCommon {
  kind: DltDatasetKind;
  /** Unqualified dataset name (published into the pipeline target schema). */
  name: string;
  /**
   * Optional explicit SELECT body. When omitted the compiler auto-generates a
   * `SELECT * FROM [STREAM] <upstream>` from the single wired source. A query
   * surface is an allowed free-text SQL surface (loom_no_freeform_config).
   */
  query?: string;
  comment?: string;
}

/** An expectation attached (by edge) to a dataset. */
export interface DltExpectationNode extends DltNodeCommon {
  kind: 'expectation';
  name: string;
  /** Boolean SQL expression, e.g. `id IS NOT NULL`. */
  condition: string;
  action: DltExpectationAction;
}

export type DltNode = DltSourceNode | DltDatasetNode | DltExpectationNode;

/** A directed wire: source→dataset, expectation→dataset, or dataset→dataset. */
export interface DltEdge {
  id: string;
  source: string;   // upstream node id
  target: string;   // downstream node id
}

/** DLT pipeline runtime channel (mirrors the Pipelines REST `channel`). */
export type DltChannel = 'CURRENT' | 'PREVIEW';

/** The full authored model persisted to the item's Cosmos state. */
export interface DltPipelineModel {
  name: string;
  /** UC catalog the pipeline publishes into (UC-first; Hive metastore if unset). */
  catalog?: string;
  /** Target schema for published tables. */
  target?: string;
  /** true = continuous streaming; false = triggered (default). */
  continuous: boolean;
  /** true = development mode (default); false = production. */
  development: boolean;
  photon: boolean;
  serverless: boolean;
  channel: DltChannel;
  nodes: DltNode[];
  edges: DltEdge[];
  /** Extra pipeline `configuration` key/values (typed rows, not a JSON blob). */
  configuration?: Record<string, string>;
}

/** A fresh, empty model with the Azure-first defaults. */
export function emptyDltModel(name = 'New DLT pipeline'): DltPipelineModel {
  return {
    name,
    continuous: false,
    development: true,
    photon: true,
    serverless: true,
    channel: 'CURRENT',
    nodes: [],
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A Databricks object identifier: letters, digits, underscores; not empty. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Type guards. */
export function isDataset(n: DltNode): n is DltDatasetNode {
  return n.kind === 'streaming_table' || n.kind === 'materialized_view';
}
export function isSource(n: DltNode): n is DltSourceNode {
  return n.kind === 'source';
}
export function isExpectation(n: DltNode): n is DltExpectationNode {
  return n.kind === 'expectation';
}

/** Upstream node ids feeding `datasetId` (sources + upstream datasets). */
export function upstreamOf(model: DltPipelineModel, datasetId: string): string[] {
  return model.edges.filter((e) => e.target === datasetId).map((e) => e.source);
}

/** Expectation nodes attached to `datasetId`. */
export function expectationsOf(model: DltPipelineModel, datasetId: string): DltExpectationNode[] {
  const attachedIds = new Set(
    model.edges.filter((e) => e.target === datasetId).map((e) => e.source),
  );
  return model.nodes.filter(
    (n): n is DltExpectationNode => isExpectation(n) && attachedIds.has(n.id),
  );
}

/**
 * Validate the model, returning a list of problems (empty = OK). The editor
 * disables Save while any problem exists so an invalid pipeline never reaches
 * the Databricks REST.
 */
export function validateDltModel(model: DltPipelineModel): string[] {
  const problems: string[] = [];

  if (!model.name?.trim()) problems.push('Pipeline needs a name.');

  const datasets = model.nodes.filter(isDataset);
  if (datasets.length === 0) {
    problems.push('Add at least one streaming table or materialized view.');
  }

  // Dataset names must be valid + unique (they become published object names).
  const seen = new Map<string, number>();
  for (const d of datasets) {
    const nm = (d.name || '').trim();
    if (!nm) {
      problems.push('Every dataset needs a name.');
    } else if (!IDENT_RE.test(nm)) {
      problems.push(`Dataset "${nm}" is not a valid name (letters, digits, underscore; must not start with a digit).`);
    }
    seen.set(nm.toLowerCase(), (seen.get(nm.toLowerCase()) ?? 0) + 1);
  }
  for (const [nm, count] of seen) {
    if (count > 1 && nm) problems.push(`Duplicate dataset name "${nm}".`);
  }

  // A dataset needs either an explicit query or exactly one wired source.
  for (const d of datasets) {
    const hasQuery = !!d.query?.trim();
    const ups = upstreamOf(model, d.id).filter((sid) => {
      const n = model.nodes.find((x) => x.id === sid);
      return n && (isSource(n) || isDataset(n));
    });
    if (!hasQuery && ups.length === 0) {
      problems.push(`Dataset "${d.name || d.id}" has no query and no wired source.`);
    }
    if (!hasQuery && ups.length > 1) {
      problems.push(`Dataset "${d.name || d.id}" has ${ups.length} sources but no explicit query — wire exactly one source or write a query.`);
    }
  }

  // Sources must be fully specified.
  for (const s of model.nodes.filter(isSource)) {
    if (s.sourceKind === 'files' && !s.path?.trim()) {
      problems.push(`File source "${s.name || s.id}" needs a path.`);
    }
    if (s.sourceKind === 'table' && !s.tableName?.trim()) {
      problems.push(`Table source "${s.name || s.id}" needs a table name.`);
    }
  }

  // Expectations must have a name + condition and be attached to a dataset.
  for (const x of model.nodes.filter(isExpectation)) {
    if (!x.name?.trim()) problems.push('Every expectation needs a name.');
    else if (!IDENT_RE.test(x.name.trim())) problems.push(`Expectation "${x.name}" is not a valid constraint name.`);
    if (!x.condition?.trim()) problems.push(`Expectation "${x.name || x.id}" needs a condition.`);
    const attachedToDataset = model.edges.some((e) => {
      if (e.source !== x.id) return false;
      const t = model.nodes.find((n) => n.id === e.target);
      return !!t && isDataset(t);
    });
    if (!attachedToDataset) problems.push(`Expectation "${x.name || x.id}" is not attached to a dataset.`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// SQL compilation
// ---------------------------------------------------------------------------

/** Quote a `catalog.schema.table` (or bare name) part-by-part with back-ticks. */
function quoteQualified(name: string): string {
  return name
    .split('.')
    .map((p) => quoteIdent(p.trim(), 'databricks-sql'))
    .join('.');
}

/** A single-quoted, escaped SQL string literal (ADLS paths etc.). */
function sqlString(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

/** The `read_files(...)` / table reference a source contributes to a SELECT. */
function sourceRelation(src: DltSourceNode, streaming: boolean): string {
  if (src.sourceKind === 'files') {
    const fmt = DLT_FILE_FORMATS.includes(src.fileFormat as DltFileFormat)
      ? (src.fileFormat as DltFileFormat)
      : 'json';
    const rf = `read_files(${sqlString(src.path || '')}, format => ${sqlString(fmt)})`;
    return streaming ? `STREAM ${rf}` : rf;
  }
  // Table source.
  const rel = quoteQualified(src.tableName || '');
  return streaming ? `STREAM ${rel}` : rel;
}

/** The auto-generated (or explicit) SELECT body for a dataset. */
function datasetQuery(model: DltPipelineModel, d: DltDatasetNode): string {
  if (d.query?.trim()) return d.query.trim().replace(/;\s*$/, '');
  const streaming = d.kind === 'streaming_table';
  const ups = upstreamOf(model, d.id)
    .map((sid) => model.nodes.find((n) => n.id === sid))
    .filter((n): n is DltSourceNode | DltDatasetNode => !!n && (isSource(n) || isDataset(n)));
  const up = ups[0];
  if (!up) return 'SELECT 1';
  if (isSource(up)) return `SELECT * FROM ${sourceRelation(up, streaming)}`;
  // Upstream dataset (chained transform): reference by its published name.
  const rel = quoteIdent(up.name, 'databricks-sql');
  return `SELECT * FROM ${streaming ? `STREAM ${rel}` : rel}`;
}

/** One `CONSTRAINT … EXPECT (…)` clause. */
function expectationClause(x: DltExpectationNode): string {
  const base = `CONSTRAINT ${quoteIdent(x.name.trim(), 'databricks-sql')} EXPECT (${x.condition.trim()})`;
  if (x.action === 'drop') return `${base} ON VIOLATION DROP ROW`;
  if (x.action === 'fail') return `${base} ON VIOLATION FAIL UPDATE`;
  return base;
}

/** The `CREATE OR REFRESH …` statement for one dataset. */
function datasetStatement(model: DltPipelineModel, d: DltDatasetNode): string {
  const keyword = d.kind === 'streaming_table' ? 'STREAMING TABLE' : 'MATERIALIZED VIEW';
  const name = quoteIdent(d.name.trim(), 'databricks-sql');
  const expectations = expectationsOf(model, d.id);
  const lines: string[] = [`CREATE OR REFRESH ${keyword} ${name}`];
  if (expectations.length > 0) {
    lines.push('(');
    lines.push(expectations.map((x) => `  ${expectationClause(x)}`).join(',\n'));
    lines.push(')');
  }
  if (d.comment?.trim()) lines.push(`COMMENT ${sqlString(d.comment.trim())}`);
  lines.push(`AS ${datasetQuery(model, d)}`);
  return lines.join('\n') + ';';
}

/**
 * Compile the model to the real Databricks DLT SQL source that becomes the
 * pipeline's library. Datasets are emitted in stable node order (DLT resolves
 * the dependency graph itself, so textual order is not significant).
 */
export function compileDltSql(model: DltPipelineModel): string {
  const header = [
    `-- Lakeflow Declarative Pipeline: ${model.name}`,
    '-- Generated by CSA Loom — edit on the canvas, not here.',
    '',
  ].join('\n');
  const body = model.nodes
    .filter(isDataset)
    .map((d) => datasetStatement(model, d))
    .join('\n\n');
  return `${header}${body}\n`;
}

// ---------------------------------------------------------------------------
// Pipeline spec compilation (POST /api/2.0/pipelines body)
// ---------------------------------------------------------------------------

/** The create-spec shape sent to the Pipelines REST (mirrors the client type). */
export interface CompiledDltPipelineSpec {
  name: string;
  libraries: Array<{ notebook?: { path: string }; file?: { path: string } }>;
  continuous: boolean;
  development: boolean;
  photon: boolean;
  serverless: boolean;
  channel: DltChannel;
  catalog?: string;
  target?: string;
  configuration?: Record<string, string>;
}

/**
 * Compile the create-spec. `libraryPath` is the workspace notebook path the
 * compiled SQL was imported to (the caller writes it via the Workspace Import
 * REST, then passes the path here).
 */
export function compileDltPipelineSpec(
  model: DltPipelineModel,
  libraryPath: string,
): CompiledDltPipelineSpec {
  const spec: CompiledDltPipelineSpec = {
    name: model.name.trim(),
    libraries: [{ notebook: { path: libraryPath } }],
    continuous: model.continuous,
    development: model.development,
    photon: model.photon,
    serverless: model.serverless,
    channel: model.channel,
  };
  if (model.catalog?.trim()) spec.catalog = model.catalog.trim();
  if (model.target?.trim()) spec.target = model.target.trim();
  // Build a fresh object from typed rows (never merge client-arbitrary keys onto
  // a shared object — prototype-pollution safe).
  if (model.configuration) {
    const cfg: Record<string, string> = {};
    for (const [k, v] of Object.entries(model.configuration)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (k.trim()) cfg[k] = String(v ?? '');
    }
    if (Object.keys(cfg).length) spec.configuration = cfg;
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Existing-pipeline render graph (GET /api/2.0/pipelines/{id} → nodes/edges)
// ---------------------------------------------------------------------------

/** A minimal render node for the canvas (existing-pipeline view). */
export interface RenderNode {
  id: string;
  kind: DltNodeKind | 'library' | 'target';
  label: string;
  sublabel?: string;
}
export interface RenderGraph {
  nodes: RenderNode[];
  edges: DltEdge[];
}

interface RawPipelineSpec {
  name?: string;
  catalog?: string;
  target?: string;
  libraries?: Array<{
    notebook?: { path?: string };
    file?: { path?: string };
    glob?: { include?: string };
  }>;
}

/**
 * Derive a render graph from an EXISTING pipeline's spec: one node per library
 * (notebook / file / glob) wired to a single target-schema node. This is the
 * honest, no-parse view for a pipeline authored outside Loom (we do not have
 * its dataset graph without executing it); a Loom-authored pipeline renders its
 * full node model instead.
 */
export function parseLibraryGraph(spec: RawPipelineSpec | undefined): RenderGraph {
  const nodes: RenderNode[] = [];
  const edges: DltEdge[] = [];
  const libraries = spec?.libraries ?? [];

  const targetLabel = [spec?.catalog, spec?.target].filter(Boolean).join('.') || 'target schema';
  const targetId = '__target__';

  libraries.forEach((lib, i) => {
    const path = lib.notebook?.path || lib.file?.path || lib.glob?.include || `library ${i + 1}`;
    const kind = lib.notebook ? 'source' : lib.file ? 'source' : 'source';
    const id = `lib-${i}`;
    nodes.push({
      id,
      kind: 'library' as const,
      label: path.split('/').pop() || path,
      sublabel: lib.notebook ? 'notebook' : lib.file ? 'file' : 'glob',
    });
    edges.push({ id: `e-${i}`, source: id, target: targetId });
    void kind;
  });

  nodes.push({ id: targetId, kind: 'target', label: targetLabel, sublabel: 'published tables' });
  return { nodes, edges };
}

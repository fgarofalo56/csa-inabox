/**
 * N4 — `transformation-project` data model: ONE project, TWO engines.
 *
 * The item persists a single, engine-neutral model graph plus a **backend
 * selector**. dbt stays the DEFAULT (`'dbt'`) for continuity — the whole dbt
 * ecosystem (adapters, packages, generic tests, docs, and the
 * `target/manifest.json` artifact the L6 lineage parser already consumes) keeps
 * working exactly as it does today. Selecting `'sqlmesh'` re-plans the SAME
 * model set through SQLMesh so the project additionally gets virtual data
 * environments, Terraform-style plan/apply, and column-level model diff.
 *
 * Per `loom_no_freeform_config` the whole surface is dropdowns/wizard/canvas —
 * **SQL is the one allowed freeform slot** (per-model SQL bodies, the 1:1
 * transformation-IDE exception).
 *
 * Per `no-fabric-dependency` the engines are Azure-native/OSS by default
 * (Synapse dedicated SQL pool, Databricks SQL, DuckDB-over-ADLS for the
 * disconnected case). Fabric Warehouse is a selectable engine only, never
 * required and never the default.
 *
 * PURE data + functions — NO server-only imports, so the editor, the wizard,
 * and the BFF routes all share one source of truth.
 */

/** Which transformation engine runs the project. `dbt` is the DEFAULT. */
export type TransformBackend = 'dbt' | 'sqlmesh';

/**
 * The default backend for every new transformation-project (continuity: an
 * existing dbt user's project keeps running through dbt unless they opt in).
 */
export const DEFAULT_TRANSFORM_BACKEND: TransformBackend = 'dbt';

/** Physical engine the generated project targets. Fabric is opt-in only. */
export type TransformEngine = 'synapse' | 'databricks' | 'duckdb' | 'fabric';

/** Medallion layer — drives folder placement + the default materialization. */
export type TransformLayer = 'bronze' | 'silver' | 'gold';

/** Materialization strategy (the shared subset both engines express). */
export type TransformMaterialization = 'view' | 'table' | 'incremental' | 'ephemeral';

/** A raw upstream table the project reads from. */
export interface TransformSource {
  /** Source group name — dbt `source('<name>', …)` / SQLMesh external model schema. */
  name: string;
  schema: string;
  table: string;
  description?: string;
}

/** A generic test attached to a model column (or the model itself). */
export interface TransformTest {
  column?: string;
  type: 'unique' | 'not_null' | 'accepted_values' | 'relationships';
  values?: string[];
  to?: string;
  field?: string;
}

/** One model node in the DAG (a software-defined asset). */
export interface TransformModel {
  /** Unique model name. Becomes `models/<layer>/<name>.sql`. */
  name: string;
  layer: TransformLayer;
  materialized: TransformMaterialization;
  /** The SQL body — the ONE allowed freeform surface. */
  sql: string;
  /** Upstream model names (ref() edges). */
  refs?: string[];
  /** Upstream source keys, `"<sourceName>.<table>"`. */
  sources?: string[];
  tests?: TransformTest[];
  description?: string;
  /** incremental only — the merge key. */
  uniqueKey?: string;
  /** SQLMesh only: the model's cron cadence (dropdown, not freeform). */
  cron?: '@hourly' | '@daily' | '@weekly' | '@monthly';
  /** Asset ownership metadata (feeds the N5 software-defined-asset plane). */
  owners?: string[];
  tags?: string[];
}

/** The connection target the generated project points at. */
export interface TransformTarget {
  engine: TransformEngine;
  /** Synapse: server FQDN (`<ws>.sql.azuresynapse.net`). */
  synapseServer?: string;
  /** Databricks: workspace FQDN + SQL warehouse http_path. */
  databricksHost?: string;
  databricksHttpPath?: string;
  /** Databricks Unity Catalog (defaults to 'main'). */
  catalog?: string;
  /** Synapse / Fabric database name. */
  database?: string;
  /** DuckDB (sovereign / disconnected): the .duckdb path under the mounted lake. */
  duckdbPath?: string;
  /** Fabric warehouse endpoint — opt-in only. */
  fabricEndpoint?: string;
  /** Default schema every model builds into. */
  schema?: string;
  threads?: number;
}

/** A SQLMesh virtual data environment. `prod` always exists. */
export interface TransformEnvironment {
  name: string;
  /** True for `prod` — apply requires an explicit confirmation. */
  isProd?: boolean;
  description?: string;
}

/** The full project persisted to Cosmos under the item's `state.project`. */
export interface TransformProject {
  /** Which engine plans/applies this project. Defaults to 'dbt'. */
  backend: TransformBackend;
  projectName: string;
  profileName: string;
  sources: TransformSource[];
  models: TransformModel[];
  target: TransformTarget;
  /** SQLMesh only — ignored by the dbt backend. */
  environments: TransformEnvironment[];
  /** The environment the plan/apply wizard opens on. */
  defaultEnvironment: string;
}

/** The recommended materialization per medallion layer. */
export function defaultMaterializationForLayer(layer: TransformLayer): TransformMaterialization {
  switch (layer) {
    case 'bronze': return 'view';
    case 'silver': return 'table';
    case 'gold': return 'table';
    default: return 'view';
  }
}

/**
 * Resolve the backend for a persisted item state. An item written before N4 —
 * or one whose selector carries anything unrecognised — resolves to `'dbt'`,
 * the continuity default. NEVER throws; the selector can't break an open.
 */
export function resolveTransformBackend(state: unknown): TransformBackend {
  const raw = (state as { backend?: unknown; project?: { backend?: unknown } } | null | undefined);
  const candidate = raw?.project?.backend ?? raw?.backend;
  return candidate === 'sqlmesh' ? 'sqlmesh' : DEFAULT_TRANSFORM_BACKEND;
}

/** An empty, valid starter project (a fresh item opens on this — never an error). */
export function emptyTransformProject(projectName = 'loom_transform_project'): TransformProject {
  return {
    backend: DEFAULT_TRANSFORM_BACKEND,
    projectName,
    profileName: projectName,
    sources: [],
    models: [],
    target: { engine: 'synapse', schema: 'analytics', catalog: 'main', threads: 4 },
    environments: [
      { name: 'prod', isProd: true, description: 'The production environment. Applying here swaps the production views.' },
      { name: 'dev', description: 'A virtual environment — views over the same physical tables. Cheap to create, cheap to throw away.' },
    ],
    defaultEnvironment: 'dev',
  };
}

/** True when the project has at least one model (there is something to plan). */
export function projectHasContent(p?: TransformProject | null): boolean {
  return !!p && Array.isArray(p.models) && p.models.length > 0;
}

/** A field-level validation problem. */
export interface TransformValidationError {
  field: string;
  message: string;
}

/**
 * Server-side validation before any codegen / plan runs. The generator assumes a
 * well-formed project; a malformed one must answer 400 with field-level errors,
 * never a 502 from an unguarded TypeError (the dbt-job B10 lesson).
 */
export function validateTransformProject(p: unknown): TransformValidationError[] {
  const errors: TransformValidationError[] = [];
  if (!p || typeof p !== 'object') {
    return [{ field: 'project', message: 'project is required' }];
  }
  const project = p as Partial<TransformProject>;

  if (project.backend !== undefined && project.backend !== 'dbt' && project.backend !== 'sqlmesh') {
    errors.push({ field: 'backend', message: 'backend must be "dbt" or "sqlmesh"' });
  }

  if (!Array.isArray(project.sources)) {
    errors.push({ field: 'sources', message: 'sources must be an array (use [] when there are no sources)' });
  } else {
    project.sources.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        errors.push({ field: `sources[${i}]`, message: 'source must be an object' });
        return;
      }
      if (!s.name) errors.push({ field: `sources[${i}].name`, message: 'source name is required' });
      if (!s.table) errors.push({ field: `sources[${i}].table`, message: 'source table is required' });
    });
  }

  const validLayers = new Set<TransformLayer>(['bronze', 'silver', 'gold']);
  if (!Array.isArray(project.models)) {
    errors.push({ field: 'models', message: 'models must be an array' });
  } else {
    if (project.models.length === 0) {
      errors.push({ field: 'models', message: 'at least one model is required to plan' });
    }
    const seen = new Set<string>();
    project.models.forEach((m, i) => {
      if (!m || typeof m !== 'object') {
        errors.push({ field: `models[${i}]`, message: 'model must be an object' });
        return;
      }
      if (!m.name) errors.push({ field: `models[${i}].name`, message: 'model name is required' });
      else if (seen.has(m.name)) errors.push({ field: `models[${i}].name`, message: `duplicate model name "${m.name}"` });
      else seen.add(m.name);
      if (!m.layer) errors.push({ field: `models[${i}].layer`, message: 'model layer is required (bronze | silver | gold)' });
      else if (!validLayers.has(m.layer)) errors.push({ field: `models[${i}].layer`, message: `invalid layer "${m.layer}" (expected bronze | silver | gold)` });
      if (typeof m.sql !== 'string') errors.push({ field: `models[${i}].sql`, message: 'model sql body is required' });
    });
  }

  if (!project.target || typeof project.target !== 'object' || !project.target.engine) {
    errors.push({ field: 'target.engine', message: 'target engine is required (synapse | databricks | duckdb | fabric)' });
  }

  const backend = project.backend === 'sqlmesh' ? 'sqlmesh' : 'dbt';
  if (backend === 'sqlmesh') {
    if (!Array.isArray(project.environments) || project.environments.length === 0) {
      errors.push({ field: 'environments', message: 'SQLMesh projects need at least one environment (prod is created by default)' });
    } else if (project.defaultEnvironment
      && !project.environments.some((e) => e && e.name === project.defaultEnvironment)) {
      errors.push({ field: 'defaultEnvironment', message: `"${project.defaultEnvironment}" is not one of the project's environments` });
    }
  }

  return errors;
}

/** Model names referenced by a ref() that has no matching model in the project. */
export function findDanglingRefs(p: TransformProject): Array<{ model: string; ref: string }> {
  const names = new Set((p.models || []).map((m) => m.name));
  const out: Array<{ model: string; ref: string }> = [];
  for (const m of p.models || []) {
    for (const r of m.refs || []) {
      if (!names.has(r)) out.push({ model: m.name, ref: r });
    }
  }
  return out;
}

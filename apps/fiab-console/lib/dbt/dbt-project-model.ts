/**
 * CSA Loom — dbt visual builder data model.
 *
 * A typed, serializable representation of a dbt project that the visual
 * builder edits and the code generator (dbt-codegen.ts) turns into real dbt
 * project files (dbt_project.yml, profiles.yml, models/**.sql, sources.yml,
 * schema.yml). This is the single source of truth persisted to Cosmos under
 * `dbt-job` item `state.project`.
 *
 * Per no-freeform-config.md: the graph is built through dropdowns / wizards /
 * canvas — the only freeform slots are the per-model SQL bodies (the 1:1
 * dbt-IDE editor exception) and single Jinja/SQL expressions.
 *
 * Per no-fabric-dependency.md: the default adapter targets are Azure-native
 * (Databricks / Synapse). Fabric Warehouse is a selectable adapter only, never
 * required and never the default.
 */

/** Medallion layer a model belongs to — drives folder + default materialization. */
export type MedallionLayer = 'bronze' | 'silver' | 'gold';

/** dbt materialization strategy. */
export type Materialization = 'view' | 'table' | 'incremental' | 'ephemeral';

/** Supported dbt adapter targets. Databricks + Synapse are Azure-native; Fabric is opt-in. */
export type DbtAdapter = 'databricks' | 'synapse' | 'fabric';

/** A generic-test definition attached to a model column (or model-level). */
export interface DbtTest {
  /** Column the test applies to. Omitted = model-level test. */
  column?: string;
  type: 'unique' | 'not_null' | 'accepted_values' | 'relationships';
  /** accepted_values: the allowed values. */
  values?: string[];
  /** relationships: the referenced model + field. */
  to?: string;
  field?: string;
}

/** A dbt source table (raw, ingested data the project reads from). */
export interface DbtSource {
  /** Source group name (the `source('<name>', …)` first arg). */
  name: string;
  /** Physical schema/database the source lives in. */
  schema: string;
  /** Physical table name (the `source(…, '<table>')` second arg). */
  table: string;
  /** Optional freshness warn/error thresholds (hours). */
  freshnessWarnHours?: number;
  freshnessErrorHours?: number;
  description?: string;
}

/** A dbt model node in the DAG. */
export interface DbtModel {
  /** Unique model name (file becomes models/<layer>/<name>.sql). */
  name: string;
  layer: MedallionLayer;
  materialized: Materialization;
  /** The SQL body. May contain {{ ref('x') }} / {{ source('s','t') }} Jinja. */
  sql: string;
  /** Upstream model names referenced via ref(). Drives DAG edges + lineage. */
  refs?: string[];
  /** Upstream source keys referenced via source() — "<sourceName>.<table>". */
  sources?: string[];
  /** Generic tests attached to this model / its columns. */
  tests?: DbtTest[];
  description?: string;
  /** incremental only: unique key for the merge. */
  uniqueKey?: string;
}

/** The connection target a generated profiles.yml points at. */
export interface DbtTarget {
  adapter: DbtAdapter;
  /**
   * Databricks: workspace FQDN baked into the generated profiles.yml `host`
   * (e.g. adb-123.4.azuredatabricks.net). Left blank in the visual builder —
   * the run BFF defaults it from the console's `LOOM_DATABRICKS_HOSTNAME` so
   * the pushed profile carries a literal host the dbt CLI compute can reach.
   */
  databricksHost?: string;
  /** Databricks: SQL warehouse http_path OR all-purpose-compute ODBC path used by the dbt task. */
  databricksHttpPath?: string;
  /** Databricks workspace catalog (Unity Catalog) — defaults to 'main'. */
  catalog?: string;
  /** Synapse: server FQDN (<ws>.sql.azuresynapse.net). */
  synapseServer?: string;
  /** Synapse / Fabric: database name. */
  database?: string;
  /** Default schema all models are built into. */
  schema?: string;
  /** Fabric: warehouse server endpoint (opt-in only). */
  fabricEndpoint?: string;
  /** Number of dbt threads. */
  threads?: number;
}

/** The full project graph persisted to Cosmos. */
export interface DbtProjectGraph {
  /** dbt project name (becomes dbt_project.yml `name`). */
  projectName: string;
  /** Profile name referenced by dbt_project.yml + profiles.yml top key. */
  profileName: string;
  sources: DbtSource[];
  models: DbtModel[];
  target: DbtTarget;
}

/** Default materialization recommended per medallion layer. */
export function defaultMaterializationForLayer(layer: MedallionLayer): Materialization {
  switch (layer) {
    case 'bronze': return 'view';
    case 'silver': return 'table';
    case 'gold': return 'table';
    default: return 'view';
  }
}

/** An empty, valid starter graph (used when an item has no project yet). */
export function emptyProjectGraph(projectName = 'loom_dbt_project'): DbtProjectGraph {
  return {
    projectName,
    profileName: projectName,
    sources: [],
    models: [],
    target: { adapter: 'databricks', catalog: 'main', schema: 'analytics', threads: 4 },
  };
}

/** True when the graph has at least one model — the builder has real content to generate. */
export function projectHasContent(g?: DbtProjectGraph | null): boolean {
  return !!g && Array.isArray(g.models) && g.models.length > 0;
}

/** A single field-level validation problem ({ field, message }). */
export interface DbtGraphValidationError {
  field: string;
  message: string;
}

/**
 * Server-side validation of a DbtProjectGraph before any code generation runs.
 *
 * The code generator (dbt-codegen.ts) assumes a well-formed graph: `sources` and
 * `models` are arrays, `target.adapter` is set, and every model has a `name` +
 * `layer`. A malformed graph (missing `sources[]`, a model with no `layer`, etc.)
 * previously crashed codegen with an unguarded TypeError ("Cannot read
 * properties of undefined (reading 'length')") which surfaced as a raw 502
 * (audit B10). This returns precise field-level errors so the run route can
 * answer 400 instead. Returns [] when the graph is safe to generate.
 */
export function validateDbtProjectGraph(g: unknown): DbtGraphValidationError[] {
  const errors: DbtGraphValidationError[] = [];
  if (!g || typeof g !== 'object') {
    return [{ field: 'project', message: 'project graph is required' }];
  }
  const graph = g as Partial<DbtProjectGraph>;

  if (!Array.isArray(graph.sources)) {
    errors.push({ field: 'sources', message: 'sources must be an array (use [] when there are no sources)' });
  } else {
    graph.sources.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        errors.push({ field: `sources[${i}]`, message: 'source must be an object' });
        return;
      }
      if (!s.name) errors.push({ field: `sources[${i}].name`, message: 'source name is required' });
      if (!s.table) errors.push({ field: `sources[${i}].table`, message: 'source table is required' });
    });
  }

  if (!Array.isArray(graph.models)) {
    errors.push({ field: 'models', message: 'models must be an array' });
  } else {
    if (graph.models.length === 0) {
      errors.push({ field: 'models', message: 'at least one model is required to run' });
    }
    const validLayers = new Set<MedallionLayer>(['bronze', 'silver', 'gold']);
    graph.models.forEach((m, i) => {
      if (!m || typeof m !== 'object') {
        errors.push({ field: `models[${i}]`, message: 'model must be an object' });
        return;
      }
      if (!m.name) errors.push({ field: `models[${i}].name`, message: 'model name is required' });
      if (!m.layer) errors.push({ field: `models[${i}].layer`, message: 'model layer is required (bronze | silver | gold)' });
      else if (!validLayers.has(m.layer)) errors.push({ field: `models[${i}].layer`, message: `invalid layer "${m.layer}" (expected bronze | silver | gold)` });
      if (typeof m.sql !== 'string') errors.push({ field: `models[${i}].sql`, message: 'model sql body is required' });
    });
  }

  if (!graph.target || typeof graph.target !== 'object' || !graph.target.adapter) {
    errors.push({ field: 'target.adapter', message: 'target adapter is required (databricks | synapse | fabric)' });
  }

  return errors;
}

/**
 * CSA Loom — dbt project file generator.
 *
 * Pure, dependency-free functions that turn a DbtProjectGraph (the visual
 * builder's model) into the real files of a dbt Core project:
 *
 *   dbt_project.yml
 *   profiles.yml                (generated from DbtTarget — never pasted)
 *   models/sources.yml
 *   models/<layer>/<name>.sql   (with {{ config(materialized=…) }})
 *   models/<layer>/schema.yml   (column + model generic tests)
 *
 * The same project runs on Databricks, Synapse, or Fabric Warehouse by
 * swapping only the adapter `type` in profiles.yml — that portability is the
 * core design lever. Default adapters are Azure-native (Databricks / Synapse);
 * Fabric is opt-in only (no-fabric-dependency.md).
 *
 * A hand-rolled minimal YAML emitter is used (no js-yaml dependency) — the
 * shapes here are small and fully controlled, so a typed emitter keeps the
 * generated files deterministic + golden-testable.
 */

import type {
  DbtProjectGraph, DbtModel, DbtSource, DbtTarget, DbtTest, MedallionLayer,
} from './dbt-project-model';

export interface GeneratedFile {
  /** POSIX-relative path within the dbt project root. */
  path: string;
  content: string;
}

const LAYER_ORDER: MedallionLayer[] = ['bronze', 'silver', 'gold'];

/** Quote a YAML scalar only when needed (keeps golden files readable). */
function yamlScalar(v: string | number | boolean): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '' ) return "''";
  if (/^[A-Za-z0-9_./@$+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** dbt project config (dbt_project.yml). Models are grouped by medallion folder. */
export function generateDbtProjectYml(g: DbtProjectGraph): string {
  const lines: string[] = [];
  lines.push(`name: ${yamlScalar(g.projectName)}`);
  lines.push(`version: '1.0.0'`);
  lines.push(`config-version: 2`);
  lines.push(`profile: ${yamlScalar(g.profileName)}`);
  lines.push('');
  lines.push(`model-paths: ["models"]`);
  lines.push(`seed-paths: ["seeds"]`);
  lines.push(`test-paths: ["tests"]`);
  lines.push(`macro-paths: ["macros"]`);
  lines.push(`target-path: "target"`);
  lines.push(`clean-targets: ["target", "dbt_packages"]`);
  lines.push('');
  // Per-layer +materialized defaults so each medallion folder gets a sensible
  // default even before a model overrides it inline.
  lines.push('models:');
  lines.push(`  ${g.projectName}:`);
  const layersPresent = LAYER_ORDER.filter((l) => g.models.some((m) => m.layer === l));
  if (layersPresent.length === 0) {
    lines.push(`    +materialized: view`);
  } else {
    for (const layer of layersPresent) {
      const def = layer === 'bronze' ? 'view' : 'table';
      lines.push(`    ${layer}:`);
      lines.push(`      +materialized: ${def}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * profiles.yml generated from the target. Auth is always identity-based
 * (Entra / managed identity) — no static secrets are ever written into the file.
 *   - databricks: the documented Databricks "dbt task custom profile" form —
 *     `method: http` + static `host`/`http_path` + `token: env_var('DBT_ACCESS_TOKEN')`.
 *     Databricks AUTO-INJECTS `DBT_ACCESS_TOKEN` for the Run-As principal of every
 *     dbt task (Learn: /azure/databricks/jobs/dbt + .../how-to/use-dbt-in-workflows
 *     "Advanced — run dbt with a custom profile"), so the profile resolves on the
 *     dbt-CLI compute with no Loom-side secret plumbing. host/http_path are baked
 *     literals (host defaulted from LOOM_DATABRICKS_HOSTNAME by the run BFF).
 *   - synapse:    authentication=CLI (the runner's managed identity / az login).
 *   - fabric:     authentication=CLI against the Fabric SQL endpoint (opt-in).
 */
export function generateProfilesYml(g: DbtProjectGraph): string {
  const t = g.target;
  const threads = t.threads || 4;
  const schema = t.schema || 'analytics';
  const out: string[] = [];
  out.push(`${g.profileName}:`);
  out.push(`  target: prod`);
  out.push(`  outputs:`);
  out.push(`    prod:`);
  if (t.adapter === 'databricks') {
    // Custom-profile form recommended by Databricks for dbt tasks: the token is
    // the run-scoped DBT_ACCESS_TOKEN that Databricks injects automatically;
    // host + http_path are static literals (no extra env vars to plumb). When a
    // literal isn't known yet (pure preview), fall back to an env_var() marker so
    // the file stays valid YAML — the run BFF bakes the real host before push.
    out.push(`      type: databricks`);
    out.push(`      method: http`);
    out.push(`      host: ${yamlScalar(t.databricksHost || "{{ env_var('DBT_DATABRICKS_HOST') }}")}`);
    out.push(`      http_path: ${yamlScalar(t.databricksHttpPath || "{{ env_var('DBT_DATABRICKS_HTTP_PATH') }}")}`);
    out.push(`      token: "{{ env_var('DBT_ACCESS_TOKEN') }}"`);
    out.push(`      catalog: ${yamlScalar(t.catalog || 'main')}`);
    out.push(`      schema: ${yamlScalar(schema)}`);
    out.push(`      threads: ${threads}`);
  } else if (t.adapter === 'synapse') {
    out.push(`      type: synapse`);
    out.push(`      driver: 'ODBC Driver 18 for SQL Server'`);
    out.push(`      server: ${yamlScalar(t.synapseServer || "{{ env_var('DBT_SYNAPSE_SERVER') }}")}`);
    out.push(`      database: ${yamlScalar(t.database || "{{ env_var('DBT_SYNAPSE_DATABASE') }}")}`);
    out.push(`      schema: ${yamlScalar(schema)}`);
    out.push(`      authentication: CLI`);
    out.push(`      encrypt: true`);
    out.push(`      trust_cert: false`);
    out.push(`      threads: ${threads}`);
  } else {
    // fabric (opt-in only)
    out.push(`      type: fabric`);
    out.push(`      driver: 'ODBC Driver 18 for SQL Server'`);
    out.push(`      server: ${yamlScalar(t.fabricEndpoint || "{{ env_var('DBT_FABRIC_ENDPOINT') }}")}`);
    out.push(`      database: ${yamlScalar(t.database || "{{ env_var('DBT_FABRIC_DATABASE') }}")}`);
    out.push(`      schema: ${yamlScalar(schema)}`);
    out.push(`      authentication: CLI`);
    out.push(`      encrypt: true`);
    out.push(`      threads: ${threads}`);
  }
  return out.join('\n') + '\n';
}

/** models/sources.yml — the source freshness + table registry. */
export function generateSourcesYml(sources: DbtSource[]): string {
  if (!sources.length) return 'version: 2\n';
  // Group tables under a shared source name (one dbt `source` block per name).
  const byName = new Map<string, DbtSource[]>();
  for (const s of sources) {
    const arr = byName.get(s.name) || [];
    arr.push(s);
    byName.set(s.name, arr);
  }
  const out: string[] = ['version: 2', '', 'sources:'];
  for (const [name, tables] of byName) {
    out.push(`  - name: ${yamlScalar(name)}`);
    // schema is per-table in our model; use the first table's schema as the
    // source-level schema and override per-table when they differ.
    const groupSchema = tables[0].schema;
    out.push(`    schema: ${yamlScalar(groupSchema)}`);
    out.push(`    tables:`);
    for (const tbl of tables) {
      out.push(`      - name: ${yamlScalar(tbl.table)}`);
      if (tbl.description) out.push(`        description: ${yamlScalar(tbl.description)}`);
      if (tbl.schema && tbl.schema !== groupSchema) {
        out.push(`        config:`);
        out.push(`          schema: ${yamlScalar(tbl.schema)}`);
      }
      if (tbl.freshnessWarnHours || tbl.freshnessErrorHours) {
        out.push(`        freshness:`);
        if (tbl.freshnessWarnHours) {
          out.push(`          warn_after: { count: ${tbl.freshnessWarnHours}, period: hour }`);
        }
        if (tbl.freshnessErrorHours) {
          out.push(`          error_after: { count: ${tbl.freshnessErrorHours}, period: hour }`);
        }
        out.push(`        loaded_at_field: _loaded_at`);
      }
    }
  }
  return out.join('\n') + '\n';
}

/** A single model's .sql file body, with a leading config() block. */
export function generateModelSql(m: DbtModel): string {
  const cfg: string[] = [`materialized='${m.materialized}'`];
  if (m.materialized === 'incremental' && m.uniqueKey) {
    cfg.push(`unique_key='${m.uniqueKey.replace(/'/g, "")}'`);
  }
  const header = `{{ config(${cfg.join(', ')}) }}`;
  const body = (m.sql || '').trim();
  const parts = [header];
  if (m.description) parts.push(`-- ${m.description.replace(/\n/g, ' ')}`);
  parts.push('');
  parts.push(body || `select 1 as placeholder -- TODO: author ${m.name}`);
  return parts.join('\n') + '\n';
}

/** schema.yml for one layer folder — model docs + generic tests. */
export function generateSchemaYml(models: DbtModel[]): string {
  if (!models.length) return 'version: 2\n';
  const out: string[] = ['version: 2', '', 'models:'];
  for (const m of models) {
    out.push(`  - name: ${yamlScalar(m.name)}`);
    if (m.description) out.push(`    description: ${yamlScalar(m.description)}`);
    const colTests = (m.tests || []).filter((t) => t.column);
    const modelTests = (m.tests || []).filter((t) => !t.column);
    if (colTests.length) {
      // Group tests by column.
      const byCol = new Map<string, DbtTest[]>();
      for (const t of colTests) {
        const arr = byCol.get(t.column!) || [];
        arr.push(t);
        byCol.set(t.column!, arr);
      }
      out.push(`    columns:`);
      for (const [col, tests] of byCol) {
        out.push(`      - name: ${yamlScalar(col)}`);
        out.push(`        tests:`);
        for (const t of tests) out.push(...renderTest(t, '          '));
      }
    }
    if (modelTests.length) {
      out.push(`    tests:`);
      for (const t of modelTests) out.push(...renderTest(t, '      '));
    }
  }
  return out.join('\n') + '\n';
}

function renderTest(t: DbtTest, indent: string): string[] {
  switch (t.type) {
    case 'unique':
    case 'not_null':
      return [`${indent}- ${t.type}`];
    case 'accepted_values':
      return [
        `${indent}- accepted_values:`,
        `${indent}    values: [${(t.values || []).map((v) => yamlScalar(v)).join(', ')}]`,
      ];
    case 'relationships':
      return [
        `${indent}- relationships:`,
        `${indent}    to: ref('${(t.to || '').replace(/'/g, '')}')`,
        `${indent}    field: ${yamlScalar(t.field || 'id')}`,
      ];
    default:
      return [];
  }
}

/**
 * Generate the complete set of project files from a graph. The returned list is
 * deterministically ordered so a golden test can diff it byte-for-byte.
 */
export function generateProject(g: DbtProjectGraph): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  files.push({ path: 'dbt_project.yml', content: generateDbtProjectYml(g) });
  files.push({ path: 'profiles.yml', content: generateProfilesYml(g) });
  files.push({ path: 'models/sources.yml', content: generateSourcesYml(g.sources) });
  // Per-layer model files + schema.yml.
  for (const layer of LAYER_ORDER) {
    const layerModels = g.models.filter((m) => m.layer === layer);
    if (!layerModels.length) continue;
    for (const m of layerModels) {
      files.push({ path: `models/${layer}/${m.name}.sql`, content: generateModelSql(m) });
    }
    files.push({ path: `models/${layer}/schema.yml`, content: generateSchemaYml(layerModels) });
  }
  // packages.yml + .gitignore for a runnable project skeleton.
  files.push({ path: 'packages.yml', content: 'packages: []\n' });
  files.push({ path: '.gitignore', content: 'target/\ndbt_packages/\nlogs/\n' });
  return files;
}

/** Topologically-validated build order check — returns model names with unknown refs. */
export function findDanglingRefs(g: DbtProjectGraph): { model: string; ref: string }[] {
  const known = new Set(g.models.map((m) => m.name));
  const out: { model: string; ref: string }[] = [];
  for (const m of g.models) {
    for (const r of m.refs || []) {
      if (!known.has(r)) out.push({ model: m.name, ref: r });
    }
  }
  return out;
}

/** dbt command list for a run, honoring an optional --select model subset. */
export function defaultDbtCommands(select?: string[]): string[] {
  const sel = select && select.length ? ` --select ${select.join(' ')}` : '';
  return ['dbt deps', `dbt build${sel}`];
}

/**
 * N4 — project codegen: ONE {@link TransformProject} → real project files for
 * EITHER engine.
 *
 *   backend 'dbt'     → dbt_project.yml + profiles.yml + models/**.sql +
 *                       sources.yml + schema.yml  (identical shape to the
 *                       existing lib/dbt/dbt-codegen output, so the runner's
 *                       `target/manifest.json` is exactly what L6's lineage
 *                       parser already consumes).
 *   backend 'sqlmesh' → config.yaml (gateways) + models/**.sql with a real
 *                       `MODEL (...)` DDL header + external_models.yaml.
 *
 * No credentials are ever written into a generated file: every profile /
 * gateway authenticates with the runner's managed identity.
 *
 * PURE — string building only.
 */

import { escapeSqlLiteral } from '@/lib/sql/quoting';
import type {
  TransformModel, TransformProject, TransformSource, TransformTarget,
} from './transform-project-model';

export interface GeneratedFile {
  path: string;
  content: string;
}

const q = (s: string) => JSON.stringify(String(s ?? ''));

function yamlList(items: string[], indent: string): string {
  return items.map((i) => `${indent}- ${i}`).join('\n');
}

// ── dbt ─────────────────────────────────────────────────────────────────────

function dbtProfile(p: TransformProject): string {
  const t = p.target;
  const threads = t.threads || 4;
  const lines: string[] = [`${p.profileName}:`, '  target: default', '  outputs:', '    default:'];
  switch (t.engine) {
    case 'databricks':
      lines.push(
        '      type: databricks',
        `      host: ${t.databricksHost || '{{ env_var("DBT_DATABRICKS_HOST") }}'}`,
        `      http_path: ${t.databricksHttpPath || '{{ env_var("DBT_DATABRICKS_HTTP_PATH") }}'}`,
        `      catalog: ${t.catalog || 'main'}`,
        `      schema: ${t.schema || 'analytics'}`,
        // Databricks injects a run-scoped DBT_ACCESS_TOKEN for the task's
        // Run-As principal — no secret is plumbed through Loom.
        '      token: "{{ env_var(\'DBT_ACCESS_TOKEN\') }}"',
        `      threads: ${threads}`,
      );
      break;
    case 'duckdb':
      lines.push(
        '      type: duckdb',
        `      path: ${t.duckdbPath || 'loom.duckdb'}`,
        `      schema: ${t.schema || 'analytics'}`,
        `      threads: ${threads}`,
      );
      break;
    case 'fabric':
      // Opt-in only — never the default engine.
      lines.push(
        '      type: fabric',
        '      driver: "ODBC Driver 18 for SQL Server"',
        `      server: ${t.fabricEndpoint || '{{ env_var("DBT_FABRIC_ENDPOINT") }}'}`,
        `      database: ${t.database || '{{ env_var("DBT_FABRIC_DATABASE") }}'}`,
        `      schema: ${t.schema || 'dbo'}`,
        '      authentication: CLI',
        `      threads: ${threads}`,
      );
      break;
    case 'synapse':
    default:
      lines.push(
        '      type: synapse',
        '      driver: "ODBC Driver 18 for SQL Server"',
        `      server: ${t.synapseServer || '{{ env_var("DBT_SYNAPSE_SERVER") }}'}`,
        `      database: ${t.database || '{{ env_var("DBT_SYNAPSE_DATABASE") }}'}`,
        `      schema: ${t.schema || 'dbo'}`,
        '      authentication: CLI',
        `      threads: ${threads}`,
      );
      break;
  }
  return `${lines.join('\n')}\n`;
}

function dbtProjectYml(p: TransformProject): string {
  return [
    `name: ${q(p.projectName)}`,
    "version: '1.0.0'",
    "config-version: 2",
    `profile: ${q(p.profileName)}`,
    'model-paths: ["models"]',
    'target-path: "target"',
    'clean-targets: ["target", "dbt_packages"]',
    'models:',
    `  ${p.projectName}:`,
    '    bronze:', '      +materialized: view',
    '    silver:', '      +materialized: table',
    '    gold:', '      +materialized: table',
    '',
  ].join('\n');
}

function dbtSourcesYml(sources: TransformSource[]): string {
  if (sources.length === 0) return '';
  const groups = new Map<string, TransformSource[]>();
  for (const s of sources) {
    const list = groups.get(s.name) || [];
    list.push(s);
    groups.set(s.name, list);
  }
  const out: string[] = ['version: 2', 'sources:'];
  for (const [name, list] of groups) {
    out.push(`  - name: ${q(name)}`);
    out.push(`    schema: ${q(list[0].schema || name)}`);
    out.push('    tables:');
    for (const s of list) {
      out.push(`      - name: ${q(s.table)}`);
      if (s.description) out.push(`        description: ${q(s.description)}`);
    }
  }
  out.push('');
  return out.join('\n');
}

function dbtSchemaYml(models: TransformModel[]): string {
  const withTests = models.filter((m) => (m.tests || []).length > 0 || m.description);
  if (withTests.length === 0) return '';
  const out: string[] = ['version: 2', 'models:'];
  for (const m of withTests) {
    out.push(`  - name: ${q(m.name)}`);
    if (m.description) out.push(`    description: ${q(m.description)}`);
    const colTests = (m.tests || []).filter((t) => t.column);
    const modelTests = (m.tests || []).filter((t) => !t.column);
    if (modelTests.length) {
      out.push('    tests:');
      for (const t of modelTests) out.push(`      - ${t.type}`);
    }
    if (colTests.length) {
      const byCol = new Map<string, typeof colTests>();
      for (const t of colTests) {
        const list = byCol.get(t.column!) || [];
        list.push(t);
        byCol.set(t.column!, list);
      }
      out.push('    columns:');
      for (const [col, tests] of byCol) {
        out.push(`      - name: ${q(col)}`);
        out.push('        tests:');
        for (const t of tests) {
          if (t.type === 'accepted_values') {
            out.push('          - accepted_values:');
            out.push(`              values: [${(t.values || []).map(q).join(', ')}]`);
          } else if (t.type === 'relationships') {
            out.push('          - relationships:');
            out.push(`              to: ref(${q(t.to || '')})`);
            out.push(`              field: ${q(t.field || 'id')}`);
          } else {
            out.push(`          - ${t.type}`);
          }
        }
      }
    }
  }
  out.push('');
  return out.join('\n');
}

function dbtModelFile(m: TransformModel): GeneratedFile {
  const config: string[] = [`materialized=${q(m.materialized)}`];
  if (m.materialized === 'incremental' && m.uniqueKey) config.push(`unique_key=${q(m.uniqueKey)}`);
  if (m.tags?.length) config.push(`tags=[${m.tags.map(q).join(', ')}]`);
  const header = `{{ config(${config.join(', ')}) }}`;
  return {
    path: `models/${m.layer}/${m.name}.sql`,
    content: `${header}\n\n${m.sql.trim()}\n`,
  };
}

// ── SQLMesh ─────────────────────────────────────────────────────────────────

/** SQLMesh model KIND for a Loom materialization. */
export function sqlMeshKind(m: TransformModel): string {
  switch (m.materialized) {
    case 'view': return 'VIEW';
    case 'ephemeral': return 'EMBEDDED';
    case 'incremental':
      return m.uniqueKey
        ? `INCREMENTAL_BY_UNIQUE_KEY (unique_key ${m.uniqueKey})`
        : 'INCREMENTAL_BY_TIME_RANGE (time_column ds)';
    case 'table':
    default: return 'FULL';
  }
}

function sqlMeshGateway(t: TransformTarget): string[] {
  const schema = t.schema || 'analytics';
  switch (t.engine) {
    case 'databricks':
      return [
        '    connection:', '      type: databricks',
        `      server_hostname: ${t.databricksHost || '{{ env_var("DBT_DATABRICKS_HOST") }}'}`,
        `      http_path: ${t.databricksHttpPath || '{{ env_var("DBT_DATABRICKS_HTTP_PATH") }}'}`,
        `      catalog: ${t.catalog || 'main'}`,
      ];
    case 'duckdb':
      return ['    connection:', '      type: duckdb', `      database: ${t.duckdbPath || 'loom.duckdb'}`];
    case 'fabric':
      return [
        '    connection:', '      type: mssql',
        `      host: ${t.fabricEndpoint || '{{ env_var("DBT_FABRIC_ENDPOINT") }}'}`,
        `      database: ${t.database || '{{ env_var("DBT_FABRIC_DATABASE") }}'}`,
        '      driver: pyodbc', '      driver_name: ODBC Driver 18 for SQL Server',
        '      autocommit: true',
      ];
    case 'synapse':
    default:
      return [
        '    connection:', '      type: mssql',
        `      host: ${t.synapseServer || '{{ env_var("DBT_SYNAPSE_SERVER") }}'}`,
        `      database: ${t.database || '{{ env_var("DBT_SYNAPSE_DATABASE") }}'}`,
        '      driver: pyodbc', '      driver_name: ODBC Driver 18 for SQL Server',
        `      # schema: ${schema} (models carry their own qualified names)`,
        '      autocommit: true',
      ];
  }
}

function sqlMeshConfig(p: TransformProject): string {
  const out: string[] = [
    `# SQLMesh config for ${p.projectName} — generated by CSA Loom (N4).`,
    '# Auth is the runner Container App\'s managed identity (AZURE_CLIENT_ID);',
    '# no passwords or keys are ever written into this file.',
    'gateways:',
    '  loom:',
    ...sqlMeshGateway(p.target),
    'default_gateway: loom',
    `model_defaults:`,
    `  dialect: ${p.target.engine === 'databricks' ? 'databricks' : p.target.engine === 'duckdb' ? 'duckdb' : 'tsql'}`,
    '  start: 2020-01-01',
    '',
  ];
  return out.join('\n');
}

function sqlMeshModelFile(m: TransformModel, schema: string): GeneratedFile {
  const props: string[] = [
    `  name ${schema}.${m.name}`,
    `  kind ${sqlMeshKind(m)}`,
  ];
  if (m.cron) props.push(`  cron '${m.cron}'`);
  if (m.owners?.length) props.push(`  owner '${m.owners[0]}'`);
  if (m.description) props.push(`  description ${q(m.description)}`);
  if (m.tags?.length) props.push(`  tags (${m.tags.join(', ')})`);
  // SQLMesh reads ref()/source() as plain qualified names — rewrite the Jinja the
  // canvas emits so ONE SQL body works on both engines.
  const sql = m.sql
    .replace(/\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, (_x, name: string) => `${schema}.${name}`)
    .replace(/\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g,
      (_x, src: string, table: string) => `${src}.${table}`)
    .trim();
  return {
    path: `models/${m.layer}/${m.name}.sql`,
    content: `MODEL (\n${props.join(',\n')}\n);\n\n${sql}\n`,
  };
}

function sqlMeshExternalModels(sources: TransformSource[]): string {
  if (sources.length === 0) return '';
  const out: string[] = ['# External (source) tables the project reads but does not own.'];
  for (const s of sources) {
    out.push(`- name: ${s.schema || s.name}.${s.table}`);
    if (s.description) out.push(`  description: ${q(s.description)}`);
  }
  out.push('');
  return out.join('\n');
}

function sqlMeshAudits(models: TransformModel[]): string {
  // SQLMesh expresses dbt's generic tests as AUDITs. Emit the ones the visual
  // test picker can produce; anything else is simply not emitted (never faked).
  const blocks: string[] = [];
  for (const m of models) {
    for (const t of m.tests || []) {
      if (!t.column) continue;
      if (t.type === 'not_null') {
        blocks.push(`AUDIT (\n  name assert_${m.name}_${t.column}_not_null\n);\n\nSELECT * FROM @this_model WHERE ${t.column} IS NULL;\n`);
      } else if (t.type === 'unique') {
        blocks.push(`AUDIT (\n  name assert_${m.name}_${t.column}_unique\n);\n\nSELECT ${t.column} FROM @this_model GROUP BY ${t.column} HAVING COUNT(*) > 1;\n`);
      } else if (t.type === 'accepted_values' && (t.values || []).length) {
        const values = (t.values || []).map((v) => `'${escapeSqlLiteral(v)}'`).join(', ');
        blocks.push(`AUDIT (\n  name assert_${m.name}_${t.column}_accepted_values\n);\n\nSELECT * FROM @this_model WHERE ${t.column} NOT IN (${values});\n`);
      }
    }
  }
  return blocks.join('\n');
}

// ── entrypoint ──────────────────────────────────────────────────────────────

/** Generate the real project files for the project's selected backend. */
export function generateTransformProject(p: TransformProject): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  if (p.backend === 'sqlmesh') {
    const schema = p.target.schema || 'analytics';
    files.push({ path: 'config.yaml', content: sqlMeshConfig(p) });
    for (const m of p.models) files.push(sqlMeshModelFile(m, schema));
    const external = sqlMeshExternalModels(p.sources || []);
    if (external) files.push({ path: 'external_models.yaml', content: external });
    const audits = sqlMeshAudits(p.models || []);
    if (audits) files.push({ path: 'audits/loom_audits.sql', content: audits });
    return files;
  }
  files.push({ path: 'dbt_project.yml', content: dbtProjectYml(p) });
  files.push({ path: 'profiles.yml', content: dbtProfile(p) });
  for (const m of p.models) files.push(dbtModelFile(m));
  const sources = dbtSourcesYml(p.sources || []);
  if (sources) files.push({ path: 'models/sources.yml', content: sources });
  const schema = dbtSchemaYml(p.models || []);
  if (schema) files.push({ path: 'models/schema.yml', content: schema });
  return files;
}

/** The per-run env the runner injects (engine coordinates, never credentials). */
export function runnerEnv(p: TransformProject): Record<string, string> {
  const t = p.target;
  return {
    DBT_SYNAPSE_SERVER: t.synapseServer || '',
    DBT_SYNAPSE_DATABASE: t.database || '',
    DBT_DATABRICKS_HOST: (t.databricksHost || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    DBT_DATABRICKS_HTTP_PATH: t.databricksHttpPath || '',
    DBT_FABRIC_ENDPOINT: t.fabricEndpoint || '',
    DBT_FABRIC_DATABASE: t.database || '',
  };
}

/** The default dbt command list (the wizard's checkbox picker seeds from this). */
export function defaultDbtCommands(): string[] {
  return ['dbt deps', 'dbt build'];
}

/** Dangling ref()s a generated file would compile to nothing (pre-plan check). */
export function referencedModelNames(sql: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g;
  let m: RegExpExecArray | null = re.exec(sql);
  while (m) {
    out.push(m[1]);
    m = re.exec(sql);
  }
  return out;
}

export { yamlList };

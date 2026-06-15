/**
 * dbt-codegen — golden + behavioral tests for the dbt project generator.
 *
 * These are pure-function tests (no Azure, no React) verifying that a
 * DbtProjectGraph produces real, runnable dbt project files with the right
 * adapter, materializations, lineage refs, and tests.
 */
import { describe, it, expect } from 'vitest';
import {
  generateProject, generateProfilesYml, generateDbtProjectYml,
  generateModelSql, generateSchemaYml, generateSourcesYml,
  findDanglingRefs, defaultDbtCommands,
} from '../dbt-codegen';
import type { DbtProjectGraph } from '../dbt-project-model';

function fixture(adapter: DbtProjectGraph['target']['adapter'] = 'databricks'): DbtProjectGraph {
  return {
    projectName: 'loom_dbt_project',
    profileName: 'loom_dbt_project',
    sources: [
      { name: 'raw', schema: 'dbo', table: 'orders', freshnessWarnHours: 12 },
    ],
    models: [
      {
        name: 'stg_orders', layer: 'bronze', materialized: 'view',
        sql: "select * from {{ source('raw', 'orders') }}",
        sources: ['raw.orders'], refs: [],
        tests: [{ column: 'order_id', type: 'unique' }, { column: 'order_id', type: 'not_null' }],
      },
      {
        name: 'fct_orders', layer: 'gold', materialized: 'incremental', uniqueKey: 'order_id',
        sql: "select * from {{ ref('stg_orders') }}",
        refs: ['stg_orders'], sources: [],
        tests: [{ type: 'accepted_values', column: 'status', values: ['new', 'shipped'] }],
      },
    ],
    target: { adapter, catalog: 'main', schema: 'analytics', threads: 4, synapseServer: 'ws.sql.azuresynapse.net', database: 'pool01' },
  };
}

describe('dbt-codegen', () => {
  it('emits dbt_project.yml with the project name + per-layer materialized defaults', () => {
    const y = generateDbtProjectYml(fixture());
    expect(y).toContain('name: loom_dbt_project');
    expect(y).toContain('profile: loom_dbt_project');
    expect(y).toContain('bronze:');
    expect(y).toContain('+materialized: view');
    expect(y).toContain('gold:');
  });

  it('generates a Databricks profiles.yml with the run-injected DBT_ACCESS_TOKEN (no Loom secret plumbing)', () => {
    const y = generateProfilesYml(fixture('databricks'));
    expect(y).toContain('type: databricks');
    expect(y).toContain('method: http');
    expect(y).toContain('catalog: main');
    // Databricks injects DBT_ACCESS_TOKEN for the dbt task's Run-As principal —
    // that is the ONLY env var the generated profile depends on at runtime.
    expect(y).toContain("env_var('DBT_ACCESS_TOKEN')");
    // The old, never-injected token env var must be gone (it would fail on the cluster).
    expect(y).not.toContain("env_var('DBT_DATABRICKS_TOKEN')");
    expect(y).not.toContain('type: synapse');
  });

  it('bakes a literal host into the Databricks profile when databricksHost is set (run BFF default)', () => {
    const g = fixture('databricks');
    g.target.databricksHost = 'adb-123.4.azuredatabricks.net';
    g.target.databricksHttpPath = '/sql/1.0/warehouses/abc123';
    const y = generateProfilesYml(g);
    // host + http_path are static literals; only the token is an env_var marker,
    // so the profile resolves on the dbt-CLI compute with just the injected token.
    expect(y).toContain('host: adb-123.4.azuredatabricks.net');
    expect(y).toContain('http_path: /sql/1.0/warehouses/abc123');
    const envVars = (y.match(/env_var\('([^']+)'\)/g) || []).sort();
    expect(envVars).toEqual(["env_var('DBT_ACCESS_TOKEN')"]);
  });

  it('generates a Synapse profiles.yml with ODBC 18 + authentication CLI (no secrets)', () => {
    const y = generateProfilesYml(fixture('synapse'));
    expect(y).toContain('type: synapse');
    expect(y).toContain('ODBC Driver 18 for SQL Server');
    expect(y).toContain('authentication: CLI');
    expect(y).toContain('ws.sql.azuresynapse.net');
    expect(y).not.toMatch(/password/i);
  });

  it('the SAME project switches clouds by only changing the adapter type', () => {
    const dbx = generateProfilesYml(fixture('databricks'));
    const syn = generateProfilesYml(fixture('synapse'));
    const fab = generateProfilesYml(fixture('fabric'));
    expect(dbx).toContain('type: databricks');
    expect(syn).toContain('type: synapse');
    expect(fab).toContain('type: fabric');
  });

  it('emits a model .sql with the config() materialization header + incremental unique_key', () => {
    const m = fixture().models[1];
    const sql = generateModelSql(m);
    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("unique_key='order_id'");
    expect(sql).toContain("{{ ref('stg_orders') }}");
  });

  it('emits schema.yml with column tests (unique/not_null) and accepted_values', () => {
    const y = generateSchemaYml(fixture().models);
    expect(y).toContain('- name: stg_orders');
    expect(y).toContain('- unique');
    expect(y).toContain('- not_null');
    expect(y).toContain('accepted_values');
    expect(y).toContain('[new, shipped]');
  });

  it('emits sources.yml with freshness thresholds', () => {
    const y = generateSourcesYml(fixture().sources);
    expect(y).toContain('- name: raw');
    expect(y).toContain('- name: orders');
    expect(y).toContain('warn_after: { count: 12, period: hour }');
  });

  it('generateProject produces the full medallion file set in deterministic order', () => {
    const files = generateProject(fixture());
    const paths = files.map((f) => f.path);
    expect(paths).toContain('dbt_project.yml');
    expect(paths).toContain('profiles.yml');
    expect(paths).toContain('models/sources.yml');
    expect(paths).toContain('models/bronze/stg_orders.sql');
    expect(paths).toContain('models/bronze/schema.yml');
    expect(paths).toContain('models/gold/fct_orders.sql');
    expect(paths).toContain('packages.yml');
  });

  it('findDanglingRefs flags a ref() to a non-existent model', () => {
    const g = fixture();
    g.models[1].refs = ['stg_orders', 'does_not_exist'];
    const dangling = findDanglingRefs(g);
    expect(dangling).toEqual([{ model: 'fct_orders', ref: 'does_not_exist' }]);
  });

  it('defaultDbtCommands adds --select when a model subset is given', () => {
    expect(defaultDbtCommands()).toEqual(['dbt deps', 'dbt build']);
    expect(defaultDbtCommands(['stg_orders'])).toEqual(['dbt deps', 'dbt build --select stg_orders']);
  });
});

/**
 * N4 — backend selector, validation, codegen, and the exported DAG contract.
 *
 * The selector test is the one that guards the "SQLMesh ALONGSIDE dbt, dbt stays
 * the default" promise: an item written before N4 (no `backend` key at all) must
 * resolve to dbt, not silently switch engines.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSFORM_BACKEND, emptyTransformProject, findDanglingRefs,
  projectHasContent, resolveTransformBackend, validateTransformProject,
  type TransformProject,
} from '../transform-project-model';
import { generateTransformProject, runnerEnv, sqlMeshKind } from '../transform-codegen';
import { buildTransformDag, downstreamClosure, layoutTransformDag } from '../transform-dag';
import type { PlanImpact } from '../plan-impact';

function sampleProject(overrides: Partial<TransformProject> = {}): TransformProject {
  return {
    ...emptyTransformProject('loom_sales'),
    sources: [{ name: 'raw', schema: 'dbo', table: 'orders' }],
    models: [
      {
        name: 'stg_orders', layer: 'bronze', materialized: 'view',
        sql: "SELECT * FROM {{ source('raw','orders') }}", sources: ['raw.orders'], refs: [],
        owners: ['data-platform'], tags: ['pii'],
      },
      {
        name: 'fct_orders', layer: 'silver', materialized: 'incremental', uniqueKey: 'order_id',
        sql: "SELECT * FROM {{ ref('stg_orders') }}", refs: ['stg_orders'], sources: [],
        cron: '@hourly',
        tests: [{ column: 'order_id', type: 'not_null' }, { column: 'order_id', type: 'unique' }],
      },
      {
        name: 'rpt_revenue', layer: 'gold', materialized: 'table',
        sql: "SELECT * FROM {{ ref('fct_orders') }}", refs: ['fct_orders'], sources: [],
      },
    ],
    ...overrides,
  };
}

describe('backend selector (dbt is the default — continuity)', () => {
  it('defaults to dbt', () => {
    expect(DEFAULT_TRANSFORM_BACKEND).toBe('dbt');
    expect(emptyTransformProject().backend).toBe('dbt');
  });

  it('resolves a pre-N4 item (no backend key at all) to dbt, never sqlmesh', () => {
    expect(resolveTransformBackend({ project: { models: [] } })).toBe('dbt');
    expect(resolveTransformBackend({})).toBe('dbt');
    expect(resolveTransformBackend(null)).toBe('dbt');
    expect(resolveTransformBackend(undefined)).toBe('dbt');
  });

  it('resolves an unrecognised selector to dbt rather than throwing', () => {
    expect(resolveTransformBackend({ project: { backend: 'spark-sql' } })).toBe('dbt');
    expect(resolveTransformBackend({ backend: 42 })).toBe('dbt');
  });

  it('honors an explicit sqlmesh selection at either level', () => {
    expect(resolveTransformBackend({ project: { backend: 'sqlmesh' } })).toBe('sqlmesh');
    expect(resolveTransformBackend({ backend: 'sqlmesh' })).toBe('sqlmesh');
  });
});

describe('validateTransformProject', () => {
  it('accepts a well-formed project', () => {
    expect(validateTransformProject(sampleProject())).toEqual([]);
  });

  it('rejects a non-object / missing project (400, never a 502 TypeError)', () => {
    expect(validateTransformProject(null)).toEqual([{ field: 'project', message: 'project is required' }]);
  });

  it('reports field-level problems', () => {
    const errors = validateTransformProject({
      backend: 'spark', sources: undefined, models: [{ name: '', sql: 1 }], target: {},
    });
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('backend');
    expect(fields).toContain('sources');
    expect(fields).toContain('models[0].name');
    expect(fields).toContain('models[0].layer');
    expect(fields).toContain('models[0].sql');
    expect(fields).toContain('target.engine');
  });

  it('rejects duplicate model names', () => {
    const p = sampleProject();
    p.models.push({ ...p.models[0] });
    expect(validateTransformProject(p).some((e) => /duplicate model name/.test(e.message))).toBe(true);
  });

  it('requires the default environment to exist for a SQLMesh project', () => {
    const p = sampleProject({ backend: 'sqlmesh', defaultEnvironment: 'staging' });
    expect(validateTransformProject(p).some((e) => e.field === 'defaultEnvironment')).toBe(true);
    // dbt does not use virtual environments, so the same project is valid there.
    expect(validateTransformProject({ ...p, backend: 'dbt' })
      .some((e) => e.field === 'defaultEnvironment')).toBe(false);
  });

  it('finds dangling refs', () => {
    const p = sampleProject();
    p.models[2].refs = ['does_not_exist'];
    expect(findDanglingRefs(p)).toEqual([{ model: 'rpt_revenue', ref: 'does_not_exist' }]);
  });

  it('projectHasContent is false for an empty starter', () => {
    expect(projectHasContent(emptyTransformProject())).toBe(false);
    expect(projectHasContent(sampleProject())).toBe(true);
  });
});

describe('codegen — one graph, two engines', () => {
  it('generates a real dbt project for the default backend', () => {
    const files = generateTransformProject(sampleProject());
    const paths = files.map((f) => f.path);
    expect(paths).toContain('dbt_project.yml');
    expect(paths).toContain('profiles.yml');
    expect(paths).toContain('models/bronze/stg_orders.sql');
    expect(paths).toContain('models/silver/fct_orders.sql');
    expect(paths).toContain('models/sources.yml');
    expect(paths).toContain('models/schema.yml');
    // Jinja is preserved for dbt; the incremental unique key rides the config.
    const fct = files.find((f) => f.path === 'models/silver/fct_orders.sql')!;
    expect(fct.content).toContain("{{ ref('stg_orders') }}");
    expect(fct.content).toContain('materialized="incremental"');
    expect(fct.content).toContain('unique_key="order_id"');
    // Managed identity only — no credential is ever written into a profile.
    const profile = files.find((f) => f.path === 'profiles.yml')!;
    expect(profile.content).toContain('authentication: CLI');
    expect(profile.content).not.toMatch(/password/i);
  });

  it('generates a real SQLMesh project for the same graph', () => {
    const files = generateTransformProject(sampleProject({ backend: 'sqlmesh' }));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('config.yaml');
    expect(paths).toContain('models/silver/fct_orders.sql');
    expect(paths).toContain('external_models.yaml');
    expect(paths).toContain('audits/loom_audits.sql');
    // dbt_project.yml/profiles.yml are dbt-only.
    expect(paths).not.toContain('dbt_project.yml');
    const fct = files.find((f) => f.path === 'models/silver/fct_orders.sql')!;
    expect(fct.content).toContain('MODEL (');
    expect(fct.content).toContain('name analytics.fct_orders');
    expect(fct.content).toContain('INCREMENTAL_BY_UNIQUE_KEY (unique_key order_id)');
    expect(fct.content).toContain("cron '@hourly'");
    // ref()/source() Jinja is rewritten to qualified names for SQLMesh, so the
    // SAME authored SQL body runs on both engines.
    expect(fct.content).toContain('analytics.stg_orders');
    expect(fct.content).not.toContain('{{ ref(');
    const stg = files.find((f) => f.path === 'models/bronze/stg_orders.sql')!;
    expect(stg.content).toContain('raw.orders');
    expect(stg.content).not.toContain('{{ source(');
  });

  it('maps materializations onto SQLMesh kinds', () => {
    expect(sqlMeshKind({ name: 'a', layer: 'gold', materialized: 'view', sql: '' })).toBe('VIEW');
    expect(sqlMeshKind({ name: 'a', layer: 'gold', materialized: 'table', sql: '' })).toBe('FULL');
    expect(sqlMeshKind({ name: 'a', layer: 'gold', materialized: 'ephemeral', sql: '' })).toBe('EMBEDDED');
    expect(sqlMeshKind({ name: 'a', layer: 'gold', materialized: 'incremental', sql: '' }))
      .toBe('INCREMENTAL_BY_TIME_RANGE (time_column ds)');
  });

  it('emits engine coordinates only — never credentials — as the runner env', () => {
    const env = runnerEnv(sampleProject({ target: { engine: 'synapse', synapseServer: 'ws.sql.azuresynapse.net', database: 'pool01' } }));
    expect(env.DBT_SYNAPSE_SERVER).toBe('ws.sql.azuresynapse.net');
    expect(env.DBT_SYNAPSE_DATABASE).toBe('pool01');
    expect(Object.keys(env).some((k) => /PASSWORD|SECRET|KEY|TOKEN/i.test(k))).toBe(false);
  });
});

describe('transform DAG (the exported software-defined-asset contract)', () => {
  const dag = buildTransformDag(sampleProject());

  it('emits one node per source + model with a stable asset key', () => {
    expect(dag.nodes.map((n) => n.id).sort())
      .toEqual(['fct_orders', 'raw.orders', 'rpt_revenue', 'stg_orders']);
    const stg = dag.nodes.find((n) => n.id === 'stg_orders')!;
    expect(stg.asset).toMatchObject({
      key: 'model:analytics.stg_orders',
      group: 'bronze',
      owners: ['data-platform'],
      tags: ['pii'],
      materialization: 'view',
    });
    expect(dag.nodes.find((n) => n.id === 'raw.orders')!.asset.key).toBe('source:dbo.orders');
  });

  it('emits ref + source edges and counts upstream/downstream', () => {
    expect(dag.edges.map((e) => e.id).sort()).toEqual([
      'ref:fct_orders->rpt_revenue', 'ref:stg_orders->fct_orders', 'src:raw.orders->stg_orders',
    ]);
    expect(dag.nodes.find((n) => n.id === 'fct_orders')).toMatchObject({ upstream: 1, downstream: 1 });
    expect(dag.nodes.find((n) => n.id === 'rpt_revenue')).toMatchObject({ upstream: 1, downstream: 0 });
  });

  it('drops dangling refs from the drawn graph (validation surfaces them instead)', () => {
    const p = sampleProject();
    p.models[2].refs = ['ghost'];
    const d = buildTransformDag(p);
    expect(d.edges.some((e) => e.source === 'ghost')).toBe(false);
  });

  it('lays out left→right by dependency depth', () => {
    const pos = layoutTransformDag(dag);
    expect(pos['raw.orders'].x).toBe(0);
    expect(pos['stg_orders'].x).toBeGreaterThan(pos['raw.orders'].x);
    expect(pos['fct_orders'].x).toBeGreaterThan(pos['stg_orders'].x);
    expect(pos['rpt_revenue'].x).toBeGreaterThan(pos['fct_orders'].x);
  });

  it('computes the transitive downstream blast radius', () => {
    expect(downstreamClosure(dag, 'stg_orders')).toEqual(['fct_orders', 'rpt_revenue']);
    expect(downstreamClosure(dag, 'rpt_revenue')).toEqual([]);
  });

  it('decorates nodes with the plan impact (matching a fully-qualified engine name)', () => {
    const impact = {
      engine: 'sqlmesh', environment: 'dev', hasChanges: true,
      rows: [{
        model: 'analytics.fct_orders', changeType: 'modified', severity: 'breaking',
        direct: true, downstream: ['analytics.rpt_revenue'], downstreamCount: 1, columns: [],
      }],
      summary: {
        added: 0, modified: 1, removed: 0, breaking: 1, nonBreaking: 0,
        forwardOnly: 0, metadata: 0, downstreamImpacted: 1, backfillIntervals: 0,
      },
    } as unknown as PlanImpact;
    const decorated = buildTransformDag(sampleProject(), impact);
    expect(decorated.nodes.find((n) => n.id === 'fct_orders')!.impact)
      .toMatchObject({ severity: 'breaking', changeType: 'modified' });
    expect(decorated.nodes.find((n) => n.id === 'rpt_revenue')!.impact).toBeNull();
    expect(decorated.edges.find((e) => e.id === 'ref:stg_orders->fct_orders')!.impacted).toBe(true);
  });
});

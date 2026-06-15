/**
 * dbt-runner — unit tests for the run-dispatch helpers.
 *
 * buildWorkspaceDbtJobSpec + dbtRunnerConfigGate are pure. pushProjectToDatabricks
 * is tested with the databricks-client mocked so we assert it (a) mkdirs parent
 * dirs before children and (b) imports every generated file as a workspace file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mkdirs = vi.fn(async (_p?: string) => {});
const importFile = vi.fn(async (_p?: string, _c?: string) => {});

vi.mock('@/lib/azure/databricks-client', () => ({
  mkdirsWorkspace: (p: string) => mkdirs(p),
  importWorkspaceFile: (p: string, c: string) => importFile(p, c),
  createJob: vi.fn(),
  getJob: vi.fn(),
  updateJob: vi.fn(),
  runJob: vi.fn(),
}));

import {
  buildWorkspaceDbtJobSpec, dbtWorkspaceDir, dbtRunnerConfigGate, pushProjectToDatabricks,
  DBT_DATABRICKS_LIBRARY,
} from '../dbt-runner';

describe('dbt-runner', () => {
  beforeEach(() => { mkdirs.mockClear(); importFile.mockClear(); });

  it('buildWorkspaceDbtJobSpec uses source WORKSPACE + project_directory', () => {
    const spec = buildWorkspaceDbtJobSpec('item-1', '/Workspace/Shared/loom-dbt/item-1', 'clu-1', ['dbt deps', 'dbt build']);
    const task: any = (spec.tasks as any[])[0];
    expect(task.dbt_task.source).toBe('WORKSPACE');
    expect(task.dbt_task.project_directory).toContain('item-1');
    expect(task.dbt_task.commands).toEqual(['dbt deps', 'dbt build']);
    expect(task.existing_cluster_id).toBe('clu-1');
    expect(spec.name).toBe('loom-dbt-item-1');
  });

  it('buildWorkspaceDbtJobSpec pins dbt-databricks >= 1.6.0 for dev/prod parity', () => {
    const spec = buildWorkspaceDbtJobSpec('item-1', '/Workspace/Shared/loom-dbt/item-1', 'clu-1', ['dbt build']);
    const task: any = (spec.tasks as any[])[0];
    expect(task.libraries).toEqual([{ pypi: { package: DBT_DATABRICKS_LIBRARY } }]);
    expect(DBT_DATABRICKS_LIBRARY).toContain('dbt-databricks>=1.6.0');
  });

  it('dbtRunnerConfigGate reports the missing env var when unset', () => {
    delete process.env.LOOM_DBT_RUNNER_URL;
    expect(dbtRunnerConfigGate()).toEqual({ missing: 'LOOM_DBT_RUNNER_URL' });
    process.env.LOOM_DBT_RUNNER_URL = 'https://runner';
    expect(dbtRunnerConfigGate()).toBeNull();
    delete process.env.LOOM_DBT_RUNNER_URL;
  });

  it('dbtWorkspaceDir is scoped per item under the Loom shared folder', () => {
    expect(dbtWorkspaceDir('abc')).toBe('/Workspace/Shared/loom-dbt/abc');
  });

  it('pushProjectToDatabricks mkdirs parents before children and imports every file', async () => {
    const files = [
      { path: 'dbt_project.yml', content: 'a' },
      { path: 'models/bronze/stg.sql', content: 'b' },
      { path: 'models/bronze/schema.yml', content: 'c' },
    ];
    const { projectDir, written } = await pushProjectToDatabricks('item-9', files);
    expect(projectDir).toBe('/Workspace/Shared/loom-dbt/item-9');
    expect(written).toHaveLength(3);
    // Every file was imported with its full workspace path.
    expect(importFile).toHaveBeenCalledTimes(3);
    expect(importFile).toHaveBeenCalledWith('/Workspace/Shared/loom-dbt/item-9/models/bronze/stg.sql', 'b');
    // Parent dir created before the nested models/bronze dir (sorted shallow→deep).
    const mkdirCalls = mkdirs.mock.calls.map((c) => c[0]);
    const rootIdx = mkdirCalls.indexOf('/Workspace/Shared/loom-dbt/item-9');
    const bronzeIdx = mkdirCalls.indexOf('/Workspace/Shared/loom-dbt/item-9/models/bronze');
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(bronzeIdx).toBeGreaterThan(rootIdx);
  });
});

import { describe, it, expect } from 'vitest';
import {
  runtimeFromComputeKind,
  runtimeFromComputeId,
  completionsFor,
  starterCellFor,
  copilotRuntimeDirective,
  RUNTIME_LABEL,
} from '../cluster-runtime';

describe('runtimeFromComputeKind', () => {
  it('maps databricks-cluster → databricks', () => {
    expect(runtimeFromComputeKind('databricks-cluster')).toBe('databricks');
  });
  it('maps aml-ci → azure-ml', () => {
    expect(runtimeFromComputeKind('aml-ci')).toBe('azure-ml');
  });
  it('maps synapse-spark + unknown + undefined → synapse-spark (validated default)', () => {
    expect(runtimeFromComputeKind('synapse-spark')).toBe('synapse-spark');
    expect(runtimeFromComputeKind('something-new')).toBe('synapse-spark');
    expect(runtimeFromComputeKind(undefined)).toBe('synapse-spark');
  });
});

describe('runtimeFromComputeId', () => {
  it('reads the id prefix', () => {
    expect(runtimeFromComputeId('databricks:abc')).toBe('databricks');
    expect(runtimeFromComputeId('aml-ci:my-ci')).toBe('azure-ml');
    expect(runtimeFromComputeId('spark:pool1')).toBe('synapse-spark');
    expect(runtimeFromComputeId('serverless:ws')).toBe('synapse-spark');
    expect(runtimeFromComputeId(undefined)).toBe('synapse-spark');
  });
});

describe('completionsFor', () => {
  it('offers dbutils + display + Unity Catalog on Databricks Python, NOT mssparkutils', () => {
    const labels = completionsFor('databricks', 'python').map((c) => c.label);
    expect(labels).toContain('dbutils');
    expect(labels.some((l) => l === 'display')).toBe(true);
    expect(labels.some((l) => l.includes('Unity Catalog'))).toBe(true);
    expect(labels.some((l) => l.includes('mssparkutils'))).toBe(false);
    // %sql / %md / %run Databricks magics, not %%pyspark
    expect(labels).toContain('%sql');
    expect(labels).not.toContain('%%pyspark');
  });

  it('offers mssparkutils + notebookutils + %% magics on Synapse Python, NOT dbutils', () => {
    const labels = completionsFor('synapse-spark', 'python').map((c) => c.label);
    expect(labels).toContain('mssparkutils');
    expect(labels).toContain('notebookutils');
    expect(labels).toContain('%%pyspark');
    expect(labels.some((l) => l === 'dbutils')).toBe(false);
    expect(labels).not.toContain('%sql'); // Databricks-style single-% magic
  });

  it('offers azure.ai.ml + automl + mlflow on Azure ML Python, no Spark globals', () => {
    const labels = completionsFor('azure-ml', 'python').map((c) => c.label);
    expect(labels.some((l) => l.includes('MLClient'))).toBe(true);
    expect(labels.some((l) => l.includes('automl'))).toBe(true);
    expect(labels.some((l) => l.toLowerCase().includes('mlflow'))).toBe(true);
    expect(labels.some((l) => l === 'dbutils' || l.includes('mssparkutils'))).toBe(false);
  });
});

describe('starterCellFor', () => {
  it('Databricks seed uses display() and dbutils-flavored comment', () => {
    expect(starterCellFor('databricks', 'pyspark')).toContain('display(df)');
  });
  it('Azure ML seed uses MLClient', () => {
    expect(starterCellFor('azure-ml', 'python')).toContain('MLClient');
  });
  it('Synapse seed preserves the validated df.show() PySpark path', () => {
    expect(starterCellFor('synapse-spark', 'pyspark')).toContain('df.show()');
  });
});

describe('copilotRuntimeDirective', () => {
  it('names the correct API set per runtime', () => {
    expect(copilotRuntimeDirective('databricks')).toMatch(/dbutils/);
    expect(copilotRuntimeDirective('synapse-spark')).toMatch(/mssparkutils/);
    expect(copilotRuntimeDirective('azure-ml')).toMatch(/azure\.ai\.ml/);
  });
});

describe('RUNTIME_LABEL', () => {
  it('has a label for every runtime', () => {
    expect(RUNTIME_LABEL.databricks).toBeTruthy();
    expect(RUNTIME_LABEL['synapse-spark']).toBeTruthy();
    expect(RUNTIME_LABEL['azure-ml']).toBeTruthy();
  });
});

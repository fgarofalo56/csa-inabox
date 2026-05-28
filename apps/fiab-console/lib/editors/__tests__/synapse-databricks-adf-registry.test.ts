/**
 * Synapse / Databricks / ADF family — registry completeness test.
 *
 * Real test (per .claude/rules/no-vaporware.md): parses the actual
 * registry.ts source via filesystem read and asserts that every slug in
 * the Synapse / Databricks / ADF family resolves to a `reg(...)` entry
 * pointing at the expected component name in the expected source file.
 *
 * Catches the regression where someone removes or renames an editor
 * component without updating the registry (which would manifest as a
 * runtime "editor not found" in the live console).
 *
 * Does NOT import the registry module directly because that pulls in
 * the Next.js dynamic-import shim + JSX which require a heavier
 * transform pipeline. Reading the source string keeps Vitest cheap +
 * deterministic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGISTRY_SRC = readFileSync(
  resolve(__dirname, '..', 'registry.ts'),
  'utf-8',
);

// Map slug → [expected component name, expected source file]
const FAMILY: Record<string, [string, string]> = {
  // Synapse SQL (real-REST: TDS over PE + AAD MI)
  'synapse-dedicated-sql-pool':  ['SynapseDedicatedSqlPoolEditor',  './synapse-sql-editors'],
  'synapse-serverless-sql-pool': ['SynapseServerlessSqlPoolEditor', './synapse-sql-editors'],
  // Synapse Spark + Pipeline (real-REST: ARM + dev endpoint)
  'synapse-spark-pool':          ['SynapseSparkPoolEditor',         './azure-services-editors'],
  'synapse-pipeline':            ['SynapsePipelineEditor',          './azure-services-editors'],
  // Databricks (real-REST: Jobs / SCIM / SQL Warehouses via UAMI)
  'databricks-notebook':         ['DatabricksNotebookEditor',       './databricks-editors'],
  'databricks-job':              ['DatabricksJobEditor',            './databricks-editors'],
  'databricks-cluster':          ['DatabricksClusterEditor',        './databricks-editors'],
  'databricks-sql-warehouse':    ['DatabricksSqlWarehouseEditor',   './databricks-editors'],
  // ADF (real-REST: Author REST API)
  'adf-pipeline':                ['AdfPipelineEditor',              './azure-services-editors'],
  'adf-dataset':                 ['AdfDatasetEditor',               './azure-services-editors'],
  'adf-trigger':                 ['AdfTriggerEditor',               './azure-services-editors'],
};

describe('Synapse / Databricks / ADF editor registry', () => {
  for (const [slug, [component, sourceFile]] of Object.entries(FAMILY)) {
    it(`maps '${slug}' to ${component} in ${sourceFile}`, () => {
      // Quote the slug to disambiguate from prefix-matching slugs
      const slugLine = REGISTRY_SRC
        .split('\n')
        .find((l) => l.includes(`'${slug}':`));
      expect(slugLine, `registry entry for '${slug}' must exist`).toBeTruthy();
      expect(slugLine).toContain(sourceFile);
      expect(slugLine).toContain(`'${component}'`);
    });
  }

  it('has exactly the 11 family slugs registered (no drift, no gaps)', () => {
    const slugCount = Object.keys(FAMILY).length;
    expect(slugCount).toBe(11);
    // Sanity: the registry source file contains every family slug at
    // least once (catches stealth removal during refactors).
    for (const slug of Object.keys(FAMILY)) {
      expect(REGISTRY_SRC).toContain(`'${slug}':`);
    }
  });
});

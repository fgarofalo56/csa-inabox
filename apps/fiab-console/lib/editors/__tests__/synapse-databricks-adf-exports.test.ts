/**
 * Synapse / Databricks / ADF family — source-exports completeness test.
 *
 * Real test: greps the actual editor source files and asserts that each
 * required `export function <Name>` is present. Catches the regression
 * where a refactor accidentally removes or renames a wired editor (e.g.
 * a registry update without the matching component, or vice versa).
 *
 * No mocks, no fixtures. Filesystem only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SourceContract {
  file: string;
  exports: string[];
}

const CONTRACTS: SourceContract[] = [
  {
    file: 'synapse-sql-editors.tsx',
    exports: [
      'SynapseDedicatedSqlPoolEditor',
      'SynapseServerlessSqlPoolEditor',
    ],
  },
  {
    file: 'azure-services-editors.tsx',
    exports: [
      'SynapseSparkPoolEditor',
      'SynapsePipelineEditor',
      'AdfPipelineEditor',
      'AdfDatasetEditor',
      'AdfTriggerEditor',
    ],
  },
  // databricks-editors.tsx is now a barrel; the editor `export function`
  // declarations live in the per-editor files under ./databricks/.
  {
    file: 'databricks/databricks-notebook-editor.tsx',
    exports: ['DatabricksNotebookEditor'],
  },
  {
    file: 'databricks/job-editor.tsx',
    exports: ['DatabricksJobEditor'],
  },
  {
    file: 'databricks/cluster-editor.tsx',
    exports: ['DatabricksClusterEditor'],
  },
  {
    file: 'databricks/sql-warehouse-editor.tsx',
    exports: ['DatabricksSqlWarehouseEditor'],
  },
];

describe('Synapse / Databricks / ADF editor source exports', () => {
  for (const { file, exports: required } of CONTRACTS) {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');

    for (const name of required) {
      it(`${file} exports ${name}`, () => {
        const pattern = new RegExp(`export\\s+function\\s+${name}\\b`);
        expect(pattern.test(src), `expected '${file}' to declare 'export function ${name}'`).toBe(true);
      });
    }

    it(`${file} contains no vaporware tokens (MOCK_, FIXME)`, () => {
      // Per .claude/rules/no-vaporware.md "How to spot a vaporware violation".
      // SAMPLE_ is allowed when intentionally labelled (e.g. U-SQL deprecation
      // surface uses USQL_SAMPLE). MOCK_ and FIXME are never allowed in the
      // wired family editors.
      //
      // Walk line-by-line so comment lines (which sometimes mention these
      // tokens in narrative form, e.g. "// previous body returned MOCK_DATA")
      // are excluded — only code-line hits count as violations.
      const codeLines = src.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      });
      const codeOnly = codeLines.join('\n');
      expect(/\bMOCK_/.test(codeOnly), `'${file}' contains MOCK_ token outside comments`).toBe(false);
      expect(/\bFIXME\b/.test(codeOnly), `'${file}' contains FIXME token outside comments`).toBe(false);
    });
  }
});

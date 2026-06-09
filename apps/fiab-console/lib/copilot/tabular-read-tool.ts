/**
 * tabular-read-tool.ts — Semantic Link read tools for the Loom Copilot.
 *
 * Registers four ToolDef objects for the LoomToolRegistry, giving the notebook
 * and DAX Copilot personas (and the default cross-item Copilot) the ability to
 * read a Loom semantic model with ZERO Power BI / Fabric dependency:
 *
 *   tabular_list_models    — list semantic-model items the user owns
 *   tabular_list_tables    — list a model's tables (+ columns + measure names)
 *   tabular_list_measures  — list a model's measures (name, table, DAX, format)
 *   tabular_eval_dax       — evaluate DAX and return a real row-set
 *
 * Parity: sempy.fabric.list_datasets / list_tables / list_measures /
 * evaluate_dax (Microsoft Fabric "Semantic Link") — but the backend is the
 * Azure-native loom-native tabular layer (Cosmos metadata + Synapse SQL) by
 * default, AAS XMLA only when explicitly opted in. The Power BI REST host is
 * NEVER called on the default path.
 *
 * Every handler calls real tabular-eval-client functions (no stubs, no mock
 * arrays) per no-vaporware.md. Results use the { columns, rows } shape that
 * LoomDataTable (T7) renders directly.
 */

import type { ToolDef } from '@/lib/azure/copilot-orchestrator';
import {
  listModels,
  listTables,
  listMeasures,
  evalDax,
} from '@/lib/azure/tabular-eval-client';

const S_STRING = { type: 'string' } as const;
function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

export function buildTabularReadTools(): ToolDef[] {
  return [
    {
      name: 'tabular_list_models',
      service: 'Tabular',
      description:
        'List the Loom semantic models the current user owns (Semantic Link parity: list datasets). ' +
        'Returns { id, displayName, workspaceId, description } per model. Use the returned id as modelId in the other tabular_* tools.',
      parameters: obj({}),
      handler: async (_args, ctx) => listModels(ctx.userOid),
    },
    {
      name: 'tabular_list_tables',
      service: 'Tabular',
      description:
        'List the tables in a Loom semantic model (Semantic Link parity: list_tables). ' +
        'Returns name, columns (name + dataType) and the measure names per table. Requires modelId from tabular_list_models.',
      parameters: obj({ modelId: S_STRING }, ['modelId']),
      handler: async ({ modelId }, ctx) => listTables(String(modelId), ctx.userOid),
    },
    {
      name: 'tabular_list_measures',
      service: 'Tabular',
      description:
        'List the measures in a Loom semantic model (Semantic Link parity: list_measures). ' +
        'Returns name, table, DAX expression and formatString per measure. Requires modelId from tabular_list_models.',
      parameters: obj({ modelId: S_STRING }, ['modelId']),
      handler: async ({ modelId }, ctx) => listMeasures(String(modelId), ctx.userOid),
    },
    {
      name: 'tabular_eval_dax',
      service: 'Tabular',
      description:
        'Evaluate a DAX query against a Loom semantic model and return real values (Semantic Link parity: evaluate_dax). ' +
        'Returns { columns: string[], rows: object[] } — renders as a table. ' +
        'On the default loom-native backend the supported patterns are: EVALUATE <Table>; EVALUATE TOPN(N, <Table>); ' +
        'EVALUATE ROW("Label", CALCULATE(SUM|COUNT|AVERAGE|MIN|MAX(Table[Col]))). Full DAX needs LOOM_SEMANTIC_BACKEND=analysis-services. ' +
        'Optionally pass `database` to target the Synapse database that holds the model\'s source tables. Requires modelId from tabular_list_models.',
      parameters: obj({ modelId: S_STRING, dax: S_STRING, database: S_STRING }, ['modelId', 'dax']),
      handler: async ({ modelId, dax, database }, ctx) =>
        evalDax(String(modelId), String(dax), ctx.userOid, database ? String(database) : undefined),
    },
  ];
}

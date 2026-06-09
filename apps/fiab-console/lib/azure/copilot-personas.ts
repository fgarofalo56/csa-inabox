/**
 * copilot-personas.ts — Notebook + DAX Copilot persona registries.
 *
 * A "persona" is a LoomToolRegistry scoped to one assistant surface. Instead of
 * the full default registry (29+ tools), each persona exposes only the tools
 * relevant to its context — fewer tokens, a sharper system prompt, and no
 * persona bleed (the DAX persona can't accidentally trigger an ADF pipeline).
 *
 * Both personas centre on the new tabular_* tools (Semantic Link read), so a
 * notebook / DAX assistant grounds every answer in the REAL Loom semantic model
 * — no Power BI / Fabric dependency on the default path (per
 * no-fabric-dependency.md). Registries are built per-request so the userOid
 * captured in each tool handler is always current.
 */

import { LoomToolRegistry } from './copilot-orchestrator';
import { buildTabularReadTools } from '@/lib/copilot/tabular-read-tool';
import { executeQuery as synapseExecute, serverlessTarget } from './synapse-sql-client';

const S_STRING = { type: 'string' } as const;
function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Notebook persona
// ---------------------------------------------------------------------------

export const NOTEBOOK_PERSONA_SYSTEM_PROMPT =
  'You are CSA Loom Notebook Copilot — an assistant specialising in notebook code ' +
  'generation, semantic-model exploration and data-query building inside CSA Loom. ' +
  'CSA Loom is its OWN product, NOT Microsoft Fabric. When exploring data, prefer ' +
  'tabular_list_models → tabular_list_tables / tabular_list_measures → tabular_eval_dax ' +
  'to ground answers in the REAL model, then generate Python/SQL notebook cells from the ' +
  'real metadata. Never fabricate column names or measure expressions — always read them ' +
  'with the tabular_* tools first. Do NOT call Power BI or Fabric tools unless the user ' +
  'explicitly asks for a Power BI action.';

/** Notebook persona: tabular read tools + Synapse SQL + item listing. */
export function buildNotebookPersonaRegistry(): LoomToolRegistry {
  const r = new LoomToolRegistry();

  for (const t of buildTabularReadTools()) r.register(t);

  r.register({
    name: 'synapse_serverless_query',
    service: 'Synapse',
    description: 'Run a read-only T-SQL query against the Synapse serverless SQL pool (ad-hoc analytics over the lakehouse/warehouse).',
    parameters: obj({ sql: S_STRING, database: S_STRING }, ['sql']),
    handler: async ({ sql, database }) => synapseExecute(serverlessTarget(String(database || 'master')), String(sql)),
  });

  r.register({
    name: 'item_list',
    service: 'Loom',
    description:
      'List Loom items the current user owns. Pass itemType="semantic-model" to find models to explore with the tabular_* tools.',
    parameters: obj({ itemType: S_STRING, workspaceId: S_STRING }, []),
    handler: async ({ itemType, workspaceId }, ctx) => {
      const { listOwnedItems, listAllOwnedItems } = await import('@/app/api/items/_lib/item-crud');
      const wid = String(workspaceId ?? '').trim() || undefined;
      const items = wid
        ? await listAllOwnedItems(ctx.userOid, wid)
        : await listOwnedItems(String(itemType || 'semantic-model'), ctx.userOid);
      return items.map((it) => ({ id: it.id, itemType: it.itemType, displayName: it.displayName, workspaceId: it.workspaceId }));
    },
  });

  return r;
}

// ---------------------------------------------------------------------------
// DAX persona
// ---------------------------------------------------------------------------

export const DAX_PERSONA_SYSTEM_PROMPT =
  'You are CSA Loom DAX Copilot — an assistant specialising in DAX query generation and ' +
  'semantic-model analysis for the CSA Loom tabular engine. Always call tabular_list_models ' +
  'first, then tabular_list_tables and tabular_list_measures to ground your answer in the real ' +
  'schema before writing any DAX or explaining any measure. On the default loom-native backend ' +
  'the supported patterns are EVALUATE <Table>, EVALUATE TOPN(N, Table), and ' +
  'EVALUATE ROW("Label", CALCULATE(AGG(Table[Col]))). Never fabricate measure expressions — read ' +
  'them from tabular_list_measures first.';

/** DAX persona: tabular read tools only (semantic-layer focus). */
export function buildDaxPersonaRegistry(): LoomToolRegistry {
  const r = new LoomToolRegistry();
  for (const t of buildTabularReadTools()) r.register(t);
  return r;
}

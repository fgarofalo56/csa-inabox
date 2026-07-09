/**
 * copilot-personas-lakehouse.ts — Lakehouse inline Copilot builder config (G1).
 * NL → a Synapse-serverless / Spark SQL SELECT over the lakehouse Delta tables,
 * grounded on the tables captured in item.state.
 *
 * Reuses the intent of the existing 'lakehouse' persona type (copilot-personas.ts)
 * but as a structured propose/apply builder. Azure-native
 * (no-fabric-dependency.md): a CSA Loom lakehouse is ADLS Gen2 + Delta registered
 * for Synapse serverless — no Microsoft Fabric / OneLake. The generated SQL is
 * saved as a Loom-native draft (item.state.copilotSqlDraft) with checkpoint/
 * restore; the editor's SQL pane loads it and runs it via OPENROWSET over Delta.
 */

import { makeQueryBuilderConfig, type QueryBuilderDoc } from '@/lib/azure/copilot-query-builder';
import type { CopilotBuilderConfig } from '@/app/api/items/_lib/copilot-builder-route';

function tableNames(state: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: any) => { const n = String(v?.name || v?.table || v || '').trim(); if (n) out.push(n); };
  if (Array.isArray(state.tables)) (state.tables as any[]).forEach(push);
  // App-install bundle stamps a rich content graph; pull table names if present.
  const content = state.content as any;
  if (content && Array.isArray(content.tables)) content.tables.forEach(push);
  return [...new Set(out)];
}

function grounding(state: Record<string, unknown>): string {
  const names = tableNames(state);
  return names.length ? `DELTA TABLES: ${names.join(', ')}` : '';
}

const SYSTEM_PROMPT = `You author a read-only SQL SELECT over a CSA Loom lakehouse (ADLS Gen2 + Delta, queried via Synapse serverless OPENROWSET or Spark SQL).
CSA Loom is its OWN Azure product — NOT Microsoft Fabric. Never mention Microsoft Fabric or OneLake.
Respond with a JSON object ONLY: { "summary": "<1 sentence>", "ops": [ { "kind": "set-query", "query": "<SELECT ...>" } ] }.
No prose, no code fence around the JSON.
RULES:
 - Produce ONE read-only SELECT (or WITH ... SELECT). NEVER emit INSERT/UPDATE/DELETE/DDL.
 - Reference ONLY the DELTA TABLES in the LIVE ITEM CONTEXT. If none are listed, use the table names the user names and say so in summary — never invent a table.
 - Put the full SELECT in ops[0].query.`;

export const LAKEHOUSE_BUILDER_CONFIG: CopilotBuilderConfig<QueryBuilderDoc> = makeQueryBuilderConfig({
  itemType: 'lakehouse',
  docKey: 'copilotSqlDraft',
  language: 'SQL',
  systemPrompt: SYSTEM_PROMPT,
  grounding,
});

/**
 * copilot-personas-materialized-lake-view.ts — Materialized Lake View inline
 * Copilot builder config (G1). NL → a Spark SQL materialized-view definition,
 * grounded on the view's real target container / schema captured in
 * item.state.spec.
 *
 * Azure-native (no-fabric-dependency.md): a CSA Loom Materialized Lake View is
 * Delta-on-ADLS materialized by Synapse Spark (materialized-lake-view-engine).
 * No Microsoft Fabric. The generated SQL is saved as a Loom-native draft
 * (item.state.copilotMlvDraft) with checkpoint/restore; the editor's Definition
 * pane loads it and materializes it via the real batch engine.
 */

import { makeQueryBuilderConfig, type QueryBuilderDoc } from '@/lib/azure/copilot-query-builder';
import type { CopilotBuilderConfig } from '@/app/api/items/_lib/copilot-builder-route';

function grounding(state: Record<string, unknown>): string {
  const spec = (state.spec && typeof state.spec === 'object' ? state.spec : {}) as Record<string, any>;
  const lines: string[] = [];
  if (spec.container) lines.push(`TARGET CONTAINER (medallion layer): ${spec.container}`);
  if (spec.schema) lines.push(`TARGET SCHEMA: ${spec.schema}`);
  if (spec.viewName) lines.push(`VIEW NAME: ${spec.viewName}`);
  const upstream = Array.isArray(spec.upstream) ? spec.upstream : Array.isArray(state.upstream) ? state.upstream : [];
  if (upstream.length) lines.push(`UPSTREAM TABLES: ${upstream.map((u: any) => String(u?.name || u)).filter(Boolean).join(', ')}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You author a Spark SQL materialized-view definition for a CSA Loom Materialized Lake View (Delta-on-ADLS, materialized by Synapse Spark).
CSA Loom is its OWN Azure product — NOT Microsoft Fabric. Never mention Microsoft Fabric or OneLake.
Respond with a JSON object ONLY: { "summary": "<1 sentence>", "ops": [ { "kind": "set-query", "query": "<SELECT ...>" } ] }.
No prose, no code fence around the JSON.
RULES:
 - Produce the SELECT body of the materialized view (a read-only SELECT ... FROM <schema>.<table> ...). Do NOT include CREATE MATERIALIZED VIEW — the engine wraps it using the view name from context.
 - Reference ONLY the UPSTREAM TABLES / SCHEMA in the LIVE ITEM CONTEXT. If none are listed, use the target schema's conventional table names and say so in summary.
 - Prefer medallion patterns: read from bronze/silver, aggregate/clean into the target layer.
 - Put the full SELECT in ops[0].query.`;

export const MLV_BUILDER_CONFIG: CopilotBuilderConfig<QueryBuilderDoc> = makeQueryBuilderConfig({
  itemType: 'materialized-lake-view',
  docKey: 'copilotMlvDraft',
  language: 'Spark SQL',
  systemPrompt: SYSTEM_PROMPT,
  grounding,
});

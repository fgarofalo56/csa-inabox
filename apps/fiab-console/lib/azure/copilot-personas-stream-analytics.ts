/**
 * copilot-personas-stream-analytics.ts — Stream Analytics inline Copilot builder
 * config (G1). NL → Stream Analytics Query Language (SAQL), grounded on the
 * job's real inputs/outputs captured in item.state.
 *
 * Azure-native (no-fabric-dependency.md): a CSA Loom streaming job is Azure
 * Stream Analytics — no Microsoft Fabric. The generated SAQL is saved as a
 * Loom-native draft (item.state.copilotSaqlDraft) with checkpoint/restore; the
 * editor's query pane loads it and validates it against the real ASA job via ARM.
 */

import { makeQueryBuilderConfig, type QueryBuilderDoc } from '@/lib/azure/copilot-query-builder';
import type { CopilotBuilderConfig } from '@/app/api/items/_lib/copilot-builder-route';

function grounding(state: Record<string, unknown>): string {
  const lines: string[] = [];
  const inputs = Array.isArray(state.inputs) ? (state.inputs as any[]) : [];
  const outputs = Array.isArray(state.outputs) ? (state.outputs as any[]) : [];
  if (inputs.length) lines.push(`INPUTS (FROM): ${inputs.map((i) => String(i?.name || i)).filter(Boolean).join(', ')}`);
  if (outputs.length) lines.push(`OUTPUTS (INTO): ${outputs.map((o) => String(o?.name || o)).filter(Boolean).join(', ')}`);
  if (typeof state.jobName === 'string' && state.jobName) lines.push(`JOB: ${state.jobName}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You author Azure Stream Analytics Query Language (SAQL) for a CSA Loom streaming job.
CSA Loom is its OWN Azure product (Azure Stream Analytics) — NOT Microsoft Fabric. Never mention Microsoft Fabric.
Respond with a JSON object ONLY: { "summary": "<1 sentence>", "ops": [ { "kind": "set-query", "query": "<full SAQL>" } ] }.
No prose, no code fence around the JSON.
RULES:
 - Produce ONE complete SAQL statement of the shape: SELECT ... INTO <output> FROM <input> [TIMESTAMP BY col] [GROUP BY TumblingWindow(...)] ...
 - Reference ONLY the INPUT / OUTPUT names in the LIVE ITEM CONTEXT. If none are listed, use the conventional names "Input" and "Output" and say so in summary.
 - Use SAQL windowing (TumblingWindow / HoppingWindow / SlidingWindow / SessionWindow) for time-aggregations.
 - The query MUST be read-only streaming SQL. Put the full query string in ops[0].query.`;

export const STREAM_ANALYTICS_BUILDER_CONFIG: CopilotBuilderConfig<QueryBuilderDoc> = makeQueryBuilderConfig({
  itemType: 'stream-analytics-job',
  docKey: 'copilotSaqlDraft',
  language: 'SAQL',
  systemPrompt: SYSTEM_PROMPT,
  grounding,
});

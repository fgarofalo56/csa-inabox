/**
 * copilot-query-builder.ts — shared factory that turns a query-centric design
 * surface into a Copilot builder config (G1).
 *
 * Several Loom surfaces are query authoring surfaces rather than structured-node
 * topologies: Stream Analytics (SAQL), the graph editors (GQL/Cypher/KQL), the
 * Materialized Lake View (SQL/PySpark view definition), and the Lakehouse SQL
 * pane. For those, the Copilot builder proposes ONE op — replace the draft query
 * — grounded on the item's real schema/inputs in item.state, and apply persists
 * it to the Loom-native Cosmos draft (`item.state.<docKey>`) with checkpoint/
 * restore safety. The host editor's Copilot tab reads that draft back.
 *
 * Azure-native DEFAULT (no-fabric-dependency.md): the draft lives in the Cosmos
 * item — no Microsoft Fabric / Power BI. The generated query runs against the
 * surface's real Azure backend (ASA ARM validate, ADX Kusto, Synapse serverless)
 * from the editor's existing Run/Test path.
 *
 * Server-only (imported by assist routes). Uses only the shared route helper.
 */

import type {
  BuilderOp,
  CopilotBuilderConfig,
} from '@/app/api/items/_lib/copilot-builder-route';

export interface QueryBuilderDoc {
  /** The current draft query text (persisted to item.state[docKey]). */
  query: string;
  /** REAL grounding (schema / inputs / tables) captured from item.state. */
  grounding: string;
}

export interface QueryBuilderSpec {
  itemType: string;
  /** item.state key holding the draft query (e.g. 'copilotQueryDraft'). */
  docKey: string;
  /** Human language name for the badge / messages (e.g. 'SAQL', 'GQL', 'SQL'). */
  language: string;
  /** Persona system prompt (grounding is appended by the route). MUST NOT
   *  mention Microsoft Fabric. It MUST instruct the model to return
   *  { "summary": "...", "ops": [ { "kind":"set-query", "query":"..." } ] }. */
  systemPrompt: string;
  /**
   * Compact REAL grounding text derived from item.state (schema / inputs /
   * outputs / tables). Receives the full state so the surface can pull whatever
   * it persisted. Return '(no schema captured yet)' when empty — never fabricate.
   */
  grounding: (state: Record<string, unknown>) => string;
  maxCompletionTokens?: number;
}

/** Strip a leading/trailing ```lang fence the model sometimes wraps around code. */
function stripFence(s: string): string {
  return s
    .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

export function makeQueryBuilderConfig(spec: QueryBuilderSpec): CopilotBuilderConfig<QueryBuilderDoc> {
  const { itemType, docKey, language } = spec;

  return {
    itemType,
    docKeys: [docKey],
    checkpointsKey: `${itemType}QueryCheckpoints`,
    readDoc(state) {
      const raw = state[docKey];
      return {
        query: typeof raw === 'string' ? raw : '',
        grounding: spec.grounding(state) || '(no schema captured yet)',
      };
    },
    computeStats(doc) {
      return { lines: doc.query ? doc.query.split('\n').length : 0 };
    },
    systemPrompt: spec.systemPrompt,
    groundingText(doc) {
      const draft = doc.query.trim()
        ? `CURRENT DRAFT ${language} (revise this unless the request asks for a fresh query):\n${doc.query.trim().slice(0, 1200)}`
        : `(no draft ${language} yet — author a new query)`;
      return `${doc.grounding}\n\n${draft}`;
    },
    normalizeOps(rawOps): BuilderOp[] {
      // Accept the FIRST set-query op with a non-empty query.
      for (const o of rawOps as any[]) {
        if (String(o?.kind || '').trim() !== 'set-query') continue;
        const query = stripFence(String(o?.query || ''));
        if (!query) continue;
        const preview = query.length > 90 ? `${query.slice(0, 90)}…` : query;
        return [{
          kind: 'set-query',
          query,
          badge: `Set ${language}`,
          badgeColor: 'brand',
          describe: `Replace the draft ${language} with:\n${preview}`,
        }];
      }
      return [];
    },
    applyOps(_doc, ops) {
      const op = ops[0];
      const query = op ? String(op.query || '') : '';
      return {
        patch: { [docKey]: query },
        applied: [`Saved a ${query.split('\n').length}-line ${language} draft. Open the query pane to Run it against the real backend.`],
        skipped: [],
      };
    },
    maxCompletionTokens: spec.maxCompletionTokens ?? 1200,
  };
}

/**
 * dataflow-tools — the five Azure-OpenAI tool definitions for the Dataflow Gen2
 * Copilot persona. Each tool maps a natural-language ask onto one real M
 * operation in `dataflow-engine-client.ts` (which validates every result with
 * the same parser that backs the Applied Steps pane).
 *
 * Tools follow the shared `ToolDef` shape from `copilot-orchestrator.ts`, so the
 * Dataflow Copilot can be driven either by the focused JSON BFF route
 * (`/api/items/dataflow/copilot`) or registered into the cross-item registry.
 *
 * Azure-native by default (per no-fabric-dependency): no Fabric / Power BI host
 * is reachable from any handler — only the tenant's Azure OpenAI deployment and
 * pure M string manipulation.
 */

import type { ToolDef } from '@/lib/azure/copilot-orchestrator';
import type { AoaiTarget } from '@/lib/azure/copilot-orchestrator';
import {
  generateQueryFromNL,
  generateReferenceQuery,
  explainQuery,
  generateTransformStep,
  parseLetBody,
  buildLetBody,
} from '@/lib/azure/dataflow-engine-client';

const S_STRING = { type: 'string' } as const;
const S_STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/**
 * Build the Dataflow Copilot tool set bound to a resolved AOAI target.
 *
 * `dataflow_undo_last_step` is pure M manipulation (no AOAI) — it removes the
 * most-recently-appended Applied Step and rewires `in <result>` to the new last
 * step, returning the rebuilt body for the editor to apply after diff approval.
 */
export function buildDataflowTools(target: AoaiTarget): ToolDef[] {
  return [
    {
      name: 'dataflow_generate_query_from_nl',
      service: 'Dataflow',
      description:
        'Generate a new Power Query (M) query from a natural-language description, optionally with sample data.',
      parameters: obj({ prompt: S_STRING, existingQueryNames: S_STRING_ARRAY }, ['prompt']),
      handler: async ({ prompt, existingQueryNames }) => {
        const g = await generateQueryFromNL(String(prompt || ''), existingQueryNames || [], target);
        return { kind: 'new_query', queryName: g.queryName, mBody: g.mBody };
      },
    },
    {
      name: 'dataflow_generate_reference_query',
      service: 'Dataflow',
      description:
        'Generate a new query that references (reads from) an existing query in the same dataflow.',
      parameters: obj(
        { prompt: S_STRING, sourceQueryName: S_STRING, sourceBody: S_STRING, existingQueryNames: S_STRING_ARRAY },
        ['prompt', 'sourceQueryName'],
      ),
      handler: async ({ prompt, sourceQueryName, sourceBody, existingQueryNames }) => {
        const g = await generateReferenceQuery(
          String(prompt || ''),
          String(sourceQueryName || ''),
          String(sourceBody || ''),
          existingQueryNames || [],
          target,
        );
        return { kind: 'new_query', queryName: g.queryName, mBody: g.mBody };
      },
    },
    {
      name: 'dataflow_explain_query',
      service: 'Dataflow',
      description: 'Explain the active query and its applied steps in plain English.',
      parameters: obj({ queryName: S_STRING, body: S_STRING }, ['queryName', 'body']),
      handler: async ({ queryName, body }) => ({
        kind: 'explain',
        explanation: await explainQuery(String(queryName || ''), String(body || ''), target),
      }),
    },
    {
      name: 'dataflow_add_transform_step',
      service: 'Dataflow',
      description:
        'Generate a new transformation step (one M expression) to append to the active query, from a natural-language description.',
      parameters: obj({ prompt: S_STRING, activeQueryName: S_STRING, currentBody: S_STRING }, [
        'prompt',
        'activeQueryName',
        'currentBody',
      ]),
      handler: async ({ prompt, activeQueryName, currentBody }) => {
        const step = await generateTransformStep(
          String(prompt || ''),
          String(activeQueryName || ''),
          String(currentBody || ''),
          target,
        );
        return { kind: 'transform', stepName: step.stepName, stepExpr: step.stepExpr };
      },
    },
    {
      name: 'dataflow_undo_last_step',
      service: 'Dataflow',
      description: 'Remove the last applied step from the active query.',
      parameters: obj({ activeQueryName: S_STRING, currentBody: S_STRING }, ['activeQueryName', 'currentBody']),
      handler: async ({ currentBody }) => {
        const { steps } = parseLetBody(String(currentBody || ''));
        if (steps.length <= 1) {
          return { kind: 'undo', ok: false, error: 'Cannot remove the last remaining step.' };
        }
        const nextSteps = steps.slice(0, -1);
        const nextResult = nextSteps[nextSteps.length - 1].name;
        return {
          kind: 'undo',
          ok: true,
          removedStep: steps[steps.length - 1].name,
          newBody: buildLetBody(nextSteps, nextResult),
        };
      },
    },
  ];
}

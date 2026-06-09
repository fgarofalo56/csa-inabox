/**
 * copilot-personas-pipeline.ts — the Pipeline Copilot persona registry.
 *
 * Split out from copilot-personas.ts (which holds the client-safe suggested-
 * prompt chip helpers) because this module imports the server-only ADF /
 * Synapse data-plane clients. Keeping it separate ensures the client chip
 * bundle never pulls in @azure/identity / node built-ins.
 *
 * buildPipelineRegistry(backend, pipelineName, aoaiTarget) → LoomToolRegistry
 *   The Pipeline Copilot docked in the data-pipeline editor: NL→pipeline,
 *   `/` source/dest completion, apply-to-canvas, run, summarize, and the error
 *   assistant. It reuses the core orchestrate() loop from copilot-orchestrator.ts
 *   via registryOverride/systemPromptOverride. Azure-native (ADF / Synapse), no
 *   Fabric dependency.
 */

import { LoomToolRegistry, type AoaiTarget } from './copilot-orchestrator';
import * as tools from '../copilot/pipeline-tools';
import type { PipelineBackend } from '../copilot/pipeline-tools';
import * as adf from './adf-client';
import * as synapseDev from './synapse-dev-client';
import type { PipelineSpec } from '../components/pipeline/types';

export const PIPELINE_COPILOT_SYSTEM_PROMPT = `You are CSA Loom Pipeline Copilot — the AI assistant embedded in the CSA Loom data-pipeline canvas editor. You generate, run, summarize, and debug Azure-native data pipelines (Azure Data Factory / Synapse Integrate). CSA Loom is its OWN product and runs entirely on Azure — never say "Microsoft Fabric"; you may name ADF / Synapse as the real backend.

You NEVER invent linked-service (connection) or dataset names. Always call pipeline_list_connections FIRST to get the real names available in this factory/workspace, then reference only those.

Workflow for "copy from X to Y" (or any "build/generate a pipeline" request):
  1. Call pipeline_list_connections to enumerate available connections.
  2. Call pipeline_generate with the description + the real connections array.
  3. Call pipeline_apply_canvas with the generated spec — this persists it to the
     real ADF/Synapse pipeline AND pushes the nodes to the canvas.

Other intents:
  - "run it" / "run the pipeline"  → call pipeline_run, report the real runId.
  - "what's the status of <runId>"  → call pipeline_get_run_status.
  - "what does this pipeline do?"    → call pipeline_summarize.
  - "why did <runId> fail?" / "explain the error" → call pipeline_explain_error.

Use tools immediately — never say "I would" or "I will". Keep your final summary short; the user already sees the step trace.`;

export function buildPipelineRegistry(
  backend: PipelineBackend,
  pipelineName: string,
  aoaiTarget: AoaiTarget,
): LoomToolRegistry {
  const r = new LoomToolRegistry();
  const backendLabel = backend === 'adf' ? 'Azure Data Factory' : 'Synapse';

  r.register({
    name: 'pipeline_list_connections',
    service: 'Pipeline',
    description:
      `List the linked services (connections) available in this ${backendLabel}. Returns name + connector type + ` +
      'whether each can be a Copy source and/or sink. Call this BEFORE generating any pipeline so you use real names.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: async () => tools.handlePipelineListConnections({ backend }),
  });

  r.register({
    name: 'pipeline_list_datasets',
    service: 'Pipeline',
    description: `List the datasets registered in this ${backendLabel} (name + type + the linked service each binds to).`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: async () => tools.handlePipelineListDatasets({ backend }),
  });

  r.register({
    name: 'pipeline_generate',
    service: 'Pipeline',
    description:
      'Generate a complete pipeline JSON from a natural-language description, grounded in the real linked services ' +
      'from pipeline_list_connections. Returns a validated pipeline spec + a human summary. Does NOT persist — call ' +
      'pipeline_apply_canvas next to push it live.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the pipeline should do.' },
        name: { type: 'string', description: 'Pipeline name (letters/digits/_/-, ≤140 chars).' },
        connections: {
          type: 'array',
          description: 'The connections returned by pipeline_list_connections.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, type: { type: 'string' } },
            required: ['name', 'type'],
            additionalProperties: true,
          },
        },
      },
      required: ['description', 'name'],
      additionalProperties: false,
    },
    handler: async (args) =>
      tools.handlePipelineGenerate(
        { description: args.description, name: args.name, backend, connections: args.connections },
        aoaiTarget,
      ),
  });

  r.register({
    name: 'pipeline_apply_canvas',
    service: 'Pipeline',
    description:
      `Apply a generated pipeline spec to the canvas. Pass the spec from pipeline_generate. This UPSERTS the ` +
      `activities into the bound pipeline "${pipelineName}" via the real ${backendLabel} REST API and pushes the ` +
      'nodes to the React-Flow canvas.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'Pipeline spec ({ name?, properties: { activities, ... } }).' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const incoming = (args.spec || {}) as PipelineSpec;
      const properties = incoming.properties && typeof incoming.properties === 'object'
        ? incoming.properties
        : { activities: [] };
      if (!Array.isArray((properties as any).activities)) (properties as any).activities = [];
      // Always persist into the BOUND pipeline name (the item the user is editing),
      // not the model-suggested name — so apply mutates this pipeline's canvas.
      const upsertSpec: PipelineSpec = { name: pipelineName, properties };
      if (backend === 'adf') {
        await adf.upsertPipeline(pipelineName, upsertSpec as any);
      } else {
        await synapseDev.upsertPipeline(pipelineName, upsertSpec as any);
      }
      // _action marks this for the BFF route to emit a 'canvas_apply' SSE event.
      return { _action: 'apply_canvas', pipelineName, spec: upsertSpec, activityCount: (properties as any).activities.length };
    },
  });

  r.register({
    name: 'pipeline_run',
    service: 'Pipeline',
    description: `Run the bound pipeline "${pipelineName}" on ${backendLabel}. Returns a real runId. Optionally pass parameters.`,
    parameters: {
      type: 'object',
      properties: { params: { type: 'object', description: 'Optional pipeline parameters (name→value).' } },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => tools.handlePipelineRun({ pipelineName, backend, params: args.params }),
  });

  r.register({
    name: 'pipeline_get_run_status',
    service: 'Pipeline',
    description: 'Get the status (Queued/InProgress/Succeeded/Failed/Cancelled) of a pipeline run by its runId.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'The runId from pipeline_run.' } },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async (args) => tools.handlePipelineGetRunStatus({ runId: args.runId, backend, pipelineName }),
  });

  r.register({
    name: 'pipeline_summarize',
    service: 'Pipeline',
    description: `Summarize the bound pipeline "${pipelineName}": its activities, their types, and dependencies. Use for "what does this pipeline do?".`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: async () => tools.handlePipelineSummarize({ pipelineName, backend }),
  });

  r.register({
    name: 'pipeline_explain_error',
    service: 'Pipeline',
    description:
      'Read the REAL error details from a failed pipeline run and return them so you can explain the failure in plain ' +
      'English. Pass the runId of a failed run.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'runId of the failed run.' } },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async (args) => tools.handlePipelineExplainError({ runId: args.runId, backend, pipelineName }),
  });

  return r;
}

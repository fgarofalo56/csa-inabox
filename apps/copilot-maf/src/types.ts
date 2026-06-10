/**
 * Orchestrator step contract — byte-identical to the Console's
 * `OrchestratorStep` discriminated union in
 * `apps/fiab-console/lib/azure/copilot-orchestrator.ts`. The Console proxies
 * these straight through to the `/api/copilot/orchestrate` SSE stream, so the
 * shapes MUST stay in lockstep. This is a leaf type file (no imports) so it can
 * be shared/duplicated without dragging in the Next.js dependency graph.
 */

export interface OrchestratorUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aoaiCalls: number;
  toolCalls: number;
}

export type OrchestratorStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string; usage?: OrchestratorUsage; model?: string }
  | { kind: 'error'; error: string };

/** OpenAI/AOAI chat message shape used by the agent loop. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Tool schema as returned by the Console's internal /tools endpoint. */
export interface ToolSchema {
  name: string;
  description: string;
  service: string;
  parameters: Record<string, unknown>;
}

/**
 * Agent tool-KIND contract (shared) — the typed vocabulary of tools an agent
 * can carry. Extracted into this small leaf module so the parallel AIF-5 work
 * (typed tool catalog) and AIF-18 (browser-automation tool) both build on ONE
 * canonical shape and merge cleanly, instead of each re-deriving a `TOOL_TYPES`
 * array in the editor.
 *
 * A "kind" is the tool *type* (code_interpreter / file_search / function /
 * browser_automation …). Each kind knows:
 *   - how it renders in the Agents editor (label + description),
 *   - whether it needs extra input (a function name),
 *   - whether it is gated on an infra env var (honest-gate per no-vaporware),
 *   - how to serialize into the Foundry `tools[]` entry.
 *
 * No Azure imports here — this is a pure, unit-testable contract. Runtime gate
 * *state* (is the env var actually set) is resolved by the small helpers at the
 * bottom, which only read `process.env`.
 */

export type AgentToolKindValue =
  | 'code_interpreter'
  | 'file_search'
  | 'function'
  | 'browser_automation';

export interface AgentToolKind {
  value: AgentToolKindValue;
  label: string;
  /** One-line "what it does" shown under the checkbox. */
  description: string;
  /** True when the kind needs a function name input (the OpenAI function tool). */
  needsFunctionName?: boolean;
  /**
   * When set, this kind's backend is gated on an Azure infra env var. Absent →
   * the editor renders an honest MessageBar (never a silent/broken tool).
   */
  gateEnv?: string;
  /** Honest-gate copy: what to provision + which module deploys it. */
  gateHint?: string;
}

/** Env var that points at the deployed Playwright ACA Job (AIF-18). */
export const BROWSER_TOOL_ENV = 'LOOM_BROWSER_TOOL_JOB';

export const BROWSER_TOOL_GATE_HINT =
  'Browser automation requires a Playwright headless-browser runner. Deploy ' +
  'platform/fiab/bicep/modules/copilot/browser-tool.bicep (a scale-to-zero Azure ' +
  'Container Apps Job) and set ' + BROWSER_TOOL_ENV + ' to the job resource id. ' +
  'The full tool UI still renders — it just has no runner to drive yet.';

/**
 * The canonical tool kinds. Order is the editor's display order. AIF-5 may add
 * more entries here (e.g. `mcp`, `openapi`, `azure_ai_search`, `bing_grounding`)
 * — this module is the single place to do so.
 */
export const AGENT_TOOL_KINDS: readonly AgentToolKind[] = [
  { value: 'code_interpreter', label: 'Code interpreter', description: 'Run sandboxed Python to compute, chart, and analyze uploaded data.' },
  { value: 'file_search', label: 'File search', description: 'Ground answers on the agent\'s attached files / vector store.' },
  { value: 'function', label: 'Function calling', description: 'Call a named function tool with a typed argument schema.', needsFunctionName: true },
  {
    value: 'browser_automation',
    label: 'Browser automation',
    description: 'Drive a real web page (navigate, click, read) via a Loom-owned Playwright runner — Azure-native, no external browser service.',
    gateEnv: BROWSER_TOOL_ENV,
    gateHint: BROWSER_TOOL_GATE_HINT,
  },
] as const;

/** Look up a kind by value. */
export function getToolKind(value: string): AgentToolKind | undefined {
  return AGENT_TOOL_KINDS.find((k) => k.value === value);
}

/** True when the kind is a valid, known tool kind. */
export function isToolKind(value: string): value is AgentToolKindValue {
  return AGENT_TOOL_KINDS.some((k) => k.value === value);
}

/**
 * Resolve a kind's infra gate against the current env. `gated:true` means the
 * kind's backend env var is unset, so the editor must render the honest hint
 * and the tool cannot actually run yet.
 */
export function toolKindGate(value: string, env: Record<string, string | undefined> = process.env): { gated: boolean; hint?: string } {
  const kind = getToolKind(value);
  if (!kind?.gateEnv) return { gated: false };
  const set = !!(env[kind.gateEnv] || '').trim();
  return set ? { gated: false } : { gated: true, hint: kind.gateHint };
}

/** True when the browser-automation runner is configured (its env var is set). */
export function browserToolConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !toolKindGate('browser_automation', env).gated;
}

/**
 * Serialize a checked kind into a Foundry `FoundryAgentBody.tools` entry. The
 * browser_automation kind is expressed as a `function` tool with a fixed
 * OpenAI schema so any Assistants-compatible runtime (Foundry or the MAF tier)
 * can call it; Loom routes that function name to the Playwright runner.
 */
export function buildToolDefinition(
  value: AgentToolKindValue,
  opts?: { functionName?: string },
): Record<string, unknown> {
  if (value === 'function') {
    const name = (opts?.functionName || '').trim() || 'my_function';
    return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } };
  }
  if (value === 'browser_automation') {
    return {
      type: 'function',
      function: {
        name: 'browser_automation',
        description: 'Drive a headless web browser: navigate to a URL and run a sequence of actions (click, type, read text), returning the page text/screenshot.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to open.' },
            actions: {
              type: 'array',
              description: 'Ordered actions: {op:"click"|"type"|"read"|"screenshot", selector?, text?}.',
              items: { type: 'object' },
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    };
  }
  return { type: value };
}

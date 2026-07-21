/**
 * a2a-protocol — the PURE Agent2Agent (A2A) protocol core (WS-5.2).
 *
 * A2A is the sibling protocol to MCP: where MCP publishes a Loom agent as a
 * callable *tool* (data-agent-mcp.ts), A2A publishes it as a delegable *agent*
 * that other agents (Google ADK, Azure AI Foundry Agent Service, any A2A client)
 * discover via an **Agent Card** and drive with JSON-RPC **task delegation**
 * (`message/send` → a `Task`, `tasks/get`, `tasks/cancel`).
 *
 * This module holds only the PURE protocol logic — the type shapes (grounded in
 * the official a2a-js SDK: `kind` discriminators, kebab-case `TaskState`,
 * `message/*` method names), the agent-card + skill builders, the JSON-RPC
 * dispatcher, and message/part helpers — so it is unit-tested with NO network,
 * Cosmos, or Fluent import. The routes inject the real backends: `execute`
 * (which runs the delegated task against the real data-agent / agent-flow /
 * ontology backend, governed + audited) and the task store (`saveTask` /
 * `loadTask`, the Cosmos-backed a2a-task-store in production).
 *
 * Sovereign / Azure-native: nothing here reaches Fabric or Power BI; the
 * execution backends the route injects are all Azure-native (no-fabric-dependency.md).
 */

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** A2A protocol version this server advertises (a2a-js current line). */
export const A2A_PROTOCOL_VERSION = '0.3.0';

/** JSON-RPC 2.0 + A2A-specific error codes (verbatim from the a2a-js SDK). */
export const A2A_ERROR = {
  // Standard JSON-RPC 2.0
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // A2A-specific (server-error range)
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED: -32007,
} as const;

// ---------------------------------------------------------------------------
// Agent Card types (served at /.well-known/agent-card.json)
// ---------------------------------------------------------------------------

export interface A2aAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface A2aAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2aAgentProvider {
  organization: string;
  url: string;
}

export interface A2aSecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
  description?: string;
  // http
  scheme?: string;
  bearerFormat?: string;
  // apiKey
  in?: 'header' | 'query' | 'cookie';
  name?: string;
  // openIdConnect
  openIdConnectUrl?: string;
}

export interface A2aAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  /** The A2A JSON-RPC endpoint URL (POST message/send here). */
  url: string;
  version: string;
  preferredTransport?: string;
  capabilities: A2aAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
  provider?: A2aAgentProvider;
  documentationUrl?: string;
  securitySchemes?: Record<string, A2aSecurityScheme>;
  security?: Array<Record<string, string[]>>;
}

// ---------------------------------------------------------------------------
// Task / Message / Part types
// ---------------------------------------------------------------------------

export type A2aTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

/** Terminal states — a task in one of these cannot be canceled. */
export const A2A_TERMINAL_STATES: readonly A2aTaskState[] = [
  'completed', 'canceled', 'failed', 'rejected',
];

export interface A2aTextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}
export interface A2aDataPart {
  kind: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export interface A2aFilePart {
  kind: 'file';
  file: { bytes?: string; uri?: string; mimeType?: string; name?: string };
  metadata?: Record<string, unknown>;
}
export type A2aPart = A2aTextPart | A2aDataPart | A2aFilePart;

export interface A2aMessage {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: A2aPart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aArtifact {
  artifactId: string;
  parts: A2aPart[];
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
  state: A2aTaskState;
  message?: A2aMessage;
  timestamp?: string;
}

export interface A2aTask {
  kind: 'task';
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  history?: A2aMessage[];
  artifacts?: A2aArtifact[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Options for the standard Loom agent card (bearer-PAT secured). */
export interface BuildAgentCardOpts {
  name: string;
  description: string;
  /** Absolute A2A endpoint URL (POST message/send). */
  url: string;
  skills: A2aAgentSkill[];
  version?: string;
  documentationUrl?: string;
  capabilities?: A2aAgentCapabilities;
}

/**
 * Build a valid A2A agent card for a Loom agent / the platform. Loom secures the
 * A2A endpoint with the same Bearer scheme its MCP + OpenAPI surfaces use (a
 * scoped `loom_pat_…` token or a Console session cookie), declared here as an
 * HTTP bearer security scheme so an external client knows how to authenticate.
 */
export function buildAgentCard(opts: BuildAgentCardOpts): A2aAgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: opts.name,
    description: opts.description,
    url: opts.url,
    version: opts.version || '1.0.0',
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      ...(opts.capabilities || {}),
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: opts.skills,
    provider: { organization: 'CSA Loom', url: 'https://csa-loom.limitlessdata.ai' },
    ...(opts.documentationUrl ? { documentationUrl: opts.documentationUrl } : {}),
    securitySchemes: {
      loomBearer: {
        type: 'http',
        scheme: 'Bearer',
        bearerFormat: 'loom_pat',
        description:
          'A scoped Loom API token (Authorization: Bearer loom_pat_…) or a Console session cookie.',
      },
    },
    security: [{ loomBearer: [] }],
  };
}

/** True when `card` satisfies the required A2A agent-card fields. Pure validator. */
export function isValidAgentCard(card: unknown): card is A2aAgentCard {
  if (!card || typeof card !== 'object') return false;
  const c = card as Record<string, unknown>;
  const strOk = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (!strOk(c.protocolVersion) || !strOk(c.name) || !strOk(c.description)) return false;
  if (!strOk(c.url) || !strOk(c.version)) return false;
  if (!c.capabilities || typeof c.capabilities !== 'object') return false;
  if (!Array.isArray(c.defaultInputModes) || !Array.isArray(c.defaultOutputModes)) return false;
  if (!Array.isArray(c.skills)) return false;
  for (const s of c.skills as unknown[]) {
    const sk = s as Record<string, unknown>;
    if (!strOk(sk?.id) || !strOk(sk?.name) || !strOk(sk?.description) || !Array.isArray(sk?.tags)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Message / Part helpers
// ---------------------------------------------------------------------------

/** Concatenate the text of every TextPart in a message (the free-text prompt). */
export function messageText(msg: A2aMessage | undefined): string {
  if (!msg || !Array.isArray(msg.parts)) return '';
  return msg.parts
    .filter((p): p is A2aTextPart => p?.kind === 'text' && typeof (p as A2aTextPart).text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** Merge the `data` of every DataPart into one object (structured task params). */
export function messageData(msg: A2aMessage | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!msg || !Array.isArray(msg.parts)) return out;
  for (const p of msg.parts) {
    if (p?.kind === 'data' && p.data && typeof p.data === 'object') Object.assign(out, p.data);
  }
  return out;
}

let _idCounter = 0;
/** Default id generator (overridable in ctx for deterministic tests). */
export function genA2aId(prefix = 'a2a'): string {
  _idCounter = (_idCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Server context + JSON-RPC dispatch
// ---------------------------------------------------------------------------

/** The result of executing one delegated task (built into a terminal Task). */
export interface A2aExecuteResult {
  /** The agent's output parts (folded into the Task's single artifact). */
  parts: A2aPart[];
  /** Terminal state — defaults to `completed`. Use `failed` for an error. */
  state?: Extract<A2aTaskState, 'completed' | 'failed' | 'rejected'>;
  /** Optional human status message (surfaced in status.message on failure). */
  statusText?: string;
}

/** One audit observation the dispatcher emits per delegated task. */
export interface A2aAuditEvent {
  method: string;
  skillId?: string;
  taskId: string;
  contextId: string;
  outcome: 'success' | 'failure';
  detail?: string;
}

/** Injected side-effect surface — real in the route, stubbed in tests. */
export interface A2aServerContext {
  /** The agent card (for the `security`/`skills` the endpoint advertises). */
  agentCard: A2aAgentCard;
  /**
   * Run the delegated task against the REAL backend. `skillId` is the requested
   * A2A skill (or undefined → the agent's default). Throwing rejects the task
   * as `failed`; returning a result with `state:'failed'` is an honest failure.
   */
  execute: (input: { skillId?: string; text: string; data: Record<string, unknown>; message: A2aMessage }) => Promise<A2aExecuteResult>;
  /** Persist a task so `tasks/get` can retrieve it later. */
  saveTask: (task: A2aTask) => Promise<void>;
  /** Load a previously-persisted task by id (null when unknown / not visible). */
  loadTask: (id: string) => Promise<A2aTask | null>;
  /** Fire-and-forget audit hook (the route wires the Cosmos/SIEM audit). */
  onAudit?: (ev: A2aAuditEvent) => void;
  now?: () => string;
  genId?: () => string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Read the requested skill id from the params/message metadata. */
export function requestedSkillId(params: any): string | undefined {
  const fromParams = params?.metadata?.skillId ?? params?.metadata?.skill;
  const fromMessage = params?.message?.metadata?.skillId ?? params?.message?.metadata?.skill;
  const v = fromParams ?? fromMessage;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Dispatch a single JSON-RPC request against the A2A surface. Returns the
 * response object (never null — A2A has no notification methods here). PURE apart
 * from the injected `ctx` backends — fully unit-tested with stubs.
 *
 * Supported methods:
 *   - `message/send`  → execute the delegated task, persist + return a Task.
 *   - `tasks/send`    → legacy (A2A v0.1) alias of `message/send`.
 *   - `tasks/get`     → load + return a persisted Task (or -32001).
 *   - `tasks/cancel`  → cancel a non-terminal Task (or -32002 / -32001).
 *   - `message/stream`→ -32004 (streaming not advertised; use message/send).
 */
export async function handleA2aRpc(
  body: { id?: unknown; method?: unknown; params?: any },
  ctx: A2aServerContext,
): Promise<Record<string, unknown>> {
  const { id, method, params } = body || {};
  const now = ctx.now || (() => new Date().toISOString());
  const gid = ctx.genId || genA2aId;

  switch (method) {
    case 'message/send':
    case 'tasks/send': { // legacy A2A v0.1 alias
      const message = params?.message as A2aMessage | undefined;
      if (!message || message.kind !== 'message' || !Array.isArray(message.parts)) {
        return rpcError(id, A2A_ERROR.INVALID_PARAMS, 'params.message must be an A2A Message (kind:"message" with parts[])');
      }
      const text = messageText(message);
      const data = messageData(message);
      if (!text && Object.keys(data).length === 0) {
        return rpcError(id, A2A_ERROR.INVALID_PARAMS, 'the delegated message has no text or data parts — nothing to run');
      }
      const skillId = requestedSkillId(params);
      const taskId = message.taskId || gid('task');
      const contextId = message.contextId || gid('ctx');
      const userMessage: A2aMessage = { ...message, taskId, contextId };

      let result: A2aExecuteResult;
      try {
        result = await ctx.execute({ skillId, text, data, message: userMessage });
      } catch (e: any) {
        const detail = e?.message || String(e);
        const failed = buildTerminalTask(taskId, contextId, 'failed', [{ kind: 'text', text: detail }], userMessage, now, detail);
        try { await ctx.saveTask(failed); } catch { /* best-effort persist */ }
        ctx.onAudit?.({ method: 'message/send', skillId, taskId, contextId, outcome: 'failure', detail });
        return rpcResult(id, failed);
      }

      const state = result.state || 'completed';
      const task = buildTerminalTask(taskId, contextId, state, result.parts, userMessage, now, result.statusText);
      try { await ctx.saveTask(task); } catch { /* best-effort persist */ }
      ctx.onAudit?.({
        method: 'message/send', skillId, taskId, contextId,
        outcome: state === 'completed' ? 'success' : 'failure',
        detail: result.statusText,
      });
      return rpcResult(id, task);
    }

    case 'tasks/get': {
      const taskId = String(params?.id || '');
      if (!taskId) return rpcError(id, A2A_ERROR.INVALID_PARAMS, 'params.id (task id) is required');
      let task: A2aTask | null;
      try { task = await ctx.loadTask(taskId); } catch { task = null; }
      if (!task) return rpcError(id, A2A_ERROR.TASK_NOT_FOUND, `Task "${taskId}" was not found.`);
      // Honor historyLength (0 → drop history) per TaskQueryParams.
      const hl = params?.historyLength;
      if (typeof hl === 'number' && hl >= 0 && Array.isArray(task.history)) {
        // NB: slice(-0) === slice(0) returns the whole array, so compute the
        // start index explicitly (hl=0 → start at length → []).
        task = { ...task, history: task.history.slice(Math.max(0, task.history.length - hl)) };
      }
      return rpcResult(id, task);
    }

    case 'tasks/cancel': {
      const taskId = String(params?.id || '');
      if (!taskId) return rpcError(id, A2A_ERROR.INVALID_PARAMS, 'params.id (task id) is required');
      let task: A2aTask | null;
      try { task = await ctx.loadTask(taskId); } catch { task = null; }
      if (!task) return rpcError(id, A2A_ERROR.TASK_NOT_FOUND, `Task "${taskId}" was not found.`);
      if (A2A_TERMINAL_STATES.includes(task.status.state)) {
        return rpcError(id, A2A_ERROR.TASK_NOT_CANCELABLE, `Task "${taskId}" is already ${task.status.state} and cannot be canceled.`);
      }
      const canceled: A2aTask = { ...task, status: { state: 'canceled', timestamp: now() } };
      try { await ctx.saveTask(canceled); } catch { /* best-effort */ }
      ctx.onAudit?.({ method: 'tasks/cancel', taskId, contextId: task.contextId, outcome: 'success' });
      return rpcResult(id, canceled);
    }

    case 'message/stream':
    case 'tasks/resubscribe':
      return rpcError(id, A2A_ERROR.UNSUPPORTED_OPERATION, 'Streaming is not supported by this agent — use message/send (blocking).');

    default:
      return rpcError(id, A2A_ERROR.METHOD_NOT_FOUND, `Method not found: ${String(method)}`);
  }
}

/** Build a terminal Task from an execution result. Pure. */
export function buildTerminalTask(
  id: string,
  contextId: string,
  state: A2aTaskState,
  parts: A2aPart[],
  userMessage: A2aMessage,
  now: () => string,
  statusText?: string,
): A2aTask {
  const ts = now();
  const cleanParts = parts.length ? parts : [{ kind: 'text' as const, text: statusText || '' }];
  const artifacts: A2aArtifact[] = [{
    artifactId: `${id}-result`,
    name: 'result',
    parts: cleanParts,
  }];
  const statusMessage: A2aMessage | undefined = statusText
    ? { kind: 'message', messageId: `${id}-status`, role: 'agent', parts: [{ kind: 'text', text: statusText }], taskId: id, contextId }
    : undefined;
  return {
    kind: 'task',
    id,
    contextId,
    status: { state, timestamp: ts, ...(statusMessage ? { message: statusMessage } : {}) },
    history: [userMessage],
    artifacts,
  };
}

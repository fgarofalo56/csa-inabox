/**
 * a2a-client — the OUTBOUND half of WS-5.2: a Loom agent delegates a task OUT to
 * an external A2A agent (Google ADK, Foundry Agent Service, any A2A server).
 *
 * Every outbound fetch (the agent-card discovery + the JSON-RPC message/send /
 * tasks/get) is gated by the gov-safe egress profile (a2a-egress-guard.ts) — with
 * no `LOOM_A2A_EGRESS_ALLOW` set, delegation is refused entirely (the sovereign /
 * air-gapped default; nothing leaves the boundary). This is the real network
 * client; the routes call it after a session check, so a Loom user (or a Loom
 * agent acting for them) can delegate to a whitelisted external agent.
 *
 * Discovery reads the current spec location `/.well-known/agent-card.json` and
 * falls back to the legacy `/.well-known/agent.json`. Azure-native egress; no
 * Fabric dependency.
 */

import { assertA2aEgressAllowed } from '@/lib/azure/a2a-egress-guard';
import {
  isValidAgentCard, type A2aAgentCard, type A2aMessage, type A2aPart, type A2aTask,
  genA2aId,
} from '@/lib/copilot/a2a-protocol';

const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'];
const FETCH_TIMEOUT_MS = 15000;

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } : {};
}

/**
 * Resolve an external agent's card. `origin` is the agent's base URL (or a full
 * card URL). Tries the current then the legacy well-known path. Egress-gated.
 * Throws A2aEgressError when the host is not in the gov-safe profile.
 */
export async function fetchExternalAgentCard(origin: string, token?: string): Promise<A2aAgentCard> {
  const base = origin.replace(/\/+$/, '');
  // If a full card URL was passed, try it verbatim first.
  const candidates = /\/\.well-known\/agent(-card)?\.json$/.test(base)
    ? [base]
    : CARD_PATHS.map((p) => `${base}${p}`);

  let lastErr: unknown;
  for (const url of candidates) {
    await assertA2aEgressAllowed(url); // gov-safe egress gate (per candidate host)
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...authHeaders(token) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) { lastErr = new Error(`agent card fetch ${res.status} at ${url}`); continue; }
      const card = await res.json();
      if (!isValidAgentCard(card)) { lastErr = new Error(`invalid agent card at ${url}`); continue; }
      return card;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('could not resolve the external agent card');
}

/** Build a user Message from free text (+ optional structured data part). */
export function buildUserMessage(text: string, data?: Record<string, unknown>): A2aMessage {
  const parts: A2aPart[] = [];
  if (text) parts.push({ kind: 'text', text });
  if (data && Object.keys(data).length) parts.push({ kind: 'data', data });
  return { kind: 'message', messageId: genA2aId('msg'), role: 'user', parts };
}

/** A JSON-RPC error surfaced from a remote A2A agent. */
export class A2aRemoteError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'A2aRemoteError';
    this.code = code;
  }
}

async function a2aRpc<T>(endpoint: string, method: string, params: unknown, token?: string): Promise<T> {
  await assertA2aEgressAllowed(endpoint); // gov-safe egress gate
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ jsonrpc: '2.0', id: genA2aId('rpc'), method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error(`remote A2A agent returned non-JSON (${res.status})`); }
  if (json?.error) throw new A2aRemoteError(json.error.code ?? -32603, json.error.message || 'remote A2A error');
  if (!res.ok) throw new Error(`remote A2A agent ${res.status}`);
  return json.result as T;
}

/**
 * Delegate a task to an external A2A agent (`message/send`). Resolves the agent
 * card first (to discover the JSON-RPC `url`), then posts the message. Returns
 * the remote `Task` (or a direct `Message` — discriminate on `kind`). Egress-gated.
 */
export async function delegateToExternalAgent(opts: {
  origin: string;
  text: string;
  data?: Record<string, unknown>;
  token?: string;
}): Promise<{ card: A2aAgentCard; result: A2aTask | A2aMessage }> {
  const card = await fetchExternalAgentCard(opts.origin, opts.token);
  const endpoint = card.url;
  const message = buildUserMessage(opts.text, opts.data);
  const result = await a2aRpc<A2aTask | A2aMessage>(
    endpoint, 'message/send', { message, configuration: { blocking: true } }, opts.token,
  );
  return { card, result };
}

/** Poll an external agent for a delegated task's status (`tasks/get`). Egress-gated. */
export async function getExternalTask(endpoint: string, taskId: string, token?: string): Promise<A2aTask> {
  return a2aRpc<A2aTask>(endpoint, 'tasks/get', { id: taskId }, token);
}

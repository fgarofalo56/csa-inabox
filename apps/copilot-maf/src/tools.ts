/**
 * Tool DISPATCH proxy. The MAF tier owns the AOAI agent loop but NOT the tool
 * handlers — those stay in the Console so the MAF tier is "same tool dispatch +
 * OBO" rather than a divergent re-implementation. This module fetches the tool
 * SCHEMAS from the Console's token-gated internal endpoint and INVOKES tools the
 * same way, forwarding the signed-in user's oid so ownership/OBO is preserved.
 *
 * Endpoints (Console, internal ingress):
 *   GET  {LOOM_CONSOLE_ENDPOINT}/api/internal/copilot/tools
 *   POST {LOOM_CONSOLE_ENDPOINT}/api/internal/copilot/tools/<name>/invoke
 * Auth: x-loom-internal-token: {LOOM_INTERNAL_TOKEN}  (+ x-user-oid on invoke)
 */
import type { ToolSchema } from './types.js';

function consoleBase(): string | null {
  const b = (process.env.LOOM_CONSOLE_ENDPOINT || '').replace(/\/+$/, '');
  return b || null;
}

function internalToken(): string {
  return process.env.LOOM_INTERNAL_TOKEN || '';
}

/**
 * Fetch the registered tool schemas from the Console. Best-effort: a missing
 * console endpoint or token yields an empty tool set, so the agent loop still
 * returns a plain AOAI completion (no tools) instead of failing the turn.
 */
export async function fetchToolSchemas(): Promise<ToolSchema[]> {
  const base = consoleBase();
  if (!base || !internalToken()) return [];
  try {
    const res = await fetch(`${base}/api/internal/copilot/tools`, {
      method: 'GET',
      headers: { 'x-loom-internal-token': internalToken() },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { ok?: boolean; tools?: ToolSchema[] };
    return Array.isArray(body?.tools) ? body.tools : [];
  } catch {
    return [];
  }
}

/** Convert tool schemas into the OpenAI/AOAI `tools` array. */
export function toAoaiTools(schemas: ToolSchema[]): unknown[] {
  return schemas.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface ToolInvokeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Invoke a tool by name through the Console, forwarding the user oid for OBO /
 * ownership. The real handler (Azure REST, Cosmos, TDS, ARM …) runs in the
 * Console process exactly as it does for the Foundry tier.
 */
export async function invokeTool(
  name: string,
  args: unknown,
  userOid: string,
): Promise<ToolInvokeResult> {
  const base = consoleBase();
  if (!base) {
    return { ok: false, error: 'LOOM_CONSOLE_ENDPOINT not set — MAF tool dispatch unavailable.' };
  }
  if (!internalToken()) {
    return { ok: false, error: 'LOOM_INTERNAL_TOKEN not set — MAF cannot authenticate tool dispatch.' };
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/internal/copilot/tools/${encodeURIComponent(name)}/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loom-internal-token': internalToken(),
        'x-user-oid': userOid,
      },
      body: JSON.stringify({ args: args ?? {} }),
    });
  } catch (e: any) {
    return { ok: false, error: `tool dispatch to Console failed: ${e?.message || e}` };
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    return { ok: false, error: body?.error || `tool dispatch returned ${res.status}` };
  }
  return { ok: true, result: body?.result };
}

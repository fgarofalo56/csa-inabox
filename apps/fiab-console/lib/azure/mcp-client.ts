/**
 * MCP (Model Context Protocol) JSON-RPC over HTTPS client — Streamable HTTP
 * transport (the current MCP transport; SSE-only servers are also tolerated).
 *
 * Communicates with external MCP servers to:
 *   1. Fetch tool lists (tools/list)
 *   2. Call tools (tools/call)
 *
 * Transport (per the MCP spec + Microsoft Learn "Troubleshoot MCP servers on
 * Azure Container Apps"): a single JSON-RPC endpoint where the `method` field
 * selects the operation. The client therefore:
 *   • POSTs every request to the configured endpoint URL itself — NOT to
 *     `<endpoint>/tools/list` or `<endpoint>/tools/call` sub-paths (those 404
 *     against a real MCP server).
 *   • Sends `initialize` FIRST (servers reply -32601 "Method not found" to a
 *     tools/* call that arrives before initialize), capturing the
 *     `Mcp-Session-Id` response header and echoing it on subsequent calls.
 *   • Advertises `Accept: application/json, text/event-stream` and parses
 *     either a plain JSON body or an SSE-framed (`text/event-stream`) body —
 *     Streamable HTTP servers may respond with either.
 *
 * Auth: Authorization header or Key Vault secret reference (resolved at call time).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { kvScope, kvSuffix } from './cloud-endpoints';
import type { McpToolsListResponse } from '../types/mcp-config';

// Resolve Key Vault secrets over the KV REST API (no @azure/keyvault-secrets
// dependency) using the same UAMI→DefaultAzureCredential chain every Loom
// Azure client uses. KV host suffix + scope are sovereign-cloud aware (Gov uses
// *.vault.usgovcloudapi.net + the matching scope) via cloud-endpoints helpers.
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const kvCredential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/**
 * Resolve the Authorization header value for an MCP server.
 * @param authMethod 'header' (use authValue directly) or 'key-vault' (fetch from KV REST)
 * @param authValue raw value, or a KV secret ref "<vault-name-or-url>/<secret-name>" / "<secret-name>"
 */
export async function resolveAuthHeader(
  authMethod: string,
  authValue?: string,
): Promise<string> {
  if (!authValue) return '';
  if (authMethod === 'key-vault') {
    const parts = authValue.split('/');
    const secretName = parts.pop() || authValue;
    // Vault URL: explicit "https://..." prefix in the ref, else the named vault
    // (sovereign-cloud-aware suffix), else LOOM_KEY_VAULT_URL / LOOM_KEY_VAULT_URI.
    let vaultUrl = process.env.LOOM_KEY_VAULT_URL || process.env.LOOM_KEY_VAULT_URI || '';
    if (parts.length) {
      const head = parts.join('/');
      vaultUrl = head.startsWith('http') ? head : `https://${head}.${kvSuffix()}`;
    }
    if (!vaultUrl) throw new Error('LOOM_KEY_VAULT_URL not set for MCP Key Vault auth');
    try {
      const tok = await kvCredential.getToken(kvScope());
      const res = await fetchWithTimeout(`${vaultUrl.replace(/\/$/, '')}/secrets/${encodeURIComponent(secretName)}?api-version=7.4`, {
        headers: { authorization: `Bearer ${tok?.token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`KV ${res.status}`);
      const j = await res.json();
      const secret = String(j?.value || '');
      // KV-stored MCP keys are bare API keys (e.g. the Loom built-in server's
      // `loom-mcp-api-key`). Send them as a Bearer credential unless the secret
      // already carries an explicit auth scheme. ('header' auth stays verbatim
      // so an admin who pasted a full "Bearer …"/"Basic …" value is honored.)
      if (secret && !/^(bearer|basic|negotiate|digest)\s/i.test(secret)) {
        return `Bearer ${secret}`;
      }
      return secret;
    } catch (e: any) {
      throw new Error(`Failed to resolve Key Vault secret ${secretName}: ${e?.message || e}`);
    }
  }
  return authValue;
}

/** Protocol version we advertise on initialize. Servers negotiate down if needed. */
const MCP_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Parse a Streamable HTTP response body into a single JSON-RPC response.
 * Streamable HTTP servers may answer a POST with either:
 *   • `application/json` — a single JSON object, or
 *   • `text/event-stream` — one or more SSE `data:` frames (we take the first
 *     frame that carries a JSON-RPC response matching our request id).
 */
function parseRpcBody(contentType: string, text: string, wantId: string): JsonRpcResponse {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    // Concatenate consecutive `data:` lines per SSE event, then JSON.parse each
    // event payload and return the first that is a JSON-RPC response.
    let fallback: JsonRpcResponse | null = null;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        const obj = JSON.parse(data) as JsonRpcResponse;
        if (obj && (obj.result !== undefined || obj.error !== undefined)) {
          if (String(obj.id) === wantId) return obj;
          fallback = fallback || obj;
        }
      } catch { /* skip non-JSON SSE frames (comments / pings) */ }
    }
    if (fallback) return fallback;
    throw new Error('MCP server returned an SSE stream with no JSON-RPC response');
  }
  // Plain JSON (or empty body).
  if (!text.trim()) return {};
  return JSON.parse(text) as JsonRpcResponse;
}

/**
 * Open an MCP session against the single JSON-RPC endpoint: send `initialize`,
 * then the follow-up `notifications/initialized`. Returns the negotiated
 * `Mcp-Session-Id` (when the server issues one) so subsequent tools/* calls can
 * echo it. Throws on transport / protocol failure with the server's message.
 */
async function initializeSession(
  endpoint: string,
  authHeader: string,
  signal: AbortSignal,
): Promise<{ sessionId?: string }> {
  const url = endpoint.replace(/\/$/, '');
  const initId = `init-${Date.now()}`;
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(authHeader ? { authorization: authHeader } : {}),
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'csa-loom-console', version: '1.0' },
      },
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`initialize failed — HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const sessionId = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id') || undefined;
  const body = parseRpcBody(res.headers.get('content-type') || '', await res.text(), initId);
  if (body.error) throw new Error(`MCP initialize error: ${body.error.message}`);

  // Best-effort `initialized` notification (no id, no response expected).
  try {
    await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...baseHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal,
    });
  } catch { /* notification delivery is non-fatal */ }

  return { sessionId };
}

/** POST a single JSON-RPC request to the endpoint and return the parsed response. */
async function rpcCall(
  endpoint: string,
  authHeader: string,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<JsonRpcResponse> {
  const url = endpoint.replace(/\/$/, '');
  const id = `${method.replace(/\W/g, '')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authHeader ? { authorization: authHeader } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} — HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return parseRpcBody(res.headers.get('content-type') || '', await res.text(), id);
}

/**
 * Fetch the list of available tools from an MCP server.
 * Performs the full Streamable HTTP handshake: initialize → tools/list.
 */
export async function listMcpTools(
  endpoint: string,
  authMethod: string,
  authValue?: string,
  timeoutMs: number = 5000,
): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
  const authHeader = await resolveAuthHeader(authMethod, authValue);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { sessionId } = await initializeSession(endpoint, authHeader, controller.signal);
    const body = await rpcCall(endpoint, authHeader, sessionId, 'tools/list', {}, controller.signal);
    if (body.error) throw new Error(`MCP error: ${body.error.message}`);
    const result = body.result as McpToolsListResponse['result'];
    return result?.tools || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Call a tool on an MCP server.
 * Performs the full Streamable HTTP handshake: initialize → tools/call.
 */
export async function callMcpTool(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown>,
  authMethod: string,
  authValue?: string,
  timeoutMs: number = 30000,
): Promise<unknown> {
  const authHeader = await resolveAuthHeader(authMethod, authValue);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { sessionId } = await initializeSession(endpoint, authHeader, controller.signal);
    const body = await rpcCall(
      endpoint, authHeader, sessionId, 'tools/call',
      { name: toolName, arguments: args }, controller.signal,
    );
    if (body.error) throw new Error(`MCP error: ${body.error.message}`);
    return body.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

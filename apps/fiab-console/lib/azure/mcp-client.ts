/**
 * MCP (Model Context Protocol) JSON-RPC over HTTPS client.
 *
 * Communicates with external MCP servers to:
 *   1. Fetch tool lists (tools/list)
 *   2. Call tools (tools/call)
 *
 * Auth: Authorization header or Key Vault secret reference (resolved at call time).
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { kvScope, kvSuffix } from './cloud-endpoints';
import type { McpToolsListResponse, McpToolsCallRequest, McpToolsCallResponse } from '../types/mcp-config';

// Resolve Key Vault secrets over the KV REST API (no @azure/keyvault-secrets
// dependency) using the same UAMI→DefaultAzureCredential chain every Loom
// Azure client uses. KV host suffix + scope are sovereign-cloud aware (Gov uses
// *.vault.usgovcloudapi.net + the matching scope) via cloud-endpoints helpers.
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const kvCredential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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
      const res = await fetch(`${vaultUrl.replace(/\/$/, '')}/secrets/${encodeURIComponent(secretName)}?api-version=7.4`, {
        headers: { authorization: `Bearer ${tok?.token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`KV ${res.status}`);
      const j = await res.json();
      return j?.value || '';
    } catch (e: any) {
      throw new Error(`Failed to resolve Key Vault secret ${secretName}: ${e?.message || e}`);
    }
  }
  return authValue;
}

/**
 * Fetch the list of available tools from an MCP server (tools/list).
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
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/tools/list`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `list-${Date.now()}`,
        method: 'tools/list',
        params: {},
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const body: McpToolsListResponse = await res.json();
    if (body.error) {
      throw new Error(`MCP error: ${body.error.message}`);
    }
    return body.result?.tools || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Call a tool on an MCP server (tools/call).
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
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req: McpToolsCallRequest = {
      jsonrpc: '2.0',
      id: callId,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };

    const res = await fetch(`${endpoint.replace(/\/$/, '')}/tools/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const body: McpToolsCallResponse = await res.json();
    if (body.error) {
      throw new Error(`MCP error: ${body.error.message}`);
    }
    return body.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

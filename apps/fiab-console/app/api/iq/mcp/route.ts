/**
 * Fabric IQ / Microsoft IQ — unified MCP tool surface (Build 2026 #1+#6).
 *
 * A single Model Context Protocol (MCP) JSON-RPC endpoint that packages the
 * organization's ONTOLOGY + SEMANTIC layer + LIVE SIGNALS into one tool surface
 * external agents (Microsoft Agent 365, Azure AI Foundry agents, Copilot Studio)
 * can ground on. This is the SERVER side of MCP (inverse of lib/azure/mcp-client.ts,
 * which CALLS external MCP servers).
 *
 * Methods (JSON-RPC 2.0 over HTTPS POST):
 *   initialize  → protocol handshake + serverInfo + capabilities
 *   tools/list  → the IQ tool catalog (iq_overview, iq_search, iq_get_ontology, …)
 *   tools/call  → dispatch a tool to its real Azure-native backend
 *   ping        → liveness
 *
 * Auth (two accepted credentials):
 *   1. Bearer token — external agents present `Authorization: Bearer <token>`
 *      matching LOOM_IQ_MCP_TOKEN (or, if unset, LOOM_INTERNAL_TOKEN — the same
 *      deterministic shared secret Bicep wires). The acting-tenant oid is taken
 *      from the `x-user-oid` header. This is the path Agent 365 / Foundry use.
 *   2. Cookie session — an authenticated Console user (admin testing / the IQ
 *      hub "Try it" panel) hits the same endpoint with their MSAL session; the
 *      tenant is the session oid.
 *
 * Per .claude/rules/no-fabric-dependency.md every layer resolves to an Azure
 * backend with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET. Per no-vaporware.md each
 * tool calls a real backend (Cosmos ontology/semantic items + ADX signals) or
 * returns an honest structured gate.
 *
 * The endpoint is OFF by default and only serves external (token) callers when
 * LOOM_IQ_MCP_ENABLED=true (cookie-session callers always work for self-test).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isValidInternalToken, INTERNAL_USER_OID_HEADER } from '@/lib/auth/internal-token';
import { IQ_MCP_TOOLS, callIqTool } from '@/lib/azure/iq-mcp-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC error codes. */
const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
};

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
}
function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result });
}

/**
 * Validate the bearer token against LOOM_IQ_MCP_TOKEN (preferred) or
 * LOOM_INTERNAL_TOKEN (fallback — the shared internal trust secret).
 */
function isValidIqToken(presented: string | null): boolean {
  const dedicated = process.env.LOOM_IQ_MCP_TOKEN;
  if (dedicated) {
    return !!presented && presented === dedicated;
  }
  // Fall back to the shared internal token (constant-time check, fails closed).
  return isValidInternalToken(presented);
}

/** Resolve the acting tenant oid + auth mode, or null when unauthenticated. */
function resolveTenant(req: NextRequest): { tenantId: string; mode: 'token' | 'session' } | null {
  // 1. Cookie session (Console user / self-test) — always allowed.
  const s = getSession();
  if (s?.claims?.oid) return { tenantId: s.claims.oid, mode: 'session' };

  // 2. Bearer token (external agent). Only when the endpoint is enabled.
  if (process.env.LOOM_IQ_MCP_ENABLED !== 'true') return null;
  const authz = req.headers.get('authorization') || '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
  if (!isValidIqToken(bearer)) return null;
  const oid = req.headers.get(INTERNAL_USER_OID_HEADER) || '';
  if (!oid) return null;
  return { tenantId: oid, mode: 'token' };
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, RPC.PARSE, 'Invalid JSON');
  }

  // Support a JSON-RPC batch (array) — process each request sequentially.
  if (Array.isArray(body)) {
    const auth = resolveTenant(req);
    if (!auth) return rpcError(null, RPC.UNAUTHORIZED, 'unauthorized', 401);
    const results = [];
    for (const single of body) {
      results.push(await handleOne(single, auth.tenantId));
    }
    return NextResponse.json(results);
  }

  const { jsonrpc, id, method } = body || {};
  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(id, RPC.INVALID_REQUEST, 'Expected JSON-RPC 2.0 request with a method');
  }

  const auth = resolveTenant(req);
  if (!auth) {
    return rpcError(id, RPC.UNAUTHORIZED, 'unauthorized — present a session cookie or a Bearer token (and x-user-oid)', 401);
  }

  const out = await handleOne(body, auth.tenantId);
  // `notifications/*` (no id) returns null → 204.
  if (out === null) return new NextResponse(null, { status: 204 });
  return NextResponse.json(out);
}

/** Handle a single JSON-RPC request object; returns the response object (or null for notifications). */
async function handleOne(body: any, tenantId: string): Promise<any> {
  const { id, method, params } = body || {};

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'csa-loom-iq',
            title: 'CSA Loom — Fabric IQ',
            version: '1.0.0',
          },
          instructions:
            'Unified Fabric IQ surface: ontology (conceptual model), semantic models (curated tables + measures), and live signals (Azure Data Explorer). Call iq_overview first to discover what is available, then drill in with iq_get_ontology / iq_get_semantic_model, search with iq_search, and query real-time telemetry with iq_query_signals.',
        },
      };

    case 'ping':
      return { jsonrpc: '2.0', id: id ?? null, result: {} };

    case 'notifications/initialized':
      return null; // notification — no response

    case 'tools/list':
      return { jsonrpc: '2.0', id: id ?? null, result: { tools: IQ_MCP_TOOLS } };

    case 'tools/call': {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name || typeof name !== 'string') {
        return { jsonrpc: '2.0', id: id ?? null, error: { code: RPC.INVALID_PARAMS, message: 'params.name (tool) is required' } };
      }
      try {
        const result = await callIqTool(name, args, tenantId);
        return { jsonrpc: '2.0', id: id ?? null, result };
      } catch (e: any) {
        const msg = e?.message || String(e);
        // Unknown tool → method-not-found-ish; arg/backend errors → tool error content.
        if (/unknown tool/i.test(msg)) {
          return { jsonrpc: '2.0', id: id ?? null, error: { code: RPC.METHOD_NOT_FOUND, message: msg } };
        }
        // MCP convention: tool execution errors come back as isError content, not RPC errors.
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: msg }], isError: true },
        };
      }
    }

    default:
      return { jsonrpc: '2.0', id: id ?? null, error: { code: RPC.METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
  }
}

/**
 * GET → a small, unauthenticated discovery document describing the endpoint so
 * operators (and agent registration UIs) can verify the URL and see whether the
 * external (token) path is enabled. Does NOT expose tenant data.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    server: 'csa-loom-iq',
    protocol: 'mcp/json-rpc-2.0',
    protocolVersion: PROTOCOL_VERSION,
    transport: 'http',
    endpoint: '/api/iq/mcp',
    methods: ['initialize', 'ping', 'tools/list', 'tools/call'],
    tools: IQ_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    externalAccessEnabled: process.env.LOOM_IQ_MCP_ENABLED === 'true',
    auth: {
      session: 'MSAL cookie session (Console users / self-test)',
      bearer: 'Authorization: Bearer <LOOM_IQ_MCP_TOKEN|LOOM_INTERNAL_TOKEN> + x-user-oid header (external agents; requires LOOM_IQ_MCP_ENABLED=true)',
    },
  });
}

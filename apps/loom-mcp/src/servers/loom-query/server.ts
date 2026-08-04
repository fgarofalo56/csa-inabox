/**
 * M2 `loom-query` — the bounded data-read MCP server (PRP §4.2, §5.3). Composes
 * the shared core factory with the three query tools. It is a READ-ONLY server:
 * `allowMutations` is left at its default (false), so the core gate refuses to
 * dispatch any non-`readOnly` tool — defense in depth for the exfiltration
 * surface. The §5.3 row/byte caps + DDL/DML parse-reject live in the tools; the
 * core supplies the auth gate, the secret-scrub over every returned data cell,
 * the hashed-args audit, and error normalization, all reused unchanged.
 */
import { createLoomMcpServer } from '../../core/server.js';
import { resolveAuth } from '../../core/auth.js';
import { queryTools } from './tools.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditSink, AuthContext } from '../../core/types.js';

export const QUERY_SERVER_NAME = 'loom-query';
export const QUERY_SERVER_VERSION = '0.1.0';

export interface CreateQueryServerOptions {
  /** Pre-resolved auth (tests). When omitted, {@link resolveAuth} runs. */
  auth?: AuthContext | null;
  /** Audit sink override (tests). */
  audit?: AuditSink;
}

/** Build (but do not connect) the loom-query MCP server. */
export async function createQueryServer(opts: CreateQueryServerOptions = {}): Promise<McpServer> {
  const auth = opts.auth !== undefined ? opts.auth : await resolveAuth();
  return createLoomMcpServer({
    name: QUERY_SERVER_NAME,
    version: QUERY_SERVER_VERSION,
    tools: queryTools(),
    auth,
    audit: opts.audit,
    // Read-only server: mutations are not permitted (the default). The gate
    // refuses any non-readOnly tool that might be added here by mistake.
  });
}

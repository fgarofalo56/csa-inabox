/**
 * M1 `loom-catalog` — the read-only MCP server. Composes the core factory with
 * the four catalog tools. Auth is resolved once at startup (env PAT or the CLI
 * credential store); the tools list unconditionally (discovery) but every call
 * is gated — no anonymous call succeeds.
 */
import { createLoomMcpServer } from '../../core/server.js';
import { resolveAuth } from '../../core/auth.js';
import { catalogTools } from './tools.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditSink, AuthContext } from '../../core/types.js';

export const CATALOG_SERVER_NAME = 'loom-catalog';
export const CATALOG_SERVER_VERSION = '0.1.0';

export interface CreateCatalogServerOptions {
  /** Pre-resolved auth (tests). When omitted, {@link resolveAuth} runs. */
  auth?: AuthContext | null;
  /** Audit sink override (tests). */
  audit?: AuditSink;
}

/** Build (but do not connect) the loom-catalog MCP server. */
export async function createCatalogServer(opts: CreateCatalogServerOptions = {}): Promise<McpServer> {
  const auth = opts.auth !== undefined ? opts.auth : await resolveAuth();
  return createLoomMcpServer({
    name: CATALOG_SERVER_NAME,
    version: CATALOG_SERVER_VERSION,
    tools: catalogTools(),
    auth,
    audit: opts.audit,
  });
}

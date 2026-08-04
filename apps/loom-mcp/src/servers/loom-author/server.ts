/**
 * M3 `loom-author` — the WRITE MCP server. Composes the shared core factory with
 * the three author tools and the write authorization policy `{allowMutations:true}`.
 *
 * The policy is the ONLY difference from M1 at the gate: mutations are permitted,
 * still bounded by the per-tool `read-write` scope floor (a `read-only` PAT is
 * refused with `insufficient_scope`). Dry-run-by-default lives in the tools
 * (`apply` arg). Scrub, audit, error-normalization, and the no-anonymous rule are
 * all inherited from the core unchanged.
 */
import { createLoomMcpServer } from '../../core/server.js';
import { resolveAuth } from '../../core/auth.js';
import { authorTools } from './tools.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditSink, AuthContext, AuthzPolicy } from '../../core/index.js';

export const AUTHOR_SERVER_NAME = 'loom-author';
export const AUTHOR_SERVER_VERSION = '0.1.0';

/** M3 authorization policy: mutations allowed; scope floor stays `read-write` per tool. */
export const AUTHOR_AUTHZ: AuthzPolicy = { allowMutations: true, server: AUTHOR_SERVER_NAME };

export interface CreateAuthorServerOptions {
  /** Pre-resolved auth (tests). When omitted, {@link resolveAuth} runs. */
  auth?: AuthContext | null;
  /** Audit sink override (tests). */
  audit?: AuditSink;
}

/** Build (but do not connect) the loom-author MCP server. */
export async function createAuthorServer(opts: CreateAuthorServerOptions = {}): Promise<McpServer> {
  const auth = opts.auth !== undefined ? opts.auth : await resolveAuth();
  return createLoomMcpServer({
    name: AUTHOR_SERVER_NAME,
    version: AUTHOR_SERVER_VERSION,
    tools: authorTools(),
    auth,
    audit: opts.audit,
    authz: AUTHOR_AUTHZ,
  });
}

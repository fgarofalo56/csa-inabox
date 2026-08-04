/**
 * M4 `loom-ops` — the run/logs MCP server (PRP §4.2). Composes the shared core
 * factory with the five ops tools. Unlike M1/M2 this is a WRITE server: it sets
 * `allowMutations: true` so the core gate will dispatch the two non-`readOnly`
 * tools (`loom.run.start`, `loom.run.cancel`) — but ONLY after they clear the
 * core scope floor (`minScope:'read-write'`), so a read-only PAT is still
 * refused. The scrub, hashed-args audit, and error normalization are the core's,
 * reused unchanged; the write path is the one new capability M4 exercises.
 */
import { createLoomMcpServer } from '../../core/server.js';
import { resolveAuth } from '../../core/auth.js';
import { opsTools } from './tools.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditSink, AuthContext } from '../../core/types.js';

export const OPS_SERVER_NAME = 'loom-ops';
export const OPS_SERVER_VERSION = '0.1.0';

export interface CreateOpsServerOptions {
  /** Pre-resolved auth (tests). When omitted, {@link resolveAuth} runs. */
  auth?: AuthContext | null;
  /** Audit sink override (tests). */
  audit?: AuditSink;
}

/** Build (but do not connect) the loom-ops MCP server. */
export async function createOpsServer(opts: CreateOpsServerOptions = {}): Promise<McpServer> {
  const auth = opts.auth !== undefined ? opts.auth : await resolveAuth();
  return createLoomMcpServer({
    name: OPS_SERVER_NAME,
    version: OPS_SERVER_VERSION,
    tools: opsTools(),
    auth,
    audit: opts.audit,
    // Write server: the two mutating tools may be dispatched — but only after
    // clearing the per-tool read-write scope floor in the core gate.
    allowMutations: true,
  });
}

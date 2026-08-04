/**
 * Server factory — the shared seam. Given a set of {@link ToolSpec}s and a
 * resolved auth context, it builds an `McpServer` with every tool registered
 * through the core control pipeline (authorize → SDK → scrub → audit → normalize).
 *
 * Each of M2 `loom-query`, M3 `loom-author`, M4 `loom-ops`, M5 `loom-admin`
 * reuses this factory unchanged: they supply their own `ToolSpec[]` (and a
 * stricter auth resolver — OBO-only, PIM step-up, etc.), and inherit the scrub,
 * the audit stream, the read-only/scope gate, and the error normalization for
 * free. Nothing about the security controls is re-implemented per server.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildToolHandler } from './tool.js';
import type { AuthzPolicy } from './authz.js';
import type { AuditSink, AuthContext, ToolSpec } from './types.js';

export interface CreateServerOptions {
  /** MCP server name (e.g. `loom-catalog`). */
  name: string;
  /** MCP server version. */
  version: string;
  /** The tools this server exposes. */
  tools: ToolSpec[];
  /** Resolved caller identity, or null (anonymous — every call is then denied). */
  auth: AuthContext | null;
  /** Audit sink override (defaults to the stderr JSON sink). */
  audit?: AuditSink;
  /**
   * Per-server authorization policy. Omitted ⇒ the M1 read-only default
   * (no mutations, PAT allowed, always enabled). M3 passes `{allowMutations:true}`;
   * M5 passes the strict admin policy (`requireAdmin`, `rejectPat`, `enabled`).
   * The same audited gate serves every server — there is no per-server authz fork.
   */
  authz?: AuthzPolicy;
}

/** Build a fully-wired MCP server (not yet connected to a transport). */
export function createLoomMcpServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer({ name: opts.name, version: opts.version });

  for (const spec of opts.tools) {
    const handler = buildToolHandler(spec, {
      server: opts.name,
      auth: opts.auth,
      audit: opts.audit,
      authz: opts.authz,
    });
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly,
          // Queries a live external system (the Loom estate).
          openWorldHint: true,
        },
      },
      // The SDK validates `args` against `inputSchema` before calling us; the
      // handler treats them as an opaque record. `extra` (auth/session context
      // from the transport) is unused by M1.
      (args) => handler(args as Record<string, unknown>),
    );
  }

  return server;
}

/**
 * Shared types for the Loom MCP core.
 *
 * The core is the seam every Loom MCP server (M1 `loom-catalog` today; M2
 * `loom-query`, M3 `loom-author`, M4 `loom-ops`, M5 `loom-admin` later) is
 * built on: auth resolution, a per-tool authorization gate, secret-scrubbing,
 * structured errors, and an audit hook. A server contributes only a
 * {@link ToolSpec}[] and (for the write/admin servers) a stricter auth floor;
 * everything else is shared here.
 */
import type { z } from 'zod';
import type { LoomClient } from '@csa-loom/sdk';

/** PAT scopes, mirroring `lib/auth/pat.ts` (3 typed scopes). */
export type TokenScope = 'read-only' | 'read-write' | 'admin';

/**
 * A resolved caller identity. `null` (see {@link resolveAuth}) means anonymous
 * — which the authorization gate rejects for every tool (no MCP tool runs
 * without a credential, per PRP §5.1 "Never accepted: Anonymous").
 */
export interface AuthContext {
  /** How the caller authenticated. */
  mode: 'pat' | 'cookie';
  /**
   * Non-secret correlation id for the audit trail: the PAT **id** segment
   * (`loom_pat_<id>_…` → `pat_<id>`) or `'session'` for a cookie. Never the
   * secret half of the token.
   */
  principal: string;
  /** PAT scope, if known. Cookie (user-session) callers are treated as read-write. */
  scope: TokenScope;
  /** The resolved Loom API base URL. */
  apiUrl: string;
  /** A ready-to-use Loom SDK client bound to this credential. */
  client: LoomClient;
}

/** The single audit shape for the whole toolkit (PRP §5.7). */
export interface AuditEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Non-secret principal correlation id (see {@link AuthContext.principal}). */
  principal: string;
  /** Which MCP server emitted the event (e.g. `loom-catalog`). */
  server: string;
  /** Tool name. */
  tool: string;
  /** SHA-256 (truncated) of the JSON args — args are redacted, never stored raw. */
  args_hash: string;
  /** Authorization decision. */
  decision: 'allow' | 'deny';
  /** Outcome once dispatched (only meaningful when `decision === 'allow'`). */
  outcome: 'ok' | 'error';
  /** Row/record count returned, when the tool reports one. */
  count?: number;
  /** Wall-clock duration of the tool call. */
  duration_ms: number;
  /** Deny reason or error code, for triage. */
  reason?: string;
}

/** A sink for audit events. The default writes structured JSON to **stderr**. */
export type AuditSink = (event: AuditEvent) => void;

/**
 * The MCP tool-result shape this core returns (a structural subset of the SDK's
 * `CallToolResult`). The open index signature mirrors `CallToolResult` so the
 * handler is directly assignable to the SDK's `ToolCallback` return type.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A declarative tool. The core turns each spec into a registered MCP tool whose
 * handler runs: authorize → dispatch `run` → scrub → audit → normalize errors.
 */
export interface ToolSpec {
  /** MCP tool name (e.g. `loom.catalog.find`). */
  name: string;
  /** Short human title. */
  title: string;
  /** Description surfaced to the model. */
  description: string;
  /** Zod raw shape for the MCP `inputSchema` (argument validation is done by the SDK). */
  inputSchema: z.ZodRawShape;
  /**
   * M1 invariant: every catalog tool is read-only. The authorization gate
   * refuses to dispatch any tool not marked `readOnly` — defense in depth so a
   * mutating endpoint can never be reached from this server.
   */
  readOnly: boolean;
  /** Minimum PAT scope required to call the tool. */
  minScope: TokenScope;
  /**
   * The work. Given the resolved auth (guaranteed non-null here — the gate runs
   * first) and the validated args, call the SDK and return the raw data plus an
   * optional record count. The core scrubs the returned `data` before it leaves
   * the process.
   */
  run(ctx: { auth: AuthContext; args: Record<string, unknown> }): Promise<{ data: unknown; count?: number }>;
}

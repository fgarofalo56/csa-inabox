/**
 * Tool-handler factory. Wraps a declarative {@link ToolSpec} into the async MCP
 * handler the SDK calls, threading the full control pipeline through every call:
 *
 *   authorize → dispatch `run` (SDK) → **scrub** result → audit → normalize errors
 *
 * The scrub (§5.2) runs on the tool's data before it leaves the process; the
 * audit (§5.7) fires on both the allow and deny paths; errors are normalized to
 * a `{ok:false,…}` envelope (§5.2) with no stack traces.
 */
import { authorize } from './authz.js';
import { scrub } from './scrub.js';
import { toErrorResult, errorResult } from './errors.js';
import { emitAudit, hashArgs, stderrAuditSink } from './audit.js';
import type { AuditSink, AuthContext, ToolResult, ToolSpec } from './types.js';

export interface ToolHandlerOptions {
  /** Server id for the audit record (e.g. `loom-catalog`). */
  server: string;
  /** The resolved caller identity, or null (anonymous → denied). */
  auth: AuthContext | null;
  /** Audit sink (defaults to the stderr JSON sink). */
  audit?: AuditSink;
  /**
   * Whether this server permits non-`readOnly` tools. Default `false` (a
   * read-only server: M1 `loom-catalog`, M2 `loom-query`). A write server
   * (M4 `loom-ops`) sets `true`; the scope floor still applies.
   */
  allowMutations?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Build the MCP handler for one tool. */
export function buildToolHandler(spec: ToolSpec, opts: ToolHandlerOptions): ToolHandler {
  const sink = opts.audit ?? stderrAuditSink;

  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const started = Date.now();
    const argsHash = hashArgs(args);
    const principal = opts.auth?.principal ?? 'anonymous';

    const decision = authorize(spec, opts.auth, { allowMutations: opts.allowMutations });
    if (!decision.ok) {
      emitAudit(sink, {
        ts: new Date().toISOString(),
        principal,
        server: opts.server,
        tool: spec.name,
        args_hash: argsHash,
        decision: 'deny',
        outcome: 'error',
        duration_ms: Date.now() - started,
        reason: decision.code,
      });
      return errorResult(decision.reason, decision.code);
    }

    // Non-null once authorized (the gate rejects a null auth above).
    const auth = opts.auth as AuthContext;
    try {
      const { data, count } = await spec.run({ auth, args });
      const safe = scrub(data);
      emitAudit(sink, {
        ts: new Date().toISOString(),
        principal,
        server: opts.server,
        tool: spec.name,
        args_hash: argsHash,
        decision: 'allow',
        outcome: 'ok',
        count,
        duration_ms: Date.now() - started,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
        structuredContent: { ok: true, count, data: safe },
      };
    } catch (e) {
      emitAudit(sink, {
        ts: new Date().toISOString(),
        principal,
        server: opts.server,
        tool: spec.name,
        args_hash: argsHash,
        decision: 'allow',
        outcome: 'error',
        duration_ms: Date.now() - started,
        reason: 'run_threw',
      });
      return toErrorResult(e);
    }
  };
}

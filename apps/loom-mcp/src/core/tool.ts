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
import { authorize, type AuthzPolicy } from './authz.js';
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
   * Per-server authorization policy (M3 `allowMutations`, M5 admin floors,
   * default-OFF). Omitted ⇒ the M1 read-only default (see {@link AuthzPolicy}).
   * The gate reads `server` from here too, so pass it through for the message.
   */
  authz?: AuthzPolicy;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Build the MCP handler for one tool. */
export function buildToolHandler(spec: ToolSpec, opts: ToolHandlerOptions): ToolHandler {
  const sink = opts.audit ?? stderrAuditSink;
  const policy: AuthzPolicy = { server: opts.server, ...opts.authz };

  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const started = Date.now();
    const argsHash = hashArgs(args);
    const principal = opts.auth?.principal ?? 'anonymous';

    const decision = authorize(spec, opts.auth, policy);
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
      const { data, count, audit } = await spec.run({ auth, args });
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
        // Plan-vs-apply + affected principal for mutating tools (§5.4/§5.7).
        mutation: audit?.mutation,
        target: audit?.target,
        duration_ms: Date.now() - started,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
        structuredContent: { ok: true, count, mutation: audit?.mutation, data: safe },
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

/**
 * Per-tool authorization gate — PRP §5.1.
 *
 * It enforces, in order:
 *   1. **No anonymous.** A tool never runs without a resolved credential.
 *   2. **Mutation floor (per server).** A tool not marked `readOnly` is refused
 *      UNLESS the server opted in with `allowMutations` (M4 `loom-ops`, M3, M5).
 *      A read-only server (M1 `loom-catalog`, M2 `loom-query` — the default,
 *      `allowMutations` omitted) can therefore never dispatch a mutating
 *      endpoint (§5.1 "never call a mutating endpoint") — defense in depth.
 *   3. **Scope floor.** The caller's scope must meet the tool's `minScope`. A
 *      write tool sets `minScope:'read-write'`, so a `read-only` PAT is refused
 *      even on a mutation-permitting server — this is the write path's gate
 *      (PRP §5.1 M4: "PAT read-only for run_start/run_cancel" is Never accepted).
 *
 * The gate does NOT re-implement per-item ACLs: the tool calls the Loom BFF via
 * the SDK, and the BFF performs the same workspace/item ACL check it does for
 * the browser (§5.1 "the MCP tool calls the BFF handler, it does not
 * reimplement it").
 */
import type { AuthContext, ToolSpec, TokenScope } from './types.js';

export type AuthzDecision = { ok: true } | { ok: false; reason: string; code: string };

/** Extra inputs to the gate. `allowMutations` is the per-server mutation floor. */
export interface AuthorizeOptions {
  /**
   * Whether this server permits non-`readOnly` tools at all. Default `false`
   * (a read-only server: M1/M2). A write server (M3/M4/M5) sets `true`, after
   * which a mutating tool still has to clear the scope floor in (3).
   */
  allowMutations?: boolean;
}

const SCOPE_RANK: Record<TokenScope, number> = { 'read-only': 1, 'read-write': 2, admin: 3 };

export function scopeSatisfies(have: TokenScope, need: TokenScope): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

export function authorize(tool: ToolSpec, auth: AuthContext | null, opts: AuthorizeOptions = {}): AuthzDecision {
  if (!auth) {
    return {
      ok: false,
      code: 'unauthenticated',
      reason:
        'authentication required — set LOOM_TOKEN (a loom_pat_<id>_<secret> PAT) and LOOM_API_URL, or run `loom auth login`.',
    };
  }
  if (!tool.readOnly && !opts.allowMutations) {
    // Read-only server (default): a mutating tool is never dispatched.
    return { ok: false, code: 'forbidden_mutation', reason: `tool "${tool.name}" is not read-only; this server does not permit mutations.` };
  }
  if (!scopeSatisfies(auth.scope, tool.minScope)) {
    return {
      ok: false,
      code: 'insufficient_scope',
      reason: `tool "${tool.name}" requires scope "${tool.minScope}"; token scope is "${auth.scope}".`,
    };
  }
  return { ok: true };
}

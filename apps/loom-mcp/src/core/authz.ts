/**
 * Per-tool authorization gate — PRP §5.1.
 *
 * For M1 `loom-catalog` this enforces three things, in order:
 *   1. **No anonymous.** A tool never runs without a resolved credential.
 *   2. **Read-only only.** A tool not marked `readOnly` is refused — defense in
 *      depth so this server can never dispatch a mutating endpoint (§5.1 "never
 *      call a mutating endpoint").
 *   3. **Scope floor.** The caller's scope must meet the tool's `minScope`.
 *
 * The gate does NOT re-implement per-item ACLs: the tool calls the Loom BFF via
 * the SDK, and the BFF performs the same workspace/item ACL check it does for
 * the browser (§5.1 "the MCP tool calls the BFF handler, it does not
 * reimplement it").
 */
import type { AuthContext, ToolSpec, TokenScope } from './types.js';

export type AuthzDecision = { ok: true } | { ok: false; reason: string; code: string };

const SCOPE_RANK: Record<TokenScope, number> = { 'read-only': 1, 'read-write': 2, admin: 3 };

export function scopeSatisfies(have: TokenScope, need: TokenScope): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

export function authorize(tool: ToolSpec, auth: AuthContext | null): AuthzDecision {
  if (!auth) {
    return {
      ok: false,
      code: 'unauthenticated',
      reason:
        'authentication required — set LOOM_TOKEN (a loom_pat_<id>_<secret> PAT) and LOOM_API_URL, or run `loom auth login`.',
    };
  }
  if (!tool.readOnly) {
    // Unreachable for M1 (every catalog tool is read-only) — belt and braces.
    return { ok: false, code: 'forbidden_mutation', reason: `tool "${tool.name}" is not read-only; refused by loom-catalog.` };
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

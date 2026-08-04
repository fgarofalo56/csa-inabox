/**
 * Per-tool authorization gate — PRP §5.1. The SINGLE audited decision point for
 * every Loom MCP server; there is deliberately no second, less-audited authz
 * path. A server tunes the gate with an {@link AuthzPolicy}; the checks below
 * run in fail-closed order and every refusal is emitted to the audit stream by
 * the caller (`tool.ts`) as a `decision:'deny'` event.
 *
 * For M1 `loom-catalog` (the default policy `{}`) this enforces, in order:
 *   1. **No anonymous.** A tool never runs without a resolved credential.
 *   2. **Read-only only.** A tool not marked `readOnly` is refused — defense in
 *      depth so this server can never dispatch a mutating endpoint (§5.1 "never
 *      call a mutating endpoint").
 *   3. **Scope floor.** The caller's scope must meet the tool's `minScope`.
 *
 * For the write server M3 `loom-author` the policy is `{ allowMutations:true }`
 * — mutations become permitted, still subject to the scope floor (`read-write`).
 * For the admin server M5 `loom-admin` (the escalation surface, §5.4) the policy
 * is the strictest: `{ allowMutations:true, requireAdmin:true, rejectPat:true,
 * enabled:<LOOM_MCP_ADMIN_ENABLED> }` — default-OFF, no PAT ever, and an explicit
 * admin-scope floor on TOP of the per-tool `minScope`.
 *
 * The gate does NOT re-implement per-item ACLs or the live tenant-admin
 * re-check (§5.4.2): the tool calls the Loom BFF via the SDK, and the BFF
 * performs the same workspace/item ACL + `isTenantAdmin`/`enforceCapability`/
 * PDP check it does for the browser (§5.1 "the MCP tool calls the BFF handler,
 * it does not reimplement it"). This gate is the LOCAL, deny-by-default floor;
 * the BFF is the authoritative escalation boundary.
 */
import type { AuthContext, ToolSpec, TokenScope } from './types.js';

export type AuthzDecision = { ok: true } | { ok: false; reason: string; code: string };

/**
 * Per-server tuning of the shared gate. Every field DEFAULTS to the M1
 * (read-only catalog) behavior, so `authorize(tool, auth)` with no policy is
 * byte-for-byte the original M1 decision. Write/admin servers opt in explicitly.
 */
export interface AuthzPolicy {
  /**
   * When `false`/absent (M1/M2/M4-read default), a non-`readOnly` tool is
   * refused (`forbidden_mutation`). Write/admin servers (M3/M5) set `true`.
   */
  allowMutations?: boolean;
  /**
   * When `true` (M5), the caller's scope must be exactly `admin` regardless of
   * the tool's `minScope` — an explicit admin floor on top of the scope floor
   * (§5.4 "the core scope-floor + an explicit admin check").
   */
  requireAdmin?: boolean;
  /**
   * When `true` (M5), a PAT credential is refused unconditionally — no scoped
   * API token, however privileged, reaches an admin tool (§5.1 "Never accepted:
   * Any PAT"; extends the `patCannotMint` principle to the whole server).
   */
  rejectPat?: boolean;
  /**
   * Server master-switch (M5 default-OFF, §5.4.1). When explicitly `false`,
   * EVERY call is refused (`admin_disabled`) even for a valid admin — the server
   * still lists its tools (discovery) but dispatches none. `undefined`/`true`
   * leave the server enabled (M1 default).
   */
  enabled?: boolean;
  /** Server id, for a precise refusal message (e.g. `loom-admin`). */
  server?: string;
}

const SCOPE_RANK: Record<TokenScope, number> = { 'read-only': 1, 'read-write': 2, admin: 3 };

export function scopeSatisfies(have: TokenScope, need: TokenScope): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

export function authorize(tool: ToolSpec, auth: AuthContext | null, policy: AuthzPolicy = {}): AuthzDecision {
  const who = policy.server ?? 'this server';

  // 0) Server master-switch (default-OFF admin server, §5.4.1). Fail closed
  //    before anything else so a disabled escalation surface dispatches nothing.
  if (policy.enabled === false) {
    return {
      ok: false,
      code: 'admin_disabled',
      reason: `${who} is disabled — set LOOM_MCP_ADMIN_ENABLED=1 (an explicit, audited tenant-admin action) to enable it.`,
    };
  }

  // 1) No anonymous — no tool runs without a resolved credential.
  if (!auth) {
    return {
      ok: false,
      code: 'unauthenticated',
      reason:
        'authentication required — set LOOM_TOKEN (a loom_pat_<id>_<secret> PAT) and LOOM_API_URL, or run `loom auth login`.',
    };
  }

  // 2) PAT denylist (admin server). A PAT never reaches an escalation tool.
  if (policy.rejectPat && auth.mode === 'pat') {
    return {
      ok: false,
      code: 'forbidden_principal',
      reason: `${who} does not accept API-token (PAT) credentials — sign in interactively (Entra) for admin operations.`,
    };
  }

  // 3) Mutation gate. Off by default (M1 read-only invariant); on for M3/M5.
  if (!tool.readOnly && !policy.allowMutations) {
    return { ok: false, code: 'forbidden_mutation', reason: `tool "${tool.name}" is not read-only; refused by ${who}.` };
  }

  // 4) Explicit admin floor (admin server) — on TOP of the per-tool scope floor.
  if (policy.requireAdmin && auth.scope !== 'admin') {
    return {
      ok: false,
      code: 'forbidden_not_admin',
      reason: `tool "${tool.name}" requires an admin credential; caller scope is "${auth.scope}".`,
    };
  }

  // 5) Per-tool scope floor.
  if (!scopeSatisfies(auth.scope, tool.minScope)) {
    return {
      ok: false,
      code: 'insufficient_scope',
      reason: `tool "${tool.name}" requires scope "${tool.minScope}"; token scope is "${auth.scope}".`,
    };
  }
  return { ok: true };
}

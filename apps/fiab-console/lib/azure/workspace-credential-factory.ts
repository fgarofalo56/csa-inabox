/**
 * workspace-credential-factory — I5 (loom-next-level): the ONE module every
 * Azure client resolves server-side credentials through.
 *
 * WHY. Today ~130 clients under lib/azure/* build a module-level
 * `new ChainedTokenCredential(new AcaManagedIdentityCredential(), …)` — the
 * credential is resolved ONCE at module load from process env, so there is no
 * per-request / per-workspace identity context anywhere. This factory is the
 * load-bearing interface change of Section I: a client asks
 * `credentialFor({ workspaceId })` (or holds the lazy
 * {@link workspaceScopedCredential} adapter) and the ACTIVE identity is decided
 * per call by `LOOM_WORKSPACE_IDENTITY_MODE`:
 *
 *   off      → the shared Console UAMI chain (uamiArmCredential — today's exact
 *              behavior; zero cost, no ARM lookup, no Cosmos).
 *   shadow   → the SHARED credential (behavior unchanged) — and this is the ONE
 *              seam where the I3 shadow hook fires ("would the workspace UAMI
 *              have had access?" recorded, never blocking). Concentrating that
 *              hook here — not across 130+ call sites — is why I5 lands before
 *              I3 in the chain.
 *   enforce  → the per-workspace ManagedIdentityCredential for
 *              uami-ws-<workspaceId> (LRU-cached), minted via the existing
 *              getWorkspaceCredential — which FAIL-SAFES to the shared UAMI
 *              when the UAMI doesn't exist / ARM is unreachable, so a
 *              mis-flip never breaks a request. (The per-workspace enforce
 *              flag lands with I6; until then global enforce mode governs.)
 *
 * CACHE-KEY GUARD (rev-2 SRE F14 — the confused-deputy review's one demand):
 * the LRU keys STRICTLY on `workspaceId` and NEVER returns a different
 * workspace's cached credential on a miss — a miss mints/looks-up fresh.
 * Proven by unit test (workspace-credential-factory.test.ts).
 *
 * ADOPTION RATCHET: scripts/ci/check-workspace-credential-adoption.mjs counts
 * direct `new ChainedTokenCredential(` constructions under lib/ and only ever
 * lets the number SHRINK — new code must come through this factory. Pure
 * admin/ARM-plane clients that can never carry a workspace context may stay on
 * `uamiArmCredential()` (they still ride the same chain this factory serves).
 */

import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/identity';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { workspaceIdentityMode } from '@/lib/azure/workspace-identity-client';

export interface CredentialContext {
  /** The workspace whose identity should govern this call (when known). */
  workspaceId?: string;
  /** I2 grant-matrix backend key ('adls-lake' | 'synapse-sql' | …) — consumed
   * by the I3 shadow hook to answer "would the workspace UAMI have had
   * access?" against the right grant. */
  backend?: string;
}

// The shared Console-UAMI chain, constructed ONCE per process — the exact
// object shape every migrated module-level singleton used to hold.
let sharedCredential: TokenCredential | undefined;
function shared(): TokenCredential {
  return (sharedCredential ??= uamiArmCredential());
}

// ── enforce-mode per-workspace credential LRU ───────────────────────────────
// Keyed STRICTLY on workspaceId (F14). Short TTL so a rollback
// (enforce → off / flag off) takes effect within minutes without a redeploy —
// the TTL is the documented max rollback latency (I7).
const WS_CRED_TTL_MS = 5 * 60_000;
const WS_CRED_MAX_ENTRIES = 500;
const wsCredCache = new Map<string, { at: number; cred: TokenCredential }>();

/** Test-only: reset the factory's caches. */
export function __clearWorkspaceCredentialCache(): void {
  wsCredCache.clear();
  sharedCredential = undefined;
}

async function enforceCredential(workspaceId: string): Promise<TokenCredential> {
  const hit = wsCredCache.get(workspaceId); // strict key — never a neighbor's entry
  if (hit && Date.now() - hit.at < WS_CRED_TTL_MS) return hit.cred;
  // Lazy import: the off/shadow fast paths never pay the identity-client load.
  const { getWorkspaceCredential } = await import('@/lib/azure/workspace-identity-client');
  // getWorkspaceCredential FAIL-SAFES internally: missing UAMI / unreachable
  // ARM / open config gate all resolve to the shared UAMI (logged there).
  const cred = await getWorkspaceCredential(workspaceId);
  wsCredCache.set(workspaceId, { at: Date.now(), cred });
  if (wsCredCache.size > WS_CRED_MAX_ENTRIES) {
    // Evict the oldest entry (insertion order ≈ oldest `at` under steady use).
    const oldest = wsCredCache.keys().next().value;
    if (oldest !== undefined) wsCredCache.delete(oldest);
  }
  return cred;
}

/**
 * Resolve the credential for a (possibly workspace-scoped) server-side Azure
 * call. See the module header for the per-mode behavior table. Never throws:
 * every branch resolves to a usable TokenCredential (worst case the shared
 * chain).
 */
export async function credentialFor(ctx?: CredentialContext): Promise<TokenCredential> {
  const mode = workspaceIdentityMode();
  if (mode === 'off' || !ctx?.workspaceId) return shared();
  if (mode === 'shadow') {
    // I3 lands the shadow hook HERE (recordIdentityShadow — async, sampled,
    // never blocking). In I5 the shadow branch is behaviorally identical to
    // off: the call runs as the shared UAMI.
    return shared();
  }
  // enforce — per-workspace identity (I6 adds the per-workspace flag gate).
  try {
    return await enforceCredential(ctx.workspaceId);
  } catch {
    return shared(); // belt-and-braces fail-safe (I7 rollback guarantee)
  }
}

/**
 * Lazy TokenCredential adapter — the drop-in replacement for a module-level
 * `const credential = new ChainedTokenCredential(…)`. The underlying identity
 * is resolved through {@link credentialFor} at getToken TIME (per call), so a
 * migrated client picks up mode changes + per-workspace context without any
 * further refactor. With mode off this delegates straight to the memoized
 * shared chain — behavior and cost identical to the singleton it replaces.
 */
export function workspaceScopedCredential(ctx?: CredentialContext): TokenCredential {
  return {
    async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
      const cred = await credentialFor(ctx);
      return cred.getToken(scopes, options);
    },
  };
}

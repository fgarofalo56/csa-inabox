/**
 * Item version history — RESTORE (Wave-2 W6).
 *
 * POST /api/items/[type]/[id]/versions/[versionId]/restore
 *   → { ok, item }   — the live item after restore
 *
 * Restore writes a NEW save to the live item from the selected version's content
 * (displayName / description / state), through the same Cosmos `items` replace
 * the editors use — so the real backend serves the restored config on reload,
 * and the restore is ITSELF recorded as a new version (via recordItemVersion).
 *
 * ACL: reuses `resolveItemAccessByOid` and requires WRITE (`canWrite`) — a
 * read-only share cannot restore, exactly like it cannot save.
 */
import { NextRequest } from 'next/server';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { getItemVersion, recordItemVersion } from '@/lib/versions/item-version-store';
import { carryServerDerivedScope } from '@/app/api/items/_lib/item-crud';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiOk, apiError, apiForbidden, apiNotFound, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// route-toolkit migration (loom-next-level R3, boy-scout): this route was one of
// the hand-rolled `getSession()` + 401 prologues in
// `scripts/ci/route-toolkit-baseline.json`, and #4619 touched it to add the
// carry below — so the ratchet required clearing it here rather than later.
//
// `scripts/codemods/migrate-route-toolkit.mjs` SKIPS this file with
// "body declares its own `params` (collision)": the old prologue's
// `const params = await props.params` shadows the `params` that `withSession`
// supplies. That is codemod conservatism, not a genuine obstacle — the
// migration deletes the colliding declaration — so this was done BY HAND to the
// same shape as `cosmos-items/[type]/[id]/route.ts`, which this PR migrated for
// the same reason. TOUCH_EXEMPT was deliberately NOT used: exempting a path is
// baselining the guard, not satisfying it.
//
// `withSession` returns `apiUnauthorized()` itself, which is exactly what the
// removed prologue returned, so the 401 contract is unchanged. The local
// try/catch is KEPT: `withSession` genericizes an unexpected throw through
// `apiServerError`, but it does not know that `cosmos_not_configured` must
// surface as a 503 with its own code, and losing that would turn an honest
// infra gate into an opaque 500.
export const POST = withSession<{ type: string; id: string; versionId: string }>(
  async (_req: NextRequest, { session, params }) => {
  try {
    const access = await resolveItemAccessByOid(session, params.id, params.type);
    if (!access) return apiNotFound('Item not found');
    if (!access.canWrite) return apiForbidden('Read-only access');

    const version = await getItemVersion(params.id, params.versionId);
    if (!version) return apiNotFound('Version not found');

    const live = access.item;
    // #4619 — THE SIXTH WHOLESALE `state` WRITER. The snapshot's state is
    // written WHOLESALE below, so before this a restore moved BOTH server-derived
    // keys to whatever the chosen version carried — including, on the live
    // estate, versions recorded through the UNGUARDED generic PATCH before this
    // change deploys. That is a laundering path: the guard refuses the direct
    // write, and "restore a version I saved earlier" would have put it back.
    //
    // CARRY ONLY — NO ASSERT, and that is deliberate. The caller is not
    // SUPPLYING state here, they are SELECTING a stored snapshot, so a receipt
    // that differs from live is the NORMAL case rather than an attack, and
    // asserting would turn an ordinary restore into a 400 whenever the item had
    // been re-provisioned since. Operator decision (2026-09-24), asked as a
    // semantics question and answered "carry the live values forward" over
    // "snapshot wins".
    //
    // Right on the merits, not only safe: a provisioning receipt describes the
    // LIVE Azure object, and that object does not roll back when a Loom item
    // version is restored. Writing an old receipt would make the record claim a
    // backing resource the item may no longer have. `item-definition.ts:116`
    // already drops `provisioning` from a portable definition for the same
    // reason, and `promote.ts` rebases rather than copies.
    //
    // THE COST, disclosed rather than discovered later: an operator who wants to
    // roll back a BINDING will find that restore no longer does it, and there is
    // no other supported path for `state.storageAccount` on an existing item
    // (see the `SERVER_DERIVED_SCOPE_KEYS` block in `server-derived-scope.ts`).
    // That is a
    // real affordance loss. It is the accepted trade because a restore that
    // silently re-points a grant coordinate is worse. Tracked on #4619.
    const restoredState = carryServerDerivedScope(
      (version.content?.state ?? live.state ?? {}) as Record<string, unknown>,
      live.state,
    );
    // Write the version's content back onto the live item as a fresh save.
    const next: WorkspaceItem = {
      ...live,
      displayName: version.content?.displayName?.trim() || live.displayName,
      description: version.content?.description?.trim() || undefined,
      state: restoredState,
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(live.id, live.workspaceId).replace<WorkspaceItem>(next);

    // The restore is itself a save → record it as a new version so history is
    // append-only and a restore can itself be undone by restoring the prior head.
    await recordItemVersion(live, resource ?? next, {
      oid: session.claims.oid,
      name: session.claims.name || session.claims.upn || session.claims.email,
    });

    return apiOk({ item: resource ?? next, restoredFrom: version.id });
  } catch (e: any) {
    if (e?.code === 'cosmos_not_configured') {
      return apiError(e.message || 'Cosmos DB is not configured in this deployment', 503, { code: 'cosmos_not_configured' });
    }
    return apiServerError(e, 'Failed to restore item version', 'cosmos_error');
  }
});

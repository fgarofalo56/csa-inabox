/**
 * OneLake / ADLS Gen2 storage-tier (Hot / Cool / Cold) management.
 *
 * GET  /api/onelake/tier?lakehouseId=&container=&path=
 *   Returns the current access tier of a single file.
 *
 * PUT  /api/onelake/tier
 *   Body: { lakehouseId, container, path, tier: 'Hot' | 'Cool' | 'Cold' }
 *   Changes the access tier. Direction is auto-detected against the live tier:
 *     - cooler  (Hot→Cool/Cold, Cool→Cold) → Set Blob Tier
 *     - warmer  (Cool/Cold→Hot)            → Copy Blob (avoids the
 *                                            early-deletion penalty on the
 *                                            source Cool/Cold blob)
 *
 * Real Azure blob data-plane only — no mock, no Fabric dependency. GA in all
 * four sovereign clouds via the .blob endpoint resolved by getBlobSuffix().
 *
 * Authorization (#4619):
 *   - PUT is TENANT-ADMIN for now (`withTenantAdmin`, before the body is read).
 *     The confinement below relies on the lakehouse root recorded in the item's
 *     state, which is not yet server-owned. PUT becomes item-scoped once #4777's
 *     server-owned roots land; #4808 tracks that change. An admin's PUT still
 *     runs every check below.
 *   - GET is ITEM-scoped, the same model as `/api/lakehouse/path`:
 *   1. The path must be a plain container-relative path
 *      (`lib/util/blob-rel-path.ts`) in a known lake container.
 *   2. `lakehouseId` names the lakehouse the file belongs to. The caller must
 *      reach that item (`resolveItemAccessByOid`: owner, workspace role, item
 *      grant, or tenant admin) — any role for GET, a write role for PUT. An id
 *      the caller cannot reach is a 404, so an id is never confirmed.
 *   3. The lakehouse's storage binding (`resolveLakehouseAbfss`) must be on the
 *      deployment's lake account, and the path must lie in the BOUND container,
 *      strictly below the bound root, compared segment by segment. Anything
 *      outside is a 403 before storage is touched; the path forwarded to storage
 *      is rebuilt from the checked segments.
 *   Without a `lakehouseId` only a tenant admin may act (403 `admin_only`
 *   otherwise), on any file in the known containers — the unscoped admin tool.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';
import { blobRelPathError } from '@/lib/util/blob-rel-path';
import { requireTenantAdmin, type TenantAdminRefusal } from '@/lib/auth/feature-gate';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import type { SessionPayload } from '@/lib/auth/session';
import {
  KNOWN_CONTAINERS,
  getAccountName,
  getBlobTier,
  setBlobTier,
  copyBlobToTier,
  type KnownContainer,
  type BlobAccessTier,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TIERS: BlobAccessTier[] = ['Hot', 'Cool', 'Cold'];

const UNSCOPED_REFUSAL: TenantAdminRefusal = {
  reason:
    'This storage-tier request does not name the lakehouse the file belongs to, so Loom cannot check it '
    + 'against your access to that lakehouse. Only a tenant admin may change tiers without naming a lakehouse.',
  remediation: 'Open the lakehouse that holds the file and change its tier from the Files view.',
};

/** Keep in step with `TIER_CHANGE_ADMIN_ONLY` in lib/util/admin-only-copy.ts. */
const TIER_CHANGE_REFUSAL: TenantAdminRefusal = {
  reason: 'Changing a file\'s storage tier is limited to tenant admins for now.',
  remediation: 'Ask a tenant admin to change the tier. You can still see the current tier here.',
};

const STORAGE_UNBOUND =
  'Loom has no lakehouse storage binding for this item, so it did not read or change any tier. Re-run the '
  + 'item provision and retry.';

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status });
}

/** Non-empty `/`-separated segments; null if any is `.` or `..`. */
function segmentsOf(p: string): string[] | null {
  const out = p.split(/[\\/]/).filter((s) => s !== '');
  return out.some((s) => s === '.' || s === '..') ? null : out;
}

/** Account name from `abfss://<container>@<account>.dfs.<suffix>/<root>`. */
function abfssAccount(abfss: string): string | null {
  const m = /^abfss:\/\/[^@/]+@([^./]+)\./i.exec(abfss);
  return m ? m[1].toLowerCase() : null;
}

interface TierTarget { container: KnownContainer; path: string }

/**
 * Validate the request and return the storage target, or the refusal. Runs
 * every check before any storage call; see the header for the model.
 */
async function resolveTierTarget(
  session: SessionPayload,
  input: { lakehouseId: string; container: string; path: string },
  write: boolean,
): Promise<TierTarget | NextResponse> {
  const { lakehouseId, container, path } = input;
  if (!container || !path) return json({ ok: false, error: 'container and path are required' }, 400);
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return json({ ok: false, error: `unknown container: ${container}` }, 404);
  }
  const pathErr = blobRelPathError(path);
  if (pathErr) return json({ ok: false, error: pathErr }, 400);

  if (!lakehouseId) {
    const gate = requireTenantAdmin(session, UNSCOPED_REFUSAL);
    if (gate) return gate;
    return { container: container as KnownContainer, path };
  }

  // 404, not 403: never confirm an id the caller may not see.
  const access = await resolveItemAccessByOid(session, lakehouseId, 'lakehouse');
  if (!access) return json({ ok: false, error: 'lakehouse not found' }, 404);
  if (write && !access.canWrite) {
    return json({
      ok: false,
      error: 'Your role on this lakehouse is read-only, so Loom did not change the tier. A workspace '
        + 'Member/Admin, or an item grant that includes Edit, can make this change.',
    }, 403);
  }

  const bound = await resolveLakehouseAbfss(lakehouseId, access.item.workspaceId);
  if (!bound) return json({ ok: false, error: STORAGE_UNBOUND }, 409);
  let lakeAccount: string | null = null;
  try { lakeAccount = getAccountName().toLowerCase(); } catch { /* no lake account configured */ }
  if (!lakeAccount || abfssAccount(bound.abfss) !== lakeAccount) {
    return json({
      ok: false,
      error: 'This lakehouse stores its files on a storage account other than the deployment lake account '
        + 'this dialog manages (or no lake account is configured), so Loom did not read or change any tier.',
    }, 409);
  }
  // An empty root would make every path "below" it; refuse it separately.
  const root = segmentsOf(bound.root);
  if (!root || root.length === 0) {
    return json({
      ok: false,
      error: `Loom found a storage binding for this lakehouse, but its recorded root (${JSON.stringify(bound.root)}) `
        + 'is not a usable path inside the container. Re-run the item provision to rewrite the binding.',
    }, 409);
  }

  const segments = segmentsOf(path) ?? [];
  const outside = json({
    ok: false,
    error: `${container}/${segments.join('/')} is outside this lakehouse's storage root `
      + `(${bound.container}/${root.join('/')}), so Loom did not read or change its tier.`,
  }, 403);
  if (bound.container !== container) return outside;
  // Strictly below the root: equal length is the root folder itself.
  if (segments.length <= root.length) return outside;
  for (let i = 0; i < root.length; i += 1) {
    // Segment-wise, so `lakehouses/Sales-archive` is NOT inside `lakehouses/Sales`.
    if (segments[i] !== root[i]) return outside;
  }
  return { container: bound.container as KnownContainer, path: segments.join('/') };
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const sp = req.nextUrl.searchParams;
  const target = await resolveTierTarget(session, {
    lakehouseId: (sp.get('lakehouseId') || '').trim(),
    container: sp.get('container') || '',
    path: sp.get('path') || '',
  }, false);
  if (target instanceof NextResponse) return target;
  const { container, path } = target;

  try {
    const result = await getBlobTier(container, path);
    return NextResponse.json({ ok: true, ...result, container, path });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status },
    );
  }
});

// 401 without a session; 403 `admin_only` for a non-admin before the body is
// read. PUT becomes item-scoped once #4777's server-owned roots land (tracked
// in #4808); until
// then the root `resolveTierTarget` confines to is read from item state, so
// only a tenant admin may write. The admin's request is still validated and
// confined by `resolveTierTarget` before any of `getBlobTier` / `setBlobTier`
// / `copyBlobToTier` runs.
export const PUT = withTenantAdmin(async (req: NextRequest, { session }) => {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const tier: BlobAccessTier = body?.tier;
  const target = await resolveTierTarget(session, {
    lakehouseId: typeof body?.lakehouseId === 'string' ? body.lakehouseId.trim() : '',
    container: typeof body?.container === 'string' ? body.container : '',
    path: typeof body?.path === 'string' ? body.path : '',
  }, true);
  if (target instanceof NextResponse) return target;
  const { container, path } = target;
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json({ ok: false, error: `tier must be one of: ${VALID_TIERS.join(', ')}` }, { status: 400 });
  }

  try {
    // Read the current tier to pick the safe direction.
    const current = await getBlobTier(container, path);
    const currentTier = current.tier;

    // Archive requires multi-hour rehydration; not changeable from this dialog.
    if (currentTier === 'Archive') {
      return NextResponse.json(
        { ok: false, error: 'Source blob is in the Archive tier; rehydration is required before re-tiering and is not supported from this dialog.' },
        { status: 409 },
      );
    }

    // Upgrade (cooler → Hot): use Copy Blob to avoid the early-deletion penalty.
    if (tier === 'Hot' && currentTier && currentTier !== 'Hot') {
      const result = await copyBlobToTier(container, path, 'Hot');
      return NextResponse.json({ ...result, ok: true, container, path });
    }

    // Downgrade / same-or-cooler: Set Blob Tier (Hot→Cool/Cold, Cool→Cold).
    const result = await setBlobTier(container, path, tier as 'Cool' | 'Cold');
    return NextResponse.json({ ...result, ok: true, container, path });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status },
    );
  }
}, TIER_CHANGE_REFUSAL);

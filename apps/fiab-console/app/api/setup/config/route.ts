/**
 * GET /api/setup/config
 *   Returns the Admin Plane deployment defaults the Setup Wizard uses to
 *   auto-fill the single-subscription path WITHOUT a dropdown — the new DLZ
 *   lands in the same subscription as the Admin Plane (LOOM_SUBSCRIPTION_ID),
 *   in the deployment region (LOOM_LOCATION), unless the operator chooses the
 *   multi-subscription path.
 *
 * The browser cannot read process.env, so this session-gated route exposes the
 * two NON-secret deployment coordinates the wizard needs. It optionally resolves
 * the admin subscription's friendly displayName via a single ARM GET (best
 * effort — the id is always returned even if the name lookup is denied).
 *
 * Response shape:
 *   { ok: true,  adminSubscriptionId, adminSubscriptionName, location, boundary }
 *   { ok: false, error }                                            (only on auth)
 *
 * No secrets are ever returned (mirrors the env-config masking convention).
 */
import { NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Best-effort friendly name for the admin subscription — never blocks the response. */
async function resolveSubName(subId: string): Promise<string | undefined> {
  if (!GUID_RE.test(subId)) return undefined;
  try {
    const arm = armBase();
    const t = await credential.getToken(`${arm}/.default`);
    if (!t?.token) return undefined;
    const r = await fetch(`${arm}/subscriptions/${subId}?api-version=2022-12-01`, {
      headers: { authorization: `Bearer ${t.token}` },
      cache: 'no-store',
    });
    if (!r.ok) return undefined;
    const j: any = await r.json().catch(() => null);
    return j?.displayName || undefined;
  } catch {
    return undefined;
  }
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const adminSubscriptionId = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const location = (process.env.LOOM_LOCATION || '').trim();

  // Friendly name is a best-effort enrichment; absence never blocks the wizard.
  const adminSubscriptionName = adminSubscriptionId
    ? await resolveSubName(adminSubscriptionId)
    : undefined;

  return NextResponse.json({
    ok: true,
    adminSubscriptionId: adminSubscriptionId || undefined,
    adminSubscriptionName,
    location: location || undefined,
    boundary: cloudBoundaryLabel(),
  });
}

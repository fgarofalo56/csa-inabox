/**
 * GET /api/setup/subscriptions
 *   Lists every Azure subscription the Console identity can see via
 *   Azure Resource Manager: `GET {arm}/subscriptions?api-version=2022-12-01`.
 *
 * Used by the Setup Wizard's subscription-selection step so the operator
 * picks the *target* subscription before a Data Landing Zone deploy. The
 * previous wizard never collected a subscription id, so the deploy step
 * failed with no way to choose where the DLZ lands.
 *
 * The Console identity (UAMI or the developer's az-login credential) needs
 * Reader on the subscriptions it should be able to target. Subscriptions
 * outside that grant simply won't appear — that's ARM's own RBAC trim, not
 * a Loom filter.
 *
 * Cloud selection:
 *   LOOM_ARM_ENDPOINT  (Commercial: the ARM commercial host — default)
 *                      (Gov:        https://management.usgovcloudapi.net)
 *
 * Response shape:
 *   { ok: true,  subscriptions: [{ subscriptionId, displayName, state, tenantId }] }
 *   { ok: false, error, hint? }                              on auth / network failure
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { getArmTokenPreferUser } from '@/lib/auth/obo';
import { swrAwait } from '@/lib/azure/cross-sub-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function arm(): string {
  return armBase();
}

interface ArmSubscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId?: string;
}

/** Walk ARM's nextLink-paged subscription list under `token`. Throws on ARM error. */
async function listSubscriptions(token: string): Promise<ArmSubscription[]> {
  const subscriptions: ArmSubscription[] = [];
  let url: string | undefined = `${arm()}/subscriptions?api-version=2022-12-01`;
  while (url) {
    const r: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`ARM ${r.status}: ${t.slice(0, 200)}`);
    }
    if (!ct.includes('application/json')) {
      const t = await r.text().catch(() => '');
      throw new Error(`ARM returned non-JSON (${ct || 'unknown'}): ${t.slice(0, 200)}`);
    }
    const j: any = await r.json();
    for (const s of (j.value || []) as any[]) {
      subscriptions.push({
        subscriptionId: s.subscriptionId,
        displayName: s.displayName,
        state: s.state,
        tenantId: s.tenantId,
      });
    }
    url = j.nextLink || undefined;
  }
  subscriptions.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  return subscriptions;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // USER-PASSTHROUGH: list the subscriptions the SIGNED-IN USER can see (so the
  // target-subscription picker reflects what they can actually deploy into),
  // falling back to the shared Console UAMI when the user's ARM scope wasn't
  // consented at login.
  let token: string;
  let identity: 'user' | 'uami';
  try {
    const arm = await getArmTokenPreferUser(session);
    token = arm.token;
    identity = arm.identity;
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'Could not acquire an ARM token. Grant the Console UAMI (or your signed-in account) Reader on the target subscriptions.',
      },
      { status: 502 },
    );
  }

  // SWR-cached per (user, identity): the cross-sub list can be slow on a large
  // tenant, so a Refresh/retry is served from cache instantly (a cold miss awaits
  // the real ARM walk once). Keyed by identity so a UAMI list never masks the
  // user's own visibility.
  try {
    const { value: subscriptions } = await swrAwait(
      session.claims.oid,
      `subscriptions:${identity}`,
      { ttlMs: 60_000 },
      () => listSubscriptions(token),
    );
    return NextResponse.json({ ok: true, subscriptions, identity });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `ARM request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
}

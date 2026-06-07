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
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function arm(): string {
  return armBase();
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${arm()}/.default`);
  if (!t?.token) throw new Error('Failed to acquire AAD token for ARM');
  return t.token;
}

interface ArmSubscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId?: string;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let token: string;
  try {
    token = await armToken();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI (or your az-login principal) Reader on the target subscriptions.',
      },
      { status: 502 },
    );
  }

  // ARM is paged via nextLink; walk every page so large tenants list fully.
  const subscriptions: ArmSubscription[] = [];
  let url: string | undefined = `${arm()}/subscriptions?api-version=2022-12-01`;
  try {
    while (url) {
      const r: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return NextResponse.json(
          { ok: false, error: `ARM ${r.status}: ${t.slice(0, 200)}` },
          { status: 502 },
        );
      }
      if (!ct.includes('application/json')) {
        const t = await r.text().catch(() => '');
        return NextResponse.json(
          { ok: false, error: `ARM returned non-JSON (${ct || 'unknown'}): ${t.slice(0, 200)}` },
          { status: 502 },
        );
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
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `ARM request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }

  subscriptions.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

  return NextResponse.json({ ok: true, subscriptions });
}

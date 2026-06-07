/**
 * GET /api/azure/function-apps
 *   List all Microsoft.Web/sites of kind=functionapp in the Loom subscription.
 *
 * Used by the UserDataFunctionEditor to populate the "Deploy to Function App"
 * picker. The Console UAMI needs Reader at the subscription level (same role
 * as the Azure SQL server listing).
 *
 * Response shape:
 *   { ok: true, functionApps: [{ id, name, location, kind, state, defaultHostName, resourceGroup }] }
 *   { ok: false, error, hint? }     on auth / network failure
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

interface ArmSite {
  id: string;
  name: string;
  location?: string;
  kind?: string;
  properties?: {
    state?: string;
    defaultHostName?: string;
    resourceGroup?: string;
    enabled?: boolean;
  };
}

function rgFromId(id: string): string | undefined {
  const m = id.match(/\/resourceGroups\/([^/]+)\//i);
  return m ? m[1] : undefined;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) {
    return NextResponse.json({
      ok: false,
      error: 'LOOM_SUBSCRIPTION_ID not configured',
      hint: 'Set LOOM_SUBSCRIPTION_ID env var on the Console Container App to enable Function App discovery.',
    }, { status: 500 });
  }

  try {
    const token = await armToken();
    const url = `${arm()}/subscriptions/${sub}/providers/Microsoft.Web/sites?api-version=2023-12-01`;
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      cache: 'no-store',
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* fall-through */ }
    if (!res.ok) {
      const msg = (body?.error?.message || text || `ARM HTTP ${res.status}`).toString();
      const hint = res.status === 401 || res.status === 403
        ? 'Grant the Console UAMI the "Reader" role on the Loom subscription (or a more specific role on the Function App resource group).'
        : undefined;
      return NextResponse.json({ ok: false, error: msg, hint }, { status: res.status });
    }
    const sites: ArmSite[] = body?.value || [];
    const functionApps = sites
      .filter((s) => typeof s.kind === 'string' && s.kind.toLowerCase().includes('functionapp'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        location: s.location,
        kind: s.kind,
        state: s.properties?.state,
        defaultHostName: s.properties?.defaultHostName,
        resourceGroup: rgFromId(s.id),
        enabled: s.properties?.enabled,
      }));
    return NextResponse.json({ ok: true, functionApps });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

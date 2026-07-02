/**
 * Create a NEW Azure Data Factory (ADF standalone) across any subscription /
 * resource group the Console identity can reach — the binder "Create new
 * factory" action behind the unified Data pipeline editor's runtime selector.
 *
 *   POST /api/adf/factories/create
 *     body { name, location, subscriptionId, resourceGroup }
 *     → ARM PUT
 *        https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}
 *          /providers/Microsoft.DataFactory/factories/{name}?api-version=2018-06-01
 *        body { location, properties: {} }
 *     → 200 { ok:true, factory:{ id,name,subscriptionId,resourceGroup,location } }
 *
 * Shared-contract refs:
 *   - Contract E#1 (the binder create-new route) — body shape, return shape,
 *     and the verbatim honest-gate copy below.
 *   - no-fabric-dependency.md — `'adf'` is the Azure-native DEFAULT pipeline
 *     runtime; this route provisions a real Azure Data Factory (NOT Fabric).
 *   - no-vaporware.md §2/§3 — REAL ARM REST, no mock; honest precise gates.
 *
 * The ARM call targets a CROSS-sub/rg factory (the operator picks where to
 * create it via AzureResourcePicker), so it builds its OWN ARM URL from
 * `armBase()` rather than the env-pinned default-factory base in adf-client.
 * Auth is the same ChainedTokenCredential(ACA-MSI → UAMI → Default) chain the
 * adf-client uses, so the Console identity's ARM token flows through unchanged.
 * This is the Contract-E `createFactory()` behaviour, implemented at the route
 * (cross-sub/rg PUT, api-version 2018-06-01).
 *
 * Mirrors the session + try/catch shape of /api/adf/integration-runtimes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADF factory naming: 3-63 chars, letters/digits/hyphen (per ADF resource
// naming rules). Matches Contract E NAME_RE.
const NAME_RE = /^[A-Za-z0-9-]{3,63}$/;
// Azure region tokens are lowercase letters/digits (e.g. eastus2, usgovvirginia).
const LOCATION_RE = /^[A-Za-z0-9 ]{2,64}$/;
// ARM subscription GUID.
const SUB_RE = /^[0-9a-fA-F-]{36}$/;
// ARM resource-group name.
const RG_RE = /^[A-Za-z0-9._()-]{1,90}$/;

const API = '2018-06-01';

// Same credential chain adf-client.ts uses — ACA MSI first (the running
// Container App's user-assigned identity), then an explicit UAMI by client id,
// then DefaultAzureCredential for local/dev. The UAMI needs Data Factory
// Contributor (or Contributor) on the TARGET resource group; the honest 403
// gate below names exactly that.
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

interface CreateFactoryBody {
  name?: unknown;
  location?: unknown;
  subscriptionId?: unknown;
  resourceGroup?: unknown;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as CreateFactoryBody;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const location = typeof body?.location === 'string' ? body.location.trim() : '';
  const subscriptionId = typeof body?.subscriptionId === 'string' ? body.subscriptionId.trim() : '';
  const resourceGroup = typeof body?.resourceGroup === 'string' ? body.resourceGroup.trim() : '';

  // 400 on missing / invalid — precise so the wizard can map each to its field.
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!NAME_RE.test(name)) {
    return NextResponse.json(
      { ok: false, error: 'name must be 3-63 chars: letters, digits, hyphen' },
      { status: 400 },
    );
  }
  if (!location) return NextResponse.json({ ok: false, error: 'location is required' }, { status: 400 });
  if (!LOCATION_RE.test(location)) {
    return NextResponse.json({ ok: false, error: 'location is invalid' }, { status: 400 });
  }
  if (!subscriptionId) return NextResponse.json({ ok: false, error: 'subscriptionId is required' }, { status: 400 });
  if (!SUB_RE.test(subscriptionId)) {
    return NextResponse.json({ ok: false, error: 'subscriptionId must be a GUID' }, { status: 400 });
  }
  if (!resourceGroup) return NextResponse.json({ ok: false, error: 'resourceGroup is required' }, { status: 400 });
  if (!RG_RE.test(resourceGroup)) {
    return NextResponse.json({ ok: false, error: 'resourceGroup is invalid' }, { status: 400 });
  }

  // Build the cross-sub/rg ARM URL from armBase() (sovereign-cloud aware) — NOT
  // the env-pinned default-factory base. ARM PUT is idempotent: re-PUT on an
  // existing factory is a no-op update, so "Create new" is safe to retry.
  const id =
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.DataFactory/factories/${name}`;
  const url = `${armBase()}${id}?api-version=${API}`;

  try {
    const tok = await credential.getToken(armScope());
    if (!tok?.token) {
      return NextResponse.json(
        { ok: false, error: 'Failed to acquire an Azure ARM token for the Console identity.' },
        { status: 502 },
      );
    }

    const res = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${tok.token}`,
        'content-type': 'application/json',
      },
      // Minimal factory body — region + empty properties. ADF takes its
      // identity / repo / network config via later updates (the editor's
      // Manage surfaces), so create is intentionally lean.
      body: JSON.stringify({ location, properties: {} }),
    });

    const text = await res.text();
    // ARM returns 200 (existing) or 201 (created) on success.
    if (res.ok) {
      let parsed: { id?: string; name?: string; location?: string } = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { /* tolerate empty/non-JSON 200 */ }
      return NextResponse.json({
        ok: true,
        factory: {
          id: parsed.id || id,
          name: parsed.name || name,
          subscriptionId,
          resourceGroup,
          location: parsed.location || location,
        },
      });
    }

    // ---- Honest gates (no-vaporware §2) -------------------------------------
    // 403 → the Console identity can't create resources in the target RG.
    if (res.status === 403) {
      return NextResponse.json(
        {
          ok: false,
          code: 'forbidden',
          error:
            `Console UAMI lacks Contributor on resource group ${resourceGroup}. ` +
            `Grant Data Factory Contributor (or Contributor) on it, or pick an existing factory.`,
        },
        { status: 403 },
      );
    }

    // Microsoft.DataFactory resource provider not registered on the target sub.
    // ARM surfaces this as 409 (or 400) with code MissingSubscriptionRegistration
    // / SubscriptionNotRegistered. Honest message naming the exact remediation.
    if (/MissingSubscriptionRegistration|SubscriptionNotRegistered|not registered to use namespace 'Microsoft\.DataFactory'/i.test(text)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'rp_not_registered',
          error:
            `The Microsoft.DataFactory resource provider is not registered on subscription ${subscriptionId}. ` +
            `Register it (az provider register --namespace Microsoft.DataFactory --subscription ${subscriptionId}) and retry.`,
        },
        { status: 409 },
      );
    }

    // Anything else: surface the real ARM error text (truncated) — never a mock.
    return NextResponse.json(
      { ok: false, error: `Factory create failed ${res.status}: ${text.slice(0, 600)}` },
      { status: 502 },
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

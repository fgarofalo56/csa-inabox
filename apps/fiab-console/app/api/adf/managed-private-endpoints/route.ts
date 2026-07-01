/**
 * Managed private endpoints on the deployment-default Data Factory (the Factory
 * Resources navigator's "Managed private endpoints" group).
 *
 * A managed private endpoint lets the factory's Managed VNet Azure IR reach a
 * PE-locked data source (ADLS, Azure SQL, Key Vault, …) privately. ADF's managed
 * virtual network is conventionally named `default`; managed PEs live under it.
 * A newly-created PE lands **Pending** — the OWNER of the target resource must
 * approve the private-endpoint connection (a separate ARM action on the source)
 * before it carries traffic. This route does NOT auto-approve; it surfaces the
 * approval as an honest next step.
 *
 *   GET  /api/adf/managed-private-endpoints
 *        → { ok, managedVnetName, managedVnetPresent, managedPrivateEndpoints: [...] }
 *   POST /api/adf/managed-private-endpoints  body { action: 'create-mvnet' }
 *        → create the managed VNet (prerequisite for PEs)
 *   POST /api/adf/managed-private-endpoints  body { name, privateLinkResourceId, groupId, fqdns? }
 *        → create a managed PE (Pending) + nextStep approval note
 *   DELETE /api/adf/managed-private-endpoints?name=NAME → delete a managed PE
 *
 * Factory is the env-pinned default; honest 503 gate when LOOM_SUBSCRIPTION_ID /
 * LOOM_DLZ_RG / LOOM_ADF_NAME aren't set. The Loom UAMI needs Data Factory
 * Contributor on that factory. Pure ADF ARM (2018-06-01), no Fabric. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate, DEFAULT_MANAGED_VNET,
  listManagedVnets, ensureManagedVnet,
  listManagedPrivateEndpoints, upsertManagedPrivateEndpoint, deleteManagedPrivateEndpoint,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ManagedPrivateEndpoint name: 1-127, start/end alphanumeric or _, inner may include -.
const PE_NAME_RE = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,125}[A-Za-z0-9_])?$/;

function gate() {
  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/** Build the honest "approve the PE on the target resource" next-step note + portal link. */
function approvalNextStep(resourceId: string, peName: string): { note: string; portalUrl: string; azCli: string } {
  return {
    note:
      `Managed private endpoint “${peName}” was created in a Pending state. It cannot carry ` +
      `traffic until the owner of the target resource APPROVES the private-endpoint connection — ` +
      `a separate ARM action on the source, not performed here. Approve it in the Azure portal ` +
      `(the resource → Networking → Private endpoint connections → Approve) or with the Azure CLI.`,
    portalUrl: `https://portal.azure.com/#@/resource${resourceId}/networking`,
    azCli:
      `az network private-endpoint-connection approve --id ` +
      `$(az network private-endpoint-connection list --id "${resourceId}" ` +
      `--query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id | [0]" -o tsv) ` +
      `--description "Approved for ADF managed VNet"`,
  };
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const mvnets = await listManagedVnets();
    const managedVnetPresent = mvnets.some((v) => v.name === DEFAULT_MANAGED_VNET) || mvnets.length > 0;
    const mvnetName = mvnets[0]?.name || DEFAULT_MANAGED_VNET;
    // PEs live under a managed VNet — only list when one exists.
    const managedPrivateEndpoints = managedVnetPresent
      ? await listManagedPrivateEndpoints(mvnetName)
      : [];
    return NextResponse.json({ ok: true, managedVnetName: mvnetName, managedVnetPresent, managedPrivateEndpoints });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));

  try {
    // Create the managed VNet (prerequisite for any managed private endpoint).
    if (body?.action === 'create-mvnet') {
      const mvnet = await ensureManagedVnet(DEFAULT_MANAGED_VNET);
      return NextResponse.json({
        ok: true,
        action: 'create-mvnet',
        managedVnetName: mvnet.name,
        message:
          `Managed virtual network “${mvnet.name}” created on the factory. Managed private ` +
          `endpoints can now be added to reach PE-locked sources privately. Note: the factory's ` +
          `Managed IR must run inside this managed VNet for the endpoints to be used.`,
      });
    }

    // Otherwise: create a managed private endpoint to a target resource.
    const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
    const privateLinkResourceId: string = typeof body?.privateLinkResourceId === 'string' ? body.privateLinkResourceId.trim() : '';
    const groupId: string = typeof body?.groupId === 'string' ? body.groupId.trim() : '';
    const fqdns: string[] | undefined = Array.isArray(body?.fqdns)
      ? body.fqdns.map((f: unknown) => String(f).trim()).filter(Boolean)
      : undefined;

    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    if (!PE_NAME_RE.test(name)) {
      return NextResponse.json({ ok: false, error: "name must be 1-127 chars: letters, digits, _ or - (start/end alphanumeric or _)" }, { status: 400 });
    }
    if (!privateLinkResourceId || !privateLinkResourceId.startsWith('/subscriptions/')) {
      return NextResponse.json({ ok: false, error: 'privateLinkResourceId must be the full ARM resource id of the target (/subscriptions/…)' }, { status: 400 });
    }
    if (!groupId) return NextResponse.json({ ok: false, error: 'groupId is required (e.g. dfs, blob, sqlServer, vault)' }, { status: 400 });

    const pe = await upsertManagedPrivateEndpoint(name, { privateLinkResourceId, groupId, fqdns });
    const next = approvalNextStep(privateLinkResourceId, pe.name || name);
    return NextResponse.json({
      ok: true,
      action: 'create-pe',
      managedPrivateEndpoint: pe,
      nextStep: next,
      message: next.note,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteManagedPrivateEndpoint(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

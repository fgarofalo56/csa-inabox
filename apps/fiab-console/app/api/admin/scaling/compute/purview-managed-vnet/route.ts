/**
 * /api/admin/scaling/compute/purview-managed-vnet
 *
 * The SERVERLESS, no-SHIR path for scanning PE-locked Azure sources with
 * Microsoft Purview. Instead of standing up + patching a self-hosted IR VMSS
 * (see ../register-purview-shir), Purview deploys and manages a virtual network
 * and the private endpoints itself. Surfaced in Admin → Capacity & compute →
 * "Scale & manage" as the "Managed VNet IR + private endpoints" section.
 *
 *   GET  → honest gate status + inventory: is LOOM_PURVIEW_ACCOUNT set, which
 *          managed-VNet IR / managed virtual network names Loom uses, the managed
 *          virtual networks present, and the managed private endpoints in the
 *          default managed VNet (with their Pending/Approved connection state).
 *
 *   POST { action: 'create-ir' }                         → real scanning-dataplane:
 *            PUT /scan/managedvirtualnetworks/{mvnet}                 (create the managed VNet)
 *            PUT /scan/integrationruntimes/{ir}  kind 'Managed'       (create the managed-VNet IR)
 *
 *   POST { action: 'create-pe', resourceId, groupId, name? }  → real scanning-dataplane:
 *            PUT /scan/managedvirtualnetworks/{mvnet}/managedprivateendpoints/{name}
 *          Creates a managed private endpoint to a data source (e.g. the DLZ lake
 *          storage account, groupId `dfs`/`blob`). The PE is created in a PENDING
 *          state — the response carries an honest next-step note: the resource
 *          owner must APPROVE it (ARM privateEndpointConnections approve on the
 *          target resource) before scans can traverse it. Loom does NOT perform
 *          that approval here — it is a separate ARM action against the source.
 *
 * Honest gate (no Fabric, no mocks):
 *   - LOOM_PURVIEW_ACCOUNT unset → 501 { gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } }
 *
 * The Console UAMI already holds Data Source Administrator on Purview (needed to
 * PUT the managed VNet / IR / managed PEs) — granted in bicep
 * (admin-plane/catalog.bicep consolePurviewScanAdminGrant).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import {
  isPurviewConfigured,
  getPurviewAccountName,
  upsertPurviewManagedVnet,
  upsertPurviewManagedVnetIr,
  listPurviewManagedVnets,
  listPurviewManagedPrivateEndpoints,
  upsertPurviewManagedPrivateEndpoint,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Names Loom uses for the shared managed VNet + its managed-VNet IR (overridable). */
const MVNET_NAME = process.env.LOOM_PURVIEW_MANAGED_VNET || 'loom-purview-mvnet';
const MVNET_IR_NAME = process.env.LOOM_PURVIEW_MANAGED_VNET_IR || 'loom-purview-mvnet-ir';

/** Derive a stable managed-PE name from the target resource + group. */
function defaultPeName(resourceId: string, groupId: string): string {
  const leaf = (resourceId.split('/').pop() || 'source').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const g = (groupId || 'pe').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `mpe-${leaf}-${g}`.slice(0, 63);
}

/** Build the honest "approve the PE on the target resource" next-step note + portal link. */
function approvalNextStep(resourceId: string, peName: string): { note: string; portalUrl: string; azCli: string } {
  return {
    note:
      `Managed private endpoint “${peName}” was created in a PENDING state. It cannot carry scan ` +
      `traffic until the owner of the target resource APPROVES the private-endpoint connection — ` +
      `a separate ARM action on the source, not performed here. Approve it in the Azure portal ` +
      `(the resource → Networking → Private endpoint connections → Approve) or with the Azure CLI.`,
    portalUrl: `https://portal.azure.com/#@/resource${resourceId}/networking`,
    azCli:
      `az network private-endpoint-connection approve --id ` +
      `$(az network private-endpoint-connection list --id "${resourceId}" ` +
      `--query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id | [0]" -o tsv) ` +
      `--description "Approved for Purview managed VNet scan"`,
  };
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;

  const purviewConfigured = isPurviewConfigured();
  if (!purviewConfigured) {
    return NextResponse.json({
      ok: true,
      purviewConfigured: false,
      purviewAccount: null,
      mvnetName: MVNET_NAME,
      irName: MVNET_IR_NAME,
      managedVnets: [],
      managedPrivateEndpoints: [],
      irPresent: false,
    });
  }

  try {
    const managedVnets = await listPurviewManagedVnets();
    const irPresent = managedVnets.some((v) => v.name === MVNET_NAME);
    // Managed PEs live under a managed VNet — only list when ours exists.
    const managedPrivateEndpoints = irPresent
      ? await listPurviewManagedPrivateEndpoints(MVNET_NAME)
      : [];
    return NextResponse.json({
      ok: true,
      purviewConfigured: true,
      purviewAccount: getPurviewAccountName(),
      mvnetName: MVNET_NAME,
      irName: MVNET_IR_NAME,
      managedVnets,
      managedPrivateEndpoints,
      irPresent,
    });
  } catch (e: unknown) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: 'Microsoft Purview is not provisioned in this deployment.', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } },
        { status: 501 },
      );
    }
    if (e instanceof PurviewError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 502 });
    }
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;

  // Honest gate: Purview not provisioned.
  if (!isPurviewConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Microsoft Purview is not provisioned in this deployment.', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } },
      { status: 501 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    name?: string;
    resourceId?: string;
    groupId?: string;
  };
  const action = (body.action || 'create-ir').toString();

  try {
    if (action === 'create-pe') {
      // Create a managed private endpoint to a data source (e.g. the DLZ lake).
      const resourceId = (body.resourceId || '').trim();
      const groupId = (body.groupId || '').trim();
      if (!resourceId || !groupId) {
        return NextResponse.json(
          { ok: false, error: 'resourceId and groupId are required to create a managed private endpoint (e.g. the storage account ARM id + groupId “dfs”).' },
          { status: 400 },
        );
      }
      const peName = (typeof body.name === 'string' && body.name.trim()) || defaultPeName(resourceId, groupId);
      const pe = await upsertPurviewManagedPrivateEndpoint(MVNET_NAME, peName, { resourceId, groupId });
      const next = approvalNextStep(resourceId, pe.name || peName);
      return NextResponse.json({
        ok: true,
        action: 'create-pe',
        mvnetName: MVNET_NAME,
        managedPrivateEndpoint: pe,
        nextStep: next,
        message: next.note,
      });
    }

    // Default action: create-ir — the managed VNet + the managed-VNet IR.
    const irName = (typeof body.name === 'string' && body.name.trim()) || MVNET_IR_NAME;
    const mvnet = await upsertPurviewManagedVnet(MVNET_NAME);
    const ir = await upsertPurviewManagedVnetIr(irName, {
      managedVnetName: MVNET_NAME,
      description: `Loom-managed Purview managed-VNet IR (serverless scan of PE-locked sources, no SHIR VMSS)`,
    });
    return NextResponse.json({
      ok: true,
      action: 'create-ir',
      mvnetName: mvnet.name || MVNET_NAME,
      irName: ir.name || irName,
      irKind: ir.kind || 'Managed',
      irState: ir.state || 'provisioning',
      message:
        `Managed-VNet integration runtime “${ir.name || irName}” created on managed virtual network ` +
        `“${mvnet.name || MVNET_NAME}”. It initializes in a few minutes (state turns “Running”). ` +
        `Add a managed private endpoint per PE-locked source below, then approve each on the target ` +
        `resource — Purview then scans those sources with no self-hosted IR VMSS to run.`,
    });
  } catch (e: unknown) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: 'Microsoft Purview is not provisioned in this deployment.', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } },
        { status: 501 },
      );
    }
    if (e instanceof PurviewError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 502 });
    }
    return apiServerError(e);
  }
}

/**
 * Trusted workspace access — storage RESOURCE-INSTANCE rules (Fabric-parity
 * Phase 4 G6).
 *
 * The Fabric "trusted workspace access" equivalent on the Azure-native path:
 * authorize an identity-bearing resource instance to reach a FIREWALLED ADLS
 * Gen2 / Blob storage account (networkAcls.defaultAction=Deny) by writing a
 * `{ tenantId, resourceId }` entry into
 * `Microsoft.Storage/storageAccounts → properties.networkAcls.resourceAccessRules`
 * over REAL ARM (GET + PATCH, complete acls preserved). The sibling `trusted`
 * route manages IP-CIDR NSG allow-rules; THIS route manages the storage-side
 * resource-instance authorization.
 *
 *   GET    /api/admin/workspaces/[id]/networking/trusted-resources?storageAccountId=<armId>
 *            → { ok, state: StorageTrustedAccessState, identities }
 *              identities = the resolvable choices for the Add dropdown:
 *                consoleUami       — LOOM_UAMI_RESOURCE_ID (null when unset)
 *                workspaceIdentity — the per-workspace uami-ws-<id> when it
 *                                    exists in ARM (null otherwise / unconfigured)
 *   POST   /api/admin/workspaces/[id]/networking/trusted-resources
 *            body { storageAccountId, identity: 'console-uami' | 'workspace-identity' }
 *            → resolves the identity to its ARM resource id + tenant, PATCHes
 *              the rule in, returns the refreshed state
 *   DELETE /api/admin/workspaces/[id]/networking/trusted-resources
 *              ?storageAccountId=<armId>&resourceId=<armId>[&tenantId=<guid>]
 *            → PATCHes the rule out, returns the refreshed state
 *
 * SECURITY: authorizeNetworking = session + workspace ownership + TENANT ADMIN
 * (same gate as every sibling under networking/). Honest gates per
 * no-vaporware.md flow through storageTrustedAccessErrorResponse:
 *   503 → the exact env var (LOOM_UAMI_RESOURCE_ID / AZURE_TENANT_ID / …)
 *   403 → Storage Account Contributor (17d1049b-…) or Owner on the target
 *         storage account
 * Azure-native — NO Fabric dependency (no-fabric-dependency.md).
 *
 * Learn: https://learn.microsoft.com/azure/storage/common/storage-network-security-resource-instances
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getStorageTrustedAccess,
  addStorageResourceInstance,
  removeStorageResourceInstance,
  NetworkingNotConfiguredError,
  NetworkingArmError,
} from '@/lib/clients/networking-client';
import {
  getWorkspaceUami,
  workspaceIdentityConfigGate,
  workspaceUamiName,
} from '@/lib/azure/workspace-identity-client';
import { authorizeNetworking, storageTrustedAccessErrorResponse } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An identity the Add dropdown can authorize: full ARM id + its Entra tenant. */
interface IdentityChoice {
  resourceId: string;
  tenantId: string;
  name: string;
}

/** Entra tenant the deployment's managed identities live in (rule tenantId). */
function deploymentTenantId(): string {
  const tid = (process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || '').trim();
  if (!tid) throw new NetworkingNotConfiguredError(['AZURE_TENANT_ID (or LOOM_TENANT_ID)']);
  return tid;
}

/** Console UAMI as an identity choice; null when LOOM_UAMI_RESOURCE_ID is unset. */
function consoleUamiChoice(): IdentityChoice | null {
  const rid = (process.env.LOOM_UAMI_RESOURCE_ID || '').trim();
  if (!rid) return null;
  return {
    resourceId: rid,
    tenantId: deploymentTenantId(),
    name: rid.split('/').pop() || 'console-uami',
  };
}

/** Per-workspace UAMI (uami-ws-<id>) as an identity choice; null when it does
 * not exist in ARM or the workspace-identity plane is unconfigured. Lookup
 * failures degrade to null here (the GET is informational) — POST re-resolves
 * strictly and throws the honest gate instead. */
async function workspaceIdentityChoice(workspaceId: string): Promise<IdentityChoice | null> {
  try {
    if (workspaceIdentityConfigGate()) return null;
    const uami = await getWorkspaceUami(workspaceId);
    if (!uami?.id) return null;
    return { resourceId: uami.id, tenantId: deploymentTenantId(), name: uami.name };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await authorizeNetworking(ctx);
  if (g.resp) return g.resp;
  const { id } = g;
  const storageAccountId = req.nextUrl.searchParams.get('storageAccountId')?.trim() || '';
  if (!storageAccountId) {
    return NextResponse.json({ ok: false, error: 'storageAccountId query param required' }, { status: 400 });
  }
  try {
    const [state, workspaceIdentity] = await Promise.all([
      getStorageTrustedAccess(storageAccountId),
      workspaceIdentityChoice(id),
    ]);
    let consoleUami: IdentityChoice | null = null;
    try { consoleUami = consoleUamiChoice(); } catch { consoleUami = null; }
    return NextResponse.json({
      ok: true,
      state,
      identities: { consoleUami, workspaceIdentity },
    });
  } catch (e) {
    return storageTrustedAccessErrorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await authorizeNetworking(ctx);
  if (g.resp) return g.resp;
  const { id } = g;
  const body = await req.json().catch(() => ({}));
  const storageAccountId = String(body?.storageAccountId || '').trim();
  const identity = String(body?.identity || '').trim();
  if (!storageAccountId) {
    return NextResponse.json({ ok: false, error: 'storageAccountId required' }, { status: 400 });
  }
  if (identity !== 'console-uami' && identity !== 'workspace-identity') {
    return NextResponse.json(
      { ok: false, error: "identity must be 'console-uami' or 'workspace-identity'" },
      { status: 400 },
    );
  }
  try {
    let choice: IdentityChoice;
    if (identity === 'console-uami') {
      const c = consoleUamiChoice();
      if (!c) throw new NetworkingNotConfiguredError(['LOOM_UAMI_RESOURCE_ID']);
      choice = c;
    } else {
      // Strict resolution: surface the exact missing env var / absence honestly.
      const cfgGate = workspaceIdentityConfigGate();
      if (cfgGate) throw new NetworkingNotConfiguredError([cfgGate.missing]);
      const uami = await getWorkspaceUami(id).catch((e) => {
        throw new NetworkingArmError(
          `Could not read the per-workspace identity ${workspaceUamiName(id)} from ARM: ${e instanceof Error ? e.message : String(e)}`,
          502,
        );
      });
      if (!uami?.id) {
        throw new NetworkingArmError(
          `This workspace has no per-workspace identity (${workspaceUamiName(id)} not found). ` +
          'Deploy platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep to provision one, ' +
          'or authorize the Console UAMI instead.',
          404,
        );
      }
      choice = { resourceId: uami.id, tenantId: deploymentTenantId(), name: uami.name };
    }
    const state = await addStorageResourceInstance(storageAccountId, {
      resourceId: choice.resourceId,
      tenantId: choice.tenantId,
    });
    return NextResponse.json({
      ok: true,
      state,
      added: choice,
      message:
        `Resource-instance rule added: ${choice.name} is now authorized through the storage firewall. ` +
        'It takes effect when the account is "Enabled from selected networks" with default action Deny.',
    });
  } catch (e) {
    return storageTrustedAccessErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await authorizeNetworking(ctx);
  if (g.resp) return g.resp;
  const sp = req.nextUrl.searchParams;
  const storageAccountId = sp.get('storageAccountId')?.trim() || '';
  const resourceId = sp.get('resourceId')?.trim() || '';
  const tenantId = sp.get('tenantId')?.trim() || undefined;
  if (!storageAccountId) {
    return NextResponse.json({ ok: false, error: 'storageAccountId query param required' }, { status: 400 });
  }
  if (!resourceId) {
    return NextResponse.json({ ok: false, error: 'resourceId query param required' }, { status: 400 });
  }
  try {
    const state = await removeStorageResourceInstance(storageAccountId, resourceId, tenantId);
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    return storageTrustedAccessErrorResponse(e);
  }
}

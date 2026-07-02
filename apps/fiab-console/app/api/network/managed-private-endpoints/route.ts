/**
 * Self-service MANAGED private endpoints — admin Network page (Fabric-parity
 * Phase 4 G5).
 *
 * Tenant admins create a REAL Microsoft.Network/privateEndpoints into the DLZ
 * managed-VNet PE subnet (LOOM_PE_SUBNET_ID) against ANY connectable Azure
 * resource, then track the approval lifecycle. The endpoint is created with a
 * MANUAL private-link connection so it lands **Pending** until the OWNER of the
 * target resource approves the connection (a separate ARM action on the source —
 * this route never auto-approves).
 *
 *   GET    /api/network/managed-private-endpoints
 *            → { ok, count, endpoints: ManagedPrivateEndpoint[] }
 *   GET    /api/network/managed-private-endpoints?poll=<name>
 *            → { ok, endpoint }  (re-read a single PE's live connection state)
 *   POST   /api/network/managed-private-endpoints
 *            body { targetResourceId, groupId, name, justification, armType? }
 *            → creates the PE (Pending) + honest approval next-step note
 *   DELETE /api/network/managed-private-endpoints?id=<name|arm-id>
 *            → removes the managed PE via ARM
 *
 * SECURITY: private endpoints touch the SHARED landing-zone network, so this is
 * tenant-admin gated (requireTenantAdmin) — a bare authenticated session is not
 * enough. Honest gates per no-vaporware.md / no-fabric-dependency.md flow through
 * the shared networkingErrorResponse mapper: NetworkingNotConfiguredError → 503 +
 * the exact env var to set; NetworkingArmError 401|403 → 403 naming the Network
 * Contributor role to grant the Console UAMI. Pure Azure ARM — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  listManagedPrivateEndpoints,
  createManagedPrivateEndpoint,
  deleteManagedPrivateEndpoint,
  getPrivateEndpointConnectionState,
  ensureManagedPeDnsZoneGroup,
  type ManagedPeDnsResult,
} from '@/lib/clients/networking-client';
import { networkingErrorResponse } from '@/app/api/admin/workspaces/[id]/networking/_gate';
import { ALL_PE_GROUP_IDS, normalizePrivateLinkTargetId } from '@/lib/azure/pe-subresource-groups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PrivateEndpoint name: 1-80, start/end alphanumeric or _, inner may include -.
const PE_NAME_RE = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,78}[A-Za-z0-9_])?$/;

/** Honest "approve the PE on the target resource" next-step note + portal/CLI. */
function approvalNextStep(targetResourceId: string, peName: string): {
  note: string; portalUrl: string; azCli: string;
} {
  return {
    note:
      `Managed private endpoint “${peName}” was created in a Pending state. It cannot carry ` +
      `traffic until the OWNER of the target resource APPROVES the private-endpoint connection — ` +
      `a separate ARM action on the source, not performed here. Approve it in the Azure portal ` +
      `(the resource → Networking → Private endpoint connections → Approve) or with the Azure CLI, ` +
      `then refresh the connection state here.`,
    portalUrl: `https://portal.azure.com/#@/resource${targetResourceId}/networking`,
    azCli:
      `az network private-endpoint-connection approve --id ` +
      `$(az network private-endpoint-connection list --id "${targetResourceId}" ` +
      `--query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id | [0]" -o tsv) ` +
      `--description "Approved for CSA Loom managed private endpoint"`,
  };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  const poll = req.nextUrl.searchParams.get('poll')?.trim();
  try {
    if (poll) {
      const endpoint = await getPrivateEndpointConnectionState(poll);
      if (!endpoint) {
        return NextResponse.json({ ok: false, error: 'managed private endpoint not found' }, { status: 404 });
      }
      // Once the owner has APPROVED the connection, make sure the matching
      // privatelink.* DNS zone group is attached — without it the endpoint
      // never resolves privately even though the connection is live.
      if ((endpoint.connectionState || '').toLowerCase() === 'approved') {
        try {
          const dns = await ensureManagedPeDnsZoneGroup(
            endpoint.name,
            (endpoint.groupIds || [])[0] || '',
            endpoint.privateLinkServiceId,
          );
          endpoint.dnsRegistered = dns.registered;
          endpoint.dnsZoneName = dns.zoneName;
          endpoint.dnsNote = dns.note;
        } catch (e) {
          endpoint.dnsRegistered = false;
          endpoint.dnsNote = `Private DNS registration failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return NextResponse.json({ ok: true, endpoint });
    }
    const endpoints = await listManagedPrivateEndpoints();
    return NextResponse.json({ ok: true, count: endpoints.length, endpoints });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const targetResourceIdRaw = String(body?.targetResourceId || '').trim();
  const armType = typeof body?.armType === 'string' ? body.armType : undefined;
  const groupId = String(body?.groupId || '').trim();
  const name = String(body?.name || '').trim();
  const justification = String(body?.justification || '').trim();

  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!PE_NAME_RE.test(name)) {
    return NextResponse.json(
      { ok: false, error: 'name must be 1-80 chars: letters, digits, _ or - (start/end alphanumeric or _)' },
      { status: 400 },
    );
  }
  const target = normalizePrivateLinkTargetId(targetResourceIdRaw, armType);
  if (!target.startsWith('/subscriptions/')) {
    return NextResponse.json(
      { ok: false, error: 'targetResourceId must be the full ARM id of the target resource (/subscriptions/…)' },
      { status: 400 },
    );
  }
  if (!groupId) {
    return NextResponse.json(
      { ok: false, error: 'groupId (sub-resource) is required (e.g. blob, dfs, sqlServer, vault, namespace)' },
      { status: 400 },
    );
  }
  if (!ALL_PE_GROUP_IDS.includes(groupId)) {
    return NextResponse.json(
      { ok: false, error: `unknown groupId “${groupId}”. Expected one of: ${ALL_PE_GROUP_IDS.join(', ')}` },
      { status: 400 },
    );
  }
  if (!justification) {
    return NextResponse.json(
      { ok: false, error: 'justification is required — it is sent to the target owner as the approval request message' },
      { status: 400 },
    );
  }

  try {
    const endpoint = await createManagedPrivateEndpoint({
      name,
      targetResourceId: target,
      armType,
      groupId,
      justification,
      createdBy: session!.claims.oid,
    });
    // Register the PE FQDN in the matching privatelink.* private DNS zone right
    // away (best-effort) — without a privateDnsZoneGroups config the endpoint
    // never resolves, even after approval. A transient failure here is retried
    // automatically on the ?poll path once the connection shows Approved.
    let dns: ManagedPeDnsResult;
    try {
      dns = await ensureManagedPeDnsZoneGroup(endpoint.name, groupId, target);
    } catch (e) {
      dns = {
        registered: false,
        note: `Private DNS zone group not attached yet (${e instanceof Error ? e.message : String(e)}) — it is retried automatically when you refresh the endpoint after approval.`,
      };
    }
    endpoint.dnsRegistered = dns.registered;
    endpoint.dnsZoneName = dns.zoneName;
    endpoint.dnsNote = dns.note;
    const nextStep = approvalNextStep(target, endpoint.name);
    const message = dns.registered
      ? `${nextStep.note} Private DNS: registered in ${dns.zoneName}.`
      : `${nextStep.note} Private DNS: ${dns.note || 'not registered yet.'}`;
    return NextResponse.json({ ok: true, endpoint, dns, nextStep, message });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  const raw =
    req.nextUrl.searchParams.get('id')?.trim() ||
    req.nextUrl.searchParams.get('name')?.trim() ||
    '';
  if (!raw) {
    return NextResponse.json(
      { ok: false, error: 'id (managed private endpoint name or ARM id) query param is required' },
      { status: 400 },
    );
  }
  // Accept either the bare name or the full ARM id (delete is by name).
  const name = raw.startsWith('/subscriptions/') ? (raw.split('/').pop() || raw) : raw;
  try {
    await deleteManagedPrivateEndpoint(name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

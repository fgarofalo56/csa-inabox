import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import { applyWorkspaceBindings } from '@/lib/azure/workspace-bindings';
import { domainExists } from '@/lib/azure/domain-registry';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const tenantId = session.claims.oid;
  const withCount = req.nextUrl?.searchParams.get('count') === 'true';
  try {
    const c = await workspacesContainer();
    const { resources } = await c.items
      .query<Workspace>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
        parameters: [{ name: '@t', value: tenantId }],
      }, { partitionKey: tenantId })
      .fetchAll();
    if (!withCount || resources.length === 0) return NextResponse.json(resources);

    // ?count=true — aggregate item counts grouped by workspaceId. Cross-
    // partition query on the items container, filtered to workspace ids
    // owned by this tenant. Cheap because we only project workspaceId.
    try {
      const ids = resources.map(w => w.id);
      const items = await itemsContainer();
      // Build IN clause params: @w0, @w1, ...
      const inParams = ids.map((id, i) => ({ name: `@w${i}`, value: id }));
      const inExpr = inParams.map(p => p.name).join(',');
      const { resources: countRows } = await items.items
        .query<{ workspaceId: string; n: number }>({
          query: `SELECT c.workspaceId, COUNT(1) AS n FROM c WHERE c.workspaceId IN (${inExpr}) GROUP BY c.workspaceId`,
          parameters: inParams,
        })
        .fetchAll();
      const counts = new Map<string, number>();
      for (const row of countRows) counts.set(row.workspaceId, row.n ?? 0);
      const enriched = resources.map(w => ({ ...w, itemCount: counts.get(w.id) ?? 0 }));
      return NextResponse.json(enriched);
    } catch {
      // If the aggregate fails (e.g., RU limit), return the unenriched list.
      return NextResponse.json(resources);
    }
  } catch (e: any) {
    return err(e?.message || 'Failed to list workspaces', 500, 'cosmos_error');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  const { name, description, capacity, domain } = body || {};
  if (!name || typeof name !== 'string') return err('name is required', 400, 'missing_name');

  // A workspace MUST be bound to a governance domain (t158). The domain must
  // exist in this tenant's registry; the `default` starter domain is the
  // guaranteed fallback (seeded on first read).
  const domainId = typeof domain === 'string' ? domain.trim() : '';
  if (!domainId) return err('domain is required — pick the governance domain this workspace belongs to', 400, 'domain_required');
  if (!(await domainExists(session.claims.oid, domainId))) {
    return err(`Unknown domain '${domainId}' — it is not registered in this tenant.`, 400, 'unknown_domain');
  }

  const now = new Date().toISOString();
  const ws: Workspace = {
    id: crypto.randomUUID(),
    tenantId: session.claims.oid,
    name: name.trim(),
    description: description?.trim() || undefined,
    capacity: capacity?.trim() || undefined,
    domain: domainId,
    createdBy: session.claims.upn || session.claims.email || session.claims.oid,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const c = await workspacesContainer();
    const { resource } = await c.items.create<Workspace>(ws);
    if (!resource) {
      return err('Cosmos returned no resource on create', 500, 'cosmos_no_resource');
    }
    // Best-effort side-effects: assign-to-capacity + Purview register +
    // marketplace publish. Never blocks the create — outcome captured
    // into status fields on the workspace doc and replaced.
    let merged: Workspace = resource;
    if (capacity || domain) {
      try {
        const bindings = await applyWorkspaceBindings(resource);
        merged = {
          ...resource,
          ...(bindings.capacityAssignment ? { capacityAssignment: bindings.capacityAssignment } : {}),
          ...(bindings.domainRegistration ? { domainRegistration: bindings.domainRegistration } : {}),
          updatedAt: new Date().toISOString(),
        };
        try {
          await c.item(merged.id, merged.tenantId).replace(merged);
        } catch {
          // Race / partition issue — keep the original resource; the UI will
          // re-fetch and show the next state.
        }
      } catch {
        // applyWorkspaceBindings should never throw, but fail-safe.
      }
    }
    void upsertLoomDoc(docForWorkspace(merged));
    return NextResponse.json(merged, { status: 201 });
  } catch (e: any) {
    return err(e?.message || 'Failed to create workspace', 500, 'cosmos_error');
  }
}

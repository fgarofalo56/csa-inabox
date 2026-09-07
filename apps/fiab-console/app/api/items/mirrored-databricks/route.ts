/**
 * Mirrored Databricks list + create (audit H8).
 *
 * The Fabric REST type is MirroredAzureDatabricksCatalog. A "mirror" mounts a
 * Databricks Unity Catalog so its tables are queryable elsewhere. Per
 * .claude/rules/no-fabric-dependency.md + no-vaporware.md, create does the REAL
 * mount work on the Azure-native path — it does NOT just write a config doc:
 *
 *   1. Validate the UC source against the live Databricks REST surface and
 *      resolve the catalog's queryable Delta tables + their ADLS storage
 *      locations (resolveUcMirrorTables).
 *   2. Pair a `synapse-serverless-sql-pool` item + run its provisioner so the
 *      mounted catalog is QUERYABLE in Loom as T-SQL (one OPENROWSET
 *      FORMAT='delta' view per UC table over the table's own abfss location).
 *      This is the Azure-native "shortcut" — no Microsoft Fabric / OneLake.
 *
 * If a prerequisite is missing (Databricks not configured, no queryable Delta
 * tables, Synapse not configured) the mirror is still created but the response
 * reports `ok:false` with `created:true` — no silent config-doc-only success
 * (#4183). A caller that only reads the envelope's `ok` therefore learns the
 * truth ("the mirror is not queryable") without having to reach into
 * `pairing.ok`; a caller that wants to keep the created mirror branches on
 * `created`. `gateId` names the gate-registry entry so the UI can render a
 * Fix-it (ux-baseline G2) rather than prose the operator must act on by hand.
 *
 * HTTP stays 200 for a failed pairing on purpose: the mirror item WAS created
 * and is readable, so a 4xx/5xx would misdescribe the server's own outcome.
 */
import { NextRequest, NextResponse } from 'next/server';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { resolveUcMirrorTables } from '@/lib/azure/databricks-uc-mirror';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { synapseSqlPoolProvisioner } from '@/lib/install/provisioners/synapse-serverless-sql-pool';
import { resolveTarget } from '@/lib/install/provisioning-engine';
import { apiError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

/**
 * Gate-registry id per pairing failure code, so the editor can render a Fix-it
 * instead of asking the operator to go set an env var by hand (ux-baseline G2,
 * auto-bind-by-default §5). A code with no registry entry yields `undefined` —
 * the response then carries the honest reason with no Fix-it claim attached,
 * rather than naming a gate that does not exist (deploy-integrity R7).
 */
const PAIRING_GATE_ID: Record<string, string | undefined> = {
  NO_DATABRICKS: 'svc-databricks',
  NO_SYNAPSE: 'svc-synapse',
};

/**
 * The mirror item was created but is NOT queryable. Report that as `ok:false`
 * with `created:true` (#4183) — HTTP 200 because the create itself succeeded.
 */
function pairingFailed(mirror: unknown, pairing: Record<string, unknown>) {
  const code = typeof pairing.code === 'string' ? pairing.code : undefined;
  return NextResponse.json({
    ok: false,
    created: true,
    code,
    error: typeof pairing.gate === 'string' ? pairing.gate : 'mirror is not queryable',
    ...(code && PAIRING_GATE_ID[code] ? { gateId: PAIRING_GATE_ID[code] } : {}),
    mirror,
    pairing,
  });
}

// Route-toolkit: withSession (R1/R3) — the 401 prologue and the
// try/catch → apiServerError wrapper come from the toolkit, not hand-rolled.
export const GET = withSession(async (req: NextRequest, { session: s }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const ws = await loadWs(workspaceId, s.claims.oid);
  if (!ws) return err('workspace not found', 404);
  const items = await itemsContainer();
  const { resources } = await items.items.query<WorkspaceItem>({
    query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
    parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'mirrored-databricks' }],
  }, { partitionKey: workspaceId }).fetchAll();
  return NextResponse.json({
    ok: true, workspaceId,
    mirrors: resources.map(r => ({
      id: r.id, displayName: r.displayName, description: r.description,
      catalogName: (r.state as any)?.catalogName,
      hostname: (r.state as any)?.hostname,
      sqlItemId: (r.state as any)?.sqlItemId,
      sqlDatabase: (r.state as any)?.sqlDatabase,
      sqlEndpoint: (r.state as any)?.sqlEndpoint,
      viewCount: (r.state as any)?.viewCount,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
  });
});

// Route-toolkit: withSession (R1/R3).
export const POST = withSession(async (req: NextRequest, { session: s }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  const catalogName = String(body?.catalogName || '').trim();
  if (!displayName) return err('displayName required', 400);
  if (!catalogName) return err('catalogName required', 400);
  // Optional explicit table subset [{schema,table}] (else: whole catalog).
  const tableSubset = Array.isArray(body?.tables)
    ? body.tables
        .map((t: any) => ({ schema: String(t?.schema || '').trim(), table: String(t?.table || '').trim() }))
        .filter((t: any) => t.schema && t.table)
    : undefined;

  {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();

    // 1. Create the mirror item (config doc) first.
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'mirrored-databricks',
      displayName, description: body?.description,
      state: {
        catalogName,
        hostname: body?.hostname || process.env.LOOM_DATABRICKS_HOSTNAME || null,
        mirrorMode: body?.mirrorMode || 'AllTables',
        ...(tableSubset && tableSubset.length ? { tables: tableSubset } : {}),
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource: created } = await items.items.create(item);

    // 2. Resolve the catalog's queryable Delta tables (real Databricks REST).
    const resolved = await resolveUcMirrorTables(catalogName, { tableSubset });
    const pairing: Record<string, unknown> = {
      tablesResolved: resolved.tables.length,
      tablesSkipped: resolved.skipped,
    };

    if (!resolved.ok) {
      // Honest gate — mirror exists but is not yet queryable. Name the exact
      // requirement; do NOT report a silent success.
      pairing.ok = false;
      pairing.code = resolved.code;
      // `resolved.error` already names the specific missing variable that
      // databricksConfigGate() found; the previous unconditional string
      // asserted LOOM_DATABRICKS_HOSTNAME for every NO_DATABRICKS, which is a
      // claim this code did not establish (deploy-integrity R7).
      pairing.gate =
        resolved.code === 'NO_DATABRICKS'
          ? `${resolved.error || 'Databricks workspace not configured.'} A default deploy wires this from ` +
            'the Databricks module (platform/fiab/bicep/main.bicep, deDatabricksEnabled defaults true), so an ' +
            'unset value means Databricks was opted out at deploy time or this is a brownfield estate — not a ' +
            'step every install must perform by hand. No Fabric required.'
          : resolved.error ||
            `Catalog "${catalogName}" has no queryable Delta tables with a resolvable ADLS storage location.`;
      return pairingFailed(created, pairing);
    }

    // 3. Pair + provision a Synapse Serverless SQL endpoint over the UC Delta
    //    tables (the Azure-native "shortcut" that makes the catalog queryable).
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      pairing.ok = false;
      pairing.code = 'NO_SYNAPSE';
      pairing.gate =
        'Unity Catalog validated (' + resolved.tables.length + ' Delta table(s)), but no Synapse Serverless ' +
        'workspace is configured to serve them. Set LOOM_SYNAPSE_WORKSPACE (the synapseServerlessSqlEndpoint output ' +
        'of landing-zone/synapse.bicep) and grant the Console UAMI Synapse SQL admin. No Fabric required.';
      return pairingFailed(created, pairing);
    }

    const pairedName = `${displayName} SQL Analytics`;
    const pairedContent = {
      databricksMirrorItemId: created!.id,
      databricksMirrorName: displayName,
      ucCatalogName: catalogName,
      ucTables: resolved.tables,
    };
    const createdPair = await createOwnedItem(s, 'synapse-serverless-sql-pool', {
      workspaceId,
      displayName: pairedName,
      state: { content: pairedContent },
    });
    if (!createdPair.ok) {
      pairing.ok = false;
      pairing.code = 'PAIR_CREATE_FAILED';
      pairing.gate = createdPair.error;
      return pairingFailed(created, pairing);
    }

    const result = await synapseSqlPoolProvisioner({
      session: s,
      target: resolveTarget('shared'),
      cosmosItemId: createdPair.item.id,
      workspaceId,
      displayName: pairedName,
      content: pairedContent,
      appId: 'mirrored-databricks',
    });

    pairing.ok = result.status === 'created' || result.status === 'exists';
    pairing.status = result.status;
    pairing.steps = result.steps;
    if (result.gate) pairing.gate = result.gate.remediation;
    if (result.error) pairing.error = result.error;

    // Record the pairing on the mirror item so the editor + sql-endpoint route
    // can deep-link the endpoint without re-deriving it.
    if (pairing.ok) {
      const refreshed: WorkspaceItem = {
        ...created!,
        state: {
          ...(created!.state as Record<string, unknown>),
          sqlItemId: createdPair.item.id,
          sqlDatabase: result.secondaryIds?.database,
          sqlEndpoint: result.secondaryIds?.endpoint,
          viewCount: result.secondaryIds?.viewCount,
          pairedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };
      await items.item(created!.id, workspaceId).replace(refreshed);
      return NextResponse.json({ ok: true, created: true, mirror: refreshed, pairing });
    }

    // The provisioner ran and did not reach created/exists: same shape as the
    // three prerequisite gates above — the mirror exists, the catalog is not
    // queryable, so the envelope says so rather than reporting ok:true (#4183).
    return pairingFailed(created, pairing);
  }
});

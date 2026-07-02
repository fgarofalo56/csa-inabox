/**
 * Shared helpers for the Loom Marketplace "Data shares" (Delta Sharing) BFF.
 *
 * Every route is a thin authenticated wrapper over the Unity Catalog Delta
 * Sharing REST (shares / recipients / providers). A deployment with no
 * Databricks workspace bound (LOOM_DATABRICKS_HOSTNAMES unset and no Cosmos
 * metastore registration) returns a structured 501 the UI renders as an honest
 * MessageBar — per no-vaporware.md the surface still renders behind the gate.
 *
 * No-fabric-dependency: Delta Sharing is an Azure Databricks (Unity Catalog)
 * feature, not a Microsoft Fabric one — gating on a Databricks workspace is a
 * legitimate Azure infra gate, not a Fabric dependency.
 */
import { NextResponse } from 'next/server';
import {
  resolveWorkspaceHostnames,
  UnityCatalogNotConfiguredError,
  UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';

/** Resolve the workspace host to operate the share/recipient/provider on.
 *  Honors an explicit `?host=` (must be one of the known hosts), else uses the
 *  first resolved (primary) metastore-bound workspace. Throws the typed
 *  NotConfigured error when nothing is bound so {@link sharingErrorResponse}
 *  can render the gate. */
export async function resolveShareHost(explicit?: string | null): Promise<string> {
  const hosts = await resolveWorkspaceHostnames(); // throws NotConfigured when none
  if (explicit) {
    const norm = explicit.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (hosts.includes(norm)) return norm;
    throw new UnityCatalogError(`Unknown Databricks workspace host: ${norm}`, 400);
  }
  if (hosts.length === 0) {
    throw new UnityCatalogNotConfiguredError({
      missingEnvVar: 'LOOM_DATABRICKS_HOSTNAMES',
      bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
      bicepStatus: 'A Databricks workspace with a Unity Catalog metastore must be bound.',
      followUp: 'Bind a Databricks workspace to enable Delta Sharing (publish + subscribe to data shares).',
    });
  }
  return hosts[0];
}

/** Map a thrown error to the right JSON response. NotConfigured → 501 gate
 *  (with the precise remediation hint); a Databricks REST error that signals
 *  Delta Sharing is disabled on the metastore → 501 gate; everything else →
 *  its own status. */
export function sharingErrorResponse(e: any): NextResponse {
  if (e instanceof UnityCatalogNotConfiguredError) {
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        error: e.message,
        hint: e.hint?.followUp,
        missing: e.hint?.missingEnvVar,
        bicepModule: e.hint?.bicepModule,
      },
      { status: 501 },
    );
  }
  const msg = String(e?.message || e);
  // Delta Sharing not enabled on the metastore, or the UAMI lacks a metastore
  // sharing privilege (CREATE SHARE / RECIPIENT / PROVIDER) — both are honest
  // infra gates. Match Databricks' phrasings: "delta sharing is not enabled",
  // "User does not have CREATE SHARE on Metastore '…'", "is not a metastore admin".
  if (
    /delta.?sharing|not enabled|sharing is disabled|CREATE[ _](SHARE|RECIPIENT|PROVIDER)|does not have .*(SHARE|RECIPIENT|PROVIDER)|metastore admin|on Metastore|PERMISSION_DENIED|not authorized|does not have permission/i.test(
      msg,
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        error: `Delta Sharing publishing is unavailable: ${msg}`,
        hint:
          'Grant the Loom Console UAMI the FULL Unity Catalog metastore sharing privilege set — CREATE PROVIDER (register an inbound share from an activation file), CREATE CATALOG (subscribe = create a catalog from the share so you can query it), CREATE SHARE + CREATE RECIPIENT (publish outbound) — or make it a metastore admin. A Databricks metastore admin runs scripts/csa-loom/grant-databricks-delta-sharing.sh (or `GRANT CREATE PROVIDER/CATALOG/SHARE/RECIPIENT ON METASTORE TO `<uami>``); the UAMI cannot grant itself. The push-button day-one bootstrap applies these automatically (csa-loom-post-deploy-bootstrap "Grant Databricks Delta Sharing"). After subscribing, query the new catalog from a Databricks SQL warehouse (set LOOM_DATABRICKS_SQL_WAREHOUSE_ID) or a Databricks notebook.',
      },
      { status: 501 },
    );
  }
  return NextResponse.json(
    { ok: false, error: msg, body: e?.body, endpoint: e?.endpoint },
    { status: typeof e?.status === 'number' ? e.status : 500 },
  );
}

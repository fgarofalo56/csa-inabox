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
  // Delta Sharing not enabled on the metastore, or the UAMI lacks the metastore
  // CREATE_SHARE / sharing-admin privilege — both are honest infra gates.
  if (
    /delta.?sharing|not enabled|sharing is disabled|CREATE_SHARE|metastore admin|PERMISSION_DENIED|not authorized/i.test(
      msg,
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        error: `Delta Sharing is unavailable on this metastore: ${msg}`,
        hint:
          'Enable Delta Sharing on the Unity Catalog metastore and grant the Loom Console UAMI the metastore-admin / CREATE_SHARE + CREATE_RECIPIENT privileges (Databricks account console → metastore → Delta Sharing). See scripts/csa-loom/grant-databricks-system-tables-role.sh for the grant pattern.',
      },
      { status: 501 },
    );
  }
  return NextResponse.json(
    { ok: false, error: msg, body: e?.body, endpoint: e?.endpoint },
    { status: typeof e?.status === 'number' ? e.status : 500 },
  );
}

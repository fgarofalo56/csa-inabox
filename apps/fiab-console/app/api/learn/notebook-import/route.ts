/**
 * Learning-Hub notebook import.
 *
 * GET  /api/learn/notebook-import
 *   → { ok, notebooks: NotebookImportOption[] }
 *   Lists every prebuilt notebook across the in-process app bundles, flagging
 *   which bundles can also seed real ADLS sample data.
 *
 * POST /api/learn/notebook-import
 *   Body: {
 *     workspaceId: string,           // caller-owned workspace
 *     bundleId: string,              // owning app bundle (e.g. 'app-ml-pipeline')
 *     notebookDisplayName?: string,  // which notebook (defaults to first in bundle)
 *     withSampleData: boolean,       // also seed the bundle's lakehouse(s) into ADLS Delta
 *   }
 *   Creates the chosen prebuilt notebook as a real Cosmos workspace item
 *   (populated cells), then runs the EXISTING provisioning engine which
 *   dispatches the notebook provisioner (Synapse Spark → Databricks →
 *   Fabric-opt-in, Azure-native default). When withSampleData is true, the
 *   bundle's sample-data lakehouse item(s) are created + provisioned too, so
 *   the lakehouse provisioner writes the real sampleRows CSVs into the DLZ
 *   ADLS Gen2 container (no Fabric required).
 *
 *   → { ok, workspaceId, bundleId, withSampleData, installed[], provision }
 *
 * This route adds NO new env vars: it consumes LOOM_SYNAPSE_WORKSPACE /
 * LOOM_DATABRICKS_HOSTNAME / LOOM_ADLS_* / LOOM_*_URL already emitted by the
 * DLZ + admin-plane bicep and read in resolveTarget(). When neither a Synapse
 * nor Databricks engine (nor an opted-in Fabric workspace) is configured, the
 * notebook provisioner returns an honest remediation gate — never a Fabric
 * hard-dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getBundle, getBundleNotebooks, getSampleDataLakehouses, listNotebookImports,
} from '@/lib/apps/content-bundles';
import { runProvisioning, type ProvisionReport } from '@/lib/install/provisioning-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return NextResponse.json({ ok: true, notebooks: await listNotebookImports() });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  const bundleId = (body?.bundleId || '').toString().trim();
  const notebookDisplayName = (body?.notebookDisplayName || '').toString().trim() || undefined;
  const withSampleData = body?.withSampleData === true;

  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  if (!bundleId) return NextResponse.json({ ok: false, error: 'bundleId required' }, { status: 400 });

  // Verify the caller owns the workspace (same check as the app-install route).
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, s.claims.oid).read<any>();
    if (!resource || resource.tenantId !== s.claims.oid) {
      return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    }
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    throw e;
  }

  const bundle = await getBundle(bundleId);
  if (!bundle) return NextResponse.json({ ok: false, error: `bundle '${bundleId}' not found` }, { status: 404 });

  // Resolve the exact prebuilt notebook (no first-of-type fallback — the
  // wizard always passes the displayName when a bundle has more than one).
  const candidates = await getBundleNotebooks(bundleId, notebookDisplayName);
  const chosen = candidates[0] || (await getBundleNotebooks(bundleId))[0];
  if (!chosen) {
    return NextResponse.json(
      { ok: false, error: `bundle '${bundleId}' has no prebuilt notebook` },
      { status: 404 },
    );
  }

  const items = await itemsContainer();

  // 1. Create the notebook as a real workspace item, projecting NotebookContent
  //    cells into the editor's read shape (state.cells / state.defaultLang) so
  //    the notebook opens fully populated — mirrors the app-install route.
  const displayName = chosen.displayName;
  const state: Record<string, unknown> = {
    sourceApp: bundle.appId,
    sourceLearnImport: true,
    content: chosen.content,
  };
  const nbc = chosen.content as { kind?: string; cells?: unknown[]; defaultLang?: string } | undefined;
  if (nbc?.kind === 'notebook' && Array.isArray(nbc.cells) && nbc.cells.length > 0) {
    state.cells = nbc.cells;
    state.defaultLang = nbc.defaultLang || 'pyspark';
  }

  const installed: Array<{ itemType: string; id?: string; displayName: string; content?: unknown }> = [];

  const createdNb = await createOwnedItem(s, chosen.itemType, {
    workspaceId,
    displayName,
    description: chosen.description || `Imported notebook from ${bundle.appId}`,
    state,
  });
  if (!createdNb.ok) {
    return NextResponse.json({ ok: false, error: createdNb.error }, { status: createdNb.status });
  }
  installed.push({ itemType: chosen.itemType, id: createdNb.item.id, displayName, content: chosen.content });

  // 2. When the user chose "with sample data", also create + provision the
  //    bundle's sample-data lakehouse(s). The lakehouse provisioner's
  //    Azure-native path writes the real sampleRows as CSVs to the DLZ ADLS
  //    Gen2 container (no Fabric). Without sample data, only the notebook is
  //    provisioned — nothing touches ADLS.
  if (withSampleData) {
    for (const lh of await getSampleDataLakehouses(bundleId)) {
      const created = await createOwnedItem(s, lh.itemType, {
        workspaceId,
        displayName: lh.displayName,
        description: lh.description || `Sample-data lakehouse from ${bundle.appId}`,
        state: { sourceApp: bundle.appId, sourceLearnImport: true, content: lh.content },
      });
      if (created.ok) {
        installed.push({ itemType: lh.itemType, id: created.item.id, displayName: lh.displayName, content: lh.content });
      } else {
        installed.push({ itemType: lh.itemType, displayName: lh.displayName, content: lh.content });
      }
    }

    // Auto-attach the seeded lakehouse(s) to the notebook so it opens with its
    // data sources wired — mirrors the app-install route's attach pass.
    try {
      const lakehouses = installed
        .filter((i) => i.itemType === 'lakehouse' && i.id)
        .map((i, idx) => ({ kind: 'lakehouse' as const, id: i.id!, displayName: i.displayName, isDefault: idx === 0 }));
      if (lakehouses.length > 0) {
        const { resource } = await items.item(createdNb.item.id, workspaceId).read<any>();
        if (resource) {
          resource.state = { ...(resource.state || {}), attachedSources: lakehouses };
          await items.item(createdNb.item.id, workspaceId).replace(resource);
        }
      }
    } catch { /* best-effort attach */ }
  }

  // 3. Run the existing provisioning engine — dispatches notebookProvisioner
  //    (+ lakehouseProvisioner when seeding). Azure-native default; Fabric is
  //    opt-in only inside the provisioners.
  let provision: ProvisionReport | undefined;
  try {
    provision = await runProvisioning(
      s,
      bundle.appId,
      workspaceId,
      installed.filter((i) => i.id),
      { deploy: true, mode: 'shared' },
    );

    // Stamp each Cosmos item with its provisioning result so the editor shows
    // "Backed by …" rather than an empty canvas (best-effort, like install).
    for (const step of provision.steps) {
      if (!step.cosmosItemId) continue;
      try {
        const { resource: cur } = await items.item(step.cosmosItemId, workspaceId).read<any>();
        if (!cur) continue;
        const nextState: Record<string, unknown> = {
          ...(cur.state || {}),
          provisioning: {
            status: step.result.status,
            resourceId: step.result.resourceId,
            secondaryIds: step.result.secondaryIds,
            gate: step.result.gate,
            error: step.result.error,
            mode: 'shared',
            at: new Date().toISOString(),
          },
        };
        await items.item(step.cosmosItemId, workspaceId).replace({ ...cur, state: nextState, updatedAt: new Date().toISOString() });
      } catch { /* swallow — provisioning record is best-effort */ }
    }
  } catch (e: any) {
    provision = {
      outcome: 'partial',
      mode: 'shared',
      target: { mode: 'shared' },
      steps: installed.map((it) => ({
        itemType: it.itemType,
        displayName: it.displayName,
        cosmosItemId: it.id || '',
        result: { status: 'failed', error: e?.message || String(e), steps: [] },
      })),
    };
  }

  return NextResponse.json({
    ok: true,
    workspaceId,
    bundleId: bundle.appId,
    withSampleData,
    installed: installed.map((i) => ({ itemType: i.itemType, id: i.id, displayName: i.displayName })),
    provision,
  });
}

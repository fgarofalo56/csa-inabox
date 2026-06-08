/**
 * /api/admin/batch-labeling — bulk apply a sensitivity label to many catalog
 * items at once.
 *
 * GET  → everything the admin page needs to render:
 *        { ok, items[], loomLabels[], mipLabels[]|null, mipConfigured,
 *          purviewConfigured, pbiAdminConfigured }
 *
 * POST → apply one label to the selected items.
 *        body: {
 *          items: { id, workspaceId }[],          // required
 *          labelName: string,                      // display name written to Cosmos
 *          labelId?: string,                       // MIP GUID (for PBI + Cosmos id field)
 *          applyToPurview?: boolean,               // opt-in Purview classification
 *          applyToPowerBi?: boolean,               // opt-in PBI Admin setLabels
 *        }
 *        → { ok, results: ResultRow[] }
 *
 * Backends:
 *   - Cosmos (ALWAYS): writes state.sensitivityLabel (+ sensitivityLabelId,
 *     labeledAt, labeledBy) onto each workspace-item doc. This IS the
 *     label-assignment record. Real item.replace() — no fake success.
 *   - Purview (opt-in, gated by LOOM_PURVIEW_ACCOUNT): matches the item to a
 *     catalog asset by name and stamps the label as an Atlas classification.
 *   - Power BI Admin setLabels (opt-in, gated by LOOM_POWERBI_ADMIN_LABELS +
 *     a real MIP label GUID): propagates the label to the linked PBI artifact.
 *
 * Every status is the real outcome of the backend call. No row is reported
 * "Succeeded" unless the underlying write returned without error.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { listSensitivityLabels, MipNotConfiguredError } from '@/lib/azure/mip-graph-client';
import {
  setLabelsAsAdmin,
  type PbiArtifactType,
  type PbiSetLabelArtifacts,
  type PbiLabelChangeStatus,
} from '@/lib/azure/powerbi-client';
import {
  isPurviewConfigured,
  searchPurview,
  ensureClassificationDefs,
  addAssetClassification,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LoomLabelDoc { id: string; name: string; color: string; protectionNote?: string }

async function loadLoomLabels(tenantId: string): Promise<LoomLabelDoc[]> {
  const c = await tenantSettingsContainer();
  const docId = `sensitivity-labels:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<{ labels?: LoomLabelDoc[] }>();
    return resource?.labels || [];
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

/** Resolve the linked Power BI artifact (id + type) from an item's state, if any. */
function extractPbiArtifact(item: any): { pbiArtifactId?: string; pbiArtifactType?: PbiArtifactType } {
  const st = item?.state || {};
  switch (item?.itemType) {
    case 'semantic-model':
      return { pbiArtifactId: st.datasetId || st.pbiDatasetId, pbiArtifactType: 'datasets' };
    case 'report':
    case 'paginated-report':
      return { pbiArtifactId: st.reportId || st.pbiReportId, pbiArtifactType: 'reports' };
    case 'dashboard':
      return { pbiArtifactId: st.dashboardId || st.pbiDashboardId, pbiArtifactType: 'dashboards' };
    case 'dataflow':
      return { pbiArtifactId: st.objectId || st.dataflowId || st.pbiDataflowId, pbiArtifactType: 'dataflows' };
    default:
      return {};
  }
}

// ============================================================
// GET — render data
// ============================================================

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;

  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();

    const wsName = new Map(workspaces.map((w: any) => [w.id, w.name]));
    const wsIds = Array.from(wsName.keys());

    let items: any[] = [];
    if (wsIds.length > 0) {
      const { resources } = await itC.items.query({
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
        parameters: [{ name: '@w', value: wsIds }],
      }).fetchAll();
      items = resources;
    }

    const mappedItems = items.map((i: any) => {
      const pbi = extractPbiArtifact(i);
      return {
        id: i.id,
        workspaceId: i.workspaceId,
        workspaceName: wsName.get(i.workspaceId) || i.workspaceId,
        itemType: i.itemType,
        displayName: i.displayName,
        sensitivity: i.state?.sensitivityLabel || null,
        pbiArtifactId: pbi.pbiArtifactId || null,
        pbiArtifactType: pbi.pbiArtifactType || null,
      };
    }).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

    const loomLabels = await loadLoomLabels(tenantId);

    let mipLabels: any[] | null = null;
    let mipConfigured = false;
    try {
      mipLabels = await listSensitivityLabels();
      mipConfigured = true;
    } catch (e) {
      if (!(e instanceof MipNotConfiguredError)) {
        // A real Graph error (e.g. 403 missing AppRole) — surface it as a
        // configured-but-failing signal rather than hiding it. The page shows
        // a warning; Loom-native labels still work.
        mipConfigured = process.env.LOOM_MIP_ENABLED === 'true';
        mipLabels = null;
      }
    }

    return NextResponse.json({
      ok: true,
      items: mappedItems,
      loomLabels: loomLabels.map((l) => ({ id: l.id, name: l.name, color: l.color, protectionNote: l.protectionNote })),
      mipLabels: mipLabels
        ? mipLabels.map((l: any) => ({ id: l.id, name: l.name || l.displayName, color: l.color, isMipGuid: GUID_RE.test(l.id || '') }))
        : null,
      mipConfigured,
      purviewConfigured: isPurviewConfigured(),
      pbiAdminConfigured: process.env.LOOM_POWERBI_ADMIN_LABELS === 'true',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

// ============================================================
// POST — apply label
// ============================================================

interface ResultRow {
  id: string;
  displayName: string;
  itemType: string;
  cosmosStatus: string;            // 'Succeeded' | error message
  purviewStatus?: string;          // 'Succeeded' | 'NotFound' | 'Skipped' | error
  pbiArtifactId?: string;
  pbiStatus?: PbiLabelChangeStatus | 'Skipped';
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const rawItems: Array<{ id: string; workspaceId: string }> = Array.isArray(body?.items) ? body.items : [];
  const labelName = (body?.labelName || '').toString().trim();
  const labelId = body?.labelId ? body.labelId.toString().trim() : undefined;
  const applyToPurview = body?.applyToPurview === true;
  const applyToPowerBi = body?.applyToPowerBi === true;

  if (!rawItems.length) return NextResponse.json({ ok: false, error: 'items[] is required' }, { status: 400 });
  if (!labelName) return NextResponse.json({ ok: false, error: 'labelName is required' }, { status: 400 });
  if (rawItems.length > 2000) {
    return NextResponse.json({ ok: false, error: 'A single batch is limited to 2000 items.' }, { status: 400 });
  }

  const who = s.claims.upn || s.claims.oid;
  const labeledAt = new Date().toISOString();
  const isMipGuid = !!labelId && GUID_RE.test(labelId);

  const purviewOn = applyToPurview && isPurviewConfigured();
  const pbiOn = applyToPowerBi && isMipGuid && process.env.LOOM_POWERBI_ADMIN_LABELS === 'true';

  const itC = await itemsContainer();
  const results: ResultRow[] = [];

  // Ensure the classification typedef exists once (best-effort) before we stamp
  // it onto assets. If this fails, per-item Purview writes report the error.
  if (purviewOn) {
    try { await ensureClassificationDefs([labelName]); } catch { /* surfaced per item below */ }
  }

  // ----- Phase A: Cosmos (always) + Phase B: Purview (opt-in) -----
  for (const ref of rawItems) {
    const id = (ref?.id || '').toString();
    const workspaceId = (ref?.workspaceId || '').toString();
    const row: ResultRow = { id, displayName: id, itemType: '', cosmosStatus: 'Succeeded' };

    let itemDoc: any = null;
    try {
      const { resource } = await itC.item(id, workspaceId).read<any>();
      if (!resource) { row.cosmosStatus = 'not_found'; results.push(row); continue; }
      itemDoc = resource;
      row.displayName = resource.displayName || id;
      row.itemType = resource.itemType || '';
      resource.state = resource.state || {};
      resource.state.sensitivityLabel = labelName;
      if (isMipGuid) resource.state.sensitivityLabelId = labelId;
      resource.state.sensitivityLabeledAt = labeledAt;
      resource.state.sensitivityLabeledBy = who;
      resource.updatedAt = labeledAt;
      await itC.item(id, workspaceId).replace(resource);
      row.cosmosStatus = 'Succeeded';
    } catch (e: any) {
      row.cosmosStatus = e?.message || 'cosmos_error';
      results.push(row);
      continue;
    }

    // Phase B — Purview asset classification (opt-in).
    if (purviewOn) {
      try {
        const hits = await searchPurview(row.displayName, 25);
        const match = hits.find((h) => (h.name || '').toLowerCase() === row.displayName.toLowerCase());
        if (!match || !match.id) {
          row.purviewStatus = 'NotFound';
        } else {
          await addAssetClassification(match.id, [labelName]);
          row.purviewStatus = 'Succeeded';
        }
      } catch (e: any) {
        row.purviewStatus = e?.message || 'purview_error';
      }
    } else if (applyToPurview) {
      row.purviewStatus = 'Skipped';
    }

    // Stash the linked PBI artifact (resolved server-side from the item) for phase C.
    const pbi = extractPbiArtifact(itemDoc);
    if (pbi.pbiArtifactId && pbi.pbiArtifactType) {
      row.pbiArtifactId = pbi.pbiArtifactId;
      (row as any)._pbiType = pbi.pbiArtifactType;
    }
    results.push(row);
  }

  // ----- Phase C: Power BI Admin setLabels (opt-in, single bulk call) -----
  if (pbiOn) {
    const artifacts: PbiSetLabelArtifacts = {};
    const idToRow = new Map<string, ResultRow>();
    for (const r of results) {
      if (r.cosmosStatus !== 'Succeeded') continue; // don't propagate when Cosmos failed
      const t = (r as any)._pbiType as PbiArtifactType | undefined;
      if (!r.pbiArtifactId || !t) { if (r.itemType) r.pbiStatus = 'Skipped'; continue; }
      (artifacts[t] ||= []).push({ id: r.pbiArtifactId });
      idToRow.set(r.pbiArtifactId, r);
    }
    const hasAny = Object.values(artifacts).some((a) => a && a.length);
    if (hasAny) {
      try {
        const resp = await setLabelsAsAdmin(artifacts, labelId!);
        for (const list of Object.values(resp)) {
          for (const res of list || []) {
            const r = idToRow.get(res.id);
            if (r) r.pbiStatus = res.status;
          }
        }
        // Any artifact the API didn't return a status for → Failed (honest).
        for (const r of idToRow.values()) {
          if (!r.pbiStatus) r.pbiStatus = 'Failed';
        }
      } catch (e: any) {
        // The whole bulk call failed (e.g. SP not a Fabric admin) — record the
        // real error verbatim on every artifact row.
        const msg = e?.message || 'powerbi_error';
        for (const r of idToRow.values()) r.pbiStatus = msg as any;
      }
    }
  } else if (applyToPowerBi) {
    for (const r of results) {
      if (r.pbiArtifactId) r.pbiStatus = 'Skipped';
    }
  }

  // strip internal scratch field before returning
  const clean = results.map(({ ...r }) => { delete (r as any)._pbiType; return r; });

  return NextResponse.json({
    ok: true,
    results: clean,
    applied: { cosmos: true, purview: purviewOn, powerBi: pbiOn },
    labelName,
  });
}

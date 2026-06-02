/**
 * POST /api/apps/[id]/install — install an app's bundled items into a
 * caller-chosen workspace, then optionally (Phase 2) provision the
 * matching REAL artifacts in Fabric / ADX / Synapse / AI Search.
 *
 * Body:
 *   {
 *     workspaceId: string,
 *     deploy?: boolean,             // Phase 2 — default true
 *     mode?: 'shared' | 'dedicated',// Phase 2 — default 'shared'
 *     targetOverrides?: {...},      // Phase 2 — dedicated-mode resource ids
 *   }
 *
 * Reads the curated app from /api/apps-catalog (Cosmos apps-catalog).
 * For each `items[i]` in the app: creates a workspace item via the same
 * createOwnedItem helper the per-type editors use, so they pick it up in
 * their normal list flow + the item gets mirrored into AI Search /
 * audit-log automatically. Then, when deploy===true, calls the Phase-2
 * provisioning-engine which dispatches per-itemType provisioners that
 * hit the actual Azure REST surfaces.
 *
 * Result:
 *   {
 *     ok, app, workspaceId,
 *     installed: [{itemType, id, displayName, status:'created'|'existed'|'failed', error?}],
 *     provision?: { outcome, mode, target, steps:[ {itemType, displayName, cosmosItemId, result} ] }
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { appsCatalogContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { resolveBundleItem, getBundle } from '@/lib/apps/content-bundles';
import { runProvisioning, type ProvisionReport } from '@/lib/install/provisioning-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AppItemRef {
  type: string;
  template?: string;
  displayName?: string;
}
interface AppDoc {
  id: string;
  name: string;
  description?: string;
  items?: AppItemRef[];
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Phase-2 flags
  const deploy = body?.deploy !== false; // default true
  const mode = body?.mode === 'dedicated' ? 'dedicated' : 'shared';
  const targetOverrides = body?.targetOverrides && typeof body.targetOverrides === 'object'
    ? body.targetOverrides
    : undefined;

  // Verify caller owns the workspace.
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

  // Load the app.
  const apps = await appsCatalogContainer();
  const { resources: appDocs } = await apps.items
    .query<AppDoc>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.tenantId = @t',
      parameters: [{ name: '@id', value: params.id }, { name: '@t', value: s.claims.oid }],
    })
    .fetchAll();
  let app = appDocs[0];
  // Fall back to GLOBAL if not yet copied per-tenant.
  if (!app) {
    const { resources: globalDocs } = await apps.items
      .query<AppDoc>({
        query: 'SELECT * FROM c WHERE c.id = @id AND c.tenantId = @t',
        parameters: [{ name: '@id', value: params.id }, { name: '@t', value: 'GLOBAL' }],
      })
      .fetchAll();
    app = globalDocs[0];
  }
  if (!app) return NextResponse.json({ ok: false, error: `app '${params.id}' not found` }, { status: 404 });

  const items = await itemsContainer();
  // Existing items in this workspace, for dedup.
  const { resources: existing } = await items.items
    .query({
      query: 'SELECT c.id, c.itemType, c.displayName, c.state FROM c WHERE c.workspaceId = @w',
      parameters: [{ name: '@w', value: workspaceId }],
    }, { partitionKey: workspaceId })
    .fetchAll();
  const existsKey = new Set<string>(
    (existing as any[]).map(e => `${e.itemType}::${(e.displayName || '').toLowerCase()}`),
  );

  // When a bundle is registered for this app, its items[] is the source
  // of truth (it may add extra items beyond the Cosmos catalog shape, such
  // as walkthrough notebooks). Otherwise fall back to the Cosmos catalog.
  const bundleForApp = getBundle(app.id);
  const refs: AppItemRef[] = bundleForApp
    ? bundleForApp.items.map(b => ({ type: b.itemType, displayName: b.displayName }))
    : (app.items || []);

  const installed: Array<{
    itemType: string;
    id?: string;
    displayName: string;
    status: string;
    error?: string;
    content?: unknown;
  }> = [];
  for (const ref of refs) {
    // Resolve rich starter content (notebook cells, KQL DDL, dbt models,
    // dashboard tiles, etc.) from the in-process bundle registry.
    // Pass ref.displayName so bundles with multiple items of the same
    // itemType (e.g. logic-apps-integration's three distinct logic-app
    // workflows) resolve to the RIGHT item instead of collapsing onto the
    // first one — keeping each workflow's own name + WDL content.
    const bundle = resolveBundleItem(app.id, ref.type, ref.displayName);
    const displayName = bundle?.displayName || ref.displayName || `${app.name} · ${ref.type}`;
    const description = bundle?.description || `Installed from app '${app.name}'${ref.template ? ` · template: ${ref.template}` : ''}`;
    const state: Record<string, unknown> = {
      sourceApp: app.id,
      ...(ref.template ? { template: ref.template } : {}),
      ...(bundle?.content ? { content: bundle.content } : {}),
      ...(bundle?.learnDoc ? { learnDoc: bundle.learnDoc } : {}),
    };
    // Notebook items: project the bundle's NotebookContent.cells into the
    // editor's read shape (state.cells / state.defaultLang) so the notebook
    // opens FULLY POPULATED with every markdown + code cell — instead of an
    // empty notebook whose content is stranded in the "bundle" pane. Covers
    // notebook, synapse-notebook, and databricks-notebook item types.
    const nbc = bundle?.content as { kind?: string; cells?: unknown[]; defaultLang?: string } | undefined;
    if (nbc?.kind === 'notebook' && Array.isArray(nbc.cells) && nbc.cells.length > 0) {
      state.cells = nbc.cells;
      state.defaultLang = nbc.defaultLang || 'pyspark';
    }
    const key = `${ref.type}::${displayName.toLowerCase()}`;
    if (existsKey.has(key)) {
      const match = (existing as any[]).find(e => e.itemType === ref.type && (e.displayName || '').toLowerCase() === displayName.toLowerCase());
      installed.push({ itemType: ref.type, id: match?.id, displayName, status: 'existed', content: match?.state?.content || bundle?.content });
      continue;
    }
    const r = await createOwnedItem(s, ref.type, {
      workspaceId,
      displayName,
      description,
      state,
    });
    if (r.ok) {
      installed.push({ itemType: ref.type, id: r.item.id, displayName, status: 'created', content: bundle?.content });
    } else {
      installed.push({ itemType: ref.type, displayName, status: 'failed', error: r.error });
    }
  }

  // Auto-attach the app's installed lakehouse(s) to its notebooks, so each
  // notebook opens with the data sources it needs already attached (no manual
  // wiring). First lakehouse is the default source.
  try {
    const lakehouses = installed
      .filter((i) => i.itemType === 'lakehouse' && i.id)
      .map((i, idx) => ({ kind: 'lakehouse' as const, id: i.id!, displayName: i.displayName, isDefault: idx === 0 }));
    if (lakehouses.length > 0) {
      const itemsC = await itemsContainer();
      const nbItems = installed.filter(
        (i) => i.id && ['notebook', 'databricks-notebook', 'synapse-notebook'].includes(i.itemType),
      );
      for (const nb of nbItems) {
        try {
          const { resource } = await itemsC.item(nb.id!, workspaceId).read<any>();
          if (resource) {
            resource.state = { ...(resource.state || {}), attachedSources: lakehouses };
            await itemsC.item(nb.id!, workspaceId).replace(resource);
          }
        } catch { /* best-effort attach */ }
      }
    }
  } catch { /* best-effort */ }

  // Phase 2: run live-service provisioning.
  let provision: ProvisionReport | undefined;
  try {
    provision = await runProvisioning(
      s,
      app.id,
      workspaceId,
      installed.filter((i) => i.id).map((i) => ({ itemType: i.itemType, id: i.id, displayName: i.displayName, content: i.content })),
      { deploy, mode, targetOverrides },
    );

    // Stamp each Cosmos item with the provisioning result so the editor
    // surfaces "Backed by Fabric notebook <id>" instead of an empty
    // canvas.  Best-effort — failures here don't block the install.
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
            mode,
            at: new Date().toISOString(),
          },
        };
        // Pipeline items (adf-pipeline / synapse-pipeline) bind to a real Azure
        // pipeline via `state.pipelineName` — the pipeline GET route's
        // resolveBinding() 412s ("unbound") and never reaches its state.content
        // fallback when this is missing, so the designer canvas opens EMPTY even
        // though the bundle stamped a full activity graph. The provisioner
        // already computed the Azure pipeline name (secondaryIds.pipelineName);
        // stamp it as the binding here so the editor loads either the live
        // pipeline OR the built-out content fallback, and Run/Validate target
        // the real backend. Don't clobber a name the user already bound.
        const sec = (step.result.secondaryIds || {}) as Record<string, string>;
        if (
          (step.itemType === 'adf-pipeline' || step.itemType === 'synapse-pipeline') &&
          sec.pipelineName &&
          !(cur.state as any)?.pipelineName
        ) {
          nextState.pipelineName = sec.pipelineName;
          if (sec.backend === 'synapse' && process.env.LOOM_SYNAPSE_WORKSPACE) {
            nextState.workspace = process.env.LOOM_SYNAPSE_WORKSPACE;
          }
          if (sec.backend === 'adf' && process.env.LOOM_ADF_NAME) {
            nextState.factory = process.env.LOOM_ADF_NAME;
          }
        }
        await items.item(step.cosmosItemId, workspaceId).replace({ ...cur, state: nextState, updatedAt: new Date().toISOString() });
      } catch { /* swallow — provisioning record is best-effort */ }
    }
  } catch (e: any) {
    // Engine itself failed catastrophically — return a partial report so
    // the UI shows the failure rather than silently swallowing.
    provision = {
      outcome: 'partial',
      mode,
      target: { mode },
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
    app: app.id,
    workspaceId,
    installed: installed.map((i) => ({ itemType: i.itemType, id: i.id, displayName: i.displayName, status: i.status, ...(i.error ? { error: i.error } : {}) })),
    provision,
  });
}

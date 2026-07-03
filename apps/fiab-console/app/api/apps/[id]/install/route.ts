/**
 * POST /api/apps/[id]/install — install an app's bundled items into a
 * caller-chosen workspace, then optionally (Phase 2) provision the
 * matching REAL artifacts in Azure-native backends (ADX / Synapse / Event
 * Hubs / Azure Monitor / AI Search; Fabric strictly opt-in).
 *
 * ASYNC (task-019). A long install — creating 10-12 Cosmos items then
 * provisioning each into a real Azure backend (ADX cluster create, Synapse
 * dedicated-pool resume, Databricks job run-now+poll, ADF/Synapse pipeline
 * createRun+poll, Logic App run) — routinely exceeds the edge gateway's ~30s
 * window and used to 504. This route now:
 *   1. validates auth + workspace + app (fast),
 *   2. writes a `running` AppInstallJob to Cosmos,
 *   3. fires the full install in a FLOATING promise (the Container App Node
 *      process stays alive across the response, so the loop completes — same
 *      mechanism as /api/data-products/import),
 *   4. returns 202 { ok, jobId, totalItems } immediately.
 * The dialog polls GET /api/apps/install-jobs/[jobId] every 5s for live
 * phase + percentComplete + the final ProvisionReport.
 *
 * Body:
 *   {
 *     workspaceId: string,
 *     deploy?: boolean,             // Phase 2 — default true
 *     mode?: 'shared' | 'dedicated',// Phase 2 — default 'shared'
 *     folderId?: string,            // optional install target folder
 *     targetOverrides?: {...},      // Phase 2 — dedicated-mode resource ids
 *   }
 *
 * Reads the curated app from /api/apps-catalog (Cosmos apps-catalog). For each
 * `items[i]` in the app: creates a workspace item via the same createOwnedItem
 * helper the per-type editors use, so they pick it up in their normal list flow
 * + the item gets mirrored into AI Search / audit-log automatically. Then, when
 * deploy===true, calls the Phase-2 provisioning-engine which dispatches
 * per-itemType provisioners that hit the actual Azure REST surfaces.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  appsCatalogContainer,
  itemsContainer,
  workspacesContainer,
  appInstallJobsContainer,
  type AppInstallJob,
} from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { resolveBundleItem, getBundle } from '@/lib/apps/content-bundles';
import { substituteCellsPlaceholders } from '@/lib/apps/notebook-placeholders';
import { appWantsSuperchargeSeed, runSuperchargeSeed } from '@/lib/apps/supercharge-seed';
import { runProvisioning, type ProvisionReport } from '@/lib/install/provisioning-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Session = NonNullable<ReturnType<typeof getSession>>;

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
  const limited = await enforceRateLimit(s, 'provision');
  if (limited) return limited;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Phase-2 flags
  const deploy = body?.deploy !== false; // default true
  const mode = body?.mode === 'dedicated' ? 'dedicated' : 'shared';
  // Optional install target folder inside the workspace (null/'' = root).
  const folderId = (body?.folderId || '').toString().trim() || null;
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

  // When a bundle is registered for this app, its items[] is the source
  // of truth (it may add extra items beyond the Cosmos catalog shape, such
  // as walkthrough notebooks). Otherwise fall back to the Cosmos catalog.
  const bundleForApp = getBundle(app.id);
  const refs: AppItemRef[] = bundleForApp
    ? bundleForApp.items.map(b => ({ type: b.itemType, displayName: b.displayName }))
    : (app.items || []);

  // Write the `running` job doc, then fire the install in the background and
  // return 202. The whole install (item creation → provisioning → result
  // write-back) now runs in a floating promise so a long provision can't 504.
  const tenantId = s.claims.oid;
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const initial: AppInstallJob = {
    id: jobId,
    tenantId,
    appId: app.id,
    appName: app.name,
    workspaceId,
    status: 'running',
    phase: 'creating-items',
    deploy,
    mode,
    totalItems: refs.length,
    createdItems: 0,
    percentComplete: 0,
    installed: [],
    createdAt: now,
    updatedAt: now,
    createdBy: s.claims.upn || s.claims.email || tenantId,
  };
  try {
    const jobs = await appInstallJobsContainer();
    await jobs.items.create<AppInstallJob>(initial);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `Failed to create install job: ${e?.message || e}` }, { status: 500 });
  }

  // Fire the worker. The Container App Node process stays alive across the
  // response, so the loop completes and the poll observes the progress.
  void runInstallJob(s, jobId, app, refs, workspaceId, { deploy, mode, folderId, targetOverrides });

  return NextResponse.json(
    { ok: true, jobId, totalItems: refs.length },
    { status: 202 },
  );
}

interface InstalledItem {
  itemType: string;
  id?: string;
  displayName: string;
  status: string;
  error?: string;
  content?: unknown;
}

/**
 * The async install worker. Runs the full Phase-1 (item creation) + lakehouse
 * auto-attach + Phase-2 (provisioning) + result write-back, persisting progress
 * to the app-install-jobs Cosmos doc as it advances. Never throws — a
 * catastrophic failure is recorded on the job doc (status:'failed').
 */
async function runInstallJob(
  s: Session,
  jobId: string,
  app: AppDoc,
  refs: AppItemRef[],
  workspaceId: string,
  opts: { deploy: boolean; mode: 'shared' | 'dedicated'; folderId: string | null; targetOverrides?: Record<string, unknown> },
): Promise<void> {
  const tenantId = s.claims.oid;
  const { deploy, mode, folderId, targetOverrides } = opts;
  const total = refs.length;

  // Phase weights: item creation 0→35%, provisioning 35→95%, finalize 95→100%.
  const CREATE_CEIL = total > 0 ? 35 : 95;
  const PROVISION_FLOOR = 35;
  const PROVISION_CEIL = 95;

  const persist = async (patch: Partial<AppInstallJob>): Promise<void> => {
    try {
      const jobs = await appInstallJobsContainer();
      const { resource } = await jobs.item(jobId, tenantId).read<AppInstallJob>();
      if (!resource) return;
      const next: AppInstallJob = { ...resource, ...patch, updatedAt: new Date().toISOString() };
      await jobs.item(jobId, tenantId).replace<AppInstallJob>(next);
    } catch {
      // best-effort progress write — never throw out of the worker
    }
  };

  try {
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

    // ── Phase 1: create the Cosmos items ────────────────────────────────────
    const installed: InstalledItem[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      // Resolve rich starter content (notebook cells, KQL DDL, dbt models,
      // dashboard tiles, etc.) from the in-process bundle registry. Pass
      // ref.displayName so bundles with multiple items of the same itemType
      // resolve to the RIGHT item instead of collapsing onto the first one.
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
      // editor's read shape so the notebook opens FULLY POPULATED. Resolve the
      // `{{ADLS_ACCOUNT}}` deployment placeholder to the real Azure-native ADLS
      // account (LOOM_ADLS_ACCOUNT) so the persisted cells carry a valid abfss
      // host — never the raw token that would 404 at read time.
      const nbc = bundle?.content as { kind?: string; cells?: unknown[]; defaultLang?: string } | undefined;
      if (nbc?.kind === 'notebook' && Array.isArray(nbc.cells) && nbc.cells.length > 0) {
        state.cells = substituteCellsPlaceholders(nbc.cells as Array<{ source?: unknown }>);
        state.defaultLang = nbc.defaultLang || 'pyspark';
      }
      const key = `${ref.type}::${displayName.toLowerCase()}`;
      if (existsKey.has(key)) {
        const match = (existing as any[]).find(e => e.itemType === ref.type && (e.displayName || '').toLowerCase() === displayName.toLowerCase());
        installed.push({ itemType: ref.type, id: match?.id, displayName, status: 'existed', content: match?.state?.content || bundle?.content });
      } else {
        const r = await createOwnedItem(s, ref.type, { workspaceId, displayName, description, state, folderId });
        if (r.ok) {
          installed.push({ itemType: ref.type, id: r.item.id, displayName, status: 'created', content: bundle?.content });
        } else {
          installed.push({ itemType: ref.type, displayName, status: 'failed', error: r.error });
        }
      }
      // Persist create progress so the poll shows the item count advancing.
      const pct = total > 0 ? Math.round(((i + 1) / total) * CREATE_CEIL) : CREATE_CEIL;
      await persist({
        createdItems: i + 1,
        percentComplete: pct,
        installed: installed.map(stripContent),
      });
    }

    // Auto-attach the app's installed lakehouse(s) to its notebooks.
    try {
      const lakehouses = installed
        .filter((it) => it.itemType === 'lakehouse' && it.id)
        .map((it, idx) => ({ kind: 'lakehouse' as const, id: it.id!, displayName: it.displayName, isDefault: idx === 0 }));
      if (lakehouses.length > 0) {
        const nbItems = installed.filter(
          (it) => it.id && ['notebook', 'databricks-notebook', 'synapse-notebook'].includes(it.itemType),
        );
        for (const nb of nbItems) {
          try {
            const { resource } = await items.item(nb.id!, workspaceId).read<any>();
            if (resource) {
              resource.state = { ...(resource.state || {}), attachedSources: lakehouses };
              await items.item(nb.id!, workspaceId).replace(resource);
            }
          } catch { /* best-effort attach */ }
        }
      }
    } catch { /* best-effort */ }

    // ── Phase 2: live-service provisioning ──────────────────────────────────
    await persist({ phase: 'provisioning', percentComplete: PROVISION_FLOOR, installed: installed.map(stripContent) });

    const provisionInput = installed.filter((it) => it.id).map((it) => ({ itemType: it.itemType, id: it.id, displayName: it.displayName, content: it.content }));
    const provisionTotal = provisionInput.length;
    let provision: ProvisionReport;
    try {
      provision = await runProvisioning(
        s,
        app.id,
        workspaceId,
        provisionInput,
        {
          deploy,
          mode,
          targetOverrides,
          onProgress: async (done, totalItems) => {
            const span = PROVISION_CEIL - PROVISION_FLOOR;
            const pct = PROVISION_FLOOR + (totalItems > 0 ? Math.round((done / totalItems) * span) : span);
            await persist({ percentComplete: pct });
          },
        },
      );

      // Stamp each Cosmos item with the provisioning result so the editor
      // surfaces "Backed by …" instead of an empty canvas. Best-effort.
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
          if (step.itemType === 'logic-app' && sec.workflowName && !(cur.state as any)?.logicAppName) {
            nextState.logicAppName = sec.workflowName;
          }
          await items.item(step.cosmosItemId, workspaceId).replace({ ...cur, state: nextState, updatedAt: new Date().toISOString() });
        } catch { /* swallow — provisioning record is best-effort */ }
      }
    } catch (e: any) {
      // Engine itself failed catastrophically — record a partial report so the
      // UI shows the failure rather than silently swallowing.
      provision = {
        outcome: 'partial',
        mode,
        target: { mode },
        steps: provisionInput.map((it) => ({
          itemType: it.itemType,
          displayName: it.displayName,
          cosmosItemId: it.id || '',
          result: { status: 'failed', error: e?.message || String(e), steps: [] },
        })),
      };
    }

    // ── Sample-data seed (Supercharge medallion apps) ───────────────────────
    // Land the Bronze SOURCE parquet under Files/output/* + pre-create the
    // lh_bronze/lh_silver/lh_gold Spark databases so the installed notebooks
    // have real data to ingest and the medallion flows end-to-end. Best-effort:
    // a seed failure/gate is recorded but never fails the install.
    if (deploy && appWantsSuperchargeSeed(app.id)) {
      await persist({ phase: 'seeding' });
      const seedPool = (process.env.LOOM_SYNAPSE_SPARK_POOL || process.env.LOOM_SYNAPSE_DEDICATED_POOL || 'loompool').trim();
      try {
        const seedRes = await runSuperchargeSeed(seedPool);
        await persist({ seed: { status: seedRes.status, error: seedRes.error, gate: seedRes.gate, at: new Date().toISOString() } });
      } catch (e: any) {
        await persist({ seed: { status: 'failed', error: e?.message || String(e), at: new Date().toISOString() } });
      }
    }

    // ── Finalize: derive terminal status from the provision outcome ──────────
    await persist({ phase: 'finalizing', percentComplete: PROVISION_CEIL });

    const createFailed = installed.some((it) => it.status === 'failed');
    let status: AppInstallJob['status'];
    if (!deploy || provisionTotal === 0) {
      status = createFailed ? 'partial' : 'done';
    } else if (provision.outcome === 'all-created' || provision.outcome === 'skipped') {
      status = createFailed ? 'partial' : 'done';
    } else if (provision.outcome === 'partial' || provision.outcome === 'all-remediation') {
      status = 'partial';
    } else {
      status = 'partial';
    }

    await persist({
      status,
      phase: 'done',
      percentComplete: 100,
      installed: installed.map(stripContent),
      provision,
    });
  } catch (e: any) {
    // Worker itself threw before/around the loop — surface a failed job rather
    // than a job stuck on 'running' forever.
    await persist({ status: 'failed', phase: 'done', percentComplete: 100, error: e?.message || String(e) });
  }
}

/** Drop the heavy `content` blob before persisting the per-item list to Cosmos —
 * the dialog only needs itemType/id/displayName/status/error. */
function stripContent(it: InstalledItem): AppInstallJob['installed'][number] {
  return { itemType: it.itemType, id: it.id, displayName: it.displayName, status: it.status, ...(it.error ? { error: it.error } : {}) };
}

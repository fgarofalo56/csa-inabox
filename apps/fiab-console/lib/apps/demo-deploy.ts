/**
 * Self-serve DEMO ENVIRONMENT deploy — the in-console equivalent of the
 * operator-only `scripts/csa-loom/demo-seed.mjs`.
 *
 * The comprehensive "art-of-the-possible" demo (#1989/#1990) installs ~14
 * showcase apps — each into its own `Demo — X` workspace — plus a flagship
 * curated workspace. Until now that only ran from a script/CI with an admin
 * session, so a self-service user could not stand up the whole demo to explore.
 *
 * This orchestrator lets ANY signed-in user deploy the entire demo with one
 * click. It reuses the EXACT same public in-console APIs the script uses —
 * POST /api/workspaces (find-or-create by name, idempotent) and
 * POST /api/apps/{id}/install (full provision per app) — by forwarding the
 * caller's own session cookie to same-origin calls. No refactor of the install
 * engine, no admin-only path: every app fully provisions its Azure-native
 * backend exactly as an individual install does (no-vaporware.md, no-fabric).
 *
 * Progress is tracked on an app-install-jobs doc (appId='demo-environment') with
 * a `subJobs[]` array so the UI can poll aggregate status; each sub-install is a
 * normal app-install job the user can also open individually.
 */
import { appInstallJobsContainer, type AppInstallJob } from '@/lib/azure/cosmos-client';

/** The showcase apps, each installed into its own `Demo — <label>` workspace.
 *  Mirrors SHOWCASE_APPS in scripts/csa-loom/demo-seed.mjs (single source of the
 *  demo set — keep in sync). */
export const SHOWCASE_APPS: ReadonlyArray<readonly [appId: string, wsLabel: string]> = [
  ['app-supercharge-bronze', 'Demo — Medallion Bronze'],
  ['app-supercharge-silver', 'Demo — Medallion Silver'],
  ['app-supercharge-gold', 'Demo — Medallion Gold'],
  ['app-direct-lake-replacement', 'Demo — Direct Lake'],
  ['app-lakehouse-inspector', 'Demo — Lakehouse Inspector'],
  ['app-real-time-dashboards', 'Demo — Real-Time Dashboards'],
  ['app-iot-realtime', 'Demo — IoT Real-Time'],
  ['app-ml-pipeline', 'Demo — ML Pipeline'],
  ['app-rag-builder', 'Demo — RAG Builder'],
  ['app-sovereign-ai-agents', 'Demo — Sovereign AI Agents'],
  ['app-data-governance', 'Demo — Data Governance'],
  ['app-data-steward', 'Demo — Data Steward'],
  ['app-federal-data-mesh', 'Demo — Federal Data Mesh'],
  ['app-finops-cost', 'Demo — FinOps'],
] as const;

/** One demo sub-install: an app installed into its own Demo workspace. */
export interface DemoSubJob {
  appId: string;
  wsLabel: string;
  workspaceId?: string;
  /** The underlying app-install jobId (poll /api/apps/install-jobs/{id} for detail). */
  installJobId?: string;
  status: 'pending' | 'installing' | 'done' | 'error';
  error?: string;
}

const DEMO_APP_ID = 'demo-environment';

/**
 * Same-origin base for server-side self-calls. Defaults to the LOCAL container
 * port (127.0.0.1:PORT) — a hairpin to the PUBLIC Front Door URL from inside the
 * container does NOT work (egress/routing), so we call the app on localhost.
 * Overridable via LOOM_SELF_BASE_URL. Cookie-based auth is unaffected by the host.
 */
export function selfBaseUrl(): string {
  return (process.env.LOOM_SELF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

async function jobDoc(jobId: string, tenantId: string): Promise<AppInstallJob | null> {
  const jobs = await appInstallJobsContainer();
  try {
    const { resource } = await jobs.item(jobId, tenantId).read<AppInstallJob>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

async function patchDemoJob(jobId: string, tenantId: string, patch: Partial<AppInstallJob>): Promise<void> {
  const jobs = await appInstallJobsContainer();
  const cur = await jobDoc(jobId, tenantId);
  if (!cur) return;
  await jobs.item(jobId, tenantId).replace<AppInstallJob>({ ...cur, ...patch, updatedAt: new Date().toISOString() });
}

/** Create the tracking doc for a demo deploy. Returns the demo jobId. */
export async function createDemoJob(tenantId: string, who: string): Promise<string> {
  const jobs = await appInstallJobsContainer();
  const jobId = (globalThis.crypto as Crypto).randomUUID();
  const now = new Date().toISOString();
  const sub: DemoSubJob[] = SHOWCASE_APPS.map(([appId, wsLabel]) => ({ appId, wsLabel, status: 'pending' }));
  const doc: AppInstallJob = {
    id: jobId,
    tenantId,
    appId: DEMO_APP_ID,
    appName: 'CSA Loom Demo Environment',
    workspaceId: '',
    status: 'running',
    phase: 'creating-items',
    deploy: true,
    mode: 'shared',
    totalItems: SHOWCASE_APPS.length,
    createdItems: 0,
    percentComplete: 0,
    installed: [],
    createdAt: now,
    updatedAt: now,
    createdBy: who,
    // per-app sub-installs the demo GET reads back for aggregate progress.
    subJobs: sub,
  };
  await jobs.items.create<AppInstallJob>(doc);
  return jobId;
}

/**
 * Run the demo deploy: for each showcase app, find-or-create its `Demo —`
 * workspace and fire the app install, forwarding the caller's session cookie to
 * same-origin API calls. Best-effort per app (one failure never sinks the rest).
 * Never throws — records terminal status on the demo job doc.
 *
 * @param cookie  the caller's raw Cookie header (carries loom_session).
 * @param origin  same-origin base (req.nextUrl.origin), overridable via LOOM_SELF_BASE_URL.
 */
export async function runDemoDeploy(opts: {
  jobId: string;
  tenantId: string;
  cookie: string;
  origin: string;
}): Promise<void> {
  const { jobId, tenantId, cookie } = opts;
  const base = selfBaseUrl();
  const H = { cookie, 'content-type': 'application/json' };
  const sub: DemoSubJob[] = SHOWCASE_APPS.map(([appId, wsLabel]) => ({ appId, wsLabel, status: 'pending' }));

  const flush = (done: number) =>
    patchDemoJob(jobId, tenantId, {
      createdItems: done,
      percentComplete: Math.round((done / SHOWCASE_APPS.length) * 100),
      subJobs: sub.map((s) => ({ ...s })),
    }).catch(() => {});

  // Look up existing workspaces once (idempotent find-or-create by name).
  const wsByName = new Map<string, string>();
  try {
    const r = await fetch(`${base}/api/workspaces`, { headers: { cookie } });
    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j) ? j : (j.workspaces || j.items || []);
    for (const w of list) wsByName.set((w.name || w.displayName || '').toLowerCase(), w.id);
  } catch { /* best-effort — creates fresh below */ }

  let done = 0;
  for (let i = 0; i < sub.length; i++) {
    const entry = sub[i];
    try {
      entry.status = 'installing';
      await flush(done);
      // 1) find-or-create the Demo workspace (idempotent by name).
      let wsId = wsByName.get(entry.wsLabel.toLowerCase());
      if (!wsId) {
        const cr = await fetch(`${base}/api/workspaces`, {
          method: 'POST', headers: H, body: JSON.stringify({ name: entry.wsLabel, displayName: entry.wsLabel }),
        });
        const cj = await cr.json().catch(() => ({}));
        wsId = cj?.id || cj?.workspace?.id;
        if (wsId) wsByName.set(entry.wsLabel.toLowerCase(), wsId);
      }
      if (!wsId) { entry.status = 'error'; entry.error = 'workspace create failed'; done++; await flush(done); continue; }
      entry.workspaceId = wsId;
      // 2) install the app into it (full provision — deploy:true default).
      const ir = await fetch(`${base}/api/apps/${encodeURIComponent(entry.appId)}/install`, {
        method: 'POST', headers: H, body: JSON.stringify({ workspaceId: wsId }),
      });
      const ij = await ir.json().catch(() => ({}));
      if (ij?.jobId) { entry.installJobId = ij.jobId; entry.status = 'done'; }
      else { entry.status = 'error'; entry.error = ij?.error || `install HTTP ${ir.status}`; }
    } catch (e: any) {
      entry.status = 'error';
      entry.error = (e?.message || String(e)).slice(0, 200);
    }
    done++;
    await flush(done);
  }

  const anyErr = sub.some((s) => s.status === 'error');
  await patchDemoJob(jobId, tenantId, {
    status: anyErr ? 'partial' : 'done',
    phase: 'done',
    percentComplete: 100,
    subJobs: sub,
  }).catch(() => {});
}

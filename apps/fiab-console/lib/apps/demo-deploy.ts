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
 *
 * ── #3905: ACCEPTED IS NOT DONE ────────────────────────────────────────────
 * This module used to mark a sub-install `'done'` the instant the install API
 * returned a `jobId` — before provisioning had started — and roll that up to
 * `done / 100%`. `installJobId` was never read again. The banner then reported
 * "14/14 apps installed · done" over empty lakehouses. That is
 * `deploy-integrity.md` R2 rendered in the product.
 *
 * The deploy now runs in TWO phases:
 *   1. DISPATCH   — create the workspace + POST the install. Success here is
 *                   `accepted`, never `done`.
 *   2. CONFIRM    — poll each `installJobId`'s job doc until it reaches a
 *                   TERMINAL status (`done` | `partial` | `failed`) and record
 *                   the REAL outcome.
 *
 * If confirmation cannot be reached — the poll budget is exhausted, the job doc
 * stops advancing (installs are detached floating promises on a console running
 * minReplicas:2/maxReplicas:6/multiRevision, so a scale-in can kill an install
 * mid-write and the doc simply stops moving — #3905 P2), or the doc cannot be
 * read — the entry becomes `unknown`. A poll loop that exhausts and then claims
 * success would be WORSE than the original bug because it looks measured.
 * `unknown` is a first-class outcome and it is rendered as unknown.
 */
import { appInstallJobsContainer, type AppInstallJob } from '@/lib/azure/cosmos-client';
import {
  summarizeDemoSubJobs, mapTerminalInstallStatus, isResolved,
  type DemoSubJob, type DemoRollup,
} from '@/lib/apps/demo-deploy-status';

export type { DemoSubJob, DemoSubStatus, DemoRollup } from '@/lib/apps/demo-deploy-status';

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

const DEMO_APP_ID = 'demo-environment';

/**
 * The persisted demo job doc. `AppInstallJob['subJobs']` in
 * lib/azure/cosmos-client.ts still carries the ORIGINAL narrow union
 * ('pending' | 'installing' | 'done' | 'error') that predates this fix; that
 * file is owned by another lane in the #3905 fan-out, so the widened shape is
 * declared here and cast ONCE at the Cosmos boundary (Cosmos itself is
 * schemaless, and the demo poll route returns the doc verbatim). Widening the
 * cosmos-client declaration is a follow-up, not a behaviour change.
 */
export type PersistedDemoJob = Omit<AppInstallJob, 'subJobs'> & {
  subJobs?: DemoSubJob[];
  /** Server-computed rollup, written with every flush so a CLI/script reader
   *  sees the same verdict the banner does (one function, one truth). */
  demoSummary?: DemoRollup;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Timing budgets. Defaults are production values; every one is overridable so
 *  the specs can exercise the real loop in milliseconds instead of minutes. */
export interface DemoDeployTiming {
  /** Spacing between install dispatches (the provision limiter refills 1/sec). */
  dispatchSpacingMs: number;
  /** Base backoff for a rate-limited install retry (multiplied by attempt). */
  rateLimitBackoffMs: number;
  /** Interval between confirmation polls of the install job docs. */
  pollIntervalMs: number;
  /** Total wall-clock budget for the confirmation phase. On exhaustion every
   *  still-unconfirmed entry becomes `unknown` — never `succeeded`. */
  pollBudgetMs: number;
  /** An install job whose doc has not CHANGED for this long is `unknown`. */
  stallMs: number;
}

function envInt(name: string, dflt: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}

/** Production defaults (env-overridable tuning knobs — the deploy sets none of
 *  them and does not need to; these values work as-is). */
export function defaultDemoTiming(): DemoDeployTiming {
  return {
    dispatchSpacingMs: envInt('LOOM_DEMO_DISPATCH_SPACING_MS', 1500),
    rateLimitBackoffMs: envInt('LOOM_DEMO_RATE_BACKOFF_MS', 2500),
    pollIntervalMs: envInt('LOOM_DEMO_POLL_INTERVAL_MS', 5_000),
    pollBudgetMs: envInt('LOOM_DEMO_POLL_BUDGET_MS', 25 * 60_000),
    stallMs: envInt('LOOM_DEMO_STALL_MS', 5 * 60_000),
  };
}

/** Consecutive failed/absent reads of an install job doc before the entry is
 *  declared `unknown` (a single blip is not evidence of anything). */
const READ_FAILURES_BEFORE_UNKNOWN = 3;

/**
 * Same-origin base for server-side self-calls. Defaults to the LOCAL container
 * port (127.0.0.1:PORT) — a hairpin to the PUBLIC Front Door URL from inside the
 * container does NOT work (egress/routing), so we call the app on localhost.
 * Overridable via LOOM_SELF_BASE_URL. Cookie-based auth is unaffected by the host.
 */
export function selfBaseUrl(): string {
  return (process.env.LOOM_SELF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

async function jobDoc(jobId: string, tenantId: string): Promise<PersistedDemoJob | null> {
  const jobs = await appInstallJobsContainer();
  try {
    const { resource } = await jobs.item(jobId, tenantId).read<AppInstallJob>();
    return (resource as unknown as PersistedDemoJob) ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

async function patchDemoJob(jobId: string, tenantId: string, patch: Partial<PersistedDemoJob>): Promise<void> {
  const jobs = await appInstallJobsContainer();
  const cur = await jobDoc(jobId, tenantId);
  if (!cur) return;
  const next: PersistedDemoJob = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  // Single boundary cast — see the PersistedDemoJob note above.
  await jobs.item(jobId, tenantId).replace<AppInstallJob>(next as unknown as AppInstallJob);
}

/** Create the tracking doc for a demo deploy. Returns the demo jobId. */
export async function createDemoJob(tenantId: string, who: string): Promise<string> {
  const jobs = await appInstallJobsContainer();
  const jobId = (globalThis.crypto as Crypto).randomUUID();
  const now = new Date().toISOString();
  const sub: DemoSubJob[] = SHOWCASE_APPS.map(([appId, wsLabel]) => ({ appId, wsLabel, status: 'pending' }));
  const doc: PersistedDemoJob = {
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
    demoSummary: summarizeDemoSubJobs(sub),
  };
  await jobs.items.create<AppInstallJob>(doc as unknown as AppInstallJob);
  return jobId;
}

/**
 * Run the demo deploy: for each showcase app, find-or-create its `Demo —`
 * workspace and fire the app install, then POLL every install to a terminal
 * state and record the REAL outcome. Best-effort per app (one failure never
 * sinks the rest). Never throws — records the rollup on the demo job doc.
 *
 * @param cookie  the caller's raw Cookie header (carries loom_session).
 * @param origin  same-origin base (req.nextUrl.origin), overridable via LOOM_SELF_BASE_URL.
 * @param timing  budget overrides (tests run the real loop in milliseconds).
 */
export async function runDemoDeploy(opts: {
  jobId: string;
  tenantId: string;
  cookie: string;
  origin: string;
  timing?: Partial<DemoDeployTiming>;
}): Promise<void> {
  const { jobId, tenantId, cookie } = opts;
  const t: DemoDeployTiming = { ...defaultDemoTiming(), ...(opts.timing || {}) };
  const base = selfBaseUrl();
  const H = { cookie, 'content-type': 'application/json' };
  const sub: DemoSubJob[] = SHOWCASE_APPS.map(([appId, wsLabel]) => ({ appId, wsLabel, status: 'pending' }));

  const flush = (phase: AppInstallJob['phase']) => {
    const summary = summarizeDemoSubJobs(sub);
    return patchDemoJob(jobId, tenantId, {
      // `createdItems` is the count of apps whose install actually SUCCEEDED —
      // not the count of apps we have walked past.
      createdItems: summary.succeeded,
      percentComplete: summary.percentComplete,
      phase,
      subJobs: sub.map((s) => ({ ...s })),
      demoSummary: summary,
    }).catch(() => {});
  };

  // Look up existing workspaces once (idempotent find-or-create by name).
  const wsByName = new Map<string, string>();
  try {
    const r = await fetch(`${base}/api/workspaces`, { headers: { cookie } });
    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j) ? j : (j.workspaces || j.items || []);
    for (const w of list) wsByName.set((w.name || w.displayName || '').toLowerCase(), w.id);
  } catch { /* best-effort — creates fresh below */ }

  // ── Phase 1: DISPATCH ─────────────────────────────────────────────────────
  // A jobId in hand means the install was ACCEPTED. It does not mean anything
  // was provisioned, so the entry stops at `accepted` and phase 2 decides.
  for (let i = 0; i < sub.length; i++) {
    const entry = sub[i];
    try {
      // NOTE: the entry stays `pending` while its workspace is created. It is
      // not `installing` — nothing is installing until an install job exists.
      await flush('creating-items');
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
      if (!wsId) {
        entry.status = 'failed';
        entry.error = 'workspace create failed';
        await flush('creating-items');
        continue;
      }
      entry.workspaceId = wsId;
      // 2) install the app into it (full provision — deploy:true default). The
      // provision rate-limiter is a token bucket (ratePerSec 1, burst 3), so 14
      // rapid installs would trip it — retry a rate-limited install with backoff.
      let ij: any = {};
      for (let attempt = 0; attempt < 4; attempt++) {
        const ir = await fetch(`${base}/api/apps/${encodeURIComponent(entry.appId)}/install`, {
          method: 'POST', headers: H, body: JSON.stringify({ workspaceId: wsId }),
        });
        ij = await ir.json().catch(() => ({}));
        const limited = ir.status === 429 || /rate.?limit/i.test(String(ij?.error || ij?.code || ''));
        if (ij?.jobId || !limited) break;
        await sleep(t.rateLimitBackoffMs * (attempt + 1));
      }
      if (ij?.jobId) {
        entry.installJobId = String(ij.jobId);
        entry.status = 'accepted';   // ← #3905: NOT 'done'. Nothing is installed yet.
      } else {
        entry.status = 'failed';
        entry.error = ij?.error || 'install failed';
      }
    } catch (e: any) {
      entry.status = 'failed';
      entry.error = (e?.message || String(e)).slice(0, 200);
    }
    await flush('creating-items');
    // Space installs under the provision refill rate (1/sec) so the next one
    // doesn't trip the limiter after the burst budget is spent.
    if (i < sub.length - 1) await sleep(t.dispatchSpacingMs);
  }

  // ── Phase 2: CONFIRM ──────────────────────────────────────────────────────
  await confirmInstalls(sub, tenantId, t, () => flush('provisioning'));

  const summary = summarizeDemoSubJobs(sub);
  await patchDemoJob(jobId, tenantId, {
    status: summary.status,          // 'done' ONLY when every install succeeded
    phase: 'done',
    createdItems: summary.succeeded,
    percentComplete: summary.percentComplete,
    subJobs: sub,
    demoSummary: summary,
  }).catch(() => {});
}

/** Progress fingerprint of an install job doc — any change means the worker is
 *  alive. `updatedAt` alone is enough in practice; phase + percent + status are
 *  included so a same-millisecond rewrite still registers as movement. */
function fingerprint(doc: PersistedDemoJob): string {
  return `${doc.updatedAt}|${doc.phase}|${doc.percentComplete}|${doc.status}`;
}

/**
 * Poll every dispatched install to a TERMINAL state.
 *
 * Exits when every entry is resolved, or when the budget runs out — and on
 * exhaustion the survivors are `unknown`, never `succeeded`. Three ways an
 * entry lands on `unknown`, each with a message TRUE of what was actually
 * observed (deploy-integrity.md R7):
 *   • the doc stopped changing for `stallMs` (the classic lost-replica case);
 *   • the doc could not be read `READ_FAILURES_BEFORE_UNKNOWN` times running;
 *   • the confirmation budget expired while it was still running.
 */
export async function confirmInstalls(
  sub: DemoSubJob[],
  tenantId: string,
  t: DemoDeployTiming,
  onProgress: () => Promise<unknown> | unknown,
): Promise<void> {
  const started = Date.now();
  const lastFp = new Map<string, { fp: string; at: number }>();
  const readMisses = new Map<string, number>();

  const outstanding = () => sub.filter((e) => !isResolved(e.status));

  // Anything dispatched without a jobId can never be confirmed — resolve it now
  // rather than burning the budget on it.
  for (const e of outstanding()) {
    if (!e.installJobId) {
      e.status = 'unknown';
      e.detail = 'no install jobId was returned, so this install could not be tracked';
    }
  }

  while (outstanding().length > 0) {
    const elapsed = Date.now() - started;
    if (elapsed >= t.pollBudgetMs) break;
    await sleep(t.pollIntervalMs);

    for (const entry of outstanding()) {
      const id = entry.installJobId as string;
      let doc: PersistedDemoJob | null = null;
      try {
        doc = await jobDoc(id, tenantId);
      } catch (e: any) {
        const misses = (readMisses.get(id) || 0) + 1;
        readMisses.set(id, misses);
        if (misses >= READ_FAILURES_BEFORE_UNKNOWN) {
          entry.status = 'unknown';
          entry.detail = `the install job doc could not be read (${misses} consecutive attempts): ${String(e?.message || e).slice(0, 160)}`;
        }
        continue;
      }

      if (!doc) {
        const misses = (readMisses.get(id) || 0) + 1;
        readMisses.set(id, misses);
        if (misses >= READ_FAILURES_BEFORE_UNKNOWN) {
          entry.status = 'unknown';
          entry.detail = `no install job doc was found for this install after ${misses} attempts`;
        }
        continue;
      }
      readMisses.set(id, 0);

      const terminal = mapTerminalInstallStatus(doc.status);
      if (terminal) {
        entry.status = terminal;
        entry.installStatus = doc.status;
        entry.lastPercent = doc.percentComplete;
        if (terminal === 'failed') {
          entry.error = String(doc.error || 'the install job reported failure').slice(0, 200);
        } else if (terminal === 'partial') {
          entry.detail = 'the install job finished with gates or per-item failures — open the app to see them';
        }
        continue;
      }

      // Still running — record movement, and treat "stopped advancing" as
      // UNKNOWN. Installs are detached floating promises, so a replica
      // scale-in leaves the doc frozen mid-install with no error written.
      entry.status = 'installing';
      entry.lastPercent = doc.percentComplete;
      const fp = fingerprint(doc);
      const seen = lastFp.get(id);
      if (!seen || seen.fp !== fp) {
        lastFp.set(id, { fp, at: Date.now() });
        entry.lastProgressAt = new Date().toISOString();
      } else if (Date.now() - seen.at >= t.stallMs) {
        entry.status = 'unknown';
        entry.detail = `the install job stopped advancing for ${Math.round((Date.now() - seen.at) / 1000)}s at phase '${doc.phase}' (${doc.percentComplete}%) — its worker may have been lost to a replica restart, so the outcome is not known`;
      }
    }

    await onProgress();
  }

  // Budget exhausted (or the loop never got to a terminal read): whatever is
  // left is UNKNOWN. It is NEVER promoted to success.
  for (const entry of outstanding()) {
    entry.status = 'unknown';
    entry.detail = entry.detail
      || `not confirmed within the ${Math.round(t.pollBudgetMs / 1000)}s confirmation budget — last seen ${entry.lastPercent ?? 0}% complete`;
  }
  await onProgress();
}

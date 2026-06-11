'use client';

/**
 * jobs-store — module-scope background-job registry for long-running lakehouse
 * operations (file uploads, load-to-Delta-table hand-offs).
 *
 * WHY this exists (F10 — multitasking / background-job continuity):
 * The lakehouse editor used to `await fetch('/api/lakehouse/upload')` inside a
 * React `useCallback` bound to the component. When the user switched item tabs
 * mid-upload the editor unmounted, every `setState` after the await became a
 * silent no-op, and the user returned to a stale ribbon with no confirmation —
 * the upload "vanished" from the UI even though the XHR was still completing.
 *
 * By owning the `fetch` here — at MODULE scope, inside a Zustand action, NOT in
 * any React lifecycle — the request and its completion handling outlive any
 * component mount/unmount. Tab navigation never cancels an in-flight job; only
 * an explicit `cancelJob()` (via the per-job AbortController) does.
 *
 * On completion the store fires a `loom:job-complete` CustomEvent. The globally
 * mounted <GlobalJobToaster> (in AppShell) listens and raises a Fluent toast
 * that NAMES the originating lakehouse — so the user knows which lakehouse the
 * file landed in regardless of which tab they're now looking at.
 *
 * This is NOT mock job state: the in-flight `fetch` IS the poll. It resolves
 * only when `@azure/storage-file-datalake`'s Create+Append+Flush against the
 * real ADLS Gen2 DFS endpoint returns (via the /api/lakehouse/upload BFF). No
 * server-side job id or fake progress is invented.
 */

import { create } from 'zustand';

export type JobKind = 'upload' | 'load-to-table' | 'sql-query' | 'app-install';
export type JobStatus = 'running' | 'success' | 'error' | 'cancelled';

export interface LoomJob {
  id: string;
  kind: JobKind;
  /** Human-readable lakehouse name (displayName ?? container key ?? item id). */
  lakehouseName: string;
  /** KNOWN_CONTAINERS value: 'bronze' | 'silver' | 'gold' | 'landing'. */
  container: string;
  /** Leaf file name (upload) or target table name (load-to-table). */
  fileName: string;
  /** Target Delta table name, set for load-to-table jobs. */
  tableName?: string;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  /** Detected Spark format label from the upload response (.sparkFormat.label). */
  sparkFormatLabel?: string;
  error?: string;
  /** sql-query: server/database label used in the completion toast. */
  server?: string;
  /** sql-query: BFF requestId registered in azure-sql-client.liveRequests (cancel token). */
  requestId?: string;
  /** sql-query: result payload from the BFF on success. */
  queryResult?: {
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    executionMs: number;
    truncated: boolean;
  };
  // ── app-install (task-019) ────────────────────────────────────────────────
  /** app-install: the app's display name (shown in the completion toast). */
  appName?: string;
  /** app-install: server-side AppInstallJob id being polled. */
  serverJobId?: string;
  /** app-install: 0-100 live progress mirrored from the server job doc. */
  percentComplete?: number;
  /** app-install: coarse server phase ('creating-items' | 'provisioning' | …). */
  installPhase?: string;
  /** app-install: total item count reported by the kickoff 202. */
  totalItems?: number;
  /** app-install: terminal server outcome ('done' | 'partial' | 'failed'). */
  installOutcome?: 'done' | 'partial' | 'failed';
  /** app-install: per-item create results (for the dialog's installed panel). */
  installResult?: Array<{ itemType: string; id?: string; displayName: string; status: string; error?: string }>;
  /** app-install: final ProvisionReport (opaque here; the dialog casts it). */
  provisionReport?: unknown;
}

export interface JobToastDetail {
  job: LoomJob;
}

/** CustomEvent name consumed by <GlobalJobToaster>. */
export const JOB_EVENT = 'loom:job-complete';

/** Fire the completion event the global toaster listens for. */
function fireJobEvent(job: LoomJob): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<JobToastDetail>(JOB_EVENT, { detail: { job } }),
  );
}

// Module-level AbortController registry — deliberately NOT in React state so it
// survives component unmounts. Tab navigation does NOT touch this map; only
// cancelJob() calls abort().
const controllers = new Map<string, AbortController>();

let seq = 0;
function nextId(): string {
  seq += 1;
  return `job-${Date.now().toString(36)}-${seq}`;
}

/**
 * Parse the /api/lakehouse/upload response defensively. A gateway / Container
 * App / WAF can return an HTML error page (5xx, 413, 502); calling `.json()`
 * blind would throw "Unexpected token '<'". Sniff the content-type first and
 * surface a precise message otherwise.
 */
async function parseUploadResponse(
  r: Response,
): Promise<{ ok: boolean; error?: string; sparkFormatLabel?: string }> {
  const ct = r.headers.get('content-type') || '';
  let body: { ok?: boolean; error?: string; sparkFormat?: { label?: string } } | null = null;
  if (ct.includes('application/json')) {
    try { body = await r.json(); } catch { /* fall through */ }
  }
  if (r.ok && body?.ok !== false) {
    return { ok: true, sparkFormatLabel: body?.sparkFormat?.label };
  }
  let bodyText = '';
  if (!body) { try { bodyText = (await r.text()).slice(0, 200); } catch { /* ignore */ } }
  const detail =
    body?.error
    || (r.status === 413 ? 'File too large (max 4 GB).'
      : r.status === 502 ? 'Upstream storage error (502). Check ADLS network / role assignments.'
      : r.status === 401 ? 'Sign-in expired. Reload and re-authenticate.'
      : `Upload failed (HTTP ${r.status}).${bodyText ? ` Server said: ${bodyText}` : ''}`);
  return { ok: false, error: detail };
}

interface StartUploadArgs {
  lakehouseName: string;
  container: string;
  /** Full target path within the container, e.g. "silver/data.parquet". */
  path: string;
  file: File;
  onDone?: (r: { ok: boolean; error?: string; sparkFormatLabel?: string }) => void;
}

interface RecordLoadArgs {
  lakehouseName: string;
  container: string;
  tableName: string;
}

/** Result handed to the InstallAppDialog's onDone when an async install ends. */
export interface InstallJobDone {
  ok: boolean;
  outcome?: 'done' | 'partial' | 'failed';
  installed?: Array<{ itemType: string; id?: string; displayName: string; status: string; error?: string }>;
  provision?: unknown;
  error?: string;
}

interface StartInstallArgs {
  appId: string;
  appName: string;
  workspaceId: string;
  deploy: boolean;
  mode: 'shared' | 'dedicated';
  folderId: string | null;
  /**
   * Foreground completion callback. Fires whether or not the dialog is still
   * mounted; when backgrounded (dialog closed / tab switched) the completed job
   * stays in the store and the global toaster raises the toast naming the app.
   */
  onDone?: (r: InstallJobDone) => void;
}

interface SqlQueryDone {
  ok: boolean;
  queryResult?: LoomJob['queryResult'];
  error?: string;
  code?: string;
}

interface StartSqlQueryArgs {
  /** Database (or "server / database") label shown in the completion toast. */
  databaseName: string;
  /** Server name (kept for disambiguation / future filtering). */
  server: string;
  /** First chars of the SQL text — display only. */
  sqlLabel: string;
  /** The SQL to execute. */
  sqlText: string;
  /** Fully-qualified BFF query URL (family-aware: azure-sql vs postgres). */
  queryUrl: string;
  /** crypto.randomUUID() — registered in liveRequests on the BFF before .query(). */
  requestId: string;
  /**
   * Foreground completion callback. Fires whether or not the originating
   * component is still mounted; the editor guards its own setState. When the
   * component HAS unmounted (backgrounded), the completed job stays in the
   * store and the global toaster raises the toast.
   */
  onDone?: (r: SqlQueryDone) => void;
}

interface JobsState {
  jobs: LoomJob[];
  /** Kick off a real ADLS upload that survives component unmount. Returns the job id. */
  startUpload(args: StartUploadArgs): string;
  /**
   * Kick off a real TDS query (via /api/items/.../query) that survives component
   * unmount. A background-completing query raises a completion toast naming the
   * database. Returns the job id.
   */
  startSqlQuery(args: StartSqlQueryArgs): string;
  /**
   * Kick off a TRUE async app install (task-019): POST /api/apps/{id}/install
   * returns 202 { jobId }; this owns the 5s poll of
   * /api/apps/install-jobs/{jobId} at MODULE scope so a long provision survives
   * the dialog closing / tab switching. Returns the local job id; the dialog
   * selects the job by id to render live percentComplete.
   */
  startInstall(args: StartInstallArgs): string;
  /** Record a load-to-Delta-table hand-off (notebook prefilled + opened). Returns the job id. */
  recordLoadToTable(args: RecordLoadArgs): string;
  /** Abort an in-flight upload via its AbortController. */
  cancelJob(id: string): void;
  /** Drop all non-running jobs from the registry. */
  clearCompleted(): void;
  /** In-flight upload jobs for a given container (for ribbon/badge counts). */
  runningForContainer(container: string): LoomJob[];
}

export const useJobsStore = create<JobsState>((set, get) => ({
  jobs: [],

  startUpload: ({ lakehouseName, container, path, file, onDone }) => {
    const id = nextId();
    const ac = new AbortController();
    controllers.set(id, ac);
    const fileName = path.split('/').pop() || file.name;

    const initial: LoomJob = {
      id,
      kind: 'upload',
      lakehouseName,
      container,
      fileName,
      status: 'running',
      startedAt: Date.now(),
    };

    const fd = new FormData();
    fd.set('container', container);
    fd.set('path', path);
    fd.set('file', file);

    // fetch at module scope — the XHR outlives any React component lifecycle.
    fetch('/api/lakehouse/upload', { method: 'POST', body: fd, signal: ac.signal })
      .then(parseUploadResponse)
      .then((res) => {
        controllers.delete(id);
        const patch: Partial<LoomJob> = res.ok
          ? { status: 'success', completedAt: Date.now(), sparkFormatLabel: res.sparkFormatLabel }
          : { status: 'error', completedAt: Date.now(), error: res.error };
        let updated: LoomJob | undefined;
        set((s) => ({
          jobs: s.jobs.map((j) => {
            if (j.id !== id) return j;
            updated = { ...j, ...patch };
            return updated;
          }),
        }));
        if (updated) fireJobEvent(updated);
        onDone?.(res);
      })
      .catch((e: Error) => {
        controllers.delete(id);
        if (e?.name === 'AbortError') {
          set((s) => ({
            jobs: s.jobs.map((j) => (j.id === id
              ? { ...j, status: 'cancelled' as JobStatus, completedAt: Date.now() }
              : j)),
          }));
          return; // user-initiated cancel — no toast
        }
        const message = e?.message || String(e);
        let updated: LoomJob | undefined;
        set((s) => ({
          jobs: s.jobs.map((j) => {
            if (j.id !== id) return j;
            updated = { ...j, status: 'error', completedAt: Date.now(), error: message };
            return updated;
          }),
        }));
        if (updated) fireJobEvent(updated);
        onDone?.({ ok: false, error: message });
      });

    set((s) => ({ jobs: [...s.jobs, initial] }));
    return id;
  },

  startSqlQuery: ({ databaseName, server, sqlLabel, sqlText, queryUrl, requestId, onDone }) => {
    const id = nextId();
    const initial: LoomJob = {
      id,
      kind: 'sql-query',
      lakehouseName: server ? `${server} / ${databaseName}` : databaseName,
      container: 'query', // neutral — sql-query jobs are not container-scoped
      fileName: sqlLabel,
      server,
      requestId,
      status: 'running',
      startedAt: Date.now(),
    };

    // fetch at MODULE scope — outlives the editor's mount. A backgrounded query
    // (user closed/switched the tab) still resolves here and fires the toast.
    // Cancellation is NOT an AbortController: the /query/cancel route sends a
    // real TDS ATTENTION packet, so the server stops the query and this fetch
    // resolves normally with { ok: false, code: 'ECANCEL' }.
    fetch(queryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database: databaseName, sql: sqlText, requestId }),
    })
      .then(async (r) => {
        const ct = r.headers.get('content-type') || '';
        const j: any = ct.includes('application/json')
          ? await r.json().catch(() => ({ ok: false, error: 'Malformed JSON from query route' }))
          : { ok: false, error: `Expected JSON but received ${ct || 'unknown'} (HTTP ${r.status})` };
        let updated: LoomJob | undefined;
        set((s) => ({
          jobs: s.jobs.map((job) => {
            if (job.id !== id) return job;
            const patch: Partial<LoomJob> = j.ok
              ? {
                  status: 'success' as JobStatus,
                  completedAt: Date.now(),
                  queryResult: {
                    columns: j.columns || [],
                    rows: j.rows || [],
                    rowCount: j.rowCount ?? 0,
                    executionMs: j.executionMs ?? 0,
                    truncated: j.truncated ?? false,
                  },
                }
              : { status: 'error' as JobStatus, completedAt: Date.now(), error: j.error || 'query failed' };
            updated = { ...job, ...patch };
            return updated;
          }),
        }));
        if (updated) fireJobEvent(updated);
        onDone?.(j.ok
          ? { ok: true, queryResult: updated?.queryResult }
          : { ok: false, error: j.error || 'query failed', code: j.code });
      })
      .catch((e: Error) => {
        const message = e?.message || String(e);
        let updated: LoomJob | undefined;
        set((s) => ({
          jobs: s.jobs.map((job) => {
            if (job.id !== id) return job;
            updated = { ...job, status: 'error' as JobStatus, completedAt: Date.now(), error: message };
            return updated;
          }),
        }));
        if (updated) fireJobEvent(updated);
        onDone?.({ ok: false, error: message });
      });

    set((s) => ({ jobs: [...s.jobs, initial] }));
    return id;
  },

  startInstall: ({ appId, appName, workspaceId, deploy, mode, folderId, onDone }) => {
    const id = nextId();
    const initial: LoomJob = {
      id,
      kind: 'app-install',
      lakehouseName: appName, // reused by the generic toaster title path
      appName,
      container: 'install', // neutral — install jobs are not container-scoped
      fileName: appName,
      status: 'running',
      startedAt: Date.now(),
      percentComplete: 0,
      installPhase: 'creating-items',
    };
    set((s) => ({ jobs: [...s.jobs, initial] }));

    // Terminal-state writer shared by the kickoff-failure and poll-completion paths.
    const finish = (patch: Partial<LoomJob>, done: InstallJobDone) => {
      let updated: LoomJob | undefined;
      set((s) => ({
        jobs: s.jobs.map((j) => {
          if (j.id !== id) return j;
          updated = { ...j, completedAt: Date.now(), ...patch };
          return updated;
        }),
      }));
      if (updated) fireJobEvent(updated);
      onDone?.(done);
    };

    // Poll the server job doc every 5s at MODULE scope (survives unmount).
    const poll = (serverJobId: string) => {
      const tick = async () => {
        try {
          const r = await fetch(`/api/apps/install-jobs/${encodeURIComponent(serverJobId)}`);
          const ct = r.headers.get('content-type') || '';
          const j: any = ct.includes('application/json') ? await r.json().catch(() => null) : null;
          if (r.ok && j?.ok && j.job) {
            const job = j.job as {
              status: 'running' | 'done' | 'partial' | 'failed';
              phase: string;
              percentComplete: number;
              installed?: InstallJobDone['installed'];
              provision?: unknown;
              error?: string;
            };
            if (job.status === 'running') {
              set((s) => ({
                jobs: s.jobs.map((x) => (x.id === id
                  ? { ...x, percentComplete: job.percentComplete ?? x.percentComplete, installPhase: job.phase }
                  : x)),
              }));
            } else {
              const outcome: 'done' | 'partial' | 'failed' = job.status;
              finish(
                {
                  status: outcome === 'failed' ? 'error' : 'success',
                  percentComplete: 100,
                  installPhase: 'done',
                  installOutcome: outcome,
                  installResult: job.installed,
                  provisionReport: job.provision,
                  error: job.error,
                },
                { ok: outcome !== 'failed', outcome, installed: job.installed, provision: job.provision, error: job.error },
              );
              return; // stop polling
            }
          }
          // Non-OK / transient — keep polling (the worker may still be writing).
        } catch {
          // transient network error — keep polling
        }
        setTimeout(tick, 5000);
      };
      setTimeout(tick, 2500); // first poll quickly, then every 5s
    };

    // Kickoff: POST returns 202 { jobId }. fetch at MODULE scope.
    (async () => {
      try {
        const r = await fetch(`/api/apps/${encodeURIComponent(appId)}/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, deploy, mode, folderId }),
        });
        const ct = r.headers.get('content-type') || '';
        const j: any = ct.includes('application/json') ? await r.json().catch(() => null) : null;
        if (!r.ok || !j?.ok || !j.jobId) {
          const error = j?.error || `Install kickoff failed (HTTP ${r.status}).`;
          finish({ status: 'error', percentComplete: 100, installPhase: 'done', error }, { ok: false, error });
          return;
        }
        const serverJobId = j.jobId as string;
        set((s) => ({
          jobs: s.jobs.map((x) => (x.id === id
            ? { ...x, serverJobId, totalItems: j.totalItems }
            : x)),
        }));
        poll(serverJobId);
      } catch (e: any) {
        const error = e?.message || String(e);
        finish({ status: 'error', percentComplete: 100, installPhase: 'done', error }, { ok: false, error });
      }
    })();

    return id;
  },

  recordLoadToTable: ({ lakehouseName, container, tableName }) => {
    const id = nextId();
    // The real backend work (the no-code Load-to-Table wizard submitting a Spark
    // job that materializes the Delta table) is owned by the editor/wizard. This
    // records the LH-named metadata in the registry so the global toaster can
    // identify the originating lakehouse and the job survives navigation.
    const job: LoomJob = {
      id,
      kind: 'load-to-table',
      lakehouseName,
      container,
      fileName: tableName,
      tableName,
      status: 'success',
      startedAt: Date.now(),
      completedAt: Date.now(),
    };
    set((s) => ({ jobs: [...s.jobs, job] }));
    fireJobEvent(job);
    return id;
  },

  cancelJob: (id) => {
    const ac = controllers.get(id);
    if (ac) { ac.abort(); controllers.delete(id); }
  },

  clearCompleted: () => set((s) => ({ jobs: s.jobs.filter((j) => j.status === 'running') })),

  runningForContainer: (container) =>
    get().jobs.filter((j) => j.status === 'running' && j.container === container),
}));

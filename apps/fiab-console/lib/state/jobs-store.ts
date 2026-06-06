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

export type JobKind = 'upload' | 'load-to-table';
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

interface JobsState {
  jobs: LoomJob[];
  /** Kick off a real ADLS upload that survives component unmount. Returns the job id. */
  startUpload(args: StartUploadArgs): string;
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

  recordLoadToTable: ({ lakehouseName, container, tableName }) => {
    const id = nextId();
    // The real side effects (notebook prefill in localStorage + navigation) are
    // owned by the editor. This records the LH-named metadata so the toast can
    // identify the originating lakehouse; marking success reflects the real
    // state (notebook opened — the user runs it to write the Delta table).
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

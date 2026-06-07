/**
 * jobs-store unit tests (F10 — background-job continuity).
 *
 * Exercises the module-scope store's real state machine: a started upload is
 * recorded immediately as `running`, transitions to `success`/`error` when the
 * (mocked) /api/lakehouse/upload fetch resolves, fires a `loom:job-complete`
 * CustomEvent carrying the lakehouse name, and can be cancelled via its
 * AbortController. Per no-vaporware.md these tests do not pretend to exercise
 * ADLS — they exercise the store's lifecycle, which is the F10 contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useJobsStore, JOB_EVENT, type JobToastDetail } from '../jobs-store';

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('jobs-store', () => {
  beforeEach(() => {
    useJobsStore.setState({ jobs: [] });
    // Minimal window so fireJobEvent can dispatch in the node test env.
    if (typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = new EventTarget();
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a running upload immediately and resolves to success with a lakehouse-named event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, sparkFormat: { label: 'Parquet' } }, 201),
    ));

    const events: JobToastDetail[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent<JobToastDetail>).detail);
    (globalThis as any).window.addEventListener(JOB_EVENT, listener);

    const file = new File([new Uint8Array([1, 2, 3])], 'data.parquet');
    const id = useJobsStore.getState().startUpload({
      lakehouseName: 'Sales Bronze',
      container: 'bronze',
      path: 'sales/data.parquet',
      file,
    });

    // Recorded synchronously as running — survives any later unmount.
    let job = useJobsStore.getState().jobs.find((j) => j.id === id);
    expect(job?.status).toBe('running');
    expect(job?.lakehouseName).toBe('Sales Bronze');
    expect(useJobsStore.getState().runningForContainer('bronze')).toHaveLength(1);

    await flush();

    job = useJobsStore.getState().jobs.find((j) => j.id === id);
    expect(job?.status).toBe('success');
    expect(job?.sparkFormatLabel).toBe('Parquet');
    expect(events).toHaveLength(1);
    expect(events[0].job.lakehouseName).toBe('Sales Bronze');
    expect(events[0].job.status).toBe('success');

    (globalThis as any).window.removeEventListener(JOB_EVENT, listener);
  });

  it('marks an upload as error on a non-ok response and fires an error event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: 'file too large (… > 4 GB)' }, 413),
    ));

    const events: JobToastDetail[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent<JobToastDetail>).detail);
    (globalThis as any).window.addEventListener(JOB_EVENT, listener);

    const file = new File([new Uint8Array([0])], 'big.bin');
    const id = useJobsStore.getState().startUpload({
      lakehouseName: 'Gold LH', container: 'gold', path: 'big.bin', file,
    });

    await flush();

    const job = useJobsStore.getState().jobs.find((j) => j.id === id);
    expect(job?.status).toBe('error');
    expect(job?.error).toContain('4 GB');
    expect(events[0].job.status).toBe('error');
    expect(events[0].job.lakehouseName).toBe('Gold LH');

    (globalThis as any).window.removeEventListener(JOB_EVENT, listener);
  });

  it('cancelJob aborts an in-flight upload (status -> cancelled, no toast)', async () => {
    // fetch that rejects with AbortError when its signal aborts.
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as Error).name = 'AbortError';
          reject(err);
        });
      })));

    const events: JobToastDetail[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent<JobToastDetail>).detail);
    (globalThis as any).window.addEventListener(JOB_EVENT, listener);

    const file = new File([new Uint8Array([1])], 'x.csv');
    const id = useJobsStore.getState().startUpload({
      lakehouseName: 'Silver', container: 'silver', path: 'x.csv', file,
    });
    expect(useJobsStore.getState().jobs.find((j) => j.id === id)?.status).toBe('running');

    useJobsStore.getState().cancelJob(id);
    await flush();

    expect(useJobsStore.getState().jobs.find((j) => j.id === id)?.status).toBe('cancelled');
    expect(events).toHaveLength(0); // cancellation is silent

    (globalThis as any).window.removeEventListener(JOB_EVENT, listener);
  });

  it('recordLoadToTable records a success job and fires a lakehouse-named event', () => {
    const events: JobToastDetail[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent<JobToastDetail>).detail);
    (globalThis as any).window.addEventListener(JOB_EVENT, listener);

    const id = useJobsStore.getState().recordLoadToTable({
      lakehouseName: 'Retail', container: 'silver', tableName: 'orders',
    });

    const job = useJobsStore.getState().jobs.find((j) => j.id === id);
    expect(job?.kind).toBe('load-to-table');
    expect(job?.status).toBe('success');
    expect(job?.tableName).toBe('orders');
    expect(events).toHaveLength(1);
    expect(events[0].job.lakehouseName).toBe('Retail');
    expect(events[0].job.fileName).toBe('orders');

    (globalThis as any).window.removeEventListener(JOB_EVENT, listener);
  });

  it('clearCompleted keeps only running jobs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 201)));
    const file = new File([new Uint8Array([1])], 'a.parquet');
    useJobsStore.getState().startUpload({ lakehouseName: 'L', container: 'bronze', path: 'a.parquet', file });
    await flush();
    useJobsStore.getState().recordLoadToTable({ lakehouseName: 'L', container: 'bronze', tableName: 't' });
    expect(useJobsStore.getState().jobs.length).toBeGreaterThanOrEqual(2);

    useJobsStore.getState().clearCompleted();
    expect(useJobsStore.getState().jobs.every((j) => j.status === 'running')).toBe(true);
  });
});

/**
 * autoReport benign-noise filter (#2908).
 *
 * The global error listener forwards every window 'error' / 'unhandledrejection'
 * to autoReport, which files an 'auto-error' via /api/feedback. Browsers emit
 * benign "ResizeObserver loop …" notifications routinely (a resize callback
 * scheduling another layout in the same frame — nothing breaks), and one got
 * auto-filed from the eventstream canvas (#2908). These must be dropped before
 * they POST, while genuine errors still forward.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientFetch = vi.fn(async () => new Response('{}', { status: 200 }));
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => clientFetch(...a) }));

import { autoReport } from '../error-boundary';

beforeEach(() => clientFetch.mockClear());

describe('autoReport benign-noise filter (#2908)', () => {
  it('does NOT forward either ResizeObserver loop notification', async () => {
    await autoReport(
      { name: 'Error', message: 'ResizeObserver loop completed with undelivered notifications.' },
      'window',
    );
    await autoReport({ name: 'Error', message: 'ResizeObserver loop limit exceeded' }, 'window');
    expect(clientFetch).not.toHaveBeenCalled();
  });

  it('DOES forward a genuine error to /api/feedback', async () => {
    await autoReport({ name: 'TypeError', message: 'genuine boom #2908-probe' }, 'window');
    expect(clientFetch).toHaveBeenCalledTimes(1);
    expect(clientFetch).toHaveBeenCalledWith('/api/feedback', expect.objectContaining({ method: 'POST' }));
  });
});

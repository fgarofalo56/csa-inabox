/**
 * /admin/capacity cost + utilization cells — mount-cost regression pins
 * (vitest jsdom).
 *
 * THE DEFECT THESE PIN: both cells used to fetch from a bare mount effect, so
 * painting an N-row Azure inventory issued 2N Cost Management / Azure Monitor
 * calls immediately, queued behind small QPU limiters. The live in-VNet route
 * smoke measured /admin/capacity at ~44s to mount (2x the next slowest page)
 * and it never reached `networkidle`.
 *
 * The contract now: a row that is NOT on screen issues NO request. These tests
 * fail if that regresses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => clientFetchMock(...args),
}));

import {
  CostCell, UtilizationSparkCell, __resetCapacityCellCaches,
  type AzureRes,
} from '@/lib/components/admin/capacity-cells';

interface FakeEntry { isIntersecting: boolean; target: Element }

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  private cb: (entries: FakeEntry[]) => void;
  elements: Element[] = [];
  disconnected = false;

  constructor(cb: (entries: FakeEntry[]) => void) {
    this.cb = cb;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) { this.elements.push(el); }
  unobserve(el: Element) { this.elements = this.elements.filter((e) => e !== el); }
  disconnect() { this.disconnected = true; this.elements = []; }
  takeRecords() { return []; }

  static intersectAll() {
    for (const io of [...FakeIntersectionObserver.instances]) {
      if (io.disconnected || io.elements.length === 0) continue;
      io.cb(io.elements.map((target) => ({ isIntersecting: true, target })));
    }
  }
  static reset() { FakeIntersectionObserver.instances = []; }
}

const RES: AzureRes = {
  id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa1',
  name: 'sa1',
  type: 'Microsoft.Storage/storageAccounts',
  location: 'eastus2',
  resourceGroup: 'rg',
};

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
}

function wrap(node: React.ReactNode) {
  return <FluentProvider theme={webLightTheme}>{node}</FluentProvider>;
}

/** Every URL clientFetch was called with, in order. */
function calledUrls(): string[] {
  return clientFetchMock.mock.calls.map((c) => String(c[0]));
}

describe('capacity cells — deferred until on screen', () => {
  beforeEach(() => {
    __resetCapacityCellCaches();
    clientFetchMock.mockReset();
    FakeIntersectionObserver.reset();
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  });
  afterEach(() => {
    delete (globalThis as any).IntersectionObserver;
  });

  it('CostCell issues NO Cost Management request while the row is off screen', async () => {
    clientFetchMock.mockImplementation(() => jsonOk({ ok: true, cost: 12.34, currency: 'USD' }));
    const onCost = vi.fn();
    render(wrap(<CostCell resourceId={RES.id} onCost={onCost} />));

    // Off screen: nothing requested, and the cell shows a designed placeholder
    // (never a blank cell that reads as "$0").
    expect(clientFetchMock).not.toHaveBeenCalled();
    expect(onCost).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Cost loads when this row scrolls into view/i)).toBeInTheDocument();

    await act(async () => { FakeIntersectionObserver.intersectAll(); });
    await waitFor(() => expect(screen.getByText('$12.34')).toBeInTheDocument());
    expect(calledUrls().filter((u) => u.includes('/api/admin/capacity/cost'))).toHaveLength(1);
    expect(onCost).toHaveBeenCalledWith(RES.id, 12.34, 'USD');
  });

  it('UtilizationSparkCell issues NO Azure Monitor request while the row is off screen', async () => {
    clientFetchMock.mockImplementation(() =>
      jsonOk({ ok: true, data: { metric: { metricName: 'Availability', label: 'Availability', unit: 'Percent', aggregation: 'Average', points: [{ timeStamp: 't', value: 99.9 }] } } }),
    );
    render(wrap(<UtilizationSparkCell res={RES} />));

    expect(clientFetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Utilization loads when this row scrolls into view/i)).toBeInTheDocument();

    await act(async () => { FakeIntersectionObserver.intersectAll(); });
    await waitFor(() => expect(screen.getByLabelText('utilization sparkline')).toBeInTheDocument());
    expect(calledUrls().filter((u) => u.includes('/api/admin/capacity/utilization'))).toHaveLength(1);
  });

  it('N off-screen rows cost ZERO requests at mount (the ~44s mount regression)', () => {
    clientFetchMock.mockImplementation(() => jsonOk({ ok: true, cost: 1, currency: 'USD' }));
    const rows: AzureRes[] = Array.from({ length: 40 }, (_, i) => ({ ...RES, id: `${RES.id}-${i}`, name: `sa${i}` }));
    render(wrap(
      <>
        {rows.map((r) => (
          <span key={r.id}>
            <CostCell resourceId={r.id} onCost={() => {}} />
            <UtilizationSparkCell res={r} />
          </span>
        ))}
      </>,
    ));
    // Pre-fix this render issued 80 Azure calls.
    expect(clientFetchMock).toHaveBeenCalledTimes(0);
  });

  it('`eager` bypasses the visibility gate (the "Load all costs" action)', async () => {
    clientFetchMock.mockImplementation(() => jsonOk({ ok: true, cost: 5, currency: 'USD' }));
    render(wrap(<CostCell resourceId={RES.id} onCost={() => {}} eager />));
    await waitFor(() => expect(screen.getByText('$5.00')).toBeInTheDocument());
    expect(calledUrls()).toHaveLength(1);
  });

  it('de-dupes concurrent requests and serves a remount from cache', async () => {
    clientFetchMock.mockImplementation(() => jsonOk({ ok: true, cost: 7, currency: 'USD' }));
    const { unmount } = render(wrap(
      <>
        <CostCell resourceId={RES.id} onCost={() => {}} />
        <CostCell resourceId={RES.id} onCost={() => {}} />
      </>,
    ));
    await act(async () => { FakeIntersectionObserver.intersectAll(); });
    await waitFor(() => expect(screen.getAllByText('$7.00').length).toBe(2));
    expect(calledUrls()).toHaveLength(1);

    unmount();
    render(wrap(<CostCell resourceId={RES.id} onCost={() => {}} />));
    // Cached: renders the value with no observer round-trip and no refetch.
    await waitFor(() => expect(screen.getByText('$7.00')).toBeInTheDocument());
    expect(calledUrls()).toHaveLength(1);
  });

  it('renders an honest gate badge (never a fake number) when the BFF gates', async () => {
    clientFetchMock.mockImplementation(() =>
      jsonOk({ ok: false, gate: { missing: ['Cost Management Reader'], message: 'Grant Cost Management Reader' } }),
    );
    render(wrap(<CostCell resourceId={RES.id} onCost={() => {}} />));
    await act(async () => { FakeIntersectionObserver.intersectAll(); });
    await waitFor(() => expect(screen.getByText('No access')).toBeInTheDocument());
  });
});

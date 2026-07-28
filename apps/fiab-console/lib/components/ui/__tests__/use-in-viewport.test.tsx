/**
 * useInViewport — the deferral primitive behind /admin/capacity's lazy cost +
 * utilization cells (vitest jsdom).
 *
 * Pins the two contracts callers depend on:
 *   • NOTHING reports visible until the observed element actually intersects,
 *   • where IntersectionObserver does not exist the hook reports visible
 *     immediately (progressive enhancement — an unavailable optimization must
 *     never leave real data unloaded).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useInViewport } from '@/lib/components/ui/use-in-viewport';

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

  /** Fire an intersecting callback on every live observer. */
  static intersectAll() {
    for (const io of [...FakeIntersectionObserver.instances]) {
      if (io.disconnected || io.elements.length === 0) continue;
      io.cb(io.elements.map((target) => ({ isIntersecting: true, target })));
    }
  }
  static reset() { FakeIntersectionObserver.instances = []; }
}

function Probe({ eager = false }: { eager?: boolean }) {
  const { ref, inViewport } = useInViewport<HTMLDivElement>({ eager });
  return <div ref={ref} data-testid="probe">{inViewport ? 'visible' : 'deferred'}</div>;
}

describe('useInViewport', () => {
  beforeEach(() => {
    FakeIntersectionObserver.reset();
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  });
  afterEach(() => {
    delete (globalThis as any).IntersectionObserver;
    vi.restoreAllMocks();
  });

  it('reports deferred until the element intersects, then latches visible', async () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('deferred');
    // The element is observed, not assumed visible.
    expect(FakeIntersectionObserver.instances.length).toBe(1);
    expect(FakeIntersectionObserver.instances[0].elements.length).toBe(1);

    await act(async () => { FakeIntersectionObserver.intersectAll(); });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('visible'));
    // Latched: the observer is torn down once seen.
    expect(FakeIntersectionObserver.instances[0].disconnected).toBe(true);
  });

  it('reports visible immediately when `eager` is set', () => {
    render(<Probe eager />);
    expect(screen.getByTestId('probe')).toHaveTextContent('visible');
  });

  it('falls back to visible where IntersectionObserver is unavailable', async () => {
    delete (globalThis as any).IntersectionObserver;
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('visible'));
  });
});

/**
 * THE SURFACE, END TO END — the pane rendered over a real snapshot.
 *
 * The sibling suites test the pieces: the model decides, the node renders, the
 * detectors detect. This one mounts the actual `BrainPane` the page ships and
 * checks that the three things an operator must be able to see are on screen:
 *
 *   1. the graph, with its legend distinguishing dangling wires;
 *   2. the recommendations, with their evidence and their proposals;
 *   3. THE COVERAGE PANEL — what the snapshot could not establish.
 *
 * (3) is the one a normal product would not ship and the one this program
 * exists for. A surface that renders findings but hides the fact that three of
 * its five edge provenances were never collected is a confident lie, and it is
 * the specific failure PRP §3.2 calls non-negotiable.
 *
 * ── NOTE ON WHAT THIS IS NOT ───────────────────────────────────────────────
 * This is jsdom. Per `ux-baseline.md` G1 a rendering test is NOT a completion
 * receipt — the GuidedPickerRail adoption passed every CI gate and hard-froze
 * the live renderer. No in-browser E2E has been run against a live estate, and
 * the PR body says so in those words.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { ReactElement } from 'react';
import { BrainPane, parseBrainTab } from '@/app/admin/brain/brain-pane';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { collection, estateRows } from './estate-fixture';

/**
 * #4278 — the tab is an ADDRESS, so the router is part of the subject.
 *
 * The global `vitest.setup.ts` stub returns a fresh throwaway router and an
 * always-empty `URLSearchParams`, which cannot express "arrive at
 * `?tab=recommendations`" or observe what the pane wrote back. This file-scoped
 * mock makes both readable: `nav.search` is the incoming URL, `nav.replace` and
 * `nav.push` are the outgoing writes.
 */
const nav = vi.hoisted(() => ({
  search: new URLSearchParams(''),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/admin/brain',
  useSearchParams: () => nav.search,
  useParams: () => ({}),
}));

beforeEach(() => {
  nav.search = new URLSearchParams('');
  nav.replace.mockClear();
  nav.push.mockClear();
});

const snapshot = snapshotFromCollection(collection());

function wrap(ui: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

/** Re-render in place, so a changed `nav.search` reaches the mounted pane. */
function rewrap(r: ReturnType<typeof wrap>, ui: ReactElement) {
  r.rerender(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

describe('the pane renders the estate', () => {
  it('mounts with the filter bar and the view population', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    expect(screen.getByTestId('brain-pane')).toBeInTheDocument();

    // The view reports its OWN population. A filtered canvas showing 3 nodes
    // over an estate of 63 looks exactly like an estate of 3.
    const pop = screen.getByTestId('view-population');
    expect(pop.textContent).toContain(`of ${snapshot.nodes.length} node(s)`);
    expect(pop.textContent).toContain(`of ${snapshot.edges.length} edge(s)`);
    // The cloud is named, so a Commercial reading is never mistaken for a Gov one.
    expect(pop.textContent).toContain(snapshot.cloud);
  });

  it('renders the graph canvas by default', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    expect(screen.getByTestId('brain-canvas')).toBeInTheDocument();
  });

  it('the recommendations tab lists the findings with their proposals', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Recommendations/ }));
    expect(screen.getByTestId('recommendations')).toBeInTheDocument();
    expect(screen.getAllByTestId('finding-card').length).toBe(snapshot.findings.length);
    // The founding finding is on screen, by name.
    expect(screen.getByText(/loom-capacity-broker is always-on and unreachable/)).toBeInTheDocument();
  });

  it('the recommend-only guarantee is stated where the proposals are', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Recommendations/ }));
    expect(screen.getByTestId('recommend-only-banner').textContent).toContain(
      'Nothing on this page changes anything in Azure',
    );
  });
});

describe('THE COVERAGE PANEL — the surface admits what it does not know', () => {
  it('names every provenance and its collection state', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const panel = screen.getByTestId('coverage-panel');
    for (const p of ['configured', 'declared', 'imports', 'observed', 'owns']) {
      const row = panel.querySelector(`[data-coverage-provenance="${p}"]`);
      expect(row, `no coverage row for '${p}'`).not.toBeNull();
    }
  });

  it('marks the three uncollected provenances as NOT collected', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const panel = screen.getByTestId('coverage-panel');
    for (const p of ['declared', 'imports', 'observed']) {
      expect(
        panel.querySelector(`[data-coverage-provenance="${p}"]`)!.getAttribute('data-coverage-state'),
      ).toBe('not-collected');
    }
    // ...and the one that WAS collected is marked differently. Without this the
    // panel could be reporting 'not-collected' for everything.
    expect(
      panel.querySelector('[data-coverage-provenance="configured"]')!.getAttribute('data-coverage-state'),
    ).toBe('collected');
  });

  it('shows every detector that DECLINED, with the reason', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const panel = screen.getByTestId('coverage-panel');
    const declined = panel.querySelectorAll('[data-detector-vacuous="true"]');
    expect(declined.length).toBeGreaterThan(0);
    for (const row of Array.from(declined)) {
      expect(within(row as HTMLElement).getByText(/declined/i)).toBeInTheDocument();
      expect(row.textContent).toContain('NOT COLLECTED');
    }
  });

  it('reports every detector population, including the ones with zero findings', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const panel = screen.getByTestId('coverage-panel');
    for (const d of snapshot.detectors) {
      const row = panel.querySelector(`[data-detector="${d.detector}"]`);
      expect(row, `detector '${d.detector}' is missing from the coverage panel`).not.toBeNull();
      expect(row!.textContent!.length).toBeGreaterThan(20);
    }
  });

  it('surfaces the ownership blindness that withholds every proposal', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const bar = screen.getByTestId('ownership-blind');
    expect(bar.textContent).toContain('Ownership is not established');
    expect(bar.textContent).toContain('Do NOT widen the ownership key');
  });

  it('with ownership STAMPED, the blindness banner is gone', () => {
    // The discrimination arm. Without it, a banner hard-coded to always render
    // would satisfy the spec above.
    const owned = snapshotFromCollection(
      collection(estateRows({ ownershipTag: 'estate-under-test' })),
      { estateId: 'estate-under-test' },
    );
    wrap(<BrainPane initialSnapshot={owned} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    expect(screen.queryByTestId('ownership-blind')).toBeNull();
  });

  it('reports what was read — subscriptions, apps, env entries, unreadable secrets', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const panel = screen.getByTestId('coverage-panel');
    expect(panel.textContent).toContain('subscription(s)');
    expect(panel.textContent).toContain('container app(s)');
    expect(panel.textContent).toContain('env entries read');
    // A value that could not be read is named as such, not counted as empty.
    expect(panel.textContent).toContain('secretRef (NOT readable)');
  });
});

describe('an INCOMPLETE read is never rendered as an estate', () => {
  it('shows a hard error banner when the row count disagrees with ARG', () => {
    const partial = snapshotFromCollection({
      rows: estateRows(),
      stats: {
        rowsFetched: estateRows().length,
        totalRecords: 9999,
        pages: 1,
        complete: false,
        subscriptionsSeen: 2,
        durationMs: 5,
        cloud: 'Commercial',
        truncatedByPageCap: false,
      },
    });
    wrap(<BrainPane initialSnapshot={partial} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const bar = screen.getByTestId('incomplete-collection');
    expect(bar.textContent).toContain('INCOMPLETE');
    // The specific false positive it warns about.
    expect(bar.textContent).toContain('unreachable purely because the thing that calls it was not read');
  });

  it('a COMPLETE read shows no such banner', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    expect(screen.queryByTestId('incomplete-collection')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #4278 — the four views have an address
// ──────────────────────────────────────────────────────────────────────────

describe('parseBrainTab — the URL cannot name a view that does not exist', () => {
  it('round-trips every value the renderer switches on', () => {
    for (const t of ['graph', 'synapses', 'recommendations', 'coverage'] as const) {
      expect(parseBrainTab(t)).toBe(t);
    }
  });

  it('falls back to graph on anything unrecognised', () => {
    // A renamed tab, a hand-typed URL, a stale bookmark, a trailing-space
    // paste. None of these may select an undefined view.
    for (const junk of ['perform', 'Graph', 'graph ', '', '../coverage', '1', null, undefined]) {
      expect(parseBrainTab(junk)).toBe('graph');
    }
  });
});

describe('the tab is addressable (#4278)', () => {
  const CASES = [
    { tab: 'graph', tabName: /Graph/, testId: 'brain-canvas' },
    { tab: 'synapses', tabName: /Synapses/, testId: 'synapse-view' },
    { tab: 'recommendations', tabName: /Recommendations/, testId: 'recommendations' },
    { tab: 'coverage', tabName: /Coverage/, testId: 'coverage-panel' },
  ] as const;

  for (const c of CASES) {
    it(`?tab=${c.tab} opens the ${c.tab} view`, () => {
      nav.search = new URLSearchParams(`tab=${c.tab}`);
      wrap(<BrainPane initialSnapshot={snapshot} />);
      expect(screen.getByRole('tab', { name: c.tabName })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByTestId(c.testId)).toBeInTheDocument();
    });
  }

  it('THE RECEIPT ROUTE: /admin/brain?tab=recommendations lands on the findings', () => {
    // This is the case that structurally blocked the G1 receipt.
    // `loom-ui-verify.yml` navigates to a `target_route`; with no route to this
    // view a receipt attempt captured the GRAPH and reported it as the
    // Recommendations surface — verifying something nobody asked about.
    nav.search = new URLSearchParams('tab=recommendations');
    wrap(<BrainPane initialSnapshot={snapshot} />);
    expect(screen.getByTestId('recommendations')).toBeInTheDocument();
    expect(screen.queryByTestId('brain-canvas')).toBeNull();
  });

  it('an unrecognised ?tab= renders the graph rather than nothing', () => {
    nav.search = new URLSearchParams('tab=perform');
    wrap(<BrainPane initialSnapshot={snapshot} />);
    expect(screen.getByRole('tab', { name: /Graph/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('brain-canvas')).toBeInTheDocument();
  });

  it('selecting a tab writes it back with REPLACE, never push', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Recommendations/ }));

    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(String(nav.replace.mock.calls[0]?.[0])).toContain('tab=recommendations');
    // Push would make Back cycle through tabs instead of leaving the page.
    expect(nav.push).not.toHaveBeenCalled();
    // Switching a tab is not a navigation to a new document; jumping to the top
    // would discard the operator's scroll position. Matches the two sibling
    // call sites (`loom-marketplace`, `realtime-intelligence-hub`).
    expect(nav.replace.mock.calls[0]?.[1]).toEqual({ scroll: false });
  });

  it('A STALE SETTLE DOES NOT SNAP THE TAB BACKWARDS', () => {
    /**
     * `router.replace` is asynchronous and under `force-dynamic` carries a
     * server RSC round-trip, so two fast switches can settle out of order. The
     * regression this pins: click Recommendations, click Coverage, then let the
     * FIRST navigation land. Before the `pendingTabRef` guard the effect
     * accepted that stale URL and moved the operator off Coverage — off a view
     * they had chosen — with no input from them.
     */
    const r = wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Recommendations/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    expect(screen.getByRole('tab', { name: /Coverage/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // The FIRST replace() settles late — the URL now names the tab the operator
    // already left.
    nav.search = new URLSearchParams('tab=recommendations');
    rewrap(r, <BrainPane initialSnapshot={snapshot} />);

    // Latest intent wins.
    expect(screen.getByRole('tab', { name: /Coverage/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('coverage-panel')).toBeInTheDocument();

    // And when the SECOND navigation finally lands, the view is unchanged and
    // the pane is following the URL again.
    nav.search = new URLSearchParams('tab=coverage');
    rewrap(r, <BrainPane initialSnapshot={snapshot} />);
    expect(screen.getByRole('tab', { name: /Coverage/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('an EXTERNAL url change is still followed once the write has landed', () => {
    // The guard above must not deafen the pane to Back/forward. Once the
    // pending write settles, a later external change is honoured.
    const r = wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    nav.search = new URLSearchParams('tab=coverage');
    rewrap(r, <BrainPane initialSnapshot={snapshot} />);

    // Back lands on a different tab, with no click of ours.
    nav.search = new URLSearchParams('tab=synapses');
    rewrap(r, <BrainPane initialSnapshot={snapshot} />);
    expect(screen.getByRole('tab', { name: /Synapses/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('preserves any other search params already on the URL', () => {
    nav.search = new URLSearchParams('tab=graph&focusId=abc');
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Coverage/ }));
    const url = String(nav.replace.mock.calls[0]?.[0]);
    expect(url).toContain('tab=coverage');
    expect(url).toContain('focusId=abc');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #4280 — the legend and the provenance chips cannot overlap
// ──────────────────────────────────────────────────────────────────────────

describe('the canvas top strip is ONE flow (#4280)', () => {
  /**
   * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ────────────────────────────────
   * jsdom performs NO layout: every box measures 0x0, so `getBoundingClientRect`
   * cannot see two elements painting over each other. This suite therefore does
   * NOT prove the pixels are fixed — the re-captured browser receipt is the only
   * evidence that can, exactly as `cost-badge-overflow.test.ts` records for the
   * same class of defect.
   *
   * What it DOES prove is that the STRUCTURAL CAUSE is gone and stays gone. The
   * overlap existed because the legend and the chips were two absolutely
   * positioned React Flow `Panel`s (`top-left` and `top-right`) — width-unbounded,
   * so the legend never wrapped, it just grew until it ran under the chips. The
   * assertion below is that they now share ONE panel, i.e. one wrapping flex
   * flow. Split them back into two panels and this goes red.
   */
  it('the legend and the provenance chips live in the SAME react-flow panel', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);

    const legend = screen.getByRole('group', { name: 'Legend' });
    const chips = screen.getByTestId('brain-canvas-provenance');

    const legendPanel = legend.closest('.react-flow__panel');
    const chipsPanel = chips.closest('.react-flow__panel');

    expect(legendPanel).not.toBeNull();
    // Two separately-positioned panels is the defect. One shared panel is the fix.
    expect(legendPanel).toBe(chipsPanel);
  });

  it('both rows are children of the one wrapping strip', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    const strip = screen.getByTestId('brain-canvas-top-strip');
    expect(within(strip).getByRole('group', { name: 'Legend' })).toBeInTheDocument();
    expect(within(strip).getByTestId('brain-canvas-provenance')).toBeInTheDocument();
  });

  /**
   * ── THE TWO BELOW ARE DELETE GUARDS, NOT OVERLAP COVERAGE ─────────────────
   * Named explicitly because the reviewer measured that they PASS on the
   * panel-split mutant: they do not detect the overlap and must never be read
   * as if they do. Their job is narrower and still worth having — the cheap
   * "fix" for two rows colliding is to delete or truncate one of them, and
   * that is what these catch. The structural guard is the first spec in this
   * block; the browser receipt is the visual one.
   */
  it('DELETE GUARD (not overlap): every provenance chip is still rendered', () => {
    wrap(<BrainPane initialSnapshot={snapshot} />);
    const chips = screen.getByTestId('brain-canvas-provenance');
    for (const p of ['configured', 'declared', 'imports', 'observed', 'owns']) {
      expect(chips.textContent).toContain(p);
    }
  });

  it('DELETE GUARD (not overlap): the destructive-class label is not shortened', () => {
    // `Unreachable + always-on` labels the recommendation class whose executor
    // PATCHes minReplicas: 0. It was the worst-hit label in the receipt; it must
    // not be abbreviated or dropped to make the row fit.
    wrap(<BrainPane initialSnapshot={snapshot} />);
    const legend = screen.getByRole('group', { name: 'Legend' });
    expect(legend.textContent).toContain('Unreachable + always-on');
  });
});

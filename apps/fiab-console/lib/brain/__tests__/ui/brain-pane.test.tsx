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

import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { ReactElement } from 'react';
import { BrainPane } from '@/app/admin/brain/brain-pane';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { collection, estateRows } from './estate-fixture';

const snapshot = snapshotFromCollection(collection());

function wrap(ui: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
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

/**
 * NO CONTROL ON THE SYNAPSES VIEW CAN TRIGGER A MUTATION.
 *
 * #3934: "Recommend-only. No control on this surface may execute anything.
 * Approve → draft a proposal for a human. A test must prove no control can
 * trigger a mutation."
 *
 * The bar is higher here than on the Recommendations tab, and deliberately. That
 * tab has a legitimate write — the review POST that records a human decision in
 * the audit stream. This one has NONE. The risk findings it renders are drafted
 * remediations for AUTHORIZATION paths, and PRP §3.7 is explicit: "the Brain
 * reports and drafts; it never patches an authorization path on its own. A wrong
 * autonomous fix to authz is worse than the gap." So the synapses surface is
 * read-only end to end, and this file asserts it four independent ways:
 *
 *   A. NETWORK — drive the surface through its REAL fetch path with a spy that
 *      records every call, click every control, and assert that no request is
 *      anything but a GET and that none reaches an endpoint outside a named,
 *      measured read list. (Two of the three reads on the page are not this
 *      view's — the app shell's flags read and the filter bar's Refresh — and
 *      they are listed rather than filtered out, so a new one fails the test.)
 *   B. LABELS — enumerate every rendered interactive element (not just buttons:
 *      an <a>, a submit input or a menuitem would evade a button-only scan) and
 *      fail on any mutation verb, including `approve`, which is legitimate on
 *      the sibling tab and is NOT legitimate here.
 *   C. FORMS — no `<form action>`, which needs no label at all.
 *   D. SOURCE — a scan of this view's own modules for an Azure write, carrying
 *      an EMBEDDED CONTROL so a broken matcher cannot report clean forever.
 *
 * Each of A-D fails independently. B and C only see what is rendered; D catches
 * a mutation reachable from an effect or a route the UI does not link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { BrainPane } from '@/app/admin/brain/brain-pane';
import { SynapseView } from '@/app/admin/brain/synapse-view';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { buildRiskLayer } from '@/app/api/admin/brain/_lib/risk-layer';
import { loadEdgeHistory } from '@/app/api/admin/brain/_lib/edge-history';
import { NO_SECURITY_GRAPH_REASON } from '@/app/api/admin/brain/_lib/security-source';
import { costByNode } from '@/app/admin/brain/model';
import type { SecurityGraph, SecurityNode } from '@/lib/brain/security';
import { collection } from './estate-fixture';

const snapshot = snapshotFromCollection(collection());

function wrap(ui: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

/**
 * A graph carrying a REAL C1 subject, so the surface has real findings to render.
 *
 * A "no control mutates" scan over a surface showing zero findings is a scan over
 * nothing — the risk cards, their accordions and their focus buttons would never
 * be constructed, and the scan would pass having examined an empty page. That is
 * the population failure this whole program is about, applied to its own test.
 */
function graphWithASubject(): SecurityGraph {
  const authorizer: SecurityNode = {
    id: 'lib/auth/item-gate.ts#allowItemAction',
    kind: 'authorizer',
    provenance: 'declared',
    label: 'allowItemAction',
    facet: {
      kind: 'authorizer',
      fnName: 'allowItemAction',
      params: ['session', 'itemId'],
      resourceScoped: true,
      callerNamedResourceInputs: ['itemId'],
      allowPaths: [
        {
          id: 'allow-1',
          conditionPredicates: ['isTenantAdmin'],
          scopeLiterals: ["opts.itemType === 'lakehouse'"],
          mentionsVerdict: false,
          impliedByOwnsVerdict: false,
          ownsResolver: null,
        },
      ],
      reachesPrivilegedSink: true,
      privilegedSinkKinds: ['adls-posix-acl'],
    },
  };
  return {
    nodes: [authorizer],
    edges: [],
    annotations: { expectedPredicateClusterSize: {} },
    source: 'modelled',
  };
}

const EVALUATED_LAYERS = {
  risk: buildRiskLayer({ available: true, graph: graphWithASubject() }),
  history: loadEdgeHistory(),
};

const UNEVALUATED_LAYERS = {
  risk: buildRiskLayer({ available: false, reason: NO_SECURITY_GRAPH_REASON }),
  history: loadEdgeHistory(),
};

function viewWith(layers: typeof EVALUATED_LAYERS) {
  return (
    <SynapseView
      snapshot={snapshot}
      nodes={snapshot.nodes}
      edges={snapshot.edges}
      costByNodeId={costByNode(snapshot.findings)}
      findingCountByNodeId={new Map()}
      selectedId={null}
      onSelect={() => {}}
      loadLayers={async () => layers}
    />
  );
}

// ---------------------------------------------------------------------------
// The population precondition
// ---------------------------------------------------------------------------

describe('the fixture gives this scan something to examine', () => {
  it('the evaluated layer carries real findings from the real detectors', () => {
    expect(EVALUATED_LAYERS.risk.evaluated).toBe(true);
    if (!EVALUATED_LAYERS.risk.evaluated) throw new Error('unreachable');
    expect(EVALUATED_LAYERS.risk.findings.length).toBeGreaterThan(0);
    expect(
      EVALUATED_LAYERS.risk.findings.some(
        (f) => f.findingClass === 'C1-unauthorized-inbound-edge',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A — the network
// ---------------------------------------------------------------------------

describe('A — every request the page makes while this view is open is a GET', () => {
  /**
   * The reads this page legitimately performs, measured rather than assumed.
   *
   *   /api/runtime-flags     the app shell's own feature-flag read, issued by
   *                          the provider tree, not by this surface.
   *   /api/admin/brain/graph the estate snapshot — re-read by the filter bar's
   *                          Refresh button, which the click-walk below presses.
   *   /api/admin/brain/synapses  this view's own risk + history read.
   *
   * Listed EXPLICITLY so a control that starts calling a fourth endpoint fails
   * here. A test that only checked the method would pass a GET to a route that
   * performs a write behind a read-shaped verb.
   */
  const ALLOWED_READS = new Set([
    '/api/runtime-flags',
    '/api/admin/brain/graph',
    '/api/admin/brain/synapses',
  ]);

  const calls: Array<{ url: string; method: string }> = [];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
      return new Response(
        JSON.stringify({ ok: true, risk: UNEVALUATED_LAYERS.risk, history: UNEVALUATED_LAYERS.history }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('mounting the Synapses tab reads /api/admin/brain/synapses, with GET', async () => {
    // Driven through `BrainPane` with NO injected loader, so this exercises the
    // production fetch path rather than the test seam.
    wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Synapses/ }));

    await waitFor(() => expect(screen.getByTestId('synapse-view')).toBeInTheDocument());
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/admin/brain/synapses')).toBe(true),
    );

    // The positive control above proves the read HAPPENED; this proves how.
    const mine = calls.filter((c) => c.url === '/api/admin/brain/synapses');
    expect(mine.map((c) => c.method)).toEqual(mine.map(() => 'GET'));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('clicking EVERY control adds no non-GET request and reaches no new endpoint', async () => {
    const { container } = wrap(<BrainPane initialSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole('tab', { name: /Synapses/ }));
    await waitFor(() => expect(screen.getByTestId('synapse-panel')).toBeInTheDocument());

    const controls = Array.from(
      container.querySelectorAll(
        'button, a[href], input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="menuitem"]',
      ),
    );
    // POPULATION: a click-walk over zero controls passes having done nothing.
    expect(controls.length).toBeGreaterThan(3);
    for (const c of controls) fireEvent.click(c);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const mutating = calls.filter((c) => c.method !== 'GET');
    expect(
      mutating,
      `the synapses surface issued: ${mutating.map((c) => `${c.method} ${c.url}`).join(', ')}`,
    ).toEqual([]);

    const unexpected = [...new Set(calls.map((c) => c.url))].filter((u) => !ALLOWED_READS.has(u));
    expect(unexpected, `a control reached an unlisted endpoint: ${unexpected.join(', ')}`).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// B + C — the rendered controls
// ---------------------------------------------------------------------------

/**
 * Verbs that would indicate a control does something.
 *
 * `approve` and `dismiss` ARE on this list, unlike the Recommendations tab's
 * scan, because recording a decision about an authorization draft is not a
 * workflow this surface offers. `Show on graph`, `Retry` and `Copy` are not:
 * panning a canvas, re-reading, and writing to a clipboard change nothing.
 */
const MUTATION_VERBS = [
  'apply',
  'approve',
  'execute',
  'run now',
  'delete',
  'remove',
  'scale',
  'stop',
  'restart',
  'deploy',
  'provision',
  'destroy',
  'terminate',
  'fix it',
  'remediate',
  'patch',
  'merge',
  'commit',
];

describe('B — no rendered control on the synapses view carries a mutation verb', () => {
  it('THE CONTROL FOR THIS SCAN: the matcher flags a synthetic control', () => {
    // Runs first. A matcher with a typo'd verb list reports a clean surface
    // forever, and nothing says so.
    for (const label of ['Apply patch', 'Approve remediation', 'Remediate now']) {
      expect(MUTATION_VERBS.some((v) => label.toLowerCase().includes(v))).toBe(true);
    }
    expect(MUTATION_VERBS.some((v) => 'show on graph'.includes(v))).toBe(false);
    expect(MUTATION_VERBS.some((v) => 'retry'.includes(v))).toBe(false);
  });

  it('finds no mutation verb with the risk lane EVALUATED and showing findings', async () => {
    const { container } = wrap(viewWith(EVALUATED_LAYERS));
    await waitFor(() => expect(screen.getAllByTestId('risk-finding').length).toBeGreaterThan(0));

    // Expand every accordion first — a control hidden inside a collapsed panel
    // is a control this scan would otherwise never see.
    for (const h of screen.getAllByRole('button')) fireEvent.click(h);

    const controls = Array.from(
      container.querySelectorAll(
        'button, a[href], input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="menuitem"]',
      ),
    );
    expect(controls.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const c of controls) {
      const label = `${c.textContent ?? ''} ${c.getAttribute('aria-label') ?? ''} ${
        c.getAttribute('href') ?? ''
      }`.toLowerCase();
      for (const verb of MUTATION_VERBS) {
        if (label.includes(verb)) offenders.push(`${label.trim().slice(0, 80)} (matched '${verb}')`);
      }
    }
    expect(offenders, `mutation-verb control(s): ${offenders.join('; ')}`).toEqual([]);
  });

  it('C — there are no forms that could POST anywhere', async () => {
    const { container } = wrap(viewWith(EVALUATED_LAYERS));
    await waitFor(() => expect(screen.getByTestId('synapse-panel')).toBeInTheDocument());
    expect(
      Array.from(container.querySelectorAll('form[action]')).map((f) => f.getAttribute('action')),
    ).toEqual([]);
  });

  it('the drafted remediation renders as TEXT to read, never as an action', async () => {
    wrap(viewWith(EVALUATED_LAYERS));
    await waitFor(() => expect(screen.getAllByTestId('risk-finding').length).toBeGreaterThan(0));

    const headers = screen.getAllByRole('button', { name: /Drafted remediation \(not applied\)/i });
    expect(headers.length).toBeGreaterThan(0);
    fireEvent.click(headers[0]!);

    const patches = screen.getAllByTestId('risk-proposed-patch');
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0]!.tagName.toLowerCase()).toBe('pre');
    expect(headers[0]!.textContent).toContain('not applied');
  });

  it('there is no approve control on this lane at all', async () => {
    wrap(viewWith(EVALUATED_LAYERS));
    await waitFor(() => expect(screen.getAllByTestId('risk-finding').length).toBeGreaterThan(0));
    // The Recommendations tab has one and should. This lane must not: its
    // findings are authorization drafts.
    expect(screen.queryAllByTestId('approve')).toHaveLength(0);
    expect(screen.queryAllByTestId('dismiss')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The honest states are RENDERED, not merely modelled
// ---------------------------------------------------------------------------

describe('a lane that could not be evaluated says so on screen', () => {
  it('the risk lane renders NOT EVALUATED with the reason and the registry size', async () => {
    wrap(viewWith(UNEVALUATED_LAYERS));
    const bar = await screen.findByTestId('risk-not-evaluated');
    expect(bar.textContent).toMatch(/NOT evaluated/i);
    expect(bar.textContent).toMatch(/this is not a clean result/i);
    expect(bar.textContent).toMatch(/9 detector\(s\) registered/);
    expect(bar.textContent).toMatch(/0 examined/);
  });

  it('the growth lane says no history exists and names the work item', async () => {
    wrap(viewWith(UNEVALUATED_LAYERS));
    const bar = await screen.findByTestId('new-not-available');
    expect(bar.textContent).toMatch(/#3935/);
  });

  it('the hot lane distinguishes "no telemetry" from "no traffic"', async () => {
    wrap(viewWith(UNEVALUATED_LAYERS));
    const bar = await screen.findByTestId('hot-not-collected');
    expect(bar.textContent).toMatch(/indistinguishable from "no traffic"/i);
  });

  it('a top-level banner names every lane that drew no verdict', async () => {
    wrap(viewWith(UNEVALUATED_LAYERS));
    const bar = await screen.findByTestId('synapse-partial');
    expect(bar.textContent).toContain('RISK');
    expect(bar.textContent).toContain('HOT PATHS');
    expect(bar.textContent).toContain('GROWTH');
    expect(bar.textContent).toMatch(/not the same as drawing a clean one/i);
  });

  it('the prune lane DOES report, because it was evaluable — the control', async () => {
    // Without this, "every lane says NOT EVALUATED" would satisfy the four specs
    // above and the surface would be uniformly useless rather than honest.
    wrap(viewWith(UNEVALUATED_LAYERS));
    await waitFor(() => expect(screen.getByTestId('lane-prune')).toBeInTheDocument());
    expect(screen.queryByTestId('prune-not-evaluated')).toBeNull();
    expect(screen.getByTestId('lane-prune').textContent).toMatch(/unreachable \+ billing/);
    expect(screen.getByTestId('prune-cost-provenance').textContent).toMatch(/NOT a bill/);
  });
});

// ---------------------------------------------------------------------------
// D — the source scan, with its embedded control
// ---------------------------------------------------------------------------

const MUTATING_VERB = /method:\s*['"`](PUT|PATCH|POST|DELETE)['"`]/i;

const MUTATION_RULES: ReadonlyArray<{ name: string; find: (s: string) => boolean }> = [
  {
    name: 'any non-GET HTTP verb',
    // Order-independent: it does not care what URL is near it. The synapses view
    // has no legitimate write of any kind, so unlike the Recommendations scan
    // there is no allowlist to weaken this.
    find: (src) => MUTATING_VERB.test(src),
  },
  { name: 'az CLI mutation', find: (src) => /\baz\s+\w+\s+(update|delete|create|scale|stop|start)\b/i.test(src) },
  { name: 'ARM write helper', find: (src) => /\barm(Put|Patch|Delete|Post)\s*\(/.test(src) },
  {
    name: 'Azure SDK mutation call',
    find: (src) => /\.(beginCreateOrUpdate|beginDelete|createOrUpdate|deleteMethod)\s*\(/.test(src),
  },
];

function scanForMutations(source: string): string[] {
  return MUTATION_RULES.filter((r) => r.find(source)).map((r) => r.name);
}

describe('D — the synapse modules contain no write of any kind', () => {
  const files = [
    join(process.cwd(), 'app', 'admin', 'brain', 'synapse-model.ts'),
    join(process.cwd(), 'app', 'admin', 'brain', 'synapse-panel.tsx'),
    join(process.cwd(), 'app', 'admin', 'brain', 'synapse-view.tsx'),
    join(process.cwd(), 'app', 'api', 'admin', 'brain', 'synapses', 'route.ts'),
    join(process.cwd(), 'app', 'api', 'admin', 'brain', '_lib', 'risk-layer.ts'),
    join(process.cwd(), 'app', 'api', 'admin', 'brain', '_lib', 'security-source.ts'),
    join(process.cwd(), 'app', 'api', 'admin', 'brain', '_lib', 'edge-history.ts'),
    join(process.cwd(), 'app', 'api', 'admin', 'brain', '_lib', 'synapse-wire.ts'),
  ];

  it('THE CONTROL: the scanner flags a synthetic write, in either order', () => {
    expect(scanForMutations(`await fetch(url, { method: 'DELETE' })`)).not.toEqual([]);
    expect(scanForMutations(`await fetch(url, { method: 'POST' })`)).not.toEqual([]);
    expect(scanForMutations(`await fetch('/x', { body: b, method: 'PATCH' })`)).not.toEqual([]);
    expect(scanForMutations(`await exec('az containerapp update --min-replicas 0')`)).not.toEqual([]);
    expect(scanForMutations(`await armPut(id, body)`)).not.toEqual([]);
    expect(scanForMutations(`await client.beginDelete(rg, name)`)).not.toEqual([]);
    // …and does not flag the read this view actually performs.
    expect(scanForMutations(`await fetch('/api/admin/brain/synapses', { cache: 'no-store' })`)).toEqual([]);
  });

  it('every file this view ships exists and was read', () => {
    // POPULATION: a scan over a mistyped path list is green and blind.
    for (const f of files) expect(readFileSync(f, 'utf8').length).toBeGreaterThan(200);
    expect(files.length).toBe(8);
  });

  it('finds no write in any of them', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const hits = scanForMutations(readFileSync(f, 'utf8'));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(', ')}`);
    }
    expect(offenders, `write found on the synapses surface: ${offenders.join(' | ')}`).toEqual([]);
  });
});

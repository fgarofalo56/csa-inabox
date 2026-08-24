/**
 * "UNREACHABLE NODES AND DANGLING EDGES ARE VISUALLY DISTINCT" — PRP §3.6,
 * asserted at both the model layer and the rendered DOM.
 *
 * ── WHY BOTH LAYERS ────────────────────────────────────────────────────────
 * A model test alone proves the decision is made; it does not prove the
 * decision reaches the screen. A DOM test alone is brittle and, worse, easy to
 * satisfy trivially — jsdom resolves a CSS custom property to the literal
 * string `var(--loom-accent-red)`, so a naive "the colour is red" assertion
 * passes even if every state shares one colour.
 *
 * So the model layer asserts PAIRWISE DISTINCTNESS — that the states differ
 * from each other — rather than asserting today's constants. Pinning constants
 * would pass a refactor that made two states identical; pinning distinctness
 * cannot.
 *
 * ── THE DISTINCTION IS CARRIED ON THREE CHANNELS ───────────────────────────
 * accent, status dot, and badge — plus the red error ring for the one state
 * that costs money. Redundant on purpose: a colour-only distinction fails for a
 * colour-blind operator and dies to one CSS regression. The dangling edge
 * likewise gets colour AND a dash pattern AND a label.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { ReactFlowProvider } from '@xyflow/react';
import type { ComponentProps, ReactElement } from 'react';
import { BrainCanvasNode } from '@/app/admin/brain/brain-canvas-node';
import { edgeVisual, nodeVisual, layoutNodes, type NodeVisualState } from '@/app/admin/brain/model';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import type { WireEdge, WireNode } from '@/app/api/admin/brain/_lib/wire';
import { BROKER_ID, CONSOLE_ID, DIRECTLAKE_ID, MIGRATE_ID, collection } from './estate-fixture';

const snapshot = snapshotFromCollection(collection());
const COVERED = snapshot.coverage.configured.collected;

const broker = snapshot.nodes.find((n) => n.id === BROKER_ID)!;
const healthy = snapshot.nodes.find((n) => n.id === DIRECTLAKE_ID)!;
const idleUnreachable = snapshot.nodes.find((n) => n.id === MIGRATE_ID)!;
const external = snapshot.nodes.find((n) => n.id === CONSOLE_ID)!;

function wrap(ui: ReactElement) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ReactFlowProvider>{ui}</ReactFlowProvider>
    </FluentProvider>,
  );
}

/**
 * Mount one canvas node.
 *
 * React Flow's `NodeProps` carries a dozen fields the renderer never reads
 * (drag state, absolute position, connectability). They are built here as a
 * plain object and cast ONCE, rather than spread from a `never` — a spread of
 * `never` is not even well-typed, and it hid the shape of what the test was
 * actually passing.
 */
function renderNode(node: WireNode) {
  const props = {
    id: node.id,
    type: 'brain',
    selected: false,
    zIndex: 0,
    isConnectable: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    data: { node, coverageConfigured: COVERED, findingCount: 0, derivedCostUsd: null },
  } as unknown as ComponentProps<typeof BrainCanvasNode>;
  return wrap(<BrainCanvasNode {...props} />);
}

describe('the fixture produced the four states this suite compares', () => {
  it('has an unreachable always-on node, a wired node, an idle-unreachable node and an external one', () => {
    // Without this, every "they differ" assertion below could be comparing
    // undefined with undefined.
    expect(broker).toBeDefined();
    expect(healthy).toBeDefined();
    expect(idleUnreachable).toBeDefined();
    expect(external).toBeDefined();
    expect(nodeVisual(broker, COVERED).state).toBe('unreachable-always-on');
    expect(nodeVisual(healthy, COVERED).state).not.toBe('unreachable-always-on');
  });
});

describe('MODEL — the states are pairwise distinct, not merely labelled', () => {
  const states: NodeVisualState[] = [
    'unreachable-always-on',
    'unreachable-idle',
    'scale-unknown',
    'reachability-not-evaluable',
    'reachable-always-on',
    'reachable',
  ];

  // Build one representative node per state by construction, so the comparison
  // does not depend on the fixture happening to contain all six.
  function nodeInState(state: NodeVisualState): WireNode {
    const base: WireNode = {
      ...broker,
      id: `synthetic:${state}`,
      tags: {},
      inboundByProvenance: { configured: 0, declared: 0, imports: 0, observed: 0, owns: 0 },
      outboundTotal: 0,
      unreachableConfigured: true,
      alwaysOn: true,
      scaleMeasured: true,
      ownershipConfirmed: false,
      danglingIntendedFor: 0,
    };
    switch (state) {
      case 'unreachable-always-on':
        return base;
      case 'unreachable-idle':
        return { ...base, alwaysOn: false };
      case 'scale-unknown':
        return { ...base, scaleMeasured: false, scale: undefined };
      case 'reachability-not-evaluable':
        return { ...base, ingress: { external: true, fqdn: 'x.example.test' } };
      case 'reachable-always-on':
        return {
          ...base,
          unreachableConfigured: false,
          inboundByProvenance: { ...base.inboundByProvenance, configured: 1 },
        };
      default:
        return {
          ...base,
          alwaysOn: false,
          unreachableConfigured: false,
          inboundByProvenance: { ...base.inboundByProvenance, configured: 1 },
        };
    }
  }

  it('each state resolves to the state it was built for', () => {
    for (const st of states) {
      expect(nodeVisual(nodeInState(st), COVERED).state, `built for ${st}`).toBe(st);
    }
  });

  it('no two states share an accent colour', () => {
    const accents = states.map((st) => nodeVisual(nodeInState(st), COVERED).accent);
    expect(new Set(accents).size, `accents collided: ${accents.join(', ')}`).toBe(states.length);
  });

  it('the unreachable+always-on state is the ONLY one drawn with the error ring', () => {
    const withError = states.filter((st) => nodeVisual(nodeInState(st), COVERED).error);
    expect(withError).toEqual(['unreachable-always-on']);
  });

  it('the three problem states carry a badge and the healthy state does not', () => {
    expect(nodeVisual(nodeInState('unreachable-always-on'), COVERED).badge).toBe('Unreachable');
    expect(nodeVisual(nodeInState('unreachable-idle'), COVERED).badge).toBe('No consumer');
    expect(nodeVisual(nodeInState('scale-unknown'), COVERED).badge).toBe('Scale unknown');
    expect(nodeVisual(nodeInState('reachable'), COVERED).badge).toBeNull();
  });

  it('every state explains itself in prose, for the tooltip and the details header', () => {
    for (const st of states) {
      const r = nodeVisual(nodeInState(st), COVERED).reason;
      expect(r.length, `${st} has no reason`).toBeGreaterThan(20);
    }
  });

  it('with `configured` UNCOLLECTED, NOTHING is painted unreachable', () => {
    // The vacuous-truth guard at the visual layer: over a graph with no
    // configured edges, `unreachableConfigured` is true of every node, and a
    // canvas that trusted the flag alone would go entirely red.
    for (const st of states) {
      const v = nodeVisual(nodeInState(st), /* coverageConfigured */ false);
      expect(v.state, `${st} was painted as a problem with no coverage`).not.toBe(
        'unreachable-always-on',
      );
      expect(v.error).toBe(false);
      expect(v.reason).toContain('NOT EVALUATED');
    }
  });
});

describe('DOM — an unreachable node renders differently from a healthy one', () => {
  it('the unreachable always-on node carries its state, badge and accent in the DOM', () => {
    const { container } = renderNode(broker);
    const el = container.querySelector('[data-brain-state]')!;
    expect(el.getAttribute('data-brain-state')).toBe('unreachable-always-on');
    expect(el.getAttribute('data-brain-unreachable')).toBe('true');
    expect(el.getAttribute('data-brain-always-on')).toBe('true');
    expect(el.getAttribute('data-brain-badge')).toBe('Unreachable');
    expect(el.getAttribute('data-brain-accent')).toContain('red');
    // The reason is on the tooltip, so hovering explains the colour.
    expect(el.getAttribute('title')).toContain('bills every second');
    // And the badge is actually rendered as text, not only as an attribute.
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
  });

  it('the healthy node renders a DIFFERENT state, accent and badge', () => {
    const { container } = renderNode(healthy);
    const el = container.querySelector('[data-brain-state]')!;
    const state = el.getAttribute('data-brain-state');
    const accent = el.getAttribute('data-brain-accent');

    expect(state).not.toBe('unreachable-always-on');
    expect(el.getAttribute('data-brain-unreachable')).toBe('false');

    // The comparison that matters: re-render the unreachable one and require the
    // two DOMs to differ on all three channels.
    const brokerDom = renderNode(broker).container.querySelector('[data-brain-state]')!;
    expect(state).not.toBe(brokerDom.getAttribute('data-brain-state'));
    expect(accent).not.toBe(brokerDom.getAttribute('data-brain-accent'));
    expect(el.getAttribute('data-brain-badge')).not.toBe(brokerDom.getAttribute('data-brain-badge'));
  });

  it('an unreachable-but-idle node is distinct from BOTH', () => {
    // Three-way: the surface must not collapse "costing money" into "unused".
    const a = renderNode(broker).container.querySelector('[data-brain-state]')!.getAttribute('data-brain-state');
    const b = renderNode(idleUnreachable).container.querySelector('[data-brain-state]')!.getAttribute('data-brain-state');
    const c = renderNode(healthy).container.querySelector('[data-brain-state]')!.getAttribute('data-brain-state');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('DANGLING EDGES are visually distinct on three channels', () => {
  const dangling = snapshot.edges.find((e) => e.resolution === 'dangling')!;
  const resolved = snapshot.edges.find((e) => e.resolution === 'resolved')!;

  it('the fixture has one of each (otherwise the comparison is vacuous)', () => {
    expect(dangling).toBeDefined();
    expect(resolved).toBeDefined();
  });

  it('colour, dash and label all differ from a resolved edge', () => {
    const d = edgeVisual(dangling);
    const r = edgeVisual(resolved);
    expect(d.stroke).not.toBe(r.stroke);
    expect(d.stroke).toContain('red');
    expect(d.dashed).toBe(true);
    expect(r.dashed).toBe(false);
    expect(d.label).toBeTruthy();
    expect(r.label).toBeNull();
  });

  it("the label names the symbol and shows the empty value as ''", () => {
    const empty = snapshot.edges.find(
      (e): e is WireEdge => e.resolution === 'dangling' && e.danglingReason === 'empty-value',
    )!;
    const v = edgeVisual(empty);
    expect(v.label).toContain(empty.evidence.symbol!);
    expect(v.label).toContain("''");
  });
});

describe('LAYOUT groups the problem states into their own columns', () => {
  it('every unreachable always-on node shares one x column, distinct from the healthy one', () => {
    const positions = new Map(layoutNodes(snapshot.nodes, COVERED).map((p) => [p.id, p]));
    const brokerX = positions.get(BROKER_ID)!.x;
    const healthyX = positions.get(DIRECTLAKE_ID)!.x;
    expect(brokerX).not.toBe(healthyX);
    // ...and the problem column is leftmost, so it is read first.
    expect(brokerX).toBeLessThan(healthyX);
  });

  it('is deterministic — two runs place every node identically', () => {
    // A force layout would reshuffle on every refresh, making two screenshots of
    // the same estate incomparable.
    const a = layoutNodes(snapshot.nodes, COVERED);
    const b = layoutNodes(snapshot.nodes, COVERED);
    expect(a).toEqual(b);
  });
});

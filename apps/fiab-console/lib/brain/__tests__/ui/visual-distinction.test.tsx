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
import { allocateTerminusPositions } from '@/app/admin/brain/brain-canvas';
import {
  DANGLING_TERMINUS_HEIGHT,
  DANGLING_TERMINUS_WIDTH,
  edgeVisual,
  layoutNodes,
  layoutSpread,
  MIN_LEGIBLE_ZOOM,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeVisual,
  type NodeVisualState,
} from '@/app/admin/brain/model';
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

// ---------------------------------------------------------------------------
// #4251 — LEGIBILITY AT ESTATE SCALE
// ---------------------------------------------------------------------------

/**
 * 112 nodes in three visual states, cloned from the real fixture nodes so
 * `nodeVisual` classifies them the same way production does.
 *
 * The count is the measured one: the live default view rendered 112 nodes, and a
 * layout that is fine at nine and illegible at 112 is exactly the failure this
 * suite exists to catch.
 */
function estateScaleNodes(): WireNode[] {
  const out: WireNode[] = [];
  const templates = [broker, healthy, idleUnreachable];
  for (let i = 0; i < 112; i += 1) {
    const t = templates[i % templates.length];
    out.push({
      ...t,
      id: `${t.id}-clone-${String(i).padStart(3, '0')}`,
      displayName: `${t.displayName}-${String(i).padStart(3, '0')}`,
    } as WireNode);
  }
  return out;
}

describe('#4251 — the default view is LEGIBLE at estate scale', () => {
  // The measured viewport of the live canvas at the default window size.
  const CONTAINER = { width: 894, height: 512 };

  it('EMBEDDED CONTROL: the fixture really is 112 nodes across 3 states', () => {
    const nodes = estateScaleNodes();
    expect(nodes.length).toBe(112);
    const states = new Set(nodes.map((n) => nodeVisual(n, COVERED).state));
    expect(states.size).toBe(3);
  });

  it('THE DEFECT: one column per state fits at scale 0.2 — unreadable', () => {
    // The pre-fix behaviour, still reachable by omitting the container. Asserted
    // rather than described so the improvement below is measured against a
    // number this file computes, not against a number in a commit message.
    const spread = layoutSpread(layoutNodes(estateScaleNodes(), COVERED));
    const fit = Math.min(CONTAINER.width / spread.width, CONTAINER.height / spread.height);
    expect(fit).toBeLessThan(0.25);
  });

  it('THE FIX: the spread APPROXIMATES the container aspect, and the fit improves', () => {
    // ── WHY THE TARGET IS NOT "fit >= 0.5" ─────────────────────────────────
    //
    // #4251 proposed asserting `min(W/spreadW, H/spreadH) >= 0.5`. That is
    // arithmetically unreachable and the arithmetic is worth recording rather
    // than quietly weakening the number: 112 nodes at 180x76 is 1,532,160 px² of
    // NODE AREA alone, against an 894x512 = 457,728 px² viewport. Even a perfect
    // zero-gutter packing tops out at sqrt(457728 / 1532160) = 0.55, and any
    // gutter at all puts it below 0.5. A layout that met the number would have
    // to make the boxes smaller, which is the defect, not the fix.
    //
    // So the fix is the one the issue's own layout item describes — wrap each
    // bucket so the SPREAD approximates the container's aspect — plus the
    // legibility FLOOR asserted below, which stops `fitView` shrinking past
    // readable and lets the operator pan. Measured: 0.20 -> 0.33.
    const spread = layoutSpread(
      layoutNodes(estateScaleNodes(), COVERED, { container: CONTAINER }),
    );
    const fit = Math.min(CONTAINER.width / spread.width, CONTAINER.height / spread.height);
    expect(fit).toBeGreaterThan(0.3);

    const containerAspect = CONTAINER.width / CONTAINER.height;
    const spreadAspect = spread.width / spread.height;
    // Within a factor of two of the viewport's shape — the 7x60 tower the fixed
    // grid produced is a factor of TWELVE out, which is where the 0.2 came from.
    expect(spreadAspect).toBeGreaterThan(containerAspect / 2);
    expect(spreadAspect).toBeLessThan(containerAspect * 2);
  });

  it('THE FLOOR: at MIN_LEGIBLE_ZOOM a node renders far above the measured 36x15', () => {
    // The operator-visible outcome. `fitView` chose 0.2 live, so the node box
    // came out 36x15 css px — label unreadable, status dot sub-pixel. The floor
    // is what makes the initial view readable; the layout above is what makes
    // the panning sane.
    expect(NODE_WIDTH * MIN_LEGIBLE_ZOOM).toBeGreaterThan(90);
    expect(NODE_HEIGHT * MIN_LEGIBLE_ZOOM).toBeGreaterThan(38);
    // …and the manual floor is still lower, so zooming out to see the whole
    // shape remains possible. Collapsing the two would remove a working control.
    expect(MIN_LEGIBLE_ZOOM).toBeGreaterThan(0.2);
  });

  it('still DETERMINISTIC — two runs at the same container size are identical', () => {
    const a = layoutNodes(estateScaleNodes(), COVERED, { container: CONTAINER });
    const b = layoutNodes(estateScaleNodes(), COVERED, { container: CONTAINER });
    expect(a).toEqual(b);
  });

  it('the problem state is STILL leftmost — wrapping did not reorder the states', () => {
    const positions = new Map(
      layoutNodes(estateScaleNodes(), COVERED, { container: CONTAINER }).map((p) => [p.id, p]),
    );
    const unreachableXs = estateScaleNodes()
      .filter((n) => nodeVisual(n, COVERED).state === 'unreachable-always-on')
      .map((n) => positions.get(n.id)!.x);
    const reachableXs = estateScaleNodes()
      .filter((n) => nodeVisual(n, COVERED).state === 'reachable')
      .map((n) => positions.get(n.id)!.x);
    expect(Math.max(...unreachableXs)).toBeLessThan(Math.min(...reachableXs));
  });

  it('no two node boxes overlap', () => {
    const positions = layoutNodes(estateScaleNodes(), COVERED, { container: CONTAINER });
    expect(overlappingPairs(positions.map((p) => box(p, NODE_WIDTH, NODE_HEIGHT)))).toEqual([]);
  });
});

/** An axis-aligned box, for the overlap assertions. */
function box(
  p: { readonly id?: string; readonly x: number; readonly y: number },
  w: number,
  h: number,
) {
  return { id: p.id ?? '', x: p.x, y: p.y, w, h };
}

/** Every pair of boxes that share area. Empty is the only acceptable answer. */
function overlappingPairs(
  boxes: readonly { id: string; x: number; y: number; w: number; h: number }[],
): string[] {
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlapX && overlapY) hits.push(`${a.id} ∩ ${b.id}`);
    }
  }
  return hits;
}

describe('#4251 — dangling termini do not overlap anything', () => {
  /** N dangling edges out of ONE source — the fan-out the old 4px step stacked. */
  function danglingFrom(sourceId: string, n: number): WireEdge[] {
    const template = snapshot.edges.find((e): e is WireEdge => e.resolution === 'dangling')!;
    return Array.from({ length: n }, (_, i) => ({
      ...template,
      id: `${template.id}-fan-${i}`,
      from: sourceId,
    })) as WireEdge[];
  }

  it('EMBEDDED CONTROL: the fixture really produces N dangling edges from one source', () => {
    const edges = danglingFrom(BROKER_ID, 8);
    expect(edges).toHaveLength(8);
    expect(edges.every((e) => e.resolution === 'dangling' && e.from === BROKER_ID)).toBe(true);
  });

  it('8 termini from one source occupy 8 non-overlapping boxes', () => {
    const positions = new Map(
      layoutNodes(snapshot.nodes, COVERED).map((p) => [p.id, { x: p.x, y: p.y }]),
    );
    const placed = allocateTerminusPositions(danglingFrom(BROKER_ID, 8), positions);
    expect(placed.size).toBe(8);
    const boxes = [...placed.entries()].map(([id, p]) =>
      box({ id, ...p }, DANGLING_TERMINUS_WIDTH, DANGLING_TERMINUS_HEIGHT),
    );
    expect(overlappingPairs(boxes)).toEqual([]);
  });

  it('no terminus box intersects a NODE box', () => {
    const laid = layoutNodes(snapshot.nodes, COVERED);
    const positions = new Map(laid.map((p) => [p.id, { x: p.x, y: p.y }]));
    // Every source in the graph fans out, so the lanes are as crowded as they
    // can get — the case a per-source counter alone would not survive.
    const edges = snapshot.nodes.flatMap((n) => danglingFrom(n.id, 4));
    const placed = allocateTerminusPositions(edges, positions);
    const nodeBoxes = laid.map((p) => box(p, NODE_WIDTH, NODE_HEIGHT));
    const terminusBoxes = [...placed.entries()].map(([id, p]) =>
      box({ id, ...p }, DANGLING_TERMINUS_WIDTH, DANGLING_TERMINUS_HEIGHT),
    );
    expect(overlappingPairs([...nodeBoxes, ...terminusBoxes])).toEqual([]);
  });
});

/**
 * THE SYNAPSE DISTINCTION REACHES THE DOM — and the Graph tab is untouched.
 *
 * `synapse-distinction.test.ts` proves the DECISION is made. This file proves it
 * arrives on screen, which is a separate claim: a model can be perfect and the
 * renderer can drop it, and on 2026-07-15 a change that passed every model-level
 * gate hard-froze the live renderer.
 *
 * It also carries the NEGATIVE control the overlay needs: with no synapse mark,
 * the node must render exactly as it did before this layer existed. Without that
 * assertion, an overlay that painted every node in every tab would satisfy every
 * positive test here.
 *
 * ── STILL NOT A COMPLETION RECEIPT ─────────────────────────────────────────
 * This is jsdom. Per `ux-baseline.md` G1 a rendering test is not an E2E, and no
 * in-browser walk has been run against a live estate. The PR body says so in
 * those words.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { ReactFlowProvider } from '@xyflow/react';
import type { ComponentProps, ReactElement } from 'react';
import { BrainCanvasNode } from '@/app/admin/brain/brain-canvas-node';
import { buildSynapseOverlay, type SynapseNodeMark } from '@/app/admin/brain/synapse-model';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import type { WireNode } from '@/app/api/admin/brain/_lib/wire';
import { BROKER_ID, DIRECTLAKE_ID, collection } from './estate-fixture';

const snapshot = snapshotFromCollection(collection());
const COVERED = snapshot.coverage.configured.collected;
const overlay = buildSynapseOverlay({
  snapshot,
  nodes: snapshot.nodes,
  edges: snapshot.edges,
  risk: null,
  history: null,
});

const broker = snapshot.nodes.find((n) => n.id === BROKER_ID)!;
const healthy = snapshot.nodes.find((n) => n.id === DIRECTLAKE_ID)!;

function wrap(ui: ReactElement) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ReactFlowProvider>{ui}</ReactFlowProvider>
    </FluentProvider>,
  );
}

/**
 * Mount one canvas node, with or without a synapse mark.
 *
 * React Flow's `NodeProps` carries a dozen fields the renderer never reads. They
 * are built here as a plain object and cast ONCE, matching the sibling suite,
 * rather than spread from a `never` — which is not well-typed and hides the
 * shape of what the test is actually passing.
 */
function renderNode(node: WireNode, synapse?: SynapseNodeMark) {
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
    data: {
      node,
      coverageConfigured: COVERED,
      findingCount: 0,
      derivedCostUsd: null,
      ...(synapse ? { synapse } : {}),
    },
  } as unknown as ComponentProps<typeof BrainCanvasNode>;
  return wrap(<BrainCanvasNode {...props} />);
}

function shell(id: string): HTMLElement {
  const el = document.querySelector(`[data-brain-node-id="${id}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no rendered node for ${id}`);
  return el;
}

describe('the overlay produced the two marks this suite compares', () => {
  it('the broker is a costly prune candidate and the control is not', () => {
    // Without this, every "they differ" assertion below could be comparing
    // undefined with undefined.
    expect(overlay.nodeMarks.get(BROKER_ID)?.layer).toBe('prune-costly');
    expect(overlay.nodeMarks.get(DIRECTLAKE_ID)?.layer).toBe('quiet');
  });
});

describe('DOM — the synapse layer is observable on the rendered node', () => {
  it('a prune candidate carries its layer, its width and its ring', () => {
    renderNode(broker, overlay.nodeMarks.get(BROKER_ID)!);
    const el = shell(BROKER_ID);
    expect(el.getAttribute('data-synapse-layer')).toBe('prune-costly');
    expect(el.getAttribute('data-synapse-ring')).toBe('true');
    const width = Number(el.getAttribute('data-synapse-width'));
    expect(width).toBeGreaterThanOrEqual(160);
    expect(width).toBeLessThanOrEqual(190);
  });

  it('a healthy node renders differently on layer, accent, badge AND ring', () => {
    renderNode(broker, overlay.nodeMarks.get(BROKER_ID)!);
    const b = {
      layer: shell(BROKER_ID).getAttribute('data-synapse-layer'),
      accent: shell(BROKER_ID).getAttribute('data-brain-accent'),
      badge: shell(BROKER_ID).getAttribute('data-brain-badge'),
      ring: shell(BROKER_ID).getAttribute('data-synapse-ring'),
    };
    document.body.innerHTML = '';

    renderNode(healthy, overlay.nodeMarks.get(DIRECTLAKE_ID)!);
    const h = {
      layer: shell(DIRECTLAKE_ID).getAttribute('data-synapse-layer'),
      accent: shell(DIRECTLAKE_ID).getAttribute('data-brain-accent'),
      badge: shell(DIRECTLAKE_ID).getAttribute('data-brain-badge'),
      ring: shell(DIRECTLAKE_ID).getAttribute('data-synapse-ring'),
    };

    expect(b.layer).not.toBe(h.layer);
    expect(b.accent).not.toBe(h.accent);
    expect(b.badge).not.toBe(h.badge);
    expect(b.ring).not.toBe(h.ring);
  });

  it('the badge is rendered, and it is exactly ONE', () => {
    renderNode(broker, overlay.nodeMarks.get(BROKER_ID)!);
    expect(screen.getAllByText('Prune')).toHaveLength(1);
    // The reachability badge does NOT also appear — two badges on one node is
    // the overlap `ux-baseline.md` names as a defect.
    expect(screen.queryByText('Unreachable')).toBeNull();
  });

  it('the reason survives to the tooltip, so the colour has a finding behind it', () => {
    renderNode(broker, overlay.nodeMarks.get(BROKER_ID)!);
    expect(shell(BROKER_ID).getAttribute('title')).toMatch(/inbound configured/i);
  });
});

describe('THE CONTROL — with no synapse mark the node is untouched', () => {
  it('emits no synapse attributes at all', () => {
    // The Graph tab. If the overlay leaked into it, every positive assertion
    // above would still pass and the plain graph would be silently repainted.
    renderNode(broker);
    const el = shell(BROKER_ID);
    expect(el.getAttribute('data-synapse-layer')).toBeNull();
    expect(el.getAttribute('data-synapse-width')).toBeNull();
    expect(el.getAttribute('data-synapse-ring')).toBeNull();
  });

  it('and still shows the reachability badge the Graph tab has always shown', () => {
    renderNode(broker);
    expect(screen.getAllByText('Unreachable')).toHaveLength(1);
    expect(screen.queryByText('Prune')).toBeNull();
  });
});

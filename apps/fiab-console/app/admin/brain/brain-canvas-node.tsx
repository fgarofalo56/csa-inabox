'use client';

/**
 * LOOM BRAIN VISUALIZER — the canvas node.
 *
 * Built on the shared `CanvasNode` from `@/lib/components/canvas/canvas-node-kit`
 * rather than hand-rolled, per `ux-baseline.md` (a hand-built node with no
 * accent bar, no status dot and no selection glow is explicitly forbidden). That
 * also buys the compactness rules for free: ~180px wide, two rows, at most one
 * on-node badge, actions on hover only.
 *
 * ── THE `data-brain-state` ATTRIBUTE IS PART OF THE CONTRACT ───────────────
 * It is not a test hook bolted on. `visual-distinction.test.ts` asserts that an
 * unreachable always-on node and a healthy one differ, and asserting that on
 * COLOUR alone would be a weak test — a computed style in jsdom is a CSS var
 * string, and two states could share it after an innocent refactor without
 * anything failing. The attribute makes the state machine observable, and the
 * test additionally asserts the accent and the badge differ, so the distinction
 * has to survive on three channels at once.
 */

import * as React from 'react';
// React 19 removed the GLOBAL JSX namespace, so `JSX.Element` no longer
// resolves ambiently. `canvas-node-kit` types `CanvasVisual.icon` as
// `JSX.Element` and imports the namespace explicitly for the same reason;
// matching that import keeps this file assignable to its contract rather than
// widening the icon type here.
import type { JSX } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Cloud20Regular,
  Database20Regular,
  DocumentText20Regular,
  PlugDisconnected20Regular,
  Server20Regular,
} from '@fluentui/react-icons';
import { CanvasNode, type CanvasVisual } from '@/lib/components/canvas/canvas-node-kit';
import type { WireNode } from '@/app/api/admin/brain/_lib/wire';
import { nodeVisual, type NodeVisualState } from './model';

/** Data carried on each React Flow node. */
export interface BrainNodeData extends Record<string, unknown> {
  readonly node: WireNode;
  readonly coverageConfigured: boolean;
  readonly findingCount: number;
  /** Derived cost attributed to this node, or null when nothing priced it. */
  readonly derivedCostUsd: number | null;
}

function glyphFor(state: NodeVisualState, kind: WireNode['kind']): JSX.Element {
  if (state === 'unreachable-always-on' || state === 'unreachable-idle') {
    return <PlugDisconnected20Regular />;
  }
  switch (kind) {
    case 'deploy-artifact':
      return <DocumentText20Regular />;
    case 'code-module':
      return <DocumentText20Regular />;
    case 'loom-item':
      return <Database20Regular />;
    default:
      return <Server20Regular />;
  }
}

/** Short type label — the ARM provider prefix is noise at node size. */
export function shortType(resourceType: string | undefined, kind: WireNode['kind']): string {
  if (!resourceType) return kind;
  const tail = resourceType.split('/').slice(1).join('/');
  return tail || resourceType;
}

function BrainCanvasNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as BrainNodeData;
  const v = nodeVisual(d.node, d.coverageConfigured);

  const visual: CanvasVisual = {
    icon: glyphFor(v.state, d.node.kind),
    // `external` is the neutral category; the accent below overrides its tint,
    // so the category only selects the gradient shape.
    category: 'external',
    accent: v.accent,
  };

  // ONE badge (ux-baseline node compactness). Cost and finding counts are richer
  // signals but they go to the tooltip + the details panel — stacking them on
  // the node is exactly the overlap the rule forbids.
  const badge = v.badge;

  const description =
    d.derivedCostUsd !== null
      ? `~$${d.derivedCostUsd.toFixed(2)}/30d (derived)`
      : d.findingCount > 0
        ? `${d.findingCount} finding${d.findingCount === 1 ? '' : 's'}`
        : undefined;

  return (
    <div
      // The observable state machine — see the doc-block.
      data-brain-state={v.state}
      data-brain-node-id={d.node.id}
      data-brain-unreachable={String(d.node.unreachableConfigured)}
      data-brain-always-on={String(d.node.alwaysOn)}
      data-brain-accent={v.accent}
      data-brain-badge={badge ?? ''}
      title={v.reason}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <CanvasNode
        title={d.node.displayName}
        visual={visual}
        selected={selected}
        status={v.status}
        error={v.error}
        typeLabel={shortType(d.node.resourceType, d.node.kind)}
        {...(description ? { description } : {})}
        {...(badge
          ? {
              badges: (
                <span
                  data-brain-badge-text={badge}
                  style={{
                    // flexWrap + minWidth:0 live on CanvasNode's badge row; this
                    // span only ever holds one short label, and it truncates.
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {badge}
                </span>
              ),
            }
          : {})}
      />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export const BrainCanvasNode = React.memo(BrainCanvasNodeImpl);

/**
 * The terminus a DANGLING edge points at.
 *
 * A dangling edge has `to: null` by construction, so React Flow — which
 * requires both endpoints — has nothing to connect it to. The alternative would
 * be to drop those edges from the canvas, which would silently delete the
 * single most important thing this surface renders. So each one gets a small
 * explicit "nowhere" terminus, drawn so it cannot be mistaken for a resource.
 */
function DanglingTerminusImpl({ data }: NodeProps) {
  const d = data as { readonly reason?: string; readonly symbol?: string };
  return (
    <div
      data-brain-state="dangling-terminus"
      data-brain-dangling-reason={d.reason ?? ''}
      title={`This wire resolves to nothing (${d.reason ?? 'unresolved'}). It does NOT make its intended target reachable.`}
      style={{
        width: '128px',
        padding: 'var(--loom-space-2)',
        border: '1px dashed var(--loom-accent-red)',
        borderRadius: 'var(--loom-radius-md, 6px)',
        background: 'transparent',
        color: 'var(--loom-accent-red)',
        fontSize: '11px',
        textAlign: 'center',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Cloud20Regular style={{ verticalAlign: 'middle', marginRight: '4px' }} />
      nothing
    </div>
  );
}

export const DanglingTerminus = React.memo(DanglingTerminusImpl);

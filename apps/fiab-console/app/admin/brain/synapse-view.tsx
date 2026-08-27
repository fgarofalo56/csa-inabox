'use client';

/**
 * LOOM BRAIN — THE SYNAPSES VIEW (#3934).
 *
 * The security and pruning layer rendered ONTO the architecture graph, so an
 * admin sees waste and risk in the same picture as the wiring. Operator framing:
 *
 *   "like how the human brain works to prune and clean and grow synapses — so
 *    there is no waste, but also no security concerns for customers as they use
 *    and evolve their work."
 *
 * ── WHERE EACH LAYER'S DATA COMES FROM ─────────────────────────────────────
 *
 *   PRUNE  the estate snapshot this tab is HANDED. Not re-fetched: the Graph tab
 *          already holds it, and a second Resource Graph pull seconds later
 *          would give the two tabs different estates with no way to tell which
 *          was stale (`_lib/wire.ts`).
 *   HOT    the same snapshot's edge provenances.
 *   RISK   `/api/admin/brain/synapses` -> `lib/brain/security/**`. A separate
 *          payload, because a security graph describes SOURCE and the estate
 *          graph describes AZURE: they share no facts, so they cannot go stale
 *          against one another, and the single-payload argument does not apply.
 *   NEW    the same route's history lane (W9, #3935).
 *
 * ── G3 ─────────────────────────────────────────────────────────────────────
 * `SplitPane` with its own persisted `sizingKey` — deliberately NOT the Graph
 * tab's key. Two views of one graph with different right-hand content should not
 * fight over one stored width.
 *
 * ── RECOMMEND-ONLY ─────────────────────────────────────────────────────────
 * Nothing on this surface can execute anything. It issues exactly one request, a
 * GET, and it is asserted in `__tests__/ui/synapse-no-mutation.test.tsx` by
 * walking every rendered control, by scanning the source for an ARM write, and by
 * driving the whole surface with a fetch that FAILS the test if any control calls
 * it with a method other than GET.
 */

import * as React from 'react';
import { Badge, Caption1, MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens } from '@fluentui/react-components';
import { SplitPane } from '@/lib/components/shared/split-pane';
import type { BrainSnapshot, WireEdge, WireNode } from '@/app/api/admin/brain/_lib/wire';
import type { EdgeHistory, RiskLayer } from '@/app/api/admin/brain/_lib/synapse-wire';
import { BrainCanvas } from './brain-canvas';
import { SynapsePanel } from './synapse-panel';
import { buildSynapseOverlay } from './synapse-model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0, alignItems: 'center' },
  badge: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  note: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
  split: { minHeight: 0, minWidth: 0 },
});

/** What the synapses route returns. Both lanes, or an honest reason. */
export interface SynapseLayers {
  readonly risk: RiskLayer;
  readonly history: EdgeHistory;
}

type LayerState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly layers: SynapseLayers }
  | { readonly phase: 'error'; readonly message: string };

async function fetchLayers(): Promise<SynapseLayers> {
  const res = await fetch('/api/admin/brain/synapses', { cache: 'no-store' });
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; risk?: RiskLayer; history?: EdgeHistory; error?: string }
    | null;
  if (!res.ok || !json?.ok || !json.risk || !json.history) {
    throw new Error(json?.error ?? `the synapse layers could not be read (HTTP ${res.status})`);
  }
  return { risk: json.risk, history: json.history };
}

export interface SynapseViewProps {
  readonly snapshot: BrainSnapshot;
  /** The FILTERED view — the marks describe what is on screen, not the estate. */
  readonly nodes: readonly WireNode[];
  readonly edges: readonly WireEdge[];
  readonly costByNodeId: ReadonlyMap<string, number>;
  readonly findingCountByNodeId: ReadonlyMap<string, number>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  /**
   * Test seam. Production omits it and the real BFF is used; a test supplies the
   * layers directly so a render assertion does not depend on a network stub that
   * could quietly return a different shape.
   */
  readonly loadLayers?: () => Promise<SynapseLayers>;
}

export function SynapseView(props: SynapseViewProps) {
  const s = useStyles();
  const load = props.loadLayers ?? fetchLayers;
  const [state, setState] = React.useState<LayerState>({ phase: 'loading' });

  const run = React.useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'ready', layers: await load() });
    } catch (e) {
      setState({
        phase: 'error',
        message: e instanceof Error ? e.message : 'the synapse layers could not be read',
      });
    }
  }, [load]);

  React.useEffect(() => {
    void run();
  }, [run]);

  const layers = state.phase === 'ready' ? state.layers : null;

  const overlay = React.useMemo(
    () =>
      buildSynapseOverlay({
        snapshot: props.snapshot,
        nodes: props.nodes,
        edges: props.edges,
        risk: layers?.risk ?? null,
        history: layers?.history ?? null,
      }),
    [props.snapshot, props.nodes, props.edges, layers],
  );

  return (
    <div className={s.root} data-testid="synapse-view">
      <div className={s.badges} data-testid="synapse-population">
        <Badge className={s.badge} appearance="tint">
          {overlay.prune.costly + overlay.prune.idle} prune candidate(s)
        </Badge>
        <Badge className={s.badge} appearance="tint">
          {overlay.risk.evaluated ? `${overlay.risk.findings.length} risk finding(s)` : 'risk: NOT EVALUATED'}
        </Badge>
        <Badge className={s.badge} appearance="tint">
          {overlay.hot.collected ? `${overlay.hot.observed} hot path(s)` : 'hot paths: NOT COLLECTED'}
        </Badge>
        <Badge className={s.badge} appearance="tint">
          {overlay.fresh.available ? `${overlay.fresh.newEdges} new edge(s)` : 'growth: NO HISTORY'}
        </Badge>
        <Caption1 className={s.note}>
          over {overlay.prune.nodesExamined} node(s) and {overlay.hot.edgesExamined} edge(s) in the
          current filter
        </Caption1>
      </div>

      {/*
        A view that hides three of its four layers must say so where the operator
        is looking, not only inside the lane they might not scroll to.
      */}
      {(!overlay.risk.evaluated || !overlay.hot.collected || !overlay.fresh.available) && (
        <MessageBar intent="warning" data-testid="synapse-partial">
          <MessageBarBody>
            <MessageBarTitle>Not every synapse layer could be evaluated.</MessageBarTitle>
            {[
              overlay.risk.evaluated ? null : 'RISK',
              overlay.hot.collected ? null : 'HOT PATHS',
              overlay.fresh.available ? null : 'GROWTH (new edges)',
            ]
              .filter((x): x is string => x !== null)
              .join(', ')}{' '}
            drew no verdict at all. That is not the same as drawing a clean one — each lane below
            states what was missing and what would make it evaluable.
          </MessageBarBody>
        </MessageBar>
      )}

      <SplitPane
        direction="horizontal"
        storageKey="brain-synapses-inspector"
        defaultSize="62%"
        minSize={320}
        className={s.split}
      >
        <BrainCanvas
          nodes={props.nodes}
          edges={props.edges}
          coverageConfigured={props.snapshot.coverage.configured.collected}
          costByNodeId={props.costByNodeId}
          findingCountByNodeId={props.findingCountByNodeId}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          overlay={overlay}
          testId="synapse-canvas"
          resizeStorageKey="brain-synapses"
        />
        <SynapsePanel
          overlay={overlay}
          riskLoading={state.phase === 'loading'}
          riskError={state.phase === 'error' ? state.message : null}
          onRetryRisk={() => void run()}
          onFocusNode={(id) => props.onSelect(id)}
        />
      </SplitPane>
    </div>
  );
}

'use client';

/**
 * LOOM BRAIN VISUALIZER — the surface.
 *
 * Fetches ONE snapshot and renders it four ways: the graph, the SYNAPSE layers
 * over that same graph, the details of the selected node, and the
 * recommendations. All four read the same object, which is the mechanism behind
 * PRP §3.6's "the picture and the analysis cannot disagree" — see the doc-block
 * in `app/api/admin/brain/_lib/wire.ts` for why that is architecture rather than
 * a promise.
 *
 * The Synapses tab additionally loads `/api/admin/brain/synapses`, and that IS a
 * second payload. It is allowed because it describes a different subject — a
 * graph of the SOURCE, not of the estate — so the two cannot go stale against
 * each other. `synapse-view.tsx` argues it in full.
 *
 * ── LAYOUT ─────────────────────────────────────────────────────────────────
 * Graph and details sit in a `SplitPane` with a persisted `sizingKey`, per
 * `ux-baseline.md` G3 (a fixed-size graph pane is a listed defect), and the
 * canvas itself is additionally height-resizable via `ResizableCanvasRegion`.
 *
 * ── THE FILTER BAR REPORTS ITS OWN POPULATION ──────────────────────────────
 * A filtered canvas showing 3 nodes over an estate of 63 looks exactly like an
 * estate of 3. So the filter bar renders "showing N of M" and names every
 * active predicate. The population rule is not only for detectors — a view that
 * hides most of its subject and does not say so is the same failure in a
 * different place.
 */

import * as React from 'react';
import {
  Badge,
  Button,
  Caption1,
  Checkbox,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Skeleton,
  SkeletonItem,
  Tab,
  TabList,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwise20Regular } from '@fluentui/react-icons';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { EmptyState } from '@/lib/components/empty-state';
import type { BrainSnapshot } from '@/app/api/admin/brain/_lib/wire';
import type { EdgeProvenance } from '@/lib/brain/graph';
import { BrainCanvas } from './brain-canvas';
import { CoveragePanel } from './coverage-panel';
import { NodeDetails } from './node-details';
import { Recommendations } from './recommendations';
import { SynapseView } from './synapse-view';
import {
  applyFilters,
  costByNode,
  DEFAULT_FILTERS,
  findingsByNode,
  subscriptionLabel,
  subscriptionsIn,
  type BrainFilters,
} from './model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  grow: { flex: 1, minWidth: '160px' },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  note: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
  split: { minHeight: 0, minWidth: 0 },
  detailPane: { minWidth: 0, height: '100%', overflow: 'hidden' },
});

const ALL_PROVENANCES: EdgeProvenance[] = ['configured', 'declared', 'imports', 'observed', 'owns'];

type LoadState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly snapshot: BrainSnapshot }
  | { readonly phase: 'error'; readonly message: string };

export interface BrainPaneProps {
  /**
   * Test seam. Production passes nothing and the real BFF is used; a test
   * supplies a snapshot directly so a render assertion does not depend on a
   * network stub that could quietly return a different shape.
   */
  readonly initialSnapshot?: BrainSnapshot;
  readonly submitDecision?: React.ComponentProps<typeof Recommendations>['submitDecision'];
  /** Test seam for the Synapses tab's own (separate) payload. Same reasoning. */
  readonly loadSynapseLayers?: React.ComponentProps<typeof SynapseView>['loadLayers'];
}

export function BrainPane({ initialSnapshot, submitDecision, loadSynapseLayers }: BrainPaneProps) {
  const s = useStyles();
  const [state, setState] = React.useState<LoadState>(
    initialSnapshot ? { phase: 'ready', snapshot: initialSnapshot } : { phase: 'loading' },
  );
  const [filters, setFilters] = React.useState<BrainFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<'graph' | 'synapses' | 'recommendations' | 'coverage'>('graph');

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch('/api/admin/brain/graph', { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; snapshot?: BrainSnapshot; error?: string }
        | null;
      if (!res.ok || !json?.ok || !json.snapshot) {
        setState({
          phase: 'error',
          message: json?.error ?? `the estate could not be read (HTTP ${res.status})`,
        });
        return;
      }
      setState({ phase: 'ready', snapshot: json.snapshot });
    } catch (e) {
      setState({
        phase: 'error',
        message: e instanceof Error ? e.message : 'the estate could not be read',
      });
    }
  }, []);

  React.useEffect(() => {
    if (!initialSnapshot) void load();
  }, [initialSnapshot, load]);

  if (state.phase === 'loading') {
    return (
      <Skeleton aria-label="Loading the estate graph">
        <SkeletonItem size={16} />
        <SkeletonItem size={16} />
        <SkeletonItem size={16} />
      </Skeleton>
    );
  }

  if (state.phase === 'error') {
    return (
      <MessageBar intent="error" data-testid="brain-error">
        <MessageBarBody>
          <MessageBarTitle>The estate could not be read.</MessageBarTitle>
          {state.message}
          <div>
            <Caption1>
              No graph is shown and no reachability verdict has been drawn — an empty canvas here
              would look exactly like a clean estate, which is the failure this message exists to
              prevent.
            </Caption1>
          </div>
          <Button appearance="primary" size="small" onClick={() => void load()}>Retry</Button>
        </MessageBarBody>
      </MessageBar>
    );
  }

  const snapshot = state.snapshot;
  return (
    <ReadySurface
      snapshot={snapshot}
      filters={filters}
      setFilters={setFilters}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      tab={tab}
      setTab={setTab}
      onRefresh={() => void load()}
      styles={s}
      {...(submitDecision ? { submitDecision } : {})}
      {...(loadSynapseLayers ? { loadSynapseLayers } : {})}
    />
  );
}

function ReadySurface({
  snapshot,
  filters,
  setFilters,
  selectedId,
  setSelectedId,
  tab,
  setTab,
  onRefresh,
  styles: s,
  submitDecision,
  loadSynapseLayers,
}: {
  snapshot: BrainSnapshot;
  filters: BrainFilters;
  setFilters: React.Dispatch<React.SetStateAction<BrainFilters>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  tab: 'graph' | 'synapses' | 'recommendations' | 'coverage';
  setTab: (t: 'graph' | 'synapses' | 'recommendations' | 'coverage') => void;
  onRefresh: () => void;
  styles: ReturnType<typeof useStyles>;
  submitDecision?: React.ComponentProps<typeof Recommendations>['submitDecision'];
  loadSynapseLayers?: React.ComponentProps<typeof SynapseView>['loadLayers'];
}) {
  const view = React.useMemo(() => applyFilters(snapshot, filters), [snapshot, filters]);
  const costs = React.useMemo(() => costByNode(snapshot.findings), [snapshot.findings]);
  const findingsFor = React.useMemo(() => findingsByNode(snapshot.findings), [snapshot.findings]);
  const findingCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const [k, v] of findingsFor) m.set(k, v.length);
    return m;
  }, [findingsFor]);

  const selected = React.useMemo(
    () => (selectedId ? (snapshot.nodes.find((n) => n.id === selectedId) ?? null) : null),
    [snapshot.nodes, selectedId],
  );

  const subs = React.useMemo(() => subscriptionsIn(snapshot), [snapshot]);

  const focus = React.useCallback(
    (id: string) => {
      setSelectedId(id);
      setTab('graph');
    },
    [setSelectedId, setTab],
  );

  return (
    <div className={s.root} data-testid="brain-pane">
      <div className={s.bar} role="group" aria-label="Graph filters">
        <Field label="Search" className={s.grow}>
          <Input
            size="small"
            value={filters.search}
            placeholder="name, type or resource group"
            onChange={(_, d) => setFilters((f) => ({ ...f, search: d.value }))}
          />
        </Field>
        <Field label="Subscription">
          <Dropdown
            size="small"
            selectedOptions={[filters.subscriptionId]}
            value={filters.subscriptionId === 'all' ? 'All subscriptions' : subscriptionLabel(filters.subscriptionId)}
            onOptionSelect={(_, d) =>
              setFilters((f) => ({ ...f, subscriptionId: (d.optionValue as string) ?? 'all' }))
            }
          >
            <Option value="all">All subscriptions</Option>
            {subs.map((id) => (
              <Option key={id} value={id}>{subscriptionLabel(id)}</Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Ownership">
          <Dropdown
            size="small"
            selectedOptions={[filters.ownership]}
            value={filters.ownership}
            onOptionSelect={(_, d) =>
              setFilters((f) => ({ ...f, ownership: (d.optionValue as BrainFilters['ownership']) ?? 'all' }))
            }
          >
            <Option value="all">all</Option>
            <Option value="owned">owned (tag established)</Option>
            <Option value="unowned">ownership not established</Option>
          </Dropdown>
        </Field>
        <Field label="Min derived cost (USD / 30d)">
          <Input
            size="small"
            type="number"
            min={0}
            value={String(filters.minCostUsd)}
            onChange={(_, d) =>
              setFilters((f) => ({ ...f, minCostUsd: Number(d.value) || 0 }))
            }
          />
        </Field>
        <Field label="Edge provenance">
          <div className={s.badges}>
            {ALL_PROVENANCES.map((p) => (
              <Checkbox
                key={p}
                size="medium"
                label={`${p} (${snapshot.edgesByProvenance[p]})`}
                checked={filters.provenances.has(p)}
                onChange={(_, d) =>
                  setFilters((f) => {
                    const next = new Set(f.provenances);
                    if (d.checked) next.add(p);
                    else next.delete(p);
                    return { ...f, provenances: next };
                  })
                }
              />
            ))}
          </div>
        </Field>
        <Checkbox
          label="Only nodes with findings"
          checked={filters.findingsOnly}
          onChange={(_, d) => setFilters((f) => ({ ...f, findingsOnly: Boolean(d.checked) }))}
        />
        <Tooltip content="Re-read the estate from Azure Resource Graph" relationship="label">
          <Button size="small" icon={<ArrowClockwise20Regular />} onClick={onRefresh}>
            Refresh
          </Button>
        </Tooltip>
      </div>

      {/* The view's own population — a filtered canvas must never read as the estate. */}
      <div className={s.badges} data-testid="view-population">
        <Badge appearance="tint">
          showing {view.population.nodesShown} of {view.population.nodesTotal} node(s)
        </Badge>
        <Badge appearance="tint">
          {view.population.edgesShown} of {view.population.edgesTotal} edge(s)
        </Badge>
        <Badge appearance="outline">cloud: {snapshot.cloud}</Badge>
        <Badge appearance="outline">read {new Date(snapshot.generatedAt).toLocaleString()}</Badge>
        {view.population.hiddenBy.length > 0 && (
          <Caption1 className={s.note}>filters: {view.population.hiddenBy.join(' · ')}</Caption1>
        )}
      </div>

      {!snapshot.coverage.configured.collected && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Reachability was not evaluated.</MessageBarTitle>
            {snapshot.coverage.configured.note}
          </MessageBarBody>
        </MessageBar>
      )}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="graph">Graph</Tab>
        <Tab value="synapses">Synapses</Tab>
        <Tab value="recommendations">Recommendations ({snapshot.findings.length})</Tab>
        <Tab value="coverage">Coverage &amp; populations</Tab>
      </TabList>

      {tab === 'graph' && (
        <SplitPane
          direction="horizontal"
          storageKey="brain-graph-details"
          defaultSize="66%"
          minSize={320}
          className={s.split}
        >
          <BrainCanvas
            nodes={view.nodes}
            edges={view.edges}
            coverageConfigured={snapshot.coverage.configured.collected}
            costByNodeId={costs}
            findingCountByNodeId={findingCounts}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <div className={s.detailPane}>
            {selected ? (
              <NodeDetails node={selected} snapshot={snapshot} />
            ) : (
              <EmptyState
                title="Select a node"
                body="Click a node on the graph to see what was measured about it, which wires reach it, which wires tried and failed, and what it costs."
              />
            )}
          </div>
        </SplitPane>
      )}

      {tab === 'synapses' && (
        <SynapseView
          snapshot={snapshot}
          nodes={view.nodes}
          edges={view.edges}
          costByNodeId={costs}
          findingCountByNodeId={findingCounts}
          selectedId={selectedId}
          onSelect={setSelectedId}
          {...(loadSynapseLayers ? { loadLayers: loadSynapseLayers } : {})}
        />
      )}

      {tab === 'recommendations' && (
        <Recommendations
          findings={snapshot.findings}
          onFocusNode={focus}
          {...(submitDecision ? { submitDecision } : {})}
        />
      )}

      {tab === 'coverage' && <CoveragePanel snapshot={snapshot} />}
    </div>
  );
}

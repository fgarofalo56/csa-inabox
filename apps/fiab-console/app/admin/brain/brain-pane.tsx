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
import { useRouter, useSearchParams } from 'next/navigation';
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
  split: {
    minHeight: 0,
    minWidth: 0,
    // #4241 defect 8: SplitPane reserves only 80px for its FLEXING pane, so a
    // persisted `loom.splitpane.brain-graph-details` size could pin the details
    // pane at ~80px forever. The fix CAPS THE PRIMARY (the graph pane, the
    // split's first child per `ordered` in split-pane.tsx) rather than flooring
    // the details pane: the primary renders with an inline `flex: 0 0 <px>` —
    // shrink 0 — so a min-width on the flexing pane cannot take space back from
    // it and would only clip/overflow. Flexbox DOES honor max-width over a flex
    // basis, and the freed space flows to the grow-1 details pane, which
    // therefore always gets at least min(320px, 35%). The 6px term is the
    // divider's fixed hit area. Layout px, not spacing — split-pane.tsx's own
    // layout-px note applies.
    '> div:first-child': { maxWidth: 'calc(100% - min(320px, 35%) - 6px)' },
  },
  detailPane: { minWidth: 0, height: '100%', overflow: 'hidden' },
});

const ALL_PROVENANCES: EdgeProvenance[] = ['configured', 'declared', 'imports', 'observed', 'owns'];

/**
 * #4278 — the four views, and their ADDRESS.
 *
 * The tab used to be local `useState` only, so `/admin/brain` always rendered
 * the Graph and Synapses / Recommendations / Coverage had no URL at all. That
 * is not cosmetic: `loom-ui-verify.yml` captures a G1 receipt by navigating to
 * a `target_route`, so no route could reach three of the four views, and a
 * receipt attempted against Recommendations silently captured the Graph
 * instead — verifying a surface nobody asked about. It also meant an operator
 * wanting a second opinion before performing a destructive action had no link
 * to send, and any reload dropped them back to Graph.
 */
export type BrainTab = 'graph' | 'synapses' | 'recommendations' | 'coverage';

const BRAIN_TABS: readonly BrainTab[] = ['graph', 'synapses', 'recommendations', 'coverage'];

/** Narrowing guard, so `parseBrainTab` needs no assertion on the value itself. */
function isBrainTab(raw: string | null | undefined): raw is BrainTab {
  // Widening the tuple to `readonly string[]` is sound; asserting the narrow
  // type onto an unvalidated input would be the thing this function exists to
  // avoid.
  return typeof raw === 'string' && (BRAIN_TABS as readonly string[]).includes(raw);
}

/**
 * Validate `?tab=` against the SAME union the renderer switches on. A stale
 * link, a hand-typed URL, or a renamed tab must not be able to select a view
 * that does not exist — every unrecognised value lands on the graph.
 */
export function parseBrainTab(raw: string | null | undefined): BrainTab {
  return isBrainTab(raw) ? raw : 'graph';
}

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

  // #4278: the tab lives in the URL. Read it through `useSearchParams` (the
  // pattern `governance/lineage` already uses), validated by `parseBrainTab` so
  // an unrecognised value can never select a view that does not exist.
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = parseBrainTab(searchParams?.get('tab'));
  const [tab, setTabState] = React.useState<BrainTab>(urlTab);

  /**
   * The tab the OPERATOR last asked for, while its navigation is still in
   * flight.
   *
   * `router.replace` is asynchronous, and under `force-dynamic` it carries a
   * server RSC round-trip, so a fast second switch can have the FIRST
   * navigation settle after it. Without this ref that stale settle re-entered
   * the effect below and snapped the tab BACKWARDS to a view the operator had
   * already left — measured as: click Recommendations, click Coverage, first
   * `replace()` commits, Coverage goes `aria-selected=false`.
   *
   * So: while an intent is outstanding, only the settle that MATCHES it is
   * allowed to write state. Every other settle in that window is our own stale
   * echo and is dropped. The latest user intent wins.
   */
  const pendingTabRef = React.useRef<BrainTab | null>(null);

  // Follow the URL when it changes underneath us — a deep link, or Back landing
  // on a different `?tab=`. Keyed on the parsed value, so it is a no-op unless
  // the address actually names a different view.
  React.useEffect(() => {
    if (pendingTabRef.current !== null) {
      // Still waiting for our own write to land. Anything else is stale.
      if (urlTab !== pendingTabRef.current) return;
      pendingTabRef.current = null;
    }
    setTabState(urlTab);
  }, [urlTab]);

  const setTab = React.useCallback(
    (t: BrainTab) => {
      setTabState(t);
      // Latch ONLY when this selection actually changes the address.
      //
      // Fluent's `TabList` fires `onTabSelect` for the ALREADY-SELECTED tab, and
      // re-selecting the current tab produces a `replace` that does not move
      // `urlTab`. The effect above is keyed `[urlTab]`, so it would never run,
      // so an unconditional latch would never be cleared — and from then on
      // every external navigation is swallowed: the pane shows one view while
      // the address bar names another.
      //
      // That is #4278's own defect reintroduced by its fix, and it is the worse
      // form of it. The whole point of addressable tabs is that an operator can
      // send a colleague a link before performing a destructive action; a URL
      // that LIES about which view you are on is worse than no URL, because
      // this one gets trusted.
      pendingTabRef.current = t === urlTab ? null : t;
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      params.set('tab', t);
      // REPLACE, not push: pushing would turn every tab click into a history
      // entry, so Back would cycle the operator through tabs instead of
      // leaving the page.
      //
      // `scroll: false` because switching a tab is not a navigation to a new
      // document — jumping to the top would throw away the operator's scroll
      // position for no reason. Matches `loom-marketplace.tsx:57` and
      // `realtime-intelligence-hub.tsx:54`, which do this same pattern.
      router.replace(`/admin/brain?${params.toString()}`, { scroll: false });
    },
    [router, searchParams, urlTab],
  );

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
  tab: BrainTab;
  setTab: (t: BrainTab) => void;
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

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(parseBrainTab(String(d.value)))}>
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

'use client';

/**
 * /assets — N5 SOFTWARE-DEFINED ASSETS.
 *
 * The estate reframed as a graph of assets: every lakehouse table, materialized
 * view, SQLMesh/dbt model and pipeline output Loom's lineage already knows
 * about, each with declared deps, a freshness policy, and a Materialize action
 * that runs its REAL backing job.
 *
 * The graph is DERIVED, never authored: `lib/assets/asset-registry.ts` consumes
 * WS-L's unified lineage (Purview/Atlas + Databricks Unity Catalog + Weave, with
 * the column-mapping facet) and N4's emitted model DAG. When a lineage source is
 * gated, the FULL page still renders and the gate is stated honestly — the other
 * sources keep drawing.
 *
 * FLAG0: the canvas reads the `n5-assets-canvas` runtime flag (default ON). OFF
 * leaves the KPI band + the late/failing lists working and replaces the canvas
 * with a guided notice — the seconds-fast revert for a rendering regression.
 *
 * Azure-native throughout; no Fabric / Power BI / Dagster host is reachable from
 * any path. IL5: every backing call is in-boundary.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dropdown, MessageBar, MessageBarBody, MessageBarTitle,
  Option, Spinner, Subtitle2, Text, Title3,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, CheckmarkCircle20Regular, DatabaseLink20Regular,
  ErrorCircle20Regular, Timer20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { clientFetch } from '@/lib/client-fetch';
import { AssetsCanvas, type AssetNodeView } from '@/lib/components/assets/assets-canvas';
import type { DerivedDep } from '@/lib/assets/asset-graph';
import type { FreshnessRollup } from '@/lib/assets/freshness';
import type { AssetFreshnessPolicy } from '@/lib/azure/asset-registry-model';

interface SourceStatus {
  source: string;
  ok: boolean;
  gate?: string;
  nodeCount: number;
}

interface LineageResponse {
  ok: boolean;
  error?: string;
  nodes: AssetNodeView[];
  deps: DerivedDep[];
  sources: SourceStatus[];
  roots: { resolved: number; total: number; capped: boolean };
  builtAt: string;
}

interface StatusResponse {
  ok: boolean;
  error?: string;
  rollup: FreshnessRollup;
  autoManaged: number;
  configured: number;
  late: Array<{
    key: string; name: string; group: string; status: string;
    ageMinutes: number | null; overdueByMinutes: number; dueAt: string | null;
    materializer: string; mode: string;
  }>;
  failing: Array<{ key: string; name: string; consecutiveFailures: number; lastTriggerAt?: string; detail?: string }>;
  unbound: Array<{ key: string; name: string; group: string }>;
}

const useStyles = makeStyles({
  band: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  tileHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  metric: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700 },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  chips: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
    alignItems: 'center', minWidth: 0,
  },
  list: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  listRow: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS,
    alignItems: 'baseline', minWidth: 0,
  },
  hint: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
});

async function fetchLineage(): Promise<LineageResponse> {
  const res = await clientFetch('/api/assets/lineage', { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as LineageResponse;
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Could not load the asset graph (HTTP ${res.status})`);
  }
  return json;
}

async function fetchStatus(): Promise<StatusResponse> {
  const res = await clientFetch('/api/assets/status', { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as StatusResponse;
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Could not load asset freshness (HTTP ${res.status})`);
  }
  return json;
}

export default function AssetsPage() {
  const s = useStyles();
  const qc = useQueryClient();
  const canvasOn = useRuntimeFlag('n5-assets-canvas', true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const graph = useQuery({ queryKey: ['assets-graph'], queryFn: fetchLineage, staleTime: 20_000 });
  const status = useQuery({ queryKey: ['assets-status'], queryFn: fetchStatus, staleTime: 20_000 });

  const assets = useMemo(() => {
    const all = graph.data?.nodes || [];
    if (statusFilter === 'all') return all;
    return all.filter((a) => a.freshness.status === statusFilter);
  }, [graph.data, statusFilter]);

  const deps = useMemo(() => {
    const keep = new Set(assets.map((a) => a.key));
    return (graph.data?.deps || []).filter((d) => keep.has(d.from) && keep.has(d.to));
  }, [graph.data, assets]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['assets-graph'] });
    void qc.invalidateQueries({ queryKey: ['assets-status'] });
  }, [qc]);

  const savePolicy = useCallback(async (assetKey: string, policy: AssetFreshnessPolicy) => {
    const res = await clientFetch('/api/assets/freshness', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetKey, policy }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || json?.ok !== true) {
      throw new Error(json?.error || `Could not save the freshness policy (HTTP ${res.status})`);
    }
    refresh();
  }, [refresh]);

  const materialize = useCallback(async (assetKey: string): Promise<string> => {
    const res = await clientFetch('/api/assets/materialize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetKey }),
    });
    const json = (await res.json().catch(() => ({}))) as
      { ok?: boolean; error?: string; detail?: string; engine?: string; runId?: string };
    if (!res.ok || json?.ok !== true) {
      throw new Error(json?.error || `Materialization failed (HTTP ${res.status})`);
    }
    refresh();
    return json.detail || `Materialization dispatched${json.runId ? ` (run ${json.runId})` : ''}.`;
  }, [refresh]);

  const rollup = status.data?.rollup;
  const gatedSources = (graph.data?.sources || []).filter((x) => !x.ok);

  return (
    <PageShell
      title="Assets"
      subtitle="Every table, view, model and pipeline output as a software-defined asset — derived deps, freshness policies, and data-aware materialization."
      actions={
        <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={refresh}>
          Refresh
        </Button>
      }
    >
      <div className={s.band}>
        {/* KPI band — every number comes from the SAME derived snapshot the canvas draws. */}
        <TileGrid minTileWidth={220}>
          <div className={s.tile}>
            <div className={s.tileHead}>
              <DatabaseLink20Regular aria-hidden />
              <Caption1>Assets derived</Caption1>
            </div>
            <Text className={s.metric}>{rollup?.total ?? (status.isLoading ? '—' : 0)}</Text>
            <Caption1 className={s.hint}>
              {status.data ? `${status.data.configured} with a saved policy · ${status.data.autoManaged} auto-managed` : 'From lineage + your transformation projects'}
            </Caption1>
          </div>
          <div className={s.tile}>
            <div className={s.tileHead}>
              <CheckmarkCircle20Regular aria-hidden />
              <Caption1>Fresh</Caption1>
            </div>
            <Text className={s.metric}>{rollup?.fresh ?? '—'}</Text>
            <Caption1 className={s.hint}>Within their declared cadence.</Caption1>
          </div>
          <div className={s.tile}>
            <div className={s.tileHead}>
              <Warning20Regular aria-hidden />
              <Caption1>Stale</Caption1>
            </div>
            <Text className={s.metric}>{rollup?.stale ?? '—'}</Text>
            <Caption1 className={s.hint}>Past cadence, still inside the grace window.</Caption1>
          </div>
          <div className={s.tile}>
            <div className={s.tileHead}>
              <ErrorCircle20Regular aria-hidden />
              <Caption1>Overdue</Caption1>
            </div>
            <Text className={s.metric}>{rollup?.overdue ?? '—'}</Text>
            <Caption1 className={s.hint}>Past cadence + grace — the reconciler alerts these.</Caption1>
          </div>
          <div className={s.tile}>
            <div className={s.tileHead}>
              <Timer20Regular aria-hidden />
              <Caption1>Unmanaged</Caption1>
            </div>
            <Text className={s.metric}>{(rollup?.unmanaged ?? 0) + (rollup?.never ?? 0)}</Text>
            <Caption1 className={s.hint}>No cadence declared yet, or never materialized.</Caption1>
          </div>
        </TileGrid>

        {/* Honest per-source gates — the page NEVER blanks because one source is off. */}
        {gatedSources.map((src) => (
          <MessageBar key={src.source} intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{src.source} lineage is not contributing</MessageBarTitle>
              {src.gate} The asset graph still renders from every other source.
            </MessageBarBody>
          </MessageBar>
        ))}

        {graph.data?.roots.capped && (
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>
              Showing the {graph.data.roots.resolved} largest lineage chains of{' '}
              {graph.data.roots.total}. Narrow the view with the status filter, or open an item&apos;s
              own lineage for its complete graph.
            </MessageBarBody>
          </MessageBar>
        )}

        <div className={s.toolbar}>
          <Dropdown
            aria-label="Filter by freshness"
            selectedOptions={[statusFilter]}
            value={statusFilter === 'all' ? 'All assets' : statusFilter}
            onOptionSelect={(_e, d) => setStatusFilter(d.optionValue || 'all')}
          >
            <Option value="all" text="All assets">All assets</Option>
            <Option value="overdue" text="Overdue">Overdue</Option>
            <Option value="stale" text="Stale">Stale</Option>
            <Option value="fresh" text="Fresh">Fresh</Option>
            <Option value="never" text="Not materialized">Not materialized</Option>
            <Option value="unmanaged" text="Unmanaged">Unmanaged</Option>
          </Dropdown>
          <div className={s.chips}>
            {(graph.data?.sources || []).filter((x) => x.ok).map((src) => (
              <Badge key={src.source} size="small" appearance="outline">
                {src.source} · {src.nodeCount}
              </Badge>
            ))}
          </div>
          {graph.data?.builtAt && (
            <Caption1 className={s.hint}>Derived {graph.data.builtAt}</Caption1>
          )}
        </div>

        {graph.isLoading && <Spinner label="Deriving the asset graph from lineage…" />}
        {graph.isError && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Could not derive the asset graph</MessageBarTitle>
              {(graph.error as Error)?.message}
            </MessageBarBody>
          </MessageBar>
        )}

        {!graph.isLoading && !graph.isError && !canvasOn && (
          <EmptyState
            icon={<DatabaseLink20Regular />}
            title="Asset canvas is switched off"
            body="An administrator has disabled the n5-assets-canvas runtime flag. Freshness policies, the reconciler, and the /api/assets endpoints keep working — re-enable the flag on /admin/runtime-flags to bring the canvas back."
            primaryAction={{ label: 'Open runtime flags', href: '/admin/runtime-flags' }}
          />
        )}

        {!graph.isLoading && !graph.isError && canvasOn && (
          <AssetsCanvas
            assets={assets}
            deps={deps}
            sizingKey="assets-graph-canvas"
            onSavePolicy={savePolicy}
            onMaterialize={materialize}
          />
        )}

        {/* Incident lists — what the reconciler is currently unhappy about. */}
        {status.data && status.data.late.length > 0 && (
          <div className={s.band}>
            <Subtitle2>Late assets</Subtitle2>
            <div className={s.list}>
              {status.data.late.slice(0, 10).map((row) => (
                <div key={row.key} className={s.listRow}>
                  <Badge size="small" appearance="tint" color={row.status === 'overdue' ? 'danger' : 'warning'}>
                    {row.status}
                  </Badge>
                  <Body1>{row.name}</Body1>
                  <Caption1 className={s.hint}>
                    {row.overdueByMinutes > 0 ? `${row.overdueByMinutes} min late` : `due ${row.dueAt ?? 'soon'}`}
                    {' · '}{row.materializer}{' · '}{row.mode}
                  </Caption1>
                </div>
              ))}
            </div>
          </div>
        )}

        {status.data && status.data.failing.length > 0 && (
          <div className={s.band}>
            <Subtitle2>Failing materializations</Subtitle2>
            <div className={s.list}>
              {status.data.failing.slice(0, 10).map((row) => (
                <div key={row.key} className={s.listRow}>
                  <Badge size="small" appearance="tint" color="danger">
                    {row.consecutiveFailures}×
                  </Badge>
                  <Body1>{row.name}</Body1>
                  <Caption1 className={s.hint}>{row.detail || 'See the asset inspector for the engine log.'}</Caption1>
                </div>
              ))}
            </div>
            <Caption1 className={s.hint}>
              After 3 consecutive failures the reconciler backs off exponentially (capped at 24 h) so a
              broken asset can never thrash the engine.
            </Caption1>
          </div>
        )}

        {status.data && status.data.unbound.length > 0 && (
          <div className={s.band}>
            <Title3>Auto-managed with no materializer</Title3>
            <Caption1 className={s.hint}>
              These assets are set to Auto but have nothing bound to run. Select each on the canvas and
              bind a transformation project, a Synapse pipeline, or a Databricks job — the reconciler
              skips them until then, and says so in its receipt.
            </Caption1>
            <div className={s.chips}>
              {status.data.unbound.slice(0, 20).map((row) => (
                <Badge key={row.key} size="small" appearance="outline">{row.name}</Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

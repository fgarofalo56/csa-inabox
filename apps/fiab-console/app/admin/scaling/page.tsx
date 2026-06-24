'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useState } from 'react';
import {
  Body1, Caption1, Button, MessageBar, MessageBarBody,
  Input, makeStyles, tokens,
} from '@fluentui/react-components';
import { AdminShell } from '@/lib/components/admin-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { ServiceCard, type UtilizationSnapshot } from '@/lib/components/admin-scaling/service-card';
import { ScalePicker } from '@/lib/components/admin-scaling/scale-picker';
import { CostPreview } from '@/lib/components/admin-scaling/cost-preview';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

/**
 * /admin/scaling — Scale-by-SKU dropdowns for every scalable Loom backing
 * service. Every Apply button POSTs to /api/admin/scaling/* which calls
 * real Azure REST. Per .claude/rules/no-vaporware.md there are no mock
 * arrays here; if a service is not configured the card surfaces an
 * honest MessageBar with the precise env var + bicep module to wire up.
 *
 * Presentation: each backing service is a Fluent `ServiceCard` (makeStyles
 * card). Multi-resource services render their per-resource list with the
 * shared `LoomDataTable`; every Apply is a Fluent primary `Button`. No raw
 * <button> styling, no inline style literals — all styling lives in
 * `useStyles` below or in the shared components.
 */

const FABRIC_SKUS = ['F2','F4','F8','F16','F32','F64','F128','F256','F512','F1024','F2048'];
const POWERBI_SKUS = ['P1','P2','P3'];
const DWU_SKUS = ['DW100c','DW200c','DW300c','DW400c','DW500c','DW1000c','DW1500c','DW2000c','DW2500c','DW3000c','DW5000c','DW6000c','DW7500c','DW10000c','DW15000c','DW30000c'];
const ADX_SKUS = ['Dev(No SLA)_Standard_E2a_v4','Standard_E2ads_v5','Standard_E4ads_v5','Standard_E8ads_v5','Standard_E16ads_v5','Standard_E64ads_v5'];
const WAREHOUSE_SIZES = ['2X-Small','X-Small','Small','Medium','Large','X-Large','2X-Large','3X-Large','4X-Large'];
const SEARCH_SKUS = ['free','basic','standard','standard2','standard3','storage_optimized_l1','storage_optimized_l2'];
const APIM_SKUS = ['Developer','Basic','Standard','Premium','BasicV2','StandardV2','PremiumV2','Consumption'];
const ACA_PROFILES = ['Consumption','D4','D8','D16','D32','E4','E8','E16','E32'];

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: tokens.spacingVerticalL },
  grid: {
    display: 'grid',
    // min(420px, 100%) lets the track shrink below 420px on narrow viewports
    // instead of forcing a 420px column (and horizontal page overflow).
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  // numeric input widths (replaces inline style={{ width: N }})
  inlineNumber: { width: '100px' },
  numNarrow: { width: '70px' },
  numWide: { width: '180px' },
  // uppercase micro-label above a numeric input (replaces repeated inline
  // textTransform/letterSpacing/fontSize literals)
  fieldLabel: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: 600,
  },
  // a labelled control stack (label over input)
  cellStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  // a row of controls inside one table cell
  controlRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  // resource (name + current state) cell
  resourceCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  subtle: { color: tokens.colorNeutralForeground3 },
  // apply button + inline status, stacked
  applyCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, alignItems: 'flex-start' },
  italicNote: { fontStyle: 'italic', color: tokens.colorNeutralForeground3 },
  // backend error/ok strings can be long & unbroken (URLs, ARM ids, tokens) —
  // wrap so they never push the card/cell wider than its column.
  errorText: { color: tokens.colorPaletteRedForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  okText: { color: tokens.colorPaletteGreenForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  // MCP persistence sub-section inside the Container Apps card
  mcpSection: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalS,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  mcpSectionLabel: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground2,
    fontWeight: 600,
  },
  mcpBox: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: tokens.spacingVerticalS,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  statusError: { display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorPaletteRedForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  statusOk: { display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorPaletteGreenForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

async function jsonPost(url: string, body: unknown): Promise<any> {
  const r = await clientFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `${r.status}`);
  return j;
}

async function jsonGet(url: string): Promise<any> {
  // 12s timeout so a hung backend route can't leave a panel spinning forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await clientFetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return await r.json().catch(() => ({}));
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? `Timed out loading ${url}` : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

export default function ScalingPage() {
  const styles = useStyles();
  const [unauth, setUnauth] = useState(false);

  // Per-card state. Each card tracks { data, loading, pendingSku, applying, error, ok }.
  const [capacityData, setCapacityData] = useState<any>(null);
  const [capacitySel, setCapacitySel] = useState<Record<string, string>>({});
  const [capacityState, setCapacityState] = useState<Record<string, { applying?: boolean; error?: string; ok?: string }>>({});

  const [dwuData, setDwuData] = useState<any>(null);
  const [dwuSel, setDwuSel] = useState<Record<string, string>>({});
  const [dwuState, setDwuState] = useState<Record<string, { applying?: boolean; error?: string; ok?: string }>>({});

  const [adxData, setAdxData] = useState<any>(null);
  const [adxSku, setAdxSku] = useState('');
  const [adxState, setAdxState] = useState<{ applying?: boolean; error?: string; ok?: string }>({});

  const [whData, setWhData] = useState<any>(null);
  const [whSel, setWhSel] = useState<Record<string, string>>({});
  const [whState, setWhState] = useState<Record<string, { applying?: boolean; error?: string; ok?: string }>>({});

  const [clusterData, setClusterData] = useState<any>(null);
  const [clusterSel, setClusterSel] = useState<Record<string, { node_type_id?: string; num_workers?: number }>>({});
  const [clusterState, setClusterState] = useState<Record<string, { applying?: boolean; error?: string; ok?: string }>>({});

  const [searchData, setSearchData] = useState<any>(null);
  const [searchSel, setSearchSel] = useState<{ sku?: string; replicaCount?: number; partitionCount?: number }>({});
  const [searchState, setSearchState] = useState<{ applying?: boolean; error?: string; ok?: string }>({});

  const [apimData, setApimData] = useState<any>(null);
  const [apimSel, setApimSel] = useState<{ sku?: string; capacity?: number }>({});
  const [apimState, setApimState] = useState<{ applying?: boolean; error?: string; ok?: string }>({});

  const [cosmosData, setCosmosData] = useState<any>(null);
  const [cosmosSel, setCosmosSel] = useState<Record<string, { mode?: 'manual' | 'autoscale'; ru?: number; maxRu?: number }>>({});
  const [cosmosState, setCosmosState] = useState<Record<string, { applying?: boolean; error?: string; ok?: string }>>({});

  const [acaData, setAcaData] = useState<any>(null);
  const [acaSel, setAcaSel] = useState<Record<string, { workloadProfileName?: string; minReplicas?: number; maxReplicas?: number }>>({});
  const [acaState, setAcaState] = useState<Record<string, { applying?: boolean; error?: string; ok?: string }>>({});

  const [foundryData, setFoundryData] = useState<any>(null);
  const [foundrySel, setFoundrySel] = useState<Record<string, { vmSize?: string; minNodeCount?: number; maxNodeCount?: number }>>({});
  const [foundryState, setFoundryState] = useState<Record<string, { applying?: boolean; error?: string; ok?: string }>>({});

  // MCP container app — Azure Files mount (persistence). Deploy path, not a SKU dial.
  const [mcpData, setMcpData] = useState<any>(null);
  const [mcpSel, setMcpSel] = useState<{ mountPath?: string; accessMode?: 'ReadWrite' | 'ReadOnly' }>({});
  const [mcpState, setMcpState] = useState<{ applying?: boolean; error?: string; ok?: string }>({});

  // Utilization snapshots from /api/admin/scaling/utilization (Azure Monitor).
  // Key = ARM resource type (lowercase). Loading until the fetch settles.
  const [utilData, setUtilData] = useState<Record<string, UtilizationSnapshot> | null>(null);
  const [utilLoading, setUtilLoading] = useState(true);

  useEffect(() => {
    // Fire every GET in parallel but populate each card independently as its
    // own response lands — one slow backend no longer holds the whole page on
    // a spinner. `cancelled` guards against setState after unmount.
    let cancelled = false;
    const when = <T,>(fn: (v: T) => void) => (v: T) => { if (!cancelled) fn(v); };

    // Capacity is the primary probe for the unauthenticated state.
    jsonGet('/api/admin/scaling/capacity').then(when((cap: any) => {
      if (cap?.error === 'unauthenticated') { setUnauth(true); return; }
      setCapacityData(cap);
    }));
    jsonGet('/api/admin/scaling/synapse-dwu').then(when(setDwuData));
    jsonGet('/api/admin/scaling/adx').then(when(setAdxData));
    jsonGet('/api/admin/scaling/databricks-warehouse').then(when(setWhData));
    jsonGet('/api/admin/scaling/databricks-cluster').then(when(setClusterData));
    jsonGet('/api/admin/scaling/ai-search').then(when(setSearchData));
    jsonGet('/api/admin/scaling/apim').then(when(setApimData));
    jsonGet('/api/admin/scaling/cosmos').then(when(setCosmosData));
    jsonGet('/api/admin/scaling/container-apps').then(when(setAcaData));
    jsonGet('/api/admin/scaling/foundry-compute').then(when(setFoundryData));
    jsonGet('/api/admin/mcp-servers/deploy').then(when(setMcpData));

    // Utilization: fire separately so a Monitor timeout never delays the SKU dials.
    jsonGet('/api/admin/scaling/utilization').then(when((u: any) => {
      if (u?.ok && Array.isArray(u.items)) {
        const byType: Record<string, UtilizationSnapshot> = {};
        for (const item of u.items) {
          if (item?.resourceType) byType[item.resourceType] = item as UtilizationSnapshot;
        }
        setUtilData(byType);
      } else {
        // Route returned an error (Monitor not configured, 503, etc.) — mark all
        // as unavailable so cards show "—" rather than spinning indefinitely.
        setUtilData({});
      }
      setUtilLoading(false);
    }));

    return () => { cancelled = true; };
  }, []);

  if (unauth) {
    return (
      <AdminShell sectionTitle="Scale by SKU">
        <SignInRequired subject="Scale-by-SKU admin" />
      </AdminShell>
    );
  }

  const skuOpts = (xs: string[]) => xs.map(x => ({ value: x, label: x }));

  // Inline status (error/ok) shown under each Apply button.
  const statusCell = (st: { error?: string; ok?: string }) => (
    <>
      {st.error && <Caption1 role="alert" className={styles.errorText}>{st.error}</Caption1>}
      {st.ok && <Caption1 role="status" className={styles.okText}>{st.ok}</Caption1>}
    </>
  );

  // --- LoomDataTable column definitions for the multi-resource cards. Each
  // render closure reads the latest per-row pending selection + apply state
  // from component state, and every Apply is a Fluent primary Button. These
  // are small per-card lists shown with `noFilters`; control/action columns
  // are not sortable/filterable. -----------------------------------------

  const capacityColumns: LoomColumn<any>[] = [
    {
      key: 'displayName', label: 'Capacity', width: 180,
      render: (cap) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{cap.displayName}</strong></Caption1>
          <Caption1 className={styles.subtle}>{cap.sku} · {cap.state || 'Active'}</Caption1>
        </div>
      ),
    },
    {
      key: 'target', label: 'Target SKU', width: 240, sortable: false, filterable: false,
      render: (cap) => {
        const isPbi = (cap.sku || '').toUpperCase().startsWith('P');
        const opts = isPbi ? POWERBI_SKUS : FABRIC_SKUS;
        const pending = capacitySel[cap.id] ?? cap.sku;
        return (
          <ScalePicker label="Target SKU" options={skuOpts(opts)} value={pending}
            onChange={(v) => setCapacitySel({ ...capacitySel, [cap.id]: v })} />
        );
      },
    },
    {
      key: 'estimate', label: 'Estimated cost', width: 230, sortable: false, filterable: false,
      render: (cap) => <CostPreview family="fabric-capacity" currentSku={cap.sku} targetSku={capacitySel[cap.id] ?? cap.sku} />,
    },
    {
      key: 'apply', label: '', width: 150, sortable: false, filterable: false,
      render: (cap) => {
        const pending = capacitySel[cap.id] ?? cap.sku;
        const st = capacityState[cap.id] || {};
        return (
          <div className={styles.applyCell}>
            <Button appearance="primary" disabled={st.applying || pending === cap.sku}
              onClick={async () => {
                setCapacityState({ ...capacityState, [cap.id]: { applying: true } });
                try {
                  await jsonPost('/api/admin/scaling/capacity', { resourceId: cap.id, sku: pending });
                  setCapacityState({ ...capacityState, [cap.id]: { ok: `Scaling to ${pending}…` } });
                } catch (e: any) {
                  setCapacityState({ ...capacityState, [cap.id]: { error: e.message } });
                }
              }}>
              {st.applying ? 'Applying…' : 'Apply'}
            </Button>
            {statusCell(st)}
          </div>
        );
      },
    },
  ];

  const dwuColumns: LoomColumn<any>[] = [
    {
      key: 'name', label: 'Pool', width: 180,
      render: (pool) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{pool.name}</strong></Caption1>
          <Caption1 className={styles.subtle}>{pool.sku?.name} · {pool.status || 'Online'}</Caption1>
        </div>
      ),
    },
    {
      key: 'target', label: 'Target DWU', width: 240, sortable: false, filterable: false,
      render: (pool) => {
        const pending = dwuSel[pool.name] ?? pool.sku?.name;
        return (
          <ScalePicker label="Target DWU" options={skuOpts(DWU_SKUS)} value={pending}
            onChange={(v) => setDwuSel({ ...dwuSel, [pool.name]: v })} />
        );
      },
    },
    {
      key: 'estimate', label: 'Estimated cost', width: 230, sortable: false, filterable: false,
      render: (pool) => <CostPreview family="synapse-dwu" currentSku={pool.sku?.name} targetSku={dwuSel[pool.name] ?? pool.sku?.name} />,
    },
    {
      key: 'apply', label: '', width: 150, sortable: false, filterable: false,
      render: (pool) => {
        const pending = dwuSel[pool.name] ?? pool.sku?.name;
        const st = dwuState[pool.name] || {};
        return (
          <div className={styles.applyCell}>
            <Button appearance="primary" disabled={st.applying || pending === pool.sku?.name}
              onClick={async () => {
                setDwuState({ ...dwuState, [pool.name]: { applying: true } });
                try {
                  await jsonPost('/api/admin/scaling/synapse-dwu', { pool: pool.name, sku: pending });
                  setDwuState({ ...dwuState, [pool.name]: { ok: `Scaling to ${pending}…` } });
                } catch (e: any) {
                  setDwuState({ ...dwuState, [pool.name]: { error: e.message } });
                }
              }}>
              {st.applying ? 'Applying…' : 'Apply'}
            </Button>
            {statusCell(st)}
          </div>
        );
      },
    },
  ];

  const whColumns: LoomColumn<any>[] = [
    {
      key: 'name', label: 'Warehouse', width: 180,
      render: (w) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{w.name}</strong></Caption1>
          <Caption1 className={styles.subtle}>{w.cluster_size} · {w.state || 'Stopped'}</Caption1>
        </div>
      ),
    },
    {
      key: 'target', label: 'cluster_size', width: 240, sortable: false, filterable: false,
      render: (w) => {
        const pending = whSel[w.id] ?? w.cluster_size;
        return (
          <ScalePicker label="cluster_size" options={skuOpts(WAREHOUSE_SIZES)} value={pending}
            onChange={(v) => setWhSel({ ...whSel, [w.id]: v })} />
        );
      },
    },
    {
      key: 'estimate', label: 'Estimated cost', width: 230, sortable: false, filterable: false,
      render: (w) => <CostPreview family="databricks-warehouse" currentSku={w.cluster_size} targetSku={whSel[w.id] ?? w.cluster_size} />,
    },
    {
      key: 'apply', label: '', width: 150, sortable: false, filterable: false,
      render: (w) => {
        const pending = whSel[w.id] ?? w.cluster_size;
        const st = whState[w.id] || {};
        return (
          <div className={styles.applyCell}>
            <Button appearance="primary" disabled={st.applying || pending === w.cluster_size}
              onClick={async () => {
                setWhState({ ...whState, [w.id]: { applying: true } });
                try {
                  await jsonPost('/api/admin/scaling/databricks-warehouse', { id: w.id, cluster_size: pending });
                  setWhState({ ...whState, [w.id]: { ok: `Resized to ${pending}` } });
                } catch (e: any) { setWhState({ ...whState, [w.id]: { error: e.message } }); }
              }}>
              {st.applying ? 'Applying…' : 'Apply'}
            </Button>
            {statusCell(st)}
          </div>
        );
      },
    },
  ];

  const clusterColumns: LoomColumn<any>[] = [
    {
      key: 'cluster_name', label: 'Cluster', width: 180,
      render: (c) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{c.cluster_name}</strong></Caption1>
          <Caption1 className={styles.subtle}>{c.node_type_id} · {c.num_workers ?? 'autoscale'} workers · {c.state}</Caption1>
        </div>
      ),
    },
    {
      key: 'config', label: 'Node type & workers', width: 380, sortable: false, filterable: false,
      render: (c) => {
        const pendingNode = clusterSel[c.cluster_id]?.node_type_id ?? c.node_type_id;
        const pendingWorkers = clusterSel[c.cluster_id]?.num_workers ?? c.num_workers ?? 1;
        const nodeOpts = (clusterData?.nodeTypes || []).map((n: any) => ({
          value: n.id, label: `${n.id} (${n.cores}c / ${Math.round((n.memoryMb || 0) / 1024)}GB)`,
        }));
        return (
          <div className={styles.controlRow}>
            <ScalePicker
              label="node_type_id"
              options={nodeOpts.length ? nodeOpts : [{ value: pendingNode, label: pendingNode }]}
              value={pendingNode}
              onChange={(v) => setClusterSel({ ...clusterSel, [c.cluster_id]: { ...clusterSel[c.cluster_id], node_type_id: v } })}
            />
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>num_workers</Caption1>
              <Input type="number" value={String(pendingWorkers)} className={styles.inlineNumber}
                onChange={(_, d) => setClusterSel({ ...clusterSel, [c.cluster_id]: { ...clusterSel[c.cluster_id], num_workers: parseInt(d.value, 10) || 0 } })} />
            </div>
          </div>
        );
      },
    },
    {
      key: 'apply', label: '', width: 150, sortable: false, filterable: false,
      render: (c) => {
        const pendingNode = clusterSel[c.cluster_id]?.node_type_id ?? c.node_type_id;
        const pendingWorkers = clusterSel[c.cluster_id]?.num_workers ?? c.num_workers ?? 1;
        const st = clusterState[c.cluster_id] || {};
        return (
          <div className={styles.applyCell}>
            <Button appearance="primary" disabled={st.applying}
              onClick={async () => {
                setClusterState({ ...clusterState, [c.cluster_id]: { applying: true } });
                try {
                  await jsonPost('/api/admin/scaling/databricks-cluster', {
                    cluster_id: c.cluster_id, node_type_id: pendingNode, num_workers: pendingWorkers,
                  });
                  setClusterState({ ...clusterState, [c.cluster_id]: { ok: `Updated ${pendingNode} · ${pendingWorkers} workers` } });
                } catch (e: any) { setClusterState({ ...clusterState, [c.cluster_id]: { error: e.message } }); }
              }}>
              {st.applying ? 'Applying…' : 'Apply'}
            </Button>
            {statusCell(st)}
          </div>
        );
      },
    },
  ];

  const cosmosColumns: LoomColumn<any>[] = [
    {
      key: 'id', label: 'Container', width: 200,
      render: (cn) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{cn.id}</strong></Caption1>
          <Caption1 className={styles.subtle}>{cn.mode}{cn.ru ? ` · ${cn.ru} RU/s` : ''}{cn.maxRu ? ` · max ${cn.maxRu} RU/s` : ''}</Caption1>
        </div>
      ),
    },
    {
      key: 'throughput', label: 'Throughput', width: 300, sortable: false, filterable: false,
      render: (cn) => {
        if (cn.mode === 'serverless') {
          return <Caption1 className={styles.italicNote}>Serverless account — no RU/s dial (billed per request).</Caption1>;
        }
        const sel = cosmosSel[cn.id] || {};
        return (
          <div className={styles.controlRow}>
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>Manual RU/s</Caption1>
              <Input type="number" className={styles.inlineNumber} value={String(sel.ru ?? cn.ru ?? '')}
                onChange={(_, d) => setCosmosSel({ ...cosmosSel, [cn.id]: { ...sel, ru: parseInt(d.value, 10) || undefined, maxRu: undefined } })} />
            </div>
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>Autoscale max</Caption1>
              <Input type="number" className={styles.inlineNumber} value={String(sel.maxRu ?? cn.maxRu ?? '')}
                onChange={(_, d) => setCosmosSel({ ...cosmosSel, [cn.id]: { ...sel, maxRu: parseInt(d.value, 10) || undefined, ru: undefined } })} />
            </div>
          </div>
        );
      },
    },
    {
      key: 'apply', label: '', width: 150, sortable: false, filterable: false,
      render: (cn) => {
        if (cn.mode === 'serverless') return <Caption1 className={styles.subtle}>—</Caption1>;
        const sel = cosmosSel[cn.id] || {};
        const st = cosmosState[cn.id] || {};
        return (
          <div className={styles.applyCell}>
            <Button appearance="primary" disabled={st.applying || (!sel.ru && !sel.maxRu)}
              onClick={async () => {
                setCosmosState({ ...cosmosState, [cn.id]: { applying: true } });
                try {
                  await jsonPost('/api/admin/scaling/cosmos', { container: cn.id, ru: sel.ru, maxRu: sel.maxRu });
                  setCosmosState({ ...cosmosState, [cn.id]: { ok: 'Updated' } });
                } catch (e: any) { setCosmosState({ ...cosmosState, [cn.id]: { error: e.message } }); }
              }}>
              {st.applying ? 'Applying…' : 'Apply'}
            </Button>
            {statusCell(st)}
          </div>
        );
      },
    },
  ];

  const acaColumns: LoomColumn<any>[] = [
    {
      key: 'name', label: 'App', width: 180,
      render: (a) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{a.name}</strong></Caption1>
          <Caption1 className={styles.subtle}>{a.workloadProfileName || 'Consumption'} · {a.minReplicas}-{a.maxReplicas} replicas</Caption1>
        </div>
      ),
    },
    {
      key: 'config', label: 'Profile & replicas', width: 360, sortable: false, filterable: false,
      render: (a) => {
        const sel = acaSel[a.name] || {};
        const pendingProfile = sel.workloadProfileName ?? a.workloadProfileName ?? 'Consumption';
        const pendingMin = sel.minReplicas ?? a.minReplicas ?? 0;
        const pendingMax = sel.maxReplicas ?? a.maxReplicas ?? 1;
        return (
          <div className={styles.controlRow}>
            <ScalePicker label="Profile" options={skuOpts(ACA_PROFILES)} value={pendingProfile}
              onChange={(v) => setAcaSel({ ...acaSel, [a.name]: { ...sel, workloadProfileName: v } })} />
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>min</Caption1>
              <Input type="number" className={styles.numNarrow} value={String(pendingMin)}
                onChange={(_, d) => setAcaSel({ ...acaSel, [a.name]: { ...sel, minReplicas: parseInt(d.value, 10) || 0 } })} />
            </div>
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>max</Caption1>
              <Input type="number" className={styles.numNarrow} value={String(pendingMax)}
                onChange={(_, d) => setAcaSel({ ...acaSel, [a.name]: { ...sel, maxReplicas: parseInt(d.value, 10) || 1 } })} />
            </div>
          </div>
        );
      },
    },
    {
      key: 'apply', label: '', width: 150, sortable: false, filterable: false,
      render: (a) => {
        const sel = acaSel[a.name] || {};
        const st = acaState[a.name] || {};
        const pendingProfile = sel.workloadProfileName ?? a.workloadProfileName ?? 'Consumption';
        const pendingMin = sel.minReplicas ?? a.minReplicas ?? 0;
        const pendingMax = sel.maxReplicas ?? a.maxReplicas ?? 1;
        return (
          <div className={styles.applyCell}>
            <Button appearance="primary" disabled={st.applying}
              onClick={async () => {
                setAcaState({ ...acaState, [a.name]: { applying: true } });
                try {
                  await jsonPost('/api/admin/scaling/container-apps', {
                    name: a.name, workloadProfileName: pendingProfile, minReplicas: pendingMin, maxReplicas: pendingMax,
                  });
                  setAcaState({ ...acaState, [a.name]: { ok: 'Scale applied' } });
                } catch (e: any) { setAcaState({ ...acaState, [a.name]: { error: e.message } }); }
              }}>
              {st.applying ? 'Applying…' : 'Apply'}
            </Button>
            {statusCell(st)}
          </div>
        );
      },
    },
  ];

  const foundryColumns: LoomColumn<any>[] = [
    {
      key: 'name', label: 'Compute', width: 200,
      render: (c) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{c.name}</strong></Caption1>
          <Caption1 className={styles.subtle}>{c.computeType} · {c.vmSize || 'unknown'} · {c.state || 'unknown'}</Caption1>
        </div>
      ),
    },
    {
      key: 'config', label: 'vmSize & nodes', width: 420, sortable: false, filterable: false,
      render: (c) => {
        if (c.computeType !== 'AmlCompute') {
          return (
            <Caption1 className={styles.italicNote}>
              {c.computeType} cannot be PATCHed; delete + recreate to change vmSize (Azure ML limit).
            </Caption1>
          );
        }
        const sel = foundrySel[c.name] || {};
        return (
          <div className={styles.controlRow}>
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>vmSize</Caption1>
              <Input className={styles.numWide} value={sel.vmSize ?? c.vmSize ?? ''}
                onChange={(_, d) => setFoundrySel({ ...foundrySel, [c.name]: { ...sel, vmSize: d.value } })} />
            </div>
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>min nodes</Caption1>
              <Input type="number" className={styles.numNarrow} value={String(sel.minNodeCount ?? 0)}
                onChange={(_, d) => setFoundrySel({ ...foundrySel, [c.name]: { ...sel, minNodeCount: parseInt(d.value, 10) || 0 } })} />
            </div>
            <div className={styles.cellStack}>
              <Caption1 className={styles.fieldLabel}>max nodes</Caption1>
              <Input type="number" className={styles.numNarrow} value={String(sel.maxNodeCount ?? 1)}
                onChange={(_, d) => setFoundrySel({ ...foundrySel, [c.name]: { ...sel, maxNodeCount: parseInt(d.value, 10) || 1 } })} />
            </div>
          </div>
        );
      },
    },
    {
      key: 'apply', label: '', width: 150, sortable: false, filterable: false,
      render: (c) => {
        if (c.computeType !== 'AmlCompute') return <Caption1 className={styles.subtle}>—</Caption1>;
        const sel = foundrySel[c.name] || {};
        const st = foundryState[c.name] || {};
        return (
          <div className={styles.applyCell}>
            <Button appearance="primary" disabled={st.applying}
              onClick={async () => {
                setFoundryState({ ...foundryState, [c.name]: { applying: true } });
                try {
                  await jsonPost('/api/admin/scaling/foundry-compute', { name: c.name, ...sel });
                  setFoundryState({ ...foundryState, [c.name]: { ok: 'Compute scale submitted' } });
                } catch (e: any) { setFoundryState({ ...foundryState, [c.name]: { error: e.message } }); }
              }}>
              {st.applying ? 'Applying…' : 'Apply'}
            </Button>
            {statusCell(st)}
          </div>
        );
      },
    },
  ];

  return (
    <AdminShell sectionTitle="Scale by SKU">
      <Body1 className={styles.intro}>
        Scale every backing service from inside Loom. Each card hits a real
        Azure REST endpoint via the BFF — no portal hand-offs. Cost previews
        are list-price estimates from a lookup table; reserved instances and
        SLA surcharges are excluded. Apply is async on most services (Fabric
        capacity, APIM, ADX) — refresh the card after a few minutes to see
        the new state.
      </Body1>

      <div className={styles.grid}>

        {/* Fabric / Power BI capacities — no ARM Monitor metric for cu_percentage in Gov */}
        <ServiceCard
          title="Fabric / Power BI Capacity"
          subtitle="F-SKU (F2 → F2048) for Fabric; P-SKU for Power BI Premium."
          loading={!capacityData}
          gateMessage={capacityData && !capacityData.ok ? {
            title: 'Capacity unavailable',
            body: `${capacityData.error}${capacityData.hint ? ' — ' + capacityData.hint : ''}`,
          } : undefined}
          utilization={utilData?.['microsoft.fabric/capacities']}
          utilizationLoading={utilLoading}
          controls={
            <LoomDataTable
              columns={capacityColumns}
              rows={capacityData?.capacities || []}
              getRowId={(r) => r.id}
              noFilters
              ariaLabel="Fabric / Power BI capacities"
              empty="No Fabric or Power BI capacities visible to the Console UAMI."
            />
          }
        />

        {/* Synapse DWU */}
        <ServiceCard
          title="Synapse Dedicated SQL Pool (DWU)"
          subtitle="DW100c → DW30000c — scale-out via ARM PATCH on sqlPools/{n}."
          loading={!dwuData}
          gateMessage={dwuData && !dwuData.ok ? { title: 'Synapse not configured', body: `${dwuData.error}${dwuData.hint ? ' — ' + dwuData.hint : ''}` } : undefined}
          utilization={utilData?.['microsoft.synapse/workspaces/sqlpools']}
          utilizationLoading={utilLoading}
          controls={
            <LoomDataTable
              columns={dwuColumns}
              rows={dwuData?.pools || []}
              getRowId={(r) => r.name}
              noFilters
              ariaLabel="Synapse dedicated SQL pools"
              empty="No Dedicated SQL pools in the Synapse workspace."
            />
          }
        />

        {/* ADX cluster */}
        <ServiceCard
          title="Azure Data Explorer (ADX)"
          subtitle="vCore tier (Dev / E2 / E4 / E8 / E16 / E64) + capacity."
          loading={!adxData}
          gateMessage={adxData && !adxData.ok ? { title: 'ADX not configured', body: `${adxData.error}${adxData.hint ? ' — ' + adxData.hint : ''}` } : undefined}
          currentLabel={adxData?.cluster ? `${adxData.cluster.sku?.name} · ${adxData.cluster.sku?.capacity || 1} instance(s) · ${adxData.cluster.state || 'Running'}` : undefined}
          utilization={utilData?.['microsoft.kusto/clusters']}
          utilizationLoading={utilLoading}
          controls={adxData?.cluster && (
            <ScalePicker label="Target tier" options={skuOpts(ADX_SKUS)} value={adxSku || adxData.cluster.sku?.name} onChange={setAdxSku} />
          )}
          costPreview={adxData?.cluster && <CostPreview family="adx" currentSku={adxData.cluster.sku?.name} targetSku={adxSku || adxData.cluster.sku?.name} />}
          dirty={!!adxSku && adxSku !== adxData?.cluster?.sku?.name}
          applying={adxState.applying}
          applyError={adxState.error}
          applyOk={adxState.ok}
          onApply={async () => {
            setAdxState({ applying: true });
            try {
              await jsonPost('/api/admin/scaling/adx', { sku: adxSku });
              setAdxState({ ok: `Scaling to ${adxSku}…` });
            } catch (e: any) { setAdxState({ error: e.message }); }
          }}
        />

        {/* Databricks SQL Warehouse — no ARM Monitor metric; shows "—" honestly */}
        <ServiceCard
          title="Databricks SQL Warehouse"
          subtitle="cluster_size (2X-Small → 4X-Large) via /api/2.0/sql/warehouses/{id}/edit."
          loading={!whData}
          gateMessage={whData && !whData.ok ? { title: 'Databricks not configured', body: whData.error } : undefined}
          utilization={utilData?.['microsoft.databricks/warehouse']}
          utilizationLoading={utilLoading}
          controls={
            <LoomDataTable
              columns={whColumns}
              rows={whData?.warehouses || []}
              getRowId={(r) => r.id}
              noFilters
              ariaLabel="Databricks SQL warehouses"
              empty="No SQL warehouses."
            />
          }
        />

        {/* Databricks Cluster — no ARM Monitor metric; shows "—" honestly */}
        <ServiceCard
          title="Databricks Cluster"
          subtitle="node_type_id + num_workers via /api/2.0/clusters/edit."
          loading={!clusterData}
          gateMessage={clusterData && !clusterData.ok ? { title: 'Databricks not configured', body: clusterData.error } : undefined}
          utilization={utilData?.['microsoft.databricks/cluster']}
          utilizationLoading={utilLoading}
          controls={
            <LoomDataTable
              columns={clusterColumns}
              rows={clusterData?.clusters || []}
              getRowId={(r) => r.cluster_id}
              noFilters
              ariaLabel="Databricks clusters"
              empty="No Databricks clusters."
            />
          }
        />

        {/* AI Search */}
        <ServiceCard
          title="Azure AI Search"
          subtitle="SKU (S0/S1/S2/S3/S3HD) + replicas + partitions."
          loading={!searchData}
          gateMessage={searchData && !searchData.ok ? { title: 'AI Search not configured', body: `${searchData.error}${searchData.hint ? ' — ' + searchData.hint : ''}` } : undefined}
          currentLabel={searchData?.service ? `${searchData.service.sku?.name} · ${searchData.service.replicaCount}R × ${searchData.service.partitionCount}P · ${searchData.service.status || 'Running'}` : undefined}
          utilization={utilData?.['microsoft.search/searchservices']}
          utilizationLoading={utilLoading}
          controls={searchData?.service && (
            <>
              <ScalePicker label="SKU" options={skuOpts(SEARCH_SKUS)} value={searchSel.sku || searchData.service.sku?.name} onChange={(v) => setSearchSel({ ...searchSel, sku: v })} />
              <div className={styles.cellStack}>
                <Caption1 className={styles.fieldLabel}>Replicas</Caption1>
                <Input type="number" className={styles.inlineNumber} value={String(searchSel.replicaCount ?? searchData.service.replicaCount)}
                  onChange={(_, d) => setSearchSel({ ...searchSel, replicaCount: parseInt(d.value, 10) || 1 })} />
              </div>
              <div className={styles.cellStack}>
                <Caption1 className={styles.fieldLabel}>Partitions</Caption1>
                <Input type="number" className={styles.inlineNumber} value={String(searchSel.partitionCount ?? searchData.service.partitionCount)}
                  onChange={(_, d) => setSearchSel({ ...searchSel, partitionCount: parseInt(d.value, 10) || 1 })} />
              </div>
            </>
          )}
          costPreview={searchData?.service && (
            <CostPreview
              family="ai-search"
              currentSku={searchData.service.sku?.name}
              targetSku={searchSel.sku || searchData.service.sku?.name}
              multiplier={(searchSel.replicaCount ?? searchData.service.replicaCount) * (searchSel.partitionCount ?? searchData.service.partitionCount)}
            />
          )}
          dirty={!!(searchSel.sku || searchSel.replicaCount || searchSel.partitionCount)}
          applying={searchState.applying}
          applyError={searchState.error}
          applyOk={searchState.ok}
          onApply={async () => {
            setSearchState({ applying: true });
            try {
              await jsonPost('/api/admin/scaling/ai-search', searchSel);
              setSearchState({ ok: 'AI Search scale submitted' });
            } catch (e: any) { setSearchState({ error: e.message }); }
          }}
        />

        {/* APIM */}
        <ServiceCard
          title="API Management"
          subtitle="SKU (Developer / Basic / Standard / Premium / *V2) + capacity."
          loading={!apimData}
          gateMessage={apimData && !apimData.ok ? { title: 'APIM not configured', body: `${apimData.error}${apimData.hint ? ' — ' + apimData.hint : ''}` } : undefined}
          currentLabel={apimData?.service ? `${apimData.service.sku?.name} × ${apimData.service.sku?.capacity} · ${apimData.service.provisioningState || 'Succeeded'}` : undefined}
          utilization={utilData?.['microsoft.apimanagement/service']}
          utilizationLoading={utilLoading}
          controls={apimData?.service && (
            <>
              <ScalePicker label="SKU" options={skuOpts(APIM_SKUS)} value={apimSel.sku || apimData.service.sku?.name} onChange={(v) => setApimSel({ ...apimSel, sku: v })} />
              <div className={styles.cellStack}>
                <Caption1 className={styles.fieldLabel}>Capacity</Caption1>
                <Input type="number" className={styles.inlineNumber} value={String(apimSel.capacity ?? apimData.service.sku?.capacity ?? 1)}
                  onChange={(_, d) => setApimSel({ ...apimSel, capacity: parseInt(d.value, 10) || 1 })} />
              </div>
            </>
          )}
          costPreview={apimData?.service && (
            <CostPreview family="apim" currentSku={apimData.service.sku?.name} targetSku={apimSel.sku || apimData.service.sku?.name} multiplier={apimSel.capacity ?? apimData.service.sku?.capacity ?? 1} />
          )}
          dirty={!!(apimSel.sku || apimSel.capacity)}
          applying={apimState.applying}
          applyError={apimState.error}
          applyOk={apimState.ok}
          onApply={async () => {
            setApimState({ applying: true });
            try {
              await jsonPost('/api/admin/scaling/apim', apimSel);
              setApimState({ ok: 'APIM scale submitted' });
            } catch (e: any) { setApimState({ error: e.message }); }
          }}
        />

        {/* Cosmos */}
        <ServiceCard
          title="Cosmos DB containers"
          subtitle="Per-container RU/s (manual) or autoscale max RU/s."
          loading={!cosmosData}
          gateMessage={cosmosData && !cosmosData.ok ? { title: 'Cosmos not configured', body: `${cosmosData.error}${cosmosData.hint ? ' — ' + cosmosData.hint : ''}` } : undefined}
          utilization={utilData?.['microsoft.documentdb/databaseaccounts']}
          utilizationLoading={utilLoading}
          controls={
            <LoomDataTable
              columns={cosmosColumns}
              rows={cosmosData?.containers || []}
              getRowId={(r) => r.id}
              noFilters
              ariaLabel="Cosmos DB containers"
              empty="No Cosmos containers."
            />
          }
        />

        {/* Container Apps + MCP persistence */}
        <ServiceCard
          title="Container Apps (Loom services)"
          subtitle="workload profile (Consumption / D-/E-series) + replicas."
          loading={!acaData}
          gateMessage={acaData && !acaData.ok ? { title: 'Container Apps not configured', body: `${acaData.error}${acaData.hint ? ' — ' + acaData.hint : ''}` } : undefined}
          utilization={utilData?.['microsoft.app/containerapps']}
          utilizationLoading={utilLoading}
          controls={
            <>
              <LoomDataTable
                columns={acaColumns}
                rows={acaData?.apps || []}
                getRowId={(r) => r.name}
                noFilters
                ariaLabel="Container Apps"
                empty="No container apps in this RG."
              />

              {/* MCP server — Azure Files mount (persistence). Deploy path, not a SKU dial. */}
              <div className={styles.mcpSection}>
                <Caption1 className={styles.mcpSectionLabel}>
                  MCP server — persistent storage (Azure Files)
                </Caption1>
                {mcpData && !mcpData.ok ? (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      {mcpData.error}{mcpData.hint ? ` — ${mcpData.hint}` : ''}
                    </MessageBarBody>
                  </MessageBar>
                ) : (
                  <div className={styles.mcpBox}>
                    <Caption1>
                      Mounts <strong>{mcpData?.config?.shareName || 'the MCP file share'}</strong> on{' '}
                      <strong>{mcpData?.config?.storageAccount || '…'}</strong> into the loom-mcp container at the
                      mount path below. Applying rolls a new revision (brief connection drop).
                    </Caption1>
                    <div className={styles.controlRow}>
                      <div className={styles.cellStack}>
                        <Caption1 id="mcp-mount-path-label" className={styles.fieldLabel}>Mount path</Caption1>
                        <Input className={styles.numWide} aria-labelledby="mcp-mount-path-label" placeholder="/data"
                          value={mcpSel.mountPath ?? mcpData?.config?.mountPath ?? '/data'}
                          onChange={(_, d) => setMcpSel({ ...mcpSel, mountPath: d.value })} />
                      </div>
                      <ScalePicker
                        label="Access mode"
                        options={[{ value: 'ReadWrite', label: 'ReadWrite' }, { value: 'ReadOnly', label: 'ReadOnly' }]}
                        value={mcpSel.accessMode ?? 'ReadWrite'}
                        onChange={(v) => setMcpSel({ ...mcpSel, accessMode: v as 'ReadWrite' | 'ReadOnly' })}
                      />
                      <Button
                        appearance="primary"
                        aria-label="Mount Azure Files persistence onto the MCP container"
                        disabled={mcpState.applying}
                        onClick={async () => {
                          setMcpState({ applying: true });
                          try {
                            const r = await jsonPost('/api/admin/mcp-servers/deploy', {
                              mountPath: mcpSel.mountPath ?? mcpData?.config?.mountPath,
                              accessMode: mcpSel.accessMode ?? 'ReadWrite',
                            });
                            setMcpState({ ok: `Mounted at ${r.mountPath} — new revision rolling` });
                          } catch (e: any) { setMcpState({ error: e.message }); }
                        }}>
                        {mcpState.applying ? 'Mounting…' : 'Mount persistence'}
                      </Button>
                    </div>
                    {mcpState.error && <Caption1 role="alert" className={styles.statusError}>{mcpState.error}</Caption1>}
                    {mcpState.ok && <Caption1 role="status" className={styles.statusOk}>{mcpState.ok}</Caption1>}
                  </div>
                )}
              </div>
            </>
          }
        />

        {/* Foundry compute — requires a real AML workspace (kind=Hub or standalone).
             LOOM_FOUNDRY_NAME may point at an Azure OpenAI account, which is not an ML
             workspace. The gate hint from the route gives precise env-var + bicep steps. */}
        <ServiceCard
          title="AI Foundry — AML compute"
          subtitle="vmSize + min/max nodes for AmlCompute targets. Requires a Microsoft.MachineLearningServices/workspaces resource."
          loading={!foundryData}
          utilization={utilData?.['microsoft.machinelearningservices/workspaces/computes']}
          utilizationLoading={utilLoading}
          gateMessage={
            foundryData && !foundryData.ok
              ? {
                  title: 'Azure ML workspace not configured',
                  body: `${foundryData.error}${foundryData.hint ? ' — ' + foundryData.hint : ''}`,
                }
              : undefined
          }
          controls={
            <LoomDataTable
              columns={foundryColumns}
              rows={foundryData?.computes || []}
              getRowId={(r) => r.name}
              noFilters
              ariaLabel="AI Foundry AML compute"
              empty="No AML compute targets found. Computes are created in Azure ML Studio or via the Azure ML CLI."
            />
          }
        />

      </div>
    </AdminShell>
  );
}

'use client';

import { useEffect, useState } from 'react';
import {
  Body1, Title3, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  Input, makeStyles, tokens,
} from '@fluentui/react-components';
import { AdminShell } from '@/lib/components/admin-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { ServiceCard } from '@/lib/components/admin-scaling/service-card';
import { ScalePicker } from '@/lib/components/admin-scaling/scale-picker';
import { CostPreview } from '@/lib/components/admin-scaling/cost-preview';

/**
 * /admin/scaling — Scale-by-SKU dropdowns for every scalable Loom backing
 * service. Every Apply button POSTs to /api/admin/scaling/* which calls
 * real Azure REST. Per .claude/rules/no-vaporware.md there are no mock
 * arrays here; if a service is not configured the card surfaces an
 * honest MessageBar with the precise env var + bicep module to wire up.
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
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: '16px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
    gap: '16px',
  },
  inlineNumber: { width: '100px' },
});

interface SkuState { value: string; }

async function jsonPost(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `${r.status}`);
  return j;
}

async function jsonGet(url: string): Promise<any> {
  // 12s timeout so a hung backend route can't leave a panel spinning forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
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

  useEffect(() => {
    // Parallel fetch all GETs.
    Promise.all([
      jsonGet('/api/admin/scaling/capacity'),
      jsonGet('/api/admin/scaling/synapse-dwu'),
      jsonGet('/api/admin/scaling/adx'),
      jsonGet('/api/admin/scaling/databricks-warehouse'),
      jsonGet('/api/admin/scaling/databricks-cluster'),
      jsonGet('/api/admin/scaling/ai-search'),
      jsonGet('/api/admin/scaling/apim'),
      jsonGet('/api/admin/scaling/cosmos'),
      jsonGet('/api/admin/scaling/container-apps'),
      jsonGet('/api/admin/scaling/foundry-compute'),
      jsonGet('/api/admin/mcp-servers/deploy'),
    ]).then(([cap, dwu, adx, wh, cl, srch, apim, cos, aca, fnd, mcp]) => {
      // 401 across the board means unauthed
      if (cap?.error === 'unauthenticated') { setUnauth(true); return; }
      setCapacityData(cap); setDwuData(dwu); setAdxData(adx);
      setWhData(wh); setClusterData(cl); setSearchData(srch);
      setApimData(apim); setCosmosData(cos); setAcaData(aca); setFoundryData(fnd);
      setMcpData(mcp);
    }).catch(() => { /* keep partials */ });
  }, []);

  if (unauth) {
    return (
      <AdminShell sectionTitle="Scale by SKU">
        <SignInRequired subject="Scale-by-SKU admin" />
      </AdminShell>
    );
  }

  const skuOpts = (xs: string[]) => xs.map(x => ({ value: x, label: x }));

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

        {/* Fabric / Power BI capacities */}
        <ServiceCard
          title="Fabric / Power BI Capacity"
          subtitle="F-SKU (F2 → F2048) for Fabric; P-SKU for Power BI Premium."
          loading={!capacityData}
          gateMessage={capacityData && !capacityData.ok ? {
            title: 'Capacity unavailable',
            body: `${capacityData.error}${capacityData.hint ? ' — ' + capacityData.hint : ''}`,
          } : undefined}
          controls={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
              {(capacityData?.capacities || []).map((cap: any) => {
                const isPbi = (cap.sku || '').toUpperCase().startsWith('P');
                const opts = isPbi ? POWERBI_SKUS : FABRIC_SKUS;
                const pending = capacitySel[cap.id] ?? cap.sku;
                const st = capacityState[cap.id] || {};
                return (
                  <div key={cap.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 10 }}>
                    <Caption1><strong>{cap.displayName}</strong> ({cap.sku} · {cap.state || 'Active'})</Caption1>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <ScalePicker
                        label="Target SKU"
                        options={skuOpts(opts)}
                        value={pending}
                        onChange={(v) => setCapacitySel({ ...capacitySel, [cap.id]: v })}
                      />
                      <button
                        onClick={async () => {
                          setCapacityState({ ...capacityState, [cap.id]: { applying: true } });
                          try {
                            await jsonPost('/api/admin/scaling/capacity', { resourceId: cap.id, sku: pending });
                            setCapacityState({ ...capacityState, [cap.id]: { ok: `Scaling to ${pending}…` } });
                          } catch (e: any) {
                            setCapacityState({ ...capacityState, [cap.id]: { error: e.message } });
                          }
                        }}
                        disabled={st.applying || pending === cap.sku}
                        style={{
                          padding: '6px 16px', borderRadius: 4, border: 'none',
                          background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand,
                          cursor: 'pointer', opacity: (st.applying || pending === cap.sku) ? 0.5 : 1,
                        }}
                      >
                        {st.applying ? 'Applying…' : 'Apply'}
                      </button>
                    </div>
                    <CostPreview family="fabric-capacity" currentSku={cap.sku} targetSku={pending} />
                    {st.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{st.error}</Caption1>}
                    {st.ok && <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>{st.ok}</Caption1>}
                  </div>
                );
              })}
              {capacityData?.ok && (capacityData.capacities?.length ?? 0) === 0 && (
                <Caption1>No Fabric or Power BI capacities visible to the Console UAMI.</Caption1>
              )}
            </div>
          }
        />

        {/* Synapse DWU */}
        <ServiceCard
          title="Synapse Dedicated SQL Pool (DWU)"
          subtitle="DW100c → DW30000c — scale-out via ARM PATCH on sqlPools/{n}."
          loading={!dwuData}
          gateMessage={dwuData && !dwuData.ok ? { title: 'Synapse not configured', body: `${dwuData.error}${dwuData.hint ? ' — ' + dwuData.hint : ''}` } : undefined}
          controls={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
              {(dwuData?.pools || []).map((pool: any) => {
                const pending = dwuSel[pool.name] ?? pool.sku?.name;
                const st = dwuState[pool.name] || {};
                return (
                  <div key={pool.name} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 10 }}>
                    <Caption1><strong>{pool.name}</strong> ({pool.sku?.name} · {pool.status || 'Online'})</Caption1>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <ScalePicker label="Target DWU" options={skuOpts(DWU_SKUS)} value={pending} onChange={(v) => setDwuSel({ ...dwuSel, [pool.name]: v })} />
                      <button
                        onClick={async () => {
                          setDwuState({ ...dwuState, [pool.name]: { applying: true } });
                          try {
                            await jsonPost('/api/admin/scaling/synapse-dwu', { pool: pool.name, sku: pending });
                            setDwuState({ ...dwuState, [pool.name]: { ok: `Scaling to ${pending}…` } });
                          } catch (e: any) {
                            setDwuState({ ...dwuState, [pool.name]: { error: e.message } });
                          }
                        }}
                        disabled={st.applying || pending === pool.sku?.name}
                        style={{ padding: '6px 16px', borderRadius: 4, border: 'none', background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, cursor: 'pointer', opacity: (st.applying || pending === pool.sku?.name) ? 0.5 : 1 }}
                      >
                        {st.applying ? 'Applying…' : 'Apply'}
                      </button>
                    </div>
                    <CostPreview family="synapse-dwu" currentSku={pool.sku?.name} targetSku={pending} />
                    {st.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{st.error}</Caption1>}
                    {st.ok && <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>{st.ok}</Caption1>}
                  </div>
                );
              })}
              {dwuData?.ok && (dwuData.pools?.length ?? 0) === 0 && (
                <Caption1>No Dedicated SQL pools in the Synapse workspace.</Caption1>
              )}
            </div>
          }
        />

        {/* ADX cluster */}
        <ServiceCard
          title="Azure Data Explorer (ADX)"
          subtitle="vCore tier (Dev / E2 / E4 / E8 / E16 / E64) + capacity."
          loading={!adxData}
          gateMessage={adxData && !adxData.ok ? { title: 'ADX not configured', body: `${adxData.error}${adxData.hint ? ' — ' + adxData.hint : ''}` } : undefined}
          currentLabel={adxData?.cluster ? `${adxData.cluster.sku?.name} · ${adxData.cluster.sku?.capacity || 1} instance(s) · ${adxData.cluster.state || 'Running'}` : undefined}
          controls={adxData?.cluster && (
            <>
              <ScalePicker label="Target tier" options={skuOpts(ADX_SKUS)} value={adxSku || adxData.cluster.sku?.name} onChange={setAdxSku} />
            </>
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

        {/* Databricks SQL Warehouse */}
        <ServiceCard
          title="Databricks SQL Warehouse"
          subtitle="cluster_size (2X-Small → 4X-Large) via /api/2.0/sql/warehouses/{id}/edit."
          loading={!whData}
          gateMessage={whData && !whData.ok ? { title: 'Databricks not configured', body: whData.error } : undefined}
          controls={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
              {(whData?.warehouses || []).map((w: any) => {
                const pending = whSel[w.id] ?? w.cluster_size;
                const st = whState[w.id] || {};
                return (
                  <div key={w.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 10 }}>
                    <Caption1><strong>{w.name}</strong> ({w.cluster_size} · {w.state || 'Stopped'})</Caption1>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <ScalePicker label="cluster_size" options={skuOpts(WAREHOUSE_SIZES)} value={pending} onChange={(v) => setWhSel({ ...whSel, [w.id]: v })} />
                      <button
                        onClick={async () => {
                          setWhState({ ...whState, [w.id]: { applying: true } });
                          try {
                            await jsonPost('/api/admin/scaling/databricks-warehouse', { id: w.id, cluster_size: pending });
                            setWhState({ ...whState, [w.id]: { ok: `Resized to ${pending}` } });
                          } catch (e: any) { setWhState({ ...whState, [w.id]: { error: e.message } }); }
                        }}
                        disabled={st.applying || pending === w.cluster_size}
                        style={{ padding: '6px 16px', borderRadius: 4, border: 'none', background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, cursor: 'pointer', opacity: (st.applying || pending === w.cluster_size) ? 0.5 : 1 }}
                      >
                        {st.applying ? 'Applying…' : 'Apply'}
                      </button>
                    </div>
                    <CostPreview family="databricks-warehouse" currentSku={w.cluster_size} targetSku={pending} />
                    {st.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{st.error}</Caption1>}
                    {st.ok && <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>{st.ok}</Caption1>}
                  </div>
                );
              })}
              {whData?.ok && (whData.warehouses?.length ?? 0) === 0 && <Caption1>No SQL warehouses.</Caption1>}
            </div>
          }
        />

        {/* Databricks Cluster */}
        <ServiceCard
          title="Databricks Cluster"
          subtitle="node_type_id + num_workers via /api/2.0/clusters/edit."
          loading={!clusterData}
          gateMessage={clusterData && !clusterData.ok ? { title: 'Databricks not configured', body: clusterData.error } : undefined}
          controls={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
              {(clusterData?.clusters || []).map((c: any) => {
                const pendingNode = clusterSel[c.cluster_id]?.node_type_id ?? c.node_type_id;
                const pendingWorkers = clusterSel[c.cluster_id]?.num_workers ?? c.num_workers ?? 1;
                const st = clusterState[c.cluster_id] || {};
                const nodeOpts = (clusterData.nodeTypes || []).map((n: any) => ({
                  value: n.id, label: `${n.id} (${n.cores}c / ${Math.round((n.memoryMb || 0) / 1024)}GB)`,
                }));
                return (
                  <div key={c.cluster_id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 10 }}>
                    <Caption1><strong>{c.cluster_name}</strong> ({c.node_type_id} · {c.num_workers ?? 'autoscale'} workers · {c.state})</Caption1>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <ScalePicker
                        label="node_type_id"
                        options={nodeOpts.length ? nodeOpts : [{ value: pendingNode, label: pendingNode }]}
                        value={pendingNode}
                        onChange={(v) => setClusterSel({ ...clusterSel, [c.cluster_id]: { ...clusterSel[c.cluster_id], node_type_id: v } })}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>num_workers</Caption1>
                        <Input
                          type="number"
                          value={String(pendingWorkers)}
                          className={styles.inlineNumber}
                          onChange={(_, d) => setClusterSel({ ...clusterSel, [c.cluster_id]: { ...clusterSel[c.cluster_id], num_workers: parseInt(d.value, 10) || 0 } })}
                        />
                      </div>
                      <button
                        onClick={async () => {
                          setClusterState({ ...clusterState, [c.cluster_id]: { applying: true } });
                          try {
                            await jsonPost('/api/admin/scaling/databricks-cluster', {
                              cluster_id: c.cluster_id,
                              node_type_id: pendingNode,
                              num_workers: pendingWorkers,
                            });
                            setClusterState({ ...clusterState, [c.cluster_id]: { ok: `Updated ${pendingNode} · ${pendingWorkers} workers` } });
                          } catch (e: any) { setClusterState({ ...clusterState, [c.cluster_id]: { error: e.message } }); }
                        }}
                        disabled={st.applying}
                        style={{ padding: '6px 16px', borderRadius: 4, border: 'none', background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, cursor: 'pointer', opacity: st.applying ? 0.5 : 1 }}
                      >
                        {st.applying ? 'Applying…' : 'Apply'}
                      </button>
                    </div>
                    {st.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{st.error}</Caption1>}
                    {st.ok && <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>{st.ok}</Caption1>}
                  </div>
                );
              })}
              {clusterData?.ok && (clusterData.clusters?.length ?? 0) === 0 && <Caption1>No Databricks clusters.</Caption1>}
            </div>
          }
        />

        {/* AI Search */}
        <ServiceCard
          title="Azure AI Search"
          subtitle="SKU (S0/S1/S2/S3/S3HD) + replicas + partitions."
          loading={!searchData}
          gateMessage={searchData && !searchData.ok ? { title: 'AI Search not configured', body: `${searchData.error}${searchData.hint ? ' — ' + searchData.hint : ''}` } : undefined}
          currentLabel={searchData?.service ? `${searchData.service.sku?.name} · ${searchData.service.replicaCount}R × ${searchData.service.partitionCount}P · ${searchData.service.status || 'Running'}` : undefined}
          controls={searchData?.service && (
            <>
              <ScalePicker label="SKU" options={skuOpts(SEARCH_SKUS)} value={searchSel.sku || searchData.service.sku?.name} onChange={(v) => setSearchSel({ ...searchSel, sku: v })} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>Replicas</Caption1>
                <Input type="number" className={styles.inlineNumber} value={String(searchSel.replicaCount ?? searchData.service.replicaCount)}
                  onChange={(_, d) => setSearchSel({ ...searchSel, replicaCount: parseInt(d.value, 10) || 1 })} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>Partitions</Caption1>
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
          controls={apimData?.service && (
            <>
              <ScalePicker label="SKU" options={skuOpts(APIM_SKUS)} value={apimSel.sku || apimData.service.sku?.name} onChange={(v) => setApimSel({ ...apimSel, sku: v })} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>Capacity</Caption1>
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
          controls={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxHeight: '320px', overflowY: 'auto' }}>
              {(cosmosData?.containers || []).map((cn: any) => {
                const sel = cosmosSel[cn.id] || {};
                const st = cosmosState[cn.id] || {};
                const isServerless = cn.mode === 'serverless';
                return (
                  <div key={cn.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 8 }}>
                    <Caption1><strong>{cn.id}</strong> ({cn.mode}{cn.ru ? ` · ${cn.ru} RU/s` : ''}{cn.maxRu ? ` · max ${cn.maxRu} RU/s` : ''})</Caption1>
                    {isServerless ? (
                      <Caption1 style={{ fontStyle: 'italic', color: tokens.colorNeutralForeground3 }}>
                        Serverless account — no RU/s dial (billed per request).
                      </Caption1>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>Manual RU/s</Caption1>
                          <Input type="number" style={{ width: 100 }} value={String(sel.ru ?? cn.ru ?? '')}
                            onChange={(_, d) => setCosmosSel({ ...cosmosSel, [cn.id]: { ...sel, ru: parseInt(d.value, 10) || undefined, maxRu: undefined } })} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>Autoscale max</Caption1>
                          <Input type="number" style={{ width: 100 }} value={String(sel.maxRu ?? cn.maxRu ?? '')}
                            onChange={(_, d) => setCosmosSel({ ...cosmosSel, [cn.id]: { ...sel, maxRu: parseInt(d.value, 10) || undefined, ru: undefined } })} />
                        </div>
                        <button
                          onClick={async () => {
                            setCosmosState({ ...cosmosState, [cn.id]: { applying: true } });
                            try {
                              await jsonPost('/api/admin/scaling/cosmos', { container: cn.id, ru: sel.ru, maxRu: sel.maxRu });
                              setCosmosState({ ...cosmosState, [cn.id]: { ok: 'Updated' } });
                            } catch (e: any) { setCosmosState({ ...cosmosState, [cn.id]: { error: e.message } }); }
                          }}
                          disabled={st.applying || (!sel.ru && !sel.maxRu)}
                          style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, cursor: 'pointer', opacity: (st.applying || (!sel.ru && !sel.maxRu)) ? 0.5 : 1, fontSize: 12 }}
                        >
                          {st.applying ? '…' : 'Apply'}
                        </button>
                      </div>
                    )}
                    {st.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{st.error}</Caption1>}
                    {st.ok && <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>{st.ok}</Caption1>}
                  </div>
                );
              })}
              {cosmosData?.ok && (cosmosData.containers?.length ?? 0) === 0 && <Caption1>No Cosmos containers.</Caption1>}
            </div>
          }
        />

        {/* Container Apps */}
        <ServiceCard
          title="Container Apps (Loom services)"
          subtitle="workload profile (Consumption / D-/E-series) + replicas."
          loading={!acaData}
          gateMessage={acaData && !acaData.ok ? { title: 'Container Apps not configured', body: `${acaData.error}${acaData.hint ? ' — ' + acaData.hint : ''}` } : undefined}
          controls={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
              {(acaData?.apps || []).map((a: any) => {
                const sel = acaSel[a.name] || {};
                const st = acaState[a.name] || {};
                const pendingProfile = sel.workloadProfileName ?? a.workloadProfileName ?? 'Consumption';
                const pendingMin = sel.minReplicas ?? a.minReplicas ?? 0;
                const pendingMax = sel.maxReplicas ?? a.maxReplicas ?? 1;
                return (
                  <div key={a.name} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 8 }}>
                    <Caption1><strong>{a.name}</strong> ({a.workloadProfileName || 'Consumption'} · {a.minReplicas}-{a.maxReplicas} replicas)</Caption1>
                    <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <ScalePicker label="Profile" options={skuOpts(ACA_PROFILES)} value={pendingProfile}
                        onChange={(v) => setAcaSel({ ...acaSel, [a.name]: { ...sel, workloadProfileName: v } })} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>min</Caption1>
                        <Input type="number" style={{ width: 70 }} value={String(pendingMin)}
                          onChange={(_, d) => setAcaSel({ ...acaSel, [a.name]: { ...sel, minReplicas: parseInt(d.value, 10) || 0 } })} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>max</Caption1>
                        <Input type="number" style={{ width: 70 }} value={String(pendingMax)}
                          onChange={(_, d) => setAcaSel({ ...acaSel, [a.name]: { ...sel, maxReplicas: parseInt(d.value, 10) || 1 } })} />
                      </div>
                      <button
                        onClick={async () => {
                          setAcaState({ ...acaState, [a.name]: { applying: true } });
                          try {
                            await jsonPost('/api/admin/scaling/container-apps', {
                              name: a.name,
                              workloadProfileName: pendingProfile,
                              minReplicas: pendingMin,
                              maxReplicas: pendingMax,
                            });
                            setAcaState({ ...acaState, [a.name]: { ok: 'Scale applied' } });
                          } catch (e: any) { setAcaState({ ...acaState, [a.name]: { error: e.message } }); }
                        }}
                        disabled={st.applying}
                        style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, cursor: 'pointer', opacity: st.applying ? 0.5 : 1, fontSize: 12 }}
                      >
                        {st.applying ? '…' : 'Apply'}
                      </button>
                    </div>
                    {st.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{st.error}</Caption1>}
                    {st.ok && <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>{st.ok}</Caption1>}
                  </div>
                );
              })}
              {acaData?.ok && (acaData.apps?.length ?? 0) === 0 && <Caption1>No container apps in this RG.</Caption1>}

              {/* MCP server — Azure Files mount (persistence). Deploy path, not a SKU dial. */}
              <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 10, marginTop: 4 }}>
                <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11, color: tokens.colorNeutralForeground2 }}>
                  MCP server — persistent storage (Azure Files)
                </Caption1>
                {mcpData && !mcpData.ok ? (
                  <MessageBar intent="warning" style={{ marginTop: 6 }}>
                    <MessageBarBody>
                      {mcpData.error}{mcpData.hint ? ` — ${mcpData.hint}` : ''}
                    </MessageBarBody>
                  </MessageBar>
                ) : (
                  <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 10, marginTop: 6 }}>
                    <Caption1>
                      Mounts <strong>{mcpData?.config?.shareName || 'the MCP file share'}</strong> on{' '}
                      <strong>{mcpData?.config?.storageAccount || '…'}</strong> into the loom-mcp container at the
                      mount path below. Applying rolls a new revision (brief connection drop).
                    </Caption1>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <Caption1 id="mcp-mount-path-label" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>Mount path</Caption1>
                        <Input style={{ width: 160 }} aria-labelledby="mcp-mount-path-label" placeholder="/data"
                          value={mcpSel.mountPath ?? mcpData?.config?.mountPath ?? '/data'}
                          onChange={(_, d) => setMcpSel({ ...mcpSel, mountPath: d.value })} />
                      </div>
                      <ScalePicker
                        label="Access mode"
                        options={[{ value: 'ReadWrite', label: 'ReadWrite' }, { value: 'ReadOnly', label: 'ReadOnly' }]}
                        value={mcpSel.accessMode ?? 'ReadWrite'}
                        onChange={(v) => setMcpSel({ ...mcpSel, accessMode: v as 'ReadWrite' | 'ReadOnly' })}
                      />
                      <button
                        type="button"
                        aria-label="Mount Azure Files persistence onto the MCP container"
                        onClick={async () => {
                          setMcpState({ applying: true });
                          try {
                            const r = await jsonPost('/api/admin/mcp-servers/deploy', {
                              mountPath: mcpSel.mountPath ?? mcpData?.config?.mountPath,
                              accessMode: mcpSel.accessMode ?? 'ReadWrite',
                            });
                            setMcpState({ ok: `Mounted at ${r.mountPath} — new revision rolling` });
                          } catch (e: any) { setMcpState({ error: e.message }); }
                        }}
                        disabled={mcpState.applying}
                        style={{ padding: '6px 16px', borderRadius: 4, border: 'none', background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, cursor: mcpState.applying ? 'default' : 'pointer', opacity: mcpState.applying ? 0.5 : 1, fontSize: 12 }}
                      >
                        {mcpState.applying ? 'Mounting…' : 'Mount persistence'}
                      </button>
                    </div>
                    {mcpState.error && <Caption1 role="alert" style={{ display: 'block', marginTop: 6, color: tokens.colorPaletteRedForeground1 }}>{mcpState.error}</Caption1>}
                    {mcpState.ok && <Caption1 role="status" style={{ display: 'block', marginTop: 6, color: tokens.colorPaletteGreenForeground1 }}>{mcpState.ok}</Caption1>}
                  </div>
                )}
              </div>
            </div>
          }
        />

        {/* Foundry compute */}
        <ServiceCard
          title="AI Foundry — AML compute"
          subtitle="vmSize + min/max nodes for AmlCompute targets."
          loading={!foundryData}
          gateMessage={foundryData && !foundryData.ok ? { title: 'AI Foundry not configured', body: `${foundryData.error}${foundryData.hint ? ' — ' + foundryData.hint : ''}` } : undefined}
          controls={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
              {(foundryData?.computes || []).map((c: any) => {
                const sel = foundrySel[c.name] || {};
                const st = foundryState[c.name] || {};
                const isPatchable = c.computeType === 'AmlCompute';
                return (
                  <div key={c.name} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 8 }}>
                    <Caption1><strong>{c.name}</strong> ({c.computeType} · {c.vmSize || 'unknown'} · {c.state || 'unknown'})</Caption1>
                    {!isPatchable ? (
                      <Caption1 style={{ fontStyle: 'italic', color: tokens.colorNeutralForeground3 }}>
                        {c.computeType} cannot be PATCHed; delete + recreate to change vmSize (Azure ML limit).
                      </Caption1>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>vmSize</Caption1>
                          <Input style={{ width: 180 }} value={sel.vmSize ?? c.vmSize ?? ''}
                            onChange={(_, d) => setFoundrySel({ ...foundrySel, [c.name]: { ...sel, vmSize: d.value } })} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>min nodes</Caption1>
                          <Input type="number" style={{ width: 70 }} value={String(sel.minNodeCount ?? 0)}
                            onChange={(_, d) => setFoundrySel({ ...foundrySel, [c.name]: { ...sel, minNodeCount: parseInt(d.value, 10) || 0 } })} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Caption1 style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>max nodes</Caption1>
                          <Input type="number" style={{ width: 70 }} value={String(sel.maxNodeCount ?? 1)}
                            onChange={(_, d) => setFoundrySel({ ...foundrySel, [c.name]: { ...sel, maxNodeCount: parseInt(d.value, 10) || 1 } })} />
                        </div>
                        <button
                          onClick={async () => {
                            setFoundryState({ ...foundryState, [c.name]: { applying: true } });
                            try {
                              await jsonPost('/api/admin/scaling/foundry-compute', { name: c.name, ...sel });
                              setFoundryState({ ...foundryState, [c.name]: { ok: 'Compute scale submitted' } });
                            } catch (e: any) { setFoundryState({ ...foundryState, [c.name]: { error: e.message } }); }
                          }}
                          disabled={st.applying}
                          style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, cursor: 'pointer', opacity: st.applying ? 0.5 : 1, fontSize: 12 }}
                        >
                          {st.applying ? '…' : 'Apply'}
                        </button>
                      </div>
                    )}
                    {st.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{st.error}</Caption1>}
                    {st.ok && <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>{st.ok}</Caption1>}
                  </div>
                );
              })}
              {foundryData?.ok && (foundryData.computes?.length ?? 0) === 0 && <Caption1>No AML compute targets.</Caption1>}
            </div>
          }
        />

      </div>

      <MessageBar intent="info" style={{ marginTop: 24 }}>
        <MessageBarTitle>Utilization metrics deferred</MessageBarTitle>
        <MessageBarBody>
          Current-utilization indicators (DBU / CPU / req-rate / RU consumption)
          require Azure Monitor metrics per resource — that's a separate piece of
          work. Today this page surfaces only the dial; the admin runs the scale
          decision themselves. Per .claude/rules/no-vaporware.md we do not show
          AI-hallucinated utilization numbers.
        </MessageBarBody>
      </MessageBar>
    </AdminShell>
  );
}

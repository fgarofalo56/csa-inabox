'use client';

// incremental-refresh-tab.tsx — the incremental-refresh policy + hybrid-table +
// enhanced-refresh surface, extracted VERBATIM from ../semantic-model-editor.tsx
// as part of the R10 decomposition. PURELY STRUCTURAL: no behaviour change.
//
// --- Incremental refresh policy + hybrid table (current-period DirectQuery) ---
// Mirrors the Power BI Desktop "Incremental refresh and real-time data" dialog:
// archive (keep) range, incremental refresh range, real-time DirectQuery toggle,
// detect-changes column. Writes via PUT /refresh-policy → aas-incremental-refresh
// (TMSL Alter + Refresh applyRefreshPolicy). Opt-in AAS backend; default stays
// loom-native.
//
// The cluster has no effects — only `useState` + `useCallback` — so the parent
// calls the hook once, unconditionally, where the callbacks used to sit (after
// `loadRefreshes`, which `triggerEnhancedRefresh` closes over).

import { useCallback, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Select, Switch, SpinButton, tokens,
} from '@fluentui/react-components';
import { Play20Regular, Save20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { TableLite } from './types';

export const GRAINS = ['day', 'month', 'quarter', 'year'] as const;
export type Grain = typeof GRAINS[number];

export interface IncrementalRefreshApi {
  irTableName: string;
  setIrTableName: (v: string) => void;
  irRollingWindowPeriods: number;
  setIrRollingWindowPeriods: (v: number) => void;
  irRollingWindowGranularity: Grain;
  setIrRollingWindowGranularity: (v: Grain) => void;
  irIncrementalPeriods: number;
  setIrIncrementalPeriods: (v: number) => void;
  irIncrementalGranularity: Grain;
  setIrIncrementalGranularity: (v: Grain) => void;
  irEnableHybrid: boolean;
  setIrEnableHybrid: (v: boolean) => void;
  irPollingExpression: string;
  setIrPollingExpression: (v: string) => void;
  irEffectiveDate: string;
  setIrEffectiveDate: (v: string) => void;
  irBusy: boolean;
  irMsg: { ok: boolean; text: string } | null;
  irPartitions: Array<{ name: string; storageMode: string; queryDefinition?: string }>;
  irGate: string | null;
  enhBusy: boolean;
  enhMsg: { ok: boolean; text: string } | null;
  enhApplyPolicy: boolean;
  setEnhApplyPolicy: (v: boolean) => void;
  enhEffectiveDate: string;
  setEnhEffectiveDate: (v: string) => void;
  enhCommitMode: 'transactional' | 'partialBatch';
  setEnhCommitMode: (v: 'transactional' | 'partialBatch') => void;
  loadIrPolicy: () => Promise<void>;
  saveIrPolicy: () => Promise<void>;
  triggerEnhancedRefresh: () => Promise<void>;
}

export function useSemanticModelIncrementalRefresh({
  workspaceId, datasetId, loadRefreshes,
}: {
  workspaceId: string;
  datasetId: string;
  loadRefreshes: (wsId: string, dsId: string) => Promise<void> | void;
}): IncrementalRefreshApi {
  const [irTableName, setIrTableName] = useState('');
  const [irRollingWindowPeriods, setIrRollingWindowPeriods] = useState(3);
  const [irRollingWindowGranularity, setIrRollingWindowGranularity] = useState<Grain>('year');
  const [irIncrementalPeriods, setIrIncrementalPeriods] = useState(10);
  const [irIncrementalGranularity, setIrIncrementalGranularity] = useState<Grain>('day');
  const [irEnableHybrid, setIrEnableHybrid] = useState(false);
  const [irPollingExpression, setIrPollingExpression] = useState('');
  const [irEffectiveDate, setIrEffectiveDate] = useState('');
  const [irBusy, setIrBusy] = useState(false);
  const [irMsg, setIrMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [irPartitions, setIrPartitions] = useState<Array<{ name: string; storageMode: string; queryDefinition?: string }>>([]);
  const [irGate, setIrGate] = useState<string | null>(null);
  // Enhanced refresh (apply-policy + targeted) controls.
  const [enhBusy, setEnhBusy] = useState(false);
  const [enhMsg, setEnhMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [enhApplyPolicy, setEnhApplyPolicy] = useState(true);
  const [enhEffectiveDate, setEnhEffectiveDate] = useState('');
  const [enhCommitMode, setEnhCommitMode] = useState<'transactional' | 'partialBatch'>('transactional');

  // Load the live partition schema (TMSCHEMA_PARTITIONS via AAS XMLA). Surfaces
  // the honest AAS config gate when LOOM_SEMANTIC_BACKEND!=analysis-services.
  const loadIrPolicy = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setIrGate(null); setIrPartitions([]);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh-policy?workspaceId=${encodeURIComponent(workspaceId)}&tableName=${encodeURIComponent(irTableName)}`);
      const j = await r.json();
      if (!j.ok) { setIrGate(j.error); return; }
      setIrPartitions(j.partitions || []);
    } catch (e: any) { setIrGate(e?.message || String(e)); }
  }, [workspaceId, datasetId, irTableName]);

  // Apply an incremental refresh policy: TMSL Alter (set policy) + TMSL Refresh
  // (applyRefreshPolicy:true → historical Import partitions + live DQ partition
  // when Hybrid). The receipt is the resulting partition list.
  const saveIrPolicy = useCallback(async () => {
    if (!workspaceId || !datasetId || !irTableName) return;
    setIrBusy(true); setIrMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh-policy?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tableName: irTableName,
          policy: {
            rollingWindowGranularity: irRollingWindowGranularity,
            rollingWindowPeriods: irRollingWindowPeriods,
            incrementalGranularity: irIncrementalGranularity,
            incrementalPeriods: irIncrementalPeriods,
            mode: irEnableHybrid ? 'Hybrid' : 'Import',
            ...(irPollingExpression.trim() ? { pollingExpression: irPollingExpression.trim() } : {}),
          },
          ...(irEffectiveDate.trim() ? { effectiveDate: irEffectiveDate.trim() } : {}),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setIrMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setIrPartitions(j.partitions || []);
      const dq = (j.partitions || []).filter((p: any) => p.storageMode === 'DirectQuery').length;
      setIrMsg({ ok: true, text: `Policy applied. ${j.partitions?.length ?? 0} partition(s)${dq ? `, including ${dq} live DirectQuery partition` : ''}.` });
    } catch (e: any) { setIrMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setIrBusy(false); }
  }, [workspaceId, datasetId, irTableName, irRollingWindowGranularity, irRollingWindowPeriods, irIncrementalGranularity, irIncrementalPeriods, irEnableHybrid, irPollingExpression, irEffectiveDate]);

  // Enhanced (async) refresh — POST /refreshes with commitMode + applyRefreshPolicy
  // + effectiveDate. Refreshes the rolling Import partitions per the policy while
  // leaving historical + DQ partitions intact.
  const triggerEnhancedRefresh = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setEnhBusy(true); setEnhMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refreshes?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'full',
          commitMode: enhCommitMode,
          applyRefreshPolicy: enhApplyPolicy,
          ...(enhEffectiveDate.trim() ? { effectiveDate: enhEffectiveDate.trim() } : {}),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setEnhMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setEnhMsg({ ok: true, text: `Enhanced refresh queued (requestId: ${String(j.requestId || '').slice(0, 8)}…).` });
      setTimeout(() => loadRefreshes(workspaceId, datasetId), 2000);
    } catch (e: any) { setEnhMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setEnhBusy(false); }
  }, [workspaceId, datasetId, enhCommitMode, enhApplyPolicy, enhEffectiveDate, loadRefreshes]);

  return {
    irTableName, setIrTableName,
    irRollingWindowPeriods, setIrRollingWindowPeriods,
    irRollingWindowGranularity, setIrRollingWindowGranularity,
    irIncrementalPeriods, setIrIncrementalPeriods,
    irIncrementalGranularity, setIrIncrementalGranularity,
    irEnableHybrid, setIrEnableHybrid,
    irPollingExpression, setIrPollingExpression,
    irEffectiveDate, setIrEffectiveDate,
    irBusy, irMsg, irPartitions, irGate,
    enhBusy, enhMsg,
    enhApplyPolicy, setEnhApplyPolicy,
    enhEffectiveDate, setEnhEffectiveDate,
    enhCommitMode, setEnhCommitMode,
    loadIrPolicy, saveIrPolicy, triggerEnhancedRefresh,
  };
}

export function SemanticModelIncrementalRefreshTab({
  s, ir, tables, workspaceId, datasetId,
}: {
  s: Record<string, string>;
  ir: IncrementalRefreshApi;
  tables: TableLite[] | undefined;
  workspaceId: string;
  datasetId: string;
}) {
  const {
    irTableName, setIrTableName,
    irRollingWindowPeriods, setIrRollingWindowPeriods,
    irRollingWindowGranularity, setIrRollingWindowGranularity,
    irIncrementalPeriods, setIrIncrementalPeriods,
    irIncrementalGranularity, setIrIncrementalGranularity,
    irEnableHybrid, setIrEnableHybrid,
    irPollingExpression, setIrPollingExpression,
    irEffectiveDate, setIrEffectiveDate,
    irBusy, irMsg, irPartitions, irGate,
    enhBusy, enhMsg,
    enhApplyPolicy, setEnhApplyPolicy,
    enhEffectiveDate, setEnhEffectiveDate,
    enhCommitMode, setEnhCommitMode,
    loadIrPolicy, saveIrPolicy, triggerEnhancedRefresh,
  } = ir;
  return (
    <>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Incremental refresh + hybrid table (current-period DirectQuery)</MessageBarTitle>
          Sets a <code>refreshPolicy</code> on a table (TMSL Alter over the Azure Analysis Services XMLA
          endpoint), then applies it (TMSL Refresh, <code>applyRefreshPolicy:true</code>) to create historical
          Import partitions and — when <em>real-time DirectQuery partition</em> is enabled — a live
          DirectQuery partition for the current period. Requires <code>LOOM_SEMANTIC_BACKEND=analysis-services</code>{' '}
          and <code>LOOM_AAS_XMLA_ENDPOINT</code> (compatibility level 1565+ for Hybrid mode). AAS is an
          Azure-native PaaS — no Microsoft Fabric or Power BI workspace required.{' '}
          <a href="https://learn.microsoft.com/power-bi/connect-data/incremental-refresh-xmla" target="_blank" rel="noreferrer">Docs</a>
        </MessageBarBody>
      </MessageBar>
      {irGate && (
        <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS}}>
          <MessageBarBody><MessageBarTitle>Azure Analysis Services not configured</MessageBarTitle>{irGate}</MessageBarBody>
        </MessageBar>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, maxWidth: 580 }}>
        <Field label="Table" required>
          <Select value={irTableName} onChange={(_, d) => setIrTableName(d.value)}>
            <option value="">(select a table)</option>
            {(tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </Select>
        </Field>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
          <Field label="Archive data starting (keep)" style={{ flex: 1 }}>
            <SpinButton min={1} value={irRollingWindowPeriods} onChange={(_, d) => setIrRollingWindowPeriods(Math.max(1, Number(d.value ?? d.displayValue ?? irRollingWindowPeriods)))} />
          </Field>
          <Field label="Unit" style={{ minWidth: 120 }}>
            <Select value={irRollingWindowGranularity} onChange={(_, d) => setIrRollingWindowGranularity(d.value as Grain)}>
              {GRAINS.map((g) => <option key={g} value={g}>{g}(s)</option>)}
            </Select>
          </Field>
        </div>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
          <Field label="Incrementally refresh data in the last" style={{ flex: 1 }}>
            <SpinButton min={1} value={irIncrementalPeriods} onChange={(_, d) => setIrIncrementalPeriods(Math.max(1, Number(d.value ?? d.displayValue ?? irIncrementalPeriods)))} />
          </Field>
          <Field label="Unit" style={{ minWidth: 120 }}>
            <Select value={irIncrementalGranularity} onChange={(_, d) => setIrIncrementalGranularity(d.value as Grain)}>
              {GRAINS.map((g) => <option key={g} value={g}>{g}(s)</option>)}
            </Select>
          </Field>
        </div>
        <Switch
          label="Get the latest data in real time with DirectQuery (hybrid table — adds a live current-period partition)"
          checked={irEnableHybrid}
          onChange={(_, d) => setIrEnableHybrid(d.checked)}
        />
        <Field label="Detect data changes — column expression (optional M, e.g. Table.Max(FactSales, &quot;LastModified&quot;)[LastModified])">
          <Input value={irPollingExpression} onChange={(_, d) => setIrPollingExpression(d.value)} placeholder='Table.Max(FactSales, "LastModified")[LastModified]' />
        </Field>
        <Field label="Effective date override (ISO, optional — overrides &quot;today&quot; for the rolling window)">
          <Input value={irEffectiveDate} onChange={(_, d) => setIrEffectiveDate(d.value)} placeholder="2025-06-08" />
        </Field>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
          <Button appearance="primary" icon={<Save20Regular />} disabled={irBusy || !workspaceId || !datasetId || !irTableName} onClick={saveIrPolicy}>
            {irBusy ? 'Applying…' : 'Apply refresh policy'}
          </Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!workspaceId || !datasetId} onClick={loadIrPolicy}>
            Load partitions
          </Button>
        </div>
        {irMsg && <MessageBar intent={irMsg.ok ? 'success' : 'error'}><MessageBarBody>{irMsg.text}</MessageBarBody></MessageBar>}
      </div>

      {irPartitions.length > 0 && (
        <>
          <Subtitle2 style={{ marginTop: tokens.spacingVerticalXL }}>Partition receipt ({irPartitions.length})</Subtitle2>
          <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
            <Table aria-label="Partitions" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Partition</TableHeaderCell>
                <TableHeaderCell>Storage mode</TableHeaderCell>
                <TableHeaderCell>Query / source</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {irPartitions.map((p) => (
                  <TableRow key={p.name} style={p.storageMode === 'DirectQuery' ? { background: tokens.colorBrandBackground2 } : undefined}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>
                      <Badge appearance={p.storageMode === 'DirectQuery' ? 'filled' : 'outline'} color={p.storageMode === 'DirectQuery' ? 'brand' : 'informative'}>{p.storageMode}</Badge>
                    </TableCell>
                    <TableCell className={s.cell}><code style={{ fontSize: tokens.fontSizeBase100}}>{p.queryDefinition?.slice(0, 140) || '—'}</code></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <Subtitle2 style={{ marginTop: tokens.spacingVerticalXXL }}>Enhanced refresh (apply policy)</Subtitle2>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        POST /refreshes with <code>commitMode</code>, <code>applyRefreshPolicy</code> and <code>effectiveDate</code>.
        Refreshes the rolling Import partitions per the policy; the historical and live DirectQuery partitions stay intact.
      </Caption1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS, maxWidth: 580 }}>
        <Switch label="Apply refresh policy (creates / reshuffles partitions)" checked={enhApplyPolicy} onChange={(_, d) => setEnhApplyPolicy(d.checked)} />
        <Field label="Commit mode">
          <Select value={enhCommitMode} onChange={(_, d) => setEnhCommitMode(d.value as 'transactional' | 'partialBatch')}>
            <option value="transactional">transactional (all-or-nothing)</option>
            <option value="partialBatch" disabled={enhApplyPolicy}>partialBatch (per-partition commit — not valid with applyRefreshPolicy)</option>
          </Select>
        </Field>
        <Field label="Effective date override (ISO, optional)">
          <Input value={enhEffectiveDate} onChange={(_, d) => setEnhEffectiveDate(d.value)} placeholder="2025-06-08" />
        </Field>
        <Button appearance="primary" icon={<Play20Regular />} disabled={enhBusy || !workspaceId || !datasetId} onClick={triggerEnhancedRefresh}>
          {enhBusy ? 'Queuing…' : 'Run enhanced refresh'}
        </Button>
        {enhMsg && <MessageBar intent={enhMsg.ok ? 'success' : 'error'}><MessageBarBody>{enhMsg.text}</MessageBarBody></MessageBar>}
      </div>

      <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalXL }}>
        <MessageBarBody>
          <MessageBarTitle>Scheduled refresh trigger</MessageBarTitle>
          To run this enhanced refresh on a timer, author a Synapse / ADF ScheduleTrigger with a Web Activity
          that POSTs to this dataset&apos;s refresh endpoint (the <strong>Data pipeline</strong> editor wires the
          pipeline; <code>synapse-dev-client.upsertTrigger()</code> creates the trigger when
          <code>LOOM_SYNAPSE_WORKSPACE</code> is configured). The daily run refreshes only the rolling Import
          partitions — current-period rows already arrive live through the DirectQuery partition, no full refresh needed.
        </MessageBarBody>
      </MessageBar>
    </>
  );
}

'use client';

// direct-lake-tab.tsx — the Direct Lake (shim) configuration surface, extracted
// VERBATIM from ../semantic-model-editor.tsx as part of the R10 decomposition.
// PURELY STRUCTURAL: no behaviour change.
//
// --- Direct Lake (shim) tab -------------------------------------------------
// Azure-native parity for Fabric Direct Lake: the shim keeps a warm AAS
// (Power BI Premium XMLA) cache fresh from an ADLS Gen2 Delta source, driven
// by _delta_log Event Grid notifications. Config persists to the shim's
// Cosmos store via PUT /api/items/semantic-model/{id}/direct-lake.
//
// The hook keeps the cluster's state + effects; the parent calls it
// UNCONDITIONALLY at the exact position the raw `useState` block occupied, so
// hook order, effect order, and mount lifetime are unchanged. `tab` is passed
// through verbatim (rather than a derived `active` boolean) so the effects'
// dependency arrays stay byte-identical to the pre-refactor ones.

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Select, tokens,
} from '@fluentui/react-components';
import { Save20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { TableLite, SemanticModelTab } from './types';
import type { Phase3Styles } from '../styles';

export type DlPolicy = 'Partition' | 'Full' | 'DirectQueryFallback' | 'Composite';
export type DlTableRow = { tableName: string; policy: DlPolicy; partitionColumn: string };
export interface DlShimRun { requestId: string; refreshType?: string; status?: string; startTime?: string; endTime?: string; durationMs?: number; error?: string }
export interface DlEventGrid { systemTopic: string; topicState: string; subscriptionName: string; subscriptionState: string; destinationQueueId?: string }
const DL_SLA_OPTIONS = [
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 3600, label: '1 hour' },
  { value: -1, label: 'On change (Event Grid trigger)' },
];
const DL_POLICIES: Array<{ value: DlPolicy; label: string }> = [
  { value: 'Partition', label: 'Partition (incremental — Direct Lake sweet spot)' },
  { value: 'Full', label: 'Full table refresh' },
  { value: 'DirectQueryFallback', label: 'DirectQuery (always live)' },
  { value: 'Composite', label: 'Composite (Import + DirectQuery)' },
];
const DEFAULT_DL_PATH_HINT = 'abfss://gold@<account>.dfs.core.windows.net/<delta-table-path>';

export interface DirectLakeApi {
  dlEnabled: boolean | null;
  dlHint: string;
  dlDeltaPath: string;
  setDlDeltaPath: Dispatch<SetStateAction<string>>;
  dlSla: number;
  setDlSla: Dispatch<SetStateAction<number>>;
  dlTables: DlTableRow[];
  dlRuns: DlShimRun[];
  dlEventGrid: DlEventGrid | null;
  dlBusy: boolean;
  dlLoading: boolean;
  dlMsg: { ok: boolean; text: string } | null;
  loadDirectLake: (dsId: string) => Promise<void>;
  setDlTablePolicy: (idx: number, policy: DlPolicy) => void;
  setDlTablePartCol: (idx: number, partitionColumn: string) => void;
  saveDirectLake: () => Promise<void>;
}

export function useSemanticModelDirectLake({
  tab, datasetId, workspaceId, tables,
}: { tab: SemanticModelTab; datasetId: string; workspaceId: string; tables: TableLite[] | undefined }): DirectLakeApi {
  const [dlEnabled, setDlEnabled] = useState<boolean | null>(null); // null = unknown until first load
  const [dlHint, setDlHint] = useState<string>('');
  const [dlDeltaPath, setDlDeltaPath] = useState('');
  const [dlSla, setDlSla] = useState<number>(300);
  const [dlTables, setDlTables] = useState<DlTableRow[]>([]);
  const [dlRuns, setDlRuns] = useState<DlShimRun[]>([]);
  const [dlEventGrid, setDlEventGrid] = useState<DlEventGrid | null>(null);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlLoading, setDlLoading] = useState(false);
  const [dlMsg, setDlMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadDirectLake = useCallback(async (dsId: string) => {
    if (!dsId) return;
    setDlLoading(true); setDlMsg(null);
    try {
      // #2649: NO `workspaceId` param. The shim's Power BI workspace is recorded
      // in the model's OWN Cosmos shim config (written by the PUT below) and the
      // route already falls back to it — `?workspaceId=` here only ever carried
      // the editor's auto-picked FIRST Power BI groupId, which stamped a Power
      // BI id into a Loom item URL and named a workspace this model may not be
      // in. The stored config is the authoritative binding.
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/direct-lake`);
      const j = await r.json();
      if (!j.ok) { setDlMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); setDlEnabled(true); return; }
      setDlEnabled(!!j.shimEnabled);
      setDlHint(j.hint || '');
      setDlRuns(Array.isArray(j.runs) ? j.runs : []);
      setDlEventGrid(j.eventGrid || null);
      if (j.config) {
        setDlDeltaPath(j.config.deltaSourcePath || '');
        setDlSla(typeof j.config.freshnessSlaSeconds === 'number' ? j.config.freshnessSlaSeconds : 300);
        const rows: DlTableRow[] = Object.values(j.config.tables || {}).map((t: any) => ({
          tableName: t.tableName || '', policy: (t.policy as DlPolicy) || 'Partition', partitionColumn: t.partitionColumn || '',
        }));
        if (rows.length) setDlTables(rows);
      }
    } catch (e: any) { setDlMsg({ ok: false, text: e?.message || String(e) }); setDlEnabled(true); }
    finally { setDlLoading(false); }
  }, []);

  // Seed the per-table policy grid from the model's tables when none is loaded
  // yet, so the operator sees one row per table to configure.
  useEffect(() => {
    if (tab !== 'direct-lake') return;
    setDlTables((prev) => {
      if (prev.length) return prev;
      const fromModel = (tables || []).map((t) => ({ tableName: t.name, policy: 'Partition' as DlPolicy, partitionColumn: '' }));
      return fromModel;
    });
  }, [tab, tables]);

  useEffect(() => {
    if (tab === 'direct-lake' && datasetId) loadDirectLake(datasetId);
  }, [tab, datasetId, loadDirectLake]);

  const setDlTablePolicy = useCallback((idx: number, policy: DlPolicy) => {
    setDlTables((prev) => prev.map((row, i) => (i === idx ? { ...row, policy } : row)));
  }, []);
  const setDlTablePartCol = useCallback((idx: number, partitionColumn: string) => {
    setDlTables((prev) => prev.map((row, i) => (i === idx ? { ...row, partitionColumn } : row)));
  }, []);

  const saveDirectLake = useCallback(async () => {
    if (!datasetId || !workspaceId || !dlDeltaPath.trim()) {
      setDlMsg({ ok: false, text: 'Select a workspace + dataset and enter the ADLS Gen2 Delta source path first.' });
      return;
    }
    setDlBusy(true); setDlMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/direct-lake`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deltaSourcePath: dlDeltaPath.trim(),
          freshnessSlaSeconds: dlSla,
          workspaceId,
          datasetId,
          tables: dlTables.filter((t) => t.tableName.trim()).map((t) => ({
            tableName: t.tableName.trim(), policy: t.policy,
            ...(t.partitionColumn.trim() ? { partitionColumn: t.partitionColumn.trim() } : {}),
          })),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setDlMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setDlEventGrid(j.eventGrid || null);
      setDlMsg({ ok: true, text: j.eventGridNote ? `Saved. Event Grid wiring deferred: ${j.eventGridNote}` : 'Direct Lake (shim) configured. The shim picks up the new policy within ~60 s.' });
      if (j.config?.deltaSourcePath) setDlDeltaPath(j.config.deltaSourcePath);
    } catch (e: any) { setDlMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setDlBusy(false); }
  }, [datasetId, workspaceId, dlDeltaPath, dlSla, dlTables]);

  return {
    dlEnabled, dlHint, dlDeltaPath, setDlDeltaPath, dlSla, setDlSla,
    dlTables, dlRuns, dlEventGrid, dlBusy, dlLoading, dlMsg,
    loadDirectLake, setDlTablePolicy, setDlTablePartCol, saveDirectLake,
  };
}

export function SemanticModelDirectLakeTab({
  s, dl, datasetId,
}: {
  s: Phase3Styles;
  dl: DirectLakeApi;
  datasetId: string;
}) {
  const {
    dlEnabled, dlHint, dlDeltaPath, setDlDeltaPath, dlSla, setDlSla,
    dlTables, dlRuns, dlEventGrid, dlBusy, dlLoading, dlMsg,
    loadDirectLake, setDlTablePolicy, setDlTablePartCol, saveDirectLake,
  } = dl;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: 820 }}>
      <div>
        <Subtitle2>Direct Lake (shim)</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXXS }}>
          Azure-native parity for Fabric Direct Lake. The shim keeps a warm AAS (Power BI Premium XMLA)
          cache fresh from an ADLS Gen2 Delta source — triggered by <code>_delta_log</code> Event Grid
          notifications — so the model reflects new Delta rows within the freshness SLA.
        </Caption1>
      </div>

      {/* Honest, always-on disclosure — cloud-invariant. */}
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>This is an AAS incremental-refresh shim, not a Fabric F-SKU</MessageBarTitle>
          True Direct Lake sub-second freshness requires a Fabric F-SKU (unavailable in Gov). This shim
          achieves 5–30 s via AAS incremental refresh via Power BI Premium XMLA. Set
          {' '}<code>LOOM_DIRECT_LAKE_SHIM_ENABLED=true</code> to activate.
        </MessageBarBody>
      </MessageBar>

      {dlEnabled === false ? (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Direct Lake (shim) is not enabled in this deployment</MessageBarTitle>
            {dlHint || 'Set LOOM_DIRECT_LAKE_SHIM_ENABLED=true to activate the shim.'} Deploy the shim
            container app, its Service Bus queue, and the Event Grid system topic via
            {' '}<code>platform/fiab/bicep/modules/admin-plane/aas.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <>
          {dlEventGrid && (
            <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge appearance="filled" color={dlEventGrid.subscriptionState === 'Succeeded' ? 'success' : 'warning'}>
                Event Grid: {dlEventGrid.subscriptionState}
              </Badge>
              <Caption1>Topic: <strong>{dlEventGrid.systemTopic}</strong> ({dlEventGrid.topicState})</Caption1>
            </div>
          )}

          <Field label="ADLS Gen2 Delta source path" hint="abfss://container@account.dfs… or https://account.dfs…/container/… — populated from the lakehouse the model is built on.">
            <Input value={dlDeltaPath} onChange={(_, d) => setDlDeltaPath(d.value)} placeholder={DEFAULT_DL_PATH_HINT} disabled={dlBusy} />
          </Field>

          <Field label="Freshness SLA">
            <Select value={String(dlSla)} onChange={(_, d) => setDlSla(parseInt(d.value, 10))} disabled={dlBusy}>
              {DL_SLA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>

          <div>
            <Caption1 style={{ fontWeight: 600 }}>Per-table refresh policy</Caption1>
            <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXXS, marginBottom: tokens.spacingVerticalS}}>
              One row per table in the model. Partition is the incremental Direct-Lake sweet spot — set the
              partition column the Delta directory layout encodes (e.g. <code>event_date</code>).
            </Caption1>
            <div className={s.tableWrap}>
              <Table aria-label="Per-table refresh policy" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Table</TableHeaderCell>
                  <TableHeaderCell>Refresh policy</TableHeaderCell>
                  <TableHeaderCell>Partition column</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {dlTables.length === 0 && (
                    <TableRow><TableCell colSpan={3}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No tables loaded yet — open the Tables tab to load the model schema.</Caption1></TableCell></TableRow>
                  )}
                  {dlTables.map((row, idx) => (
                    <TableRow key={row.tableName || idx}>
                      <TableCell>{row.tableName}</TableCell>
                      <TableCell>
                        <Select value={row.policy} onChange={(_, d) => setDlTablePolicy(idx, d.value as DlPolicy)} disabled={dlBusy}>
                          {DL_POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={row.partitionColumn}
                          onChange={(_, d) => setDlTablePartCol(idx, d.value)}
                          placeholder={row.policy === 'Partition' ? 'event_date' : '—'}
                          disabled={dlBusy || row.policy !== 'Partition'}
                          size="small"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
            <Button appearance="primary" icon={<Save20Regular />} disabled={dlBusy || dlLoading} onClick={saveDirectLake}>
              {dlBusy ? 'Saving…' : 'Configure shim'}
            </Button>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={dlLoading || !datasetId} onClick={() => loadDirectLake(datasetId)}>
              {dlLoading ? 'Loading…' : 'Refresh status'}
            </Button>
          </div>
          {dlMsg && <MessageBar intent={dlMsg.ok ? 'success' : 'error'}><MessageBarBody>{dlMsg.text}</MessageBarBody></MessageBar>}

          <div>
            <Caption1 style={{ fontWeight: 600 }}>Shim run log (last {dlRuns.length})</Caption1>
            <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
              <Table aria-label="Shim refresh runs" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Request</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Start</TableHeaderCell>
                  <TableHeaderCell>Duration</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {dlRuns.length === 0 && (
                    <TableRow><TableCell colSpan={5}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No refresh runs yet. Write new Delta rows to the source to trigger the shim.</Caption1></TableCell></TableRow>
                  )}
                  {dlRuns.map((run, i) => (
                    <TableRow key={run.requestId || i}>
                      <TableCell><span style={{ fontFamily: 'monospace' }}>{(run.requestId || '—').slice(0, 8)}</span></TableCell>
                      <TableCell>{run.refreshType || '—'}</TableCell>
                      <TableCell>
                        <Badge appearance="outline" color={run.status === 'Completed' ? 'success' : run.status === 'Failed' ? 'danger' : 'informative'}>
                          {run.status || 'Unknown'}
                        </Badge>
                      </TableCell>
                      <TableCell>{run.startTime ? new Date(run.startTime).toLocaleString() : '—'}</TableCell>
                      <TableCell>{typeof run.durationMs === 'number' ? `${(run.durationMs / 1000).toFixed(1)} s` : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

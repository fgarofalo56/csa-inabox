'use client';

// aggregations-tab.tsx — the automatic-aggregations (XMLA TMSL `alternateOf`)
// authoring surface, extracted VERBATIM from ../semantic-model-editor.tsx as
// part of the R10 decomposition. PURELY STRUCTURAL: no behaviour change.
//
// --- Automatic aggregations builder (XMLA TMSL alternateOf) --------------
// Defines a hidden, Import-mode aggregation table whose columns each carry an
// alternateOf (BaseTable/BaseColumn + Summarization) so the AS engine routes
// matching queries to the small agg table and falls through to the DirectQuery
// detail table otherwise. Writes via POST /api/items/semantic-model/{id}/model
// → XMLA (Azure Analysis Services by default; Premium/Fabric XMLA opt-in by URL).
//
// State lives in `useSemanticModelAggregations()`, which the parent calls
// UNCONDITIONALLY at the same position the raw `useState`s occupied — so the
// tab keeps its draft across tab switches exactly as before. The component
// below is presentational and receives that api object.

import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  Subtitle2, Caption1, Button, Input, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Select, InfoLabel, tokens,
} from '@fluentui/react-components';
import { Save20Regular, Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { TableLite } from './types';
import type { Phase3Styles } from '../styles';

const AGG_SUMMARIZATIONS = ['GroupBy', 'Sum', 'Count', 'Min', 'Max'] as const;
const AGG_DATATYPES = ['int64', 'double', 'decimal', 'dateTime', 'string', 'boolean'] as const;
type AggSummarization = typeof AGG_SUMMARIZATIONS[number];
type AltMap = { aggColumn: string; dataType: typeof AGG_DATATYPES[number]; summarization: AggSummarization; detailTable: string; detailColumn: string };

export interface AggregationsApi {
  aggTableName: string;
  setAggTableName: Dispatch<SetStateAction<string>>;
  aggPartitionExpr: string;
  setAggPartitionExpr: Dispatch<SetStateAction<string>>;
  aggAltMaps: AltMap[];
  aggProbeQuery: string;
  setAggProbeQuery: Dispatch<SetStateAction<string>>;
  aggBusy: boolean;
  aggMsg: { ok: boolean; text: string } | null;
  aggProbeResult: Array<Record<string, unknown>> | null;
  addAltMap: () => void;
  updateAltMap: (i: number, patch: Partial<AltMap>) => void;
  removeAltMap: (i: number) => void;
  seedAltMapsFromTable: () => void;
  createAggregation: () => Promise<void>;
}

export function useSemanticModelAggregations({
  workspaceId, datasetId, tables,
}: { workspaceId: string; datasetId: string; tables: TableLite[] | undefined }): AggregationsApi {
  const [aggTableName, setAggTableName] = useState('');
  const [aggPartitionExpr, setAggPartitionExpr] = useState('');
  const [aggAltMaps, setAggAltMaps] = useState<AltMap[]>([]);
  const [aggProbeQuery, setAggProbeQuery] = useState('');
  const [aggBusy, setAggBusy] = useState(false);
  const [aggMsg, setAggMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aggProbeResult, setAggProbeResult] = useState<Array<Record<string, unknown>> | null>(null);

  const addAltMap = useCallback(() => {
    setAggAltMaps((prev) => [...prev, { aggColumn: '', dataType: 'double', summarization: 'Sum', detailTable: tables?.[0]?.name || '', detailColumn: '' }]);
  }, [tables]);
  const updateAltMap = useCallback((i: number, patch: Partial<AltMap>) => {
    setAggAltMaps((prev) => prev.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  }, []);
  const removeAltMap = useCallback((i: number) => {
    setAggAltMaps((prev) => prev.filter((_, idx) => idx !== i));
  }, []);

  // Seed a starter set of mappings from the first table's columns: numeric
  // columns → Sum, the first column → GroupBy grain. A UI convenience only —
  // every value stays editable; nothing is applied until Create is clicked.
  const seedAltMapsFromTable = useCallback(() => {
    const t = tables?.[0];
    if (!t) return;
    const cols = t.columns || [];
    const numeric = (dt?: string) => /int|double|decimal|number|currency/i.test(dt || '');
    const seeded: AltMap[] = [];
    cols.forEach((c, idx) => {
      const isNum = numeric(c.dataType);
      seeded.push({
        aggColumn: c.name,
        dataType: isNum ? 'double' : 'string',
        summarization: (idx === 0 || !isNum) ? 'GroupBy' : 'Sum',
        detailTable: t.name,
        detailColumn: c.name,
      });
    });
    setAggAltMaps(seeded);
    if (!aggTableName) setAggTableName(`${t.name}_Agg`);
  }, [tables, aggTableName]);

  const createAggregation = useCallback(async () => {
    if (!workspaceId || !datasetId || !aggTableName.trim() || aggAltMaps.length === 0) return;
    setAggBusy(true); setAggMsg(null); setAggProbeResult(null);
    try {
      const r = await clientFetch(
        `/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'aggregation',
            aggTableName: aggTableName.trim(),
            partitionExpression: aggPartitionExpr.trim(),
            altMaps: aggAltMaps.map((m) => ({
              aggColumn: m.aggColumn.trim(), dataType: m.dataType, summarization: m.summarization,
              detailTable: m.detailTable.trim(), detailColumn: m.detailColumn.trim() || undefined,
            })),
            probeQuery: aggProbeQuery.trim() || undefined,
          }),
        },
      );
      const j = await r.json();
      if (j.xmlaUnavailable) {
        setAggMsg({ ok: false, text: `XMLA endpoint not configured. ${j.detail || 'Set LOOM_POWERBI_XMLA_ENDPOINT to enable aggregation authoring.'}` });
        return;
      }
      if (!j.ok) { setAggMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      const probeNote = j.probeError ? ` Probe query failed: ${j.probeError}` : (j.probeResult ? ' Probe query returned data — the engine answers the agg-grain query.' : '');
      setAggMsg({ ok: true, text: `Aggregation table "${aggTableName.trim()}" registered on model "${j.catalog}".${probeNote}` });
      if (j.probeResult?.rows) setAggProbeResult(j.probeResult.rows);
    } catch (e: any) { setAggMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setAggBusy(false); }
  }, [workspaceId, datasetId, aggTableName, aggPartitionExpr, aggAltMaps, aggProbeQuery]);

  return {
    aggTableName, setAggTableName,
    aggPartitionExpr, setAggPartitionExpr,
    aggAltMaps,
    aggProbeQuery, setAggProbeQuery,
    aggBusy, aggMsg, aggProbeResult,
    addAltMap, updateAltMap, removeAltMap, seedAltMapsFromTable, createAggregation,
  };
}

export function SemanticModelAggregationsTab({
  s, agg, tables, targetStorageMode, datasetId,
}: {
  s: Phase3Styles;
  agg: AggregationsApi;
  tables: TableLite[] | undefined;
  targetStorageMode: string | undefined;
  datasetId: string;
}) {
  const {
    aggTableName, setAggTableName, aggPartitionExpr, setAggPartitionExpr,
    aggAltMaps, aggProbeQuery, setAggProbeQuery, aggBusy, aggMsg, aggProbeResult,
    addAltMap, updateAltMap, removeAltMap, seedAltMapsFromTable, createAggregation,
  } = agg;
  return (
    <>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Automatic aggregations</MessageBarTitle>
          Define a hidden, Import-mode <strong>aggregation table</strong> whose columns each map (via
          <code> alternateOf</code>) to a column in a DirectQuery <strong>detail table</strong> with a
          summarization (GroupBy for grain keys; Sum / Count / Min / Max for measures). The Analysis Services
          engine then automatically rewrites queries that match the agg grain to this small table and falls
          through to the detail table otherwise. Requires the model at compatibility level 1460+ and an XMLA
          endpoint (<code>LOOM_POWERBI_XMLA_ENDPOINT</code> — Azure Analysis Services by default; a Power BI
          Premium / Fabric capacity XMLA endpoint is opt-in by URL). Verify a query-plan hit with SQL Profiler /
          SSMS XEvents → the <strong>Aggregate Table Rewrite Query</strong> event reports
          <code> matchingResult=matchFound</code>.
        </MessageBarBody>
      </MessageBar>
      {targetStorageMode === 'Push' && (
        <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS}}>
          <MessageBarBody>
            <MessageBarTitle>Push datasets do not support XMLA aggregations</MessageBarTitle>
            This model is a push dataset; aggregation tables are written over the XMLA endpoint, which push
            datasets don&rsquo;t expose. Build the model in Import / DirectQuery mode to author aggregations.
          </MessageBarBody>
        </MessageBar>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, maxWidth: 920 }}>
        <Field label="Aggregation table name" required style={{ maxWidth: 420 }}>
          <Input value={aggTableName} onChange={(_, d) => setAggTableName(d.value)} placeholder="Sales_Agg" />
        </Field>
        <Field label="Partition source (Power Query / M expression)" hint='The query that produces the pre-aggregated rows, e.g. Value.NativeQuery over a "SELECT CustomerKey, SUM(SalesAmount) AS SalesAmount FROM FactSales GROUP BY CustomerKey". Import-mode partition.'>
          <MonacoTextarea value={aggPartitionExpr} onChange={setAggPartitionExpr} language="plaintext" height={120} ariaLabel="Aggregation partition M expression" />
        </Field>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Subtitle2>Column mappings ({aggAltMaps.length})</Subtitle2>
          <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
            <Button size="small" appearance="outline" onClick={seedAltMapsFromTable} disabled={!tables?.length} title="seed starter mappings from the first table's columns (editable)">Seed from first table</Button>
            <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addAltMap}>Add mapping</Button>
          </div>
        </div>
        {aggAltMaps.length === 0 ? (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No mappings yet. Add a GroupBy mapping for each grain key and a Sum/Count/Min/Max mapping for each measure.</Caption1>
        ) : (
          <div className={s.tableWrap}>
            <Table aria-label="Aggregation column mappings" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell><InfoLabel info="The column created on the hidden, Import-mode aggregation table. It stores a pre-aggregated value the engine can substitute for queries against the detail table.">Agg column</InfoLabel></TableHeaderCell>
                <TableHeaderCell>Data type</TableHeaderCell>
                <TableHeaderCell><InfoLabel info="How this column rolls up the detail data: GroupBy for grain/key columns, or Sum / Count / Min / Max for measures. The engine only rewrites a query to the agg table when its grain and summarizations match.">Summarization</InfoLabel></TableHeaderCell>
                <TableHeaderCell><InfoLabel info="The DirectQuery detail table this aggregation column maps to (via alternateOf). Queries answerable at the agg grain hit the small agg table; everything else falls through to this detail table.">Detail table</InfoLabel></TableHeaderCell>
                <TableHeaderCell>Detail column</TableHeaderCell>
                <TableHeaderCell />
              </TableRow></TableHeader>
              <TableBody>
                {aggAltMaps.map((m, i) => (
                  <TableRow key={i}>
                    <TableCell><Input size="small" value={m.aggColumn} onChange={(_, d) => updateAltMap(i, { aggColumn: d.value })} placeholder="SalesAmount" /></TableCell>
                    <TableCell>
                      <Select size="small" value={m.dataType} onChange={(_, d) => updateAltMap(i, { dataType: d.value as AltMap['dataType'] })}>
                        {AGG_DATATYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select size="small" value={m.summarization} onChange={(_, d) => updateAltMap(i, { summarization: d.value as AggSummarization })}>
                        {AGG_SUMMARIZATIONS.map((su) => <option key={su} value={su}>{su}</option>)}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select size="small" value={m.detailTable} onChange={(_, d) => updateAltMap(i, { detailTable: d.value })}>
                        <option value="">— select —</option>
                        {(tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input size="small" value={m.detailColumn} onChange={(_, d) => updateAltMap(i, { detailColumn: d.value })} placeholder={m.summarization === 'Count' ? '(rows — optional)' : 'SalesAmount'} />
                    </TableCell>
                    <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeAltMap(i)} title="remove mapping" aria-label="Remove column mapping" /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <Field label="Probe DAX (optional)" hint={'Runs after the agg table is applied to prove the engine answers a query at the agg grain, e.g. EVALUATE SUMMARIZECOLUMNS(\'FactSales\'[CustomerKey], "Total", SUM(\'FactSales\'[SalesAmount])). Confirm the actual query-plan hit in SQL Profiler’s Aggregate Table Rewrite Query event.'}>
          <MonacoTextarea value={aggProbeQuery} onChange={setAggProbeQuery} language="sql" height={90} ariaLabel="Probe DAX query" />
        </Field>

        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
          <Button appearance="primary" icon={<Save20Regular />}
            onClick={createAggregation}
            disabled={aggBusy || !datasetId || !aggTableName.trim() || !aggPartitionExpr.trim() || aggAltMaps.length === 0 || targetStorageMode === 'Push'}>
            {aggBusy ? 'Applying…' : 'Create aggregation table'}
          </Button>
          {!datasetId && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Select a model first.</Caption1>}
        </div>
        {aggMsg && <MessageBar intent={aggMsg.ok ? 'success' : (aggMsg.text.includes('XMLA endpoint not configured') ? 'warning' : 'error')}><MessageBarBody>{aggMsg.text}</MessageBarBody></MessageBar>}
        {aggProbeResult && aggProbeResult.length > 0 && (
          <div className={s.tableWrap}>
            <Subtitle2 style={{ marginBottom: tokens.spacingVerticalXS}}>Probe result ({aggProbeResult.length} row{aggProbeResult.length === 1 ? '' : 's'})</Subtitle2>
            <Table aria-label="Probe result" size="small">
              <TableHeader><TableRow>
                {Object.keys(aggProbeResult[0]).map((k) => <TableHeaderCell key={k}>{k}</TableHeaderCell>)}
              </TableRow></TableHeader>
              <TableBody>
                {aggProbeResult.slice(0, 20).map((row, ri) => (
                  <TableRow key={ri}>
                    {Object.keys(aggProbeResult[0]).map((k) => <TableCell key={k} className={s.cell}>{String(row[k] ?? '')}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}

'use client';

/**
 * StatsMaintenanceDialog — Statistics manager + table maintenance (OPTIMIZE /
 * ANALYZE), with the Fabric-only V-Order toggle surfaced as an honest gate.
 *
 * Azure-native parity with the Fabric warehouse "Statistics" surface + Lakehouse
 * "Maintenance" dialog — NO Microsoft Fabric dependency. Engine-aware:
 *
 *   synapse-dedicated-sql-pool / warehouse  →  CREATE / UPDATE / DROP STATISTICS
 *     (real T-SQL on the Dedicated SQL pool via /statistics). OPTIMIZE shows an
 *     honest "not applicable — columnstore, not Delta" MessageBar.
 *
 *   databricks-sql-warehouse  →  ANALYZE TABLE … COMPUTE STATISTICS (/statistics)
 *     + OPTIMIZE [ZORDER BY] (/optimize, real Delta compaction; receipt shows the
 *     before/after ADLS Parquet file count).
 *
 * No free-form config: statistics name is identifier-checked, columns come from
 * the table's real schema, scan mode + ZORDER columns are pickers. V-Order is a
 * disabled Switch + intent='warning' MessageBar — never POSTed (no Azure 1:1).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Field, Input, Select, Switch, Dropdown, Option, Spinner, Badge,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataHistogram20Regular, Wrench20Regular, Delete16Regular, ArrowSync16Regular,
} from '@fluentui/react-icons';
import { cloudFabricNote, type CloudBoundary } from '@/lib/editors/lakehouse-spark-conf';
import { SCAN_MODES, type ScanMode } from '@/lib/azure/statistics-client';

export type StatsEngine = 'synapse-dedicated-sql-pool' | 'warehouse' | 'databricks-sql-warehouse';

export interface StatsMaintenanceDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Item type — drives engine dispatch and the route path segment. */
  engine: StatsEngine;
  itemId: string;
  /** Schema for T-SQL engines (default 'dbo'). */
  schema?: string;
  tableName: string;
  /** Column names from the table DDL — feeds the create-stats + ZORDER pickers. */
  columns?: string[];
  /** Databricks: active Unity Catalog catalog. */
  catalog?: string;
  /** Databricks: SQL Warehouse id to run statements against. */
  warehouseId?: string;
  /** ADLS container for the OPTIMIZE before/after file count (optional). */
  container?: string;
  /** ADLS path prefix of the Delta table folder (optional, for file count). */
  storagePrefix?: string;
  /** Cloud boundary — drives cloudFabricNote() in the V-Order honest gate. */
  cloud?: CloudBoundary;
}

const SCAN_LABELS: Record<ScanMode, string> = {
  'default': 'Default sampling (Synapse chooses)',
  'fullscan': 'Full scan (most accurate, slowest)',
  'sample-20': 'Sample 20 percent',
  'sample-50': 'Sample 50 percent',
};

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '520px', minHeight: '320px' },
  hint: { color: tokens.colorNeutralForeground3 },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  grow: { flexGrow: 1, minWidth: '180px' },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  ops: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
  empty: { padding: tokens.spacingVerticalM, textAlign: 'center', color: tokens.colorNeutralForeground3 },
});

interface StatRow { statsName?: string; columnName?: string; updatedAt?: string }
interface ColRow { columnName?: string; dataType?: string }

interface ApiResult {
  ok: boolean;
  gated?: boolean;
  error?: string;
  code?: string;
  state?: string;
  statistics?: StatRow[];
  columns?: ColRow[];
  note?: string;
  recordsAffected?: number;
  executionMs?: number;
  // optimize receipt
  filesBefore?: number;
  filesAfter?: number;
  filesBeforeError?: string;
  analyzeMs?: number;
  analyzeError?: string;
  optimizeResult?: { columns: string[]; rows: unknown[][] };
}

export function StatsMaintenanceDialog(props: StatsMaintenanceDialogProps) {
  const { open, onOpenChange, engine, itemId, tableName, catalog, warehouseId, container, storagePrefix, cloud } = props;
  const schema = props.schema || 'dbo';
  const s = useStyles();

  const isDatabricks = engine === 'databricks-sql-warehouse';
  const [tab, setTab] = useState<'statistics' | 'maintenance'>('statistics');

  // ---- Statistics tab state ----
  const [loading, setLoading] = useState(false);
  const [listResult, setListResult] = useState<ApiResult | null>(null);
  const [statsName, setStatsName] = useState('');
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [scanMode, setScanMode] = useState<ScanMode>('default');
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState<(ApiResult & { _action?: string }) | null>(null);

  // ---- Maintenance tab state ----
  const [zorderCols, setZorderCols] = useState<string[]>([]);
  const [analyzeAfter, setAnalyzeAfter] = useState(true);
  const [optBusy, setOptBusy] = useState(false);
  const [optResult, setOptResult] = useState<ApiResult | null>(null);

  // Columns come from the DDL prop first; fall back to the live list for Synapse.
  const liveCols = (listResult?.columns || []).map((c) => String(c.columnName)).filter(Boolean);
  const cols = (props.columns && props.columns.length ? props.columns : liveCols);

  const base = `/api/items/${engine}/${encodeURIComponent(itemId)}`;

  const loadStats = useCallback(async () => {
    setLoading(true);
    setListResult(null);
    try {
      const r = await fetch(`${base}/statistics?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(tableName)}`);
      let j: ApiResult;
      try { j = await r.json(); } catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${r.status})` }; }
      setListResult(j);
    } catch (e: any) {
      setListResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [base, schema, tableName]);

  useEffect(() => {
    if (open) {
      setTab('statistics');
      loadStats();
    }
  }, [open, loadStats]);

  const postStats = async (payload: Record<string, unknown>, label: string) => {
    setBusy(true);
    setActionResult(null);
    try {
      const r = await fetch(`${base}/statistics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema, table: tableName, catalog, warehouseId, ...payload }),
      });
      let j: ApiResult;
      try { j = await r.json(); } catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${r.status})` }; }
      setActionResult({ ...j, _action: label });
      if (j.ok) {
        setStatsName('');
        setSelectedCols([]);
        await loadStats(); // refresh so the new/dropped stat appears in the catalog list
      }
    } catch (e: any) {
      setActionResult({ ok: false, error: e?.message || String(e), _action: label });
    } finally {
      setBusy(false);
    }
  };

  const runOptimize = async () => {
    setOptBusy(true);
    setOptResult(null);
    try {
      const r = await fetch(`${base}/optimize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          warehouseId, catalog, schema, tableName,
          zorderColumns: zorderCols, analyzeAfter, container, storagePrefix,
        }),
      });
      let j: ApiResult;
      try { j = await r.json(); } catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${r.status})` }; }
      setOptResult(j);
    } catch (e: any) {
      setOptResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setOptBusy(false);
    }
  };

  const createDisabled = busy || !statsName.trim() || selectedCols.length === 0;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <DataHistogram20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS }} />
            Statistics &amp; maintenance — {tableName}
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'statistics' | 'maintenance')}>
                <Tab value="statistics" icon={<DataHistogram20Regular />}>Statistics</Tab>
                <Tab value="maintenance" icon={<Wrench20Regular />}>Maintenance</Tab>
              </TabList>

              {/* ============ Statistics tab ============ */}
              {tab === 'statistics' && (
                <div className={s.section}>
                  {isDatabricks ? (
                    <Caption1 className={s.hint}>
                      Databricks column statistics are managed automatically by the cost-based optimizer.
                      Run <code>ANALYZE TABLE</code> to refresh them — pick columns (or leave empty for all
                      columns) and Analyze.
                    </Caption1>
                  ) : (
                    <Caption1 className={s.hint}>
                      Statistics give the Synapse query optimizer column distribution histograms. Create a
                      statistics object over one or more columns, refresh it with UPDATE, or remove it.
                    </Caption1>
                  )}

                  {/* Existing statistics list (Synapse) */}
                  {!isDatabricks && (
                    <>
                      {loading ? (
                        <Spinner size="tiny" label="Loading statistics…" labelPosition="after" />
                      ) : listResult?.gated ? (
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>Configuration required</MessageBarTitle>
                            {listResult.error}
                          </MessageBarBody>
                        </MessageBar>
                      ) : listResult && !listResult.ok ? (
                        <MessageBar intent="error">
                          <MessageBarBody><MessageBarTitle>Could not load statistics</MessageBarTitle>{listResult.error}</MessageBarBody>
                        </MessageBar>
                      ) : (listResult?.statistics?.length ?? 0) > 0 ? (
                        <Table size="small" aria-label="Existing statistics">
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>Statistic</TableHeaderCell>
                              <TableHeaderCell>Column</TableHeaderCell>
                              <TableHeaderCell>Last updated</TableHeaderCell>
                              <TableHeaderCell style={{ width: 150 }}>Actions</TableHeaderCell>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {listResult!.statistics!.map((st, i) => (
                              <TableRow key={`${st.statsName}-${st.columnName}-${i}`}>
                                <TableCell>{st.statsName}</TableCell>
                                <TableCell>{st.columnName}</TableCell>
                                <TableCell>{st.updatedAt ? String(st.updatedAt).slice(0, 19).replace('T', ' ') : '—'}</TableCell>
                                <TableCell>
                                  <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy}
                                    onClick={() => postStats({ action: 'update', statsName: st.statsName }, `UPDATE ${st.statsName}`)}>
                                    Update
                                  </Button>
                                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy}
                                    onClick={() => postStats({ action: 'drop', statsName: st.statsName }, `DROP ${st.statsName}`)}>
                                    Drop
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      ) : (
                        <div className={s.empty}>No user-created statistics on this table yet.</div>
                      )}
                    </>
                  )}

                  {/* Create / Analyze form */}
                  <div className={s.section}>
                    {!isDatabricks && (
                      <Field label="Statistics name" required>
                        <Input value={statsName} placeholder="stat_orders_customerid"
                          onChange={(_, d) => setStatsName(d.value)} />
                      </Field>
                    )}
                    <Field
                      label={isDatabricks ? 'Columns (empty = all columns)' : 'Columns'}
                      required={!isDatabricks}
                      hint={cols.length === 0 ? 'Column list unavailable — schema not loaded.' : undefined}
                    >
                      <Dropdown multiselect placeholder={isDatabricks ? 'All columns' : 'Select columns'}
                        disabled={cols.length === 0}
                        selectedOptions={selectedCols}
                        value={selectedCols.join(', ')}
                        onOptionSelect={(_, d) => setSelectedCols(d.selectedOptions)}>
                        {cols.map((c) => <Option key={c} value={c}>{c}</Option>)}
                      </Dropdown>
                    </Field>
                    {!isDatabricks && (
                      <Field label="Scan mode">
                        <Select value={scanMode} onChange={(_, d) => setScanMode(d.value as ScanMode)}>
                          {SCAN_MODES.map((m) => <option key={m} value={m}>{SCAN_LABELS[m]}</option>)}
                        </Select>
                      </Field>
                    )}
                    <div className={s.row}>
                      {isDatabricks ? (
                        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <DataHistogram20Regular />}
                          disabled={busy || !warehouseId}
                          onClick={() => postStats({ action: 'analyze', columns: selectedCols }, 'ANALYZE')}>
                          {busy ? 'Analyzing…' : 'Analyze'}
                        </Button>
                      ) : (
                        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <DataHistogram20Regular />}
                          disabled={createDisabled}
                          onClick={() => postStats({ action: 'create', statsName, columns: selectedCols, mode: scanMode }, 'CREATE')}>
                          {busy ? 'Creating…' : 'Create statistics'}
                        </Button>
                      )}
                    </div>
                  </div>

                  {actionResult && (
                    <MessageBar intent={actionResult.ok ? 'success' : actionResult.gated ? 'warning' : 'error'}>
                      <MessageBarBody>
                        <MessageBarTitle>
                          {actionResult.ok ? `${actionResult._action} succeeded` : actionResult.gated ? 'Configuration required' : `${actionResult._action} failed`}
                        </MessageBarTitle>
                        {actionResult.ok
                          ? `Ran in ${actionResult.executionMs ?? 0} ms.`
                          : actionResult.error}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              )}

              {/* ============ Maintenance tab ============ */}
              {tab === 'maintenance' && (
                <div className={s.section}>
                  {/* OPTIMIZE */}
                  {isDatabricks ? (
                    <div className={s.section}>
                      <Caption1 className={s.hint}>
                        OPTIMIZE bin-packs small Parquet files in the backing Delta table into larger files.
                        ZORDER BY co-locates related values for faster data-skipping.
                      </Caption1>
                      <Field label="ZORDER BY columns (optional)" hint="Requires data-skipping benefit on high-cardinality filter columns.">
                        <Dropdown multiselect placeholder="None" disabled={cols.length === 0}
                          selectedOptions={zorderCols} value={zorderCols.join(', ') || 'None'}
                          onOptionSelect={(_, d) => setZorderCols(d.selectedOptions)}>
                          {cols.map((c) => <Option key={c} value={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                      <Switch checked={analyzeAfter} onChange={(_, d) => setAnalyzeAfter(d.checked)}
                        label="Run ANALYZE after OPTIMIZE (refresh optimizer statistics)" />
                      <div className={s.ops}>
                        <Badge appearance="outline" color="brand">
                          {zorderCols.length ? `OPTIMIZE ZORDER BY (${zorderCols.join(', ')})` : 'OPTIMIZE'}
                        </Badge>
                        {analyzeAfter && <Badge appearance="outline" color="brand">ANALYZE</Badge>}
                      </div>
                      <div className={s.row}>
                        <Button appearance="primary" icon={optBusy ? <Spinner size="tiny" /> : <Wrench20Regular />}
                          disabled={optBusy || !warehouseId}
                          onClick={runOptimize}>
                          {optBusy ? 'Running…' : 'Run OPTIMIZE'}
                        </Button>
                      </div>

                      {optResult && (
                        <MessageBar intent={optResult.ok ? 'success' : optResult.gated ? 'warning' : 'error'}>
                          <MessageBarBody>
                            <MessageBarTitle>
                              {optResult.ok ? 'OPTIMIZE complete' : optResult.gated ? 'Configuration required' : optResult.state ? 'Warehouse not running' : 'OPTIMIZE failed'}
                            </MessageBarTitle>
                            {optResult.ok ? (
                              <>
                                Ran in {optResult.executionMs ?? 0} ms.
                                {typeof optResult.filesBefore === 'number' && typeof optResult.filesAfter === 'number' ? (
                                  <> Parquet files: <strong>{optResult.filesBefore}</strong> → <strong>{optResult.filesAfter}</strong> (verified via ADLS).</>
                                ) : optResult.filesBeforeError ? (
                                  <> File count unavailable: {optResult.filesBeforeError}. See OPTIMIZE metrics below.</>
                                ) : null}
                                {optResult.analyzeMs !== undefined && <> ANALYZE ran in {optResult.analyzeMs} ms.</>}
                                {optResult.analyzeError && <><br />ANALYZE warning: {optResult.analyzeError}</>}
                              </>
                            ) : (optResult.error)}
                          </MessageBarBody>
                        </MessageBar>
                      )}
                    </div>
                  ) : (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>OPTIMIZE does not apply here</MessageBarTitle>
                        A Synapse Dedicated SQL pool stores data in clustered columnstore indexes (not Delta
                        files), so file compaction does not apply. Use <strong>UPDATE STATISTICS</strong> on the
                        Statistics tab for optimizer maintenance, or rebuild indexes with
                        {' '}<code>ALTER INDEX ALL ON [{schema}].[{tableName}] REBUILD</code>.
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  {/* V-Order honest gate — always shown, never functional (no Azure 1:1) */}
                  <div className={s.section} style={{ marginTop: tokens.spacingVerticalS }}>
                    <Switch disabled checked={false} label="V-Order (spark.sql.parquet.vorder.default)" />
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Fabric Spark only — no Azure 1:1</MessageBarTitle>
                        V-Order is a write-time Parquet layout optimization exclusive to Fabric Spark runtimes
                        (<code>spark.sql.parquet.vorder.default</code>). OPTIMIZE on the Azure-native path
                        (Synapse Spark / Databricks) runs standard Delta compaction without V-Order encoding —
                        there is no Azure-native equivalent.{cloudFabricNote(cloud ?? 'commercial')}
                      </MessageBarBody>
                    </MessageBar>
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={busy || optBusy}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

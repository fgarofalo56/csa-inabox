'use client';

/**
 * CopyJobEditor — the Loom one-for-one of Microsoft Fabric's Copy job item.
 *
 * Fabric's Copy job is a simplified, guided incremental-copy experience: a
 * wizard (Source → Destination → Mode → Update → Mapping → Review) that
 * materialises a copy pipeline and tracks a checkpoint so each run moves only
 * the delta. Mode can be Full, Incremental (watermark column), or CDC (native
 * SQL Server change tracking). Loom builds the SAME experience on Azure-native
 * backends (no-fabric-dependency):
 *
 *   • Wizard           → CopyJobWizard (guided, typed controls — no raw JSON)
 *   • Materialisation  → real ADF pipeline via upsertPipeline (adf-client)
 *   • Watermark / LSN  → dbo.copy_watermark control table in Azure SQL,
 *                        read here through the azure-sql-client, written by the
 *                        pipeline's StoredProcedure activity each run. CDC mode
 *                        stores the last processed LSN in the same row.
 *
 * No Microsoft Fabric capacity / workspace is required. Every list / save / run
 * hits real Azure; errors surface verbatim in a MessageBar.
 */

import {
  Subtitle2, Caption1, Body1, Button, Badge, Spinner, Skeleton, SkeletonItem, Divider, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  SettingsRegular, BookmarkRegular, HistoryRegular, CopyRegular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { EmptyState } from '@/lib/components/empty-state';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CopyJobWizard, type CopyJobSpec } from '@/lib/components/pipeline/copy-job/wizard';

const useStyles = makeStyles({
  tabBar: {
    paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL, paddingBottom: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '920px' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  specGrid: { display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) minmax(0, 1fr)', rowGap: tokens.spacingVerticalXS, columnGap: tokens.spacingHorizontalL, alignItems: 'baseline' },
  label: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge, padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
});

interface PipelineRunDTO {
  runId: string;
  status?: string;
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  message?: string;
}

interface WatermarkDTO {
  source?: string;
  table_name?: string;
  last_value?: string | null;
  updated_utc?: string | null;
}

interface LinkedServiceDTO { name: string; properties?: { type?: string; description?: string } }

function fmtTs(ts?: string | number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

// ---- self-contained data hooks (colocated; mirror phase2-misc-editors) ------

function useLinkedServices() {
  const [linkedServices, setLinkedServices] = useState<LinkedServiceDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null); setHint(null);
    try {
      const r = await fetch('/api/adf/linked-services');
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        setHint(j.hint || 'Provision an ADF Linked Service in the Data Factory portal first, then refresh.');
        setLinkedServices([]);
      } else {
        setLinkedServices(j.linkedServices || []);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setLinkedServices([]);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { linkedServices, error, hint, reload };
}

interface ItemDTO { id: string; workspaceId: string; displayName: string; state?: Record<string, any> }

function useItem(itemType: string, id: string) {
  const [item, setItem] = useState<ItemDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/${itemType}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setItem(j.item);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [itemType, id]);
  useEffect(() => { reload(); }, [reload]);
  return { item, error, loading, reload };
}

async function saveItem(itemType: string, id: string, state: Record<string, any>): Promise<void> {
  const r = await fetch(`/api/items/${itemType}/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save failed');
}

// ---------------------------------------------------------------------------

function specFromState(state?: Record<string, any>): Partial<CopyJobSpec> {
  const s: any = state || {};
  return {
    source: { linkedService: s.source?.linkedService || '', type: s.source?.type || 'AzureSqlSource', sourceTable: s.source?.sourceTable || s.source?.table, query: s.source?.query },
    sink: { linkedService: s.sink?.linkedService || '', type: s.sink?.type || 'AzureSqlSink', table: s.sink?.table },
    mode: s.mode || 'Full',
    writeMode: s.writeMode || 'Append',
    watermarkCol: s.watermarkCol,
    sourceName: s.sourceName,
    cdcCaptureInstance: s.cdcCaptureInstance,
    mergeKeys: s.mergeKeys,
    mappings: Array.isArray(s.mappings) ? s.mappings : [],
  };
}

export function CopyJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const { item: cosmosItem, error: loadError, loading, reload } = useItem('copy-job', id);
  const ls = useLinkedServices();

  const [tab, setTab] = useState<'settings' | 'runs'>('settings');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [runs, setRuns] = useState<PipelineRunDTO[]>([]);
  const [watermark, setWatermark] = useState<WatermarkDTO | null>(null);
  const [wmConfigured, setWmConfigured] = useState<boolean | null>(null);
  const [wmMissing, setWmMissing] = useState<string | null>(null);
  const [wmModule, setWmModule] = useState<string | null>(null);

  const persisted = useMemo(() => specFromState(cosmosItem?.state), [cosmosItem]);
  const configured = !!persisted.source?.linkedService && !!persisted.sink?.linkedService && !!persisted.sink?.table;
  const isIncremental = persisted.mode === 'Incremental';
  const isCdc = persisted.mode === 'CDC';
  // Both Incremental and CDC track their checkpoint in dbo.copy_watermark.
  const tracksCheckpoint = isIncremental || isCdc;

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/copy-job/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (j.ok) setRuns(j.runs || []);
      else if (j.error) setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  const loadWatermark = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/copy-job/${encodeURIComponent(id)}/watermark`);
      const j = await r.json();
      setWmConfigured(!!j.configured);
      setWmMissing(j.missing || null);
      setWmModule(j.module || null);
      setWatermark(j.configured ? (j.watermark || null) : null);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  useEffect(() => { if (cosmosItem) { loadRuns(); loadWatermark(); } }, [cosmosItem, loadRuns, loadWatermark]);

  const onSave = useCallback(async (spec: CopyJobSpec) => {
    setBusy(true); setErr(null);
    try {
      await saveItem('copy-job', id, spec as unknown as Record<string, any>);
      await reload();
      setWizardOpen(false);
      await loadWatermark();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, reload, loadWatermark]);

  const run = useCallback(async () => {
    setBusy(true); setErr(null); setLastRun(null);
    try {
      const r = await fetch(`/api/items/copy-job/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'run failed');
      setLastRun(j.runId);
      setTab('runs');
      setTimeout(() => { loadRuns(); loadWatermark(); }, 2500);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, loadRuns, loadWatermark]);

  const canRun = !busy && configured;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: 'Configure wizard', onClick: busy ? undefined : () => setWizardOpen(true), disabled: busy },
      ]},
      { label: 'Run', actions: [
        { label: busy ? 'Running…' : 'Run now', onClick: canRun ? run : undefined, disabled: !canRun },
        { label: 'Refresh', onClick: busy ? undefined : () => { loadRuns(); loadWatermark(); }, disabled: busy },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busy, canRun, run, loadRuns, loadWatermark]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create copy job"
        intro="A Copy job moves data source → destination with a guided wizard. It supports full, incremental (watermark column), and CDC (native SQL Server change tracking — inserts, updates, and deletes) copy modes; the incremental and CDC checkpoints live in an Azure SQL control table so each run moves only changed rows. Create it, then click Configure wizard." />
    );
  }

  return (
    <>
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
        <div>
          <div className={styles.tabBar}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'settings' | 'runs')}>
              <Tab value="settings" icon={<SettingsRegular />}>Settings</Tab>
              <Tab value="runs" icon={<HistoryRegular />}>Runs</Tab>
            </TabList>
          </div>

          <div className={styles.body}>
            {err || loadError ? (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err || loadError}</MessageBarBody>
              </MessageBar>
            ) : null}
            {loading && (
              <div className={styles.card} aria-label="Loading copy job">
                <Skeleton aria-label="Loading copy job…">
                  <SkeletonItem size={16} style={{ width: '40%' }} />
                  <SkeletonItem size={12} />
                  <SkeletonItem size={12} style={{ width: '80%' }} />
                  <SkeletonItem size={12} style={{ width: '60%' }} />
                </Skeleton>
              </div>
            )}

            {ls.error && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>ADF Linked Services unavailable</MessageBarTitle>
                  {ls.error}{ls.hint && <><br /><Caption1>{ls.hint}</Caption1></>}
                </MessageBarBody>
              </MessageBar>
            )}

            {tab === 'settings' && (
              <>
                {!configured && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Not configured yet</MessageBarTitle>
                      Click <strong>Configure wizard</strong> in the ribbon to set the source, destination, copy mode,
                      update method, and column mappings.
                    </MessageBarBody>
                  </MessageBar>
                )}

                <div className={styles.card}>
                  <div className={styles.toolbar}>
                    <span className={styles.sectionHeader}>
                      <CopyRegular className={styles.sectionIcon} aria-hidden />
                      <Subtitle2>Configuration</Subtitle2>
                    </span>
                    <Button appearance="primary" size="small" onClick={() => setWizardOpen(true)} disabled={busy}>
                      {configured ? 'Edit in wizard' : 'Configure wizard'}
                    </Button>
                  </div>
                  {configured ? (
                    <div className={styles.specGrid}>
                      <Caption1 className={styles.label}>Source</Caption1>
                      <Body1 className={styles.mono}>{persisted.source?.linkedService} · {persisted.source?.type}{persisted.source?.sourceTable ? ` · ${persisted.source.sourceTable}` : ''}</Body1>
                      <Caption1 className={styles.label}>Destination</Caption1>
                      <Body1 className={styles.mono}>{persisted.sink?.linkedService} · {persisted.sink?.type} · {persisted.sink?.table}</Body1>
                      <Caption1 className={styles.label}>Copy mode</Caption1>
                      <Body1><Badge appearance="tint" color={isCdc ? 'success' : isIncremental ? 'brand' : 'informative'}>{isCdc ? 'CDC' : persisted.mode}</Badge></Body1>
                      {isIncremental && <><Caption1 className={styles.label}>Watermark column</Caption1><Body1 className={styles.mono}>{persisted.watermarkCol || '—'}</Body1></>}
                      {isIncremental && <><Caption1 className={styles.label}>Control-table key</Caption1><Body1 className={styles.mono}>{persisted.sourceName || persisted.source?.sourceTable || '—'}</Body1></>}
                      {isCdc && <><Caption1 className={styles.label}>Capture instance</Caption1><Body1 className={styles.mono}>{persisted.cdcCaptureInstance || `${(persisted.source?.sourceTable || '').replace('.', '_') || 'default'} (default)`}</Body1></>}
                      {isCdc && <><Caption1 className={styles.label}>LSN checkpoint key</Caption1><Body1 className={styles.mono}>{persisted.sourceName || persisted.source?.sourceTable || '—'}</Body1></>}
                      <Caption1 className={styles.label}>Update method</Caption1>
                      <Body1>{persisted.writeMode}{persisted.writeMode === 'Merge' && persisted.mergeKeys ? ` (keys: ${persisted.mergeKeys})` : ''}</Body1>
                      <Caption1 className={styles.label}>Column mappings</Caption1>
                      <Body1>{(persisted.mappings?.length || 0)} mapped{(persisted.mappings?.length || 0) === 0 ? ' (all by name)' : ''}</Body1>
                    </div>
                  ) : (
                    <Caption1 className={styles.label}>No configuration yet.</Caption1>
                  )}
                </div>

                {tracksCheckpoint && (
                  <div className={styles.card}>
                    <span className={styles.sectionHeader}>
                      <BookmarkRegular className={styles.sectionIcon} aria-hidden />
                      <Subtitle2>{isCdc ? 'CDC checkpoint (LSN)' : 'Watermark'}</Subtitle2>
                    </span>
                    {isCdc && (
                      <Caption1 className={styles.label}>
                        CDC mode reads net inserts, updates, and deletes from the source via{' '}
                        <code>cdc.fn_cdc_get_net_changes_*</code>. The source database and table must have native change
                        data capture enabled (<code>sys.sp_cdc_enable_db</code> / <code>sys.sp_cdc_enable_table</code> with{' '}
                        <code>@supports_net_changes = 1</code>). Each run advances the stored log-sequence number below.
                      </Caption1>
                    )}
                    {wmConfigured === false && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Control table not configured</MessageBarTitle>
                          {isCdc ? 'CDC' : 'Incremental'} copy persists its {isCdc ? 'last processed LSN' : 'watermark'} in{' '}
                          <code>dbo.copy_watermark</code> in Azure SQL.
                          Set <code>{wmMissing || 'LOOM_COPYJOB_CONTROL_SQL_SERVER'}</code> on the console app and deploy{' '}
                          <code>{wmModule || 'platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep'}</code> to create the
                          table and stored procedure. Full copy works without this; {isCdc ? 'CDC' : 'incremental'} runs will fail until it is set.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {wmConfigured && !watermark && (
                      <Caption1 className={styles.label}>
                        {isCdc
                          ? 'No LSN checkpoint recorded yet — the first CDC run reads from the table’s minimum CDC LSN and stores the current max LSN.'
                          : 'No watermark recorded yet — the first incremental run full-loads the source and writes the initial high-water mark.'}
                      </Caption1>
                    )}
                    {wmConfigured && watermark && (
                      <div className={styles.specGrid}>
                        <Caption1 className={styles.label}>Source key</Caption1><Body1 className={styles.mono}>{watermark.source}</Body1>
                        <Caption1 className={styles.label}>Table</Caption1><Body1 className={styles.mono}>{watermark.table_name}</Body1>
                        <Caption1 className={styles.label}>{isCdc ? 'Last processed LSN' : 'Last value'}</Caption1><Body1 className={styles.mono}>{watermark.last_value ?? '—'}</Body1>
                        <Caption1 className={styles.label}>Updated</Caption1><Body1>{fmtTs(watermark.updated_utc)}</Body1>
                      </div>
                    )}
                  </div>
                )}

                {lastRun && (
                  <MessageBar intent="success">
                    <MessageBarBody><MessageBarTitle>Run started</MessageBarTitle>runId <code>{lastRun}</code></MessageBarBody>
                  </MessageBar>
                )}
                <Divider />
                <div className={styles.toolbar}>
                  <Tooltip relationship="label" content={!configured ? 'Configure the source & destination connections first' : busy ? 'A copy run is already in progress…' : 'Materialize the ADF pipeline and trigger a copy run now'}>
                    <Button appearance="primary" onClick={run} disabled={!canRun}>Run now</Button>
                  </Tooltip>
                  {busy && <Spinner size="tiny" />}
                </div>
              </>
            )}

            {tab === 'runs' && (
              <div className={styles.card} style={{ minWidth: 0, overflowX: 'auto' }}>
                <div className={styles.toolbar}>
                  <span className={styles.sectionHeader}>
                    <HistoryRegular className={styles.sectionIcon} aria-hidden />
                    <Subtitle2>Recent runs</Subtitle2>
                  </span>
                  <Caption1 className={styles.label}>pipeline loom-copy-{id.substring(0, 8)}…</Caption1>
                  <Button appearance="secondary" size="small" onClick={loadRuns} disabled={busy}>Refresh</Button>
                </div>
                {runs.length === 0 ? (
                  <EmptyState
                    icon={<HistoryRegular />}
                    title="No runs yet"
                    body="This copy job hasn't run. Configure the source, destination, and copy mode, then click Run now to move data — each run will appear here with its status, duration, and message."
                    primaryAction={canRun ? { label: 'Run now', onClick: run } : { label: 'Configure wizard', onClick: () => setWizardOpen(true) }}
                  />
                ) : (
                  <Table size="small" aria-label="Pipeline runs">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Run ID</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Started</TableHeaderCell>
                        <TableHeaderCell>Ended</TableHeaderCell>
                        <TableHeaderCell>Duration</TableHeaderCell>
                        <TableHeaderCell>Message</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((r) => (
                        <TableRow key={r.runId}>
                          <TableCell className={styles.mono}>{r.runId.substring(0, 8)}…</TableCell>
                          <TableCell>
                            <Badge appearance="outline" color={r.status === 'Succeeded' ? 'success' : r.status === 'Failed' ? 'danger' : 'informative'}>
                              {r.status || '—'}
                            </Badge>
                          </TableCell>
                          <TableCell>{fmtTs(r.runStart)}</TableCell>
                          <TableCell>{fmtTs(r.runEnd)}</TableCell>
                          <TableCell>{r.durationInMs ? `${(r.durationInMs / 1000).toFixed(1)}s` : '—'}</TableCell>
                          <TableCell style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>{r.message || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </div>
        </div>
      } />

      <CopyJobWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        linkedServices={ls.linkedServices}
        initialSpec={persisted}
        onSave={onSave}
        busy={busy}
        error={err}
      />
    </>
  );
}

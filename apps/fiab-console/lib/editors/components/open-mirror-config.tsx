'use client';
/**
 * OpenMirrorConfig — the open-mirroring (push model) panel shown inside the
 * MirroredDatabaseEditor when the source is "Open mirroring" (GenericMirror).
 *
 * Mirrors Fabric's open-mirroring Home tab one-for-one, Azure-native (no Fabric):
 *   - Landing zone card  — the abfss path producers push Parquet to.
 *   - Producer credentials card — SAS (honest gate) + RBAC instructions.
 *   - Merge schedule dropdown — fixed allowlist (no free-form config).
 *   - Last-merge status + "Merge now" — runs a Synapse Spark Livy batch that
 *     folds new Parquet into a managed Delta table, then surfaces the Livy job
 *     id + the SELECT COUNT(*) query over the managed table.
 *
 * Every control calls the real BFF route (/api/items/mirrored-database/[id]/
 * open-mirror) — no mocks, no dead buttons (no-vaporware).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Card, CardHeader, Subtitle2, Body1, Caption1, Badge, Button, Spinner, Field, Input,
  Dropdown, Option, TabList, Tab, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular, Copy16Regular, Key20Regular,
  PeopleTeam20Regular, CloudArrowUp20Regular, Clock20Regular, DataTrending20Regular,
} from '@fluentui/react-icons';
import type { MergeSchedule } from '@/lib/azure/mirror-engine';

// Fixed allowlist (no free-form config). Mirrors the canonical
// MERGE_SCHEDULE_OPTIONS in mirror-engine.ts but is declared locally so this
// client component never imports the server-only engine module (which pulls in
// pg/mssql Node built-ins that cannot be bundled for the browser).
const MERGE_SCHEDULE_OPTIONS: readonly MergeSchedule[] = ['on-demand', '15min', '1h', '4h', 'daily'];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM },
  card: { padding: tokens.spacingVerticalM },
  pathRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  code: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3, padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall, wordBreak: 'break-all', flex: 1, minWidth: 0,
  },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  scheduleLabel: { color: tokens.colorNeutralForeground3 },
});

interface ConfigResponse {
  ok: boolean;
  landingPath?: string;
  deltaPath?: string;
  tableName?: string;
  mergeSchedule?: MergeSchedule;
  keyColumns?: string[];
  lastMergeAt?: string | null;
  lastMergeJobId?: number | null;
  lastMergeStatus?: string | null;
  lastMergeError?: string | null;
  openrowset?: string;
  error?: string;
}

interface Props {
  mirrorId: string;
  workspaceId: string;
  /** Managed-Delta target table for this open-mirror (default: 'default'). */
  tableName?: string;
}

const SCHEDULE_LABEL: Record<MergeSchedule, string> = {
  'on-demand': 'On demand (Merge now)',
  '15min': 'Every 15 minutes',
  '1h': 'Every hour',
  '4h': 'Every 4 hours',
  daily: 'Daily',
};

function statusColor(status?: string | null): 'success' | 'warning' | 'danger' | 'informative' {
  if (!status) return 'informative';
  if (status === 'Succeeded' || status === 'success') return 'success';
  if (status === 'Submitted' || status === 'Running' || status === 'running' || status === 'starting') return 'warning';
  if (status === 'Failed' || status === 'Error' || status === 'dead' || status === 'killed') return 'danger';
  return 'informative';
}

export function OpenMirrorConfig({ mirrorId, workspaceId, tableName = 'default' }: Props) {
  const s = useStyles();
  const [cfg, setCfg] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [credTab, setCredTab] = useState<'sas' | 'rbac'>('rbac');
  const [schedule, setSchedule] = useState<MergeSchedule>('on-demand');
  const [keyCols, setKeyCols] = useState('');
  const [merging, setMerging] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'info' | 'warning'; title: string; text: string } | null>(null);
  const [gate, setGate] = useState<{ missing: string; message: string; workaround?: string } | null>(null);
  const [sas, setSas] = useState<{ missing: string; message: string; workaround?: string } | null>(null);

  const base = `/api/items/mirrored-database/${encodeURIComponent(mirrorId)}/open-mirror?workspaceId=${encodeURIComponent(workspaceId)}`;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}&action=config&tableName=${encodeURIComponent(tableName)}`);
      const j: ConfigResponse = await r.json();
      setCfg(j);
      if (j.ok) {
        if (j.mergeSchedule) setSchedule(j.mergeSchedule);
        if (Array.isArray(j.keyColumns)) setKeyCols(j.keyColumns.join(', '));
      }
    } catch (e: any) {
      setCfg({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [base, tableName]);

  useEffect(() => { if (mirrorId && workspaceId) void loadConfig(); }, [mirrorId, workspaceId, loadConfig]);

  const copy = useCallback((text?: string) => {
    if (!text) return;
    try { void navigator.clipboard.writeText(text); setMsg({ intent: 'info', title: 'Copied', text: 'Copied to the clipboard.' }); }
    catch { /* clipboard unavailable */ }
  }, []);

  const parsedKeyCols = useCallback(
    () => keyCols.split(',').map((c) => c.trim()).filter(Boolean),
    [keyCols],
  );

  const mergeNow = useCallback(async () => {
    setMerging(true); setMsg(null); setGate(null);
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableName, mergeSchedule: schedule, keyColumns: parsedKeyCols() }),
      });
      const j = await r.json();
      if (j.status === 'Gated' && j.gate) { setGate(j.gate); }
      else if (j.status === 'NoNewFiles') { setMsg({ intent: 'info', title: 'No new files', text: j.note || 'No new Parquet files found in the landing zone since the last merge.' }); }
      else if (j.ok && j.status === 'Submitted') {
        setMsg({ intent: 'success', title: `Merge job ${j.jobId} submitted`, text: `${j.filesFound} Parquet file(s) found. Run the query below to count rows in the managed Delta table once the job succeeds.` });
      } else if (!j.ok) { setMsg({ intent: 'error', title: 'Merge failed', text: j.error || j.note || 'Merge job could not be submitted.' }); }
      await loadConfig();
    } catch (e: any) {
      setMsg({ intent: 'error', title: 'Merge failed', text: e?.message || String(e) });
    } finally { setMerging(false); }
  }, [base, tableName, schedule, parsedKeyCols, loadConfig]);

  const saveSchedule = useCallback(async (next: MergeSchedule) => {
    setSchedule(next); setSavingSchedule(true); setMsg(null);
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // Save schedule + key columns without forcing a merge run target change.
        body: JSON.stringify({ tableName, mergeSchedule: next, keyColumns: parsedKeyCols() }),
      });
      const j = await r.json();
      if (j.status === 'Gated' && j.gate) setGate(j.gate);
      else if (j.ok || j.status === 'NoNewFiles') setMsg({ intent: 'success', title: 'Schedule saved', text: `Merge schedule set to "${SCHEDULE_LABEL[next]}".` });
      await loadConfig();
    } catch (e: any) {
      setMsg({ intent: 'error', title: 'Save failed', text: e?.message || String(e) });
    } finally { setSavingSchedule(false); }
  }, [base, tableName, parsedKeyCols, loadConfig]);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true); setMsg(null);
    try {
      const r = await fetch(`${base}&action=status`);
      const j = await r.json();
      if (j.ok && j.status === 'NoJob') setMsg({ intent: 'info', title: 'No job yet', text: 'No merge job has been submitted. Use "Merge now".' });
      else if (j.ok) setMsg({ intent: 'info', title: `Job ${j.jobId}`, text: `Status: ${j.status}${j.result ? ` (${j.result})` : ''}.` });
      else setMsg({ intent: 'error', title: 'Status check failed', text: j.error || 'Could not refresh the merge job status.' });
      await loadConfig();
    } catch (e: any) {
      setMsg({ intent: 'error', title: 'Status check failed', text: e?.message || String(e) });
    } finally { setRefreshing(false); }
  }, [base, loadConfig]);

  const checkSas = useCallback(async () => {
    setSas(null);
    try {
      const r = await fetch(`${base}&action=sas`);
      const j = await r.json();
      if (j.gate) setSas(j.gate);
    } catch (e: any) {
      setSas({ missing: 'error', message: e?.message || String(e) });
    }
  }, [base]);

  useEffect(() => { if (credTab === 'sas' && !sas) void checkSas(); }, [credTab, sas, checkSas]);

  if (loading) return <div className={s.root}><Spinner size="tiny" label="Loading open-mirror config…" /></div>;

  const rbacScope =
    'Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/landing';

  return (
    <div className={s.root}>
      <Subtitle2><CloudArrowUp20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS }} />Open mirroring (push Parquet → managed Delta)</Subtitle2>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        A producer pushes Parquet to the landing zone below; Loom merges it into a managed Delta table on a Synapse
        Spark batch — no Microsoft Fabric required. Add <code>_metadata.json</code> with <code>keyColumns</code> +
        a <code>__rowMarker__</code> column for UPSERT/DELETE merge semantics; otherwise files are appended.
      </Caption1>

      {cfg && !cfg.ok && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Config error</MessageBarTitle>{cfg.error}</MessageBarBody></MessageBar>
      )}

      {/* Landing zone */}
      <Card className={s.card}>
        <CardHeader header={<Body1><CloudArrowUp20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS }} />Landing zone</Body1>}
          description={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Producers push Parquet here, under <code>&lt;table&gt;/</code>.</Caption1>} />
        <div className={s.pathRow}>
          <span className={s.code}>{cfg?.landingPath || '(LOOM_LANDING_URL not set)'}</span>
          <Button size="small" appearance="outline" icon={<Copy16Regular />} onClick={() => copy(cfg?.landingPath)}>Copy</Button>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS }}>
          Target table: <code>{cfg?.tableName || tableName}</code> → drop files at <code>{(cfg?.landingPath || '')}/{cfg?.tableName || tableName}/*.parquet</code>
        </Caption1>
      </Card>

      {/* Producer credentials */}
      <Card className={s.card}>
        <CardHeader header={<Body1><Key20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS }} />Producer credentials</Body1>}
          description={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>How the external producer authenticates to push Parquet.</Caption1>} />
        <TabList selectedValue={credTab} onTabSelect={(_, d) => setCredTab(d.value as 'sas' | 'rbac')} size="small">
          <Tab value="rbac" icon={<PeopleTeam20Regular />}>RBAC (recommended)</Tab>
          <Tab value="sas" icon={<Key20Regular />}>SAS token</Tab>
        </TabList>
        {credTab === 'rbac' && (
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            <Caption1>
              Grant the producer principal <strong>Storage Blob Data Contributor</strong> scoped to the landing container:
            </Caption1>
            <div className={s.pathRow} style={{ marginTop: tokens.spacingVerticalS }}>
              <span className={s.code}>{rbacScope}</span>
              <Button size="small" appearance="outline" icon={<Copy16Regular />} onClick={() => copy(rbacScope)}>Copy scope</Button>
            </div>
            <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
              <code>az role assignment create --role "Storage Blob Data Contributor" --assignee &lt;producer-principal&gt; --scope /subscriptions/&lt;sub&gt;/resourceGroups/&lt;rg&gt;/providers/{rbacScope}</code>
            </Caption1>
          </div>
        )}
        {credTab === 'sas' && (
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            {sas
              ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>{sas.missing}</MessageBarTitle>
                    {sas.message}
                    {sas.workaround && <><br /><Caption1>{sas.workaround}</Caption1></>}
                  </MessageBarBody>
                </MessageBar>
              )
              : <Spinner size="tiny" label="Checking SAS capability…" />}
          </div>
        )}
      </Card>

      {/* Merge schedule + key columns */}
      <Card className={s.card}>
        <CardHeader header={<Body1><Clock20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS }} />Merge schedule</Body1>}
          description={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>How often new Parquet is folded into Delta.</Caption1>} />
        <div className={s.row}>
          <Field label="Schedule">
            <Dropdown
              value={SCHEDULE_LABEL[schedule]}
              selectedOptions={[schedule]}
              disabled={savingSchedule}
              onOptionSelect={(_, d) => { if (d.optionValue) void saveSchedule(d.optionValue as MergeSchedule); }}>
              {MERGE_SCHEDULE_OPTIONS.map((opt) => (
                <Option key={opt} value={opt} text={SCHEDULE_LABEL[opt]}>{SCHEDULE_LABEL[opt]}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Key columns (comma-separated — for UPSERT/DELETE)" style={{ flex: 1, minWidth: 220 }}>
            <Input value={keyCols} onChange={(_, d) => setKeyCols(d.value)} placeholder="id" />
          </Field>
        </div>
        {schedule !== 'on-demand' && (
          <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
            Recurring schedules run by wiring an ADF / Synapse scheduled trigger (or Logic App timer) to POST this
            route. "Merge now" runs the same merge immediately.
          </Caption1>
        )}
      </Card>

      {/* Last merge + actions */}
      <Card className={s.card}>
        <CardHeader header={<Body1><DataTrending20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS }} />Merge status</Body1>} />
        <div className={s.row}>
          <Badge appearance="filled" color={statusColor(cfg?.lastMergeStatus)}>{cfg?.lastMergeStatus || 'No merge yet'}</Badge>
          {cfg?.lastMergeJobId != null && <Caption1>Job id: <code>{cfg.lastMergeJobId}</code></Caption1>}
          {cfg?.lastMergeAt && <Caption1>Last run: {cfg.lastMergeAt}</Caption1>}
        </div>
        {cfg?.lastMergeError && (
          <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorPaletteRedForeground1 }}>{cfg.lastMergeError}</Caption1>
        )}
        <div className={s.row} style={{ marginTop: tokens.spacingVerticalL }}>
          <Button appearance="primary" icon={merging ? <Spinner size="tiny" /> : <Play20Regular />} disabled={merging} onClick={mergeNow}>
            {merging ? 'Submitting…' : 'Merge now'}
          </Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={refreshing} onClick={refreshStatus}>
            {refreshing ? 'Refreshing…' : 'Refresh status'}
          </Button>
        </div>
        {cfg?.openrowset && (
          <div style={{ marginTop: tokens.spacingVerticalL }}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Query the managed Delta table (Synapse Serverless):</Caption1>
            <div className={s.pathRow} style={{ marginTop: tokens.spacingVerticalXS }}>
              <span className={s.code}>{cfg.openrowset}</span>
              <Button size="small" appearance="outline" icon={<Copy16Regular />} onClick={() => copy(cfg.openrowset)}>Copy SQL</Button>
            </div>
          </div>
        )}
      </Card>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{gate.missing}</MessageBarTitle>
            {gate.message}
            {gate.workaround && <><br /><Caption1>{gate.workaround}</Caption1></>}
          </MessageBarBody>
        </MessageBar>
      )}
      {msg && (
        <MessageBar intent={msg.intent}>
          <MessageBarBody><MessageBarTitle>{msg.title}</MessageBarTitle>{msg.text}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

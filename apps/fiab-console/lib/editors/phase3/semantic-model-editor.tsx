'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * SemanticModelEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Loom-native semantic model (Azure Analysis Services tabular layer over the
 * warehouse / lakehouse) — Azure-native by DEFAULT; no Fabric / Power BI
 * workspace is required (the Power BI WorkspacePicker is opt-in). The editor's
 * exclusive helpers (DatasetLite / TableLite / Sm* types, SM_* + INGEST_*
 * consts, AasSemanticModelPanel, SemanticModelSecurityTab, useCopilotPaneStyles,
 * SemanticModelCopilotPane, StructureOp / CopilotEditPlan) move with it. The
 * shared Power BI workspace-picker (usePowerBiWorkspaces / WorkspacePicker) is
 * imported from ./workspace-picker; the shared phase3 styles hook from ./styles.
 * phase3-editors.tsx re-exports SemanticModelEditor from a barrel line, so the
 * registry resolves it unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Card, Divider,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, Switch, SpinButton, InfoLabel, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Save20Regular, Add20Regular, Delete20Regular,
  ArrowSync20Regular, Table20Regular, DatabaseLink20Regular,
  Sparkle16Regular, Wrench16Regular, Eye20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { PbiModelViewPanel } from '../components/pbi-model-view-panel';
import { ModelTabsExtra } from '../components/model-tabs-extra';
import { PowerBiTree } from '@/lib/components/powerbi/powerbi-tree';
import { validateRlsDax } from '@/lib/azure/aas-dax-validate';
import { ManageAccessPanel, EndorsementControl, GatewayDatasourcesPanel } from '@/lib/components/powerbi/powerbi-governance';
import { DqSourcePanel } from '@/lib/components/powerbi/dq-source-panel';
import { BulkDescribeAction } from '@/lib/components/catalog/bulk-describe-action';
import { UpstreamSensitivityField } from '@/lib/components/governance/upstream-sensitivity-field';
import { ItemEditorChrome } from '../item-editor-chrome';
import { OpenInPbiDesktopButton } from '../components/open-in-pbi-desktop-button';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PowerQueryHost } from '@/lib/components/pipeline/dataflow/power-query-host';
import { parseSharedQueries, setQueryBody } from '@/lib/components/pipeline/dataflow/m-script';
import { usePowerBiWorkspaces, WorkspacePicker } from './workspace-picker';
import { useStyles } from './styles';

interface DatasetLite {
  id: string; name: string; configuredBy?: string; isRefreshable?: boolean; targetStorageMode?: string; createdDate?: string;
  isEffectiveIdentityRolesRequired?: boolean;
}
interface TableLite {
  name: string;
  columns?: Array<{ name: string; dataType?: string }>;
  measures?: Array<{ name: string; expression?: string }>;
}
// Full tabular-model column/table shapes returned by the XMLA-backed
// GET /api/items/semantic-model/[id]/model (Azure Analysis Services / Power BI
// Premium XMLA). These carry the editable column metadata (data category,
// format string, summarize-by, display folder, sort-by, hidden, calc DAX).
interface SmColumn {
  name: string;
  type?: 'data' | 'calculated' | 'calculatedTableColumn' | 'rowNumber';
  dataType?: string;
  dataCategory?: string;
  isHidden?: boolean;
  summarizeBy?: string;
  formatString?: string;
  displayFolder?: string;
  sortByColumn?: string;
  expression?: string;
}
interface SmTable {
  name: string;
  isCalculatedTable?: boolean;
  calculatedExpression?: string;
  columns: SmColumn[];
  measures: Array<{ name: string; expression?: string }>;
}
const SM_DATA_CATEGORIES = ['WebUrl', 'ImageUrl', 'Country', 'StateOrProvince', 'City', 'PostalCode', 'County', 'Continent', 'Address', 'Place', 'Latitude', 'Longitude', 'Barcode'];
const SM_SUMMARIZE = ['default', 'none', 'sum', 'min', 'max', 'count', 'average', 'distinctCount'];
const SM_DATA_TYPES = ['string', 'int64', 'double', 'dateTime', 'decimal', 'boolean'];
const SM_FORMATS: Array<{ value: string; label: string }> = [
  { value: '', label: '— none —' },
  { value: '#,0', label: 'Integer (#,0)' },
  { value: '#,0.00', label: '2 decimals (#,0.00)' },
  { value: '0%', label: 'Percent (0%)' },
  { value: '0.00%', label: 'Percent 2dp (0.00%)' },
  { value: '$#,0.##;($#,0.##)', label: 'Currency ($)' },
  { value: 'yyyy-mm-dd', label: 'Date (yyyy-mm-dd)' },
  { value: 'yyyy-mm-dd hh:mm:ss', label: 'DateTime' },
  { value: 'General Date', label: 'General Date' },
];
interface RefreshLite {
  requestId?: string; refreshType?: string; startTime?: string; endTime?: string; status?: string; serviceExceptionJson?: string;
}

// ============================================================
// AAS (Azure Analysis Services) — Azure-native semantic-model backend.
// Rendered when NEXT_PUBLIC_LOOM_BI_BACKEND === 'aas' (bicep sets this when the
// AAS module is deployed; per no-fabric-dependency.md AAS is the Azure-native
// default and Power BI is opt-in). Storage Mode + Refresh (now / scheduled /
// history) wire to the real AAS REST + ARM backend via the /api/items/
// semantic-model/aas-databases and /[id]/refresh{,-schedule,es} routes.
// ============================================================

interface AasDbLite { name: string; storageMode?: string; state?: string; compatibilityLevel?: number; }
interface AasRefreshLite { refreshId?: string; type?: string; startTime?: string; endTime?: string; status?: string; }
interface AasScheduleLite {
  enabled: boolean; days: string[]; times: string[];
  localTimeZoneId?: string; notifyOption?: 'NoNotification' | 'MailOnFailure'; updatedAt?: string;
}

function AasSemanticModelPanel({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const AAS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const [gate, setGate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [databases, setDatabases] = useState<AasDbLite[]>([]);
  const [serverName, setServerName] = useState('');
  const [dbName, setDbName] = useState('');
  const [tab, setTab] = useState<'storage' | 'refresh'>('storage');

  const [refreshes, setRefreshes] = useState<AasRefreshLite[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Scheduled refresh form (mirrors the Power BI Scheduled-refresh pane; AAS has
  // no 30-minute boundary so times may be any HH:MM).
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [schedDays, setSchedDays] = useState<string[]>([]);
  const [schedTimes, setSchedTimes] = useState('07:00');
  const [schedTz, setSchedTz] = useState('UTC');
  const [schedNotify, setSchedNotify] = useState<'NoNotification' | 'MailOnFailure'>('NoNotification');
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedUpdatedAt, setSchedUpdatedAt] = useState<string>('');
  const [schedMsg, setSchedMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadDatabases = useCallback(async () => {
    setLoading(true); setGate(null);
    try {
      const r = await clientFetch('/api/items/semantic-model/aas-databases');
      const j = await r.json();
      if (!j.ok) { setGate(j.error || `HTTP ${r.status}`); setDatabases([]); return; }
      setDatabases(j.databases || []);
      setServerName(j.serverName || '');
      setDbName((prev) => prev || (j.databases?.[0]?.name ?? ''));
    } catch (e: any) { setGate(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadRefreshes = useCallback(async (db: string) => {
    if (!db) return;
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(db)}/refreshes?dbName=${encodeURIComponent(db)}`);
      const j = await r.json();
      if (j.ok) setRefreshes(j.refreshes || []);
    } catch { /* keep last */ }
  }, []);

  const loadSchedule = useCallback(async (db: string) => {
    if (!db) return;
    setSchedMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(db)}/refresh-schedule`);
      const j = await r.json();
      const sch: AasScheduleLite | null = j.ok ? j.schedule : null;
      if (sch && typeof sch === 'object') {
        setSchedEnabled(!!sch.enabled);
        setSchedDays(Array.isArray(sch.days) ? sch.days : []);
        setSchedTimes(Array.isArray(sch.times) && sch.times.length ? sch.times.join(', ') : '07:00');
        setSchedTz(sch.localTimeZoneId || 'UTC');
        setSchedNotify(sch.notifyOption === 'MailOnFailure' ? 'MailOnFailure' : 'NoNotification');
        setSchedUpdatedAt(sch.updatedAt || '');
      } else {
        setSchedEnabled(false); setSchedDays([]); setSchedTimes('07:00'); setSchedTz('UTC'); setSchedNotify('NoNotification'); setSchedUpdatedAt('');
      }
    } catch { /* leave defaults */ }
  }, []);

  useEffect(() => { loadDatabases(); }, [loadDatabases]);
  useEffect(() => { if (dbName) { loadRefreshes(dbName); loadSchedule(dbName); } }, [dbName, loadRefreshes, loadSchedule]);

  const refreshNow = useCallback(async () => {
    if (!dbName) return;
    setRefreshing(true); setRefreshMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dbName)}/refresh?dbName=${encodeURIComponent(dbName)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'automatic' }),
      });
      const j = await r.json();
      if (!j.ok) { setRefreshMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setRefreshMsg({ ok: true, text: `Refresh queued — id ${String(j.refreshId).slice(0, 8)}…` });
      setTimeout(() => loadRefreshes(dbName), 1500);
    } catch (e: any) { setRefreshMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setRefreshing(false); }
  }, [dbName, loadRefreshes]);

  const toggleSchedDay = useCallback((day: string) => {
    setSchedDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  }, []);

  const saveSchedule = useCallback(async () => {
    if (!dbName) return;
    setSchedBusy(true); setSchedMsg(null);
    const times = schedTimes.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dbName)}/refresh-schedule`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: schedEnabled, days: schedDays, times, localTimeZoneId: schedTz, notifyOption: schedNotify }),
      });
      const j = await r.json();
      if (!j.ok) { setSchedMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      const sch: AasScheduleLite = j.schedule;
      setSchedUpdatedAt(sch?.updatedAt || '');
      setSchedMsg({ ok: true, text: 'Scheduled refresh saved to the AAS server (loom-refresh-schedule tag).' });
    } catch (e: any) { setSchedMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSchedBusy(false); }
  }, [dbName, schedEnabled, schedDays, schedTimes, schedTz, schedNotify]);

  const current = databases.find((d) => d.name === dbName);
  const storageLabel = (mode?: string): string => {
    if (mode === 'InMemory') return 'Import (in-memory)';
    if (mode === 'DirectQuery') return 'DirectQuery';
    if (mode === 'Hybrid') return 'Hybrid';
    return mode || 'Import (in-memory)';
  };

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Source', actions: [
        { label: refreshing ? 'Queuing…' : 'Refresh now', onClick: dbName ? refreshNow : undefined, disabled: !dbName || refreshing, title: !dbName ? 'select a database first' : 'Queue an asynchronous refresh via the AAS REST API' },
      ]},
      { label: 'Schedule', actions: [
        { label: 'Scheduled refresh', onClick: dbName ? () => setTab('refresh') : undefined, disabled: !dbName, title: 'Configure days / times / time zone' },
      ]},
    ]},
  ], [refreshing, dbName, refreshNow]);

  return (
    // Unsaved-changes guard (rel-T70): this editor persists incrementally —
    // each measure/relationship change is committed to the model immediately via
    // TMSL createOrReplace — so there is no in-memory draft `dirty` state to
    // thread. If it ever gains a batched draft mode, pass `dirty={...}` here
    // exactly like notebook/dashboard/pipeline/report-designer do.
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Semantic model</Badge>
            <Badge appearance="outline" color="informative">Azure Analysis Services</Badge>
            {serverName && <Caption1>Server: <strong>{serverName}</strong></Caption1>}
            <Field label="" style={{ minWidth: 240 }}>
              <Select value={dbName} onChange={(_, d) => setDbName(d.value)} disabled={loading || databases.length === 0} aria-label="AAS database">
                {databases.length === 0 && <option value="">(no databases)</option>}
                {databases.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </Select>
            </Field>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadDatabases} disabled={loading}>Reload</Button>
            <Button
              appearance="primary"
              icon={<Play20Regular />}
              disabled={!dbName || refreshing}
              onClick={refreshNow}
              style={{ marginLeft: 'auto' }}
            >
              {refreshing ? 'Queuing…' : 'Refresh now'}
            </Button>
          </div>

          {loading && <Spinner size="small" label="Loading Azure Analysis Services databases…" labelPosition="after" />}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Azure Analysis Services not configured</MessageBarTitle>
                {gate} — set <code>LOOM_AAS_SERVER_NAME</code> and <code>LOOM_AAS_REGION</code> on the Console Container App.
                The AAS Standard server is deployed by <code>platform/fiab/bicep/modules/admin-plane/aas.bicep</code>; the Console
                managed identity is added as a server administrator there. No Microsoft Fabric / Power BI workspace is required.
              </MessageBarBody>
            </MessageBar>
          )}

          {refreshMsg && <MessageBar intent={refreshMsg.ok ? 'success' : 'error'}><MessageBarBody>{refreshMsg.text}</MessageBarBody></MessageBar>}

          {!gate && !loading && databases.length === 0 && (
            <Caption1>No tabular databases on this AAS server yet. Deploy a model via the XMLA endpoint (SSMS / Tabular Editor) or the AAS REST <code>createOrReplace</code> TMSL command.</Caption1>
          )}

          {dbName && (
            <>
              <div className={s.tabBar}>
                <TabList selectedValue={tab} onTabSelect={(_: unknown, d: any) => setTab(d.value as any)}>
                  <Tab value="storage">Storage mode</Tab>
                  <Tab value="refresh">Refresh ({refreshes.length})</Tab>
                </TabList>
              </div>

              {tab === 'storage' && (
                <div style={{ marginTop: tokens.spacingVerticalM}}>
                  <Subtitle2>Storage mode</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS}}>
                    Sourced from <code>GET …/Microsoft.AnalysisServices/servers/{serverName || '{name}'}/databases/{dbName}</code> (api-version 2017-08-01,
                    <code> properties.model.storageMode</code>). Changing the storage mode is a model operation — use the XMLA endpoint
                    (SSMS / Tabular Editor) or the AAS REST <code>createOrReplace</code> TMSL command.
                  </Caption1>
                  <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Badge appearance="filled" color={current?.storageMode === 'InMemory' || !current?.storageMode ? 'brand' : 'informative'} size="large">
                      {storageLabel(current?.storageMode)}
                    </Badge>
                    <Caption1>Processing state: <strong>{current?.state || '—'}</strong></Caption1>
                    {typeof current?.compatibilityLevel === 'number' && (
                      <Caption1>Compatibility level: <strong>{current.compatibilityLevel}</strong></Caption1>
                    )}
                  </div>
                </div>
              )}

              {tab === 'refresh' && (
                <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL}}>
                  <div>
                    <Subtitle2>Scheduled refresh</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS}}>
                      Stored as the <code>loom-refresh-schedule</code> tag on the AAS server resource (visible in the Azure portal).
                      A scheduler invokes the AAS async-refresh REST API at the configured times. AAS has no 30-minute-boundary
                      constraint, so any <code>HH:MM</code> is allowed.
                    </Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, maxWidth: 560 }}>
                      <Switch label="Enable scheduled refresh" checked={schedEnabled} onChange={(_, d) => setSchedEnabled(d.checked)} />
                      <div>
                        <Caption1>Refresh days</Caption1>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS}}>
                          {AAS_DAYS.map((day) => (
                            <Button key={day} size="small" appearance={schedDays.includes(day) ? 'primary' : 'outline'} onClick={() => toggleSchedDay(day)}>{day.slice(0, 3)}</Button>
                          ))}
                        </div>
                      </div>
                      <Field label={<InfoLabel info="One or more 24-hour clock times at which the scheduler triggers an Analysis Services refresh, in the time zone below. Separate multiple times with commas. AAS has no 30-minute-boundary limit, so any HH:MM is allowed.">Time(s) — HH:MM (24h), comma-separated</InfoLabel>}>
                        <Input value={schedTimes} onChange={(_, d) => setSchedTimes(d.value)} placeholder="07:00, 12:15" />
                      </Field>
                      <Field label="Time zone">
                        <Input value={schedTz} onChange={(_, d) => setSchedTz(d.value)} placeholder="UTC" />
                      </Field>
                      <Field label="On failure">
                        <Select value={schedNotify} onChange={(_, d) => setSchedNotify(d.value as 'NoNotification' | 'MailOnFailure')}>
                          <option value="NoNotification">No notification</option>
                          <option value="MailOnFailure">Email on failure</option>
                        </Select>
                      </Field>
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                        <Button appearance="primary" icon={<Save20Regular />} disabled={schedBusy} onClick={saveSchedule}>{schedBusy ? 'Saving…' : 'Apply'}</Button>
                        {schedUpdatedAt && <Caption1>Last saved: {schedUpdatedAt}</Caption1>}
                      </div>
                      {schedMsg && <MessageBar intent={schedMsg.ok ? 'success' : 'error'}><MessageBarBody>{schedMsg.text}</MessageBarBody></MessageBar>}
                    </div>
                  </div>

                  <div>
                    <Subtitle2>Refresh history</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS}}>
                      Last 30 days from <code>GET …/models/{dbName}/refreshes</code> (AAS async-refresh REST API), newest first.
                    </Caption1>
                    <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
                      <Table aria-label="AAS refresh history" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Refresh ID</TableHeaderCell>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Start</TableHeaderCell>
                          <TableHeaderCell>End</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {refreshes.length === 0 && <TableRow><TableCell colSpan={5}>No refresh history.</TableCell></TableRow>}
                          {refreshes.map((r, i) => (
                            <TableRow key={r.refreshId || i}>
                              <TableCell className={s.cell}>{r.refreshId?.slice(0, 8) || '—'}</TableCell>
                              <TableCell>{r.type || '—'}</TableCell>
                              <TableCell>{r.status || '—'}</TableCell>
                              <TableCell className={s.cell}>{r.startTime || '—'}</TableCell>
                              <TableCell className={s.cell}>{r.endTime || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

// ---- Security (RLS/OLS) tab shared types + presentational component --------
type SmSecColPerm = { name: string; metadataPermission: 'read' | 'none' };
type SmSecTablePerm = {
  name: string;
  filterExpression?: string;
  metadataPermission?: 'read' | 'none';
  columnPermissions?: SmSecColPerm[];
};
type SmSecRole = {
  name: string;
  modelPermission: 'read';
  tablePermissions: SmSecTablePerm[];
  members?: Array<{ memberName: string }>;
};

interface SecurityTabProps {
  s: Record<string, string>;
  tables: TableLite[];
  roles: SmSecRole[] | null;
  busy: boolean;
  saving: boolean;
  err: string | null;
  gate: { missing: string; detail: string } | null;
  saveMsg: { ok: boolean; text: string } | null;
  selectedRole: string;
  olsTable: string;
  testUpn: string;
  testQuery: string;
  testBusy: boolean;
  testResult: { rows: Array<Record<string, unknown>>; rowCount: number } | null;
  testErr: string | null;
  onReload: () => void;
  onAddRole: () => void;
  onDeleteRole: (name: string) => void;
  onRenameRole: (oldName: string, newName: string) => void;
  onSelectRole: (name: string) => void;
  onSetFilter: (roleName: string, table: string, expr: string) => void;
  onSetTableOls: (roleName: string, table: string, perm: 'read' | 'none') => void;
  onSetColumnOls: (roleName: string, table: string, column: string, perm: 'read' | 'none') => void;
  onSetMembers: (roleName: string, members: string[]) => void;
  onChangeOlsTable: (table: string) => void;
  onSave: () => void;
  onTestUpn: (v: string) => void;
  onTestQuery: (v: string) => void;
  onRunTest: () => void;
}

/**
 * SemanticModelSecurityTab — the RLS + OLS authoring surface, one-for-one with
 * Power BI's "Manage roles" experience (Tabular model security): a roles grid,
 * per-role row-filter DAX editor, an OLS table/column visibility matrix, role
 * membership, and a Test-as-role probe (the receipt). All writes go through the
 * Analysis-Services XMLA TMSL endpoint via the parent's BFF callbacks.
 */
function SemanticModelSecurityTab(props: SecurityTabProps) {
  const {
    s, tables, roles, busy, saving, err, gate, saveMsg, selectedRole, olsTable,
    testUpn, testQuery, testBusy, testResult, testErr,
    onReload, onAddRole, onDeleteRole, onRenameRole, onSelectRole,
    onSetFilter, onSetTableOls, onSetColumnOls, onSetMembers, onChangeOlsTable,
    onSave, onTestUpn, onTestQuery, onRunTest,
  } = props;

  const role = (roles || []).find((r) => r.name === selectedRole) || null;
  const tablePerm = (table: string): SmSecTablePerm | undefined =>
    role?.tablePermissions.find((tp) => tp.name === table);
  const olsTableObj = tables.find((t) => t.name === olsTable);
  const filterValidation = (expr?: string) =>
    expr && expr.trim() ? validateRlsDax(expr) : { ok: true as const };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL }}>
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Configure an Analysis-Services tabular engine to author roles</MessageBarTitle>
            {gate.detail} <em>(missing: <code>{gate.missing}</code>)</em>
          </MessageBarBody>
        </MessageBar>
      )}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {/* Section 1 — Roles grid */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
          <Subtitle2>Model roles</Subtitle2>
          <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={onReload} disabled={busy}>{busy ? 'Loading…' : 'Reload'}</Button>
          <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={onAddRole} disabled={!!gate}>Add role</Button>
          <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={onSave} disabled={saving || !!gate || !roles || roles.length === 0} style={{ marginLeft: 'auto' }}>{saving ? 'Saving…' : 'Save roles (TMSL)'}</Button>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Each role applies a row filter (RLS) and/or hides tables &amp; columns (OLS). Saving deploys the full role set to the model via XMLA <code>createOrReplace</code>.
        </Caption1>
        {saveMsg && <MessageBar intent={saveMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
        <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
          <Table aria-label="Roles" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Members</TableHeaderCell>
              <TableHeaderCell>Row filters</TableHeaderCell>
              <TableHeaderCell>Hidden objects (OLS)</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {(roles || []).length === 0 && (
                <TableRow><TableCell colSpan={5}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{busy ? 'Loading roles…' : 'No roles yet. Add one to define RLS filters and OLS permissions.'}</Caption1></TableCell></TableRow>
              )}
              {(roles || []).map((r) => {
                const filters = r.tablePermissions.filter((tp) => tp.filterExpression && tp.filterExpression.trim()).length;
                const hidden = r.tablePermissions.filter((tp) => tp.metadataPermission === 'none').length
                  + r.tablePermissions.reduce((n, tp) => n + (tp.columnPermissions || []).filter((c) => c.metadataPermission === 'none').length, 0);
                return (
                  <TableRow key={r.name} style={r.name === selectedRole ? { background: tokens.colorNeutralBackground1Selected } : undefined}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className={s.cell}>{(r.members || []).map((m) => m.memberName).join(', ') || '—'}</TableCell>
                    <TableCell>{filters || 0}</TableCell>
                    <TableCell>{hidden || 0}</TableCell>
                    <TableCell>
                      <Button size="small" appearance="outline" icon={<Eye20Regular />} onClick={() => onSelectRole(r.name)}>Edit</Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => onDeleteRole(r.name)} aria-label={`Delete role ${r.name}`} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Sections 2 + 3 — per-role RLS DAX + OLS matrix */}
      {role && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
            <Subtitle2>Editing role:</Subtitle2>
            <Input value={role.name} onChange={(_, d) => onRenameRole(role.name, d.value)} style={{ maxWidth: 240 }} aria-label="Role name" />
          </div>

          <Field label="Members (Entra UPN or group object id, comma-separated)">
            <Input
              value={(role.members || []).map((m) => m.memberName).join(', ')}
              onChange={(_, d) => onSetMembers(role.name, d.value.split(',').map((x) => x.trim()).filter(Boolean))}
              placeholder="alice@contoso.com, group-object-id"
            />
          </Field>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: -8 }}>
            Service principals cannot be added as role members (Power BI/AAS restriction) — use real users or Entra security groups.
          </Caption1>

          {/* Section 2 — Row-level security (DAX filter) */}
          <div>
            <Subtitle2>Row-level security (DAX filter)</Subtitle2>
            <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
              <Table aria-label="Row filters" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Table</TableHeaderCell>
                  <TableHeaderCell><InfoLabel info="A DAX boolean expression evaluated per row for this role. Rows where it returns TRUE stay visible to members of the role; leaving it empty grants the role full access to the table. Reference the signed-in user with USERPRINCIPALNAME(), e.g. [Region] = 'East'.">Filter DAX (boolean; empty = full access)</InfoLabel></TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {tables.map((t) => {
                    const tp = tablePerm(t.name);
                    const v = filterValidation(tp?.filterExpression);
                    return (
                      <TableRow key={t.name}>
                        <TableCell style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{t.name}</TableCell>
                        <TableCell>
                          <Textarea
                            value={tp?.filterExpression || ''}
                            onChange={(_, d) => onSetFilter(role.name, t.name, d.value)}
                            placeholder={`[Region] = "East"   —or—   USERPRINCIPALNAME() = '${t.name}'[UserEmail]`}
                            resize="vertical"
                            style={{ width: '100%', minHeight: 44, fontFamily: 'monospace' }}
                          />
                          {!v.ok && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{v.error}</Caption1>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Section 3 — Object-level security matrix */}
          <div>
            <Subtitle2>Object-level security (table &amp; column visibility)</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Hide a whole table or specific columns from this role. A table set to <strong>None</strong> hides all of its columns (column rows below are disabled).
            </Caption1>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS}}>
              {tables.map((t) => {
                const tp = tablePerm(t.name);
                const tableHidden = tp?.metadataPermission === 'none';
                return (
                  <div key={t.name} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall, padding: tokens.spacingVerticalS }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalM}}>
                      <Label weight="semibold" style={{ minWidth: 160 }}>{t.name}</Label>
                      <Field label={<InfoLabel info="Object-level security for the whole table. Read shows the table to this role; None hides the entire table — and every column in it — from anyone in the role.">Table</InfoLabel>} orientation="horizontal">
                        <Select
                          value={tableHidden ? 'none' : 'read'}
                          onChange={(_, d) => onSetTableOls(role.name, t.name, d.value as 'read' | 'none')}
                          aria-label={`Table ${t.name} permission`}
                        >
                          <option value="read">Read</option>
                          <option value="none">None (hidden)</option>
                        </Select>
                      </Field>
                    </div>
                    {(t.columns || []).length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS, opacity: tableHidden ? 0.4 : 1 }}>
                        {(t.columns || []).map((c) => {
                          const cp = (tp?.columnPermissions || []).find((x) => x.name === c.name);
                          return (
                            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalXS}}>
                              <Caption1>{c.name}</Caption1>
                              <Tooltip relationship="description" content="Column-level security (OLS). Read keeps this column visible to the role; None hides only this column while the rest of the table stays visible. Disabled when the whole table is set to None.">
                                <Select
                                  value={cp?.metadataPermission === 'none' ? 'none' : 'read'}
                                  disabled={tableHidden}
                                  onChange={(_, d) => onSetColumnOls(role.name, t.name, c.name, d.value as 'read' | 'none')}
                                  aria-label={`Column ${t.name}.${c.name} permission`}
                                  style={{ minWidth: 90 }}
                                >
                                  <option value="read">Read</option>
                                  <option value="none">None</option>
                                </Select>
                              </Tooltip>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Section 4 — Test as role (receipt) */}
      <div style={{ padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
        <Subtitle2>Test as role</Subtitle2>
        <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalS}}>
          <MessageBarBody>
            Runs a DAX query impersonating a role via the XMLA <code>EffectiveUserName</code> + <code>Roles</code> connection properties. The named user must exist in the tenant and hold Read access on the model. The result table is your receipt: a restricted role returns only filtered rows, and OLS-hidden columns are absent from the output.
          </MessageBarBody>
        </MessageBar>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, maxWidth: 720 }}>
          <Field label="Effective user (Entra UPN to impersonate)">
            <Input value={testUpn} onChange={(_, d) => onTestUpn(d.value)} placeholder="alice@contoso.com" />
          </Field>
          <Field label="Role">
            <Select value={selectedRole} onChange={(_, d) => onSelectRole(d.value)} aria-label="Role to test">
              <option value="">Select a role…</option>
              {(roles || []).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </Select>
          </Field>
          <Field label="DAX query">
            <Textarea value={testQuery} onChange={(_, d) => onTestQuery(d.value)} resize="vertical" style={{ minHeight: 60, fontFamily: 'monospace' }} />
          </Field>
          <div>
            <Button appearance="primary" icon={<Play20Regular />} onClick={onRunTest} disabled={testBusy || !!gate || !selectedRole || !testUpn.trim() || !testQuery.trim()}>{testBusy ? 'Running…' : 'Run test'}</Button>
          </div>
          {testErr && <MessageBar intent="error"><MessageBarBody>{testErr}</MessageBarBody></MessageBar>}
          {testResult && (
            <div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{testResult.rowCount} row(s) returned as role <strong>{selectedRole}</strong>.</Caption1>
              <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
                <Table aria-label="Test-as-role result" size="small">
                  <TableHeader><TableRow>
                    {Object.keys(testResult.rows[0] || {}).map((k) => <TableHeaderCell key={k}>{k}</TableHeaderCell>)}
                    {testResult.rows.length === 0 && <TableHeaderCell>result</TableHeaderCell>}
                  </TableRow></TableHeader>
                  <TableBody>
                    {testResult.rows.length === 0 && (
                      <TableRow><TableCell><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rows visible to this role (filter excludes all rows).</Caption1></TableCell></TableRow>
                    )}
                    {testResult.rows.slice(0, 50).map((row, i) => (
                      <TableRow key={i}>
                        {Object.keys(testResult.rows[0] || {}).map((k) => <TableCell key={k} className={s.cell}>{String((row as any)[k] ?? '')}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
// "Get data" starter mashup — a self-contained inline table so the wizard runs
// end-to-end with zero external connection config; the source picker replaces
// the Source step when a connector is chosen.
const INGEST_STARTER_M = `section Section1;

shared IngestQuery = let
    Source = #table({"id","name","value"}, {{1, "item_a", 100}, {2, "item_b", 200}}),
    Filtered = Table.SelectRows(Source, each [value] > 0)
in
    Filtered;`;

// Source picker connectors. Each emits a real Power Query M `Source =`
// expression. Connectors that reach an external system reference an ADF linked
// service / account the operator already configured (no secrets in the UI).
const INGEST_SOURCES: Array<{ key: string; label: string; hint: string; m: string }> = [
  { key: 'inline', label: 'Sample table (inline)', hint: 'A literal #table — runs with no connection config.',
    m: '#table({"id","name","value"}, {{1, "item_a", 100}, {2, "item_b", 200}})' },
  { key: 'adls-csv', label: 'ADLS Gen2 — CSV', hint: 'Delimited file in your data lake.',
    m: 'Csv.Document(AzureStorage.DataLakeContents("https://<account>.dfs.core.windows.net/landing/<path>/data.csv"), [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv])' },
  { key: 'adls-parquet', label: 'ADLS Gen2 — Parquet', hint: 'Parquet file/folder in your data lake.',
    m: 'Parquet.Document(AzureStorage.DataLakeContents("https://<account>.dfs.core.windows.net/landing/<path>/data.parquet"))' },
  { key: 'azuresql', label: 'Azure SQL Database', hint: 'A table or view over your Azure SQL server.',
    m: 'Sql.Database("<server>.database.windows.net", "<database>"){[Schema="dbo", Item="<table>"]}[Data]' },
  { key: 'odata', label: 'REST / OData feed', hint: 'An OData v4 endpoint.',
    m: 'OData.Feed("https://<host>/<service>/", null, [Implementation="2.0"])' },
];

// ── Copilot model-structure pane (audit-T82) ────────────────────────────────
// NL → structured edit plan → checkpoint + apply (rename measures, set
// descriptions, suggest relationships) → restore. Azure-native default: posts
// to /api/items/semantic-model/[id]/copilot-structure which writes the
// Loom-native Cosmos model store (no Fabric / Power BI / XMLA required) and
// mirrors to a live XMLA model when one is configured.

type StructureOp =
  | { kind: 'rename-measure'; from: string; to: string }
  | { kind: 'set-measure-description'; measure: string; description: string }
  | { kind: 'suggest-relationship'; fromTable: string; fromColumn: string; toTable: string; toColumn: string; cardinality: string; rationale?: string };
interface CopilotEditPlan { summary: string; ops: StructureOp[] }
interface CopilotCheckpoint {
  id: string; createdAt: string; label: string;
  source: 'copilot' | 'manual' | 'pre-restore';
  stats: { measures: number; relationships: number };
}

function describeOp(op: StructureOp): string {
  if (op.kind === 'rename-measure') return `Rename measure [${op.from}] → [${op.to}]`;
  if (op.kind === 'set-measure-description') return `Describe [${op.measure}]: "${op.description}"`;
  return `Add relationship ${op.fromTable}[${op.fromColumn}] → ${op.toTable}[${op.toColumn}] (${op.cardinality})${op.rationale ? ` — ${op.rationale}` : ''}`;
}

const OP_LABEL: Record<StructureOp['kind'], string> = {
  'rename-measure': 'Rename',
  'set-measure-description': 'Describe',
  'suggest-relationship': 'Relationship',
};
const opBadgeColor = (k: StructureOp['kind']): 'brand' | 'success' | 'informative' =>
  k === 'rename-measure' ? 'brand' : k === 'set-measure-description' ? 'success' : 'informative';

const useCopilotPaneStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  actionRow: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  planCard: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
  },
  opList: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  opRow: {
    display: 'flex',
    alignItems: 'flex-start',
    columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  opText: { flex: 1, minWidth: 0, lineHeight: tokens.lineHeightBase300 },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalS,
  },
  cpList: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
  },
  cpRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'background-color, border-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    },
  },
  cpMeta: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, minWidth: 0 },
  cpLabelRow: { display: 'flex', columnGap: tokens.spacingHorizontalXS, alignItems: 'center' },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
  },
});

function SemanticModelCopilotPane({ id }: { id: string }) {
  const cs = useCopilotPaneStyles();
  const [prompt, setPrompt] = useState('');
  const [proposing, setProposing] = useState(false);
  const [plan, setPlan] = useState<CopilotEditPlan | null>(null);
  const [proposeErr, setProposeErr] = useState<{ text: string; gate?: { missing: string; detail: string } } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; text: string; applied?: string[]; skipped?: string[]; xmla?: { attempted: boolean; backend?: string } } | null>(null);
  const [checkpoints, setCheckpoints] = useState<CopilotCheckpoint[] | null>(null);
  const [cpErr, setCpErr] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCheckpoints = useCallback(async () => {
    setCpErr(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure?action=checkpoints`);
      const j = await r.json();
      if (!j.ok) { setCpErr(j.error || `HTTP ${r.status}`); setCheckpoints([]); return; }
      setCheckpoints(Array.isArray(j.checkpoints) ? j.checkpoints : []);
    } catch (e: any) { setCpErr(e?.message || String(e)); setCheckpoints([]); }
  }, [id]);

  useEffect(() => { loadCheckpoints(); }, [loadCheckpoints]);

  const propose = useCallback(async () => {
    const q = prompt.trim();
    if (!q) return;
    setProposing(true); setPlan(null); setProposeErr(null); setApplyResult(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'propose', prompt: q }),
      });
      const j = await r.json();
      if (!j.ok) { setProposeErr({ text: j.error || `HTTP ${r.status}`, gate: j.gate }); return; }
      setPlan(j.plan as CopilotEditPlan);
    } catch (e: any) { setProposeErr({ text: e?.message || String(e) }); }
    finally { setProposing(false); }
  }, [prompt, id]);

  const apply = useCallback(async () => {
    if (!plan || plan.ops.length === 0) return;
    setApplying(true); setApplyResult(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply', plan }),
      });
      const j = await r.json();
      if (!j.ok) { setApplyResult({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setApplyResult({ ok: true, text: j.note || 'Applied.', applied: j.applied, skipped: j.skipped, xmla: j.xmla });
      setPlan(null);
      await loadCheckpoints();
    } catch (e: any) { setApplyResult({ ok: false, text: e?.message || String(e) }); }
    finally { setApplying(false); }
  }, [plan, id, loadCheckpoints]);

  const restore = useCallback(async (checkpointId: string) => {
    setRestoringId(checkpointId); setRestoreMsg(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore', checkpointId }),
      });
      const j = await r.json();
      if (!j.ok) { setRestoreMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setRestoreMsg({ ok: true, text: j.note || 'Restored.' });
      await loadCheckpoints();
    } catch (e: any) { setRestoreMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setRestoringId(null); }
  }, [id, loadCheckpoints]);

  const checkpointNow = useCallback(async () => {
    setRestoreMsg(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'checkpoint', label: 'Manual checkpoint' }),
      });
      const j = await r.json();
      if (!j.ok) { setRestoreMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setRestoreMsg({ ok: true, text: 'Checkpoint captured.' });
      await loadCheckpoints();
    } catch (e: any) { setRestoreMsg({ ok: false, text: e?.message || String(e) }); }
  }, [id, loadCheckpoints]);

  return (
    <div className={cs.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Copilot — edit model structure in natural language</MessageBarTitle>
          Describe a structure change (rename a measure, write business descriptions, suggest relationships). Copilot proposes a plan you review and approve. A checkpoint is captured before any edit so you can restore. Edits persist Azure-native to the Loom model and mirror to a live Analysis Services model via TMSL when one is configured — no Microsoft Fabric / Power BI required.
        </MessageBarBody>
      </MessageBar>

      <Field label="Ask Copilot to change the model structure" hint="Plain English — Copilot grounds the plan against the live tables and measures, then waits for your approval.">
        <Textarea
          value={prompt}
          onChange={(_, d) => setPrompt(d.value)}
          placeholder={'e.g. "Rename [Tot Sales] to [Total Sales] and write a description for every measure", or "Suggest relationships between the fact and dimension tables".'}
          rows={3}
          resize="vertical"
          aria-label="Ask Copilot to change the model structure"
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void propose(); } }}
        />
      </Field>
      <div className={cs.actionRow}>
        <Button appearance="primary" icon={proposing ? <Spinner size="tiny" /> : <Sparkle16Regular />} disabled={proposing || !prompt.trim()} onClick={propose}>
          {proposing ? 'Asking Copilot…' : 'Propose edits'}
        </Button>
        <Button appearance="secondary" disabled={!!restoringId} onClick={checkpointNow}>Save checkpoint now</Button>
      </div>

      {proposeErr && (
        <MessageBar intent={proposeErr.gate ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{proposeErr.gate ? `Copilot not configured (${proposeErr.gate.missing})` : 'Copilot could not produce a plan'}</MessageBarTitle>
            {proposeErr.gate ? proposeErr.gate.detail : proposeErr.text}
          </MessageBarBody>
        </MessageBar>
      )}

      {plan && (
        <Card className={cs.planCard}>
          <div className={cs.sectionHead}>
            <Subtitle2>Proposed plan</Subtitle2>
            {plan.ops.length > 0 && (
              <Badge appearance="tint" color="brand">{plan.ops.length} edit{plan.ops.length === 1 ? '' : 's'}</Badge>
            )}
          </div>
          <Caption1>{plan.summary}</Caption1>
          {plan.ops.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>Copilot did not find a valid structure edit for that request against the current model.</MessageBarBody></MessageBar>
          ) : (
            <ul className={cs.opList}>
              {plan.ops.map((op, i) => (
                <li key={i} className={cs.opRow}>
                  <Badge appearance="tint" color={opBadgeColor(op.kind)}>{OP_LABEL[op.kind]}</Badge>
                  <span className={cs.opText}>{describeOp(op)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className={cs.actionRow}>
            <Button appearance="primary" disabled={applying || plan.ops.length === 0} icon={applying ? <Spinner size="tiny" /> : <Sparkle16Regular />} onClick={apply}>
              {applying ? 'Applying…' : `Apply ${plan.ops.length} edit(s)`}
            </Button>
            <Button appearance="secondary" disabled={applying} onClick={() => setPlan(null)}>Discard</Button>
          </div>
        </Card>
      )}

      {applyResult && (
        <MessageBar intent={applyResult.ok ? 'success' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{applyResult.ok ? 'Edits applied' : 'Apply failed'}</MessageBarTitle>
            {applyResult.text}
            {applyResult.applied && applyResult.applied.length > 0 && (
              <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL }}>{applyResult.applied.map((a, i) => <li key={i}>{a}</li>)}</ul>
            )}
            {applyResult.skipped && applyResult.skipped.length > 0 && (
              <div style={{ marginTop: tokens.spacingVerticalS}}><strong>Skipped:</strong>
                <ul style={{ margin: `${tokens.spacingVerticalXXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL }}>{applyResult.skipped.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      <Divider />

      <div className={cs.sectionHead}>
        <div className={cs.cpLabelRow}>
          <Subtitle2>Checkpoints</Subtitle2>
          {Array.isArray(checkpoints) && checkpoints.length > 0 && (
            <Badge appearance="tint" color="informative">{checkpoints.length}</Badge>
          )}
        </div>
        <Button size="small" appearance="subtle" disabled={checkpoints === null} onClick={loadCheckpoints}>Refresh</Button>
      </div>
      {restoreMsg && (
        <MessageBar intent={restoreMsg.ok ? 'success' : 'error'}><MessageBarBody>{restoreMsg.text}</MessageBarBody></MessageBar>
      )}
      {cpErr && <MessageBar intent="error"><MessageBarBody>{cpErr}</MessageBarBody></MessageBar>}
      {checkpoints === null ? (
        <Spinner size="tiny" label="Loading checkpoints…" labelPosition="after" style={{ justifyContent: 'flex-start' }} />
      ) : checkpoints.length === 0 ? (
        <div className={cs.emptyState}>
          <Subtitle2>No checkpoints yet</Subtitle2>
          <Caption1>One is captured automatically before each Copilot apply. You can also save one now with “Save checkpoint now”.</Caption1>
        </div>
      ) : (
        <div className={cs.cpList}>
          {checkpoints.map((c) => (
            <div key={c.id} className={cs.cpRow}>
              <div className={cs.cpMeta}>
                <span className={cs.cpLabelRow}>
                  <Badge appearance="outline" color={c.source === 'pre-restore' ? 'warning' : c.source === 'manual' ? 'informative' : 'brand'}>{c.source}</Badge>
                  <strong>{c.label}</strong>
                </span>
                <Caption1>{new Date(c.createdAt).toLocaleString()} · {c.stats.measures} measure(s), {c.stats.relationships} relationship(s)</Caption1>
              </div>
              <Button size="small" appearance="secondary" disabled={restoringId === c.id} icon={restoringId === c.id ? <Spinner size="tiny" /> : undefined} onClick={() => restore(c.id)}>
                {restoringId === c.id ? 'Restoring…' : 'Restore'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SemanticModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // Azure-native default (no-fabric-dependency.md): when the AAS backend is the
  // active BI backend (bicep sets NEXT_PUBLIC_LOOM_BI_BACKEND=aas when aas.bicep
  // is deployed), render the AAS Storage-mode + Refresh surface. Power BI stays
  // behind NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi (opt-in).
  if (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND === 'aas') {
    return <AasSemanticModelPanel item={item} id={id} />;
  }
  // Power BI group listing is the OPT-IN leg (rel-T04/B12): with the default
  // ('' — Loom-native tabular metadata) the hook is disabled so the default
  // render makes ZERO Power BI network calls; powerBiConfigured stays false
  // and the editor keeps its Loom-native surface.
  const pbiOptIn = (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND || '').toLowerCase() === 'powerbi';
  const ws = usePowerBiWorkspaces(pbiOptIn);
  const [workspaceId, setWorkspaceId] = useState('');
  const [datasets, setDatasets] = useState<DatasetLite[] | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [listErr, setListErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ dataset?: DatasetLite; tables?: TableLite[]; refreshSchedule?: any } | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState<RefreshLite[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<Array<{ name?: string; fromTable?: string; fromColumn?: string; toTable?: string; toColumn?: string; crossFilteringBehavior?: string }>>([]);
  const [tab, setTab] = useState<'tables' | 'relationships' | 'model' | 'modeling' | 'measures' | 'build' | 'aggregations' | 'refresh' | 'incremental' | 'config' | 'direct-lake' | 'direct-lake-query' | 'security' | 'access' | 'governance' | 'embed' | 'calcGroups' | 'fieldParams' | 'datasource' | 'copilot'>('tables');
  // --- Calculation groups + field parameters (calc-group / field-param editor)
  // Loom-native by default: saved to the item's Cosmos content + emitted in TMSL
  // at provision time. AAS / Fabric backends persist to a live model (opt-in).
  type CgItem = { name: string; expression: string; formatStringDefinition?: string; ordinal?: number };
  type CgGroup = { name: string; precedence: number; items: CgItem[] };
  type FpField = { displayName: string; fieldRef: string; order: number };
  type FpParam = { name: string; fields: FpField[] };
  const [calcGroups, setCalcGroups] = useState<CgGroup[]>([]);
  const [cgBusy, setCgBusy] = useState(false);
  const [cgMsg, setCgMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldParams, setFieldParams] = useState<FpParam[]>([]);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpMsg, setFpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Power BI is opt-in (no-fabric-dependency.md): the editor renders Loom-native
  // tabular metadata by default and only exposes Power BI actions/embed when the
  // Console identity actually has Power BI workspace access.
  const powerBiConfigured = !!(ws.workspaces && ws.workspaces.length > 0 && !ws.error);

  // --- Model builder (real Power BI push-dataset authoring) ---------------
  // Builds a NEW semantic model with tables/typed-columns/measures/relationships
  // via POST /api/items/semantic-model/build → Power BI Push Datasets REST.
  const PBI_COL_TYPES = ['String', 'Int64', 'Double', 'Decimal', 'Boolean', 'DateTime'] as const;
  type BuilderColumn = { name: string; dataType: typeof PBI_COL_TYPES[number] };
  type BuilderMeasure = { name: string; expression: string };
  type BuilderTable = { name: string; columns: BuilderColumn[]; measures: BuilderMeasure[] };
  type BuilderRel = { name: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string; crossFilteringBehavior: 'OneDirection' | 'BothDirections' };
  const [bModelName, setBModelName] = useState('');
  const [bTables, setBTables] = useState<BuilderTable[]>([
    { name: 'Sales', columns: [{ name: 'OrderId', dataType: 'Int64' }, { name: 'Amount', dataType: 'Double' }, { name: 'OrderDate', dataType: 'DateTime' }], measures: [{ name: 'TotalSales', expression: 'SUM(Sales[Amount])' }] },
  ]);
  const [bRels, setBRels] = useState<BuilderRel[]>([]);
  const [bBusy, setBBusy] = useState(false);
  const [bMsg, setBMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // DAX measure validator — name + table dropdown + Monaco DAX editor + Test
  // button. Persistence is XMLA-only (Premium / Fabric capacity feature) so
  // we honestly surface that via MessageBar instead of pretending to Save.
  const [measureName, setMeasureName] = useState('');
  const [measureTable, setMeasureTable] = useState('');
  const [daxExpr, setDaxExpr] = useState('SUM(\'Sales\'[Amount])');
  const [daxBusy, setDaxBusy] = useState(false);
  const [daxResult, setDaxResult] = useState<{ ok: boolean; value?: unknown; error?: string } | null>(null);
  // Format string + display folder + XMLA persistence (analysis-services backend).
  const [formatString, setFormatString] = useState('');
  const [displayFolder, setDisplayFolder] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string; remediation?: string; link?: string } | null>(null);
  const [xmlaPersistence, setXmlaPersistence] = useState<boolean | null>(null);

  // DAX Copilot (Loom-native NL2DAX / explain / optimize / auto-describe). Posts
  // to /api/copilot/dax (Synapse-backed; zero Power BI on this path) and streams
  // SSE steps. A generated measure auto-inserts into the DAX editor above.
  const [daxCopilotPrompt, setDaxCopilotPrompt] = useState('');
  const [daxCopilotBusy, setDaxCopilotBusy] = useState(false);
  const [daxCopilotResult, setDaxCopilotResult] = useState<string | null>(null);
  const [daxCopilotErr, setDaxCopilotErr] = useState<string | null>(null);

  const askDaxCopilot = useCallback(async () => {
    const q = daxCopilotPrompt.trim();
    if (!q) return;
    setDaxCopilotBusy(true); setDaxCopilotResult(null); setDaxCopilotErr(null);
    try {
      const res = await fetch('/api/copilot/dax', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: q, itemId: id, itemType: item.slug || 'semantic-model' }),
      });
      if (!res.ok && !res.body) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep status */ }
        setDaxCopilotErr(msg); return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setDaxCopilotErr('No response stream.'); return; }
      const decoder = new TextDecoder();
      let buf = '';
      let finalText: string | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let step: any;
          try { step = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (step.kind === 'final') finalText = step.content || '';
          if (step.kind === 'error') setDaxCopilotErr(step.error || 'DAX Copilot error');
          if (step.kind === 'tool_result' && step.name === 'dax_nl2measure' && step.result?.daxExpression) {
            setDaxExpr(step.result.daxExpression); // auto-insert generated DAX
          }
          if (step.kind === 'tool_result' && step.name === 'dax_optimize' && step.result?.optimizedExpression) {
            setDaxExpr(step.result.optimizedExpression);
          }
        }
      }
      if (finalText) setDaxCopilotResult(finalText);
    } catch (e: any) {
      setDaxCopilotErr(e?.message || String(e));
    } finally {
      setDaxCopilotBusy(false);
    }
  }, [daxCopilotPrompt, id, item.slug]);

  // Scheduled-refresh editor (config tab) — mirrors the Power BI service
  // "Scheduled refresh" pane. Writes via PATCH /datasets/{id}/refreshSchedule.
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [schedDays, setSchedDays] = useState<string[]>([]);
  const [schedTimes, setSchedTimes] = useState<string>('07:00');
  const [schedTz, setSchedTz] = useState('UTC');
  const [schedNotify, setSchedNotify] = useState<'MailOnFailure' | 'NoNotification'>('NoNotification');
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);

  // --- XMLA column-metadata editor (Tables tab) -------------------------
  // Reads + writes the tabular model via the Azure-native XMLA backend
  // (Azure Analysis Services by default, or Power BI Premium XMLA opt-in)
  // through GET/PATCH /api/items/semantic-model/[id]/model. No Fabric / PBI
  // workspace required (no-fabric-dependency.md). When no XMLA endpoint is
  // configured the route returns an honest gate which we surface below.
  const [modelTables, setModelTables] = useState<SmTable[] | null>(null);
  const [modelBackend, setModelBackend] = useState<string>('');
  const [modelGate, setModelGate] = useState<{ missing: string; detail: string } | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [selectedTableName, setSelectedTableName] = useState('');
  const [editCol, setEditCol] = useState<{ tableName: string; col: SmColumn } | null>(null);
  const [colPatch, setColPatch] = useState<Partial<SmColumn>>({});
  const [patchBusy, setPatchBusy] = useState(false);
  const [patchMsg, setPatchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [calcColDlgOpen, setCalcColDlgOpen] = useState(false);
  const [calcColName, setCalcColName] = useState('');
  const [calcColExpr, setCalcColExpr] = useState('[Revenue] - [Cost]');
  const [calcColType, setCalcColType] = useState('double');
  const [calcColCat, setCalcColCat] = useState('');
  const [calcColFolder, setCalcColFolder] = useState('');
  const [calcTableDlgOpen, setCalcTableDlgOpen] = useState(false);
  const [calcTableName, setCalcTableName] = useState('');
  const [calcTableExpr, setCalcTableExpr] = useState('CALENDAR(DATE(2020,1,1), DATE(2025,12,31))');
  const [calcBusy, setCalcBusy] = useState(false);
  const [calcMsg, setCalcMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadModel = useCallback(async () => {
    if (!datasetId) return;
    setModelLoading(true); setModelGate(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!j.ok && j.gate) { setModelGate(j.gate); setModelTables(null); return; }
      if (!j.ok) { setModelGate({ missing: 'error', detail: j.error || `HTTP ${r.status}` }); setModelTables(null); return; }
      setModelTables(j.tables || []);
      setModelBackend(j.backend || '');
      setSelectedTableName((prev) => prev || (j.tables?.[0]?.name ?? ''));
    } catch (e: any) {
      setModelGate({ missing: 'error', detail: e?.message || String(e) });
    } finally { setModelLoading(false); }
  }, [datasetId, workspaceId]);

  // Lazy-load the XMLA model the first time the Tables tab is opened for a
  // dataset. Re-fetches when the dataset changes.
  useEffect(() => { setModelTables(null); setSelectedTableName(''); setEditCol(null); }, [datasetId]);
  useEffect(() => {
    if (tab === 'tables' && datasetId && modelTables === null && !modelGate && !modelLoading) loadModel();
  }, [tab, datasetId, modelTables, modelGate, modelLoading, loadModel]);

  // --- Wave-3 "Modeling" tab seed (ModelTabsExtra) ----------------------------
  // The what-if / calculated-table dialogs seed their lists with a one-shot
  // `useState(() => seed(item.state.model))` initializer and never self-GET, so
  // ModelTabsExtra MUST be mounted with the item's REAL persisted `state.model`
  // (the same slot the dialogs POST to at `/items/semantic-model/<id>/model`).
  // Mounting with `state:{}` left every list empty after reload and pinned the
  // count badges at 0. We GET that route by `id` (matching the dialogs' POST
  // target — works Azure-native with no PBI dataset selected) and only render
  // the surface once the slice has loaded, so the seed initializers see real
  // data. `null` = not loaded yet (spinner); an object = loaded (may be empty).
  const [modelingSlice, setModelingSlice] = useState<{
    whatIfParameters: unknown[]; calculatedTables: unknown[]; dateTables: unknown[];
  } | null>(null);
  const loadModelingSlice = useCallback(async () => {
    if (!id) { setModelingSlice({ whatIfParameters: [], calculatedTables: [], dateTables: [] }); return; }
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/model`);
      const j = await r.json().catch(() => ({}));
      setModelingSlice({
        whatIfParameters: Array.isArray(j?.whatIfParameters) ? j.whatIfParameters : [],
        calculatedTables: Array.isArray(j?.calculatedTables) ? j.calculatedTables : [],
        dateTables: Array.isArray(j?.dateTables) ? j.dateTables : [],
      });
    } catch {
      // Degrade to an empty (but non-null) slice so the surface still renders.
      setModelingSlice({ whatIfParameters: [], calculatedTables: [], dateTables: [] });
    }
  }, [id]);
  useEffect(() => {
    if (tab === 'modeling' && modelingSlice === null) void loadModelingSlice();
  }, [tab, modelingSlice, loadModelingSlice]);

  const patchColumn = useCallback(async () => {
    if (!editCol || !datasetId) return;
    setPatchBusy(true); setPatchMsg(null);
    // Merge current column with the user's edits → COMPLETE column object
    // (TMSL Alter requires every read-write property, not a partial patch).
    const full: SmColumn = { ...editCol.col, ...colPatch };
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'alter-column', tableName: editCol.tableName, columnName: editCol.col.name, column: full }),
      });
      const j = await r.json();
      if (!j.ok) { setPatchMsg({ ok: false, text: j.error || (j.gate?.detail) || `HTTP ${r.status}` }); return; }
      setPatchMsg({ ok: true, text: `Column "${full.name}" updated.` });
      setEditCol(null); setColPatch({});
      setModelTables(null); await loadModel();
    } catch (e: any) { setPatchMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setPatchBusy(false); }
  }, [editCol, colPatch, datasetId, workspaceId, loadModel]);

  const addCalcColumn = useCallback(async () => {
    if (!datasetId || !selectedTableName || !calcColName.trim() || !calcColExpr.trim()) return;
    setCalcBusy(true); setCalcMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'add-calculated-column', tableName: selectedTableName,
          column: { name: calcColName.trim(), dataType: calcColType, expression: calcColExpr.trim(), dataCategory: calcColCat || undefined, displayFolder: calcColFolder || undefined },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setCalcMsg({ ok: false, text: j.error || (j.gate?.detail) || `HTTP ${r.status}` }); return; }
      setCalcMsg({ ok: true, text: `Calculated column "${calcColName}" added to ${selectedTableName}.` });
      setModelTables(null); await loadModel();
      setTimeout(() => { setCalcColDlgOpen(false); setCalcMsg(null); }, 1200);
    } catch (e: any) { setCalcMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setCalcBusy(false); }
  }, [datasetId, workspaceId, selectedTableName, calcColName, calcColExpr, calcColType, calcColCat, calcColFolder, loadModel]);

  const addCalcTable = useCallback(async () => {
    if (!datasetId || !calcTableName.trim() || !calcTableExpr.trim()) return;
    setCalcBusy(true); setCalcMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'add-calculated-table', tableName: calcTableName.trim(), expression: calcTableExpr.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCalcMsg({ ok: false, text: j.error || (j.gate?.detail) || `HTTP ${r.status}` }); return; }
      setCalcMsg({ ok: true, text: `Calculated table "${calcTableName}" created.` });
      setSelectedTableName(calcTableName.trim());
      setModelTables(null); await loadModel();
      setTimeout(() => { setCalcTableDlgOpen(false); setCalcMsg(null); }, 1200);
    } catch (e: any) { setCalcMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setCalcBusy(false); }
  }, [datasetId, workspaceId, calcTableName, calcTableExpr, loadModel]);

  // --- Incremental refresh policy + hybrid table (current-period DirectQuery) ---
  // Mirrors the Power BI Desktop "Incremental refresh and real-time data" dialog:
  // archive (keep) range, incremental refresh range, real-time DirectQuery toggle,
  // detect-changes column. Writes via PUT /refresh-policy → aas-incremental-refresh
  // (TMSL Alter + Refresh applyRefreshPolicy). Opt-in AAS backend; default stays
  // loom-native.
  const GRAINS = ['day', 'month', 'quarter', 'year'] as const;
  type Grain = typeof GRAINS[number];
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


  // --- Security tab (RLS row filters + OLS object permissions) -------------
  // Authors model roles through the Analysis-Services XMLA endpoint (Azure
  // Analysis Services by default, or an opt-in Power BI Premium / Fabric
  // capacity). GET/PUT /api/items/semantic-model/[id]/roles; POST ?action=test
  // runs a test-as-role DAX probe (the receipt). See aas-client.ts.
  type SecColPerm = { name: string; metadataPermission: 'read' | 'none' };
  type SecTablePerm = {
    name: string;
    filterExpression?: string;
    metadataPermission?: 'read' | 'none';
    columnPermissions?: SecColPerm[];
  };
  type SecRole = {
    name: string;
    modelPermission: 'read';
    tablePermissions: SecTablePerm[];
    members?: Array<{ memberName: string }>;
  };
  const [secRoles, setSecRoles] = useState<SecRole[] | null>(null);
  const [secErr, setSecErr] = useState<string | null>(null);
  const [secGate, setSecGate] = useState<{ missing: string; detail: string } | null>(null);
  const [secBusy, setSecBusy] = useState(false);
  const [secSaving, setSecSaving] = useState(false);
  const [secSaveMsg, setSecSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secSelectedRole, setSecSelectedRole] = useState<string>('');
  const [secOlsTable, setSecOlsTable] = useState<string>('');
  const [testRoleUpn, setTestRoleUpn] = useState('');
  const [testQuery, setTestQuery] = useState('EVALUATE TOPN(10, Sales)');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ rows: Array<Record<string, unknown>>; rowCount: number } | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);

  const loadRoles = useCallback(async (dsId: string, wsId: string) => {
    setSecBusy(true); setSecErr(null); setSecGate(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/roles?workspaceId=${encodeURIComponent(wsId)}&catalog=${encodeURIComponent(dsId)}`);
      const j = await r.json();
      if (r.status === 501 && j.gate) { setSecGate(j.gate); setSecRoles([]); return; }
      if (!j.ok) { setSecErr(j.error || `HTTP ${r.status}`); setSecRoles([]); return; }
      setSecRoles(Array.isArray(j.roles) ? j.roles : []);
    } catch (e: any) { setSecErr(e?.message || String(e)); setSecRoles([]); }
    finally { setSecBusy(false); }
  }, []);

  const saveRoles = useCallback(async () => {
    if (!datasetId || !secRoles) return;
    // Client-side DAX validation before the round-trip.
    for (const role of secRoles) {
      for (const tp of role.tablePermissions) {
        if (tp.filterExpression && tp.filterExpression.trim()) {
          const v = validateRlsDax(tp.filterExpression);
          if (!v.ok) { setSecSaveMsg({ ok: false, text: `Role "${role.name}" / ${tp.name}: ${v.error}` }); return; }
        }
      }
    }
    setSecSaving(true); setSecSaveMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/roles?workspaceId=${encodeURIComponent(workspaceId)}&catalog=${encodeURIComponent(datasetId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roles: secRoles }),
      });
      const j = await r.json();
      if (!j.ok) { setSecSaveMsg({ ok: false, text: j.error || j.gate?.detail || `HTTP ${r.status}` }); return; }
      setSecSaveMsg({ ok: true, text: `Saved ${j.roleCount} role(s) to the model via XMLA TMSL.` });
    } catch (e: any) { setSecSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSecSaving(false); }
  }, [datasetId, workspaceId, secRoles]);

  const runTestRole = useCallback(async () => {
    if (!datasetId || !secSelectedRole || !testRoleUpn.trim() || !testQuery.trim()) return;
    setTestBusy(true); setTestErr(null); setTestResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/roles?action=test&workspaceId=${encodeURIComponent(workspaceId)}&catalog=${encodeURIComponent(datasetId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roleName: secSelectedRole, effectiveUserName: testRoleUpn.trim(), daxQuery: testQuery }),
      });
      const j = await r.json();
      if (!j.ok) { setTestErr(j.error || j.gate?.detail || `HTTP ${r.status}`); return; }
      setTestResult({ rows: j.rows || [], rowCount: j.rowCount ?? (j.rows?.length || 0) });
    } catch (e: any) { setTestErr(e?.message || String(e)); }
    finally { setTestBusy(false); }
  }, [datasetId, workspaceId, secSelectedRole, testRoleUpn, testQuery]);

  // Mutate a single role in place (immutable update for setSecRoles).
  const updateRole = useCallback((roleName: string, mut: (r: SecRole) => SecRole) => {
    setSecRoles((prev) => (prev || []).map((r) => (r.name === roleName ? mut(r) : r)));
  }, []);

  // matching queries to the small agg table and falls through to the DirectQuery
  // detail table otherwise. Writes via POST /api/items/semantic-model/{id}/model
  // → XMLA (Azure Analysis Services by default; Premium/Fabric XMLA opt-in by URL).
  const AGG_SUMMARIZATIONS = ['GroupBy', 'Sum', 'Count', 'Min', 'Max'] as const;
  const AGG_DATATYPES = ['int64', 'double', 'decimal', 'dateTime', 'string', 'boolean'] as const;
  type AggSummarization = typeof AGG_SUMMARIZATIONS[number];
  type AltMap = { aggColumn: string; dataType: typeof AGG_DATATYPES[number]; summarization: AggSummarization; detailTable: string; detailColumn: string };
  const [aggTableName, setAggTableName] = useState('');
  const [aggPartitionExpr, setAggPartitionExpr] = useState('');
  const [aggAltMaps, setAggAltMaps] = useState<AltMap[]>([]);
  const [aggProbeQuery, setAggProbeQuery] = useState('');
  const [aggBusy, setAggBusy] = useState(false);
  const [aggMsg, setAggMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aggProbeResult, setAggProbeResult] = useState<Array<Record<string, unknown>> | null>(null);

  const addAltMap = useCallback(() => {
    setAggAltMaps((prev) => [...prev, { aggColumn: '', dataType: 'double', summarization: 'Sum', detailTable: detail?.tables?.[0]?.name || '', detailColumn: '' }]);
  }, [detail?.tables]);
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
    const t = detail?.tables?.[0];
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
  }, [detail?.tables, aggTableName]);

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

  // --- Automatic aggregations builder (XMLA TMSL alternateOf) --------------
  // Defines a hidden, Import-mode aggregation table whose columns each carry an
  // alternateOf (BaseTable/BaseColumn + Summarization) so the AS engine routes
  // matching queries to the small agg table and falls through to the DirectQuery
  // detail table otherwise. Writes via POST /api/items/semantic-model/{id}/model
  // → XMLA (Azure Analysis Services by default; Premium/Fabric XMLA opt-in by URL).
  // Direct Lake query with transparent Serverless fallback (direct-lake-query tab).
  // When the warm AAS cache (last model refresh) is within LOOM_DL_CACHE_TTL_SECONDS
  // the row is served from the Power BI in-memory VertiPaq cache; otherwise the
  // same Gold Delta files are queried via Synapse Serverless OPENROWSET — the
  // Azure-native analog of Fabric "Direct Lake on SQL" DirectQuery fallback.
  interface DlQueryResult {
    ok: boolean;
    servingFrom?: 'warm-cache' | 'serverless-fallback';
    columns?: string[];
    rows?: unknown[][];
    rowCount?: number;
    executionMs?: number;
    truncated?: boolean;
    endpoint?: string;
    deltaPath?: string;
    lastRefreshedAt?: string | null;
    cacheTtlSeconds?: number;
    error?: string;
  }
  const [dlTable, setDlTable] = useState('');
  const [dlMaxRows, setDlMaxRows] = useState(1000);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [dlResult, setDlResult] = useState<DlQueryResult | null>(null);

  // --- Direct Lake (shim) tab -------------------------------------------------
  // Azure-native parity for Fabric Direct Lake: the shim keeps a warm AAS
  // (Power BI Premium XMLA) cache fresh from an ADLS Gen2 Delta source, driven
  // by _delta_log Event Grid notifications. Config persists to the shim's
  // Cosmos store via PUT /api/items/semantic-model/{id}/direct-lake.
  type DlPolicy = 'Partition' | 'Full' | 'DirectQueryFallback' | 'Composite';
  type DlTableRow = { tableName: string; policy: DlPolicy; partitionColumn: string };
  interface DlShimRun { requestId: string; refreshType?: string; status?: string; startTime?: string; endTime?: string; durationMs?: number; error?: string }
  interface DlEventGrid { systemTopic: string; topicState: string; subscriptionName: string; subscriptionState: string; destinationQueueId?: string }
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
  const DEFAULT_DL_PATH_HINT = 'abfss://gold@<account>.dfs.core.windows.net/<delta-table-path>';

  const loadDirectLake = useCallback(async (dsId: string, wsId: string) => {
    if (!dsId) return;
    setDlLoading(true); setDlMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/direct-lake${wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : ''}`);
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
      const fromModel = (detail?.tables || []).map((t) => ({ tableName: t.name, policy: 'Partition' as DlPolicy, partitionColumn: '' }));
      return fromModel;
    });
  }, [tab, detail?.tables]);

  useEffect(() => {
    if (tab === 'direct-lake' && datasetId) loadDirectLake(datasetId, workspaceId);
  }, [tab, datasetId, workspaceId, loadDirectLake]);

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

  // Composite + Dual per-table storage mode (Tables tab). Each table gets an
  // Import / DirectQuery / Dual picker so a single model can MIX modes; the
  // selection is pushed to the BFF datasource route which builds a model.bim
  // TMSL with a per-partition `mode` and applies it (Fabric updateDefinition)
  // or returns it as an Invoke-ASCmd receipt. Dual requires Premium/Fabric.
  const TABLE_STORAGE_MODES = ['import', 'directQuery', 'dual'] as const;
  type TableStorageMode = typeof TABLE_STORAGE_MODES[number];
  const [tableModes, setTableModes] = useState<Record<string, TableStorageMode>>({});
  const [tableSourceQ, setTableSourceQ] = useState<Record<string, string>>({});
  const [modesBusy, setModesBusy] = useState(false);
  const [modesMsg, setModesMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tmslReceipt, setTmslReceipt] = useState<string | null>(null);

  // --- Get data (Power Query / M → Delta → semantic layer) ----------------
  // Source picker → Power Query (M) authoring (PowerQueryHost) → materialise to
  // Delta in ADLS via ADF/Synapse data flows → refresh the AAS tabular model.
  // POSTs to /api/items/semantic-model/{id}/ingest (real backends; honest gate).
  const [getDataOpen, setGetDataOpen] = useState(false);
  const [ingestTab, setIngestTab] = useState<'source' | 'transform' | 'run'>('source');
  const [ingestMScript, setIngestMScript] = useState(INGEST_STARTER_M);
  const [ingestContainer, setIngestContainer] = useState<'bronze' | 'silver' | 'gold'>('silver');
  const [ingestAasTable, setIngestAasTable] = useState('');
  const [ingestRunning, setIngestRunning] = useState(false);
  const [ingestResult, setIngestResult] = useState<{
    ok: boolean; deltaPath?: string; adfRunId?: string; deltaRunId?: string; deltaBackend?: string;
    aasRefreshId?: string; warnings?: string[]; error?: string;
  } | null>(null);

  const insertSource = useCallback((mExpr: string) => {
    // Append/replace the active query's Source step with the connector's M.
    setIngestMScript((prev) => {
      const qs = parseSharedQueries(prev);
      const target = qs[qs.length - 1];
      const body = `let\n    Source = ${mExpr}\nin\n    Source`;
      if (!target) {
        return `section Section1;\n\nshared IngestQuery = ${body};\n`;
      }
      return setQueryBody(prev, target.name, body);
    });
    setIngestTab('transform');
  }, []);

  const runIngest = useCallback(async () => {
    setIngestRunning(true); setIngestResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mScript: typeof window === 'undefined' ? '' : window.btoa(unescape(encodeURIComponent(ingestMScript))),
          container: ingestContainer,
          aasTable: ingestAasTable.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setIngestResult({ ok: false, error: j.error || j.hint || `HTTP ${r.status}`, warnings: j.warnings }); return; }
      setIngestResult({ ok: true, deltaPath: j.deltaPath, adfRunId: j.adfRunId, deltaRunId: j.deltaRunId, deltaBackend: j.deltaBackend, aasRefreshId: j.aasRefreshId, warnings: j.warnings });
    } catch (e: any) {
      setIngestResult({ ok: false, error: e?.message || String(e) });
    } finally { setIngestRunning(false); }
  }, [id, ingestMScript, ingestContainer, ingestAasTable]);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDatasets([]); setListErr(j.error); return; }
      setDatasets(j.datasets || []);
      setDatasetId((prev) => prev || (j.datasets?.[0]?.id ?? ''));
    } catch (e: any) {
      setDatasets([]); setListErr(e?.message || String(e));
    }
  }, []);

  const loadDetail = useCallback(async (wsId: string, dsId: string) => {
    setDetailErr(null); setDetail(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      setDetail({ dataset: j.dataset, tables: j.tables || [], refreshSchedule: j.refreshSchedule });
      setRelationships(Array.isArray(j.relationships) ? j.relationships : []);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadRefreshes = useCallback(async (wsId: string, dsId: string) => {
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/refreshes?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setRefreshes(j.refreshes || []);
    } catch { /* silently keep last */ }
  }, []);

  // Load existing calc groups + field parameters from the model route (Cosmos
  // content on loom-native, or a live model's TMSL on the fabric backend).
  const loadModelObjects = useCallback(async (wsId: string, dsId: string) => {
    try {
      const q = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : '';
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/model${q}`);
      const j = await r.json();
      if (j.ok) {
        if (Array.isArray(j.calculationGroups)) setCalcGroups(j.calculationGroups);
        if (Array.isArray(j.fieldParameters)) setFieldParams(j.fieldParameters);
      }
    } catch { /* keep current in-editor state */ }
  }, []);

  const saveCalcGroups = useCallback(async () => {
    if (!datasetId) return;
    setCgBusy(true); setCgMsg(null);
    try {
      const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model${q}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ calculationGroups: calcGroups }),
      });
      const j = await r.json();
      if (!j.ok) { setCgMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setCgMsg({ ok: true, text: `Saved via ${j.backend}. ${(j.steps || []).join(' ')}` });
    } catch (e: any) { setCgMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setCgBusy(false); }
  }, [datasetId, workspaceId, calcGroups]);

  const saveFieldParams = useCallback(async () => {
    if (!datasetId) return;
    setFpBusy(true); setFpMsg(null);
    try {
      const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model${q}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fieldParameters: fieldParams }),
      });
      const j = await r.json();
      if (!j.ok) { setFpMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setFpMsg({ ok: true, text: `Saved via ${j.backend}. ${(j.steps || []).join(' ')}` });
    } catch (e: any) { setFpMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setFpBusy(false); }
  }, [datasetId, workspaceId, fieldParams]);

  // Auto-pick the first Power BI workspace once loaded so the list fetch fires
  // and the first dataset auto-selects — enabling New measure / Refresh / Open
  // immediately instead of leaving them disabled behind a manual pick. Matches
  // the Eventstream/Activator auto-pick pattern. Users can still switch.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => {
    if (workspaceId && datasetId) { loadDetail(workspaceId, datasetId); loadRefreshes(workspaceId, datasetId); }
  }, [workspaceId, datasetId, loadDetail, loadRefreshes]);
  useEffect(() => { if (datasetId) loadModelObjects(workspaceId, datasetId); }, [workspaceId, datasetId, loadModelObjects]);

  // Lazy-load roles the first time the Security tab is opened for a dataset.
  useEffect(() => {
    if (tab === 'security' && datasetId && secRoles === null && !secBusy) {
      loadRoles(datasetId, workspaceId);
    }
  }, [tab, datasetId, workspaceId, secRoles, secBusy, loadRoles]);
  // Reset role state when the selected dataset changes.
  useEffect(() => { setSecRoles(null); setSecSelectedRole(''); setSecSaveMsg(null); setTestResult(null); }, [datasetId]);
  // Default the test query / OLS table to the first model table once known.
  useEffect(() => {
    const first = detail?.tables?.[0]?.name;
    if (first) {
      setTestQuery((q) => (q.includes('Sales') && !((detail?.tables || []).some((t) => t.name === 'Sales')) ? `EVALUATE TOPN(10, '${first}')` : q));
      setSecOlsTable((t) => t || first);
    }
  }, [detail?.tables]);

  const refreshNow = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setRefreshing(true); setRefreshErr(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setRefreshErr(j.error || 'refresh failed');
      else { setTimeout(() => loadRefreshes(workspaceId, datasetId), 1500); }
    } finally { setRefreshing(false); }
  }, [workspaceId, datasetId, loadRefreshes]);

  // Hydrate the scheduled-refresh form from the live schedule whenever the
  // selected dataset's detail loads.
  useEffect(() => {
    const sch = detail?.refreshSchedule;
    setSchedMsg(null);
    if (sch && typeof sch === 'object') {
      setSchedEnabled(!!sch.enabled);
      setSchedDays(Array.isArray(sch.days) ? sch.days : []);
      setSchedTimes(Array.isArray(sch.times) && sch.times.length ? sch.times.join(', ') : '07:00');
      setSchedTz(sch.localTimeZoneId || 'UTC');
      setSchedNotify(sch.notifyOption === 'MailOnFailure' ? 'MailOnFailure' : 'NoNotification');
    } else {
      setSchedEnabled(false); setSchedDays([]); setSchedTimes('07:00'); setSchedTz('UTC'); setSchedNotify('NoNotification');
    }
  }, [detail?.refreshSchedule, datasetId]);

  const toggleSchedDay = useCallback((day: string) => {
    setSchedDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  }, []);

  const saveSchedule = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setSchedBusy(true); setSchedMsg(null);
    const times = schedTimes.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh-schedule?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: schedEnabled, days: schedDays, times, localTimeZoneId: schedTz, notifyOption: schedNotify }),
      });
      const j = await r.json();
      if (!j.ok) { setSchedMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setSchedMsg({ ok: true, text: 'Scheduled refresh updated.' });
      setDetail((prev) => prev ? { ...prev, refreshSchedule: j.schedule } : prev);
    } catch (e: any) { setSchedMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSchedBusy(false); }
  }, [workspaceId, datasetId, schedEnabled, schedDays, schedTimes, schedTz, schedNotify]);

  const takeOver = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setTakeoverBusy(true); setSchedMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/take-over?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setSchedMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setSchedMsg({ ok: true, text: 'Dataset taken over by the Console identity. You can now edit the schedule.' });
      loadDetail(workspaceId, datasetId);
    } catch (e: any) { setSchedMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setTakeoverBusy(false); }
  }, [workspaceId, datasetId, loadDetail]);

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

  // Apply the per-table storage modes: builds a composite model.bim TMSL with a
  // per-partition `mode` (import/directQuery/dual) and applies it via the
  // datasource BFF route, then surfaces the live DAX probe + TMSL receipt.
  const applyModes = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setModesBusy(true); setModesMsg(null); setTmslReceipt(null);
    try {
      const tables = (detail?.tables || []).map((t) => {
        const mode: TableStorageMode = tableModes[t.name] ?? 'import';
        return {
          name: t.name,
          mode,
          ...(mode !== 'import'
            ? { sourceQuery: (tableSourceQ[t.name] || `SELECT * FROM [${t.name}]`).trim(), dataSourceName: 'sqlSource' }
            : {}),
          columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })),
        };
      });
      const rels = relationships
        .filter((r) => r.fromTable && r.fromColumn && r.toTable && r.toColumn)
        .map((r) => ({
          name: r.name,
          fromTable: r.fromTable!, fromColumn: r.fromColumn!,
          toTable: r.toTable!, toColumn: r.toColumn!,
          crossFilteringBehavior: (r.crossFilteringBehavior === 'bothDirections' ? 'bothDirections' : 'oneDirection') as 'oneDirection' | 'bothDirections',
        }));
      const r = await clientFetch(
        `/api/items/semantic-model/${encodeURIComponent(datasetId)}/datasource?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: detail?.dataset?.name || 'CompositeModel', tables, relationships: rels }),
        },
      );
      const j = await r.json();
      if (!j.ok) { setTmslReceipt(typeof j.tmsl === 'string' ? j.tmsl : null); setModesMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setTmslReceipt(typeof j.tmsl === 'string' ? j.tmsl : null);
      const probe = j.probe ? ` Query probe (first rows): ${j.probe}` : '';
      setModesMsg({
        ok: true,
        text: j.applied
          ? `Composite TMSL applied in-place via Fabric.${probe}`
          : `Composite TMSL built (apply offline via Invoke-ASCmd, or opt into a Fabric/Premium backend). See receipt below.${probe}`,
      });
    } catch (e: any) { setModesMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setModesBusy(false); }
  }, [workspaceId, datasetId, detail?.tables, detail?.dataset?.name, tableModes, tableSourceQ, relationships]);

  // Validate a candidate DAX measure expression server-side via the Power
  // BI executeQueries REST endpoint. The route compiles via DEFINE MEASURE
  // and evaluates a probe row — invalid DAX returns the engine's real
  // error message (not a mocked "looks good"). Persistence requires XMLA.
  const validateDax = useCallback(async () => {
    if (!workspaceId || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()) return;
    setDaxBusy(true); setDaxResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/measures?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measureName: measureName.trim(), tableName: measureTable.trim(), daxExpression: daxExpr }),
      });
      const j = await r.json();
      if (!j.ok) { setDaxResult({ ok: false, error: j.error || `HTTP ${r.status}` }); return; }
      const row = j?.probe?.rows?.[0] || {};
      const v = Object.values(row)[0];
      setDaxResult({ ok: true, value: v });
    } catch (e: any) { setDaxResult({ ok: false, error: e?.message || String(e) }); }
    finally { setDaxBusy(false); }
  }, [workspaceId, datasetId, measureName, measureTable, daxExpr]);

  // Probe the model route once a dataset is selected so the Measures tab can
  // show the Save-to-model button when LOOM_SEMANTIC_BACKEND=analysis-services
  // + LOOM_AAS_SERVER are wired (vs an honest infra-gate otherwise).
  useEffect(() => {
    if (!datasetId) { setXmlaPersistence(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model`);
        const j = await r.json();
        if (!cancelled) setXmlaPersistence(!!j?.xmlaPersistence);
      } catch { if (!cancelled) setXmlaPersistence(false); }
    })();
    return () => { cancelled = true; };
  }, [datasetId]);

  // Persist the measure (DAX + format string + display folder) into the model
  // via TMSL createOrReplace over the AAS XMLA endpoint. The route evaluates
  // the saved measure server-side so success reflects a real computed value —
  // not a fake toast (no-vaporware.md). When AAS isn't wired the route returns
  // an honest 501 gate we surface verbatim.
  const saveMeasure = useCallback(async () => {
    if (!datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()) return;
    setSaveBusy(true); setSaveResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tableName: measureTable.trim(),
          measureName: measureName.trim(),
          expression: daxExpr,
          formatString: formatString.trim() || undefined,
          displayFolder: displayFolder.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveResult({ ok: false, text: j.error || `HTTP ${r.status}`, remediation: j.remediation, link: j.link });
        return;
      }
      const evalNote = j?.evaluate ? ` Evaluated value: ${j.evaluate.value === null || j.evaluate.value === undefined ? 'NULL' : String(j.evaluate.value)}.` : '';
      setSaveResult({ ok: true, text: `Measure "${measureName.trim()}" saved to the model via TMSL createOrReplace.${evalNote}` });
      if (workspaceId && datasetId) loadDetail(workspaceId, datasetId);
    } catch (e: any) { setSaveResult({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [datasetId, workspaceId, measureName, measureTable, daxExpr, formatString, displayFolder, loadDetail]);

  const focusNewMeasure = useCallback(() => {
    setTab('measures');
    if (!measureTable && detail?.tables?.[0]?.name) setMeasureTable(detail.tables[0].name);
    if (!measureName) setMeasureName('MyMeasure');
  }, [measureTable, measureName, detail?.tables]);

  // Direct Lake query: POST to the BFF, which serves from the warm Power BI
  // cache when fresh and transparently falls back to Synapse Serverless
  // OPENROWSET over the Gold Delta files when the cache is stale/unbuilt.
  // datasetId is optional here — the Serverless fallback only needs the table
  // name and LOOM_GOLD_URL, so the query works with no Power BI workspace bound.
  const executeDlQuery = useCallback(async () => {
    if (!dlTable) return;
    setDlqLoading(true); setDlResult(null);
    try {
      const dsPath = datasetId ? encodeURIComponent(datasetId) : '_';
      const r = await clientFetch(`/api/items/semantic-model/${dsPath}/direct-lake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, table: dlTable, maxRows: dlMaxRows }),
      });
      const j: DlQueryResult = await r.json();
      setDlResult(j);
    } catch (e: any) {
      setDlResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setDlqLoading(false);
    }
  }, [workspaceId, datasetId, dlTable, dlMaxRows]);

  // Build a REAL new semantic model (push dataset) via the Power BI Push
  // Datasets REST API. After a successful build we refresh the dataset list
  // and select the new model so the user lands in its detail view.
  const buildModel = useCallback(async () => {
    if (!workspaceId || !bModelName.trim() || bTables.length === 0) return;
    setBBusy(true); setBMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/build?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: bModelName.trim(),
          tables: bTables.map((t) => ({
            name: t.name.trim(),
            columns: t.columns.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), dataType: c.dataType })),
            measures: t.measures.filter((m) => m.name.trim() && m.expression.trim()).map((m) => ({ name: m.name.trim(), expression: m.expression.trim() })),
          })),
          relationships: bRels.filter((rl) => rl.fromTable && rl.fromColumn && rl.toTable && rl.toColumn),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setBMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setBMsg({ ok: true, text: `Created semantic model "${j.name}" (id ${String(j.datasetId).slice(0, 8)}…). Reloading workspace…` });
      await loadList(workspaceId);
      if (j.datasetId) { setDatasetId(j.datasetId); setTab('tables'); }
    } catch (e: any) { setBMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBBusy(false); }
  }, [workspaceId, bModelName, bTables, bRels, loadList]);

  const focusBuild = useCallback(() => {
    setTab('build');
    if (!bModelName) setBModelName('My semantic model');
  }, [bModelName]);

  const focusModel = useCallback(() => setTab('model'), []);

  const canRefresh = !!datasetId && !refreshing && detail?.dataset?.isRefreshable !== false;
  // DirectQuery models are live against the source — never refreshable (the
  // Power BI REST `isRefreshable` already returns false for DQ datasets). When
  // the model is in DirectQuery storage mode we surface the Source binder tab
  // and disable Refresh with an honest "no data to import" reason.
  const isDqMode = (detail?.dataset?.targetStorageMode || '').toLowerCase() === 'directquery';
  const openInPbi = useCallback(() => {
    if (workspaceId && datasetId) {
      window.open(`https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/details`, '_blank', 'noreferrer');
    }
  }, [workspaceId, datasetId]);
  // Only real, working actions. Authoring that genuinely requires the XMLA
  // endpoint / Power BI Desktop (RLS roles, perspectives, Direct Lake toggle,
  // TMSL import) is NOT shown as a dead button — it's documented in the
  // Measures-tab MessageBar instead. See no-vaporware.md.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data', actions: [
        { label: 'Get data', onClick: () => { setGetDataOpen(true); setIngestTab('source'); }, title: 'Ingest data with Power Query (M) → Delta in ADLS → refresh the semantic layer (Azure-native, no Fabric required)' },
      ]},
      { label: 'Model', actions: [
        { label: 'Build model', onClick: workspaceId ? focusBuild : undefined, disabled: !workspaceId, title: !workspaceId ? 'select a workspace first' : 'Create a new semantic model with tables, columns, measures & relationships via Power BI REST (push dataset)' },
        { label: 'Model view', onClick: datasetId ? focusModel : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Interactive relationship diagram (cardinality, cross-filter, active/inactive) + drill-hierarchy editor; writes TMSL' },
      ]},
      { label: 'Measures', actions: [
        { label: 'New measure (DAX)', onClick: datasetId ? focusNewMeasure : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Open the Measures tab to author + validate DAX against the live model' },
        { label: saveBusy ? 'Saving…' : 'Save to model (XMLA)', onClick: datasetId ? () => { setTab('measures'); saveMeasure(); } : undefined, disabled: !datasetId || saveBusy, title: !datasetId ? 'select a dataset first' : 'Persist the measure (DAX + format string + display folder) via TMSL createOrReplace (requires LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER)' },
      ]},
      { label: 'Aggregations', actions: [
        { label: 'Manage aggregations', onClick: datasetId ? () => setTab('aggregations') : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Define an automatic-aggregation table (alternateOf) so the engine routes matching queries to a small pre-aggregated cache' },
      ]},
      { label: 'Advanced', actions: [
        { label: 'Calc groups', onClick: datasetId ? () => setTab('calcGroups') : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Author calculation groups (SELECTEDMEASURE patterns) — switch a visual’s aggregation via a slicer' },
        { label: 'Field parameters', onClick: datasetId ? () => setTab('fieldParams') : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Build field-parameter calculated tables (NAMEOF) — swap a visual’s measure via a slicer' },
      ]},
      { label: 'Columns', actions: [
        { label: 'Edit columns', onClick: datasetId ? () => setTab('tables') : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Open the Tables tab to edit column metadata (data category, format, summarize-by, display folder, sort-by, hidden) via XMLA' },
        { label: 'Add calc. column', onClick: (datasetId && modelTables && selectedTableName) ? () => { setCalcMsg(null); setCalcColDlgOpen(true); } : undefined, disabled: !datasetId || !modelTables || !selectedTableName, title: !modelTables ? 'configure LOOM_AAS_SERVER_URL (Tables tab) to enable calculated columns' : 'Add a calculated column (DAX)' },
        { label: 'Add calc. table', onClick: (datasetId && modelTables) ? () => { setCalcMsg(null); setCalcTableDlgOpen(true); } : undefined, disabled: !datasetId || !modelTables, title: !modelTables ? 'configure LOOM_AAS_SERVER_URL (Tables tab) to enable calculated tables' : 'Create a calculated table (DAX)' },
      ]},
      { label: 'Source', actions: [
        { label: refreshing ? 'Queuing…' : 'Refresh', onClick: (canRefresh && !isDqMode) ? refreshNow : undefined, disabled: !canRefresh || isDqMode, title: isDqMode ? 'DirectQuery model is live — no data to import. Use the DirectQuery source tab to rebind.' : (detail?.dataset?.isRefreshable === false ? 'dataset is not refreshable (push or DirectQuery without gateway)' : (!datasetId ? 'select a dataset first' : undefined)) },
        { label: 'DirectQuery source', onClick: isDqMode ? () => setTab('datasource') : undefined, disabled: !isDqMode, title: isDqMode ? 'Bind a live Azure source for this DirectQuery model' : 'available for DirectQuery storage-mode models' },
      ]},
      { label: 'Open', actions: [
        { label: 'Open in Power BI', onClick: datasetId ? openInPbi : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'opens the dataset in Power BI — author RLS roles, perspectives & Direct Lake there' },
      ]},
    ]},
  ], [refreshing, canRefresh, refreshNow, datasetId, detail?.dataset?.isRefreshable, isDqMode, focusNewMeasure, openInPbi, workspaceId, focusBuild, focusModel, saveBusy, saveMeasure, modelTables, selectedTableName]);

  return (
    <>
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <PowerBiTree
          workspaceId={workspaceId}
          selectedDatasetId={datasetId}
          onOpenDataset={(dsId) => { setDatasetId(dsId); setTab('tables'); }}
          onNewDataset={focusBuild}
          onOpenReport={(r) => { if (r.webUrl) { try { window.open(r.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } } }}
          onOpenDashboard={(d) => { if (d.webUrl) { try { window.open(d.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } } }}
        />
      }
      main={
        <>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">Semantic model</Badge>
              <Button appearance="outline" icon={<DatabaseLink20Regular />} onClick={() => { setGetDataOpen(true); setIngestTab('source'); }} title="Power Query (M) → Delta in ADLS → semantic layer (Azure-native, no Fabric required)">Get data</Button>
              <OpenInPbiDesktopButton type="semantic-model" id={id} name={detail?.dataset?.name} mode="directQuery" />
              {powerBiConfigured && (
                <>
                  <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
                  <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
                </>
              )}
              <Button appearance="outline" icon={<Add20Regular />} onClick={focusBuild} disabled={!powerBiConfigured || !workspaceId} title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : 'Build a new semantic model (push dataset) via Power BI REST'} style={{ marginLeft: 'auto' }}>Build model</Button>
              <Button
                appearance="primary"
                icon={<Play20Regular />}
                disabled={!datasetId || refreshing || detail?.dataset?.isRefreshable === false || !powerBiConfigured}
                onClick={refreshNow}
                title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : (detail?.dataset?.isRefreshable === false ? 'Dataset is not refreshable (e.g. push dataset or DirectQuery without gateway).' : undefined)}
              >
                {refreshing ? 'Queuing…' : 'Refresh dataset'}
              </Button>
            </div>

            {/* Get data — Power Query (M) → Delta → semantic layer ingest wizard */}
            <Dialog open={getDataOpen} onOpenChange={(_, d) => setGetDataOpen(d.open)}>
              <DialogSurface style={{ maxWidth: '1080px', width: '94vw' }}>
                <DialogBody>
                  <DialogTitle>Get data — Power Query (M) ingest</DialogTitle>
                  <DialogContent>
                    <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM}}>
                      <MessageBarBody>
                        <MessageBarTitle>Azure-native, no Fabric required</MessageBarTitle>
                        Author a Power Query (M) mashup, then <strong>Run ingest</strong>: Loom compiles it into an ADF
                        WranglingDataFlow (M → Parquet), a Mapping Data Flow lands the result as <strong>Delta</strong> in
                        ADLS Gen2, and the Azure Analysis Services tabular model is refreshed so the table is queryable.
                        Set <code>LOOM_SYNAPSE_WORKSPACE</code> to run the Delta step on Synapse instead. In Government
                        clouds (no AAS) the Delta is queryable via Synapse Serverless <code>OPENROWSET</code>.
                      </MessageBarBody>
                    </MessageBar>
                    <div className={s.tabBar}>
                      <TabList selectedValue={ingestTab} onTabSelect={(_: unknown, d: any) => setIngestTab(d.value)}>
                        <Tab value="source">1 · Source</Tab>
                        <Tab value="transform">2 · Transform (M)</Tab>
                        <Tab value="run">3 · Run</Tab>
                      </TabList>
                    </div>

                    {ingestTab === 'source' && (
                      <div style={{ marginTop: tokens.spacingVerticalM}}>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Choose a connector. Loom inserts its Power Query <code>Source =</code> step — edit the connection
                          details on the next tab. External connectors reference a server / account you already configured.
                        </Caption1>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM}}>
                          {INGEST_SOURCES.map((src) => (
                            <div key={src.key} className={s.card} style={{ cursor: 'pointer' }} role="button" tabIndex={0}
                              onClick={() => insertSource(src.m)}
                              onKeyDown={(e) => { if (e.key === 'Enter') insertSource(src.m); }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                                <Database20Regular />
                                <span style={{ fontWeight: 600 }}>{src.label}</span>
                              </div>
                              <Caption1 style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>{src.hint}</Caption1>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ingestTab === 'transform' && (
                      <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', minHeight: 420 }}>
                        <PowerQueryHost mScript={ingestMScript} onChange={setIngestMScript} />
                      </div>
                    )}

                    {ingestTab === 'run' && (
                      <div style={{ marginTop: tokens.spacingVerticalM}}>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalL, flexWrap: 'wrap' }}>
                          <Field label="Delta destination (ADLS zone)" style={{ minWidth: 220 }}>
                            <Select value={ingestContainer} onChange={(_, d) => setIngestContainer(d.value as 'bronze' | 'silver' | 'gold')}>
                              <option value="bronze">bronze</option>
                              <option value="silver">silver</option>
                              <option value="gold">gold</option>
                            </Select>
                          </Field>
                          <Field label="AAS table to refresh (optional)" style={{ minWidth: 260 }} hint="Defaults to the output query name. The AAS model's partition source must point at the Delta path.">
                            <Input value={ingestAasTable} onChange={(_, d) => setIngestAasTable(d.value)} placeholder="(output query name)" />
                          </Field>
                        </div>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalL}}>
                          <Button appearance="primary" icon={<Play20Regular />} disabled={ingestRunning} onClick={runIngest}>
                            {ingestRunning ? 'Running ingest…' : 'Run ingest'}
                          </Button>
                          {ingestRunning && <Spinner size="tiny" />}
                        </div>
                        {ingestResult?.ok && (
                          <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM}}>
                            <MessageBarBody>
                              <MessageBarTitle>Ingest dispatched</MessageBarTitle>
                              Delta landing at <code>{ingestResult.deltaPath}</code> — ADF run <code>{ingestResult.adfRunId}</code>
                              {ingestResult.deltaRunId ? <> → Delta run <code>{ingestResult.deltaRunId}</code> ({ingestResult.deltaBackend})</> : null}
                              {ingestResult.aasRefreshId ? <>. AAS refresh <code>{ingestResult.aasRefreshId}</code> queued.</> : '.'}
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        {ingestResult && !ingestResult.ok && (
                          <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                            <MessageBarBody>
                              <MessageBarTitle>Ingest failed</MessageBarTitle>
                              {ingestResult.error}
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        {(ingestResult?.warnings || []).map((w, i) => (
                          <MessageBar key={i} intent="warning" style={{ marginTop: tokens.spacingVerticalS}}>
                            <MessageBarBody>{w}</MessageBarBody>
                          </MessageBar>
                        ))}
                      </div>
                    )}
                  </DialogContent>
                  <DialogActions>
                    {ingestTab !== 'run' && (
                      <Button appearance="primary" onClick={() => setIngestTab(ingestTab === 'source' ? 'transform' : 'run')}>Next</Button>
                    )}
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Close</Button>
                    </DialogTrigger>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
            {refreshErr && <MessageBar intent="error"><MessageBarBody>{refreshErr}</MessageBarBody></MessageBar>}
            {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}
            {!powerBiConfigured && (
              <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM}}>
                <MessageBarBody>
                  <MessageBarTitle>Power BI embed is opt-in</MessageBarTitle>
                  The Console identity isn&rsquo;t registered in Power BI / not in any workspace. This editor shows Loom-native table, relationship, and measure (DAX) metadata. To enable Build model / Refresh / the Power BI Embed tab, register the Console UAMI in your Power BI tenant and add it to a workspace. <a href="https://learn.microsoft.com/power-bi/admin/service-principal-api-considerations" target="_blank" rel="noreferrer">Power BI service principal setup</a>.
                </MessageBarBody>
              </MessageBar>
            )}
            {detail?.dataset && (
              <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'center', flexWrap: 'wrap' }}>
                <Caption1>Owner: <strong>{detail.dataset.configuredBy || '—'}</strong></Caption1>
                <Caption1>Mode: <strong>{detail.dataset.targetStorageMode || '—'}</strong></Caption1>
                {detail.dataset.isRefreshable === false && <Badge appearance="outline" color="warning">not refreshable</Badge>}
              </div>
            )}
          </div>
          {(datasetId || tab === 'build' || tab === 'copilot') && (
            <>
              <div className={s.tabBar}>
                <TabList selectedValue={tab} onTabSelect={(_: unknown, d: any) => setTab(d.value as any)}>
                  <Tab value="tables">Tables ({detail?.tables?.length ?? 0})</Tab>
                  <Tab value="relationships">Relationships ({relationships.length})</Tab>
                  <Tab value="model">Model view</Tab>
                  <Tab value="modeling" icon={<Table20Regular />}>Modeling</Tab>
                  <Tab value="measures">Measures (DAX)</Tab>
                  <Tab value="copilot" icon={<Sparkle20Regular />}>Copilot (structure)</Tab>
                  <Tab value="calcGroups">Calc groups ({calcGroups.length})</Tab>
                  <Tab value="fieldParams">Field parameters ({fieldParams.length})</Tab>
                  <Tab value="build">Build model</Tab>
                  <Tab value="aggregations">Aggregations ({aggAltMaps.length})</Tab>
                  <Tab value="refresh">Refresh history ({refreshes.length})</Tab>
                  {isDqMode && <Tab value="datasource">DirectQuery source</Tab>}
                  <Tab value="incremental">Incremental refresh</Tab>
                  <Tab value="config">Configuration</Tab>
                  <Tab value="security">Security (RLS/OLS)</Tab>
                  <Tab value="direct-lake">Direct Lake (shim)</Tab>
                  <Tab value="governance">Gateway &amp; endorsement</Tab>
                  <Tab value="access">Manage access</Tab>
                  <Tab value="direct-lake-query">Direct Lake query</Tab>
                  {powerBiConfigured && <Tab value="embed">Power BI Embed</Tab>}
                </TabList>
              </div>
              <div className={s.pad}>
                {tab === 'tables' && (
                  <>
                    {modelLoading && <Spinner size="tiny" label="Loading column metadata via XMLA…" style={{ justifyContent: 'flex-start', marginBottom: tokens.spacingVerticalS}} />}
                    {modelGate && (
                      <MessageBar intent={modelGate.missing === 'error' ? 'error' : 'warning'} style={{ marginBottom: tokens.spacingVerticalS}}>
                        <MessageBarBody>
                          <MessageBarTitle>{modelGate.missing === 'error' ? 'Column metadata load failed' : 'Column editor not configured'}</MessageBarTitle>
                          {modelGate.detail}
                          {modelGate.missing !== 'error' && (
                            <> Showing read-only table structure below. Deploy <code>analysis-services.bicep</code> (<code>loomSemanticBackend=analysis-services</code>) and set <code>LOOM_AAS_SERVER_URL</code> to enable data category, format string, summarize-by, display folder, sort-by, hidden, and calculated columns/tables.</>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {modelBackend && (
                      <div style={{ marginBottom: tokens.spacingVerticalS}}>
                        <Badge appearance="tint" color="brand">XMLA backend: {modelBackend === 'analysis-services' ? 'Azure Analysis Services' : 'Power BI Premium XMLA'}</Badge>
                      </div>
                    )}
                    {/* Table selector + add actions */}
                    {(modelTables || detail?.tables) && (
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap', alignItems: 'center', marginBottom: tokens.spacingVerticalM}}>
                        <Field label="Table" style={{ minWidth: 220 }}>
                          <Select value={selectedTableName} onChange={(_, d) => { setSelectedTableName(d.value); setEditCol(null); setColPatch({}); }}>
                            {(modelTables ?? (detail?.tables as any[]) ?? []).map((t: { name: string; isCalculatedTable?: boolean }) => (
                              <option key={t.name} value={t.name}>{t.name}{t.isCalculatedTable ? ' (calc)' : ''}</option>
                            ))}
                          </Select>
                        </Field>
                        <Tooltip relationship="description" content={!modelTables ? 'Configure an Analysis Services XMLA backend (set LOOM_AAS_SERVER_URL) to add calculated columns.' : 'Add a calculated column defined by a DAX expression to the selected table.'}>
                          <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXXL }}
                            onClick={() => { setCalcMsg(null); setCalcColDlgOpen(true); }}
                            disabled={!selectedTableName || !modelTables}>
                            Add calculated column
                          </Button>
                        </Tooltip>
                        <Tooltip relationship="description" content={!modelTables ? 'Configure an Analysis Services XMLA backend (set LOOM_AAS_SERVER_URL) to create calculated tables.' : 'Create a calculated table from a DAX expression (e.g. CALENDAR(...)) and add it to the model.'}>
                          <Button size="small" appearance="outline" icon={<Table20Regular />} style={{ marginTop: tokens.spacingVerticalXXL }}
                            onClick={() => { setCalcMsg(null); setCalcTableDlgOpen(true); }}
                            disabled={!modelTables}>
                            Add calculated table
                          </Button>
                        </Tooltip>
                        <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} style={{ marginTop: tokens.spacingVerticalXXL }}
                          onClick={() => { setModelTables(null); setModelGate(null); loadModel(); }}
                          disabled={!datasetId || modelLoading}>
                          Reload
                        </Button>
                      </div>
                    )}
                    {/* Column grid for the selected table */}
                    {(() => {
                      const tbl: SmTable | undefined =
                        (modelTables?.find((t) => t.name === selectedTableName)) ??
                        (detail?.tables?.find((t) => t.name === selectedTableName) as any);
                      if (!tbl) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No table selected.</Caption1>;
                      const cols: SmColumn[] = (tbl.columns as SmColumn[]) ?? [];
                      return (
                        <div className={s.tableWrap}>
                          <Table aria-label={`Columns of ${tbl.name}`} size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Column</TableHeaderCell>
                              <TableHeaderCell>Type</TableHeaderCell>
                              <TableHeaderCell>Data type</TableHeaderCell>
                              <TableHeaderCell>Category</TableHeaderCell>
                              <TableHeaderCell>Format</TableHeaderCell>
                              <TableHeaderCell>Summarize</TableHeaderCell>
                              <TableHeaderCell>Display folder</TableHeaderCell>
                              <TableHeaderCell>Hidden</TableHeaderCell>
                              {modelTables && <TableHeaderCell>Edit</TableHeaderCell>}
                            </TableRow></TableHeader>
                            <TableBody>
                              {cols.length === 0 && (
                                <TableRow><TableCell>—</TableCell><TableCell /><TableCell /><TableCell /><TableCell /><TableCell /><TableCell /><TableCell />{modelTables && <TableCell />}</TableRow>
                              )}
                              {cols.map((c) => (
                                <TableRow key={c.name} aria-label={c.name}>
                                  <TableCell>
                                    {c.name}
                                    {c.type === 'calculated' && <Badge appearance="outline" size="small" color="brand" style={{ marginLeft: tokens.spacingHorizontalXS}}>calc</Badge>}
                                  </TableCell>
                                  <TableCell>{c.type ?? 'data'}</TableCell>
                                  <TableCell>{c.dataType ?? '—'}</TableCell>
                                  <TableCell>{c.dataCategory || '—'}</TableCell>
                                  <TableCell className={s.cell}>{c.formatString || '—'}</TableCell>
                                  <TableCell>{c.summarizeBy || '—'}</TableCell>
                                  <TableCell>{c.displayFolder || '—'}</TableCell>
                                  <TableCell>{c.isHidden ? 'hidden' : '—'}</TableCell>
                                  {modelTables && (
                                    <TableCell>
                                      <Button size="small" appearance="subtle" icon={<Wrench16Regular />} aria-label={`Edit ${c.name}`}
                                        onClick={() => { setEditCol({ tableName: tbl.name, col: c }); setColPatch({}); setPatchMsg(null); }}>
                                        Edit
                                      </Button>
                                    </TableCell>
                                  )}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })()}
                    {/* Column edit panel — full metadata surface */}
                    {editCol && (
                      <div className={s.card} style={{ marginTop: tokens.spacingVerticalM}}>
                        <Subtitle2>Edit column: {editCol.tableName}[{editCol.col.name}]</Subtitle2>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS}}>
                          <Field label="Data category" style={{ minWidth: 180 }}>
                            <Select value={colPatch.dataCategory ?? editCol.col.dataCategory ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, dataCategory: d.value || undefined }))}>
                              <option value="">— none —</option>
                              {SM_DATA_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </Select>
                          </Field>
                          <Field label="Summarize by" style={{ minWidth: 160 }}>
                            <Select value={colPatch.summarizeBy ?? editCol.col.summarizeBy ?? 'default'}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, summarizeBy: d.value }))}>
                              {SM_SUMMARIZE.map((v) => <option key={v} value={v}>{v}</option>)}
                            </Select>
                          </Field>
                          <Field label={<InfoLabel info="The display format applied to this column's values (TMSL formatString) — e.g. #,0 for integers, 0.00% for percent, or a currency mask. It changes how values render in reports, not the stored data.">Format string</InfoLabel>} style={{ minWidth: 200 }}>
                            <Select value={colPatch.formatString ?? editCol.col.formatString ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, formatString: d.value }))}>
                              {SM_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </Select>
                          </Field>
                          <Field label="Display folder" style={{ minWidth: 200 }}>
                            <Input value={colPatch.displayFolder ?? editCol.col.displayFolder ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, displayFolder: d.value }))}
                              placeholder={'e.g. Geography or Finance\\KPIs'} />
                          </Field>
                          <Field label="Sort by column" style={{ minWidth: 180 }}>
                            <Select value={colPatch.sortByColumn ?? editCol.col.sortByColumn ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, sortByColumn: d.value || undefined }))}>
                              <option value="">— self (default) —</option>
                              {(modelTables?.find((t) => t.name === editCol.tableName)?.columns ?? [])
                                .filter((c) => c.name !== editCol.col.name)
                                .map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                            </Select>
                          </Field>
                          <Field label="Hidden">
                            <Switch checked={colPatch.isHidden ?? editCol.col.isHidden ?? false}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, isHidden: d.checked }))} />
                          </Field>
                        </div>
                        {editCol.col.type === 'calculated' && (
                          <div style={{ marginTop: tokens.spacingVerticalM}}>
                            <Caption1>DAX expression</Caption1>
                            <MonacoTextarea
                              value={colPatch.expression ?? editCol.col.expression ?? ''}
                              onChange={(v) => setColPatch((p) => ({ ...p, expression: v }))}
                              language="sql" height={120} minHeight={80}
                              ariaLabel="Calculated column DAX expression" />
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalM}}>
                          <Button appearance="primary" icon={<Save20Regular />}
                            disabled={patchBusy || Object.keys(colPatch).length === 0}
                            onClick={patchColumn}>
                            {patchBusy ? 'Saving…' : 'Apply'}
                          </Button>
                          <Button appearance="subtle" onClick={() => { setEditCol(null); setColPatch({}); setPatchMsg(null); }}>Cancel</Button>
                        </div>
                        {patchMsg && <MessageBar intent={patchMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{patchMsg.text}</MessageBarBody></MessageBar>}
                      </div>
                    )}
                    {patchMsg && !editCol && <MessageBar intent={patchMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{patchMsg.text}</MessageBarBody></MessageBar>}
                    {/* Read-only measures for the selected table */}
                    {(() => {
                      const tbl: SmTable | undefined =
                        (modelTables?.find((t) => t.name === selectedTableName)) ??
                        (detail?.tables?.find((t) => t.name === selectedTableName) as any);
                      if (!tbl?.measures?.length) return null;
                      return (
                        <div style={{ marginTop: tokens.spacingVerticalM}}>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Measures in {tbl.name} (read-only — edit via the Measures tab)</Caption1>
                          <div className={s.cell}>{tbl.measures.map((m) => m.name).join(', ')}</div>
                        </div>
                      );
                    })()}
                    {/* Composite (per-table storage mode) controls — origin/main integration */}
                    <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalS}}>
                      Set a per-table <strong>storage mode</strong> to build a composite model that mixes
                      Import, DirectQuery, and Dual tables. Apply pushes a <code>model.bim</code> TMSL with a
                      per-partition mode (Fabric updateDefinition), or returns it as an <code>Invoke-ASCmd</code>
                      receipt. <strong>Dual</strong> requires Power BI Premium / Fabric capacity.
                    </Caption1>
                    <div className={s.tableWrap}>
                      <Table aria-label="Tables" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Table</TableHeaderCell>
                          <TableHeaderCell>Columns</TableHeaderCell>
                          <TableHeaderCell>Measures</TableHeaderCell>
                          <TableHeaderCell>Storage mode</TableHeaderCell>
                          <TableHeaderCell>Source query (DQ / Dual)</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {(detail?.tables || []).map((t) => {
                            const mode = tableModes[t.name] ?? 'import';
                            return (
                              <TableRow key={t.name}>
                                <TableCell>{t.name}</TableCell>
                                <TableCell className={s.cell}>{(t.columns || []).map((c) => `${c.name}:${c.dataType || '?'}`).join(', ') || '—'}</TableCell>
                                <TableCell className={s.cell}>{(t.measures || []).map((m) => m.name).join(', ') || '—'}</TableCell>
                                <TableCell>
                                  <Select
                                    size="small"
                                    value={mode}
                                    onChange={(_, d) => setTableModes((prev) => ({ ...prev, [t.name]: d.value as TableStorageMode }))}
                                    aria-label={`Storage mode for ${t.name}`}
                                    title={`Storage mode for ${t.name}. 'dual' requires Power BI Premium / Fabric capacity.`}
                                  >
                                    {TABLE_STORAGE_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                                  </Select>
                                </TableCell>
                                <TableCell>
                                  {mode === 'import' ? (
                                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>
                                  ) : (
                                    <Input
                                      size="small"
                                      value={tableSourceQ[t.name] ?? `SELECT * FROM [${t.name}]`}
                                      onChange={(_, d) => setTableSourceQ((prev) => ({ ...prev, [t.name]: d.value }))}
                                      aria-label={`Source query for ${t.name}`}
                                      style={{ minWidth: 220 }}
                                    />
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalM}}>
                      <Button
                        appearance="primary"
                        icon={<ArrowSync20Regular />}
                        disabled={modesBusy || !datasetId || !powerBiConfigured || (detail?.tables || []).length === 0}
                        onClick={applyModes}
                        title={!powerBiConfigured ? 'Power BI / Fabric not configured' : 'Build the composite TMSL with the selected per-table modes and apply via Fabric updateDefinition (or generate the Invoke-ASCmd receipt), then probe the live model'}
                      >
                        {modesBusy ? 'Applying…' : 'Apply storage modes'}
                      </Button>
                      {!powerBiConfigured && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Power BI / Fabric not configured — storage modes build TMSL only (no live apply).
                        </Caption1>
                      )}
                    </div>
                    {modesMsg && (
                      <MessageBar intent={modesMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody>{modesMsg.text}</MessageBarBody>
                      </MessageBar>
                    )}
                    {tmslReceipt && (
                      <details style={{ marginTop: tokens.spacingVerticalS}}>
                        <summary style={{ cursor: 'pointer' }}>
                          <Caption1>TMSL receipt (apply offline: <code>Invoke-ASCmd -Server &quot;asazure://…&quot; -Query &lt;tmsl&gt;</code>)</Caption1>
                        </summary>
                        <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: tokens.fontSizeBase100, fontFamily: 'Consolas, monospace', background: tokens.colorNeutralBackground2, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, marginTop: tokens.spacingVerticalXS, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%'}}>
                          {tmslReceipt.slice(0, 4000)}
                        </pre>
                      </details>
                    )}
                  </>
                )}
                {tab === 'relationships' && (
                  <>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Table relationships from <code>GET /datasets/{'{'}id{'}'}/relationships</code> (Power BI REST). Editing relationships
                      on an imported model requires XMLA / Desktop; push datasets accept relationships at create time via the <strong>Build model</strong> tab.
                    </Caption1>
                    {relationships.length === 0 ? (
                      <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>No relationships returned for this model.</Caption1>
                    ) : (
                      <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
                        <Table aria-label="Relationships" size="small">
                          <TableHeader><TableRow>
                            <TableHeaderCell>Name</TableHeaderCell>
                            <TableHeaderCell>From</TableHeaderCell>
                            <TableHeaderCell>To</TableHeaderCell>
                            <TableHeaderCell>Cross-filter</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {relationships.map((r, i) => (
                              <TableRow key={r.name || i}>
                                <TableCell>{r.name || '—'}</TableCell>
                                <TableCell className={s.cell}>{r.fromTable}[{r.fromColumn}]</TableCell>
                                <TableCell className={s.cell}>{r.toTable}[{r.toColumn}]</TableCell>
                                <TableCell>{r.crossFilteringBehavior || '—'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </>
                )}
                {tab === 'model' && (
                  <PbiModelViewPanel
                    workspaceId={workspaceId || undefined}
                    datasetId={datasetId}
                  />
                )}
                {tab === 'modeling' && (
                  modelingSlice === null ? (
                    <Spinner size="small" label="Loading modeling…" labelPosition="after" style={{ marginTop: tokens.spacingVerticalL }} />
                  ) : (
                    <ModelTabsExtra
                      item={{
                        id,
                        workspaceId,
                        itemType: 'semantic-model',
                        displayName: item.displayName,
                        createdBy: '',
                        createdAt: '',
                        updatedAt: '',
                        state: { model: modelingSlice },
                      }}
                      id={id}
                      datasetId={datasetId}
                      tables={modelTables ?? detail?.tables}
                      measures={detail?.tables?.flatMap((t) => t.measures ?? [])}
                      onModelChanged={() => { void loadModelingSlice(); }}
                    />
                  )
                )}
                {tab === 'build' && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Build a semantic model (push dataset)</MessageBarTitle>
                        Define tables, typed columns, DAX measures, and relationships, then <strong>Create model</strong> —
                        this calls the Power BI <code>POST /groups/{'{'}ws{'}'}/datasets</code> push-dataset REST API to author a
                        real semantic model. Imported / Direct Lake model edits still require the XMLA endpoint
                        (<code>LOOM_POWERBI_XMLA_ENDPOINT</code>) or Power BI Desktop.
                      </MessageBarBody>
                    </MessageBar>
                    <Field label="Model name" required style={{ maxWidth: 420, marginTop: tokens.spacingVerticalS}}>
                      <Input value={bModelName} onChange={(_, d) => setBModelName(d.value)} placeholder="My semantic model" />
                    </Field>
                    {bTables.map((t, ti) => (
                      <div key={ti} className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                          <Field label="Table" style={{ minWidth: 220 }}>
                            <Input value={t.name} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, name: d.value } : x))} />
                          </Field>
                          <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove table"
                            onClick={() => setBTables((p) => p.filter((_, i) => i !== ti))} style={{ marginTop: tokens.spacingVerticalXXL }} />
                        </div>
                        <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>Columns</Caption1>
                        {t.columns.map((c, ci) => (
                          <div key={ci} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS}}>
                            <Input value={c.name} placeholder="column" onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.map((y, j) => j === ci ? { ...y, name: d.value } : y) } : x))} />
                            <Select value={c.dataType} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.map((y, j) => j === ci ? { ...y, dataType: d.value as BuilderColumn['dataType'] } : y) } : x))}>
                              {PBI_COL_TYPES.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                            </Select>
                            <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove column"
                              onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.filter((_, j) => j !== ci) } : x))} />
                          </div>
                        ))}
                        <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXS}}
                          onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: [...x.columns, { name: '', dataType: 'String' }] } : x))}>Add column</Button>
                        <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>Measures (DAX)</Caption1>
                        {t.measures.map((m, mi) => (
                          <div key={mi} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS}}>
                            <Input value={m.name} placeholder="MeasureName" onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.map((y, j) => j === mi ? { ...y, name: d.value } : y) } : x))} />
                            <Input value={m.expression} placeholder="SUM(Sales[Amount])" style={{ flex: 1, fontFamily: 'Consolas, monospace' }} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.map((y, j) => j === mi ? { ...y, expression: d.value } : y) } : x))} />
                            <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove measure"
                              onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.filter((_, j) => j !== mi) } : x))} />
                          </div>
                        ))}
                        <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXS}}
                          onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: [...x.measures, { name: '', expression: '' }] } : x))}>Add measure</Button>
                      </div>
                    ))}
                    <Button appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalS}}
                      onClick={() => setBTables((p) => [...p, { name: `Table${p.length + 1}`, columns: [{ name: 'Id', dataType: 'Int64' }], measures: [] }])}>Add table</Button>

                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalL}}>Relationships</Subtitle2>
                    {bRels.map((rl, ri) => (
                      <div key={ri} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
                        <Input value={rl.fromTable} placeholder="fromTable" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, fromTable: d.value } : x))} style={{ width: 140 }} />
                        <Input value={rl.fromColumn} placeholder="fromColumn" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, fromColumn: d.value } : x))} style={{ width: 140 }} />
                        <ArrowSync20Regular />
                        <Input value={rl.toTable} placeholder="toTable" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, toTable: d.value } : x))} style={{ width: 140 }} />
                        <Input value={rl.toColumn} placeholder="toColumn" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, toColumn: d.value } : x))} style={{ width: 140 }} />
                        <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove relationship" onClick={() => setBRels((p) => p.filter((_, i) => i !== ri))} />
                      </div>
                    ))}
                    <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXS}}
                      onClick={() => setBRels((p) => [...p, { name: `rel-${p.length + 1}`, fromTable: '', fromColumn: '', toTable: '', toColumn: '', crossFilteringBehavior: 'OneDirection' }])}>Add relationship</Button>

                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalL}}>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={bBusy || !workspaceId || !bModelName.trim()} onClick={buildModel}>
                        {bBusy ? 'Creating…' : 'Create model'}
                      </Button>
                      {!workspaceId && <Caption1>Select a workspace first.</Caption1>}
                    </div>
                    {bMsg && <MessageBar intent={bMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{bMsg.text}</MessageBarBody></MessageBar>}
                  </>
                )}
                {tab === 'measures' && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>DAX measure editor</MessageBarTitle>
                        <strong>Validate</strong> runs the expression server-side via Power BI <code>executeQueries</code> — the engine returns its real syntax + semantic errors, not a mock.{' '}
                        <strong>Save to model</strong> persists the measure (with its format string + display folder) via TMSL <code>createOrReplace</code> over the XMLA endpoint, then evaluates it so the result reflects a real computed value.{' '}
                        Save requires <code>LOOM_SEMANTIC_BACKEND=analysis-services</code> plus <code>LOOM_AAS_SERVER</code> / <code>LOOM_AAS_DATABASE</code>.{' '}
                        For Power BI Premium XMLA, use Power BI Desktop or Tabular Editor — that endpoint speaks the analysis-services protocol over <code>powerbi://</code>, not plain HTTP.
                        {xmlaPersistence === false && <> {' '}<Badge appearance="tint" color="warning">XMLA persistence not wired</Badge></>}
                        {xmlaPersistence === true && <> {' '}<Badge appearance="tint" color="success">XMLA persistence ready</Badge></>}
                      </MessageBarBody>
                    </MessageBar>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS}}>
                      <Field label="Table" style={{ minWidth: 200 }}>
                        <Select value={measureTable} onChange={(_, d) => setMeasureTable(d.value)}>
                          <option value="">(select a table)</option>
                          {(detail?.tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                        </Select>
                      </Field>
                      <Field label="Measure name" style={{ minWidth: 200 }}>
                        <Input value={measureName} onChange={(_, d) => setMeasureName(d.value)} placeholder="TotalSales" />
                      </Field>
                      <Field label={<InfoLabel info="The display format for this measure's result (TMSL formatString). Controls how the number renders in reports — currency, percent, thousands separators — without changing the underlying value.">Format string</InfoLabel>} hint="TMSL formatString — e.g. $#,0.00 currency, 0.00% percent, #,0 integer" style={{ minWidth: 200 }}>
                        <Input value={formatString} onChange={(_, d) => setFormatString(d.value)} placeholder="$#,0.00;($#,0.00);$#,0.00" />
                      </Field>
                      <Field label="Display folder" hint="Organizes the measure in reporting tools (backslash-separated)" style={{ minWidth: 200 }}>
                        <Input value={displayFolder} onChange={(_, d) => setDisplayFolder(d.value)} placeholder={'Finance\\KPIs'} />
                      </Field>
                    </div>
                    <Field
                      label="DAX expression"
                      hint="e.g. CALCULATE(SUM('Sales'[Amount]), ALL('Date')). Validate before saving."
                      style={{ marginTop: tokens.spacingVerticalS}}
                    >
                      <MonacoTextarea
                        value={daxExpr}
                        onChange={setDaxExpr}
                        language="dax"
                        height={140}
                        minHeight={100}
                        ariaLabel="DAX expression editor"
                      />
                    </Field>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalS}}>
                      <Button
                        appearance="primary"
                        icon={<Play20Regular />}
                        disabled={daxBusy || !workspaceId || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()}
                        onClick={validateDax}
                        title={!workspaceId ? 'Validate uses the Power BI executeQueries REST endpoint — select a Power BI workspace first' : undefined}
                      >
                        {daxBusy ? 'Validating…' : 'Validate DAX'}
                      </Button>
                      <Button
                        appearance="outline"
                        icon={<Save20Regular />}
                        disabled={saveBusy || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()}
                        onClick={saveMeasure}
                        title="Persist this measure (DAX + format string + display folder) via TMSL createOrReplace to Azure Analysis Services (requires LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER)"
                      >
                        {saveBusy ? 'Saving…' : 'Save to model (XMLA)'}
                      </Button>
                      {daxResult?.ok && (
                        <Badge appearance="filled" color="success">valid · probe value: <code style={{ marginLeft: tokens.spacingHorizontalXS}}>{daxResult.value === null || daxResult.value === undefined ? 'NULL' : String(daxResult.value)}</code></Badge>
                      )}
                    </div>
                    {daxResult && !daxResult.ok && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody>
                          <MessageBarTitle>DAX validation failed</MessageBarTitle>
                          {daxResult.error}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {saveResult && (
                      <MessageBar intent={saveResult.ok ? 'success' : 'warning'} style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody>
                          <MessageBarTitle>{saveResult.ok ? 'Saved to model' : 'Not persisted'}</MessageBarTitle>
                          {saveResult.text}
                          {saveResult.remediation && <> {saveResult.remediation}</>}
                          {saveResult.link && <> <a href={saveResult.link} target="_blank" rel="noreferrer">Learn more</a>.</>}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* DAX Copilot — Loom-native NL2DAX / explain / optimize / describe.
                        Synapse-backed; no Power BI on this path. */}
                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalXL }}>DAX Copilot</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Generate, explain, or optimize DAX against this Loom-native model. Grounded on the model
                      schema and evaluated via Synapse — no Power BI workspace required. A generated measure
                      auto-inserts into the editor above.
                    </Caption1>
                    <div className={s.assistBar} style={{ marginTop: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` }}>
                      <Sparkle16Regular />
                      <Input
                        value={daxCopilotPrompt}
                        onChange={(_, d) => setDaxCopilotPrompt(d.value)}
                        placeholder="Ask DAX Copilot (e.g. 'create a YoY revenue measure', 'explain this', 'make it faster')"
                        style={{ flex: 1 }}
                        disabled={daxCopilotBusy}
                        onKeyDown={(e) => { if (e.key === 'Enter') askDaxCopilot(); }}
                      />
                      <Button
                        size="small"
                        appearance="primary"
                        icon={daxCopilotBusy ? <Spinner size="tiny" /> : <Sparkle16Regular />}
                        disabled={daxCopilotBusy || !daxCopilotPrompt.trim()}
                        onClick={askDaxCopilot}
                      >
                        {daxCopilotBusy ? 'Working…' : 'Ask'}
                      </Button>
                    </div>
                    {daxCopilotErr && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody><MessageBarTitle>DAX Copilot</MessageBarTitle>{daxCopilotErr}</MessageBarBody>
                      </MessageBar>
                    )}
                    {daxCopilotResult && (
                      <div className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                        <pre className={s.assistResult}>{daxCopilotResult}</pre>
                      </div>
                    )}

                    {/* Bulk AI auto-description — generate descriptions for ALL
                        tables/columns/measures in one pass (Fabric Build 2026 #36).
                        Azure-native (AOAI); persists to the Loom-native model. */}
                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalXL }}>AI auto-description (bulk)</Subtitle2>
                    <div style={{ marginTop: tokens.spacingVerticalS}}>
                      <BulkDescribeAction modelId={id} />
                    </div>

                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalL}}>Existing measures</Subtitle2>
                    {(detail?.tables || []).flatMap((t) => (t.measures || []).map((m) => (
                      <div key={`${t.name}-${m.name}`} className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                        <Caption1>{t.name}</Caption1>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <pre style={{ margin: tokens.spacingVerticalNone, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' }}>{m.expression || '—'}</pre>
                      </div>
                    )))}
                    {((detail?.tables || []).flatMap((t) => t.measures || []).length === 0) && (
                      <Caption1>No DAX measures returned (or the dataset hasn't exposed its model definition).</Caption1>
                    )}
                  </>
                )}
                {tab === 'aggregations' && (
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
                    {detail?.dataset?.targetStorageMode === 'Push' && (
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
                          <Button size="small" appearance="outline" onClick={seedAltMapsFromTable} disabled={!detail?.tables?.length} title="seed starter mappings from the first table's columns (editable)">Seed from first table</Button>
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
                                      {(detail?.tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
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
                          disabled={aggBusy || !datasetId || !aggTableName.trim() || !aggPartitionExpr.trim() || aggAltMaps.length === 0 || detail?.dataset?.targetStorageMode === 'Push'}>
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
                )}
                {tab === 'refresh' && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Refreshes" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Request ID</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>End</TableHeaderCell>
                        <TableHeaderCell>Error</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {refreshes.length === 0 && <TableRow><TableCell colSpan={6}>No refresh history.</TableCell></TableRow>}
                        {refreshes.map((r, i) => (
                          <TableRow key={r.requestId || i}>
                            <TableCell className={s.cell}>{r.requestId?.slice(0, 8) || '—'}</TableCell>
                            <TableCell>{r.refreshType || '—'}</TableCell>
                            <TableCell>{r.status || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.startTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.endTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.serviceExceptionJson || ''}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {tab === 'incremental' && (
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
                          {(detail?.tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
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
                )}
                {tab === 'config' && (
                  <>
                    <Subtitle2>Scheduled refresh</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Mirrors the Power BI service Scheduled refresh pane. Writes via PATCH /datasets/{'{'}id{'}'}/refreshSchedule.
                    </Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, maxWidth: 560 }}>
                      <Switch label="Keep your data up to date (enable scheduled refresh)" checked={schedEnabled} onChange={(_, d) => setSchedEnabled(d.checked)} />
                      <div>
                        <Caption1>Refresh days</Caption1>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS}}>
                          {DAYS.map((day) => (
                            <Button key={day} size="small" appearance={schedDays.includes(day) ? 'primary' : 'outline'} onClick={() => toggleSchedDay(day)}>{day.slice(0, 3)}</Button>
                          ))}
                        </div>
                      </div>
                      <Field label={<InfoLabel info="Clock times when Power BI runs the scheduled dataset refresh, in the time zone below. Power BI only accepts times on the hour or half-hour (minutes :00 or :30). Separate multiple times with commas.">Time(s) — HH:MM on :00 or :30, comma-separated</InfoLabel>}>
                        <Input value={schedTimes} onChange={(_, d) => setSchedTimes(d.value)} placeholder="07:00, 12:30" />
                      </Field>
                      <Field label="Time zone (PBI id)">
                        <Input value={schedTz} onChange={(_, d) => setSchedTz(d.value)} placeholder="UTC" />
                      </Field>
                      <Field label="On failure">
                        <Select value={schedNotify} onChange={(_, d) => setSchedNotify(d.value as 'MailOnFailure' | 'NoNotification')}>
                          <option value="NoNotification">No notification</option>
                          <option value="MailOnFailure">Email the dataset owner on failure</option>
                        </Select>
                      </Field>
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                        <Button appearance="primary" icon={<Save20Regular />} disabled={schedBusy} onClick={saveSchedule}>{schedBusy ? 'Saving…' : 'Apply'}</Button>
                        <Button appearance="outline" disabled={takeoverBusy} onClick={takeOver} title="Take ownership of the dataset (needed if you are not the owner) before editing the schedule">{takeoverBusy ? 'Taking over…' : 'Take over dataset'}</Button>
                      </div>
                      {schedMsg && <MessageBar intent={schedMsg.ok ? 'success' : 'error'}><MessageBarBody>{schedMsg.text}</MessageBarBody></MessageBar>}
                    </div>

                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalXL }}>Row-level &amp; object-level security</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      RLS role filters and OLS table/column permissions are authored on the dedicated <strong>Security (RLS/OLS)</strong> tab, which deploys real TMSL roles through the Analysis-Services XMLA endpoint and includes a Test-as-role probe.
                    </Caption1>
                  </>
                )}
                {tab === 'security' && datasetId && (
                  <SemanticModelSecurityTab
                    s={s}
                    tables={detail?.tables || []}
                    roles={secRoles}
                    busy={secBusy}
                    saving={secSaving}
                    err={secErr}
                    gate={secGate}
                    saveMsg={secSaveMsg}
                    selectedRole={secSelectedRole}
                    olsTable={secOlsTable}
                    testUpn={testRoleUpn}
                    testQuery={testQuery}
                    testBusy={testBusy}
                    testResult={testResult}
                    testErr={testErr}
                    onReload={() => loadRoles(datasetId, workspaceId)}
                    onAddRole={() => {
                      const base = 'NewRole';
                      const existing = new Set((secRoles || []).map((r) => r.name));
                      let name = base; let i = 1;
                      while (existing.has(name)) { name = `${base}${i++}`; }
                      setSecRoles([...(secRoles || []), { name, modelPermission: 'read', tablePermissions: [], members: [] }]);
                      setSecSelectedRole(name);
                    }}
                    onDeleteRole={(name) => {
                      setSecRoles((secRoles || []).filter((r) => r.name !== name));
                      if (secSelectedRole === name) setSecSelectedRole('');
                    }}
                    onRenameRole={(oldName, newName) => updateRole(oldName, (r) => ({ ...r, name: newName }))}
                    onSelectRole={setSecSelectedRole}
                    onSetFilter={(roleName, table, expr) => updateRole(roleName, (r) => {
                      const tps = [...r.tablePermissions];
                      const idx = tps.findIndex((tp) => tp.name === table);
                      if (idx >= 0) tps[idx] = { ...tps[idx], filterExpression: expr };
                      else tps.push({ name: table, filterExpression: expr, metadataPermission: 'read' });
                      return { ...r, tablePermissions: tps };
                    })}
                    onSetTableOls={(roleName, table, perm) => updateRole(roleName, (r) => {
                      const tps = [...r.tablePermissions];
                      const idx = tps.findIndex((tp) => tp.name === table);
                      if (idx >= 0) tps[idx] = { ...tps[idx], metadataPermission: perm };
                      else tps.push({ name: table, metadataPermission: perm });
                      return { ...r, tablePermissions: tps };
                    })}
                    onSetColumnOls={(roleName, table, column, perm) => updateRole(roleName, (r) => {
                      const tps = [...r.tablePermissions];
                      let idx = tps.findIndex((tp) => tp.name === table);
                      if (idx < 0) { tps.push({ name: table, metadataPermission: 'read', columnPermissions: [] }); idx = tps.length - 1; }
                      const cols = [...(tps[idx].columnPermissions || [])];
                      const cidx = cols.findIndex((c) => c.name === column);
                      if (cidx >= 0) cols[cidx] = { name: column, metadataPermission: perm };
                      else cols.push({ name: column, metadataPermission: perm });
                      tps[idx] = { ...tps[idx], columnPermissions: cols };
                      return { ...r, tablePermissions: tps };
                    })}
                    onSetMembers={(roleName, members) => updateRole(roleName, (r) => ({ ...r, members: members.map((m) => ({ memberName: m })) }))}
                    onChangeOlsTable={setSecOlsTable}
                    onSave={saveRoles}
                    onTestUpn={setTestRoleUpn}
                    onTestQuery={setTestQuery}
                    onRunTest={runTestRole}
                  />
                )}
                {tab === 'direct-lake' && (
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
                          <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={dlLoading || !datasetId} onClick={() => loadDirectLake(datasetId, workspaceId)}>
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
                )}
                {tab === 'datasource' && isDqMode && datasetId && (
                  <DqSourcePanel datasetId={datasetId} itemId={id} workspaceId={workspaceId} />
                )}
                {tab === 'governance' && datasetId && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL }}>
                    {/* F17 — read-only sensitivity label inherited from the model's
                        upstream lineage source (warehouse / lakehouse it's built on). */}
                    <UpstreamSensitivityField itemId={id} />
                    <EndorsementControl workspaceId={workspaceId} itemId={datasetId} itemType="datasets" />
                    <GatewayDatasourcesPanel workspaceId={workspaceId} datasetId={datasetId} />
                  </div>
                )}
                {tab === 'access' && (
                  <ManageAccessPanel workspaceId={workspaceId} />
                )}
                {tab === 'embed' && powerBiConfigured && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Power BI embedding for semantic models</MessageBarTitle>
                      Browse the model metadata and author DAX in the Tables, Relationships, and Measures tabs above. Power BI live-query / external-tool embedding is configured here when a workspace is bound.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {tab === 'copilot' && <SemanticModelCopilotPane id={id} />}
                {tab === 'calcGroups' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Calculation groups</MessageBarTitle>
                        Author calculation items with <code>SELECTEDMEASURE()</code>. Each group becomes a slicer; selecting an item changes how the visual&rsquo;s measure is aggregated (YTD, MTD, prior year, % of total&hellip;). Saved to this model and emitted in TMSL at provision time on the Loom-native default; set <code>LOOM_SEMANTIC_BACKEND=aas</code> or <code>=fabric</code> to push to a live model.{' '}
                        <a href="https://learn.microsoft.com/analysis-services/tabular-models/calculation-groups" target="_blank" rel="noreferrer">Docs</a>
                      </MessageBarBody>
                    </MessageBar>
                    {calcGroups.map((cg, gi) => (
                      <div key={gi} className={s.card}>
                        <div className={s.toolbar}>
                          <Field label="Group name" style={{ minWidth: 220 }}>
                            <Input value={cg.name} placeholder="Time Intelligence"
                              onChange={(_, d) => setCalcGroups((prev) => prev.map((g, i) => i === gi ? { ...g, name: d.value } : g))} />
                          </Field>
                          <Field label="Precedence">
                            <SpinButton value={cg.precedence} min={0} max={9999}
                              onChange={(_, d) => setCalcGroups((prev) => prev.map((g, i) => i === gi ? { ...g, precedence: Number(d.value ?? d.displayValue ?? 0) || 0 } : g))} />
                          </Field>
                          <Button appearance="subtle" icon={<Delete20Regular />} title="Remove group"
                            onClick={() => setCalcGroups((prev) => prev.filter((_, i) => i !== gi))} />
                        </div>
                        {cg.items.map((ci, ii) => (
                          <div key={ii} className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                            <div className={s.toolbar}>
                              <Field label="Item name" style={{ minWidth: 180 }}>
                                <Input value={ci.name} placeholder="YTD"
                                  onChange={(_, d) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, name: d.value } : it) }))} />
                              </Field>
                              <Field label="Ordinal">
                                <SpinButton value={ci.ordinal ?? -1} min={-1} max={999}
                                  onChange={(_, d) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, ordinal: Number(d.value ?? d.displayValue ?? -1) } : it) }))} />
                              </Field>
                              <Button appearance="subtle" icon={<Delete20Regular />} title="Remove item"
                                onClick={() => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.filter((_, j) => j !== ii) }))} />
                            </div>
                            <Caption1>DAX expression — use <code>SELECTEDMEASURE()</code></Caption1>
                            <MonacoTextarea value={ci.expression} language="sql" height={80} minHeight={60} ariaLabel="Calculation item DAX"
                              onChange={(v) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, expression: v } : it) }))} />
                            <Caption1 style={{ marginTop: tokens.spacingVerticalXS}}>Dynamic format string (optional DAX — e.g. <code>SELECTEDMEASUREFORMATSTRING()</code>)</Caption1>
                            <MonacoTextarea value={ci.formatStringDefinition || ''} language="sql" height={50} minHeight={40} ariaLabel="Format string DAX"
                              onChange={(v) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, formatStringDefinition: v || undefined } : it) }))} />
                          </div>
                        ))}
                        <Button size="small" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}
                          onClick={() => setCalcGroups((prev) => prev.map((g, i) => i !== gi ? g : { ...g, items: [...g.items, { name: 'New item', expression: 'SELECTEDMEASURE()' }] }))}>Add item</Button>
                      </div>
                    ))}
                    <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM}}>
                      <Button icon={<Add20Regular />}
                        onClick={() => setCalcGroups((prev) => [...prev, { name: 'New group', precedence: 10, items: [{ name: 'Current', expression: 'SELECTEDMEASURE()' }] }])}>Add group</Button>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={cgBusy || calcGroups.length === 0 || !datasetId}
                        onClick={saveCalcGroups}>{cgBusy ? 'Saving…' : 'Save calc groups'}</Button>
                    </div>
                    {cgMsg && <MessageBar intent={cgMsg.ok ? 'success' : 'error'}><MessageBarBody>{cgMsg.text}</MessageBarBody></MessageBar>}
                  </div>
                )}
                {tab === 'fieldParams' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Field parameters</MessageBarTitle>
                        Build a <code>NAMEOF()</code> calculated table that lets report readers swap the measure or dimension a visual shows via a slicer. Pick the fields below; the generated DAX is shown live. Saved to this model and emitted in TMSL at provision time on the Loom-native default.{' '}
                        <a href="https://learn.microsoft.com/power-bi/create-reports/power-bi-field-parameters" target="_blank" rel="noreferrer">Docs</a>
                      </MessageBarBody>
                    </MessageBar>
                    {fieldParams.map((fp, fi) => (
                      <div key={fi} className={s.card}>
                        <div className={s.toolbar}>
                          <Field label="Parameter name" style={{ minWidth: 220 }}>
                            <Input value={fp.name} placeholder="Metric Selector"
                              onChange={(_, d) => setFieldParams((prev) => prev.map((p, i) => i === fi ? { ...p, name: d.value } : p))} />
                          </Field>
                          <Button appearance="subtle" icon={<Delete20Regular />} title="Remove parameter"
                            onClick={() => setFieldParams((prev) => prev.filter((_, i) => i !== fi))} />
                        </div>
                        {fp.fields.map((f, fj) => (
                          <div key={fj} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                            <Field label="Display name" style={{ minWidth: 160 }}>
                              <Input value={f.displayName} placeholder="Total Sales"
                                onChange={(_, d) => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.map((ff, j) => j === fj ? { ...ff, displayName: d.value } : ff) }))} />
                            </Field>
                            <Field label="NAMEOF reference" style={{ flex: 1, minWidth: 200 }}>
                              <Input value={f.fieldRef} placeholder="'Sales'[Amount]"
                                onChange={(_, d) => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.map((ff, j) => j === fj ? { ...ff, fieldRef: d.value } : ff) }))} />
                            </Field>
                            <Field label="Order">
                              <SpinButton value={f.order} min={0} max={999}
                                onChange={(_, d) => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.map((ff, j) => j === fj ? { ...ff, order: Number(d.value ?? d.displayValue ?? 0) || 0 } : ff) }))} />
                            </Field>
                            <Button appearance="subtle" icon={<Delete20Regular />} title="Remove field"
                              onClick={() => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.filter((_, j) => j !== fj) }))} />
                          </div>
                        ))}
                        <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>Generated DAX</Caption1>
                        <pre className={s.assistResult} style={{ marginTop: tokens.spacingVerticalXS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, whiteSpace: 'pre-wrap' }}>
{`${fp.name} = {\n${fp.fields.map((f, i) => `\t("${f.displayName}", NAMEOF(${f.fieldRef}), ${typeof f.order === 'number' ? f.order : i})`).join(',\n')}\n}`}
                        </pre>
                        <Button size="small" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}
                          onClick={() => setFieldParams((prev) => prev.map((p, i) => i !== fi ? p : { ...p, fields: [...p.fields, { displayName: 'New field', fieldRef: "'Table'[Column]", order: p.fields.length }] }))}>Add field</Button>
                      </div>
                    ))}
                    <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM}}>
                      <Button icon={<Add20Regular />}
                        onClick={() => setFieldParams((prev) => [...prev, { name: 'New Parameter', fields: [{ displayName: 'Field 1', fieldRef: "'Table'[Column]", order: 0 }] }])}>Add parameter</Button>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={fpBusy || fieldParams.length === 0 || !datasetId}
                        onClick={saveFieldParams}>{fpBusy ? 'Saving…' : 'Save field parameters'}</Button>
                    </div>
                    {fpMsg && <MessageBar intent={fpMsg.ok ? 'success' : 'error'}><MessageBarBody>{fpMsg.text}</MessageBarBody></MessageBar>}
                  </div>
                )}

                {tab === 'direct-lake-query' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Direct Lake query with transparent Serverless fallback</MessageBarTitle>
                        When the warm cache (last model refresh) is within{' '}
                        <code>LOOM_DL_CACHE_TTL_SECONDS</code>, rows are served from the Power BI
                        in-memory VertiPaq cache. When stale or unbuilt, the same Gold Delta files
                        are queried transparently via Synapse Serverless <code>OPENROWSET</code> —
                        the Azure-native analog of Fabric Direct Lake on SQL DirectQuery fallback.
                        No Fabric capacity required.
                      </MessageBarBody>
                    </MessageBar>

                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                        <Label htmlFor="dl-table-picker">Table</Label>
                        {(detail?.tables && detail.tables.length > 0) ? (
                          <Dropdown
                            id="dl-table-picker"
                            placeholder="Select table"
                            value={dlTable}
                            selectedOptions={dlTable ? [dlTable] : []}
                            onOptionSelect={(_, d) => setDlTable((d.optionValue as string) || '')}
                            style={{ minWidth: 200 }}
                          >
                            {detail.tables.map((t) => (
                              <Option key={t.name} value={t.name}>{t.name}</Option>
                            ))}
                          </Dropdown>
                        ) : (
                          <Input
                            id="dl-table-picker"
                            placeholder="Gold Delta table name (e.g. fact_sales)"
                            value={dlTable}
                            onChange={(_, d) => setDlTable(d.value)}
                            style={{ minWidth: 240 }}
                          />
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                        <Label htmlFor="dl-max-rows">Max rows</Label>
                        <Input
                          id="dl-max-rows"
                          type="number"
                          value={String(dlMaxRows)}
                          onChange={(_, d) => setDlMaxRows(Math.min(5000, Math.max(1, parseInt(d.value, 10) || 1000)))}
                          style={{ width: 100 }}
                        />
                      </div>
                      <Button
                        appearance="primary"
                        icon={<Play20Regular />}
                        disabled={!dlTable || dlqLoading}
                        onClick={executeDlQuery}
                      >
                        Run
                      </Button>
                    </div>

                    {dlqLoading && <Spinner size="small" label="Querying…" labelPosition="after" />}

                    {dlResult && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' }}>
                          {dlResult.servingFrom === 'warm-cache' && (
                            <Badge appearance="filled" color="success">Serving from: warm cache</Badge>
                          )}
                          {dlResult.servingFrom === 'serverless-fallback' && (
                            <Badge appearance="filled" color="warning">Serving from: fallback (Serverless)</Badge>
                          )}
                          {dlResult.executionMs !== undefined && (
                            <Caption1>{dlResult.executionMs} ms</Caption1>
                          )}
                          {dlResult.rowCount !== undefined && (
                            <Badge appearance="outline">{dlResult.rowCount} rows</Badge>
                          )}
                          {dlResult.truncated && <Badge color="warning">Truncated</Badge>}
                        </div>

                        {dlResult.servingFrom === 'serverless-fallback' && dlResult.endpoint && (
                          <Caption1>
                            Serverless endpoint: <code>{dlResult.endpoint}</code>
                            {dlResult.deltaPath && <> · Delta path: <code>{dlResult.deltaPath}</code></>}
                          </Caption1>
                        )}
                        {dlResult.lastRefreshedAt && (
                          <Caption1>
                            Last successful model refresh: {new Date(dlResult.lastRefreshedAt).toLocaleString()}
                            {dlResult.cacheTtlSeconds !== undefined && <> (TTL {dlResult.cacheTtlSeconds}s)</>}
                          </Caption1>
                        )}

                        {!dlResult.ok && (
                          <MessageBar intent="error">
                            <MessageBarBody>
                              <MessageBarTitle>Query failed</MessageBarTitle>
                              {dlResult.error}
                            </MessageBarBody>
                          </MessageBar>
                        )}

                        {dlResult.ok && dlResult.columns && dlResult.rows && (
                          <div style={{ overflowX: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: tokens.fontSizeBase200}}>
                              <thead>
                                <tr>
                                  {dlResult.columns.map((c) => (
                                    <th key={c} style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, background: tokens.colorNeutralBackground2, textAlign: 'left', fontWeight: 600, position: 'sticky', top: 0 }}>{c}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {dlResult.rows.slice(0, 200).map((row, ri) => (
                                  <tr key={ri}>
                                    {(row as unknown[]).map((cell, ci) => (
                                      <td key={ci} style={{ padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`, borderBottom: `1px solid ${tokens.colorNeutralStroke3}` }}>
                                        {cell === null || cell === undefined ? <em style={{ opacity: 0.5 }}>null</em> : String(cell)}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      }
    />
    {/* Add calculated column (DAX) dialog */}
    <Dialog open={calcColDlgOpen} onOpenChange={(_, d) => { setCalcColDlgOpen(d.open); if (!d.open) setCalcMsg(null); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add calculated column — {selectedTableName}</DialogTitle>
          <DialogContent>
            <Field label="Column name" required>
              <Input value={calcColName} onChange={(_, d) => setCalcColName(d.value)} placeholder="Margin" />
            </Field>
            <Field label="Data type" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={calcColType} onChange={(_, d) => setCalcColType(d.value)}>
                {SM_DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Data category" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={calcColCat} onChange={(_, d) => setCalcColCat(d.value)}>
                <option value="">— none —</option>
                {SM_DATA_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Display folder" style={{ marginTop: tokens.spacingVerticalS}}>
              <Input value={calcColFolder} onChange={(_, d) => setCalcColFolder(d.value)} placeholder="e.g. Finance" />
            </Field>
            <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>DAX expression</Caption1>
            <MonacoTextarea value={calcColExpr} onChange={setCalcColExpr} language="sql" height={120} minHeight={80} ariaLabel="Calculated column DAX" />
            {calcMsg && <MessageBar intent={calcMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{calcMsg.text}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={calcBusy || !calcColName.trim() || !calcColExpr.trim()} onClick={addCalcColumn}>
              {calcBusy ? 'Creating…' : 'Create'}
            </Button>
            <DialogTrigger disableButtonEnhancement><Button appearance="subtle">Cancel</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
    {/* Add calculated table (DAX) dialog */}
    <Dialog open={calcTableDlgOpen} onOpenChange={(_, d) => { setCalcTableDlgOpen(d.open); if (!d.open) setCalcMsg(null); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add calculated table</DialogTitle>
          <DialogContent>
            <Field label="Table name" required>
              <Input value={calcTableName} onChange={(_, d) => setCalcTableName(d.value)} placeholder="DimDate" />
            </Field>
            <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>DAX table expression</Caption1>
            <MonacoTextarea value={calcTableExpr} onChange={setCalcTableExpr} language="sql" height={120} minHeight={80} ariaLabel="Calculated table DAX" />
            {calcMsg && <MessageBar intent={calcMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{calcMsg.text}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={calcBusy || !calcTableName.trim() || !calcTableExpr.trim()} onClick={addCalcTable}>
              {calcBusy ? 'Creating…' : 'Create'}
            </Button>
            <DialogTrigger disableButtonEnhancement><Button appearance="subtle">Cancel</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
    </>
  );
}

// ============================================================
// Report (Power BI)
// ============================================================
// Power BI authoring (visuals, bookmarks, page editor) is out-of-scope for
// the Loom Console — Power BI Desktop / Power BI Web are the supported
// authoring surfaces. The Loom editor is a metadata + embed-viewer + open-
// in-Desktop launcher. Each editor (Report, Dashboard, Scorecard) builds
// an honest inline ribbon (no decorative disabled buttons) below.

/**
 * Built-in Power BI report themes (parity with the Power BI service
 * "View → Themes" gallery). Each entry is a valid Power BI report-theme JSON
 * object — applied at runtime via `report.applyTheme({ themeJson })` and at
 * load time via the embed config `theme`. Kept as TypeScript constants (not a
 * freeform JSON config file) per loom-no-freeform-config: the user picks a
 * named preset from a dropdown, or pastes a custom theme into the editor.
 * Format reference: https://learn.microsoft.com/power-bi/create-reports/desktop-report-themes#report-theme-json-file-format
 */

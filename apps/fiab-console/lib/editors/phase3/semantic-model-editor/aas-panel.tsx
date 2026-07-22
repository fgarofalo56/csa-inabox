'use client';

// aas-panel.tsx — AasSemanticModelPanel, the Azure Analysis Services storage-mode
// + refresh surface. Extracted byte-for-byte from ../semantic-model-editor.tsx.

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Select, Switch, InfoLabel, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Save20Regular,
  ArrowSync20Regular, Clock20Regular,
} from '@fluentui/react-icons';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { loomDocUrl } from '@/lib/learn/content';
import { ItemEditorChrome } from '../../item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useStyles } from '../styles';
import { useSmVisualStyles } from './styles';

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

export function AasSemanticModelPanel({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const sm = useSmVisualStyles();
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

          {/* SC-6 — teaching banner: the AAS-backed tabular model + Model view. */}
          <TeachingBanner
            surfaceKey="semantic-model"
            title="A Loom semantic model is a real Azure Analysis Services tabular model"
            message="Tables, relationships, and measures live in a live AAS Standard database — the Model view renders them as the shared relationship canvas (table cards + cardinality-marked join lines), Refresh queues a real processing operation, and storage mode is a live setting. No Microsoft Fabric or Power BI workspace is required."
            learnMoreHref={loomDocUrl('fiab/parity/semantic-model')}
          />

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
                  <div className={sm.paneHeader}><Database20Regular /><Subtitle2>Storage mode</Subtitle2></div>
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
                    <div className={sm.paneHeader}><ArrowSync20Regular /><Subtitle2>Scheduled refresh</Subtitle2></div>
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
                    <div className={sm.paneHeader}><Clock20Regular /><Subtitle2>Refresh history</Subtitle2></div>
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

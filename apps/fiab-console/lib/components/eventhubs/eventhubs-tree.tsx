'use client';

/**
 * EventHubsNamespaceTree — the Azure Event Hubs namespace navigator.
 *
 * The Event Hubs equivalent of the ADF Factory Resources / Synapse Workspace
 * Resources / Databricks Workspace panes. Once the namespace is known
 * (env-pinned LOOM_EVENTHUB_NAMESPACE + LOOM_SUBSCRIPTION_ID + RG), the
 * Eventstream editor's left pane becomes this typed navigator over the real
 * Microsoft.EventHub/namespaces/{ns} ARM surface — collapsing the Azure portal
 * Event Hubs blade (Event Hubs / Schema Registry / Shared access policies /
 * Networking / Geo-recovery) into one tree.
 *
 * Every count comes from a real ARM list call; every create/delete/update hits
 * the real ARM REST through the namespace-level BFF routes:
 *   - Event hubs        → /api/eventhubs/hubs            (list / create / delete)
 *   - Consumer groups   → /api/eventhubs/consumergroups  (per-hub list / create / delete; lazy-loaded per hub)
 *   - Schema groups     → /api/eventhubs/schemagroups    (list / create / delete)
 *   - Authorization rules → /api/eventhubs/authrules     (list SAS policies; reveal/rotate keys)
 *   - Networking        → /api/eventhubs/network         (firewall summary + editable rules)
 *   - Geo-recovery      → /api/eventhubs/geodr           (list Geo-DR configs)
 *
 * Authoring surfaces beyond list/create/delete open the tabbed
 * EventHubsNamespaceEditor (capture / geodr / sas / privateendpoints), which
 * drives the full ARM/EH REST surface the Azure portal exposes:
 *   - Capture config     → /api/eventhubs/capture                          (GET/PUT captureDescription)
 *   - Geo-DR pair/break/failover → /api/eventhubs/geodr-actions            (POST create | delete | failover)
 *   - SAS-key reveal/rotate      → /api/eventhubs/authrules/[rule]/keys[/regenerate] (namespace + per-hub scope)
 *   - Private endpoints  → /api/eventhubs/private-endpoints                (GET list / POST approve | reject)
 *
 * No mocks. When the namespace is unconfigured the routes 503 and the whole
 * tree shows a single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, SpinButton, Switch, Textarea,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular,
  Stream20Regular, PeopleTeam20Regular, DocumentBulletList20Regular,
  Key20Regular, Globe20Regular, ShieldKeyhole20Regular,
  Search20Regular,
  DataUsage20Regular, Send20Regular, Eye20Regular,
  Archive20Regular, LinkSquare20Regular, Settings20Regular,
} from '@fluentui/react-icons';
import { EventHubsNamespaceEditor } from './eventhubs-namespace-editor';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalS, height: '100%', minWidth: '260px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  leafRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
});

// Data Explorer styles. New makeStyles use STRING CSS values (px units) so the
// Griffel types accept them (the older block above predates that and trips tsc).
const useDataExplorerStyles = makeStyles({
  panel: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '0' },
  row: { display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' },
  grow: { flexGrow: '1', minWidth: '160px' },
  gridWrap: { maxHeight: '320px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  stickyHead: {
    position: 'sticky', top: '0', zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `inset 0 -1px 0 ${tokens.colorNeutralStroke2}`,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  bodyCell: { maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis' },
  hint: { color: tokens.colorNeutralForeground3, display: 'block' },
  clickRow: {
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
});

const HUBS_ROUTE = '/api/eventhubs/hubs';
const CG_ROUTE = '/api/eventhubs/consumergroups';
const SG_ROUTE = '/api/eventhubs/schemagroups';
const AUTH_ROUTE = '/api/eventhubs/authrules';
const NET_ROUTE = '/api/eventhubs/network';
const GEODR_ROUTE = '/api/eventhubs/geodr';
const DATA_ROUTE = '/api/eventhubs/data-explorer';
const PE_ROUTE = '/api/eventhubs/private-endpoints';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface HubRow { name: string; partitionCount?: number; messageRetentionInDays?: number; status?: string; captureEnabled?: boolean }
interface CgRow { name: string; eventHub: string; userMetadata?: string }
interface SgRow { name: string; schemaType?: string; schemaCompatibility?: string }
interface AuthRow { name: string; rights: string[]; scope: string }
interface NetSummary { defaultAction?: string; publicNetworkAccess?: string; ipRuleCount: number; vnetRuleCount: number }
interface GeoRow { name: string; role?: string; partnerNamespace?: string; provisioningState?: string }
interface PeRow { name: string; privateEndpointId?: string; connectionStatus: string; provisioningState?: string }

type CreateGroup = 'hub' | 'cg' | 'sg';
type EditorTab = 'capture' | 'networking' | 'geodr' | 'sas' | 'privateendpoints';

function peStatusColor(s?: string) {
  if (s === 'Approved') return 'success' as const;
  if (s === 'Pending') return 'warning' as const;
  if (s === 'Rejected' || s === 'Disconnected') return 'severe' as const;
  return 'informative' as const;
}

function hubStatusColor(s?: string) {
  if (s === 'Active') return 'success' as const;
  if (s === 'Disabled' || s === 'SendDisabled' || s === 'ReceiveDisabled') return 'warning' as const;
  return 'informative' as const;
}

// Public network access posture badge color. "Disabled" (private-endpoint-only)
// is the secure IL5/GCC-High default, so it reads as success; "Enabled" (public
// reachable) reads as warning to flag the looser posture.
function publicAccessColor(s?: string) {
  if (s === 'Disabled' || s === 'SecuredByPerimeter') return 'success' as const;
  if (s === 'Enabled') return 'warning' as const;
  return 'informative' as const;
}

// ===================================================================
// Data Explorer dialog — Send events + View (peek) events for one hub.
// Mirrors the Azure portal per-event-hub "Data Explorer" tool. Send hits the
// real HTTPS data-plane REST (/api/eventhubs/data-explorer op=send). View calls op=peek,
// which is an honest dependency-gate today (Event Hubs has no REST receive;
// receiving needs the @azure/event-hubs AMQP SDK) — the full View UI still
// renders and shows the precise MessageBar naming what to provision.
// ===================================================================
interface PeekEvent {
  offset?: string;
  sequenceNumber?: number;
  enqueuedTime?: string;
  partitionId?: string;
  partitionKey?: string;
  body: unknown;
  properties?: Record<string, unknown>;
}

export interface EventHubsDataExplorerDialogProps {
  open: boolean;
  hub: string;
  onClose: () => void;
}

export function EventHubsDataExplorerDialog({ open, hub, onClose }: EventHubsDataExplorerDialogProps) {
  const d = useDataExplorerStyles();
  const [tab, setTab] = useState<'send' | 'view'>('send');

  // ---- Send panel ----
  const [bodyText, setBodyText] = useState('{\n  "message": "hello from Loom"\n}');
  /** Key-value rows for the UserProperties object. Replaces the raw-JSON Textarea. */
  const [propRows, setPropRows] = useState<{ key: string; value: string }[]>([]);
  const [partitionKey, setPartitionKey] = useState('');
  const [repeat, setRepeat] = useState(1);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  // ---- View panel ----
  const [viewPartition, setViewPartition] = useState('0');
  const [maxEvents, setMaxEvents] = useState(20);
  const [fromLatest, setFromLatest] = useState(true);
  const [peeking, setPeeking] = useState(false);
  const [peekErr, setPeekErr] = useState<string | null>(null);
  const [peekGate, setPeekGate] = useState<{ message: string; missing?: string; dependency?: string; hint?: string } | null>(null);
  const [events, setEvents] = useState<PeekEvent[]>([]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  // Reset transient state whenever the dialog (re)opens for a hub.
  useEffect(() => {
    if (open) {
      setTab('send');
      setSendErr(null); setSendMsg(null);
      setPropRows([]);
      setPeekErr(null); setPeekGate(null); setEvents([]); setExpanded({});
    }
  }, [open, hub]);

  /** Build the UserProperties object from the key-value rows. Duplicate/blank keys are skipped. */
  function buildProps(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const { key, value } of propRows) {
      const k = key.trim();
      if (k) result[k] = value;
    }
    return result;
  }

  const doSend = useCallback(async () => {
    setSendErr(null); setSendMsg(null);
    if (!bodyText.trim()) { setSendErr('Event body is required.'); return; }
    const properties = buildProps();
    const count = Math.max(1, Math.min(100, repeat));
    // Body is sent as-is; if it parses as JSON we forward the parsed object so
    // it is serialized once on the wire, otherwise we send the raw string.
    let body: unknown = bodyText;
    try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    const events = Array.from({ length: count }, () => ({
      body,
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
    }));
    setSending(true);
    try {
      const res = await fetch(DATA_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'send', hub, events, partitionKey: partitionKey.trim() || undefined }),
      });
      const j = await readJson(res);
      if (!j.ok) {
        setSendErr(j.code === 'not_configured' ? `Namespace not configured: set ${j.missing}.` : (j.error || `send failed (HTTP ${res.status})`));
        return;
      }
      setSendMsg(`Sent ${j.sent} event${j.sent === 1 ? '' : 's'} to ${hub}${partitionKey.trim() ? ` (partition key "${partitionKey.trim()}")` : ''} — HTTP ${j.status}.`);
    } catch (e: any) {
      setSendErr(e?.message || String(e));
    } finally {
      setSending(false);
    }
  }, [bodyText, propRows, partitionKey, repeat, hub]);

  const doPeek = useCallback(async () => {
    setPeekErr(null); setPeekGate(null); setEvents([]); setExpanded({});
    setPeeking(true);
    try {
      const qs = new URLSearchParams({
        op: 'peek', hub, partition: viewPartition.trim() || '0',
        maxEvents: String(Math.max(1, Math.min(100, maxEvents))),
        fromLatest: String(fromLatest),
      });
      const res = await fetch(`${DATA_ROUTE}?${qs.toString()}`);
      const j = await readJson(res);
      if (!j.ok) {
        if (j.code === 'receive_unavailable') {
          setPeekGate({ message: j.error, missing: j.missing, dependency: j.dependency, hint: j.hint });
        } else if (j.code === 'not_configured') {
          setPeekGate({ message: `Event Hubs namespace not configured: set ${j.missing}.`, missing: j.missing });
        } else {
          setPeekErr(j.error || `peek failed (HTTP ${res.status})`);
        }
        return;
      }
      setEvents(Array.isArray(j.events) ? j.events : []);
    } catch (e: any) {
      setPeekErr(e?.message || String(e));
    } finally {
      setPeeking(false);
    }
  }, [hub, viewPartition, maxEvents, fromLatest]);

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '760px' }}>
        <DialogBody>
          <DialogTitle>Data Explorer — {hub}</DialogTitle>
          <DialogContent>
            <TabList selectedValue={tab} onTabSelect={(_, dt) => setTab(dt.value as 'send' | 'view')}>
              <Tab value="send" icon={<Send20Regular />}>Send events</Tab>
              <Tab value="view" icon={<Eye20Regular />}>View events</Tab>
            </TabList>

            {tab === 'send' && (
              <div className={d.panel} style={{ marginTop: '12px' }}>
                <Field label="Event body" hint="Plain text or a JSON document. Published to the event hub via the real REST data plane.">
                  <Textarea value={bodyText} onChange={(_, v) => setBodyText(v.value)} rows={6} resize="vertical" textarea={{ style: { fontFamily: tokens.fontFamilyMonospace } }} />
                </Field>
                <Field label="Custom properties (optional)" hint="Sent as UserProperties on the event. Each row is one key → value pair.">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                    {propRows.map((row, i) => (
                      <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                        <Input
                          placeholder="key"
                          value={row.key}
                          onChange={(_, v) => setPropRows((prev) => prev.map((r, idx) => idx === i ? { ...r, key: v.value } : r))}
                          style={{ flex: '1 1 0', minWidth: 0 }}
                        />
                        <Input
                          placeholder="value"
                          value={row.value}
                          onChange={(_, v) => setPropRows((prev) => prev.map((r, idx) => idx === i ? { ...r, value: v.value } : r))}
                          style={{ flex: '2 1 0', minWidth: 0 }}
                        />
                        <Button
                          appearance="subtle"
                          size="small"
                          aria-label="Remove property"
                          onClick={() => setPropRows((prev) => prev.filter((_, idx) => idx !== i))}
                        >×</Button>
                      </div>
                    ))}
                    <Button
                      appearance="outline"
                      size="small"
                      icon={<Add20Regular />}
                      onClick={() => setPropRows((prev) => [...prev, { key: '', value: '' }])}
                      style={{ alignSelf: 'flex-start' }}
                    >Add property</Button>
                  </div>
                </Field>
                <div className={d.row}>
                  <Field label="Partition key (optional)" className={d.grow}>
                    <Input value={partitionKey} onChange={(_, v) => setPartitionKey(v.value)} placeholder="e.g. device-42" />
                  </Field>
                  <Field label="Repeat (send N copies)">
                    <SpinButton min={1} max={100} value={repeat} onChange={(_, sd) => { const v = sd.value ?? Number(sd.displayValue); if (Number.isFinite(v)) setRepeat(Math.max(1, Math.min(100, Number(v)))); }} />
                  </Field>
                </div>
                {sendErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Send failed</MessageBarTitle>{sendErr}</MessageBarBody></MessageBar>}
                {sendMsg && <MessageBar intent="success"><MessageBarBody>{sendMsg}</MessageBarBody></MessageBar>}
                <Caption1 className={d.hint}>
                  Authenticated with Microsoft Entra (the namespace sets <code>disableLocalAuth:true</code>, so SAS is
                  disabled). The Console UAMI must hold <strong>Azure Event Hubs Data Sender</strong> (or Data Owner) —
                  otherwise the real 401/403 from the service is shown here.
                </Caption1>
              </div>
            )}

            {tab === 'view' && (
              <div className={d.panel} style={{ marginTop: '12px' }}>
                <div className={d.row}>
                  <Field label="Partition">
                    <Input value={viewPartition} onChange={(_, v) => setViewPartition(v.value)} placeholder="0" style={{ width: '80px' }} />
                  </Field>
                  <Field label="Max events">
                    <SpinButton min={1} max={100} value={maxEvents} onChange={(_, sd) => { const v = sd.value ?? Number(sd.displayValue); if (Number.isFinite(v)) setMaxEvents(Math.max(1, Math.min(100, Number(v)))); }} />
                  </Field>
                  <Field label="Position">
                    <Switch checked={fromLatest} onChange={(_, sd) => setFromLatest(sd.checked)} label={fromLatest ? 'Latest (newest)' : 'Earliest (retained)'} />
                  </Field>
                  <Button appearance="primary" icon={<Eye20Regular />} onClick={doPeek} disabled={peeking}>{peeking ? 'Reading…' : 'Peek'}</Button>
                </div>

                {peekErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>View failed</MessageBarTitle>{peekErr}</MessageBarBody></MessageBar>}
                {peekGate && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>View events not available in this deployment</MessageBarTitle>
                      {peekGate.message}
                      {peekGate.hint && <><br /><Caption1>{peekGate.hint}</Caption1></>}
                    </MessageBarBody>
                    {(peekGate.dependency || peekGate.missing) && (
                      <MessageBarActions>
                        {peekGate.dependency && <Badge appearance="tint" color="warning">add {peekGate.dependency}</Badge>}
                        {peekGate.missing && <Badge appearance="tint" color="warning">set {peekGate.missing}</Badge>}
                      </MessageBarActions>
                    )}
                  </MessageBar>
                )}

                {events.length > 0 && (
                  <div className={d.gridWrap}>
                    <Table size="extra-small" aria-label="Peeked events">
                      <TableHeader className={d.stickyHead}>
                        <TableRow>
                          <TableHeaderCell>Seq #</TableHeaderCell>
                          <TableHeaderCell>Offset</TableHeaderCell>
                          <TableHeaderCell>Enqueued (UTC)</TableHeaderCell>
                          <TableHeaderCell>Body</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {events.map((ev, i) => {
                          const bodyStr = typeof ev.body === 'string' ? ev.body : JSON.stringify(ev.body);
                          const isOpen = !!expanded[i];
                          return (
                            <TableRow key={`${ev.sequenceNumber ?? i}`} className={d.clickRow} onClick={() => setExpanded((m) => ({ ...m, [i]: !m[i] }))} aria-expanded={isOpen}>
                              <TableCell><span className={d.mono}>{ev.sequenceNumber ?? '—'}</span></TableCell>
                              <TableCell><span className={d.mono}>{ev.offset ?? '—'}</span></TableCell>
                              <TableCell><Caption1>{ev.enqueuedTime ?? '—'}</Caption1></TableCell>
                              <TableCell className={d.bodyCell}>
                                <span className={d.mono} style={isOpen ? undefined : { whiteSpace: 'nowrap' }}>{isOpen ? bodyStr : bodyStr.slice(0, 80)}</span>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {!peeking && !peekErr && !peekGate && events.length === 0 && (
                  <Caption1 className={d.hint}>Choose a partition and position, then Peek to read a bounded batch of recent events.</Caption1>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
            {tab === 'send' && (
              <Button appearance="primary" icon={<Send20Regular />} onClick={doSend} disabled={sending || !bodyText.trim()}>{sending ? 'Sending…' : 'Send'}</Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export interface EventHubsNamespaceTreeProps {
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
  /** Called when the user picks an event hub leaf (host editor can bind it as a source). */
  onSelectEventHub?: (eventHub: string) => void;
}

export function EventHubsNamespaceTree({ refreshKey = 0, onSelectEventHub }: EventHubsNamespaceTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [hubs, setHubs] = useState<HubRow[]>([]);
  const [schemaGroups, setSchemaGroups] = useState<SgRow[]>([]);
  const [authRules, setAuthRules] = useState<AuthRow[]>([]);
  const [network, setNetwork] = useState<NetSummary | null>(null);
  const [geodr, setGeodr] = useState<GeoRow[]>([]);
  const [peConnections, setPeConnections] = useState<PeRow[]>([]);

  // Namespace editor (Capture / Geo-DR / SAS keys / Private endpoints) overlay.
  const [editor, setEditor] = useState<{ hub: string; tab: EditorTab } | null>(null);
  const openEditor = useCallback((hub: string, tab: EditorTab) => setEditor({ hub, tab }), []);

  // Consumer groups are per-hub and lazily loaded when a hub is expanded.
  const [cgByHub, setCgByHub] = useState<Record<string, CgRow[]>>({});
  const [cgLoading, setCgLoading] = useState<Record<string, boolean>>({});

  // Data Explorer (Send + View events) — open for the chosen event hub.
  const [dataExplorerHub, setDataExplorerHub] = useState<string | null>(null);

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreateGroup | null>(null);
  const [createName, setCreateName] = useState('');
  const [hubPartitions, setHubPartitions] = useState(2);
  const [hubRetention, setHubRetention] = useState(1);
  const [cgParentHub, setCgParentHub] = useState('');
  const [sgSchemaType, setSgSchemaType] = useState<'Avro' | 'Json'>('Avro');
  const [sgCompat, setSgCompat] = useState<'None' | 'Backward' | 'Forward'>('None');
  const [createError, setCreateError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [hr, sr, ar, nr, gr, pr] = await Promise.all([
        fetch(HUBS_ROUTE).then(readJson),
        fetch(SG_ROUTE).then(readJson),
        fetch(AUTH_ROUTE).then(readJson),
        fetch(NET_ROUTE).then(readJson),
        fetch(GEODR_ROUTE).then(readJson),
        fetch(PE_ROUTE).then(readJson),
      ]);
      for (const b of [hr, sr, ar, nr, gr, pr]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (hr.ok) setHubs(hr.hubs || []); else setError(hr.error || 'failed to list event hubs');
      if (sr.ok) setSchemaGroups(sr.schemaGroups || []);
      if (ar.ok) setAuthRules(ar.rules || []);
      if (nr.ok) setNetwork(nr.network || null);
      if (gr.ok) setGeodr(gr.configs || []);
      if (pr.ok) setPeConnections(pr.connections || []);
      // Drop stale consumer-group caches for hubs that no longer exist.
      setCgByHub((prev) => {
        const live = new Set((hr.hubs || []).map((h: HubRow) => h.name));
        const next: Record<string, CgRow[]> = {};
        for (const k of Object.keys(prev)) if (live.has(k)) next[k] = prev[k];
        return next;
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  const loadConsumerGroups = useCallback(async (eventHub: string) => {
    setCgLoading((m) => ({ ...m, [eventHub]: true }));
    try {
      const body = await fetch(`${CG_ROUTE}?eventHub=${encodeURIComponent(eventHub)}`).then(readJson);
      if (applyGate(body)) return;
      if (body.ok) setCgByHub((m) => ({ ...m, [eventHub]: body.consumerGroups || [] }));
      else setError(body.error || `failed to list consumer groups for ${eventHub}`);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setCgLoading((m) => ({ ...m, [eventHub]: false }));
    }
  }, []);

  // ---------------------------------------------------------------
  // Create / delete (real ARM REST)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreateGroup, parentHub?: string) => {
    setCreateGroup(g); setCreateName(''); setCreateError(null);
    setHubPartitions(2); setHubRetention(1);
    setSgSchemaType('Avro'); setSgCompat('None');
    setCgParentHub(parentHub || hubs[0]?.name || '');
  }, [hubs]);

  const submitCreate = useCallback(async () => {
    if (!createGroup) return;
    if (!createName.trim()) { setCreateError('Name is required.'); return; }
    if (createGroup === 'cg' && !cgParentHub) { setCreateError('Pick a parent event hub.'); return; }
    setBusy(true); setCreateError(null);
    try {
      let route = HUBS_ROUTE; let payload: any = {};
      if (createGroup === 'hub') {
        route = HUBS_ROUTE;
        payload = { name: createName.trim(), partitionCount: hubPartitions, messageRetentionInDays: hubRetention };
      } else if (createGroup === 'cg') {
        route = CG_ROUTE;
        payload = { eventHub: cgParentHub, name: createName.trim() };
      } else if (createGroup === 'sg') {
        route = SG_ROUTE;
        payload = { name: createName.trim(), schemaType: sgSchemaType, schemaCompatibility: sgCompat };
      }
      const res = await fetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setCreateError(body.error || 'create failed'); setBusy(false); return; }
      const cgHub = cgParentHub;
      const wasCg = createGroup === 'cg';
      setCreateGroup(null);
      await loadAll();
      if (wasCg && cgHub) await loadConsumerGroups(cgHub);
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, createName, hubPartitions, hubRetention, cgParentHub, sgSchemaType, sgCompat, loadAll, loadConsumerGroups]);

  const del = useCallback(async (route: string, query: string, reloadHub?: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${route}?${query}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
      if (reloadHub) await loadConsumerGroups(reloadHub);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll, loadConsumerGroups]);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fHubs = useMemo(() => hubs.filter((h) => match(h.name)), [hubs, f]);
  const fSchemaGroups = useMemo(() => schemaGroups.filter((g) => match(g.name)), [schemaGroups, f]);
  const fAuthRules = useMemo(() => authRules.filter((a) => match(a.name)), [authRules, f]);
  const fGeodr = useMemo(() => geodr.filter((g) => match(g.name)), [geodr, f]);

  // ---------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------
  const groupHeader = (
    label: string, icon: React.ReactElement, count: number,
    onAdd?: () => void, addTitle?: string,
  ) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
  );

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Event Hubs namespace</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Event Hubs namespace not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console Container App (e.g.{' '}
            <code>LOOM_EVENTHUB_NAMESPACE=loom-evhns</code>, plus{' '}
            <code>LOOM_SUBSCRIPTION_ID</code> and <code>LOOM_EVENTHUB_RG</code> / <code>LOOM_DLZ_RG</code>) so
            the Loom console can reach a real Azure Event Hubs namespace. The navigator stays here; entities
            appear once the namespace is reachable. The Loom UAMI must hold{' '}
            <strong>Azure Event Hubs Data Owner</strong> (data plane) and <strong>Contributor</strong>
            (control plane) on the namespace. Provisioned by{' '}
            <code>platform/fiab/bicep/modules/landing-zone/eventhubs*.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Event Hubs namespace</span>
        <span style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Add new" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="Add new" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Stream20Regular />} onClick={() => openCreate('hub')}>Event hub</MenuItem>
                <MenuItem icon={<PeopleTeam20Regular />} onClick={() => openCreate('cg')} disabled={hubs.length === 0}>Consumer group</MenuItem>
                <MenuItem icon={<DocumentBulletList20Regular />} onClick={() => openCreate('sg')}>Schema group</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh namespace" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input
          size="small"
          contentBefore={<Search20Regular />}
          placeholder="Filter resources by name"
          value={filter}
          onChange={(_, d) => setFilter(d.value)}
        />
      </Field>

      {loading && <div style={{ padding: tokens.spacingVerticalS }}><Spinner size="tiny" label="Loading namespace…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Namespace error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="Event Hubs namespace" defaultOpenItems={['g-hubs']}>
          {/* Event hubs — each hub is a branch that lazily loads its consumer groups */}
          <TreeItem itemType="branch" value="g-hubs">
            {groupHeader('Event hubs', <Stream20Regular />, hubs.length, () => openCreate('hub'), 'New event hub')}
            <Tree>
              {fHubs.length === 0 && <TreeItem itemType="leaf" value="eh-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No event hubs'}</Caption1></TreeItemLayout></TreeItem>}
              {fHubs.map((h) => (
                <TreeItem
                  key={h.name} itemType="branch" value={`eh-${h.name}`}
                  onOpenChange={(_, d) => { if (d.open && cgByHub[h.name] === undefined && !cgLoading[h.name]) void loadConsumerGroups(h.name); }}
                >
                  <TreeItemLayout iconBefore={<Stream20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: onSelectEventHub ? 'pointer' : undefined }}
                        onClick={() => onSelectEventHub?.(h.name)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onSelectEventHub) { e.preventDefault(); onSelectEventHub(h.name); } }}
                      >
                        {h.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof h.partitionCount === 'number' && <Caption1>{h.partitionCount}p</Caption1>}
                        {typeof h.messageRetentionInDays === 'number' && <Caption1>{h.messageRetentionInDays}d</Caption1>}
                        {h.captureEnabled && <Badge size="small" appearance="outline">capture</Badge>}
                        {h.status && <Badge size="small" appearance="filled" color={hubStatusColor(h.status)}>{h.status}</Badge>}
                        <Tooltip content="Data Explorer (send / view events)" relationship="label">
                          <Button size="small" appearance="subtle" icon={<DataUsage20Regular />} onClick={() => setDataExplorerHub(h.name)} aria-label={`Data Explorer for ${h.name}`} />
                        </Tooltip>
                        <Tooltip content="Configure capture" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Archive20Regular />} onClick={() => openEditor(h.name, 'capture')} aria-label={`Configure capture for ${h.name}`} />
                        </Tooltip>
                        <Tooltip content="SAS keys (reveal / rotate)" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Key20Regular />} onClick={() => openEditor(h.name, 'sas')} aria-label={`SAS keys for ${h.name}`} />
                        </Tooltip>
                        <Tooltip content="New consumer group" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Add20Regular />} disabled={busy} onClick={() => openCreate('cg', h.name)} aria-label={`New consumer group on ${h.name}`} />
                        </Tooltip>
                        <Tooltip content="Delete event hub" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(HUBS_ROUTE, `name=${encodeURIComponent(h.name)}`)} aria-label={`Delete ${h.name}`} />
                        </Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                  <Tree>
                    {/* Consumer groups (per hub) */}
                    <TreeItem itemType="branch" value={`cg-grp-${h.name}`}>
                      {groupHeader('Consumer groups', <PeopleTeam20Regular />, cgByHub[h.name]?.length ?? 0, () => openCreate('cg', h.name), 'New consumer group')}
                      <Tree>
                        {cgLoading[h.name] && <TreeItem itemType="leaf" value={`cg-load-${h.name}`}><TreeItemLayout><Spinner size="extra-tiny" label="Loading consumer groups…" labelPosition="after" /></TreeItemLayout></TreeItem>}
                        {!cgLoading[h.name] && (cgByHub[h.name] || []).length === 0 && (
                          <TreeItem itemType="leaf" value={`cg-empty-${h.name}`}><TreeItemLayout><Caption1>No consumer groups</Caption1></TreeItemLayout></TreeItem>
                        )}
                        {(cgByHub[h.name] || []).filter((c) => match(c.name)).map((c) => {
                          const isDefault = c.name === '$Default';
                          return (
                            <TreeItem key={`${h.name}/${c.name}`} itemType="leaf" value={`cg-${h.name}-${c.name}`}>
                              <TreeItemLayout iconBefore={<PeopleTeam20Regular />}>
                                <span className={s.leafRow}>
                                  <span>{c.name}</span>
                                  <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                                    {isDefault && <Badge size="small" appearance="tint">default</Badge>}
                                    {!isDefault && (
                                      <Tooltip content="Delete consumer group" relationship="label">
                                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(CG_ROUTE, `eventHub=${encodeURIComponent(h.name)}&name=${encodeURIComponent(c.name)}`, h.name)} aria-label={`Delete ${c.name}`} />
                                      </Tooltip>
                                    )}
                                  </span>
                                </span>
                              </TreeItemLayout>
                            </TreeItem>
                          );
                        })}
                      </Tree>
                    </TreeItem>
                  </Tree>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Schema groups */}
          <TreeItem itemType="branch" value="g-schema">
            {groupHeader('Schema groups', <DocumentBulletList20Regular />, schemaGroups.length, () => openCreate('sg'), 'New schema group')}
            <Tree>
              {fSchemaGroups.length === 0 && <TreeItem itemType="leaf" value="sg-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No schema groups'}</Caption1></TreeItemLayout></TreeItem>}
              {fSchemaGroups.map((g) => (
                <TreeItem key={g.name} itemType="leaf" value={`sg-${g.name}`}>
                  <TreeItemLayout iconBefore={<DocumentBulletList20Regular />}>
                    <span className={s.leafRow}>
                      <span>{g.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {g.schemaType && <Badge size="small" appearance="tint">{g.schemaType}</Badge>}
                        {g.schemaCompatibility && <Caption1>{g.schemaCompatibility}</Caption1>}
                        <Tooltip content="Delete schema group" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(SG_ROUTE, `name=${encodeURIComponent(g.name)}`)} aria-label={`Delete ${g.name}`} />
                        </Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Authorization rules (SAS policies) — reveal + rotate keys via the editor */}
          <TreeItem itemType="branch" value="g-auth">
            <TreeItemLayout iconBefore={<Key20Regular />}>
              <span className={s.groupLayout}>
                <span>Authorization rules ({authRules.length})</span>
                <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                  <Tooltip content="Manage SAS keys (reveal / rotate)" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Settings20Regular />} onClick={() => openEditor('', 'sas')} aria-label="Manage SAS keys" />
                  </Tooltip>
                </span>
              </span>
            </TreeItemLayout>
            <Tree>
              {fAuthRules.length === 0 && <TreeItem itemType="leaf" value="auth-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No namespace SAS policies'}</Caption1></TreeItemLayout></TreeItem>}
              {fAuthRules.map((a) => (
                <TreeItem key={a.name} itemType="leaf" value={`auth-${a.name}`}>
                  <TreeItemLayout iconBefore={<Key20Regular />}>
                    <span className={s.leafRow}>
                      <span>{a.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {a.rights.map((r) => <Badge key={r} size="small" appearance="outline">{r}</Badge>)}
                        <Tooltip content="Reveal / rotate keys" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Key20Regular />} onClick={() => openEditor('', 'sas')} aria-label={`Manage keys for ${a.name}`} />
                        </Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Networking (firewall summary + editable IP / VNet rules via the editor) */}
          <TreeItem itemType="branch" value="g-network">
            <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>Networking</TreeItemLayout>
            <Tree>
              <TreeItem itemType="leaf" value="net-summary">
                <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>
                  {network ? (
                    <span className={s.leafRow}>
                      <span>Public access</span>
                      <span className={s.leafActions}>
                        <Badge size="small" appearance="filled" color={publicAccessColor(network.publicNetworkAccess)}>{network.publicNetworkAccess || '—'}</Badge>
                        <Tooltip content="Default firewall action when no rule matches" relationship="label">
                          <Badge size="small" appearance="tint">{network.defaultAction || '—'}</Badge>
                        </Tooltip>
                        <Caption1>{network.ipRuleCount} IP / {network.vnetRuleCount} VNet</Caption1>
                        <Tooltip content="Edit networking (IP / VNet firewall, public access)" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Settings20Regular />} onClick={() => openEditor('', 'networking')} aria-label="Edit networking rules" />
                        </Tooltip>
                      </span>
                    </span>
                  ) : <Spinner size="extra-tiny" label="Loading…" labelPosition="after" />}
                </TreeItemLayout>
              </TreeItem>
            </Tree>
          </TreeItem>

          {/* Geo-recovery — list + create/break/failover via the editor */}
          <TreeItem itemType="branch" value="g-geodr">
            {groupHeader('Geo-recovery', <Globe20Regular />, geodr.length, () => openEditor('', 'geodr'), 'Manage Geo-DR (pair / break / failover)')}
            <Tree>
              {fGeodr.length === 0 && <TreeItem itemType="leaf" value="geo-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No Geo-DR alias'}</Caption1></TreeItemLayout></TreeItem>}
              {fGeodr.map((g) => (
                <TreeItem key={g.name} itemType="leaf" value={`geo-${g.name}`}>
                  <TreeItemLayout iconBefore={<Globe20Regular />}>
                    <span className={s.leafRow}>
                      <span>{g.name}</span>
                      <span className={s.leafActions}>
                        {g.role && <Badge size="small" appearance="tint">{g.role}</Badge>}
                        {g.provisioningState && <Caption1>{g.provisioningState}</Caption1>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Private endpoint connections — approve/reject via the editor */}
          <TreeItem itemType="branch" value="g-pe">
            <TreeItemLayout iconBefore={<LinkSquare20Regular />}>
              <span className={s.groupLayout}>
                <span>Private endpoints ({peConnections.length})</span>
                <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                  <Tooltip content="Manage private endpoint connections (approve / reject)" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Settings20Regular />} onClick={() => openEditor('', 'privateendpoints')} aria-label="Manage private endpoints" />
                  </Tooltip>
                </span>
              </span>
            </TreeItemLayout>
            <Tree>
              {peConnections.filter((c) => match(c.name)).length === 0 && <TreeItem itemType="leaf" value="pe-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No private endpoint connections'}</Caption1></TreeItemLayout></TreeItem>}
              {peConnections.filter((c) => match(c.name)).map((c) => (
                <TreeItem key={c.name} itemType="leaf" value={`pe-${c.name}`}>
                  <TreeItemLayout iconBefore={<LinkSquare20Regular />}>
                    <span className={s.leafRow}>
                      <span>{c.name}</span>
                      <span className={s.leafActions}>
                        <Badge size="small" appearance="filled" color={peStatusColor(c.connectionStatus)}>{c.connectionStatus}</Badge>
                        {c.provisioningState && <Caption1>{c.provisioningState}</Caption1>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Create dialog (event hub / consumer group / schema group) */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'hub' ? 'event hub' : createGroup === 'cg' ? 'consumer group' : 'schema group'}
            </DialogTitle>
            <DialogContent>
              {createGroup === 'cg' && (
                <Field label="Parent event hub" required>
                  <Dropdown
                    value={cgParentHub}
                    selectedOptions={cgParentHub ? [cgParentHub] : []}
                    onOptionSelect={(_, d) => setCgParentHub(d.optionValue || '')}
                    placeholder="Pick an event hub"
                  >
                    {hubs.map((h) => <Option key={h.name} value={h.name} text={h.name}>{h.name}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Field label="Name" required style={{ marginTop: createGroup === 'cg' ? 8 : 0 }}>
                <Input value={createName} onChange={(_, d) => setCreateName(d.value)} placeholder={createGroup === 'hub' ? 'my-event-hub' : createGroup === 'cg' ? 'my-consumer-group' : 'my-schema-group'} />
              </Field>

              {createGroup === 'hub' && (
                <>
                  <Field label="Partition count" style={{ marginTop: tokens.spacingVerticalS }}>
                    <SpinButton min={1} max={32} value={hubPartitions} onChange={(_, d) => { const v = d.value ?? Number(d.displayValue); if (Number.isFinite(v)) setHubPartitions(Math.max(1, Math.min(32, Number(v)))); }} />
                  </Field>
                  <Field label="Message retention (days)" style={{ marginTop: tokens.spacingVerticalS }}>
                    <SpinButton min={1} max={7} value={hubRetention} onChange={(_, d) => { const v = d.value ?? Number(d.displayValue); if (Number.isFinite(v)) setHubRetention(Math.max(1, Math.min(7, Number(v)))); }} />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Standard namespaces allow 1–32 partitions and 1–7 days retention. Partition count is fixed
                    at create time. Tune Capture / longer retention in the Azure portal (not yet wired here).
                  </Caption1>
                </>
              )}
              {createGroup === 'cg' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                  A consumer group is an independent read position into the event hub. Each downstream
                  consumer (an Eventstream source, an ADX data connection, a custom app) should use its own
                  group. The built-in <code>$Default</code> group always exists and cannot be deleted.
                </Caption1>
              )}
              {createGroup === 'sg' && (
                <>
                  <Field label="Schema type" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={sgSchemaType} selectedOptions={[sgSchemaType]} onOptionSelect={(_, d) => setSgSchemaType((d.optionValue as 'Avro' | 'Json') || 'Avro')}>
                      {['Avro', 'Json'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Compatibility" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={sgCompat} selectedOptions={[sgCompat]} onOptionSelect={(_, d) => setSgCompat((d.optionValue as 'None' | 'Backward' | 'Forward') || 'None')}>
                      {['None', 'Backward', 'Forward'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Schema groups organize schemas in the namespace schema registry. Requires the Standard tier
                    or higher. Schemas themselves are registered via the schema-registry data plane.
                  </Caption1>
                </>
              )}
              {createError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy || !createName.trim() || (createGroup === 'cg' && !cgParentHub)}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Data Explorer (Send + View events) for the selected event hub. */}
      {dataExplorerHub && (
        <EventHubsDataExplorerDialog
          open={dataExplorerHub !== null}
          hub={dataExplorerHub}
          onClose={() => setDataExplorerHub(null)}
        />
      )}

      {/* Namespace editor — Capture / Geo-DR / SAS keys / Private endpoints. */}
      {editor && (
        <EventHubsNamespaceEditor
          open={editor !== null}
          hub={editor.hub}
          initialTab={editor.tab}
          onClose={() => setEditor(null)}
          onSaved={loadAll}
        />
      )}
    </div>
  );
}

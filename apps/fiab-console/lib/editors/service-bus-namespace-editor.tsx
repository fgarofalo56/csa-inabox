'use client';

/**
 * ServiceBusNamespaceEditor — navigator over the deployment-pinned Azure Service
 * Bus namespace (Microsoft.ServiceBus/namespaces). Real ARM via
 * /api/items/service-bus-namespace (reusing the thin servicebus-client). Lists
 * namespace properties + queues + topics and creates/deletes both with the full
 * queue/topic setting surface (TTL, lock, delivery count, dead-lettering,
 * duplicate detection, partitioning, auto-forward). A topic drills into its
 * subscriptions and each subscription's SQL/correlation filter rules. A Shared
 * access policies tab manages SAS rules (list/create/delete + list/regenerate
 * keys), and a Networking view shows the IP/VNet firewall + private endpoints.
 * Honest 503 gate when the namespace env vars are unset. Azure-native — no Fabric.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Input, Field, Checkbox,
  Textarea, Dropdown, Option, Divider,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Mailbox20Regular,
  Key20Regular, Filter20Regular, Copy20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center', maxWidth: '720px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  panel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground2 },
  dialogGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: '360px' },
  two: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalM },
  keyBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1 },
});

interface NamespaceProps { name?: string; location?: string; sku?: string; tier?: string; status?: string; provisioningState?: string; endpoint?: string; disableLocalAuth?: boolean; minimumTlsVersion?: string }
interface QueueEntity { name: string; status?: string; maxSizeInMegabytes?: number; messageCount?: number; activeMessageCount?: number; deadLetterMessageCount?: number; requiresSession?: boolean; maxDeliveryCount?: number }
interface TopicEntity { name: string; status?: string; maxSizeInMegabytes?: number; subscriptionCount?: number; requiresDuplicateDetection?: boolean; enablePartitioning?: boolean }
interface SubscriptionEntity { name: string; topic: string; status?: string; requiresSession?: boolean; maxDeliveryCount?: number; deadLetteringOnMessageExpiration?: boolean; activeMessageCount?: number; deadLetterMessageCount?: number }
interface CorrelationFilter { correlationId?: string; label?: string; contentType?: string; to?: string; replyTo?: string; messageId?: string }
interface RuleEntity { name: string; filterType: 'SqlFilter' | 'CorrelationFilter'; sqlExpression?: string; correlationFilter?: CorrelationFilter; actionSqlExpression?: string }
interface AuthorizationRule { name: string; rights: string[] }
interface AccessKeys { keyName: string; primaryKey?: string; secondaryKey?: string; primaryConnectionString?: string; secondaryConnectionString?: string; localAuthDisabled: boolean }
interface NetworkRuleSet { defaultAction?: string; publicNetworkAccess?: string; trustedServiceAccessEnabled?: boolean; ipRules: { ipMask: string; action?: string }[]; vnetRules: { subnetId: string }[] }
interface PrivateEndpointConnection { name: string; connectionStatus: string; provisioningState?: string; description?: string }
interface Props { item: FabricItemType; id: string }

export function ServiceBusNamespaceEditor({ item, id }: Props) {
  const s = useStyles();
  const [tab, setTab] = useState('queues');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [ns, setNs] = useState<NamespaceProps | null>(null);
  const [queues, setQueues] = useState<QueueEntity[]>([]);
  const [topics, setTopics] = useState<TopicEntity[]>([]);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Create queue/topic dialog (full settings)
  const [createOpen, setCreateOpen] = useState(false);
  const [kind, setKind] = useState<'queue' | 'topic'>('queue');
  const [cName, setCName] = useState('');
  const [cSize, setCSize] = useState('1024');
  const [cTtlDays, setCTtlDays] = useState('14');
  const [cLockSec, setCLockSec] = useState('30');
  const [cMaxDelivery, setCMaxDelivery] = useState('10');
  const [cSession, setCSession] = useState(false);
  const [cDlqExpire, setCDlqExpire] = useState(false);
  const [cDupDetect, setCDupDetect] = useState(false);
  const [cDupWindowMin, setCDupWindowMin] = useState('10');
  const [cPartition, setCPartition] = useState(false);
  const [cSupportOrdering, setCSupportOrdering] = useState(false);
  const [cForwardTo, setCForwardTo] = useState('');
  const [cBusy, setCBusy] = useState(false);

  // Topic subscriptions drill-in
  const [subsTopic, setSubsTopic] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubscriptionEntity[] | null>(null);
  const [createSubOpen, setCreateSubOpen] = useState(false);
  const [sName, setSName] = useState('');
  const [sLockSec, setSLockSec] = useState('30');
  const [sMaxDelivery, setSMaxDelivery] = useState('10');
  const [sTtlDays, setSTtlDays] = useState('14');
  const [sSession, setSSession] = useState(false);
  const [sDlqExpire, setSDlqExpire] = useState(false);
  const [subBusy, setSubBusy] = useState(false);

  // Subscription rules drill-in
  const [rulesFor, setRulesFor] = useState<{ topic: string; sub: string } | null>(null);
  const [rules, setRules] = useState<RuleEntity[] | null>(null);
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [rName, setRName] = useState('');
  const [rFilterType, setRFilterType] = useState<'SqlFilter' | 'CorrelationFilter'>('SqlFilter');
  const [rSql, setRSql] = useState('');
  const [rAction, setRAction] = useState('');
  const [rcCorrelationId, setRcCorrelationId] = useState('');
  const [rcLabel, setRcLabel] = useState('');
  const [rcContentType, setRcContentType] = useState('');
  const [ruleBusy, setRuleBusy] = useState(false);

  // Shared access policies
  const [authRules, setAuthRules] = useState<AuthorizationRule[] | null>(null);
  const [createAuthOpen, setCreateAuthOpen] = useState(false);
  const [aName, setAName] = useState('');
  const [aListen, setAListen] = useState(true);
  const [aSend, setASend] = useState(true);
  const [aManage, setAManage] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [keysFor, setKeysFor] = useState<string | null>(null);
  const [keys, setKeys] = useState<AccessKeys | null>(null);
  const [keysBusy, setKeysBusy] = useState(false);

  // Networking
  const [network, setNetwork] = useState<NetworkRuleSet | null>(null);
  const [privateEndpoints, setPrivateEndpoints] = useState<PrivateEndpointConnection[] | null>(null);
  const [netLoading, setNetLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace');
      const j = await r.json();
      if (!j.ok) { setGate({ error: j.error || 'not available', hint: j.hint }); setNs(null); setQueues([]); setTopics([]); return; }
      setNs(j.namespace || null);
      setQueues(Array.isArray(j.queues) ? j.queues : []);
      setTopics(Array.isArray(j.topics) ? j.topics : []);
    } catch (e: any) { setGate({ error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = useCallback((k: 'queue' | 'topic') => {
    setKind(k); setCName(''); setCSize('1024'); setCTtlDays('14'); setCLockSec('30'); setCMaxDelivery('10');
    setCSession(false); setCDlqExpire(false); setCDupDetect(false); setCDupWindowMin('10'); setCPartition(false);
    setCSupportOrdering(false); setCForwardTo(''); setCreateOpen(true);
  }, []);

  const create = useCallback(async () => {
    if (!cName.trim()) return;
    setCBusy(true); setMsg(null);
    try {
      const common = {
        name: cName.trim(),
        maxSizeInMegabytes: Number(cSize) || 1024,
        messageTtlDays: Number(cTtlDays) || undefined,
        requiresDuplicateDetection: cDupDetect,
        dupDetectionWindowMinutes: cDupDetect ? (Number(cDupWindowMin) || undefined) : undefined,
        enablePartitioning: cPartition,
      };
      const payload = kind === 'queue'
        ? { action: 'create-queue', ...common, requiresSession: cSession, lockDurationSeconds: Number(cLockSec) || undefined, maxDeliveryCount: Number(cMaxDelivery) || undefined, deadLetteringOnMessageExpiration: cDlqExpire, forwardTo: cForwardTo.trim() || undefined }
        : { action: 'create-topic', ...common, supportOrdering: cSupportOrdering };
      const r = await fetch('/api/items/service-bus-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created ${kind} "${cName.trim()}".` });
      setCreateOpen(false);
      await load();
    } finally { setCBusy(false); }
  }, [kind, cName, cSize, cTtlDays, cLockSec, cMaxDelivery, cSession, cDlqExpire, cDupDetect, cDupWindowMin, cPartition, cSupportOrdering, cForwardTo, load]);

  const del = useCallback(async (k: 'queue' | 'topic', name: string) => {
    setMsg(null);
    try {
      const r = await fetch(`/api/items/service-bus-namespace?${k}=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: `Deleted ${k} "${name}".` });
      if (k === 'topic' && subsTopic === name) { setSubsTopic(null); setSubs(null); setRulesFor(null); setRules(null); }
      await load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [load, subsTopic]);

  // --- Subscriptions ---
  const loadSubs = useCallback(async (topic: string) => {
    setSubsTopic(topic); setSubs(null); setRulesFor(null); setRules(null);
    try {
      const r = await fetch(`/api/items/service-bus-namespace?topic=${encodeURIComponent(topic)}&subscriptions=1`);
      const j = await r.json();
      setSubs(j.ok ? (j.subscriptions || []) : []);
      if (!j.ok) setMsg({ intent: 'error', text: j.error || 'failed to list subscriptions' });
    } catch { setSubs([]); }
  }, []);

  const createSub = useCallback(async () => {
    if (!subsTopic || !sName.trim()) return;
    setSubBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create-subscription', topic: subsTopic, name: sName.trim(),
          requiresSession: sSession, deadLetteringOnMessageExpiration: sDlqExpire,
          lockDurationSeconds: Number(sLockSec) || undefined, maxDeliveryCount: Number(sMaxDelivery) || undefined,
          messageTtlDays: Number(sTtlDays) || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created subscription "${sName.trim()}".` });
      setCreateSubOpen(false); setSName('');
      await loadSubs(subsTopic);
      await load();
    } finally { setSubBusy(false); }
  }, [subsTopic, sName, sSession, sDlqExpire, sLockSec, sMaxDelivery, sTtlDays, loadSubs, load]);

  const delSub = useCallback(async (topic: string, name: string) => {
    setMsg(null);
    try {
      const r = await fetch(`/api/items/service-bus-namespace?topic=${encodeURIComponent(topic)}&subscription=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: `Deleted subscription "${name}".` });
      if (rulesFor?.topic === topic && rulesFor?.sub === name) { setRulesFor(null); setRules(null); }
      await loadSubs(topic);
      await load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [loadSubs, load, rulesFor]);

  // --- Rules ---
  const loadRules = useCallback(async (topic: string, sub: string) => {
    setRulesFor({ topic, sub }); setRules(null);
    try {
      const r = await fetch(`/api/items/service-bus-namespace?topic=${encodeURIComponent(topic)}&subscription=${encodeURIComponent(sub)}&rules=1`);
      const j = await r.json();
      setRules(j.ok ? (j.rules || []) : []);
      if (!j.ok) setMsg({ intent: 'error', text: j.error || 'failed to list rules' });
    } catch { setRules([]); }
  }, []);

  const openCreateRule = useCallback(() => {
    setRName(''); setRFilterType('SqlFilter'); setRSql(''); setRAction('');
    setRcCorrelationId(''); setRcLabel(''); setRcContentType(''); setCreateRuleOpen(true);
  }, []);

  const createRuleFn = useCallback(async () => {
    if (!rulesFor || !rName.trim()) return;
    setRuleBusy(true); setMsg(null);
    try {
      const payload: any = {
        action: 'create-rule', topic: rulesFor.topic, subscription: rulesFor.sub, name: rName.trim(),
        filterType: rFilterType, actionSqlExpression: rAction.trim() || undefined,
      };
      if (rFilterType === 'SqlFilter') payload.sqlExpression = rSql.trim();
      else payload.correlationFilter = {
        correlationId: rcCorrelationId.trim() || undefined,
        label: rcLabel.trim() || undefined,
        contentType: rcContentType.trim() || undefined,
      };
      const r = await fetch('/api/items/service-bus-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created rule "${rName.trim()}".` });
      setCreateRuleOpen(false);
      await loadRules(rulesFor.topic, rulesFor.sub);
    } finally { setRuleBusy(false); }
  }, [rulesFor, rName, rFilterType, rSql, rAction, rcCorrelationId, rcLabel, rcContentType, loadRules]);

  const delRule = useCallback(async (name: string) => {
    if (!rulesFor) return;
    setMsg(null);
    try {
      const r = await fetch(`/api/items/service-bus-namespace?topic=${encodeURIComponent(rulesFor.topic)}&subscription=${encodeURIComponent(rulesFor.sub)}&rule=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      await loadRules(rulesFor.topic, rulesFor.sub);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [rulesFor, loadRules]);

  // --- Shared access policies ---
  const loadAuthRules = useCallback(async () => {
    setAuthRules(null); setKeysFor(null); setKeys(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace?authRules=1');
      const j = await r.json();
      setAuthRules(j.ok ? (j.authorizationRules || []) : []);
      if (!j.ok) setMsg({ intent: 'error', text: j.error || 'failed to list policies' });
    } catch { setAuthRules([]); }
  }, []);

  const createAuth = useCallback(async () => {
    if (!aName.trim()) return;
    const rights = [aListen && 'Listen', aSend && 'Send', aManage && 'Manage'].filter(Boolean);
    if (!rights.length) { setMsg({ intent: 'error', text: 'select at least one right' }); return; }
    setAuthBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create-auth-rule', name: aName.trim(), rights }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created policy "${aName.trim()}".` });
      setCreateAuthOpen(false); setAName('');
      await loadAuthRules();
    } finally { setAuthBusy(false); }
  }, [aName, aListen, aSend, aManage, loadAuthRules]);

  const delAuth = useCallback(async (name: string) => {
    setMsg(null);
    try {
      const r = await fetch(`/api/items/service-bus-namespace?authRule=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      if (keysFor === name) { setKeysFor(null); setKeys(null); }
      await loadAuthRules();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [loadAuthRules, keysFor]);

  const showKeys = useCallback(async (rule: string) => {
    setKeysFor(rule); setKeys(null); setKeysBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'list-keys', rule }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'failed to list keys' }); setKeysFor(null); return; }
      setKeys(j.keys);
    } finally { setKeysBusy(false); }
  }, []);

  const regenKeys = useCallback(async (rule: string, keyType: 'PrimaryKey' | 'SecondaryKey') => {
    setKeysBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate-keys', rule, keyType }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'regenerate failed' }); return; }
      setKeys(j.keys);
      setMsg({ intent: 'success', text: `Regenerated ${keyType === 'PrimaryKey' ? 'primary' : 'secondary'} key for "${rule}".` });
    } finally { setKeysBusy(false); }
  }, []);

  // --- Networking ---
  const loadNetwork = useCallback(async () => {
    setNetLoading(true);
    try {
      const r = await fetch('/api/items/service-bus-namespace?network=1');
      const j = await r.json();
      if (j.ok) { setNetwork(j.network || null); setPrivateEndpoints(Array.isArray(j.privateEndpoints) ? j.privateEndpoints : []); }
      else setMsg({ intent: 'error', text: j.error || 'failed to load networking' });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setNetLoading(false); }
  }, []);

  useEffect(() => {
    if (tab === 'sas' && authRules === null) void loadAuthRules();
    if (tab === 'networking' && network === null) void loadNetwork();
  }, [tab, authRules, network, loadAuthRules, loadNetwork]);

  const copy = useCallback((v?: string) => { if (v) void navigator.clipboard?.writeText(v).catch(() => {}); }, []);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Namespace', actions: [{ label: 'Refresh', onClick: () => void load() }] },
      { label: 'Entities', actions: [
        { label: 'New queue', onClick: gate ? undefined : () => openCreate('queue'), disabled: !!gate },
        { label: 'New topic', onClick: gate ? undefined : () => openCreate('topic'), disabled: !!gate },
      ]},
      { label: 'View', actions: [
        { label: 'Queues', onClick: () => setTab('queues') },
        { label: 'Topics', onClick: () => setTab('topics') },
        { label: 'Shared access policies', onClick: () => setTab('sas') },
        { label: 'Networking', onClick: () => setTab('networking') },
        { label: 'Overview', onClick: () => setTab('overview') },
      ]},
    ]},
  ], [gate, load, openCreate]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="queues">Queues</Tab>
            <Tab value="topics">Topics</Tab>
            <Tab value="sas">Shared access policies</Tab>
            <Tab value="networking">Networking</Tab>
            <Tab value="overview">Overview</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand" icon={<Mailbox20Regular />}>Service Bus namespace</Badge>
            {ns?.name && <Caption1 className={s.mono}>{ns.name}{ns.location ? ` · ${ns.location}` : ''}{ns.sku ? ` · ${ns.sku}` : ''}</Caption1>}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
          </div>

          {loading && <Spinner size="small" label="Loading namespace…" labelPosition="after" />}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Service Bus namespace not configured</MessageBarTitle>
                {gate.error}{gate.hint ? ` ${gate.hint}` : ''}
              </MessageBarBody>
            </MessageBar>
          )}

          {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

          {/* Create queue/topic dialog — full portal setting surface */}
          <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create {kind}</DialogTitle>
                <DialogContent>
                  <div className={s.dialogGrid}>
                    <Field label="Name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder={kind === 'queue' ? 'orders-queue' : 'orders-topic'} /></Field>
                    <div className={s.two}>
                      <Field label="Max size (MB)"><Input type="number" value={cSize} onChange={(_, d) => setCSize(d.value)} /></Field>
                      <Field label="Message TTL (days)"><Input type="number" value={cTtlDays} onChange={(_, d) => setCTtlDays(d.value)} /></Field>
                    </div>
                    {kind === 'queue' && (
                      <div className={s.two}>
                        <Field label="Lock duration (sec)" hint="Max 300"><Input type="number" value={cLockSec} onChange={(_, d) => setCLockSec(d.value)} /></Field>
                        <Field label="Max delivery count"><Input type="number" value={cMaxDelivery} onChange={(_, d) => setCMaxDelivery(d.value)} /></Field>
                      </div>
                    )}
                    <Divider />
                    {kind === 'queue' && <Checkbox label="Requires session (ordered FIFO)" checked={cSession} onChange={(_, d) => setCSession(!!d.checked)} />}
                    {kind === 'queue' && <Checkbox label="Dead-letter on message expiration" checked={cDlqExpire} onChange={(_, d) => setCDlqExpire(!!d.checked)} />}
                    {kind === 'topic' && <Checkbox label="Support ordering" checked={cSupportOrdering} onChange={(_, d) => setCSupportOrdering(!!d.checked)} />}
                    <Checkbox label="Enable duplicate detection (creation-only)" checked={cDupDetect} onChange={(_, d) => setCDupDetect(!!d.checked)} />
                    {cDupDetect && <Field label="Duplicate detection window (min)"><Input type="number" value={cDupWindowMin} onChange={(_, d) => setCDupWindowMin(d.value)} /></Field>}
                    <Checkbox label="Enable partitioning (creation-only)" checked={cPartition} onChange={(_, d) => setCPartition(!!d.checked)} />
                    {kind === 'queue' && <Field label="Auto-forward to (queue/topic name)" hint="Leave blank to disable"><Input value={cForwardTo} onChange={(_, d) => setCForwardTo(d.value)} placeholder="another-queue" /></Field>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Create subscription dialog */}
          <Dialog open={createSubOpen} onOpenChange={(_, d) => setCreateSubOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>New subscription · {subsTopic}</DialogTitle>
                <DialogContent>
                  <div className={s.dialogGrid}>
                    <Field label="Name" required><Input value={sName} onChange={(_, d) => setSName(d.value)} placeholder="all-orders" /></Field>
                    <div className={s.two}>
                      <Field label="Lock duration (sec)" hint="Max 300"><Input type="number" value={sLockSec} onChange={(_, d) => setSLockSec(d.value)} /></Field>
                      <Field label="Max delivery count"><Input type="number" value={sMaxDelivery} onChange={(_, d) => setSMaxDelivery(d.value)} /></Field>
                    </div>
                    <Field label="Message TTL (days)"><Input type="number" value={sTtlDays} onChange={(_, d) => setSTtlDays(d.value)} /></Field>
                    <Checkbox label="Requires session" checked={sSession} onChange={(_, d) => setSSession(!!d.checked)} />
                    <Checkbox label="Dead-letter on message expiration" checked={sDlqExpire} onChange={(_, d) => setSDlqExpire(!!d.checked)} />
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateSubOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={subBusy || !sName.trim()} onClick={createSub}>{subBusy ? 'Creating…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Create rule dialog */}
          <Dialog open={createRuleOpen} onOpenChange={(_, d) => setCreateRuleOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>New filter rule{rulesFor ? ` · ${rulesFor.sub}` : ''}</DialogTitle>
                <DialogContent>
                  <div className={s.dialogGrid}>
                    <Field label="Rule name" required><Input value={rName} onChange={(_, d) => setRName(d.value)} placeholder="high-priority" /></Field>
                    <Field label="Filter type">
                      <Dropdown value={rFilterType === 'SqlFilter' ? 'SQL filter' : 'Correlation filter'} selectedOptions={[rFilterType]}
                        onOptionSelect={(_, d) => setRFilterType((d.optionValue as 'SqlFilter' | 'CorrelationFilter') || 'SqlFilter')}>
                        <Option value="SqlFilter">SQL filter</Option>
                        <Option value="CorrelationFilter">Correlation filter</Option>
                      </Dropdown>
                    </Field>
                    {rFilterType === 'SqlFilter' ? (
                      <Field label="SQL filter expression" required hint="e.g. priority > 5 AND sys.Label = 'urgent'">
                        <Textarea value={rSql} onChange={(_, d) => setRSql(d.value)} placeholder="priority > 5" resize="vertical" />
                      </Field>
                    ) : (
                      <>
                        <Caption1>Match on any of these system properties (all AND-ed):</Caption1>
                        <Field label="Correlation ID"><Input value={rcCorrelationId} onChange={(_, d) => setRcCorrelationId(d.value)} /></Field>
                        <Field label="Label (Subject)"><Input value={rcLabel} onChange={(_, d) => setRcLabel(d.value)} /></Field>
                        <Field label="Content type"><Input value={rcContentType} onChange={(_, d) => setRcContentType(d.value)} /></Field>
                      </>
                    )}
                    <Field label="SQL action (optional)" hint="Mutates matched messages, e.g. SET priority = 10">
                      <Textarea value={rAction} onChange={(_, d) => setRAction(d.value)} placeholder="SET tier = 'gold'" resize="vertical" />
                    </Field>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateRuleOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={ruleBusy || !rName.trim() || (rFilterType === 'SqlFilter' && !rSql.trim())} onClick={createRuleFn}>{ruleBusy ? 'Creating…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Create SAS policy dialog */}
          <Dialog open={createAuthOpen} onOpenChange={(_, d) => setCreateAuthOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>New shared access policy</DialogTitle>
                <DialogContent>
                  <div className={s.dialogGrid}>
                    <Field label="Policy name" required><Input value={aName} onChange={(_, d) => setAName(d.value)} placeholder="listen-only" /></Field>
                    <Caption1>Claims</Caption1>
                    <Checkbox label="Listen" checked={aListen} onChange={(_, d) => setAListen(!!d.checked)} />
                    <Checkbox label="Send" checked={aSend} onChange={(_, d) => setASend(!!d.checked)} />
                    <Checkbox label="Manage (implies Listen + Send)" checked={aManage} onChange={(_, d) => setAManage(!!d.checked)} />
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateAuthOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={authBusy || !aName.trim()} onClick={createAuth}>{authBusy ? 'Creating…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* QUEUES */}
          {!loading && !gate && tab === 'queues' && (
            <>
              <div className={s.toolbar}><Button appearance="primary" icon={<Add20Regular />} onClick={() => openCreate('queue')}>New queue</Button></div>
              {queues.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No queues yet. Click <strong>New queue</strong> for point-to-point messaging.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Queues" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Queue</TableHeaderCell><TableHeaderCell>Max size (MB)</TableHeaderCell>
                      <TableHeaderCell>Active</TableHeaderCell><TableHeaderCell>Dead-letter</TableHeaderCell>
                      <TableHeaderCell>Session</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {queues.map((q) => (
                        <TableRow key={q.name}>
                          <TableCell className={s.mono}>{q.name}</TableCell>
                          <TableCell>{q.maxSizeInMegabytes ?? '—'}</TableCell>
                          <TableCell>{q.activeMessageCount ?? q.messageCount ?? '—'}</TableCell>
                          <TableCell>{q.deadLetterMessageCount ?? '—'}</TableCell>
                          <TableCell>{q.requiresSession ? 'yes' : 'no'}</TableCell>
                          <TableCell><Badge appearance="tint" color={q.status === 'Active' ? 'success' : 'informative'}>{q.status || '—'}</Badge></TableCell>
                          <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => del('queue', q.name)}>Delete</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {/* TOPICS + subscription/rule drill-in */}
          {!loading && !gate && tab === 'topics' && (
            <>
              <div className={s.toolbar}><Button appearance="primary" icon={<Add20Regular />} onClick={() => openCreate('topic')}>New topic</Button></div>
              {topics.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No topics yet. Click <strong>New topic</strong> for publish-subscribe fan-out.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Topics" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Topic</TableHeaderCell><TableHeaderCell>Max size (MB)</TableHeaderCell>
                      <TableHeaderCell>Subscriptions</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {topics.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell className={s.mono}>{t.name}</TableCell>
                          <TableCell>{t.maxSizeInMegabytes ?? '—'}</TableCell>
                          <TableCell>{t.subscriptionCount ?? 0}</TableCell>
                          <TableCell><Badge appearance="tint" color={t.status === 'Active' ? 'success' : 'informative'}>{t.status || '—'}</Badge></TableCell>
                          <TableCell>
                            <Button size="small" appearance={subsTopic === t.name ? 'primary' : 'subtle'} onClick={() => loadSubs(t.name)}>Subscriptions</Button>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => del('topic', t.name)}>Delete</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {subsTopic && (
                <div className={s.panel}>
                  <div className={s.toolbar}>
                    <Subtitle2>Subscriptions · {subsTopic}</Subtitle2>
                    <Button appearance="outline" icon={<Add20Regular />} onClick={() => { setSName(''); setCreateSubOpen(true); }}>New subscription</Button>
                  </div>
                  {subs === null ? <Spinner size="tiny" label="Loading subscriptions…" /> : subs.length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>No subscriptions. A topic delivers nothing until a subscription exists — click <strong>New subscription</strong>.</MessageBarBody></MessageBar>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Subscriptions" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Subscription</TableHeaderCell><TableHeaderCell>Active</TableHeaderCell>
                          <TableHeaderCell>Dead-letter</TableHeaderCell><TableHeaderCell>Max delivery</TableHeaderCell>
                          <TableHeaderCell>Session</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {subs.map((sub) => (
                            <TableRow key={sub.name}>
                              <TableCell className={s.mono}>{sub.name}</TableCell>
                              <TableCell>{sub.activeMessageCount ?? '—'}</TableCell>
                              <TableCell>{sub.deadLetterMessageCount ?? '—'}</TableCell>
                              <TableCell>{sub.maxDeliveryCount ?? '—'}</TableCell>
                              <TableCell>{sub.requiresSession ? 'yes' : 'no'}</TableCell>
                              <TableCell>
                                <Button size="small" appearance={rulesFor?.sub === sub.name && rulesFor?.topic === subsTopic ? 'primary' : 'subtle'} icon={<Filter20Regular />} onClick={() => loadRules(subsTopic, sub.name)}>Rules</Button>
                                <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delSub(subsTopic, sub.name)}>Delete</Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}

                  {rulesFor && rulesFor.topic === subsTopic && (
                    <div className={s.panel}>
                      <div className={s.toolbar}>
                        <Subtitle2>Filter rules · {rulesFor.sub}</Subtitle2>
                        <Button appearance="outline" icon={<Add20Regular />} onClick={openCreateRule}>New rule</Button>
                      </div>
                      {rules === null ? <Spinner size="tiny" label="Loading rules…" /> : rules.length === 0 ? (
                        <Caption1>No rules. A subscription with no rules receives nothing.</Caption1>
                      ) : (
                        <div className={s.tableWrap}>
                          <Table aria-label="Rules" size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Rule</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                              <TableHeaderCell>Filter</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {rules.map((rl) => (
                                <TableRow key={rl.name}>
                                  <TableCell className={s.mono}>{rl.name}</TableCell>
                                  <TableCell>{rl.filterType === 'SqlFilter' ? 'SQL' : 'Correlation'}</TableCell>
                                  <TableCell className={s.mono}>{rl.filterType === 'SqlFilter' ? (rl.sqlExpression || '—') : JSON.stringify(rl.correlationFilter || {})}</TableCell>
                                  <TableCell className={s.mono}>{rl.actionSqlExpression || '—'}</TableCell>
                                  <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delRule(rl.name)}>Delete</Button></TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                      <Caption1>Tip: a new subscription starts with a built-in <code>$Default</code> rule that matches every message. Delete it once you add a filter, or your filter is redundant.</Caption1>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* SHARED ACCESS POLICIES */}
          {!loading && !gate && tab === 'sas' && (
            <>
              <div className={s.toolbar}>
                <Button appearance="primary" icon={<Add20Regular />} onClick={() => { setAName(''); setAListen(true); setASend(true); setAManage(false); setCreateAuthOpen(true); }}>New policy</Button>
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void loadAuthRules()}>Refresh</Button>
              </div>
              {ns?.disableLocalAuth && (
                <MessageBar intent="info"><MessageBarBody>Local (SAS) auth is disabled on this namespace (Entra-only). Policies can be managed, but their keys and connection strings cannot authenticate — use Azure RBAC / Entra tokens instead.</MessageBarBody></MessageBar>
              )}
              {authRules === null ? <Spinner size="tiny" label="Loading policies…" /> : authRules.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No shared access policies. Click <strong>New policy</strong> to create one.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Shared access policies" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Policy</TableHeaderCell><TableHeaderCell>Claims</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {authRules.map((a) => (
                        <TableRow key={a.name}>
                          <TableCell className={s.mono}>{a.name}</TableCell>
                          <TableCell>{(a.rights || []).join(', ')}</TableCell>
                          <TableCell>
                            <Button size="small" appearance={keysFor === a.name ? 'primary' : 'subtle'} icon={<Key20Regular />} onClick={() => showKeys(a.name)}>Keys</Button>
                            {a.name !== 'RootManageSharedAccessKey' && <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delAuth(a.name)}>Delete</Button>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {keysFor && (
                <div className={s.panel}>
                  <div className={s.toolbar}>
                    <Subtitle2>Keys · {keysFor}</Subtitle2>
                    <Button size="small" appearance="outline" disabled={keysBusy} onClick={() => regenKeys(keysFor, 'PrimaryKey')}>Regenerate primary</Button>
                    <Button size="small" appearance="outline" disabled={keysBusy} onClick={() => regenKeys(keysFor, 'SecondaryKey')}>Regenerate secondary</Button>
                  </div>
                  {keysBusy && <Spinner size="tiny" label="Working…" />}
                  {keys && keys.localAuthDisabled && (
                    <MessageBar intent="warning"><MessageBarBody>Local auth is disabled on this namespace — SAS keys cannot authenticate. Use Entra ID (Azure RBAC) instead.</MessageBarBody></MessageBar>
                  )}
                  {keys && !keys.localAuthDisabled && (
                    <>
                      {([['Primary key', keys.primaryKey], ['Secondary key', keys.secondaryKey], ['Primary connection string', keys.primaryConnectionString], ['Secondary connection string', keys.secondaryConnectionString]] as [string, string | undefined][]).map(([label, val]) => (
                        <div className={s.keyBlock} key={label}>
                          <div className={s.toolbar}>
                            <Caption1>{label}</Caption1>
                            <Button size="small" appearance="subtle" icon={<Copy20Regular />} disabled={!val} onClick={() => copy(val)}>Copy</Button>
                          </div>
                          <code className={s.mono}>{val || '—'}</code>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* NETWORKING */}
          {!loading && !gate && tab === 'networking' && (
            <>
              <div className={s.toolbar}>
                <Subtitle2>Networking</Subtitle2>
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void loadNetwork()}>Refresh</Button>
              </div>
              {netLoading && <Spinner size="tiny" label="Loading networking…" />}
              {network && (
                <>
                  <div className={s.grid}>
                    <Caption1>Public network access</Caption1><code className={s.mono}>{network.publicNetworkAccess || '—'}</code>
                    <Caption1>Default action</Caption1><code className={s.mono}>{network.defaultAction || '—'}</code>
                    <Caption1>Trusted Microsoft services</Caption1><code className={s.mono}>{network.trustedServiceAccessEnabled ? 'allowed' : 'blocked'}</code>
                  </div>
                  <Subtitle2>IP firewall rules</Subtitle2>
                  {network.ipRules.length === 0 ? <Caption1>No IP rules configured.</Caption1> : (
                    <div className={s.tableWrap}>
                      <Table aria-label="IP rules" size="small">
                        <TableHeader><TableRow><TableHeaderCell>CIDR / IP</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>{network.ipRules.map((ip, i) => <TableRow key={i}><TableCell className={s.mono}>{ip.ipMask}</TableCell><TableCell>{ip.action || 'Allow'}</TableCell></TableRow>)}</TableBody>
                      </Table>
                    </div>
                  )}
                  <Subtitle2>Virtual network rules</Subtitle2>
                  {network.vnetRules.length === 0 ? <Caption1>No VNet subnet rules configured.</Caption1> : (
                    <div className={s.tableWrap}>
                      <Table aria-label="VNet rules" size="small">
                        <TableHeader><TableRow><TableHeaderCell>Subnet resource id</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>{network.vnetRules.map((v, i) => <TableRow key={i}><TableCell className={s.mono}>{v.subnetId}</TableCell></TableRow>)}</TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}
              <Subtitle2>Private endpoint connections</Subtitle2>
              {privateEndpoints === null ? null : privateEndpoints.length === 0 ? (
                <Caption1>No private endpoint connections.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Private endpoints" size="small">
                    <TableHeader><TableRow><TableHeaderCell>Connection</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Provisioning</TableHeaderCell></TableRow></TableHeader>
                    <TableBody>
                      {privateEndpoints.map((pe) => (
                        <TableRow key={pe.name}>
                          <TableCell className={s.mono}>{pe.name}</TableCell>
                          <TableCell><Badge appearance="tint" color={pe.connectionStatus === 'Approved' ? 'success' : pe.connectionStatus === 'Rejected' ? 'danger' : 'informative'}>{pe.connectionStatus}</Badge></TableCell>
                          <TableCell>{pe.provisioningState || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Caption1>Networking is read-only here. Change firewall rules or private endpoints via the servicebus.bicep module or the Azure portal.</Caption1>
            </>
          )}

          {/* OVERVIEW */}
          {!loading && !gate && tab === 'overview' && ns && (
            <div className={s.grid}>
              <Caption1>Namespace</Caption1><code className={s.mono}>{ns.name}</code>
              <Caption1>Location</Caption1><code className={s.mono}>{ns.location || '—'}</code>
              <Caption1>SKU / tier</Caption1><code className={s.mono}>{ns.sku || '—'}{ns.tier ? ` (${ns.tier})` : ''}</code>
              <Caption1>Endpoint</Caption1><code className={s.mono}>{ns.endpoint || '—'}</code>
              <Caption1>Provisioning</Caption1><code className={s.mono}>{ns.provisioningState || ns.status || '—'}</code>
              <Caption1>Local auth</Caption1><code className={s.mono}>{ns.disableLocalAuth ? 'disabled (Entra-only)' : 'enabled'}</code>
            </div>
          )}
          {!loading && !gate && tab === 'overview' && !ns && <Body1>Namespace properties unavailable.</Body1>}
        </div>
      </>
    } />
  );
}

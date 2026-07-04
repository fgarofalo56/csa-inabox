'use client';

/**
 * EventHubsNamespaceEditor — the tabbed overlay editor that surfaces the Event
 * Hubs namespace capabilities the Azure portal exposes but the tree can't show
 * inline: Capture configuration (per hub), Geo-DR pairing/break/failover
 * (namespace), SAS key reveal + rotation (namespace + per hub), and Private
 * endpoint connection approve/reject (namespace).
 *
 * Every control calls a real ARM-backed BFF route:
 *   - Capture          → /api/eventhubs/capture                 (GET read / PUT write)
 *   - Geo-DR           → /api/eventhubs/geodr (list) + /api/eventhubs/geodr-actions (create/break/failover)
 *   - SAS Keys         → /api/eventhubs/authrules (list) + /api/eventhubs/authrules/{rule}/keys (reveal) + …/keys/regenerate (rotate)
 *   - Private endpoints→ /api/eventhubs/private-endpoints       (GET list / POST approve|reject)
 *
 * Mirrors the Azure portal blades one-for-one (Capture / Geo-recovery / Shared
 * access policies / Networking → Private endpoint connections), Fluent v9 +
 * Loom theme. Honest infra-gates (disableLocalAuth, missing storage) surface as
 * MessageBars — never fake data. No mocks.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option,
  SpinButton, Switch, Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Archive20Regular, Globe20Regular, Key20Regular, LinkSquare20Regular,
  Eye20Regular, ArrowSync16Regular, Delete16Regular, Add20Regular,
  Checkmark16Regular, Dismiss16Regular, Copy16Regular, Shield20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  panel: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '0', marginTop: '12px' },
  row: { display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' },
  grow: { flexGrow: '1', minWidth: '180px' },
  hint: { color: tokens.colorNeutralForeground3, display: 'block' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' },
  gridWrap: { maxHeight: '340px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  stickyHead: {
    position: 'sticky', top: '0', zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `inset 0 -1px 0 ${tokens.colorNeutralStroke2}`,
  },
  actionsCell: { display: 'flex', gap: '4px', alignItems: 'center' },
  sectionTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, marginTop: '4px' },
  keyCell: { display: 'flex', gap: '4px', alignItems: 'center', minWidth: '0' },
  keyVal: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/** Small icon button that copies text to the clipboard and flashes a checkmark. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } catch { /* clipboard unavailable (insecure context) — no-op */ }
  }, [value]);
  return (
    <Tooltip content={done ? 'Copied' : label} relationship="label">
      <Button
        size="small" appearance="subtle"
        icon={done ? <Checkmark16Regular /> : <Copy16Regular />}
        onClick={copy} aria-label={label}
      />
    </Tooltip>
  );
}

const CAPTURE_ROUTE = '/api/eventhubs/capture';
const GEODR_ROUTE = '/api/eventhubs/geodr';
const GEODR_ACTIONS_ROUTE = '/api/eventhubs/geodr-actions';
const AUTH_ROUTE = '/api/eventhubs/authrules';
const PE_ROUTE = '/api/eventhubs/private-endpoints';
const NETWORK_ROUTE = '/api/eventhubs/network';

const DEFAULT_ARCHIVE_NAME_FORMAT =
  '{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

type EditorTab = 'capture' | 'networking' | 'geodr' | 'sas' | 'privateendpoints';

interface AuthRow { name: string; rights: string[]; scope: string }
interface GeoRow { name: string; role?: string; partnerNamespace?: string; provisioningState?: string }
interface PeRow { name: string; privateEndpointId?: string; connectionStatus: string; provisioningState?: string; description?: string }
interface IpRule { ipMask: string; action?: string }
interface VnetRule { subnetId: string; ignoreMissingVnetServiceEndpoint?: boolean }
interface NetworkRules {
  defaultAction?: string;
  publicNetworkAccess?: string;
  trustedServiceAccessEnabled?: boolean;
  ipRules: IpRule[];
  vnetRules: VnetRule[];
}
interface AccessKeys {
  keyName?: string;
  primaryKey?: string;
  secondaryKey?: string;
  primaryConnectionString?: string;
  secondaryConnectionString?: string;
  localAuthDisabled?: boolean;
}

export interface EventHubsNamespaceEditorProps {
  open: boolean;
  /** Event hub name for the Capture tab + per-hub SAS rules; '' for namespace-only. */
  hub: string;
  initialTab?: EditorTab;
  onClose: () => void;
  /** Called after any successful mutation so the parent tree can refresh. */
  onSaved?: () => void;
}

export function EventHubsNamespaceEditor({ open, hub, initialTab = 'capture', onClose, onSaved }: EventHubsNamespaceEditorProps) {
  const [tab, setTab] = useState<EditorTab>(initialTab);

  useEffect(() => { if (open) setTab(hub ? initialTab : (initialTab === 'capture' ? 'geodr' : initialTab)); }, [open, initialTab, hub]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '820px' }}>
        <DialogBody>
          <DialogTitle>Event Hubs namespace{hub ? ` — ${hub}` : ''}</DialogTitle>
          <DialogContent>
            <TabList selectedValue={tab} onTabSelect={(_, dt) => setTab(dt.value as EditorTab)}>
              {hub && <Tab value="capture" icon={<Archive20Regular />}>Capture</Tab>}
              <Tab value="networking" icon={<Shield20Regular />}>Networking</Tab>
              <Tab value="geodr" icon={<Globe20Regular />}>Geo-recovery</Tab>
              <Tab value="sas" icon={<Key20Regular />}>SAS keys</Tab>
              <Tab value="privateendpoints" icon={<LinkSquare20Regular />}>Private endpoints</Tab>
            </TabList>

            {tab === 'capture' && hub && <CaptureTab hub={hub} onSaved={onSaved} />}
            {tab === 'networking' && <NetworkingTab onSaved={onSaved} />}
            {tab === 'geodr' && <GeoDrTab onSaved={onSaved} />}
            {tab === 'sas' && <SasTab hub={hub} onSaved={onSaved} />}
            {tab === 'privateendpoints' && <PrivateEndpointsTab onSaved={onSaved} />}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ===================================================================
// Capture tab (per hub)
// ===================================================================
function CaptureTab({ hub, onSaved }: { hub: string; onSaved?: () => void }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [storageId, setStorageId] = useState('');
  const [container, setContainer] = useState('captures');
  const [intervalSec, setIntervalSec] = useState(300);
  const [sizeMb, setSizeMb] = useState(300);
  const [archiveFormat, setArchiveFormat] = useState(DEFAULT_ARCHIVE_NAME_FORMAT);
  const [skipEmpty, setSkipEmpty] = useState(false);
  const [destination, setDestination] = useState<'BlockBlob' | 'DataLake'>('BlockBlob');

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setMsg(null); setGate(null);
    try {
      const j = await readJson(await fetch(`${CAPTURE_ROUTE}?hub=${encodeURIComponent(hub)}`));
      if (j.code === 'not_configured') { setGate(j.missing || 'LOOM_EVENTHUB_NAMESPACE'); return; }
      if (!j.ok) { setErr(j.error || 'failed to read capture config'); return; }
      const c = j.capture;
      if (c) {
        setEnabled(!!c.enabled);
        setStorageId(c.storageAccountResourceId || '');
        setContainer(c.blobContainer || 'captures');
        setIntervalSec(typeof c.intervalInSeconds === 'number' ? c.intervalInSeconds : 300);
        setSizeMb(typeof c.sizeLimitInBytes === 'number' ? Math.round(c.sizeLimitInBytes / 1048576) : 300);
        setArchiveFormat(c.archiveNameFormat || DEFAULT_ARCHIVE_NAME_FORMAT);
        setSkipEmpty(!!c.skipEmptyArchives);
        setDestination(c.destination === 'DataLake' ? 'DataLake' : 'BlockBlob');
      } else {
        setEnabled(false);
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [hub]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true); setErr(null); setMsg(null);
    try {
      const payload: any = { hub, enabled };
      if (enabled) {
        if (!storageId.trim()) { setErr('Storage account resource ID is required to enable capture.'); setSaving(false); return; }
        if (!container.trim()) { setErr('Blob container is required to enable capture.'); setSaving(false); return; }
        payload.storageAccountResourceId = storageId.trim();
        payload.blobContainer = container.trim();
        payload.intervalInSeconds = intervalSec;
        payload.sizeLimitInBytes = sizeMb * 1048576;
        payload.archiveNameFormat = archiveFormat.trim() || DEFAULT_ARCHIVE_NAME_FORMAT;
        payload.skipEmptyArchives = skipEmpty;
        payload.destination = destination;
      }
      const j = await readJson(await fetch(CAPTURE_ROUTE, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }));
      if (j.code === 'not_configured') { setGate(j.missing || 'LOOM_EVENTHUB_NAMESPACE'); return; }
      if (!j.ok) { setErr(j.error || 'failed to save capture config'); return; }
      setMsg(enabled ? `Capture enabled on ${hub} (Avro → ${destination === 'DataLake' ? 'ADLS Gen2' : 'Blob Storage'}).` : `Capture disabled on ${hub}.`);
      onSaved?.();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [hub, enabled, storageId, container, intervalSec, sizeMb, archiveFormat, skipEmpty, destination, onSaved]);

  if (gate) return <GateBar missing={gate} />;

  return (
    <div className={s.panel}>
      {loading ? <Spinner size="tiny" label="Loading capture config…" /> : (
        <>
          <Field>
            <Switch checked={enabled} onChange={(_, d) => setEnabled(d.checked)} label={enabled ? 'Capture enabled' : 'Capture disabled'} />
          </Field>
          {enabled && (
            <>
              <Field label="Storage account resource ID" required hint="ARM id of a Blob Storage or ADLS Gen2 account, e.g. /subscriptions/…/storageAccounts/myacct.">
                <Input value={storageId} onChange={(_, v) => setStorageId(v.value)} placeholder="/subscriptions/.../resourceGroups/.../providers/Microsoft.Storage/storageAccounts/myacct" />
              </Field>
              <div className={s.row}>
                <Field label="Blob container" required className={s.grow}>
                  <Input value={container} onChange={(_, v) => setContainer(v.value)} placeholder="captures" />
                </Field>
                <Field label="Destination">
                  <Dropdown value={destination === 'DataLake' ? 'Azure Data Lake Storage Gen2' : 'Azure Blob Storage'} selectedOptions={[destination]} onOptionSelect={(_, d) => setDestination((d.optionValue as 'BlockBlob' | 'DataLake') || 'BlockBlob')}>
                    <Option value="BlockBlob" text="Azure Blob Storage">Azure Blob Storage</Option>
                    <Option value="DataLake" text="Azure Data Lake Storage Gen2">Azure Data Lake Storage Gen2</Option>
                  </Dropdown>
                </Field>
              </div>
              <div className={s.row}>
                <Field label="Time window (seconds)" hint="60–900">
                  <SpinButton min={60} max={900} step={30} value={intervalSec} onChange={(_, d) => { const v = d.value ?? Number(d.displayValue); if (Number.isFinite(v)) setIntervalSec(Math.max(60, Math.min(900, Number(v)))); }} />
                </Field>
                <Field label="Size window (MB)" hint="10–500">
                  <SpinButton min={10} max={500} step={10} value={sizeMb} onChange={(_, d) => { const v = d.value ?? Number(d.displayValue); if (Number.isFinite(v)) setSizeMb(Math.max(10, Math.min(500, Number(v)))); }} />
                </Field>
                <Field label="Skip empty archives">
                  <Switch checked={skipEmpty} onChange={(_, d) => setSkipEmpty(d.checked)} />
                </Field>
              </div>
              <Field label="Archive name format" hint="Must contain all 9 tokens: {Namespace} {EventHub} {PartitionId} {Year} {Month} {Day} {Hour} {Minute} {Second}.">
                <Input value={archiveFormat} onChange={(_, v) => setArchiveFormat(v.value)} input={{ style: { fontFamily: tokens.fontFamilyMonospace } }} />
              </Field>
              <Caption1 className={s.hint}>
                Avro is the only ARM-supported encoding. Parquet requires the Azure Stream Analytics no-code editor.
                The Console UAMI needs <strong>Storage Blob Data Contributor</strong> on the target storage account — without it the ARM PUT succeeds but Capture writes 403 at archive time.
              </Caption1>
            </>
          )}
          {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Capture error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
          {msg && <MessageBar intent="success"><MessageBarBody>{msg}</MessageBarBody></MessageBar>}
          <div className={s.row}>
            <Button appearance="primary" icon={<Archive20Regular />} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save capture'}</Button>
            <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={saving || loading}>Reload</Button>
          </div>
        </>
      )}
    </div>
  );
}

// ===================================================================
// Geo-DR tab (namespace)
// ===================================================================
function GeoDrTab({ onSaved }: { onSaved?: () => void }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [rows, setRows] = useState<GeoRow[]>([]);

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [alias, setAlias] = useState('');
  const [partnerId, setPartnerId] = useState('');

  // confirm dialogs
  const [confirm, setConfirm] = useState<{ action: 'delete' | 'failover'; alias: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      const j = await readJson(await fetch(GEODR_ROUTE));
      if (j.code === 'not_configured') { setGate(j.missing || 'LOOM_EVENTHUB_NAMESPACE'); return; }
      if (!j.ok) { setErr(j.error || 'failed to list Geo-DR configs'); return; }
      setRows(j.configs || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    if (!alias.trim()) { setErr('Alias name is required.'); return; }
    if (!partnerId.trim()) { setErr('Secondary namespace ARM resource ID is required.'); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const j = await readJson(await fetch(GEODR_ACTIONS_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', alias: alias.trim(), partnerNamespaceId: partnerId.trim() }),
      }));
      if (!j.ok) { setErr(j.error || 'failed to create pairing'); return; }
      setMsg(`Geo-DR pairing "${alias.trim()}" created.`);
      setShowCreate(false); setAlias(''); setPartnerId('');
      await load(); onSaved?.();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [alias, partnerId, load, onSaved]);

  const runConfirmed = useCallback(async () => {
    if (!confirm) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const j = await readJson(await fetch(GEODR_ACTIONS_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: confirm.action, alias: confirm.alias }),
      }));
      if (!j.ok) { setErr(j.error || `failed to ${confirm.action} pairing`); return; }
      setMsg(confirm.action === 'delete'
        ? `Geo-DR pairing "${confirm.alias}" broken.`
        : (j.warn || `Failover initiated on "${confirm.alias}".`));
      setConfirm(null);
      await load(); onSaved?.();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [confirm, load, onSaved]);

  if (gate) return <GateBar missing={gate} />;

  return (
    <div className={s.panel}>
      <div className={s.row}>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => { setShowCreate((v) => !v); setErr(null); }} disabled={busy}>New pairing</Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={busy || loading}>Refresh</Button>
      </div>

      {showCreate && (
        <div className={s.panel} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: '12px' }}>
          <Field label="Alias name" required>
            <Input value={alias} onChange={(_, v) => setAlias(v.value)} placeholder="loom-geodr-alias" />
          </Field>
          <Field label="Secondary namespace ARM resource ID" required hint="An existing Event Hubs namespace in another region (Standard tier or higher).">
            <Input value={partnerId} onChange={(_, v) => setPartnerId(v.value)} placeholder="/subscriptions/.../providers/Microsoft.EventHub/namespaces/secondary-ns" />
          </Field>
          <div className={s.row}>
            <Button appearance="primary" onClick={create} disabled={busy || !alias.trim() || !partnerId.trim()}>{busy ? 'Creating…' : 'Create pairing'}</Button>
            <Button appearance="secondary" onClick={() => setShowCreate(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}

      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Geo-DR error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
      {msg && <MessageBar intent="success"><MessageBarBody>{msg}</MessageBarBody></MessageBar>}

      {loading ? <Spinner size="tiny" label="Loading Geo-DR configs…" /> : (
        rows.length === 0 ? <Caption1 className={s.hint}>No Geo-DR alias configured. Create a pairing to fail over to a secondary namespace.</Caption1> : (
          <div className={s.gridWrap}>
            <Table size="small" aria-label="Geo-DR configs">
              <TableHeader className={s.stickyHead}>
                <TableRow>
                  <TableHeaderCell>Alias</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Partner namespace</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <TableRow key={g.name}>
                    <TableCell>{g.name}</TableCell>
                    <TableCell>{g.role ? <Badge size="small" appearance="tint">{g.role}</Badge> : '—'}</TableCell>
                    <TableCell>{g.partnerNamespace ? <Tooltip content={g.partnerNamespace} relationship="label"><span className={s.keyVal}>{g.partnerNamespace.split('/').pop()}</span></Tooltip> : <Caption1 className={s.hint}>—</Caption1>}</TableCell>
                    <TableCell><Caption1>{g.provisioningState || '—'}</Caption1></TableCell>
                    <TableCell>
                      <span className={s.actionsCell}>
                        <Tooltip content="Fail over to secondary (one-way)" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Globe20Regular />} onClick={() => setConfirm({ action: 'failover', alias: g.name })} disabled={busy} aria-label={`Fail over ${g.name}`} />
                        </Tooltip>
                        <Tooltip content="Break pairing" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => setConfirm({ action: 'delete', alias: g.name })} disabled={busy} aria-label={`Break pairing ${g.name}`} />
                        </Tooltip>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      )}

      <Caption1 className={s.hint}>
        Geo-DR replicates only namespace <em>metadata</em> (entities, consumer groups, SAS policies) to a paired secondary namespace — event data is NOT replicated. Clients connect to the alias FQDN. Requires Standard tier or higher.
      </Caption1>

      <Dialog open={confirm !== null} onOpenChange={(_, d) => { if (!d.open) setConfirm(null); }}>
        <DialogSurface style={{ maxWidth: '520px' }}>
          <DialogBody>
            <DialogTitle>{confirm?.action === 'failover' ? 'Confirm failover' : 'Confirm break pairing'}</DialogTitle>
            <DialogContent>
              {confirm?.action === 'failover' ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>One-way, non-reversible</MessageBarTitle>
                    Failover promotes the secondary namespace to primary and removes the original primary from the pairing for alias <strong>{confirm?.alias}</strong>. Event data is not replicated — only metadata. Re-pair after failover to restore Geo-DR protection.
                    {' '}Per Azure Event Hubs guidance, the failover REST call must target the <strong>secondary</strong> namespace's alias. This console targets the env-pinned <code>LOOM_EVENTHUB_NAMESPACE</code> — if that points at the primary, run the failover from the console bound to the secondary namespace.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Break the pairing</MessageBarTitle>
                    This removes the Geo-DR alias <strong>{confirm?.alias}</strong>. The secondary namespace becomes independent.
                  </MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={runConfirmed} disabled={busy}>{busy ? 'Working…' : (confirm?.action === 'failover' ? 'Fail over' : 'Break pairing')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// ===================================================================
// SAS keys tab (namespace + per hub)
// ===================================================================
function SasTab({ hub, onSaved }: { hub: string; onSaved?: () => void }) {
  const s = useStyles();
  const [segment, setSegment] = useState<'namespace' | 'eventhub'>('namespace');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [rules, setRules] = useState<AuthRow[]>([]);
  const [revealed, setRevealed] = useState<Record<string, AccessKeys>>({});
  const [confirm, setConfirm] = useState<{ rule: string; keyType: 'PrimaryKey' | 'SecondaryKey' } | null>(null);

  const effectiveSegment = hub ? segment : 'namespace';

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null); setRevealed({});
    try {
      const url = effectiveSegment === 'eventhub' && hub
        ? `${AUTH_ROUTE}?eventHub=${encodeURIComponent(hub)}`
        : AUTH_ROUTE;
      const j = await readJson(await fetch(url));
      if (j.code === 'not_configured') { setGate(j.missing || 'LOOM_EVENTHUB_NAMESPACE'); return; }
      if (!j.ok) { setErr(j.error || 'failed to list SAS rules'); return; }
      setRules(j.rules || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [effectiveSegment, hub]);

  useEffect(() => { void load(); }, [load]);

  const scopeQs = useCallback(() => effectiveSegment === 'eventhub' && hub
    ? `scope=eventhub&hub=${encodeURIComponent(hub)}`
    : 'scope=namespace', [effectiveSegment, hub]);

  const reveal = useCallback(async (rule: string) => {
    setBusy(true); setErr(null);
    try {
      const j = await readJson(await fetch(`${AUTH_ROUTE}/${encodeURIComponent(rule)}/keys?${scopeQs()}`, { method: 'POST' }));
      if (!j.ok) { setErr(j.error || 'failed to reveal keys'); return; }
      setRevealed((m) => ({ ...m, [rule]: j.keys || {} }));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [scopeQs]);

  const rotateConfirmed = useCallback(async () => {
    if (!confirm) return;
    setBusy(true); setErr(null);
    try {
      const j = await readJson(await fetch(`${AUTH_ROUTE}/${encodeURIComponent(confirm.rule)}/keys/regenerate?keyType=${confirm.keyType}&${scopeQs()}`, { method: 'POST' }));
      if (!j.ok) { setErr(j.error || 'failed to rotate key'); return; }
      setRevealed((m) => ({ ...m, [confirm.rule]: j.keys || {} }));
      setConfirm(null);
      onSaved?.();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [confirm, scopeQs, onSaved]);

  if (gate) return <GateBar missing={gate} />;

  return (
    <div className={s.panel}>
      {hub && (
        <TabList selectedValue={segment} onTabSelect={(_, dt) => setSegment(dt.value as 'namespace' | 'eventhub')}>
          <Tab value="namespace">Namespace rules</Tab>
          <Tab value="eventhub">{hub} rules</Tab>
        </TabList>
      )}
      <div className={s.row}>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={busy || loading}>Refresh</Button>
      </div>

      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>SAS error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

      {loading ? <Spinner size="tiny" label="Loading SAS rules…" /> : (
        rules.length === 0 ? <Caption1 className={s.hint}>No SAS policies at this scope.</Caption1> : (
          <div className={s.gridWrap}>
            <Table size="small" aria-label="SAS rules">
              <TableHeader className={s.stickyHead}>
                <TableRow>
                  <TableHeaderCell>Policy</TableHeaderCell>
                  <TableHeaderCell>Rights</TableHeaderCell>
                  <TableHeaderCell>Keys</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((a) => {
                  const k = revealed[a.name];
                  return (
                    <TableRow key={a.name}>
                      <TableCell>{a.name}</TableCell>
                      <TableCell>{a.rights.map((r) => <Badge key={r} size="small" appearance="outline" style={{ marginRight: tokens.spacingHorizontalXXS }}>{r}</Badge>)}</TableCell>
                      <TableCell>
                        {k ? (
                          k.localAuthDisabled ? (
                            <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>Entra-only (SAS disabled)</Caption1>
                          ) : (() => {
                            const conn = k.primaryConnectionString || k.primaryKey || '';
                            return (
                              <span className={s.keyCell}>
                                <span className={s.keyVal} title={conn || undefined}>{conn ? `${conn.slice(0, 44)}…` : '—'}</span>
                                {conn && <CopyButton value={conn} label="Copy primary connection string" />}
                                {k.secondaryConnectionString && <CopyButton value={k.secondaryConnectionString} label="Copy secondary connection string" />}
                              </span>
                            );
                          })()
                        ) : <Caption1 className={s.hint}>hidden</Caption1>}
                      </TableCell>
                      <TableCell>
                        <span className={s.actionsCell}>
                          <Tooltip content="Reveal keys" relationship="label">
                            <Button size="small" appearance="subtle" icon={<Eye20Regular />} onClick={() => reveal(a.name)} disabled={busy} aria-label={`Reveal keys for ${a.name}`} />
                          </Tooltip>
                          <Menu>
                            <MenuTrigger disableButtonEnhancement>
                              <Tooltip content="Rotate key" relationship="label">
                                <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} aria-label={`Rotate key for ${a.name}`} />
                              </Tooltip>
                            </MenuTrigger>
                            <MenuPopover>
                              <MenuList>
                                <MenuItem onClick={() => setConfirm({ rule: a.name, keyType: 'PrimaryKey' })}>Rotate primary key</MenuItem>
                                <MenuItem onClick={() => setConfirm({ rule: a.name, keyType: 'SecondaryKey' })}>Rotate secondary key</MenuItem>
                              </MenuList>
                            </MenuPopover>
                          </Menu>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )
      )}

      <Caption1 className={s.hint}>
        Rotating a key immediately invalidates all SAS tokens minted from it. On a namespace with <code>disableLocalAuth: true</code> (the secure default and the only allowed posture at IL5/GCC-High), key values exist in ARM but the connection strings cannot authenticate — use Azure Event Hubs Data Sender/Receiver via managed identity instead.
      </Caption1>

      <Dialog open={confirm !== null} onOpenChange={(_, d) => { if (!d.open) setConfirm(null); }}>
        <DialogSurface style={{ maxWidth: '480px' }}>
          <DialogBody>
            <DialogTitle>Rotate {confirm?.keyType === 'SecondaryKey' ? 'secondary' : 'primary'} key</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Immediate invalidation</MessageBarTitle>
                  Rotating the {confirm?.keyType === 'SecondaryKey' ? 'secondary' : 'primary'} key on <strong>{confirm?.rule}</strong> immediately invalidates every SAS token previously issued from it. Clients using that key will fail until they pick up the new key.
                </MessageBarBody>
              </MessageBar>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={rotateConfirmed} disabled={busy}>{busy ? 'Rotating…' : 'Rotate key'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// ===================================================================
// Private endpoints tab (namespace)
// ===================================================================
function peStatusColor(s?: string) {
  if (s === 'Approved') return 'success' as const;
  if (s === 'Pending') return 'warning' as const;
  if (s === 'Rejected' || s === 'Disconnected') return 'severe' as const;
  return 'informative' as const;
}

function PrivateEndpointsTab({ onSaved }: { onSaved?: () => void }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [rows, setRows] = useState<PeRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      const j = await readJson(await fetch(PE_ROUTE));
      if (j.code === 'not_configured') { setGate(j.missing || 'LOOM_EVENTHUB_NAMESPACE'); return; }
      if (!j.ok) { setErr(j.error || 'failed to list private endpoint connections'); return; }
      setRows(j.connections || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (name: string, action: 'approve' | 'reject') => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const j = await readJson(await fetch(PE_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, action }),
      }));
      if (!j.ok) { setErr(j.error || `failed to ${action} connection`); return; }
      setMsg(`Connection "${name}" ${action === 'approve' ? 'approved' : 'rejected'}.`);
      await load(); onSaved?.();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [load, onSaved]);

  if (gate) return <GateBar missing={gate} />;

  return (
    <div className={s.panel}>
      <div className={s.row}>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={busy || loading}>Refresh</Button>
      </div>

      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Private endpoints error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
      {msg && <MessageBar intent="success"><MessageBarBody>{msg}</MessageBarBody></MessageBar>}

      {loading ? <Spinner size="tiny" label="Loading connections…" /> : (
        rows.length === 0 ? <Caption1 className={s.hint}>No private endpoint connections. The namespace private endpoint provisioned by eventhubs.bicep auto-approves; manual or cross-tenant requests appear here for approval.</Caption1> : (
          <div className={s.gridWrap}>
            <Table size="small" aria-label="Private endpoint connections">
              <TableHeader className={s.stickyHead}>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Private endpoint</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell><span className={s.mono}>{c.privateEndpointId ? c.privateEndpointId.split('/').pop() : '—'}</span></TableCell>
                    <TableCell><Badge size="small" appearance="filled" color={peStatusColor(c.connectionStatus)}>{c.connectionStatus}</Badge></TableCell>
                    <TableCell><Caption1>{c.provisioningState || '—'}</Caption1></TableCell>
                    <TableCell>
                      <span className={s.actionsCell}>
                        <Tooltip content="Approve" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Checkmark16Regular />} onClick={() => act(c.name, 'approve')} disabled={busy || c.connectionStatus === 'Approved'} aria-label={`Approve ${c.name}`} />
                        </Tooltip>
                        <Tooltip content="Reject" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => act(c.name, 'reject')} disabled={busy || c.connectionStatus === 'Rejected'} aria-label={`Reject ${c.name}`} />
                        </Tooltip>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      )}

      <Caption1 className={s.hint}>
        The namespace private endpoint is provisioned by <code>eventhubs.bicep</code> with <code>groupIds: ['namespace']</code> and DNS zone <code>privatelink.servicebus.windows.net</code> (Commercial) / <code>privatelink.servicebus.usgovcloudapi.net</code> (USGov). Use this panel to approve or reject cross-tenant / manual connection requests.
      </Caption1>
    </div>
  );
}

// ===================================================================
// Networking tab (namespace) — editable IP / VNet firewall + public access
// ===================================================================
function NetworkingTab({ onSaved }: { onSaved?: () => void }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);

  const [defaultAction, setDefaultAction] = useState<'Allow' | 'Deny'>('Allow');
  const [publicAccess, setPublicAccess] = useState<'Enabled' | 'Disabled' | 'SecuredByPerimeter'>('Enabled');
  const [trustedServices, setTrustedServices] = useState(false);
  const [ipRules, setIpRules] = useState<IpRule[]>([]);
  const [vnetRules, setVnetRules] = useState<VnetRule[]>([]);
  const [newIp, setNewIp] = useState('');
  const [newSubnet, setNewSubnet] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setMsg(null); setGate(null);
    try {
      const j = await readJson(await fetch(NETWORK_ROUTE));
      if (j.code === 'not_configured') { setGate(j.missing || 'LOOM_EVENTHUB_NAMESPACE'); return; }
      if (!j.ok) { setErr(j.error || 'failed to read network rules'); return; }
      const n: NetworkRules = j.network || { ipRules: [], vnetRules: [] };
      setDefaultAction(n.defaultAction === 'Deny' ? 'Deny' : 'Allow');
      setPublicAccess((n.publicNetworkAccess as any) || 'Enabled');
      setTrustedServices(!!n.trustedServiceAccessEnabled);
      setIpRules(Array.isArray(n.ipRules) ? n.ipRules : []);
      setVnetRules(Array.isArray(n.vnetRules) ? n.vnetRules : []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addIp = () => {
    const v = newIp.trim();
    if (!v) return;
    if (ipRules.some((r) => r.ipMask === v)) { setErr(`IP rule ${v} already added.`); return; }
    setIpRules((p) => [...p, { ipMask: v, action: 'Allow' }]); setNewIp(''); setErr(null);
  };
  const addSubnet = () => {
    const v = newSubnet.trim();
    if (!v) return;
    if (vnetRules.some((r) => r.subnetId === v)) { setErr('Subnet rule already added.'); return; }
    setVnetRules((p) => [...p, { subnetId: v }]); setNewSubnet(''); setErr(null);
  };

  const save = useCallback(async () => {
    setSaving(true); setErr(null); setMsg(null);
    try {
      const j = await readJson(await fetch(NETWORK_ROUTE, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultAction, publicNetworkAccess: publicAccess, trustedServiceAccessEnabled: trustedServices, ipRules, vnetRules }),
      }));
      if (j.code === 'not_configured') { setGate(j.missing || 'LOOM_EVENTHUB_NAMESPACE'); return; }
      if (!j.ok) { setErr(j.error || 'failed to save network rules'); return; }
      const n: NetworkRules = j.network || { ipRules: [], vnetRules: [] };
      setIpRules(Array.isArray(n.ipRules) ? n.ipRules : []);
      setVnetRules(Array.isArray(n.vnetRules) ? n.vnetRules : []);
      setMsg('Networking rules saved.');
      onSaved?.();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [defaultAction, publicAccess, trustedServices, ipRules, vnetRules, onSaved]);

  if (gate) return <GateBar missing={gate} />;

  return (
    <div className={s.panel}>
      {loading ? <Spinner size="tiny" label="Loading network rules…" /> : (
        <>
          <Field label="Public network access" hint="Disabled forces all traffic through private endpoints.">
            <Dropdown
              value={publicAccess === 'SecuredByPerimeter' ? 'Secured by network security perimeter' : publicAccess === 'Disabled' ? 'Disabled' : 'Enabled (selected networks)'}
              selectedOptions={[publicAccess]}
              onOptionSelect={(_, d) => setPublicAccess((d.optionValue as any) || 'Enabled')}
            >
              <Option value="Enabled" text="Enabled (selected networks)">Enabled (selected networks)</Option>
              <Option value="Disabled" text="Disabled">Disabled</Option>
              <Option value="SecuredByPerimeter" text="Secured by network security perimeter">Secured by network security perimeter</Option>
            </Dropdown>
          </Field>
          <div className={s.row}>
            <Field label="Default action" hint="Deny = only the IP / VNet rules below may connect.">
              <Dropdown value={defaultAction} selectedOptions={[defaultAction]} onOptionSelect={(_, d) => setDefaultAction((d.optionValue as 'Allow' | 'Deny') || 'Allow')}>
                <Option value="Allow">Allow</Option>
                <Option value="Deny">Deny</Option>
              </Dropdown>
            </Field>
            <Field label="Allow trusted Microsoft services">
              <Switch checked={trustedServices} onChange={(_, d) => setTrustedServices(d.checked)} />
            </Field>
          </div>

          <div className={s.sectionTitle}>IP firewall rules</div>
          <div className={s.row}>
            <Field label="Add IP / CIDR" className={s.grow}>
              <Input value={newIp} onChange={(_, v) => setNewIp(v.value)} placeholder="13.66.201.169/32" onKeyDown={(e) => { if (e.key === 'Enter') addIp(); }} />
            </Field>
            <Button appearance="secondary" icon={<Add20Regular />} onClick={addIp}>Add IP rule</Button>
          </div>
          {ipRules.length === 0 ? <Caption1 className={s.hint}>No IP rules.</Caption1> : (
            <div className={s.gridWrap}>
              <Table size="small" aria-label="IP firewall rules">
                <TableHeader className={s.stickyHead}>
                  <TableRow><TableHeaderCell>IP / CIDR</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell><TableHeaderCell>Remove</TableHeaderCell></TableRow>
                </TableHeader>
                <TableBody>
                  {ipRules.map((r) => (
                    <TableRow key={r.ipMask}>
                      <TableCell><span className={s.mono}>{r.ipMask}</span></TableCell>
                      <TableCell><Badge size="small" appearance="outline">{r.action || 'Allow'}</Badge></TableCell>
                      <TableCell>
                        <Tooltip content="Remove IP rule" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Remove IP rule ${r.ipMask}`} onClick={() => setIpRules((p) => p.filter((x) => x.ipMask !== r.ipMask))} />
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className={s.sectionTitle}>Virtual network rules</div>
          <div className={s.row}>
            <Field label="Add subnet ARM resource ID" className={s.grow} hint="The subnet must have the Microsoft.EventHub service endpoint enabled.">
              <Input value={newSubnet} onChange={(_, v) => setNewSubnet(v.value)} placeholder="/subscriptions/.../virtualNetworks/vnet/subnets/subnet1" onKeyDown={(e) => { if (e.key === 'Enter') addSubnet(); }} />
            </Field>
            <Button appearance="secondary" icon={<Add20Regular />} onClick={addSubnet}>Add VNet rule</Button>
          </div>
          {vnetRules.length === 0 ? <Caption1 className={s.hint}>No VNet rules.</Caption1> : (
            <div className={s.gridWrap}>
              <Table size="small" aria-label="Virtual network rules">
                <TableHeader className={s.stickyHead}>
                  <TableRow><TableHeaderCell>Subnet</TableHeaderCell><TableHeaderCell>Remove</TableHeaderCell></TableRow>
                </TableHeader>
                <TableBody>
                  {vnetRules.map((r) => (
                    <TableRow key={r.subnetId}>
                      <TableCell><Tooltip content={r.subnetId} relationship="label"><span className={s.keyVal}>{r.subnetId.split('/').slice(-3).join('/')}</span></Tooltip></TableCell>
                      <TableCell>
                        <Tooltip content="Remove VNet rule" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Remove VNet rule ${r.subnetId}`} onClick={() => setVnetRules((p) => p.filter((x) => x.subnetId !== r.subnetId))} />
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Networking error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
          {msg && <MessageBar intent="success"><MessageBarBody>{msg}</MessageBarBody></MessageBar>}
          <Caption1 className={s.hint}>
            With <strong>Default action = Deny</strong> only the listed IP and VNet rules can connect; the Console UAMI&apos;s own egress IP/subnet must be allowed or this console loses access. Mirrors the Azure portal <em>Networking</em> blade.
          </Caption1>
          <div className={s.row}>
            <Button appearance="primary" icon={<Shield20Regular />} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save networking'}</Button>
            <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={saving || loading}>Reload</Button>
          </div>
        </>
      )}
    </div>
  );
}

// ===================================================================
// Shared honest infra-gate
// ===================================================================
function GateBar({ missing }: { missing: string }) {
  return (
    <MessageBar intent="warning" style={{ marginTop: '12px' }}>
      <MessageBarBody>
        <MessageBarTitle>Event Hubs namespace not configured</MessageBarTitle>
        Set <code>{missing}</code> on the Console Container App so this surface can reach a real Azure Event Hubs namespace. Provisioned by <code>platform/fiab/bicep/modules/landing-zone/eventhubs.bicep</code>.
      </MessageBarBody>
    </MessageBar>
  );
}

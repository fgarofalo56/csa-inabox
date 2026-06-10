'use client';

/**
 * WorkspaceSettingsPane — the admin workspace "Settings" flyout, one-for-one
 * with the Fabric workspace settings pane's data-platform tabs:
 *   General           → name / description (PATCH Cosmos)
 *   License           → license mode + capacity binding (PATCH + Fabric assign)
 *   Teams & SharePoint → link / create / unlink a real Microsoft 365 group (Graph)
 *   OneLake storage   → real ADLS Gen2 usage (Azure Monitor) + storage binding
 *
 * Source UI (Fabric): Workspace → Settings → License info / Teams and SharePoint
 * / OneLake storage. https://learn.microsoft.com/fabric/fundamentals/workspaces
 *
 * Every control hits a real backend (no-vaporware); the only non-functional
 * state is an honest MessageBar infra-gate. Azure-native by default — none of
 * the tabs require a Fabric workspace (no-fabric-dependency.md).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  TabList, Tab, Button, Input, Textarea, Dropdown, Option, Field, Badge,
  Spinner, Body1, Caption1, Subtitle2, Divider, Link,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular, Search16Regular, Open16Regular } from '@fluentui/react-icons';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import type { Workspace, WorkspaceLicenseMode } from '@/lib/types/workspace';

interface WsRef { id: string; name: string }
interface FabricCapacityOpt { id: string; displayName: string; sku: string; region?: string; state?: string; }
interface StorageOpt { id: string; name: string; isHns: boolean; resourceGroup?: string; }

type TabKey = 'general' | 'license' | 'm365' | 'onelake';

const LICENSE_MODES: { value: WorkspaceLicenseMode; label: string; govHidden?: boolean }[] = [
  { value: 'Org', label: 'Organizational (Azure-native)' },
  { value: 'Pro', label: 'Power BI Pro' },
  { value: 'PremiumPerUser', label: 'Premium Per User (PPU)' },
  { value: 'Premium', label: 'Premium / Fabric capacity' },
  { value: 'Embedded', label: 'Power BI Embedded' },
  { value: 'Trial', label: 'Fabric Trial', govHidden: true },
];

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalM },
  tabPanel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalM },
  applyRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalS },
  note: { color: tokens.colorNeutralForeground3, fontSize: '12px', lineHeight: 1.5 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: tokens.spacingHorizontalM },
  metricCard: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  metricValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold },
  pickerRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  resultBox: { maxHeight: '180px', overflowY: 'auto' },
  linkedRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
});

async function patchWorkspace(id: string, patch: Record<string, unknown>, isAdmin?: boolean): Promise<Workspace> {
  const url = isAdmin ? `/api/admin/workspaces/${encodeURIComponent(id)}` : `/api/workspaces/${encodeURIComponent(id)}`;
  const r = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  const j = await r.json();
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
  return (j.workspace ?? j) as Workspace;
}

function ApplyButton({ busy, error, onApply, disabled, label }: { busy: boolean; error: string | null; onApply: () => void; disabled?: boolean; label?: string }) {
  const styles = useStyles();
  return (
    <>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      <div className={styles.applyRow}>
        <Button appearance="primary" onClick={onApply} disabled={busy || disabled}>
          {busy ? <Spinner size="tiny" /> : (label || 'Apply')}
        </Button>
      </div>
    </>
  );
}

interface Props {
  workspace: WsRef | null;
  onClose: () => void;
  onSaved: (ws: Workspace) => void;
  isAdmin?: boolean;
}

export function WorkspaceSettingsPane({ workspace, onClose, onSaved, isAdmin }: Props) {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('general');
  const [full, setFull] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true); setLoadError(null);
    try {
      const url = isAdmin ? `/api/admin/workspaces/${encodeURIComponent(id)}` : `/api/workspaces/${encodeURIComponent(id)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok || j?.ok === false) { setLoadError(j?.error || `HTTP ${r.status}`); return; }
      setFull((j.workspace ?? j) as Workspace);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (workspace?.id) { setTab('general'); void load(workspace.id); }
    else setFull(null);
  }, [workspace?.id, load]);

  const handleSaved = (ws: Workspace) => { setFull(ws); onSaved(ws); };

  if (!workspace) return null;

  return (
    <Drawer open onOpenChange={(_e, d) => { if (!d.open) onClose(); }} position="end" size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />}>
          Workspace settings — {workspace.name}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.body}>
          <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as TabKey)} size="small">
            <Tab value="general">General</Tab>
            <Tab value="license">License</Tab>
            <Tab value="m365">Teams &amp; SharePoint</Tab>
            <Tab value="onelake">OneLake storage</Tab>
          </TabList>

          {loading && <Spinner size="tiny" label="Loading workspace…" />}
          {loadError && <MessageBar intent="error"><MessageBarBody>{loadError}</MessageBarBody></MessageBar>}

          {full && tab === 'general' && <GeneralTab ws={full} isAdmin={isAdmin} onSaved={handleSaved} />}
          {full && tab === 'license' && <LicenseTab ws={full} isAdmin={isAdmin} onSaved={handleSaved} />}
          {full && tab === 'm365' && <M365Tab ws={full} onSaved={handleSaved} />}
          {full && tab === 'onelake' && <OneLakeTab ws={full} isAdmin={isAdmin} onSaved={handleSaved} />}
        </div>
      </DrawerBody>
    </Drawer>
  );
}

// ============================================================
// General
// ============================================================

function GeneralTab({ ws, isAdmin, onSaved }: { ws: Workspace; isAdmin?: boolean; onSaved: (w: Workspace) => void }) {
  const styles = useStyles();
  const [name, setName] = useState(ws.name);
  const [description, setDescription] = useState(ws.description || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setName(ws.name); setDescription(ws.description || ''); }, [ws.id]);

  const apply = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await patchWorkspace(ws.id, { name, description }, isAdmin)); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.tabPanel}>
      <Field label="Name"><Input value={name} onChange={(_e, d) => setName(d.value)} /></Field>
      <Field label="Description"><Textarea value={description} rows={4} resize="vertical" onChange={(_e, d) => setDescription(d.value)} /></Field>
      {ws.contacts && ws.contacts.length > 0 && (
        <Caption1 className={styles.note}>Contacts: {ws.contacts.join(', ')}</Caption1>
      )}
      <ApplyButton busy={busy} error={err} onApply={apply} disabled={!name.trim()} />
    </div>
  );
}

// ============================================================
// License
// ============================================================

function LicenseTab({ ws, isAdmin, onSaved }: { ws: Workspace; isAdmin?: boolean; onSaved: (w: Workspace) => void }) {
  const styles = useStyles();
  const gov = isGovCloud();
  const [licenseMode, setLicenseMode] = useState<WorkspaceLicenseMode>(ws.licenseMode || 'Org');
  const [capacity, setCapacity] = useState(ws.capacity || '');
  const [caps, setCaps] = useState<FabricCapacityOpt[] | null>(null);
  const [capGate, setCapGate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setLicenseMode(ws.licenseMode || 'Org'); setCapacity(ws.capacity || ''); }, [ws.id]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/scaling/capacity').then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.ok === false || !Array.isArray(j?.capacities)) { setCapGate(j?.hint || j?.error || 'Fabric capacity API not available.'); setCaps([]); }
        else setCaps(j.capacities);
      })
      .catch((e) => { if (!cancelled) { setCapGate(String(e?.message || e)); setCaps([]); } });
    return () => { cancelled = true; };
  }, []);

  const apply = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await patchWorkspace(ws.id, { licenseMode, capacity: capacity || '' }, isAdmin)); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const selectedCapName = caps?.find((c) => c.id === capacity)?.displayName;
  const ca = ws.capacityAssignment;

  return (
    <div className={styles.tabPanel}>
      <div className={styles.badgeRow}>
        <Badge appearance="tint" color="brand">Mode: {ws.licenseMode || 'Org'}</Badge>
        {ws.capacity && <Badge appearance="tint">Capacity: {ws.capacity.split('/').pop()}</Badge>}
        {ca?.status && <Badge appearance="outline" color={ca.status === 'assigned' ? 'success' : ca.status === 'failed' ? 'danger' : 'warning'}>{ca.status}</Badge>}
      </div>
      {ca?.status === 'failed' && ca.error && <Caption1 className={styles.note}>Last assignment error: {ca.error}</Caption1>}
      {ca?.status === 'queued' && ca.queuedReason && <Caption1 className={styles.note}>{ca.queuedReason}</Caption1>}

      <Field label="License mode">
        <Dropdown
          selectedOptions={[licenseMode]}
          value={LICENSE_MODES.find((m) => m.value === licenseMode)?.label || licenseMode}
          onOptionSelect={(_e, d) => setLicenseMode(d.optionValue as WorkspaceLicenseMode)}
        >
          {LICENSE_MODES.filter((m) => !(m.govHidden && gov)).map((m) => <Option key={m.value} value={m.value}>{m.label}</Option>)}
        </Dropdown>
      </Field>

      {capGate ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Fabric capacity not configured</MessageBarTitle>
            {capGate} Assign capacity via the Azure portal, or set LOOM_UAMI_CLIENT_ID and enable the Fabric API toggle. The workspace runs on the Azure-native default meanwhile.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <Field label="Capacity">
          <Dropdown
            placeholder={caps === null ? 'Loading…' : 'None (Azure-native default)'}
            disabled={caps === null}
            value={selectedCapName || ''}
            selectedOptions={capacity ? [capacity] : ['']}
            onOptionSelect={(_e, d) => setCapacity(d.optionValue || '')}
          >
            <Option value="">None (Azure-native default)</Option>
            {(caps || []).map((c) => (
              <Option key={c.id} value={c.id} text={c.displayName}>
                {c.displayName} ({c.sku}){c.region ? ` — ${c.region}` : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}
      <Caption1 className={styles.note}>
        Capacity binding takes effect on the first Power BI artifact created in the workspace. The Azure-native path needs no capacity.
      </Caption1>
      <ApplyButton busy={busy} error={err} onApply={apply} />
    </div>
  );
}

// ============================================================
// Teams & SharePoint (Microsoft 365 group)
// ============================================================

function M365Tab({ ws, onSaved }: { ws: Workspace; onSaved: (w: Workspace) => void }) {
  const styles = useStyles();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: string; displayName: string; mail?: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); setGate(null); return; }
    const id = setTimeout(async () => {
      setSearching(true); setGate(null);
      try {
        const r = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(term)}&kind=group`);
        const j = await r.json();
        if (r.status === 503 || j?.ok === false) { setGate(j?.remediation || j?.error || 'Microsoft Graph group search is not configured.'); setResults([]); }
        else setResults((j.results || []).map((g: any) => ({ id: g.id, displayName: g.displayName, mail: g.mail })));
      } catch (e: any) { setGate(e?.message || String(e)); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const callM365 = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/workspaces/${encodeURIComponent(ws.id)}/m365`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) { setErr(j?.hint || j?.error || `HTTP ${r.status}`); return; }
      onSaved(j.workspace as Workspace);
      setQ(''); setResults([]);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  if (ws.m365GroupId) {
    return (
      <div className={styles.tabPanel}>
        <Subtitle2>Linked Microsoft 365 group</Subtitle2>
        <div className={styles.linkedRow}>
          <div className={styles.badgeRow}>
            <Badge appearance="tint" color="success">{ws.m365GroupName || ws.m365GroupId}</Badge>
          </div>
          {ws.m365SiteUrl ? (
            <Link href={ws.m365SiteUrl} target="_blank">Open SharePoint site <Open16Regular /></Link>
          ) : (
            <Caption1 className={styles.note}>SharePoint site URL not resolved yet (site may still be provisioning, or grant the UAMI Sites.Read.All to surface it).</Caption1>
          )}
        </div>
        {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        <Button appearance="secondary" disabled={busy} onClick={() => callM365({ action: 'unlink' })}>
          {busy ? <Spinner size="tiny" /> : 'Unlink group'}
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.tabPanel}>
      <Body1>Link this workspace to a Microsoft 365 group so its members collaborate over the group&apos;s SharePoint document library — the same backing Fabric uses for a workspace.</Body1>

      <Subtitle2>Link an existing group</Subtitle2>
      <Field label="Search Microsoft 365 groups">
        <Input value={q} onChange={(_e, d) => setQ(d.value)} contentBefore={<Search16Regular />} placeholder="Start typing a group name…" />
      </Field>
      {searching && <Spinner size="tiny" label="Searching Entra groups…" />}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Group search unavailable</MessageBarTitle>{gate}</MessageBarBody>
        </MessageBar>
      )}
      {results.length > 0 && (
        <div className={styles.resultBox}>
          {results.map((g) => (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 4px', gap: 8 }}>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span>{g.displayName}</span>
                {g.mail && <Caption1 className={styles.note}>{g.mail}</Caption1>}
              </span>
              <Button size="small" disabled={busy} onClick={() => callM365({ action: 'link', groupId: g.id })}>Link</Button>
            </div>
          ))}
        </div>
      )}

      <Divider />
      <Subtitle2>Create a new group for this workspace</Subtitle2>
      <Caption1 className={styles.note}>
        Creates a Microsoft 365 unified group named “{ws.name}” and links it. Requires the Console UAMI to hold the Group.Create / Group.ReadWrite.All Graph permission (set LOOM_WORKSPACE_M365_LINK=true).
      </Caption1>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      <Button appearance="primary" disabled={busy} onClick={() => callM365({ action: 'create' })}>
        {busy ? <Spinner size="tiny" /> : 'Create & link group'}
      </Button>
    </div>
  );
}

// ============================================================
// OneLake storage
// ============================================================

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

interface StorageMetrics {
  ok: boolean; gate?: boolean; error?: string; hint?: string;
  storageAccountId?: string; storageAccountIsDefault?: boolean;
  blobCapacityBytes?: number | null; indexCapacityBytes?: number | null;
  blobCount?: number | null; containerCount?: number | null;
  containers?: Array<{ name: string; usedBytes: number }>;
}

function OneLakeTab({ ws, isAdmin, onSaved }: { ws: Workspace; isAdmin?: boolean; onSaved: (w: Workspace) => void }) {
  const styles = useStyles();
  const [metrics, setMetrics] = useState<StorageMetrics | null>(null);
  const [mLoading, setMLoading] = useState(true);
  const [storage, setStorage] = useState<StorageOpt[] | null>(null);
  const [storageGate, setStorageGate] = useState<string | null>(null);
  const [selected, setSelected] = useState(ws.storageAccountId || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setSelected(ws.storageAccountId || ''); }, [ws.id, ws.storageAccountId]);

  useEffect(() => {
    let cancelled = false;
    setMLoading(true);
    fetch(`/api/admin/workspaces/${encodeURIComponent(ws.id)}/storage-metrics`).then((r) => r.json())
      .then((j) => { if (!cancelled) setMetrics(j); })
      .catch((e) => { if (!cancelled) setMetrics({ ok: false, error: String(e?.message || e) }); })
      .finally(() => { if (!cancelled) setMLoading(false); });
    fetch('/api/storage/accounts').then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.ok && Array.isArray(j.accounts)) setStorage(j.accounts.map((a: any) => ({ id: a.id, name: a.name, isHns: a.isHns, resourceGroup: a.resourceGroup })));
        else { setStorage([]); setStorageGate(j?.hint || j?.error || 'Could not list storage accounts.'); }
      })
      .catch((e) => { if (!cancelled) { setStorage([]); setStorageGate(String(e?.message || e)); } });
    return () => { cancelled = true; };
  }, [ws.id]);

  const saveBinding = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await patchWorkspace(ws.id, { storageAccountId: selected || '' }, isAdmin)); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const selectedName = storage?.find((sx) => sx.id === selected)?.name;

  return (
    <div className={styles.tabPanel}>
      <Subtitle2>OneLake usage</Subtitle2>
      {mLoading && <Spinner size="tiny" label="Reading storage metrics…" />}
      {!mLoading && metrics && metrics.ok === false && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Storage usage unavailable</MessageBarTitle>
            {metrics.error} {metrics.hint}
          </MessageBarBody>
        </MessageBar>
      )}
      {!mLoading && metrics && metrics.ok && (
        <>
          <div className={styles.metricGrid}>
            <div className={styles.metricCard}>
              <Caption1 className={styles.note}>Blob capacity</Caption1>
              <span className={styles.metricValue}>{formatBytes(metrics.blobCapacityBytes)}</span>
            </div>
            <div className={styles.metricCard}>
              <Caption1 className={styles.note}>ADLS Gen2 index</Caption1>
              <span className={styles.metricValue}>{formatBytes(metrics.indexCapacityBytes)}</span>
            </div>
            <div className={styles.metricCard}>
              <Caption1 className={styles.note}>Blobs</Caption1>
              <span className={styles.metricValue}>{metrics.blobCount != null ? Math.round(metrics.blobCount).toLocaleString() : '—'}</span>
            </div>
            <div className={styles.metricCard}>
              <Caption1 className={styles.note}>Containers</Caption1>
              <span className={styles.metricValue}>{metrics.containerCount != null ? Math.round(metrics.containerCount).toLocaleString() : '—'}</span>
            </div>
          </div>
          <Caption1 className={styles.note}>
            Account: <code>{metrics.storageAccountId?.split('/').pop()}</code>
            {metrics.storageAccountIsDefault ? ' (deployment default)' : ' (bound to this workspace)'} · live from Azure Monitor.
          </Caption1>
          {metrics.containers && metrics.containers.length > 0 && (
            <Caption1 className={styles.note}>
              Container usage: {metrics.containers.map((c) => `${c.name} ${formatBytes(c.usedBytes)}`).join(' · ')}
            </Caption1>
          )}
        </>
      )}

      <Divider />
      <Subtitle2>Storage account binding</Subtitle2>
      {storageGate ? (
        <MessageBar intent="warning">
          <MessageBarBody>{storageGate} The deployment-default ADLS account is used otherwise.</MessageBarBody>
        </MessageBar>
      ) : (
        <Field label="ADLS Gen2 account">
          <Dropdown
            placeholder={storage === null ? 'Loading…' : 'Deployment default'}
            disabled={storage === null}
            value={selectedName || (selected ? selected.split('/').pop() : 'Deployment default')}
            selectedOptions={selected ? [selected] : ['']}
            onOptionSelect={(_e, d) => setSelected(d.optionValue || '')}
          >
            <Option value="">Deployment default</Option>
            {(storage || []).map((sx) => (
              <Option key={sx.id} value={sx.id} text={sx.name}>
                {sx.name} ({sx.isHns ? 'ADLS Gen2' : 'Blob'}){sx.resourceGroup ? ` — ${sx.resourceGroup}` : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}
      <ApplyButton busy={busy} error={err} onApply={saveBinding} label="Save binding" />
    </div>
  );
}

export default WorkspaceSettingsPane;

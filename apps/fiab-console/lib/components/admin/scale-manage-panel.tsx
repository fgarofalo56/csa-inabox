'use client';

/**
 * ScaleManagePanel — Admin → Capacity & compute "Scale & manage".
 *
 * Web-3.0 cards over the Azure-native compute Loom runs on, wired to the real
 * scaling engine at /api/admin/scaling/compute:
 *   - ADX cluster        → change SKU (+ implicit capacity) via a dropdown
 *   - Synapse SQL pool    → Pause / Resume
 *   - Self-hosted IR VMSS → Start (scale to 4) / Stop (scale to 0)
 *   - Purview self-hosted IR (shared) → Start/Stop + "Register Purview SHIR"
 *       (PUT the scanning-dataplane IR + read its auth key — automates the
 *        previously-manual portal bootstrap; server-side honest-gates when
 *        Purview / the VMSS are absent)
 *
 * GET lists only the resources present in this deployment (honest — unconfigured
 * ones are simply absent). Every action POSTs real ARM through the route; the
 * card shows live state, a busy state, and verbatim errors. No mock data, no
 * Fabric. Fluent v9 + Loom tokens.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Badge, Button, Caption1, Body1, Subtitle2, Spinner, Select,
  Input, Field, Link, Divider,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play16Regular, Pause16Regular, ArrowSync16Regular, ArrowUp16Regular,
  CloudArrowUp16Regular, Add16Regular, Open16Regular, ShieldKeyhole16Regular,
  DatabasePerson24Regular, Server24Regular, Flash24Regular, PlugConnected24Regular,
} from '@fluentui/react-icons';

interface Scalable {
  kind: 'adx' | 'synapse-pool' | 'shir-vmss' | 'purview-shir-vmss';
  name: string;
  sku?: string;
  capacity?: number;
  state?: string;
  skuOptions?: string[];
  actions: string[];
}

const KIND_META: Record<Scalable['kind'], { label: string; icon: ReactNode; accent: string }> = {
  'adx': { label: 'Azure Data Explorer cluster', icon: <Flash24Regular />, accent: '#1f6feb' },
  'synapse-pool': { label: 'Synapse dedicated SQL pool', icon: <DatabasePerson24Regular />, accent: '#7d6cff' },
  'shir-vmss': { label: 'Self-hosted integration runtime', icon: <Server24Regular />, accent: '#21c08a' },
  'purview-shir-vmss': { label: 'Purview self-hosted IR (shared)', icon: <Server24Regular />, accent: '#e066b0' },
};

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: tokens.spacingHorizontalL },
  card: {
    position: 'relative', overflow: 'hidden',
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  accent: { position: 'absolute', insetInlineStart: 0, insetBlockStart: 0, insetBlockEnd: 0, width: '4px' },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  iconWrap: {
    width: '40px', height: '40px', borderRadius: tokens.borderRadiusMedium, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
  },
  meta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: '2px' },
  controls: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL },
  mvnetCard: {
    position: 'relative', overflow: 'hidden',
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '880px',
  },
  peList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  peRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
    padding: tokens.spacingVerticalXS + ' ' + tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2,
  },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  formRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  code: {
    display: 'block', fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalXS + ' ' + tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusSmall, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    marginTop: tokens.spacingVerticalXS,
  },
});

function stateColor(s?: string): 'success' | 'warning' | 'danger' | 'informative' {
  const v = (s || '').toLowerCase();
  if (/running|online|available|succeeded|\bnodes\b/.test(v)) return 'success';
  if (/start|resum|scal|updat|pend|provision/.test(v)) return 'warning';
  if (/paus|stop|offline|fail/.test(v)) return 'danger';
  return 'informative';
}

export function ScaleManagePanel() {
  const s = useStyles();
  const [items, setItems] = useState<Scalable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [skuSel, setSkuSel] = useState<Record<string, string>>({});
  const [nodeSel, setNodeSel] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/admin/scaling/compute', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setItems([]); return; }
      setItems(j.resources || []);
    } catch (e: any) { setError(e?.message || String(e)); setItems([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (it: Scalable, body: Record<string, unknown>) => {
    setBusy(it.kind + it.name); setMsg(null);
    try {
      const r = await fetch('/api/admin/scaling/compute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: it.kind, ...body }),
      });
      const j = await r.json();
      setMsg({ id: it.kind + it.name, text: j.ok ? (j.message || 'Requested.') : (j.error || 'failed'), ok: !!j.ok });
      if (j.ok) setTimeout(() => { void load(); }, 1500);
    } catch (e: any) { setMsg({ id: it.kind + it.name, text: e?.message || String(e), ok: false }); }
    finally { setBusy(null); }
  }, [load]);

  // Automate the Purview self-hosted IR bootstrap: PUT the scanning-dataplane IR
  // + read its auth key (real REST), so the operator no longer hand-creates it in
  // the portal. Honest-gates server-side when Purview / the VMSS are absent.
  const registerPurviewShir = useCallback(async (it: Scalable) => {
    const id = it.kind + it.name;
    setBusy(id); setMsg(null);
    try {
      const r = await fetch('/api/admin/scaling/compute/register-purview-shir', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const j = await r.json();
      setMsg({ id, text: j.ok ? (j.message || 'Purview SHIR registered.') : (j.error || 'failed'), ok: !!j.ok });
      if (j.ok) setTimeout(() => { void load(); }, 1500);
    } catch (e: any) { setMsg({ id, text: e?.message || String(e), ok: false }); }
    finally { setBusy(null); }
  }, [load]);

  const scalables: ReactNode =
    items === null ? (
      <Spinner size="tiny" label="Reading Azure-native compute…" />
    ) : error ? (
      <MessageBar intent="warning"><MessageBarBody>Couldn’t read scalable compute: {error}. The Console UAMI needs Contributor on the ADX / Synapse / VMSS resources.</MessageBarBody></MessageBar>
    ) : items.length === 0 ? (
      <MessageBar intent="info"><MessageBarBody>No Azure-native scalable compute detected in this deployment (ADX cluster, Synapse dedicated pool, or self-hosted IR). They appear here once provisioned.</MessageBarBody></MessageBar>
    ) : (
      <div className={s.grid}>
      {items.map((it) => {
        const id = it.kind + it.name;
        const m = KIND_META[it.kind];
        const isBusy = busy === id;
        const sel = skuSel[id] ?? it.sku ?? it.skuOptions?.[0] ?? '';
        const nodes = nodeSel[id] ?? (typeof it.capacity === 'number' ? it.capacity : 0);
        return (
          <div key={id} className={s.card}>
            <div className={s.accent} style={{ backgroundColor: m.accent }} aria-hidden />
            <div className={s.head}>
              <span className={s.iconWrap} style={{ backgroundColor: m.accent }} aria-hidden>{m.icon}</span>
              <div style={{ minWidth: 0 }}>
                <Subtitle2 style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</Subtitle2>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{m.label}</Caption1>
              </div>
            </div>
            <div className={s.meta}>
              <Badge appearance="filled" color={stateColor(it.state)}>{it.state || 'unknown'}</Badge>
              {it.sku && <Caption1>SKU: <code>{it.sku}</code></Caption1>}
              {typeof it.capacity === 'number' && <Caption1>· capacity {it.capacity}</Caption1>}
            </div>

            <div className={s.controls}>
              {it.kind === 'adx' && it.skuOptions && (
                <>
                  <Select value={sel} onChange={(_, d) => setSkuSel((p) => ({ ...p, [id]: d.value }))} disabled={isBusy} style={{ flex: 1, minWidth: 180 }}>
                    {it.skuOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                  <Button size="small" appearance="primary" icon={<ArrowUp16Regular />} disabled={isBusy || sel === it.sku}
                    onClick={() => act(it, { action: 'scale', sku: sel })}>
                    {isBusy ? 'Scaling…' : 'Apply SKU'}
                  </Button>
                </>
              )}
              {it.kind === 'synapse-pool' && (
                <>
                  <Button size="small" appearance="primary" icon={<Play16Regular />} disabled={isBusy || /online|resum/i.test(it.state || '')}
                    onClick={() => act(it, { action: 'resume' })}>Resume</Button>
                  <Button size="small" icon={<Pause16Regular />} disabled={isBusy || /paus/i.test(it.state || '')}
                    onClick={() => act(it, { action: 'pause' })}>Pause</Button>
                </>
              )}
              {(it.kind === 'shir-vmss' || it.kind === 'purview-shir-vmss') && (
                <>
                  <Select
                    value={String(nodes)}
                    onChange={(_, d) => setNodeSel((p) => ({ ...p, [id]: Number(d.value) }))}
                    disabled={isBusy}
                    aria-label={`Node count for ${it.name}`}
                    style={{ width: 120 }}
                  >
                    {[0, 1, 2, 3, 4, 6, 8].map((n) => (
                      <option key={n} value={n}>{n === 0 ? 'Stop (0)' : `${n} node${n === 1 ? '' : 's'}`}</option>
                    ))}
                  </Select>
                  <Button size="small" appearance="primary"
                    icon={isBusy ? <Spinner size="tiny" /> : (nodes === 0 ? <Pause16Regular /> : <Play16Regular />)}
                    disabled={isBusy || nodes === (it.capacity ?? 0)}
                    onClick={() => act(it, { action: 'scale', capacity: nodes })}>
                    {isBusy ? 'Scaling…' : (nodes === 0 ? 'Stop' : 'Set nodes')}
                  </Button>
                </>
              )}
              {it.kind === 'purview-shir-vmss' && (
                <Button size="small" appearance="outline" icon={<CloudArrowUp16Regular />} disabled={isBusy}
                  onClick={() => registerPurviewShir(it)}
                  title="Register the Purview self-hosted integration runtime and retrieve its auth key (real scanning-dataplane REST)">
                  {isBusy ? 'Working…' : 'Register Purview SHIR'}
                </Button>
              )}
              <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={isBusy} title="Refresh state" aria-label={`Refresh ${it.name}`} />
            </div>

            {msg && msg.id === id && (
              <MessageBar intent={msg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalXS }}>
                <MessageBarBody>{msg.text}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        );
      })}
      </div>
    );

  return (
    <div className={s.stack}>
      {scalables}
      <PurviewManagedVnetSection />
    </div>
  );
}

// ============================================================
// Managed VNet IR + private endpoints — the SERVERLESS, no-SHIR path for
// scanning PE-locked Azure sources with Microsoft Purview. Self-contained: does
// its own GET against /api/admin/scaling/compute/purview-managed-vnet and
// honest-gates when Purview is unconfigured. Wired to real scanning-dataplane
// REST (managed virtual networks + managed private endpoints). The managed PE
// lands "Pending" — approval on the target resource is a separate ARM action,
// surfaced here as a clear next step (not auto-performed).
// ============================================================

interface ManagedPe {
  name?: string;
  groupId?: string;
  privateLinkResourceId?: string;
  connectionState?: string;
  provisioningState?: string;
}
interface MvnetState {
  purviewConfigured: boolean;
  purviewAccount?: string | null;
  mvnetName: string;
  irName: string;
  irPresent: boolean;
  managedPrivateEndpoints: ManagedPe[];
}

const PE_GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: 'dfs', label: 'ADLS Gen2 — dfs (Data Lake)' },
  { value: 'blob', label: 'Storage — blob' },
  { value: 'sqlServer', label: 'Azure SQL — sqlServer' },
  { value: 'file', label: 'Storage — file' },
  { value: 'queue', label: 'Storage — queue' },
  { value: 'table', label: 'Storage — table' },
  { value: 'vault', label: 'Key Vault — vault' },
];

function peStateColor(v?: string): 'success' | 'warning' | 'danger' | 'informative' {
  const x = (v || '').toLowerCase();
  if (/approv|succeed|connected/.test(x)) return 'success';
  if (/pend|provision|initial/.test(x)) return 'warning';
  if (/reject|fail|disconnect/.test(x)) return 'danger';
  return 'informative';
}

function PurviewManagedVnetSection() {
  const s = useStyles();
  const [data, setData] = useState<MvnetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; portalUrl?: string; azCli?: string } | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [groupId, setGroupId] = useState('dfs');
  const [peName, setPeName] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/admin/scaling/compute/purview-managed-vnet', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setData(null); return; }
      setData(j as MvnetState);
    } catch (e: any) { setError(e?.message || String(e)); setData(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setMsg(null);
    try {
      const r = await fetch('/api/admin/scaling/compute/purview-managed-vnet', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      setMsg({ text: j.ok ? (j.message || 'Done.') : (j.error || 'failed'), ok: !!j.ok, portalUrl: j?.nextStep?.portalUrl, azCli: j?.nextStep?.azCli });
      if (j.ok) {
        if (body.action === 'create-pe') { setResourceId(''); setPeName(''); }
        setTimeout(() => { void load(); }, 1500);
      }
    } catch (e: any) { setMsg({ text: e?.message || String(e), ok: false }); }
    finally { setBusy(null); }
  }, [load]);

  const gated = busy !== null || !data?.irPresent;

  return (
    <div className={s.mvnetCard}>
      <div className={s.accent} style={{ backgroundColor: '#e066b0' }} aria-hidden />
      <div className={s.head}>
        <span className={s.iconWrap} style={{ backgroundColor: '#e066b0' }} aria-hidden><PlugConnected24Regular /></span>
        <div style={{ minWidth: 0 }}>
          <Subtitle2 style={{ display: 'block' }}>Managed VNet IR + private endpoints</Subtitle2>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Serverless scan of PE-locked sources — Purview runs the scan in its own managed virtual network, with no self-hosted IR VMSS to run or patch.
          </Caption1>
        </div>
      </div>

      {data === null && !error && <Spinner size="tiny" label="Reading Purview managed VNet…" />}

      {error && (
        <MessageBar intent="warning"><MessageBarBody>Couldn’t read the Purview managed VNet: {error}. The Console UAMI needs Data Source Administrator on Purview.</MessageBarBody></MessageBar>
      )}

      {data && !data.purviewConfigured && (
        <MessageBar intent="warning">
          <MessageBarBody>
            Microsoft Purview isn’t provisioned in this deployment. Set <code>LOOM_PURVIEW_ACCOUNT</code> to a classic
            Purview account, then this serverless managed-VNet scan path activates — no self-hosted IR VMSS required.
          </MessageBarBody>
        </MessageBar>
      )}

      {data && data.purviewConfigured && (
        <>
          <div className={s.meta}>
            <Badge appearance="filled" color={data.irPresent ? 'success' : 'informative'}>
              {data.irPresent ? 'Managed VNet IR present' : 'Not created yet'}
            </Badge>
            <Caption1>IR: <code>{data.irName}</code> · VNet: <code>{data.mvnetName}</code></Caption1>
          </div>

          <div className={s.controls}>
            <Button size="small" appearance="primary" icon={busy === 'ir' ? <Spinner size="tiny" /> : <CloudArrowUp16Regular />}
              disabled={busy !== null}
              onClick={() => post('ir', { action: 'create-ir' })}
              title="Create the managed virtual network + the managed-VNet integration runtime (real scanning-dataplane REST)">
              {busy === 'ir' ? 'Working…' : (data.irPresent ? 'Re-apply managed-VNet IR' : 'Create managed-VNet IR')}
            </Button>
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={busy !== null} title="Refresh" aria-label="Refresh managed VNet" />
          </div>

          <Divider />

          <div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Managed private endpoints</Caption1>
            <div className={s.peList} style={{ marginTop: tokens.spacingVerticalXS }}>
              {data.managedPrivateEndpoints.length === 0 ? (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  {data.irPresent
                    ? 'No managed private endpoints yet — add one for each PE-locked source below.'
                    : 'Create the managed-VNet IR first, then add a private endpoint per source.'}
                </Caption1>
              ) : data.managedPrivateEndpoints.map((pe) => (
                <div key={pe.name} className={s.peRow}>
                  <ShieldKeyhole16Regular />
                  <Body1 style={{ fontWeight: 600 }}>{pe.name}</Body1>
                  {pe.groupId && <Caption1>group <code>{pe.groupId}</code></Caption1>}
                  <Badge appearance="tint" color={peStateColor(pe.connectionState || pe.provisioningState)}>
                    {pe.connectionState || pe.provisioningState || 'unknown'}
                  </Badge>
                  {pe.privateLinkResourceId && (
                    <Link href={`https://portal.azure.com/#@/resource${pe.privateLinkResourceId}/networking`} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>
                      Approve in portal <Open16Regular />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className={s.form}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add a managed private endpoint to a source</Caption1>
            <div className={s.formRow}>
              <Field label="Source resource id (e.g. the DLZ lake storage account)" style={{ flex: 2, minWidth: 280 }}>
                <Input value={resourceId} onChange={(_, d) => setResourceId(d.value)} placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Storage/storageAccounts/…" disabled={gated} />
              </Field>
              <Field label="Group id" style={{ minWidth: 220 }}>
                <Select value={groupId} onChange={(_, d) => setGroupId(d.value)} disabled={gated}>
                  {PE_GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              <Field label="Name (optional)" style={{ minWidth: 160 }}>
                <Input value={peName} onChange={(_, d) => setPeName(d.value)} placeholder="auto" disabled={gated} />
              </Field>
              <Button size="small" appearance="primary" icon={busy === 'pe' ? <Spinner size="tiny" /> : <Add16Regular />}
                disabled={gated || !resourceId.trim()}
                onClick={() => post('pe', { action: 'create-pe', resourceId: resourceId.trim(), groupId, name: peName.trim() || undefined })}>
                {busy === 'pe' ? 'Creating…' : 'Add private endpoint'}
              </Button>
            </div>
            {!data.irPresent && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Create the managed-VNet IR above before adding private endpoints.</Caption1>
            )}
          </div>

          <MessageBar intent="info">
            <MessageBarBody>
              Each managed private endpoint is created in a <b>Pending</b> state. The owner of the target resource
              must <b>approve</b> the private-endpoint connection (Azure portal → that resource → Networking →
              Private endpoint connections → Approve, or <code>az network private-endpoint-connection approve</code>)
              before Purview can scan through it. That approval is a separate ARM action on the source and is not
              performed here.
            </MessageBarBody>
          </MessageBar>
        </>
      )}

      {msg && (
        <MessageBar intent={msg.ok ? 'success' : 'error'}>
          <MessageBarBody>
            {msg.text}
            {msg.ok && msg.portalUrl && (
              <> <Link href={msg.portalUrl} target="_blank" rel="noreferrer">Approve the private endpoint in the Azure portal <Open16Regular /></Link></>
            )}
            {msg.ok && msg.azCli && <code className={s.code}>{msg.azCli}</code>}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

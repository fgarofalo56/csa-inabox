'use client';

/**
 * v3 — Power Platform editors (real REST, no mocks).
 *
 *   PowerPlatformEnvironmentEditor → /api/powerplatform/environments + /api/powerplatform/environments/[name]
 *   DataverseTableEditor           → /api/items/dataverse-table[?envId=][/[id]?envId=]
 *   PowerAppEditor                 → /api/items/power-app[?envId=][/[id]?envId=]
 *   PowerAutomateFlowEditor        → /api/items/power-automate-flow + /run + /runs
 *   PowerPageEditor                → /api/items/power-page
 *   AiBuilderModelEditor           → /api/items/ai-builder-model
 *
 * Pattern: pick environment first (drives Dataverse base URL on the
 * server), then list items, then click to detail. 401/403 surfaces as
 * actionable MessageBar via the BFF `hint` field.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Dropdown, Option,
  Tab, TabList, Field, Textarea, Input, Switch, Toolbar, ToolbarButton, ToolbarDivider,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  SearchBox,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Edit20Regular, Delete20Regular, Copy20Regular,
  DatabaseArrowUp20Regular, ArrowReset20Regular, ArrowSync20Regular, History20Regular,
  Open16Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { PowerPlatformTree } from '@/lib/components/powerplatform/powerplatform-tree';
import { PowerAppsStudioTab } from '@/lib/power-platform/power-apps-editor';
import { PowerAutomateDesignerTab, NewFlowAuthor } from '@/lib/power-platform/power-automate-editor';
import { getItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

// Column types the Dataverse "New column" dialog supports — each maps 1:1 to a
// concrete AttributeMetadata @odata.type in powerplatform-client.addColumn().
const DV_COLUMN_TYPES = ['String', 'Memo', 'Integer', 'Decimal', 'Money', 'Boolean', 'DateTime'] as const;
const DV_REQUIRED_LEVELS = ['None', 'Recommended', 'ApplicationRequired'] as const;
// AI Builder model state/status label mappers extracted for vitest
// coverage. See `lib/editors/__tests__/family-utils.test.ts`.
import { aiStateLabel, aiStatusLabel } from './_family-utils';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'baseline', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  tableWrap: { overflow: 'auto', maxHeight: '480px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  // Keep the header visible while scrolling long metadata lists (up to 500 rows).
  stickyHead: {
    position: 'sticky', top: 0, zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `inset 0 -1px 0 ${tokens.colorNeutralStroke2}`,
  },
  // Filter row above a table — search box + live result count, right-aligned count.
  filterRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  filterCount: { color: tokens.colorNeutralForeground3, marginLeft: 'auto' },
  cell: { fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis' },
  cellClickable: {
    fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis',
    cursor: 'pointer', color: tokens.colorBrandForegroundLink,
  },
  empty: { padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  // Environment lifecycle command bar + dialog form — string-valued per the
  // Griffel makeStyles convention used for all new Loom surfaces.
  cmdBar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingVerticalXS },
  dialogForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  dvBox: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  row2: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingVerticalM },
});

// SKU options the BAP create API accepts (Microsoft Learn: New-AdminPowerAppEnvironment
// -EnvironmentSku — Trial | Sandbox | Production | SubscriptionBasedTrial | Teams | Developer).
const ENV_SKUS = ['Production', 'Sandbox', 'Trial', 'Developer', 'SubscriptionBasedTrial', 'Teams'] as const;
// Common Power Platform locations (Get-AdminPowerAppEnvironmentLocations). The
// operator can type any valid location id; these are the frequent ones.
const ENV_LOCATIONS = ['unitedstates', 'europe', 'asia', 'australia', 'canada', 'india', 'japan', 'unitedkingdom', 'unitedstatesfirstrelease'] as const;
// Base-language LCIDs offered when provisioning Dataverse (most common set).
const DV_LANGUAGES: Array<{ lcid: number; label: string }> = [
  { lcid: 1033, label: 'English (1033)' },
  { lcid: 1036, label: 'French (1036)' },
  { lcid: 1031, label: 'German (1031)' },
  { lcid: 3082, label: 'Spanish (3082)' },
  { lcid: 1041, label: 'Japanese (1041)' },
];
const DV_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR'] as const;

/**
 * Build the Home ribbon for a Power Platform editor. Both actions are wired —
 * Reload re-runs the active fetch, "Open in Power Platform" deep-links to the
 * maker/admin portal in a new tab. When no maker URL applies the action is
 * omitted rather than left dead (per ui-parity.md — no "not wired" buttons).
 */
function baseRibbon(onReload: () => void, makerHref?: string, extra?: RibbonTab['groups']): RibbonTab[] {
  const itemActions: RibbonTab['groups'][number]['actions'] = [{ label: 'Reload', onClick: onReload }];
  if (makerHref) {
    itemActions.push({ label: 'Open in Power Platform', onClick: () => window.open(makerHref, '_blank', 'noopener') });
  }
  return [
    { id: 'home', label: 'Home', groups: [{ label: 'Item', actions: itemActions }, ...(extra || [])] },
  ];
}

function ErrorBar({ msg, hint }: { msg: string; hint?: string }) {
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        <MessageBarTitle>Power Platform error</MessageBarTitle>
        {msg}{hint ? ` — ${hint}` : ''}
      </MessageBarBody>
    </MessageBar>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  const s = useStyles();
  return <div className={s.empty}>{children}</div>;
}

/**
 * Quick-filter row over a list table — mirrors the search box every Power
 * Platform maker list (tables, apps, flows, models) exposes. Filtering is
 * client-side over the already-fetched rows (no extra backend call); the live
 * count keeps the operator oriented when a query narrows a long list.
 */
function TableFilter({
  value, onChange, placeholder, shown, total, unit,
}: {
  value: string; onChange: (v: string) => void; placeholder: string;
  shown: number; total: number; unit: string;
}) {
  const s = useStyles();
  return (
    <div className={s.filterRow}>
      <SearchBox
        value={value}
        onChange={(_, d) => onChange(d.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{ minWidth: 260 }}
      />
      <Caption1 className={s.filterCount}>
        {value.trim() ? `${shown} of ${total} ${unit}` : `${total} ${unit}`}
      </Caption1>
    </div>
  );
}

interface FetchState<T> { loading: boolean; data: T | null; error?: string; hint?: string; code?: string; }

/**
 * Parse a response body defensively. A 4xx/5xx (or a Front Door / auth
 * redirect) frequently returns HTML, not JSON — `r.json()` would throw
 * "Unexpected token <" and crash the editor. Guard on content-type and fall
 * back to a readable text snippet.
 */
export async function readJsonSafe(r: Response): Promise<{ json: any; raw: string }> {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { return { json: await r.json(), raw: '' }; }
    catch { /* fall through to text */ }
  }
  const raw = await r.text().catch(() => '');
  try { return { json: raw ? JSON.parse(raw) : null, raw }; }
  catch { return { json: null, raw }; }
}

function useApi<T>(url: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<FetchState<T>>({ loading: false, data: null });
  const reload = useCallback(async () => {
    if (!url) { setState({ loading: false, data: null }); return; }
    setState({ loading: true, data: null });
    try {
      const r = await fetch(url);
      const { json: j, raw } = await readJsonSafe(r);
      if (!j) {
        setState({ loading: false, data: null, error: `HTTP ${r.status} — ${raw ? raw.slice(0, 200) : (r.statusText || 'non-JSON response')}` });
        return;
      }
      if (!j.ok) { setState({ loading: false, data: null, error: j.error || `HTTP ${r.status}`, hint: j.hint, code: j.code }); return; }
      setState({ loading: false, data: j as unknown as T });
    } catch (e: any) {
      setState({ loading: false, data: null, error: e?.message || String(e) });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => { void reload(); }, [reload]);
  return [state, reload] as const;
}

// ============================================================
// Shared environment picker
// ============================================================

interface EnvListResp {
  ok: boolean;
  environments: Array<{
    name: string; displayName: string; location?: string; environmentSku?: string;
    state?: string; isDefault?: boolean; organizationDomain?: string; instanceUrl?: string;
  }>;
}

function useEnvironments(): {
  envs: EnvListResp['environments'];
  selected: string | null;
  setSelected: (n: string | null) => void;
  loading: boolean;
  error?: string;
  hint?: string;
  reload: () => void;
} {
  const [st, reload] = useApi<EnvListResp>('/api/powerplatform/environments');
  const envs = st.data?.environments || [];
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!selected && envs.length > 0) {
      const def = envs.find((e) => e.isDefault) || envs[0];
      setSelected(def.name);
    }
  }, [envs, selected]);
  return { envs, selected, setSelected, loading: st.loading, error: st.error, hint: st.hint, reload };
}

function EnvPicker({
  envs, selected, setSelected,
}: { envs: EnvListResp['environments']; selected: string | null; setSelected: (n: string) => void }) {
  const current = envs.find((e) => e.name === selected);
  return (
    <Dropdown
      placeholder="Pick an environment…"
      value={current ? `${current.displayName} (${current.environmentSku || ''})` : ''}
      selectedOptions={selected ? [selected] : []}
      onOptionSelect={(_: unknown, d: any) => { if (d.optionValue) setSelected(d.optionValue); }}
      style={{ minWidth: 320 }}
    >
      {envs.map((e) => (
        <Option key={e.name} value={e.name} text={`${e.displayName} (${e.environmentSku || ''})`}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <strong>{e.displayName}</strong>
            <Caption1>{e.environmentSku || '—'} · {e.location || '—'} · {e.name}</Caption1>
          </div>
        </Option>
      ))}
    </Dropdown>
  );
}

// ============================================================
// Environment lifecycle command bar (New / Edit / Delete on real BAP REST;
// honest gates for Copy / Backup-Restore / Reset / Convert / History).
//
// New     → POST   /api/powerplatform/environments        (async create + poll)
// Edit    → PATCH  /api/powerplatform/environments        (rename / description)
// Delete  → DELETE /api/powerplatform/environments?id=…   (async soft-delete + poll)
// Poll    → GET    /api/powerplatform/environments/operation?url=…
//
// Copy / Backup & Restore / Reset / Convert-to-production / History have no
// straightforward, scope-safe BAP REST in the Console SP's grant, so they
// render an honest "requires a Power Platform admin operation" MessageBar
// naming the requirement — NOT a fake button, NOT a deep-link-as-parity.
// ============================================================

interface LifecycleOp { status?: string; done: boolean; operationUrl?: string; error?: { code?: string; message?: string }; }

/** Poll an async lifecycle operation until terminal (max ~2 min, 4s cadence). */
async function pollLifecycle(operationUrl: string, onTick: (op: LifecycleOp) => void): Promise<LifecycleOp> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const r = await fetch(`/api/powerplatform/environments/operation?url=${encodeURIComponent(operationUrl)}`);
      const { json: j } = await readJsonSafe(r);
      if (j?.ok && j.operation) {
        onTick(j.operation);
        if (j.operation.done) return j.operation;
      }
    } catch { /* transient — keep polling */ }
  }
  return { done: false, status: 'Running' };
}

function EnvironmentLifecycleBar({
  current, onChanged,
}: {
  current: { name: string; displayName: string; isDefault?: boolean } | undefined;
  onChanged: () => void;
}) {
  const s = useStyles();
  const [busy, setBusy] = useState(false);
  const [opMsg, setOpMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  // ----- New environment dialog state -----
  const [newOpen, setNewOpen] = useState(false);
  const [nName, setNName] = useState('');
  const [nSku, setNSku] = useState<string>('Sandbox');
  const [nLoc, setNLoc] = useState<string>('unitedstates');
  const [nDesc, setNDesc] = useState('');
  const [nDataverse, setNDataverse] = useState(true);
  const [nLang, setNLang] = useState<number>(1033);
  const [nCurrency, setNCurrency] = useState<string>('USD');

  // ----- Edit dialog state -----
  const [editOpen, setEditOpen] = useState(false);
  const [eName, setEName] = useState('');
  const [eDesc, setEDesc] = useState('');

  // ----- Delete dialog state -----
  const [delOpen, setDelOpen] = useState(false);

  const resetNew = () => {
    setNName(''); setNSku('Sandbox'); setNLoc('unitedstates'); setNDesc('');
    setNDataverse(true); setNLang(1033); setNCurrency('USD');
  };

  const createEnv = useCallback(async () => {
    if (!nName.trim()) { setOpMsg({ kind: 'error', text: 'Display name is required.' }); return; }
    setBusy(true); setOpMsg({ kind: 'info', text: `Creating environment "${nName}"…` });
    try {
      const r = await fetch('/api/powerplatform/environments', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: nName.trim(), environmentSku: nSku, location: nLoc,
          description: nDesc.trim() || undefined,
          dataverse: nDataverse ? { baseLanguage: nLang, currency: nCurrency } : undefined,
        }),
      });
      const { json: j } = await readJsonSafe(r);
      if (!j?.ok) { setOpMsg({ kind: 'error', text: `Create failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setNewOpen(false); resetNew();
      const op: LifecycleOp = j.operation || { done: true };
      if (op.operationUrl && !op.done) {
        setOpMsg({ kind: 'info', text: `Provisioning "${nName}" — status ${op.status || 'Running'}…` });
        const final = await pollLifecycle(op.operationUrl, (o) => setOpMsg({ kind: 'info', text: `Provisioning "${nName}" — status ${o.status || 'Running'}…` }));
        if (final.status && final.status.toLowerCase() === 'failed') {
          setOpMsg({ kind: 'error', text: `Provisioning failed: ${final.error?.message || final.status}` });
        } else {
          setOpMsg({ kind: 'success', text: `Environment "${nName}" provisioned.` });
        }
      } else {
        setOpMsg({ kind: 'success', text: `Environment "${nName}" requested${op.status ? ` (status ${op.status})` : ''}.` });
      }
      onChanged();
    } catch (e: any) {
      setOpMsg({ kind: 'error', text: `Create failed: ${e?.message || String(e)}` });
    } finally { setBusy(false); }
  }, [nName, nSku, nLoc, nDesc, nDataverse, nLang, nCurrency, onChanged]);

  const saveEdit = useCallback(async () => {
    if (!current) return;
    setBusy(true); setOpMsg({ kind: 'info', text: 'Saving…' });
    try {
      const r = await fetch('/api/powerplatform/environments', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: current.name, displayName: eName.trim() || undefined, description: eDesc.trim() || undefined }),
      });
      const { json: j } = await readJsonSafe(r);
      if (!j?.ok) { setOpMsg({ kind: 'error', text: `Update failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setEditOpen(false);
      setOpMsg({ kind: 'success', text: `Environment renamed to "${eName.trim()}".` });
      onChanged();
    } catch (e: any) {
      setOpMsg({ kind: 'error', text: `Update failed: ${e?.message || String(e)}` });
    } finally { setBusy(false); }
  }, [current, eName, eDesc, onChanged]);

  const deleteEnv = useCallback(async () => {
    if (!current) return;
    setBusy(true); setOpMsg({ kind: 'info', text: `Deleting "${current.displayName}"…` });
    try {
      const r = await fetch(`/api/powerplatform/environments?id=${encodeURIComponent(current.name)}`, { method: 'DELETE' });
      const { json: j } = await readJsonSafe(r);
      if (!j?.ok) { setOpMsg({ kind: 'error', text: `Delete failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setDelOpen(false);
      const op: LifecycleOp = j.operation || { done: true };
      if (op.operationUrl && !op.done) {
        setOpMsg({ kind: 'info', text: `Deleting "${current.displayName}" — status ${op.status || 'Running'}…` });
        const final = await pollLifecycle(op.operationUrl, (o) => setOpMsg({ kind: 'info', text: `Deleting "${current.displayName}" — status ${o.status || 'Running'}…` }));
        setOpMsg(final.status?.toLowerCase() === 'failed'
          ? { kind: 'error', text: `Delete failed: ${final.error?.message || final.status}` }
          : { kind: 'success', text: `Environment "${current.displayName}" deleted (soft-delete, recoverable).` });
      } else {
        setOpMsg({ kind: 'success', text: `Environment "${current.displayName}" deletion requested (soft-delete, recoverable).` });
      }
      onChanged();
    } catch (e: any) {
      setOpMsg({ kind: 'error', text: `Delete failed: ${e?.message || String(e)}` });
    } finally { setBusy(false); }
  }, [current, onChanged]);

  return (
    <>
      <Toolbar aria-label="Environment lifecycle" className={s.cmdBar}>
        <ToolbarButton icon={<Add20Regular />} disabled={busy} onClick={() => { resetNew(); setNewOpen(true); }}>New</ToolbarButton>
        <ToolbarButton icon={<Edit20Regular />} disabled={busy || !current} onClick={() => { if (current) { setEName(current.displayName); setEDesc(''); setEditOpen(true); } }}>Edit</ToolbarButton>
        <ToolbarButton icon={<Delete20Regular />} disabled={busy || !current || !!current?.isDefault} onClick={() => current && setDelOpen(true)}>Delete</ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton icon={<Copy20Regular />} disabled={busy || !current} onClick={() => setOpMsg({ kind: 'info', text: 'gate:copy' })}>Copy</ToolbarButton>
        <ToolbarButton icon={<DatabaseArrowUp20Regular />} disabled={busy || !current} onClick={() => setOpMsg({ kind: 'info', text: 'gate:backup' })}>Backup &amp; restore</ToolbarButton>
        <ToolbarButton icon={<ArrowReset20Regular />} disabled={busy || !current} onClick={() => setOpMsg({ kind: 'info', text: 'gate:reset' })}>Reset</ToolbarButton>
        <ToolbarButton icon={<ArrowSync20Regular />} disabled={busy || !current} onClick={() => setOpMsg({ kind: 'info', text: 'gate:convert' })}>Convert to production</ToolbarButton>
        <ToolbarButton icon={<History20Regular />} disabled={busy || !current} onClick={() => setOpMsg({ kind: 'info', text: 'gate:history' })}>History</ToolbarButton>
      </Toolbar>

      {busy && <Spinner size="tiny" label="Working…" labelPosition="after" />}

      {opMsg && !opMsg.text.startsWith('gate:') && (
        <MessageBar intent={opMsg.kind === 'info' ? 'info' : opMsg.kind}>
          <MessageBarBody>{opMsg.text}</MessageBarBody>
        </MessageBar>
      )}
      {opMsg?.text === 'gate:copy' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Copy requires a Power Platform admin operation</MessageBarTitle>
          Environment <strong>Copy</strong> (Everything / customizations-only) is a long-running platform job that
          requires the Power Platform Administrator role and a target environment, and is not exposed as a single
          tenant-safe BAP REST call in the Console SP&apos;s grant. Use the Power Platform admin centre (Manage &rarr;
          Environments &rarr; Copy) or <code>Copy-PowerAppEnvironment</code>. New / Edit / Delete above run live.
        </MessageBarBody></MessageBar>
      )}
      {opMsg?.text === 'gate:backup' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Backup &amp; restore requires a Power Platform admin operation</MessageBarTitle>
          System + manual backups and restore are managed by the platform (Dataverse-backed) and require the Power
          Platform Administrator role; there is no single tenant-safe BAP REST surface wired here. Use the admin centre
          (Backup &amp; restore) or <code>Restore-PowerAppEnvironment</code>.
        </MessageBarBody></MessageBar>
      )}
      {opMsg?.text === 'gate:reset' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Reset requires a Power Platform admin operation</MessageBarTitle>
          <strong>Reset</strong> deletes all data and re-provisions Dataverse — a destructive admin job gated behind the
          Power Platform Administrator role. Run it from the admin centre (Reset) or <code>Reset-PowerAppEnvironment</code>.
        </MessageBarBody></MessageBar>
      )}
      {opMsg?.text === 'gate:convert' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Convert to production requires a Power Platform admin operation</MessageBarTitle>
          Converting a Sandbox/Trial environment to Production changes billing and retention. It requires the Power
          Platform Administrator role; perform it in the admin centre (Convert to production).
        </MessageBarBody></MessageBar>
      )}
      {opMsg?.text === 'gate:history' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>History requires a Power Platform admin surface</MessageBarTitle>
          The environment <strong>History</strong> timeline (action / initiator / start / end / status) is served by the
          admin-centre operations feed, which requires the Power Platform Administrator role rather than the
          &quot;use Power Platform APIs&quot; allow group this console authenticates with. View it in the admin centre.
        </MessageBarBody></MessageBar>
      )}

      {/* ----- New environment dialog ----- */}
      <Dialog open={newOpen} onOpenChange={(_, d) => setNewOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New environment</DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                <Field label="Display name" required>
                  <Input value={nName} onChange={(_, d) => setNName(d.value)} placeholder="e.g. HQ Apps — Sandbox" />
                </Field>
                <div className={s.row2}>
                  <Field label="Type (SKU)">
                    <Dropdown value={nSku} selectedOptions={[nSku]} onOptionSelect={(_, d) => d.optionValue && setNSku(d.optionValue)}>
                      {ENV_SKUS.map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Region">
                    <Dropdown value={nLoc} selectedOptions={[nLoc]} onOptionSelect={(_, d) => d.optionValue && setNLoc(d.optionValue)}>
                      {ENV_LOCATIONS.map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <Field label="Description">
                  <Input value={nDesc} onChange={(_, d) => setNDesc(d.value)} placeholder="Optional — intended purpose" />
                </Field>
                <Switch checked={nDataverse} onChange={(_, d) => setNDataverse(d.checked)} label="Create a Dataverse database" />
                {nDataverse && (
                  <div className={s.dvBox}>
                    <Caption1>Dataverse requires a base language and currency (Microsoft Learn: ProvisionDatabase).</Caption1>
                    <div className={s.row2}>
                      <Field label="Base language">
                        <Dropdown
                          value={DV_LANGUAGES.find((l) => l.lcid === nLang)?.label || String(nLang)}
                          selectedOptions={[String(nLang)]}
                          onOptionSelect={(_, d) => d.optionValue && setNLang(Number(d.optionValue))}
                        >
                          {DV_LANGUAGES.map((l) => <Option key={l.lcid} value={String(l.lcid)} text={l.label}>{l.label}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Currency">
                        <Dropdown value={nCurrency} selectedOptions={[nCurrency]} onOptionSelect={(_, d) => d.optionValue && setNCurrency(d.optionValue)}>
                          {DV_CURRENCIES.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement><Button appearance="secondary" disabled={busy}>Cancel</Button></DialogTrigger>
              <Button appearance="primary" disabled={busy || !nName.trim()} onClick={() => { void createEnv(); }}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ----- Edit (rename) dialog ----- */}
      <Dialog open={editOpen} onOpenChange={(_, d) => setEditOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Edit environment</DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                <Field label="Display name" required>
                  <Input value={eName} onChange={(_, d) => setEName(d.value)} />
                </Field>
                <Field label="Description">
                  <Input value={eDesc} onChange={(_, d) => setEDesc(d.value)} placeholder="Optional" />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement><Button appearance="secondary" disabled={busy}>Cancel</Button></DialogTrigger>
              <Button appearance="primary" disabled={busy || !eName.trim()} onClick={() => { void saveEdit(); }}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ----- Delete confirm dialog ----- */}
      <Dialog open={delOpen} onOpenChange={(_, d) => setDelOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete environment</DialogTitle>
            <DialogContent>
              <Body1>
                Delete <strong>{current?.displayName}</strong>? This soft-deletes the environment and all its apps,
                flows, and Dataverse data. It can be recovered from the admin centre during the retention window.
              </Body1>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement><Button appearance="secondary" disabled={busy}>Cancel</Button></DialogTrigger>
              <Button appearance="primary" disabled={busy} onClick={() => { void deleteEnv(); }}>
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

// ============================================================
// 1. PowerPlatformEnvironmentEditor
// ============================================================

export function PowerPlatformEnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const env = useEnvironments();
  // If route-id is a real env name, prefer it.
  useEffect(() => {
    if (id && id !== 'new' && env.envs.some((e) => e.name === id) && env.selected !== id) {
      env.setSelected(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, env.envs]);

  const current = env.envs.find((e) => e.name === env.selected);
  const ribbon = baseRibbon(env.reload, 'https://admin.powerplatform.microsoft.com/environments');
  const [navRefresh, setNavRefresh] = useState(0);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        // Full Power Platform environment navigator (parity wave 11 — parity
        // with the Power Platform admin centre / make.powerapps.com left rail):
        // Environments → Apps / Cloud flows / Connections / Connectors /
        // Dataverse tables with live counts, filter, open (editor or maker),
        // delete, and flow turn-on/off — all on real Power Platform REST.
        // Selecting an environment drives the detail view on the right; opening
        // a table/app/flow deep-links to its existing Loom editor.
        <PowerPlatformTree
          selectedEnvId={env.selected}
          onSelectEnv={(envId) => env.setSelected(envId)}
          // Navigate INTO the Loom editor for the item (in-app maker authoring)
          // instead of deep-linking out to make.powerapps.com / make.powerautomate.com.
          // The target editors read `id` (logical/app/flow id) + `?envId=` and
          // render the full authoring surface (schema designer + New column,
          // Studio tab, Designer tab) — see DataverseTableEditor / PowerAppEditor /
          // PowerAutomateFlowEditor below.
          onOpenTable={(envId, logical) => {
            env.setSelected(envId);
            router.push(`/items/dataverse-table/${encodeURIComponent(logical)}?envId=${encodeURIComponent(envId)}`);
          }}
          onOpenApp={(envId, appId) => {
            env.setSelected(envId);
            router.push(`/items/power-app/${encodeURIComponent(appId)}?envId=${encodeURIComponent(envId)}`);
          }}
          onOpenFlow={(envId, flowId) => {
            env.setSelected(envId);
            router.push(`/items/power-automate-flow/${encodeURIComponent(flowId)}?envId=${encodeURIComponent(envId)}`);
          }}
          refreshKey={navRefresh}
        />
      }
      main={
      <div className={s.pad}>
        {/* Full environment lifecycle command bar — New / Edit / Delete on real
            BAP REST; Copy / Backup-restore / Reset / Convert / History honest-gated. */}
        <EnvironmentLifecycleBar
          current={current}
          onChanged={() => { env.reload(); setNavRefresh((n) => n + 1); }}
        />
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={() => { env.reload(); setNavRefresh((n) => n + 1); }} disabled={env.loading}>Reload</Button>
        </div>
        {env.loading && <Spinner size="small" label="Loading environments…" labelPosition="after" />}
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.loading && !env.error && env.envs.length === 0 && (
          <EmptyText>No Power Platform environments visible to this service principal.</EmptyText>
        )}
        {current && (
          <>
            <Subtitle2>{current.displayName}</Subtitle2>
            <Caption1>{current.name}</Caption1>
            <div className={s.metaGrid}>
              <span className={s.metaKey}>SKU</span><span><Badge appearance="tint" color="brand">{current.environmentSku || '—'}</Badge></span>
              <span className={s.metaKey}>State</span><span>{current.state || '—'}</span>
              <span className={s.metaKey}>Location</span><span>{current.location || '—'}</span>
              <span className={s.metaKey}>Default env</span><span>{current.isDefault ? 'Yes' : 'No'}</span>
              <span className={s.metaKey}>Dataverse domain</span><span>{current.organizationDomain || '—'}</span>
              <span className={s.metaKey}>Instance URL</span><span>{current.instanceUrl || '—'}</span>
            </div>
            <Caption1>
              Capacity, security group, and DLP policy summary surface in the detail call when the BAP admin role allows it.
              If a field shows "—", the UAMI SP lacks the property scope (add the SP to Power Platform Admins role for the tenant
              to widen the view).
            </Caption1>
          </>
        )}
      </div>
    } />
  );
}

// ============================================================
// 2. DataverseTableEditor
// ============================================================

interface DvTable { MetadataId: string; LogicalName: string; SchemaName?: string; DisplayName?: { UserLocalizedLabel?: { Label?: string } }; IsCustomEntity?: boolean; EntitySetName?: string; PrimaryIdAttribute?: string; PrimaryNameAttribute?: string; }
interface DvAttr  { MetadataId: string; LogicalName: string; AttributeType?: string; RequiredLevel?: { Value?: string }; DisplayName?: { UserLocalizedLabel?: { Label?: string } }; IsCustomAttribute?: boolean; IsPrimaryId?: boolean; IsPrimaryName?: boolean; }
interface DvKey   { MetadataId: string; LogicalName: string; DisplayName?: { UserLocalizedLabel?: { Label?: string } }; KeyAttributes?: string[]; EntityKeyIndexStatus?: string; }
interface DvRel   { MetadataId: string; SchemaName: string; RelationshipType: string; ReferencingEntity?: string; ReferencingAttribute?: string; ReferencedEntity?: string; ReferencedAttribute?: string; Entity1LogicalName?: string; Entity2LogicalName?: string; IntersectEntityName?: string; }
interface DvView  { savedqueryid?: string; userqueryid?: string; name: string; isdefault?: boolean; querytype?: number; isuserview?: boolean; modifiedon?: string; }
interface DvRule  { workflowid: string; name: string; statecodeLabel?: string; modifiedon?: string; }

type DvTab = 'columns' | 'keys' | 'relationships' | 'views' | 'rules' | 'data';

export function DataverseTableEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [tablesState, reloadTables] = useApi<{ ok: boolean; tables: DvTable[] }>(
    env.selected ? `/api/items/dataverse-table${envQ}` : null,
    [env.selected],
  );
  const [selectedTable, setSelectedTable] = useState<string | null>(id !== 'new' ? id : null);
  const [tab, setTab] = useState<DvTab>('columns');
  const tableEnc = selectedTable ? encodeURIComponent(selectedTable) : '';

  // ----- New column dialog (real Dataverse Web API write) ----------------
  const [colOpen, setColOpen] = useState(false);
  const [colBusy, setColBusy] = useState(false);
  const [colMsg, setColMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [colSchema, setColSchema] = useState('');
  const [colDisplay, setColDisplay] = useState('');
  const [colType, setColType] = useState<typeof DV_COLUMN_TYPES[number]>('String');
  const [colReq, setColReq] = useState<typeof DV_REQUIRED_LEVELS[number]>('None');
  const [colDesc, setColDesc] = useState('');
  const [colMaxLen, setColMaxLen] = useState('100');
  const [colPrecision, setColPrecision] = useState('2');
  const resetCol = () => {
    setColSchema(''); setColDisplay(''); setColType('String'); setColReq('None');
    setColDesc(''); setColMaxLen('100'); setColPrecision('2'); setColMsg(null);
  };

  // ----- New table dialog (real Dataverse Web API POST EntityDefinitions) -----
  const [tblOpen, setTblOpen] = useState(false);
  const [tblBusy, setTblBusy] = useState(false);
  const [tblMsg, setTblMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [tblSchema, setTblSchema] = useState('');
  const [tblDisplay, setTblDisplay] = useState('');
  const [tblPlural, setTblPlural] = useState('');
  const [tblPrimary, setTblPrimary] = useState('Name');
  const [tblOwnership, setTblOwnership] = useState<'UserOwned' | 'OrganizationOwned'>('UserOwned');
  const [tblType, setTblType] = useState<'Standard' | 'Elastic'>('Standard');
  const [tblNotes, setTblNotes] = useState(false);
  const [tblActivities, setTblActivities] = useState(false);
  const resetTbl = () => {
    setTblSchema(''); setTblDisplay(''); setTblPlural(''); setTblPrimary('Name');
    setTblOwnership('UserOwned'); setTblType('Standard'); setTblNotes(false);
    setTblActivities(false); setTblMsg(null);
  };

  const createTable = useCallback(async () => {
    if (!env.selected) return;
    if (!tblSchema.trim() || !tblDisplay.trim() || !tblPlural.trim()) {
      setTblMsg({ kind: 'error', text: 'Schema name, display name, and plural name are required.' });
      return;
    }
    setTblBusy(true); setTblMsg(null);
    try {
      const r = await fetch(`/api/powerplatform/tables?envId=${encodeURIComponent(env.selected)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaName: tblSchema.trim(),
          displayName: tblDisplay.trim(),
          displayCollectionName: tblPlural.trim(),
          primaryNameDisplayName: tblPrimary.trim() || undefined,
          ownershipType: tblOwnership,
          tableType: tblType,
          hasNotes: tblNotes,
          hasActivities: tblActivities,
        }),
      });
      const { json: j } = await readJsonSafe(r);
      if (!j?.ok) { setTblMsg({ kind: 'error', text: `Create failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setTblMsg({ kind: 'success', text: `Table "${tblDisplay.trim()}" created.` });
      setTblOpen(false); resetTbl();
      reloadTables();
    } catch (e: any) {
      setTblMsg({ kind: 'error', text: `Create failed: ${e?.message || String(e)}` });
    } finally { setTblBusy(false); }
  }, [env.selected, tblSchema, tblDisplay, tblPlural, tblPrimary, tblOwnership, tblType, tblNotes, tblActivities, reloadTables]);

  const [schemaState, reloadSchema] = useApi<{ ok: boolean; table: DvTable; attributes: DvAttr[] }>(
    env.selected && selectedTable ? `/api/items/dataverse-table/${tableEnc}${envQ}` : null,
    [env.selected, selectedTable],
  );
  const [keysState, reloadKeys] = useApi<{ ok: boolean; keys: DvKey[] }>(
    env.selected && selectedTable && tab === 'keys' ? `/api/items/dataverse-table/${tableEnc}/keys${envQ}` : null,
    [env.selected, selectedTable, tab],
  );
  const [relState, reloadRel] = useApi<{ ok: boolean; relationships: DvRel[] }>(
    env.selected && selectedTable && tab === 'relationships' ? `/api/items/dataverse-table/${tableEnc}/relationships${envQ}` : null,
    [env.selected, selectedTable, tab],
  );
  const [viewState, reloadViews] = useApi<{ ok: boolean; views: DvView[] }>(
    env.selected && selectedTable && tab === 'views' ? `/api/items/dataverse-table/${tableEnc}/views${envQ}` : null,
    [env.selected, selectedTable, tab],
  );
  const [ruleState, reloadRules] = useApi<{ ok: boolean; businessRules: DvRule[] }>(
    env.selected && selectedTable && tab === 'rules' ? `/api/items/dataverse-table/${tableEnc}/business-rules${envQ}` : null,
    [env.selected, selectedTable, tab],
  );
  const [dataState, reloadData] = useApi<{ ok: boolean; columns: string[]; rows: Record<string, any>[]; entitySet: string }>(
    env.selected && selectedTable && tab === 'data' ? `/api/items/dataverse-table/${tableEnc}/rows${envQ}&top=25` : null,
    [env.selected, selectedTable, tab],
  );

  const [tblFilter, setTblFilter] = useState('');
  const [colFilter, setColFilter] = useState('');
  const tables = tablesState.data?.tables || [];
  const filtered = useMemo(() => {
    return tables.filter((t) => t.IsCustomEntity || ['account', 'contact', 'systemuser', 'team', 'msdyn_aimodel', 'mspp_website'].includes(t.LogicalName)).slice(0, 500);
  }, [tables]);
  const tblQuery = tblFilter.trim().toLowerCase();
  const visibleTables = useMemo(() => {
    if (!tblQuery) return filtered;
    return filtered.filter((t) =>
      t.LogicalName.toLowerCase().includes(tblQuery)
      || (t.DisplayName?.UserLocalizedLabel?.Label || '').toLowerCase().includes(tblQuery)
      || (t.EntitySetName || '').toLowerCase().includes(tblQuery));
  }, [filtered, tblQuery]);
  const colQuery = colFilter.trim().toLowerCase();
  const visibleColumns = useMemo(() => {
    const attrs = schemaState.data?.attributes || [];
    const capped = attrs.slice(0, 500);
    if (!colQuery) return capped;
    return capped.filter((a) =>
      a.LogicalName.toLowerCase().includes(colQuery)
      || (a.DisplayName?.UserLocalizedLabel?.Label || '').toLowerCase().includes(colQuery)
      || (a.AttributeType || '').toLowerCase().includes(colQuery));
  }, [schemaState.data, colQuery]);

  const reloadActive = useCallback(() => {
    reloadTables();
    if (!selectedTable) return;
    reloadSchema();
    if (tab === 'keys') reloadKeys();
    if (tab === 'relationships') reloadRel();
    if (tab === 'views') reloadViews();
    if (tab === 'rules') reloadRules();
    if (tab === 'data') reloadData();
  }, [reloadTables, selectedTable, tab, reloadSchema, reloadKeys, reloadRel, reloadViews, reloadRules, reloadData]);

  const createColumn = useCallback(async () => {
    if (!env.selected || !selectedTable) return;
    if (!colSchema.trim() || !colDisplay.trim()) {
      setColMsg({ kind: 'error', text: 'Schema name and display name are required.' });
      return;
    }
    setColBusy(true); setColMsg(null);
    try {
      const payload: Record<string, unknown> = {
        schemaName: colSchema.trim(),
        displayName: colDisplay.trim(),
        attributeType: colType,
        requiredLevel: colReq,
        description: colDesc.trim() || undefined,
      };
      if (colType === 'String' || colType === 'Memo') payload.maxLength = Number(colMaxLen) || undefined;
      if (colType === 'Decimal' || colType === 'Money') payload.precision = Number(colPrecision) || undefined;
      const r = await fetch(
        `/api/items/dataverse-table/${tableEnc}/columns?envId=${encodeURIComponent(env.selected)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      );
      const { json: j } = await readJsonSafe(r);
      if (!j?.ok) { setColMsg({ kind: 'error', text: `Create failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setColMsg({ kind: 'success', text: `Column "${colSchema.trim()}" created.` });
      setColOpen(false); resetCol();
      reloadSchema();
    } catch (e: any) {
      setColMsg({ kind: 'error', text: `Create failed: ${e?.message || String(e)}` });
    } finally { setColBusy(false); }
  }, [env.selected, selectedTable, tableEnc, colSchema, colDisplay, colType, colReq, colDesc, colMaxLen, colPrecision, reloadSchema]);

  const makerHref = env.selected
    ? (selectedTable
      ? `https://make.powerapps.com/environments/${encodeURIComponent(env.selected)}/entities/${encodeURIComponent(selectedTable)}`
      : `https://make.powerapps.com/environments/${encodeURIComponent(env.selected)}/tables`)
    : undefined;
  const ribbon = baseRibbon(reloadActive, makerHref);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {id === 'new' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Create or pick a table to inspect and author</MessageBarTitle>
              Use <strong>New table</strong> to create a brand-new custom table in-product (publisher prefix,
              ownership type, primary column) — a real Dataverse Web API write. This designer also reads + inspects
              every facet of an existing table — columns, keys, relationships, views, business rules, and live data —
              and lets you <strong>add columns</strong> directly (Columns tab &rarr; New column). Pick a table below
              or create one.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadActive}>Reload</Button>
          {env.selected && !selectedTable && (
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => { resetTbl(); setTblOpen(true); }}>New table</Button>
          )}
          {tblMsg && !selectedTable && (
            <Caption1 style={{ color: tblMsg.kind === 'error' ? tokens.colorStatusDangerForeground1 : tokens.colorStatusSuccessForeground1 }}>{tblMsg.text}</Caption1>
          )}
          {selectedTable && <Caption1>Table: <strong>{selectedTable}</strong></Caption1>}
          {selectedTable && env.selected && (
            <Button
              appearance="transparent"
              icon={<Open16Regular />}
              onClick={() => window.open(
                `https://make.powerapps.com/environments/${encodeURIComponent(env.selected!)}/entities/${encodeURIComponent(selectedTable)}`,
                '_blank', 'noopener,noreferrer',
              )}
            >Open in Maker</Button>
          )}
        </div>
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.selected && !env.loading && <EmptyText>Select an environment to list its Dataverse tables.</EmptyText>}
        {tablesState.loading && <Spinner size="small" label="Loading tables…" labelPosition="after" />}
        {tablesState.error && <ErrorBar msg={tablesState.error} hint={tablesState.hint} />}
        {!selectedTable && !tablesState.loading && !tablesState.error && env.selected && tablesState.data && filtered.length === 0 && (
          <EmptyText>No custom or key system tables in this environment.</EmptyText>
        )}
        {!selectedTable && filtered.length > 0 && (
          <>
            <TableFilter
              value={tblFilter}
              onChange={setTblFilter}
              placeholder="Filter tables by name or entity set…"
              shown={visibleTables.length}
              total={filtered.length}
              unit="table(s) — custom + key system entities"
            />
            {visibleTables.length === 0
              ? <EmptyText>No tables match &ldquo;{tblFilter}&rdquo;.</EmptyText>
              : (
            <div className={s.tableWrap}>
              <Table aria-label="Tables" size="small">
                <TableHeader className={s.stickyHead}><TableRow>
                  <TableHeaderCell>Logical name</TableHeaderCell>
                  <TableHeaderCell>Display name</TableHeaderCell>
                  <TableHeaderCell>Entity set</TableHeaderCell>
                  <TableHeaderCell>Custom?</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {visibleTables.map((t) => (
                    <TableRow key={t.MetadataId}>
                      <TableCell className={s.cellClickable} onClick={() => { setSelectedTable(t.LogicalName); setTab('columns'); }}>
                        <strong>{t.LogicalName}</strong>
                      </TableCell>
                      <TableCell className={s.cell}>{t.DisplayName?.UserLocalizedLabel?.Label || '—'}</TableCell>
                      <TableCell className={s.cell}>{t.EntitySetName || '—'}</TableCell>
                      <TableCell className={s.cell}>{t.IsCustomEntity ? 'Yes' : 'No'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
              )}
          </>
        )}
        {selectedTable && (
          <>
            <Button appearance="subtle" onClick={() => setSelectedTable(null)}>&larr; Back to table list</Button>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as DvTab)}>
              <Tab value="columns">Columns</Tab>
              <Tab value="keys">Keys</Tab>
              <Tab value="relationships">Relationships</Tab>
              <Tab value="views">Views</Tab>
              <Tab value="rules">Business rules</Tab>
              <Tab value="data">Data</Tab>
            </TabList>

            {tab === 'columns' && (
              <>
                <Toolbar aria-label="Column actions" className={s.cmdBar}>
                  <ToolbarButton
                    icon={<Add20Regular />}
                    disabled={!env.selected || !selectedTable}
                    onClick={() => { resetCol(); setColOpen(true); }}
                  >New column</ToolbarButton>
                </Toolbar>
                {colMsg && (
                  <MessageBar intent={colMsg.kind}>
                    <MessageBarBody>{colMsg.text}</MessageBarBody>
                  </MessageBar>
                )}
                {schemaState.loading && <Spinner size="small" label="Loading columns…" labelPosition="after" />}
                {schemaState.error && <ErrorBar msg={schemaState.error} hint={schemaState.hint} />}
                {schemaState.data && (
                  <>
                    <TableFilter
                      value={colFilter}
                      onChange={setColFilter}
                      placeholder="Filter columns by name or type…"
                      shown={visibleColumns.length}
                      total={Math.min(schemaState.data.attributes.length, 500)}
                      unit="column(s)"
                    />
                    {visibleColumns.length === 0
                      ? <EmptyText>No columns match &ldquo;{colFilter}&rdquo;.</EmptyText>
                      : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Columns" size="small">
                        <TableHeader className={s.stickyHead}><TableRow>
                          <TableHeaderCell>Logical name</TableHeaderCell>
                          <TableHeaderCell>Display name</TableHeaderCell>
                          <TableHeaderCell>Data type</TableHeaderCell>
                          <TableHeaderCell>Required</TableHeaderCell>
                          <TableHeaderCell>Custom?</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {visibleColumns.map((a) => (
                            <TableRow key={a.MetadataId}>
                              <TableCell className={s.cell}>
                                <strong>{a.LogicalName}</strong>
                                {a.IsPrimaryId && <Badge size="small" appearance="tint" color="brand" style={{ marginLeft: tokens.spacingHorizontalXS }}>PK</Badge>}
                                {a.IsPrimaryName && <Badge size="small" appearance="tint" color="success" style={{ marginLeft: tokens.spacingHorizontalXS }}>Name</Badge>}
                              </TableCell>
                              <TableCell className={s.cell}>{a.DisplayName?.UserLocalizedLabel?.Label || '—'}</TableCell>
                              <TableCell className={s.cell}>{a.AttributeType || '—'}</TableCell>
                              <TableCell className={s.cell}>{a.RequiredLevel?.Value || '—'}</TableCell>
                              <TableCell className={s.cell}>{a.IsCustomAttribute ? 'Yes' : 'No'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                      )}
                  </>
                )}
              </>
            )}

            {tab === 'keys' && (
              <>
                {keysState.loading && <Spinner size="small" label="Loading keys…" labelPosition="after" />}
                {keysState.error && <ErrorBar msg={keysState.error} hint={keysState.hint} />}
                {keysState.data && (keysState.data.keys.length === 0
                  ? <EmptyText>No alternate keys defined on this table.</EmptyText>
                  : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Keys" size="small">
                        <TableHeader className={s.stickyHead}><TableRow>
                          <TableHeaderCell>Display name</TableHeaderCell>
                          <TableHeaderCell>Logical name</TableHeaderCell>
                          <TableHeaderCell>Key columns</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {keysState.data.keys.map((k) => (
                            <TableRow key={k.MetadataId}>
                              <TableCell className={s.cell}>{k.DisplayName?.UserLocalizedLabel?.Label || '—'}</TableCell>
                              <TableCell className={s.cell}><strong>{k.LogicalName}</strong></TableCell>
                              <TableCell className={s.cell}>{(k.KeyAttributes || []).join(', ') || '—'}</TableCell>
                              <TableCell className={s.cell}>
                                <Badge appearance="tint" color={k.EntityKeyIndexStatus === 'Active' ? 'success' : 'subtle'}>
                                  {k.EntityKeyIndexStatus || '—'}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
              </>
            )}

            {tab === 'relationships' && (
              <>
                {relState.loading && <Spinner size="small" label="Loading relationships…" labelPosition="after" />}
                {relState.error && <ErrorBar msg={relState.error} hint={relState.hint} />}
                {relState.data && (relState.data.relationships.length === 0
                  ? <EmptyText>No relationships found.</EmptyText>
                  : (
                    <>
                      <Caption1>{relState.data.relationships.length} relationship(s)</Caption1>
                      <div className={s.tableWrap}>
                        <Table aria-label="Relationships" size="small">
                          <TableHeader className={s.stickyHead}><TableRow>
                            <TableHeaderCell>Type</TableHeaderCell>
                            <TableHeaderCell>Schema name</TableHeaderCell>
                            <TableHeaderCell>Referencing</TableHeaderCell>
                            <TableHeaderCell>Referenced</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {relState.data.relationships.map((r) => (
                              <TableRow key={r.MetadataId}>
                                <TableCell className={s.cell}><Badge appearance="tint" color="brand">{r.RelationshipType}</Badge></TableCell>
                                <TableCell className={s.cell}><strong>{r.SchemaName}</strong></TableCell>
                                <TableCell className={s.cell}>
                                  {r.RelationshipType === 'N:N'
                                    ? (r.IntersectEntityName || '—')
                                    : `${r.ReferencingEntity || '—'}.${r.ReferencingAttribute || ''}`}
                                </TableCell>
                                <TableCell className={s.cell}>
                                  {r.RelationshipType === 'N:N'
                                    ? `${r.Entity1LogicalName || '—'} ↔ ${r.Entity2LogicalName || '—'}`
                                    : `${r.ReferencedEntity || '—'}.${r.ReferencedAttribute || ''}`}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  ))}
              </>
            )}

            {tab === 'views' && (
              <>
                {viewState.loading && <Spinner size="small" label="Loading views…" labelPosition="after" />}
                {viewState.error && <ErrorBar msg={viewState.error} hint={viewState.hint} />}
                {viewState.data && (viewState.data.views.length === 0
                  ? <EmptyText>No views defined for this table.</EmptyText>
                  : (
                    <>
                      <Caption1>{viewState.data.views.length} view(s)</Caption1>
                      <div className={s.tableWrap}>
                        <Table aria-label="Views" size="small">
                          <TableHeader className={s.stickyHead}><TableRow>
                            <TableHeaderCell>Name</TableHeaderCell>
                            <TableHeaderCell>Scope</TableHeaderCell>
                            <TableHeaderCell>Default?</TableHeaderCell>
                            <TableHeaderCell>Modified</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {viewState.data.views.map((v) => (
                              <TableRow key={v.savedqueryid || v.userqueryid}>
                                <TableCell className={s.cell}><strong>{v.name}</strong></TableCell>
                                <TableCell className={s.cell}>
                                  <Badge appearance="tint" color={v.isuserview ? 'informative' : 'brand'}>
                                    {v.isuserview ? 'Personal' : 'System'}
                                  </Badge>
                                </TableCell>
                                <TableCell className={s.cell}>{v.isdefault ? 'Yes' : '—'}</TableCell>
                                <TableCell className={s.cell}>{v.modifiedon || '—'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  ))}
              </>
            )}

            {tab === 'rules' && (
              <>
                {ruleState.loading && <Spinner size="small" label="Loading business rules…" labelPosition="after" />}
                {ruleState.error && <ErrorBar msg={ruleState.error} hint={ruleState.hint} />}
                {ruleState.data && (ruleState.data.businessRules.length === 0
                  ? <EmptyText>No business rules defined for this table.</EmptyText>
                  : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Business rules" size="small">
                        <TableHeader className={s.stickyHead}><TableRow>
                          <TableHeaderCell>Name</TableHeaderCell>
                          <TableHeaderCell>State</TableHeaderCell>
                          <TableHeaderCell>Modified</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {ruleState.data.businessRules.map((r) => (
                            <TableRow key={r.workflowid}>
                              <TableCell className={s.cell}><strong>{r.name}</strong></TableCell>
                              <TableCell className={s.cell}>
                                <Badge appearance="tint" color={r.statecodeLabel === 'Activated' ? 'success' : 'subtle'}>
                                  {r.statecodeLabel || '—'}
                                </Badge>
                              </TableCell>
                              <TableCell className={s.cell}>{r.modifiedon || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
              </>
            )}

            {tab === 'data' && (
              <>
                {dataState.loading && <Spinner size="small" label="Loading rows…" labelPosition="after" />}
                {dataState.error && <ErrorBar msg={dataState.error} hint={dataState.hint} />}
                {dataState.data && (dataState.data.rows.length === 0
                  ? <EmptyText>No rows in this table.</EmptyText>
                  : (
                    <>
                      <Caption1>{dataState.data.rows.length} row(s) — entity set <code>{dataState.data.entitySet}</code> (top 25)</Caption1>
                      <div className={s.tableWrap}>
                        <Table aria-label="Data grid" size="small">
                          <TableHeader className={s.stickyHead}><TableRow>
                            {dataState.data.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                          </TableRow></TableHeader>
                          <TableBody>
                            {dataState.data.rows.map((row, i) => (
                              <TableRow key={i}>
                                {dataState.data!.columns.map((c) => {
                                  const fv = row[`${c}@OData.Community.Display.V1.FormattedValue`];
                                  const v = fv ?? row[c];
                                  return <TableCell key={c} className={s.cell}>{v === null || v === undefined ? '—' : String(v)}</TableCell>;
                                })}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  ))}
              </>
            )}
          </>
        )}

        {/* ----- New table dialog (real Dataverse Web API POST EntityDefinitions) ----- */}
        <Dialog open={tblOpen} onOpenChange={(_, d) => setTblOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>New table</DialogTitle>
              <DialogContent>
                <div className={s.dialogForm}>
                  <Field label="Display name" required>
                    <Input value={tblDisplay} onChange={(_, d) => setTblDisplay(d.value)} placeholder="Invoice" />
                  </Field>
                  <Field label="Plural display name" required>
                    <Input value={tblPlural} onChange={(_, d) => setTblPlural(d.value)} placeholder="Invoices" />
                  </Field>
                  <Field
                    label="Schema name" required
                    hint="Must include your publisher prefix, e.g. new_Invoice"
                  >
                    <Input value={tblSchema} onChange={(_, d) => setTblSchema(d.value)} placeholder="new_Invoice" />
                  </Field>
                  <Field label="Primary column display name">
                    <Input value={tblPrimary} onChange={(_, d) => setTblPrimary(d.value)} placeholder="Name" />
                  </Field>
                  <div className={s.row2}>
                    <Field label="Ownership">
                      <Dropdown
                        value={tblOwnership === 'UserOwned' ? 'User or team' : 'Organization'}
                        selectedOptions={[tblOwnership]}
                        onOptionSelect={(_, d) => d.optionValue && setTblOwnership(d.optionValue as 'UserOwned' | 'OrganizationOwned')}
                      >
                        <Option value="UserOwned" text="User or team">User or team</Option>
                        <Option value="OrganizationOwned" text="Organization">Organization</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Table type">
                      <Dropdown
                        value={tblType}
                        selectedOptions={[tblType]}
                        onOptionSelect={(_, d) => d.optionValue && setTblType(d.optionValue as 'Standard' | 'Elastic')}
                      >
                        <Option value="Standard" text="Standard">Standard</Option>
                        <Option value="Elastic" text="Elastic">Elastic</Option>
                      </Dropdown>
                    </Field>
                  </div>
                  <Switch checked={tblNotes} onChange={(_, d) => setTblNotes(d.checked)} label="Enable attachments (Notes)" />
                  <Switch checked={tblActivities} onChange={(_, d) => setTblActivities(d.checked)} label="Enable activities" />
                  <Caption1>
                    Creates the table via the Dataverse Web API (<code>POST EntityDefinitions</code>). The Dataverse
                    service principal must hold a customizing role (System Administrator / System Customizer) on this
                    environment.
                  </Caption1>
                </div>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement><Button appearance="secondary" disabled={tblBusy}>Cancel</Button></DialogTrigger>
                <Button
                  appearance="primary"
                  disabled={tblBusy || !tblSchema.trim() || !tblDisplay.trim() || !tblPlural.trim()}
                  onClick={() => { void createTable(); }}
                >
                  {tblBusy ? 'Creating…' : 'Create table'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {/* ----- New column dialog (real Dataverse Web API POST /Attributes) ----- */}
        <Dialog open={colOpen} onOpenChange={(_, d) => setColOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>New column</DialogTitle>
              <DialogContent>
                <div className={s.dialogForm}>
                  <Field
                    label="Schema name" required
                    hint="Must include your publisher prefix, e.g. new_Rating"
                  >
                    <Input value={colSchema} onChange={(_, d) => setColSchema(d.value)} placeholder="new_Rating" />
                  </Field>
                  <Field label="Display name" required>
                    <Input value={colDisplay} onChange={(_, d) => setColDisplay(d.value)} placeholder="Rating" />
                  </Field>
                  <div className={s.row2}>
                    <Field label="Data type">
                      <Dropdown
                        value={colType}
                        selectedOptions={[colType]}
                        onOptionSelect={(_, d) => d.optionValue && setColType(d.optionValue as typeof DV_COLUMN_TYPES[number])}
                      >
                        {DV_COLUMN_TYPES.map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Required level">
                      <Dropdown
                        value={colReq}
                        selectedOptions={[colReq]}
                        onOptionSelect={(_, d) => d.optionValue && setColReq(d.optionValue as typeof DV_REQUIRED_LEVELS[number])}
                      >
                        {DV_REQUIRED_LEVELS.map((r) => <Option key={r} value={r} text={r}>{r}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                  {(colType === 'String' || colType === 'Memo') && (
                    <Field label="Max length">
                      <Input type="number" value={colMaxLen} onChange={(_, d) => setColMaxLen(d.value)} />
                    </Field>
                  )}
                  {(colType === 'Decimal' || colType === 'Money') && (
                    <Field label="Precision (decimal places)">
                      <Input type="number" value={colPrecision} onChange={(_, d) => setColPrecision(d.value)} />
                    </Field>
                  )}
                  <Field label="Description">
                    <Input value={colDesc} onChange={(_, d) => setColDesc(d.value)} placeholder="Optional" />
                  </Field>
                  <Caption1>
                    Creates the column on <strong>{selectedTable}</strong> via the Dataverse Web API
                    (<code>POST EntityDefinitions/Attributes</code>). The Dataverse service principal must hold a
                    customizing role (System Administrator / System Customizer) on this environment.
                  </Caption1>
                </div>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement><Button appearance="secondary" disabled={colBusy}>Cancel</Button></DialogTrigger>
                <Button appearance="primary" disabled={colBusy || !colSchema.trim() || !colDisplay.trim()} onClick={() => { void createColumn(); }}>
                  {colBusy ? 'Creating…' : 'Create column'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

// ============================================================
// 3. PowerAppEditor
//
// Resource-binding model (fixes the 404 item-GUID-as-app-id bug, #476 class):
//   • The Loom item id is a Cosmos GUID, NOT a Power Apps app id.
//   • A `power-app` item BINDS to (envId, appId, appType) persisted in
//     item.state via POST /api/items/power-app/[id]/state.
//   • Unbound → full bind/select surface renders (env picker + app list +
//     "Bind this app"). Never a 404 crash.
//   • Detail + embed + publish all resolve the REAL appId from state.
//
// Embed: canvas apps embed via the web-player iframe
//   (https://apps.powerapps.com/play/<appId>?source=iframe — Microsoft Learn
//   power-apps/maker/canvas-apps/embed-apps-dev). Model-driven apps can't be
//   iframed; we surface an "Open in Power Apps" deep link (main.aspx?appid=).
// ============================================================

interface PAppConnRef { id?: string; displayName?: string; iconUri?: string; dataSources?: string[]; }
interface PApp {
  name: string; displayName: string; description?: string; appType?: string;
  owner?: { displayName?: string; email?: string };
  createdTime?: string; lastModifiedTime?: string;
  appOpenUri?: string; playerEmbedUri?: string;
  connectionReferences?: PAppConnRef[]; appVersion?: string;
  sharedUsersCount?: number; sharedGroupsCount?: number;
}

type PAppTab = 'detail' | 'play' | 'studio';

export function PowerAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new';

  // ----- persisted binding (from the Loom item's state) ------------------
  const itemQ = useQuery<WorkspaceItem>({
    queryKey: ['item', 'power-app', id],
    queryFn: () => getItem('power-app', id),
    enabled: !isNew,
  });
  const boundEnvId = (itemQ.data?.state as any)?.envId as string | undefined;
  const boundAppId = (itemQ.data?.state as any)?.appId as string | undefined;
  const boundAppType = (itemQ.data?.state as any)?.appType as string | undefined;
  const isBound = !!(boundEnvId && boundAppId);

  // ----- environment + app picker (for binding / browsing) ----------------
  const env = useEnvironments();
  // Once we know the bound env, default the picker to it.
  useEffect(() => {
    if (boundEnvId && env.selected !== boundEnvId && env.envs.some((e) => e.name === boundEnvId)) {
      env.setSelected(boundEnvId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundEnvId, env.envs]);

  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [listSt, reloadList] = useApi<{ ok: boolean; apps: PApp[] }>(
    env.selected ? `/api/items/power-app${envQ}` : null,
    [env.selected],
  );
  const apps = listSt.data?.apps || [];
  const [appFilter, setAppFilter] = useState('');
  const appQuery = appFilter.trim().toLowerCase();
  const visibleApps = useMemo(() => {
    if (!appQuery) return apps;
    return apps.filter((a) =>
      a.displayName.toLowerCase().includes(appQuery)
      || (a.appType || '').toLowerCase().includes(appQuery)
      || (a.owner?.displayName || a.owner?.email || '').toLowerCase().includes(appQuery));
  }, [apps, appQuery]);

  // ----- bound app detail -------------------------------------------------
  // When bound, resolve the detail through the item route (it reads state).
  // When picking (pre-bind), pass explicit envId+appId so the panel previews.
  const [pick, setPick] = useState<{ appId: string; appType?: string } | null>(null);
  const detailUrl = (() => {
    if (pick && env.selected) {
      return `/api/items/power-app/${encodeURIComponent(id)}?envId=${encodeURIComponent(env.selected)}&appId=${encodeURIComponent(pick.appId)}${pick.appType ? `&appType=${encodeURIComponent(pick.appType)}` : ''}`;
    }
    if (!isNew && isBound) return `/api/items/power-app/${encodeURIComponent(id)}`;
    return null;
  })();
  const [detailSt, reloadDetail] = useApi<{ ok: boolean; app: PApp; envId: string; appId: string; bound: boolean }>(
    detailUrl, [detailUrl],
  );
  const app = detailSt.data?.app;

  const [tab, setTab] = useState<PAppTab>('detail');
  const [embedBlocked, setEmbedBlocked] = useState(false);

  // ----- bind / publish action state --------------------------------------
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const bind = useCallback(async (appId: string, appType?: string) => {
    if (isNew) {
      setActionMsg({ kind: 'error', text: 'Save this item first (it needs a workspace) before binding an app.' });
      return;
    }
    if (!env.selected) return;
    setActionBusy(true); setActionMsg(null);
    try {
      const r = await fetch(`/api/items/power-app/${encodeURIComponent(id)}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId: env.selected, appId, appType }),
      });
      const { json: j } = await readJsonSafe(r);
      if (!j?.ok) { setActionMsg({ kind: 'error', text: `Bind failed: ${j?.error || r.status}` }); return; }
      setActionMsg({ kind: 'success', text: 'App bound to this Loom item.' });
      setPick(null);
      await itemQ.refetch();
    } catch (e: any) {
      setActionMsg({ kind: 'error', text: `Bind failed: ${e?.message || String(e)}` });
    } finally { setActionBusy(false); }
  }, [env.selected, id, isNew, itemQ]);

  const publish = useCallback(async () => {
    setActionBusy(true); setActionMsg(null);
    try {
      const explicit = pick && env.selected
        ? `?envId=${encodeURIComponent(env.selected)}&appId=${encodeURIComponent(pick.appId)}` : '';
      const r = await fetch(`/api/items/power-app/${encodeURIComponent(id)}/publish${explicit}`, { method: 'POST' });
      const { json: j } = await readJsonSafe(r);
      if (!j?.ok) { setActionMsg({ kind: 'error', text: `Publish failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setActionMsg({ kind: 'success', text: 'Latest revision published.' });
      reloadDetail();
    } catch (e: any) {
      setActionMsg({ kind: 'error', text: `Publish failed: ${e?.message || String(e)}` });
    } finally { setActionBusy(false); }
  }, [id, pick, env.selected, reloadDetail]);

  const reloadAll = useCallback(() => { reloadList(); if (detailUrl) reloadDetail(); void itemQ.refetch(); }, [reloadList, reloadDetail, detailUrl, itemQ]);

  const makerHref = env.selected
    ? `https://make.powerapps.com/environments/${encodeURIComponent(env.selected)}/apps`
    : undefined;
  const makerAppHref = (appId: string) => env.selected
    ? `https://make.powerapps.com/e/${encodeURIComponent(env.selected)}/studio/${encodeURIComponent(appId)}`
    : '#';

  const ribbonExtra: RibbonTab['groups'] = app
    ? [{
        label: 'App',
        actions: [
          { label: 'Publish', onClick: () => { void publish(); } },
          { label: 'Open in maker', onClick: () => { if (env.selected) window.open(makerAppHref(app.name), '_blank', 'noopener'); } },
          ...(app.playerEmbedUri ? [{ label: 'Play', onClick: () => window.open(app.playerEmbedUri!, '_blank', 'noopener') }] : []),
        ],
      }]
    : [];
  const ribbon = baseRibbon(reloadAll, makerHref, ribbonExtra);

  const isModelDriven = (app?.appType || boundAppType || '').toLowerCase().includes('modeldriven');
  const canIframe = !!app?.playerEmbedUri && !isModelDriven;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {/* Infra gate — honest MessageBar when Power Platform isn't reachable. */}
        {env.error && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Power Platform not reachable</MessageBarTitle>
              {env.error}{env.hint ? ` — ${env.hint}` : ''}
              {' '}Set <code>LOOM_UAMI_CLIENT_ID</code> and add that service principal to the
              <strong> &quot;Service principals can use Power Platform APIs&quot;</strong> allow group in the
              Power Platform admin centre. The full editor still renders below.
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Bind state banner */}
        {!isNew && !isBound && (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>This item isn&apos;t bound to a Power App yet</MessageBarTitle>
              Pick an environment and an app below, then <strong>Bind this app</strong>. The binding is stored on
              the item so detail, embed, and publish target the real Power App (not the Loom item id).
            </MessageBarBody>
          </MessageBar>
        )}
        {isNew && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Save the item first</MessageBarTitle>
              A new Power App item must be created in a workspace before it can bind to a real app.
              New canvas apps are authored in <code>make.powerapps.com</code>; create one there (or pick an
              existing app once this item is saved) and bind it here.
            </MessageBarBody>
          </MessageBar>
        )}

        {actionMsg && (
          <MessageBar intent={actionMsg.kind}>
            <MessageBarBody>{actionMsg.text}</MessageBarBody>
          </MessageBar>
        )}

        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadAll} disabled={listSt.loading}>Reload</Button>
          {env.selected && makerHref && (
            <Button
              appearance="transparent"
              icon={<Open16Regular />}
              onClick={() => window.open(makerHref, '_blank', 'noopener,noreferrer')}
            >Open Power Apps maker</Button>
          )}
        </div>
        {env.loading && <Spinner size="small" label="Loading environments…" labelPosition="after" />}
        {!env.selected && !env.loading && !env.error && <EmptyText>Select an environment to list its Power Apps.</EmptyText>}

        {/* ===== Bound (or previewing) app detail ===== */}
        {(isBound || pick) && (
          <>
            {pick && (
              <Button appearance="subtle" onClick={() => { setPick(null); setTab('detail'); }}>&larr; Back to app list</Button>
            )}
            {detailSt.loading && <Spinner size="small" label="Loading app…" labelPosition="after" />}
            {detailSt.error && <ErrorBar msg={detailSt.error} hint={detailSt.hint} />}
            {app && (
              <>
                <Subtitle2>{app.displayName}</Subtitle2>
                <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as PAppTab)}>
                  <Tab value="detail">Details</Tab>
                  <Tab value="studio">Studio</Tab>
                  <Tab value="play">{isModelDriven ? 'Open' : 'Play / embed'}</Tab>
                </TabList>

                {tab === 'detail' && (
                  <>
                    <div className={s.metaGrid}>
                      <span className={s.metaKey}>Display name</span><span><strong>{app.displayName}</strong></span>
                      <span className={s.metaKey}>App id</span><span><code>{app.name}</code></span>
                      <span className={s.metaKey}>Type</span><span><Badge appearance="tint" color="brand">{app.appType || '—'}</Badge></span>
                      <span className={s.metaKey}>Owner</span><span>{app.owner?.displayName || app.owner?.email || '—'}</span>
                      <span className={s.metaKey}>Version</span><span>{app.appVersion || '—'}</span>
                      <span className={s.metaKey}>Created</span><span>{app.createdTime || '—'}</span>
                      <span className={s.metaKey}>Modified</span><span>{app.lastModifiedTime || '—'}</span>
                      <span className={s.metaKey}>Shared with</span><span>{`${app.sharedUsersCount ?? 0} user(s), ${app.sharedGroupsCount ?? 0} group(s)`}</span>
                      <span className={s.metaKey}>Play URL</span><span>{app.playerEmbedUri ? <a href={app.playerEmbedUri} target="_blank" rel="noreferrer">{app.playerEmbedUri}</a> : '—'}</span>
                    </div>

                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Connectors / data sources</Subtitle2>
                    {(app.connectionReferences && app.connectionReferences.length > 0)
                      ? (
                        <div className={s.tableWrap}>
                          <Table aria-label="Connectors" size="small">
                            <TableHeader className={s.stickyHead}><TableRow>
                              <TableHeaderCell>Connector</TableHeaderCell>
                              <TableHeaderCell>Id</TableHeaderCell>
                              <TableHeaderCell>Data sources</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {app.connectionReferences.map((c, i) => (
                                <TableRow key={c.id || i}>
                                  <TableCell className={s.cell}><strong>{c.displayName || c.id}</strong></TableCell>
                                  <TableCell className={s.cell}>{c.id || '—'}</TableCell>
                                  <TableCell className={s.cell}>{(c.dataSources || []).join(', ') || '—'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )
                      : <EmptyText>No connector references reported for this app.</EmptyText>}

                    <div className={s.toolbar}>
                      {pick && !isBound && (
                        <Button appearance="primary" disabled={actionBusy} onClick={() => bind(app.name, app.appType)}>
                          {actionBusy ? 'Binding…' : 'Bind this app'}
                        </Button>
                      )}
                      {isBound && pick && pick.appId !== boundAppId && (
                        <Button appearance="primary" disabled={actionBusy} onClick={() => bind(app.name, app.appType)}>
                          {actionBusy ? 'Re-binding…' : 'Re-bind to this app'}
                        </Button>
                      )}
                      <Button appearance="secondary" disabled={actionBusy} onClick={() => { void publish(); }}>
                        {actionBusy ? 'Publishing…' : 'Publish latest revision'}
                      </Button>
                    </div>
                  </>
                )}

                {tab === 'studio' && (
                  <PowerAppsStudioTab
                    appId={app.name}
                    envId={env.selected}
                    appType={app.appType || boundAppType}
                    displayName={app.displayName}
                  />
                )}

                {tab === 'play' && (
                  <>
                    {isModelDriven && (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          <MessageBarTitle>Model-driven apps open in a new tab</MessageBarTitle>
                          Model-driven apps render against the Dataverse environment URL and don&apos;t support
                          third-party iframe embedding. Use the deep link below.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {canIframe && !embedBlocked && (
                      <iframe
                        title={`Power App player — ${app.displayName}`}
                        src={app.playerEmbedUri}
                        style={{ width: '100%', height: 720, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}
                        allow="geolocation; microphone; camera; clipboard-write; clipboard-read"
                        onError={() => setEmbedBlocked(true)}
                      />
                    )}
                    {canIframe && embedBlocked && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Embed blocked</MessageBarTitle>
                          The web player refused to load in an iframe (tenant iframe policy or sign-in required).
                          Open it directly:{' '}
                          <a href={app.playerEmbedUri} target="_blank" rel="noreferrer">Open the app</a>.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {app.playerEmbedUri && (
                      <Caption1>
                        <a href={app.playerEmbedUri} target="_blank" rel="noreferrer">
                          {isModelDriven ? 'Open in Power Apps' : 'Open player in a new tab'}
                        </a>
                        {canIframe && !embedBlocked && (
                          <>{' · '}<a href="#" onClick={(e) => { e.preventDefault(); setEmbedBlocked(true); }}>use new-tab fallback</a></>
                        )}
                      </Caption1>
                    )}
                    {!app.playerEmbedUri && <EmptyText>No play URL available for this app.</EmptyText>}
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* ===== App list (pick to bind / browse). Hidden while previewing a pick. ===== */}
        {!pick && env.selected && (
          <>
            {listSt.loading && <Spinner size="small" label="Loading apps…" labelPosition="after" />}
            {listSt.error && <ErrorBar msg={listSt.error} hint={listSt.hint} />}
            {apps.length === 0 && !listSt.loading && !listSt.error && (
              <EmptyText>No Power Apps in this environment.</EmptyText>
            )}
            {apps.length > 0 && (
              <>
                <Caption1>Apps in this environment{isBound ? ' — pick another to re-bind' : ' — pick one to bind'}</Caption1>
                <TableFilter
                  value={appFilter}
                  onChange={setAppFilter}
                  placeholder="Filter apps by name, type, or owner…"
                  shown={visibleApps.length}
                  total={apps.length}
                  unit="app(s)"
                />
                {visibleApps.length === 0
                  ? <EmptyText>No apps match &ldquo;{appFilter}&rdquo;.</EmptyText>
                  : (
                <div className={s.tableWrap}>
                  <Table aria-label="Power Apps" size="small">
                    <TableHeader className={s.stickyHead}><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Owner</TableHeaderCell>
                      <TableHeaderCell>Last modified</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {visibleApps.map((a) => (
                        <TableRow key={a.name}>
                          <TableCell className={s.cellClickable} onClick={() => { setPick({ appId: a.name, appType: a.appType }); setTab('detail'); setEmbedBlocked(false); }}>
                            <strong>{a.displayName}</strong>
                            {a.name === boundAppId && <Badge size="small" appearance="tint" color="success" style={{ marginLeft: tokens.spacingHorizontalXS }}>Bound</Badge>}
                          </TableCell>
                          <TableCell className={s.cell}>{a.appType || '—'}</TableCell>
                          <TableCell className={s.cell}>{a.owner?.displayName || a.owner?.email || '—'}</TableCell>
                          <TableCell className={s.cell}>{a.lastModifiedTime || '—'}</TableCell>
                          <TableCell className={s.cell}>
                            <a href="#" onClick={(e) => { e.preventDefault(); setPick({ appId: a.name, appType: a.appType }); setTab('detail'); }}>Open</a>
                            {' · '}
                            <a href="#" onClick={(e) => { e.preventDefault(); void bind(a.name, a.appType); }}>{a.name === boundAppId ? 'Re-bind' : 'Bind'}</a>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                  )}
              </>
            )}
          </>
        )}
      </div>
    } />
  );
}

// ============================================================
// 4. PowerAutomateFlowEditor
// ============================================================

interface Flow { name: string; displayName: string; state?: string; triggerType?: string; createdTime?: string; lastModifiedTime?: string; }
interface FRun { name: string; status?: string; startTime?: string; endTime?: string; errorCode?: string; errorMessage?: string; }

export function PowerAutomateFlowEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [listSt, reloadList] = useApi<{ ok: boolean; flows: Flow[] }>(
    env.selected ? `/api/items/power-automate-flow${envQ}` : null,
    [env.selected],
  );
  const [selected, setSelected] = useState<string | null>(id !== 'new' ? id : null);
  const [flowTab, setFlowTab] = useState<'designer' | 'runs'>('designer');
  const [newFlowOpen, setNewFlowOpen] = useState(false);
  const [detailSt] = useApi<{ ok: boolean; flow: Flow }>(
    env.selected && selected ? `/api/items/power-automate-flow/${encodeURIComponent(selected)}${envQ}` : null,
    [env.selected, selected],
  );
  const [runsSt, reloadRuns] = useApi<{ ok: boolean; runs: FRun[] }>(
    env.selected && selected ? `/api/items/power-automate-flow/${encodeURIComponent(selected)}/runs${envQ}` : null,
    [env.selected, selected],
  );
  const [runBusy, setRunBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  const triggerRun = useCallback(async () => {
    if (!env.selected || !selected) return;
    setRunBusy(true); setRunMsg(null);
    try {
      const r = await fetch(`/api/items/power-automate-flow/${encodeURIComponent(selected)}/run?envId=${encodeURIComponent(env.selected)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) setRunMsg(`Run failed: ${j.error || r.status}${j.hint ? ` — ${j.hint}` : ''}`);
      else { setRunMsg(`Run started${j.runName ? `: ${j.runName}` : ''}`); reloadRuns(); }
    } catch (e: any) {
      setRunMsg(`Run failed: ${e?.message || String(e)}`);
    } finally {
      setRunBusy(false);
    }
  }, [env.selected, selected, reloadRuns]);

  const flows = listSt.data?.flows || [];
  const [flowFilter, setFlowFilter] = useState('');
  const flowQuery = flowFilter.trim().toLowerCase();
  const visibleFlows = useMemo(() => {
    if (!flowQuery) return flows;
    return flows.filter((f) =>
      f.displayName.toLowerCase().includes(flowQuery)
      || (f.state || '').toLowerCase().includes(flowQuery)
      || (f.triggerType || '').toLowerCase().includes(flowQuery));
  }, [flows, flowQuery]);
  const ribbon = baseRibbon(
    reloadList,
    env.selected ? `https://make.powerautomate.com/environments/${encodeURIComponent(env.selected)}/flows` : undefined,
  );

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {id === 'new' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Create, author, or run a cloud flow</MessageBarTitle>
              Use <strong>New flow</strong> to create a modern cloud flow in-product (real Dataverse
              <code> workflow</code> write), then author its Logic Apps definition and connection references on the
              <strong> Designer</strong> tab and turn it on — all without leaving Loom. The visual drag-drop canvas
              needs a delegated user token and opens in a new tab. Triggering runs and run history are on the
              <strong> Runs</strong> view. Pick a flow below or create one.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadList}>Reload</Button>
          {env.selected && !selected && (
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => setNewFlowOpen(true)}>New flow</Button>
          )}
          {selected && (
            <Button appearance="primary" disabled={runBusy} onClick={triggerRun}>
              {runBusy ? 'Running…' : 'Run flow'}
            </Button>
          )}
        </div>

        {/* ----- New flow (in-product create — real Dataverse workflow row) ----- */}
        <Dialog open={newFlowOpen} onOpenChange={(_, d) => setNewFlowOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>New cloud flow</DialogTitle>
              <DialogContent>
                <NewFlowAuthor
                  envId={env.selected}
                  onCreated={(workflowId) => {
                    setNewFlowOpen(false);
                    reloadList();
                    setSelected(workflowId);
                    setFlowTab('designer');
                  }}
                />
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Close</Button></DialogTrigger>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        {runMsg && <MessageBar intent={runMsg.startsWith('Run failed') ? 'error' : 'success'}><MessageBarBody>{runMsg}</MessageBarBody></MessageBar>}
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.selected && !env.loading && <EmptyText>Select an environment to list its flows.</EmptyText>}
        {listSt.loading && <Spinner size="small" label="Loading flows…" labelPosition="after" />}
        {listSt.error && <ErrorBar msg={listSt.error} hint={listSt.hint} />}
        {!selected && flows.length === 0 && !listSt.loading && env.selected && !listSt.error && (
          <EmptyText>No flows in this environment.</EmptyText>
        )}
        {!selected && flows.length > 0 && (
          <>
          <TableFilter
            value={flowFilter}
            onChange={setFlowFilter}
            placeholder="Filter flows by name, state, or trigger…"
            shown={visibleFlows.length}
            total={flows.length}
            unit="flow(s)"
          />
          {visibleFlows.length === 0
            ? <EmptyText>No flows match &ldquo;{flowFilter}&rdquo;.</EmptyText>
            : (
          <div className={s.tableWrap}>
            <Table aria-label="Flows" size="small">
              <TableHeader className={s.stickyHead}><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Trigger</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {visibleFlows.map((f) => (
                  <TableRow key={f.name}>
                    <TableCell className={s.cellClickable} onClick={() => setSelected(f.name)}>
                      <strong>{f.displayName}</strong>
                    </TableCell>
                    <TableCell className={s.cell}>
                      <Badge appearance="tint" color={f.state === 'Started' ? 'success' : f.state === 'Stopped' ? 'danger' : 'subtle'}>
                        {f.state || '—'}
                      </Badge>
                    </TableCell>
                    <TableCell className={s.cell}>{f.triggerType || '—'}</TableCell>
                    <TableCell className={s.cell}>{f.lastModifiedTime || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
            )}
          </>
        )}
        {selected && (
          <>
            <Button appearance="subtle" onClick={() => setSelected(null)}>&larr; Back to flows</Button>
            <TabList selectedValue={flowTab} onTabSelect={(_, d) => setFlowTab(d.value as 'designer' | 'runs')}>
              <Tab value="designer">Designer</Tab>
              <Tab value="runs">Runs</Tab>
            </TabList>

            {flowTab === 'designer' && (
              <PowerAutomateDesignerTab
                envId={env.selected}
                flowId={selected}
                flow={detailSt.data?.flow || null}
              />
            )}

            {flowTab === 'runs' && (
              <>
                <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Recent runs</Subtitle2>
                {runsSt.loading && <Spinner size="small" label="Loading runs…" labelPosition="after" />}
                {runsSt.error && <ErrorBar msg={runsSt.error} hint={runsSt.hint} />}
                {runsSt.data && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Runs" size="small">
                      <TableHeader className={s.stickyHead}><TableRow>
                        <TableHeaderCell>Run</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Started</TableHeaderCell>
                        <TableHeaderCell>Ended</TableHeaderCell>
                        <TableHeaderCell>Error</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {(runsSt.data.runs || []).map((r) => (
                          <TableRow key={r.name}>
                            <TableCell className={s.cell}>{r.name}</TableCell>
                            <TableCell className={s.cell}>
                              <Badge appearance="tint" color={r.status === 'Succeeded' ? 'success' : r.status === 'Failed' ? 'danger' : 'subtle'}>
                                {r.status || '—'}
                              </Badge>
                            </TableCell>
                            <TableCell className={s.cell}>{r.startTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.endTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.errorMessage || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    } />
  );
}

// ============================================================
// 5. PowerPageEditor
// ============================================================

interface Page { websiteid?: string; name: string; primarydomainname?: string; websiteurl?: string; status?: string; type?: string; createdon?: string; modifiedon?: string; }

export function PowerPageEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [listSt, reloadList] = useApi<{ ok: boolean; pages: Page[] }>(
    env.selected ? `/api/items/power-page${envQ}` : null,
    [env.selected],
  );
  const [selected, setSelected] = useState<string | null>(id !== 'new' ? id : null);
  const [detailSt] = useApi<{ ok: boolean; page: Page }>(
    env.selected && selected ? `/api/items/power-page/${encodeURIComponent(selected)}${envQ}` : null,
    [env.selected, selected],
  );
  const pages = listSt.data?.pages || [];
  const [pageFilter, setPageFilter] = useState('');
  const pageQuery = pageFilter.trim().toLowerCase();
  const visiblePages = useMemo(() => {
    if (!pageQuery) return pages;
    return pages.filter((p) =>
      p.name.toLowerCase().includes(pageQuery)
      || (p.primarydomainname || '').toLowerCase().includes(pageQuery)
      || (p.type || '').toLowerCase().includes(pageQuery));
  }, [pages, pageQuery]);
  const ribbon = baseRibbon(reloadList, 'https://make.powerpages.microsoft.com');

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power Pages design + lifecycle run outside Loom&apos;s identity</MessageBarTitle>
            Pages, templates, web roles, and content snippets edit in the proprietary Power Pages design studio
            (no public design API). Site <strong>lifecycle</strong> (provision / delete / restart, WAF, allowed-IPs,
            security scan) is exposed only through the Power Pages admin API
            (<code>api.powerplatform.com/powerpages</code>), which <strong>requires username/password (delegated)
            authentication and does not support the service-principal flow Loom uses</strong> — so those operations
            can&apos;t run under Loom&apos;s UAMI identity and must be performed in the Power Platform admin centre or
            with a user credential. This editor is a real read-only registry of deployed sites (Dataverse
            <code> mspp_website</code>): click a URL to open the live page; click a row for metadata. To author or
            manage lifecycle, open <code>make.powerpages.microsoft.com</code>.
          </MessageBarBody>
        </MessageBar>
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadList}>Reload</Button>
        </div>
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.selected && !env.loading && <EmptyText>Select an environment to list its Power Pages sites.</EmptyText>}
        {listSt.loading && <Spinner size="small" label="Loading sites…" labelPosition="after" />}
        {listSt.error && <ErrorBar msg={listSt.error} hint={listSt.hint} />}
        {!selected && pages.length === 0 && !listSt.loading && env.selected && !listSt.error && (
          <EmptyText>No Power Pages sites in this environment.</EmptyText>
        )}
        {!selected && pages.length > 0 && (
          <>
          <TableFilter
            value={pageFilter}
            onChange={setPageFilter}
            placeholder="Filter sites by name, domain, or type…"
            shown={visiblePages.length}
            total={pages.length}
            unit="site(s)"
          />
          {visiblePages.length === 0
            ? <EmptyText>No sites match &ldquo;{pageFilter}&rdquo;.</EmptyText>
            : (
          <div className={s.tableWrap}>
            <Table aria-label="Power Pages" size="small">
              <TableHeader className={s.stickyHead}><TableRow>
                <TableHeaderCell>Site</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {visiblePages.map((p) => (
                  <TableRow key={p.websiteid || p.name}>
                    <TableCell className={s.cellClickable} onClick={() => p.websiteid && setSelected(p.websiteid)}>
                      <strong>{p.name}</strong>
                    </TableCell>
                    <TableCell className={s.cell}>
                      {p.websiteurl ? <a href={p.websiteurl} target="_blank" rel="noreferrer">{p.primarydomainname || p.websiteurl}</a> : p.primarydomainname || '—'}
                    </TableCell>
                    <TableCell className={s.cell}>
                      <Badge appearance="tint" color={p.status?.toLowerCase().includes('active') || p.status === '1' ? 'success' : 'subtle'}>
                        {p.status || '—'}
                      </Badge>
                    </TableCell>
                    <TableCell className={s.cell}>{p.type || '—'}</TableCell>
                    <TableCell className={s.cell}>{p.modifiedon || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
            )}
          </>
        )}
        {selected && (
          <>
            <Button appearance="subtle" onClick={() => setSelected(null)}>&larr; Back to sites</Button>
            {detailSt.loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
            {detailSt.error && <ErrorBar msg={detailSt.error} hint={detailSt.hint} />}
            {detailSt.data?.page && (
              <div className={s.metaGrid}>
                <span className={s.metaKey}>Site name</span><span><strong>{detailSt.data.page.name}</strong></span>
                <span className={s.metaKey}>Website ID</span><span>{detailSt.data.page.websiteid}</span>
                <span className={s.metaKey}>Domain</span><span>{detailSt.data.page.primarydomainname || '—'}</span>
                <span className={s.metaKey}>URL</span><span>{detailSt.data.page.websiteurl ? <a href={detailSt.data.page.websiteurl} target="_blank" rel="noreferrer">{detailSt.data.page.websiteurl}</a> : '—'}</span>
                <span className={s.metaKey}>Status</span><span><Badge appearance="tint" color="brand">{detailSt.data.page.status || '—'}</Badge></span>
                <span className={s.metaKey}>Type</span><span>{detailSt.data.page.type || '—'}</span>
                <span className={s.metaKey}>Created</span><span>{detailSt.data.page.createdon || '—'}</span>
                <span className={s.metaKey}>Modified</span><span>{detailSt.data.page.modifiedon || '—'}</span>
              </div>
            )}
          </>
        )}
      </div>
    } />
  );
}

// ============================================================
// 6. AiBuilderModelEditor
// ============================================================

interface AiModel { msdyn_aimodelid: string; msdyn_name: string; msdyn_modelcreationcontext?: string; msdyn_typename?: string; templateName?: string; statecode?: number; statuscode?: number; createdon?: string; modifiedon?: string; }

// `aiStateLabel` / `aiStatusLabel` are imported from `_family-utils`
// (vitest coverage at `lib/editors/__tests__/family-utils.test.ts`).

export function AiBuilderModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [listSt, reloadList] = useApi<{ ok: boolean; models: AiModel[] }>(
    env.selected ? `/api/items/ai-builder-model${envQ}` : null,
    [env.selected],
  );
  const [selected, setSelected] = useState<string | null>(id !== 'new' ? id : null);
  const [detailSt, reloadDetail] = useApi<{ ok: boolean; model: AiModel }>(
    env.selected && selected ? `/api/items/ai-builder-model/${encodeURIComponent(selected)}${envQ}` : null,
    [env.selected, selected],
  );
  const models = listSt.data?.models || [];
  const [modelFilter, setModelFilter] = useState('');
  const modelQuery = modelFilter.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    if (!modelQuery) return models;
    return models.filter((m) =>
      m.msdyn_name.toLowerCase().includes(modelQuery)
      || (m.templateName || m.msdyn_typename || '').toLowerCase().includes(modelQuery));
  }, [models, modelQuery]);

  // Train / Publish / Predict action state.
  const [busy, setBusy] = useState<null | 'train' | 'publish' | 'predict'>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [predictJson, setPredictJson] = useState('{\n  "V2": {}\n}');
  const [predictResult, setPredictResult] = useState<string | null>(null);

  const runAction = useCallback(async (kind: 'train' | 'publish') => {
    if (!env.selected || !selected) return;
    setBusy(kind); setActionMsg(null);
    try {
      const r = await fetch(`/api/items/ai-builder-model/${encodeURIComponent(selected)}/${kind}?envId=${encodeURIComponent(env.selected)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envId: env.selected }),
      });
      const j = await r.json();
      if (!j.ok) setActionMsg({ ok: false, text: `${kind} failed: ${j.error || r.status}${j.hint ? ` — ${j.hint}` : ''}` });
      else { setActionMsg({ ok: true, text: `${kind === 'train' ? 'Training started' : 'Model published'}.` }); reloadDetail(); reloadList(); }
    } catch (e: any) { setActionMsg({ ok: false, text: `${kind} failed: ${e?.message || String(e)}` }); }
    finally { setBusy(null); }
  }, [env.selected, selected, reloadDetail, reloadList]);

  const runPredict = useCallback(async () => {
    if (!env.selected || !selected) return;
    setBusy('predict'); setActionMsg(null); setPredictResult(null);
    try {
      const r = await fetch(`/api/items/ai-builder-model/${encodeURIComponent(selected)}/predict`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId: env.selected, requestJson: predictJson }),
      });
      const j = await r.json();
      if (!j.ok) setActionMsg({ ok: false, text: `Predict failed: ${j.error || r.status}${j.hint ? ` — ${j.hint}` : ''}` });
      else setPredictResult(JSON.stringify(j.result, null, 2));
    } catch (e: any) { setActionMsg({ ok: false, text: `Predict failed: ${e?.message || String(e)}` }); }
    finally { setBusy(null); }
  }, [env.selected, selected, predictJson]);

  const ribbon = baseRibbon(
    reloadList,
    env.selected ? `https://make.powerapps.com/environments/${encodeURIComponent(env.selected)}/aibuilder/models` : undefined,
    selected ? [{ label: 'Model', actions: [
      { label: 'Train', onClick: () => runAction('train'), disabled: busy !== null },
      { label: 'Publish', onClick: () => runAction('publish'), disabled: busy !== null },
      { label: 'Predict', onClick: runPredict, disabled: busy !== null },
    ] }] : undefined,
  );

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {id === 'new' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>New AI Builder models are authored in the Maker portal</MessageBarTitle>
              Choosing a model type and configuring training data is done in <code>make.powerapps.com → AI hub</code>.
              This editor lists every model in <code>msdyn_aimodel</code> and runs the real lifecycle actions —
              <strong> Train</strong>, <strong>Publish</strong>, and real-time <strong>Predict</strong> — against the Dataverse Web API.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadList}>Reload</Button>
        </div>
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.selected && !env.loading && <EmptyText>Select an environment to list its AI Builder models.</EmptyText>}
        {listSt.loading && <Spinner size="small" label="Loading models…" labelPosition="after" />}
        {listSt.error && <ErrorBar msg={listSt.error} hint={listSt.hint} />}
        {!selected && models.length === 0 && !listSt.loading && env.selected && !listSt.error && (
          <EmptyText>No AI Builder models in this environment.</EmptyText>
        )}
        {!selected && models.length > 0 && (
          <>
          <TableFilter
            value={modelFilter}
            onChange={setModelFilter}
            placeholder="Filter models by name or type…"
            shown={visibleModels.length}
            total={models.length}
            unit="model(s)"
          />
          {visibleModels.length === 0
            ? <EmptyText>No models match &ldquo;{modelFilter}&rdquo;.</EmptyText>
            : (
          <div className={s.tableWrap}>
            <Table aria-label="AI Builder models" size="small">
              <TableHeader className={s.stickyHead}><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Template / Type</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {visibleModels.map((m) => (
                  <TableRow key={m.msdyn_aimodelid}>
                    <TableCell className={s.cellClickable} onClick={() => setSelected(m.msdyn_aimodelid)}>
                      <strong>{m.msdyn_name}</strong>
                    </TableCell>
                    <TableCell className={s.cell}>{m.templateName || m.msdyn_typename || '—'}</TableCell>
                    <TableCell className={s.cell}>
                      <Badge appearance="tint" color={m.statecode === 0 ? 'success' : 'subtle'}>{aiStateLabel(m.statecode)}</Badge>
                    </TableCell>
                    <TableCell className={s.cell}>
                      <Badge appearance="tint" color={m.statuscode === 3 ? 'success' : m.statuscode === 5 ? 'danger' : 'brand'}>
                        {aiStatusLabel(m.statuscode)}
                      </Badge>
                    </TableCell>
                    <TableCell className={s.cell}>{m.modifiedon || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
            )}
          </>
        )}
        {selected && (
          <>
            <Button appearance="subtle" onClick={() => setSelected(null)}>&larr; Back to models</Button>
            {detailSt.loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
            {detailSt.error && <ErrorBar msg={detailSt.error} hint={detailSt.hint} />}
            {detailSt.data?.model && (
              <div className={s.metaGrid}>
                <span className={s.metaKey}>Name</span><span><strong>{detailSt.data.model.msdyn_name}</strong></span>
                <span className={s.metaKey}>Model ID</span><span>{detailSt.data.model.msdyn_aimodelid}</span>
                <span className={s.metaKey}>Template</span><span>{detailSt.data.model.templateName || '—'}</span>
                <span className={s.metaKey}>Type</span><span>{detailSt.data.model.msdyn_typename || '—'}</span>
                <span className={s.metaKey}>Creation context</span><span>{detailSt.data.model.msdyn_modelcreationcontext || '—'}</span>
                <span className={s.metaKey}>State</span><span><Badge appearance="tint" color={detailSt.data.model.statecode === 0 ? 'success' : 'subtle'}>{aiStateLabel(detailSt.data.model.statecode)}</Badge></span>
                <span className={s.metaKey}>Status</span><span><Badge appearance="tint" color="brand">{aiStatusLabel(detailSt.data.model.statuscode)}</Badge></span>
                <span className={s.metaKey}>Created</span><span>{detailSt.data.model.createdon || '—'}</span>
                <span className={s.metaKey}>Modified</span><span>{detailSt.data.model.modifiedon || '—'}</span>
              </div>
            )}
            {detailSt.data?.model && (
              <>
                <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Lifecycle</Subtitle2>
                <div className={s.toolbar}>
                  <Button appearance="primary" disabled={busy !== null} onClick={() => runAction('train')}>
                    {busy === 'train' ? 'Training…' : 'Train'}
                  </Button>
                  <Button appearance="outline" disabled={busy !== null} onClick={() => runAction('publish')}>
                    {busy === 'publish' ? 'Publishing…' : 'Publish'}
                  </Button>
                </div>
                {actionMsg && (
                  <MessageBar intent={actionMsg.ok ? 'success' : 'error'}>
                    <MessageBarBody>{actionMsg.text}</MessageBarBody>
                  </MessageBar>
                )}
                <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Real-time prediction</Subtitle2>
                <Caption1>
                  POSTs to the Dataverse <code>Predict</code> action. The input shape is model-specific — e.g. a
                  prediction model expects <code>{'{ "V2": { "&lt;column&gt;": value } }'}</code>. Only published
                  models created after 2020-04-02 support real-time predict.
                </Caption1>
                <Field label="Predict request (JSON)">
                  <Textarea
                    rows={6}
                    resize="vertical"
                    value={predictJson}
                    onChange={(_, d) => setPredictJson(d.value)}
                    style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}
                  />
                </Field>
                <div>
                  <Button appearance="primary" disabled={busy !== null} onClick={runPredict}>
                    {busy === 'predict' ? 'Predicting…' : 'Run prediction'}
                  </Button>
                </div>
                {predictResult && (
                  <div className={s.tableWrap} style={{ padding: tokens.spacingVerticalS }}>
                    <pre style={{ margin: 0, fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{predictResult}</pre>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    } />
  );
}

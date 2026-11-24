'use client';

/**
 * HealthTenantEditor - the `health-tenant` item (LHDS W1-7).
 *
 * Opens straight on the real Overview. There is no "bind me first" form
 * (auto-bind-by-default.md section 4): on open it asks the BFF to ensure the
 * tenant (POST /api/health/tenants/[id], idempotent), and while the control
 * plane's tenant.create job runs it shows the job's receipts as progress on the
 * Overview itself. A genuine gate (control plane not configured, no healthy
 * stamp) renders through HonestGate with its inline Fix-it; the Overview still
 * renders around it.
 *
 * Azure-native: the data here is the control plane's tenant record and the
 * create job's readback receipts. No Fabric / Power BI host is reachable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Badge, Body1, Button, Caption1, Field, Input, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle,
  ProgressBar, Subtitle2, Tab, TabList, Table, TableBody, TableCell, TableHeader, TableHeaderCell,
  TableRow, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, HeartPulse20Regular, ShieldCheckmark20Regular, Wrench16Regular, PauseCircle20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from '../item-editor-chrome';
import { SmartAppsTab } from './smart-apps-tab';
import { HonestGate, GateFixitDialog } from '@/lib/components/shared/honest-gate';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { getGate, type GateDef } from '@/lib/gates/registry';
import { DetailsPanel } from '@/lib/components/shared/details-panel';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, margin: 0, padding: 0, listStyle: 'none' },
  step: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'baseline', minWidth: 0 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  paneFill: { height: '100%', minWidth: 0, overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  // Narrow: stacked cards. Wide (>=1100px): a resizable SplitPane whose size persists under the storageKey.
  splitHost: { flex: '1 1 auto', minHeight: '420px', minWidth: 0 },
  stackHost: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingVerticalM },
  gateRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  gateTitle: { flex: '1 1 0', minWidth: 0, overflowWrap: 'anywhere' },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
});

type Phase = 'loading' | 'unbound' | 'provisioning' | 'bound' | 'failed';

interface Receipt { at: string; step: string; detail: string }
interface Job { id: string; state: string; receipts: Receipt[]; error?: { code: string; message: string } }
interface Resource { kind: string; id: string; name: string }
interface Binding {
  tenantId: string; sourceName: string; tenantIdSanitized: boolean; stampId: string; createJobId?: string;
  status: 'provisioning' | 'bound' | 'failed'; boundAt?: string; verifiedAt?: string; resources: Resource[];
  lastError?: { code: string; message: string };
}
interface Tenant { id: string; displayName: string; stampId: string; status: string; quotas: { maxRequestsPerMinute: number; maxStorageGiB: number } }
interface StampInfo { id: string; status: string; pauseReason?: string }
interface GateBlock { id: string; title?: string; remediation?: string; missing?: string[]; fixItHref?: string }

interface View {
  phase: Phase;
  binding: Binding | null;
  tenant: Tenant | null;
  job: Job | null;
  gate: GateBlock | null;
  /** The tenant's stamp, when the BFF reports it. */
  stamp: StampInfo | null;
  /** Non-gate failure of the ensure call (permission, control plane unreachable). */
  problem: { title: string; text: string } | null;
  liveError: { code: string; message: string } | null;
}

const EMPTY: View = { phase: 'loading', binding: null, tenant: null, job: null, gate: null, stamp: null, problem: null, liveError: null };
const POLL_MS = 5000;

/** The five LHDS gates that apply to this editor (lib/gates/registry/health.ts). */
export const HEALTH_EDITOR_GATE_IDS = [
  'health-control-plane', 'health-stamp-capacity', 'health-gov-image-gate',
  'health-auth-graph-consent', 'health-lakehouse-isolation',
] as const;

/** The ensure (POST) reply carries no stamp; keep the one the GET read so the paused banner does not vanish on open. */
export function keepStamp(next: View, prev: Pick<View, 'stamp'>): View {
  return { ...next, stamp: next.stamp ?? prev.stamp };
}

export interface PausedNotice { stampId: string; reason?: string }

/**
 * The paused-stamp notice, or null. Two honest sources: the stamp the BFF read
 * from the control plane (status 'paused'), or the stamp-capacity gate the
 * provisioner raised because the configured stamp is not healthy. A draining,
 * evacuated or creating stamp is NOT paused and yields null.
 */
export function pausedNotice(view: Pick<View, 'stamp' | 'gate'>): PausedNotice | null {
  if (view.stamp?.status === 'paused') return { stampId: view.stamp.id, reason: view.stamp.pauseReason };
  const g = view.gate;
  if (g?.id === 'health-stamp-capacity' && g.remediation) {
    // Wording built by pickStamp() in provisioners/health-tenant.ts: "... stamp 'ID' is paused (reason); ...".
    const m = /stamp '([^']+)' is paused(?: \(([^)]*)\))?/.exec(g.remediation);
    if (m) return { stampId: m[1]!, reason: m[2] };
  }
  return null;
}

type GateRowStatus = 'configured' | 'blocked' | 'opt-in' | 'cloud-unavailable' | string;

function GateRows({ rows, onResolved }: { rows: Array<{ def: GateDef; status: GateRowStatus }>; onResolved: () => void }) {
  const s = useStyles();
  const [fix, setFix] = useState<GateDef | null>(null);
  return (
    <>
      <ul className={s.steps} aria-label="Tenant prerequisites">
        {rows.map(({ def, status }) => (
          <li key={def.id} className={s.gateRow}>
            <Badge appearance="tint" size="small" color={status === 'configured' ? 'success' : status === 'blocked' ? 'warning' : 'informative'}>
              {status === 'configured' ? 'ready' : status === 'blocked' ? 'needs setup' : status}
            </Badge>
            <span className={s.gateTitle}>{def.title}</span>
            {status !== 'configured' && status !== 'cloud-unavailable' && (
              <Button size="small" appearance="primary" icon={<Wrench16Regular />} aria-label={`Fix it: ${def.title}`} onClick={() => setFix(def)}>Fix it</Button>
            )}
          </li>
        ))}
      </ul>
      {fix && <GateFixitDialog gate={fix} open onClose={() => setFix(null)} onResolved={() => { setFix(null); onResolved(); }} />}
    </>
  );
}

function statusColor(s: string): 'success' | 'danger' | 'warning' | 'informative' {
  if (s === 'active' || s === 'bound' || s === 'succeeded') return 'success';
  if (s === 'failed' || s === 'destroying') return 'danger';
  if (s === 'creating' || s === 'provisioning' || s === 'running' || s === 'queued') return 'warning';
  return 'informative';
}

/** Overview layout: stacked cards when narrow; a resizable SplitPane (persisted size) from 1100px. */
function OverviewLayout({ card, details }: { card: ReactNode; details: ReactNode }) {
  const s = useStyles();
  // ONE copy is rendered (never both): matchMedia is absent in jsdom, which then gets the stacked layout.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(min-width: 1100px)');
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  if (!wide) return <div className={s.stackHost}>{card}{details}</div>;
  return (
    <div className={s.splitHost}>
      <SplitPane direction="horizontal" storageKey="health-tenant-overview" defaultSize="60%" minSize={320} dividerLabel="Resize overview and tenant details">
        <div className={s.paneFill}>{card}</div>
        <div className={s.paneFill}>{details}</div>
      </SplitPane>
    </div>
  );
}

export function HealthTenantEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<'overview' | 'services' | 'quotas' | 'apps'>('overview');
  const [qDraft, setQDraft] = useState<{ rpm: string; gib: string } | null>(null);
  const [qMsg, setQMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [view, setView] = useState<View>(EMPTY);
  const [busy, setBusy] = useState(false);
  const ensured = useRef(false);

  const read = useCallback(async (): Promise<View> => {
    const r = await clientFetch(`/api/health/tenants/${encodeURIComponent(id)}`);
    const j = await r.json();
    if (j?.gated) return { ...EMPTY, phase: 'unbound', gate: j.gate };
    if (!j?.ok) return { ...EMPTY, phase: 'unbound', problem: { title: 'Could not read the tenant', text: j?.error || `HTTP ${r.status}` } };
    return { ...EMPTY, phase: (j.phase as Phase) ?? 'unbound', binding: j.binding, tenant: j.tenant, job: j.job, stamp: j.stamp ?? null, liveError: j.liveError ?? null };
  }, [id]);

  // POST ensure: provision-and-bind, or heal a stale binding. Idempotent on the server.
  const ensure = useCallback(async (retry = false): Promise<View> => {
    const r = await clientFetch(`/api/health/tenants/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retry }),
    });
    const j = await r.json();
    if (j?.gated) return { ...EMPTY, phase: 'unbound', gate: j.gate };
    if (r.status === 403) {
      return { ...EMPTY, phase: 'unbound', problem: { title: 'Health Tenant Admin required', text: `${j?.error || 'You do not hold the health.tenant-admin capability.'} It is an explicit grant: Loom tenant administration does not include it. An administrator grants it at /admin/permissions.` } };
    }
    if (!j?.ok) return { ...EMPTY, phase: 'unbound', problem: { title: 'Provisioning could not start', text: j?.error || `HTTP ${r.status}` } };
    return { ...EMPTY, phase: (j.phase as Phase) ?? 'unbound', binding: j.binding, tenant: j.tenant ?? null, job: j.job ?? null };
  }, [id]);

  const open = useCallback(async () => {
    try {
      const cur = await read();
      setView(cur);
      // Open-time auto-bind: an unbound item, a stale record, or one whose daily verification is due is ensured now.
      if (!ensured.current && !cur.gate && !cur.problem) {
        ensured.current = true;
        { const n = await ensure(); setView((v) => keepStamp(n, v)); }
      }
    } catch (e: any) {
      setView({ ...EMPTY, phase: 'unbound', problem: { title: 'Could not reach the console', text: e?.message || String(e) } });
    }
  }, [read, ensure]);

  useEffect(() => { void open(); }, [open]);

  // Live status of the five health gates. /api/admin/gates is admin-scoped: for anyone else
  // it is a non-OK reply and the Prerequisites list stays empty rather than guessing.
  const [gateRows, setGateRows] = useState<Array<{ def: GateDef; status: string }>>([]);
  const loadGates = useCallback(async () => {
    try {
      const r = await clientFetch('/api/admin/gates');
      if (!r.ok) return;
      const j = await r.json();
      const byId = new Map<string, string>((j?.gates ?? []).map((g: { id: string; status: string }) => [g.id, g.status]));
      const rows: Array<{ def: GateDef; status: string }> = [];
      for (const gid of HEALTH_EDITOR_GATE_IDS) {
        const def = getGate(gid);
        const status = byId.get(gid);
        if (def && status) rows.push({ def, status });
      }
      setGateRows(rows);
    } catch { /* informational: the editor itself does not depend on it */ }
  }, []);
  useEffect(() => { void loadGates(); }, [loadGates]);

  // While the create job runs, follow it; when it finishes, ensure once more to record the readback.
  useEffect(() => {
    if (view.phase !== 'provisioning') return undefined;
    const t = setInterval(async () => {
      try {
        const cur = await read();
        if (cur.job && (cur.job.state === 'succeeded' || cur.job.state === 'failed' || cur.job.state === 'cancelled')) { const n = await ensure(); setView((v) => keepStamp(n, v)); }
        else setView((v) => ({ ...v, job: cur.job ?? v.job, tenant: cur.tenant ?? v.tenant }));
      } catch { /* the next tick retries; the last good view stays on screen */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [view.phase, read, ensure]);

  const act = useCallback(async (retry: boolean) => {
    setBusy(true);
    try { { const n = await ensure(retry); setView((v) => keepStamp(n, v)); } } finally { setBusy(false); }
  }, [ensure]);

  const saveQuotas = useCallback(async (draft: { rpm: string; gib: string }) => {
    setBusy(true);
    setQMsg(null);
    try {
      const r = await clientFetch(`/api/health/tenants/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quotas: { maxRequestsPerMinute: Number(draft.rpm), maxStorageGiB: Number(draft.gib) } }),
      });
      const j = await r.json();
      if (j?.gated) { setView((v) => ({ ...v, gate: j.gate })); return; }
      if (!j?.ok) { setQMsg({ intent: 'error', text: r.status === 403 ? `${j?.error || 'forbidden'}: ${j?.remediation || 'The Health Tenant Admin grant is required.'}` : (j?.error || `HTTP ${r.status}`) }); return; }
      setView((v) => ({ ...v, tenant: j.tenant ?? v.tenant }));
      setQDraft(null);
      setQMsg({ intent: 'success', text: 'Quotas saved on the control plane.' });
    } catch (e: any) {
      setQMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  }, [id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Tenant', actions: [
        { label: 'Verify now', onClick: () => void act(false), disabled: busy || !!view.gate },
        { label: 'Refresh', onClick: () => void open() },
      ] },
      { label: 'View', actions: [
        { label: 'Overview', onClick: () => setTab('overview') },
        { label: 'Services', onClick: () => setTab('services') },
        { label: 'Quotas', onClick: () => setTab('quotas') },
        { label: 'Apps', onClick: () => setTab('apps') },
      ] },
    ] },
  ], [act, open, busy, view.gate]);

  const paused = pausedNotice(view);
  const b = view.binding;
  const t = view.tenant;
  const receipts = view.job?.receipts ?? [];
  const failedMsg = view.phase === 'failed' ? (b?.lastError ?? view.job?.error) : null;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'overview' | 'services' | 'quotas' | 'apps')}>
            <Tab value="overview">Overview</Tab>
            <Tab value="services">Services</Tab>
            <Tab value="quotas">Quotas</Tab>
            <Tab value="apps">Apps</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {view.gate && (
            <HonestGate gate={view.gate} surface="Health tenant" onResolved={() => { ensured.current = false; void open(); }} />
          )}
          {view.problem && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody><MessageBarTitle>{view.problem.title}</MessageBarTitle>{view.problem.text}</MessageBarBody>
              <MessageBarActions><Button size="small" onClick={() => { ensured.current = false; void open(); }}>Try again</Button></MessageBarActions>
            </MessageBar>
          )}
          {view.liveError && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Showing the last recorded state</MessageBarTitle>
                The control plane could not be read just now ({view.liveError.code}: {view.liveError.message}).
              </MessageBarBody>
            </MessageBar>
          )}

          {paused && (
            <MessageBar intent="warning" layout="multiline" icon={<PauseCircle20Regular />}>
              <MessageBarBody>
                <MessageBarTitle>Stamp {paused.stampId} is paused</MessageBarTitle>
                This tenant runs on a paused stamp, so its services are not serving requests until the stamp is resumed.
                {paused.reason ? ` Reason recorded: ${paused.reason}.` : ''} Nothing has been deleted.
              </MessageBarBody>
            </MessageBar>
          )}

          {tab === 'overview' && (
            <OverviewLayout card={(
              <div className={s.card}>
                <div className={s.cardHead}>
                  <Badge appearance="filled" color="brand" icon={<HeartPulse20Regular />}>Health tenant</Badge>
                  <Badge appearance="tint" color={statusColor(view.phase === 'loading' ? 'queued' : view.phase)}>
                    {view.phase === 'loading' ? 'loading' : view.phase === 'unbound' ? 'not provisioned' : view.phase}
                  </Badge>
                  {t && <Badge appearance="outline" color={statusColor(t.status)}>{t.status}</Badge>}
                  <Button appearance="outline" size="small" icon={<ArrowSync20Regular />} disabled={busy || !!view.gate} onClick={() => void act(false)}>Verify now</Button>
                </div>

                {(view.phase === 'loading' || view.phase === 'provisioning') && !view.gate && (
                  <>
                    <ProgressBar aria-label="Provisioning the tenant" />
                    <Caption1>
                      {view.phase === 'loading'
                        ? 'Reading the tenant from the control plane.'
                        : 'Provisioning the tenant on its stamp. This takes a few minutes; you can leave this page.'}
                    </Caption1>
                  </>
                )}

                {failedMsg && (
                  <MessageBar intent="error" layout="multiline">
                    <MessageBarBody><MessageBarTitle>Provisioning failed ({failedMsg.code})</MessageBarTitle>{failedMsg.message}</MessageBarBody>
                    <MessageBarActions><Button size="small" disabled={busy} onClick={() => void act(true)}>Retry</Button></MessageBarActions>
                  </MessageBar>
                )}

                {view.phase === 'bound' && (
                  <div className={s.cardHead}>
                    <ShieldCheckmark20Regular />
                    <Body1>{b?.resources.length ?? 0} resources read back from Azure.</Body1>
                  </div>
                )}

                <Subtitle2>Activity</Subtitle2>
                {receipts.length === 0 ? (
                  <Caption1>{view.gate ? 'No job has run: the gate above must be resolved first.' : 'No job activity recorded yet.'}</Caption1>
                ) : (
                  <ul className={s.steps} aria-label="Create job activity">
                    {receipts.map((r, i) => (
                      <li key={`${r.at}-${i}`} className={s.step}>
                        <Badge appearance="tint" size="small" color="informative">{r.step}</Badge>
                        <span className={s.mono}>{r.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <Subtitle2>Prerequisites</Subtitle2>
                {gateRows.length === 0 ? (
                  <Caption1>Prerequisite status is shown to administrators.</Caption1>
                ) : (
                  <GateRows rows={gateRows} onResolved={() => { ensured.current = false; void loadGates(); void open(); }} />
                )}
              </div>
            )} details={(
              <DetailsPanel
                title="Tenant details"
                subtitle={b?.sourceName ?? item.displayName}
                icon={<HeartPulse20Regular />}
                width="100%"
                sections={[{
                  key: 'identity',
                  title: 'Identity',
                  stats: [
                    { key: 'name', label: 'Display name', value: t?.displayName ?? b?.sourceName ?? '-' },
                    { key: 'id', label: 'Tenant id', value: b?.tenantId ?? '-', hint: b?.tenantIdSanitized ? 'Derived from the display name: lowercase letters, digits and hyphens only.' : undefined },
                    { key: 'stamp', label: 'Stamp', value: t?.stampId ?? b?.stampId ?? '-' },
                    { key: 'verified', label: 'Last verified', value: b?.verifiedAt ? new Date(b.verifiedAt).toLocaleString() : 'not yet' },
                  ],
                }, {
                  key: 'quotas',
                  title: 'Quotas',
                  stats: [
                    { key: 'rpm', label: 'Requests per minute', value: t?.quotas.maxRequestsPerMinute ?? '-' },
                    { key: 'gib', label: 'Storage (GiB)', value: t?.quotas.maxStorageGiB ?? '-' },
                  ],
                }]}
              />
            )} />
          )}

          {tab === 'quotas' && (
            <div className={s.card}>
              <Subtitle2>Quotas</Subtitle2>
              <Caption1>Limits the control plane records for this tenant. Saving writes them to the control plane (PATCH), which is the authority.</Caption1>
              {!t ? (
                <MessageBar intent="info" layout="multiline">
                  <MessageBarBody><MessageBarTitle>No tenant yet</MessageBarTitle>Quotas can be edited once the tenant is registered in the control plane.</MessageBarBody>
                </MessageBar>
              ) : (
                <>
                  <Field label="Requests per minute" hint="Whole number, 1 to 1,000,000.">
                    <Input type="number" value={qDraft?.rpm ?? String(t.quotas.maxRequestsPerMinute)} onChange={(_, d) => setQDraft({ rpm: d.value, gib: qDraft?.gib ?? String(t.quotas.maxStorageGiB) })} />
                  </Field>
                  <Field label="Storage (GiB)" hint="Whole number, 1 to 10,000,000.">
                    <Input type="number" value={qDraft?.gib ?? String(t.quotas.maxStorageGiB)} onChange={(_, d) => setQDraft({ rpm: qDraft?.rpm ?? String(t.quotas.maxRequestsPerMinute), gib: d.value })} />
                  </Field>
                  <div className={s.toolbar}>
                    <Button appearance="primary" disabled={busy || !qDraft} onClick={() => qDraft && void saveQuotas(qDraft)}>Save quotas</Button>
                    <Button disabled={busy || !qDraft} onClick={() => { setQDraft(null); setQMsg(null); }}>Discard</Button>
                  </div>
                </>
              )}
              {qMsg && <MessageBar intent={qMsg.intent} layout="multiline"><MessageBarBody>{qMsg.text}</MessageBarBody></MessageBar>}
            </div>
          )}

          {tab === 'apps' && (
            b ? <SmartAppsTab id={id} /> : (
              <MessageBar intent="info" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>No tenant yet</MessageBarTitle>
                  {view.phase === 'provisioning' ? 'SMART apps can be registered as soon as the tenant finishes provisioning.' : 'SMART apps can be registered once the tenant is provisioned.'}
                </MessageBarBody>
              </MessageBar>
            )
          )}

          {tab === 'services' && (
            (b?.resources.length ?? 0) === 0 ? (
              <MessageBar intent="info" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>No resources read back yet</MessageBarTitle>
                  {view.phase === 'provisioning' ? 'They are listed here as soon as the create job has read each one back from Azure.' : 'Resources appear here once the tenant is provisioned.'}
                </MessageBarBody>
              </MessageBar>
            ) : (
              <div className={s.tableWrap}>
                <Table aria-label="Tenant resources" size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Kind</TableHeaderCell>
                    <TableHeaderCell>Azure name</TableHeaderCell>
                    <TableHeaderCell>Resource id</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {b!.resources.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell><Badge appearance="tint" color="informative">{r.kind}</Badge></TableCell>
                        <TableCell className={s.mono}>{r.name}</TableCell>
                        <TableCell className={s.mono}>{r.id}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          )}
        </div>
      </>
    } />
  );
}

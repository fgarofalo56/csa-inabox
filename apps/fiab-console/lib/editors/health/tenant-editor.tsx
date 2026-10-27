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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle,
  ProgressBar, Subtitle2, Tab, TabList, Table, TableBody, TableCell, TableHeader, TableHeaderCell,
  TableRow, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, HeartPulse20Regular, ShieldCheckmark20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from '../item-editor-chrome';
import { HonestGate } from '@/lib/components/shared/honest-gate';
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
  split: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingVerticalM, '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' } },
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, margin: 0, padding: 0, listStyle: 'none' },
  step: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'baseline', minWidth: 0 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
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
interface GateBlock { id: string; title?: string; remediation?: string; missing?: string[]; fixItHref?: string }

interface View {
  phase: Phase;
  binding: Binding | null;
  tenant: Tenant | null;
  job: Job | null;
  gate: GateBlock | null;
  /** Non-gate failure of the ensure call (permission, control plane unreachable). */
  problem: { title: string; text: string } | null;
  liveError: { code: string; message: string } | null;
}

const EMPTY: View = { phase: 'loading', binding: null, tenant: null, job: null, gate: null, problem: null, liveError: null };
const POLL_MS = 5000;

function statusColor(s: string): 'success' | 'danger' | 'warning' | 'informative' {
  if (s === 'active' || s === 'bound' || s === 'succeeded') return 'success';
  if (s === 'failed' || s === 'destroying') return 'danger';
  if (s === 'creating' || s === 'provisioning' || s === 'running' || s === 'queued') return 'warning';
  return 'informative';
}

export function HealthTenantEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<'overview' | 'services'>('overview');
  const [view, setView] = useState<View>(EMPTY);
  const [busy, setBusy] = useState(false);
  const ensured = useRef(false);

  const read = useCallback(async (): Promise<View> => {
    const r = await clientFetch(`/api/health/tenants/${encodeURIComponent(id)}`);
    const j = await r.json();
    if (j?.gated) return { ...EMPTY, phase: 'unbound', gate: j.gate };
    if (!j?.ok) return { ...EMPTY, phase: 'unbound', problem: { title: 'Could not read the tenant', text: j?.error || `HTTP ${r.status}` } };
    return { ...EMPTY, phase: (j.phase as Phase) ?? 'unbound', binding: j.binding, tenant: j.tenant, job: j.job, liveError: j.liveError ?? null };
  }, [id]);

  // POST ensure: provision-and-bind, or heal a stale binding. Idempotent on the server.
  const ensure = useCallback(async (retry = false): Promise<View> => {
    const r = await clientFetch(`/api/health/tenants/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retry }),
    });
    const j = await r.json();
    if (j?.gated) return { ...EMPTY, phase: 'unbound', gate: j.gate };
    if (r.status === 403) {
      return { ...EMPTY, phase: 'unbound', problem: { title: 'Health Tenant Admin required', text: `${j?.error || 'You do not hold the health.tenant-admin capability.'} An administrator grants it at /admin/permissions.` } };
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
        setView(await ensure());
      }
    } catch (e: any) {
      setView({ ...EMPTY, phase: 'unbound', problem: { title: 'Could not reach the console', text: e?.message || String(e) } });
    }
  }, [read, ensure]);

  useEffect(() => { void open(); }, [open]);

  // While the create job runs, follow it; when it finishes, ensure once more to record the readback.
  useEffect(() => {
    if (view.phase !== 'provisioning') return undefined;
    const t = setInterval(async () => {
      try {
        const cur = await read();
        if (cur.job && (cur.job.state === 'succeeded' || cur.job.state === 'failed' || cur.job.state === 'cancelled')) setView(await ensure());
        else setView((v) => ({ ...v, job: cur.job ?? v.job, tenant: cur.tenant ?? v.tenant }));
      } catch { /* the next tick retries; the last good view stays on screen */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [view.phase, read, ensure]);

  const act = useCallback(async (retry: boolean) => {
    setBusy(true);
    try { setView(await ensure(retry)); } finally { setBusy(false); }
  }, [ensure]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Tenant', actions: [
        { label: 'Verify now', onClick: () => void act(false), disabled: busy || !!view.gate },
        { label: 'Refresh', onClick: () => void open() },
      ] },
      { label: 'View', actions: [
        { label: 'Overview', onClick: () => setTab('overview') },
        { label: 'Services', onClick: () => setTab('services') },
      ] },
    ] },
  ], [act, open, busy, view.gate]);

  const b = view.binding;
  const t = view.tenant;
  const receipts = view.job?.receipts ?? [];
  const failedMsg = view.phase === 'failed' ? (b?.lastError ?? view.job?.error) : null;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'overview' | 'services')}>
            <Tab value="overview">Overview</Tab>
            <Tab value="services">Services</Tab>
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

          {tab === 'overview' && (
            <div className={s.split}>
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
              </div>

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
            </div>
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

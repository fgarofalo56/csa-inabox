'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useConfirm } from '@/lib/components/confirm-dialog';
/**
 * PurviewPanel — inline management for the Purview tab of /admin/security.
 *
 * Sub-tabs:
 *   - Data sources : list registered sources, register new, de-register
 *   - Scans        : list scans per source, trigger run, last 10 runs
 *   - Classifications : link to existing /governance/classifications
 *   - Glossary     : list terms, create new
 *   - Domains      : list / create business domains
 *   - Data quality : list DQ rules (preview)
 *   - Sensitivity  : link to existing /governance/sensitivity
 *   - Lineage      : link to existing /governance/lineage
 *
 * Every fetch surfaces structured errors. A 503 with `code:
 * purview_not_configured` (env var unset) OR a 403 with `code:
 * purview_not_authorized` (UAMI lacks a Data Map role) renders the
 * NotConfiguredBar with the bicep + env + role remediation — never a bare 403.
 * A single status banner (driven by /api/governance/purview/status →
 * probePurview) sits above the sub-tabs so the operator sees the wiring state
 * (live / role_missing / not_configured) at a glance. Other 4xx/5xx render an
 * error MessageBar.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { shorthands,
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  Spinner, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, Body1, Subtitle2, Text,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Input, Field, Dropdown, Option, Textarea, Switch, ProgressBar, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, Add20Regular, Delete20Regular, Play20Regular, Open16Regular,
  Search20Regular, DatabaseSearch24Regular, ScanObject24Regular, Sparkle24Regular,
  ChevronLeft20Regular, ChevronRight20Regular,
  Cloud24Regular, Database24Regular, DataArea24Regular, Flash24Regular, Molecule24Regular,
  CheckmarkCircle20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { NotConfiguredBar, type NotConfiguredHint } from './not-configured-bar';
import {
  PURVIEW_SOURCE_KIND_SPECS, PURVIEW_KIND_SPEC, toPurviewSourceName,
  type DiscoveredPurviewSource,
} from '@/lib/azure/purview-source-mapping';

const useStyles = makeStyles({
  subTabs: { marginBottom: tokens.spacingVerticalM },
  statusBannerWrap: { marginBottom: tokens.spacingVerticalM },
  section: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  toolbar: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  grow: { marginRight: 'auto' },
  filter: { minWidth: '220px' },
  fieldStack: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, minWidth: '360px',
  },
  linkOut: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    textDecoration: 'none', color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color, border-color',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      ...shorthands.borderColor(tokens.colorNeutralStroke1),
    },
  },
  muted: { color: tokens.colorNeutralForeground3 },
  sectionTitle: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  linkCaption: {
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalS,
  },
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  emptyIcon: { fontSize: '28px', color: tokens.colorNeutralForeground4 },
  table: { marginTop: tokens.spacingVerticalXS },
  code: {
    fontSize: tokens.fontSizeBase100,
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
  },
  codeWrap: {
    fontSize: tokens.fontSizeBase100,
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
    wordBreak: 'break-all',
  },
  actionCell: { textAlign: 'right', width: '48px' },
  srOnly: {
    position: 'absolute', width: '1px', height: '1px',
    padding: 0, margin: '-1px', overflow: 'hidden',
    clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
  },
  // -- Register-source wizard ------------------------------------------
  stepper: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalM, flexWrap: 'wrap',
  },
  stepPill: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
  },
  stepPillActive: {
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  stepPillDone: {
    backgroundColor: tokens.colorPaletteGreenBackground2, color: tokens.colorPaletteGreenForeground2,
  },
  wizardBody: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    minWidth: '460px', maxWidth: '620px',
  },
  pickerList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '320px', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS,
  },
  pickerRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer', textAlign: 'left', width: '100%',
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color, border-color, box-shadow',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover, boxShadow: tokens.shadow4,
    },
  },
  pickerRowSelected: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
  },
  pickerIcon: { fontSize: '24px', color: tokens.colorBrandForeground1, flexShrink: 0 },
  pickerText: { display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 },
  pickerSub: { color: tokens.colorNeutralForeground3, wordBreak: 'break-all' },
  reviewGrid: {
    display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS,
    alignItems: 'baseline',
  },
  reviewKey: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  reviewVal: { wordBreak: 'break-all' },
  wizardFooter: { display: 'flex', gap: tokens.spacingHorizontalS, width: '100%', alignItems: 'center' },
  scanBox: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  bulkList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '260px', overflowY: 'auto', marginTop: tokens.spacingVerticalS,
  },
  bulkRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
  },
  okIcon: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  skipIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  errIcon: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
});

interface ApiState<T> {
  loading: boolean;
  data: T | null;
  notConfigured?: NotConfiguredHint;
  error?: string;
  errorStatus?: number;
}

function emptyState<T>(): ApiState<T> { return { loading: false, data: null }; }

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<ApiState<T>> {
  try {
    const r = await fetch(url, init);
    const j = await r.json();
    // Honest gates render the NotConfiguredBar (never a raw red error):
    //   503 + *_not_configured        → Purview/MIP/DLP not provisioned (env var unset)
    //   403 + purview_not_authorized  → account reachable but the Console UAMI lacks a
    //                                   Data Map role on the root collection (the
    //                                   "Not authorized to access account" 403). The
    //                                   BFF attaches the grant remediation in j.hint.
    const isNotConfigured = r.status === 503 && j?.code?.endsWith('_not_configured');
    const isNotAuthorized = r.status === 403 && j?.code === 'purview_not_authorized';
    if (isNotConfigured || isNotAuthorized) {
      return { loading: false, data: null, notConfigured: j.hint, error: j.error, errorStatus: r.status };
    }
    if (!r.ok) {
      return { loading: false, data: null, error: j?.error || `HTTP ${r.status}`, errorStatus: r.status };
    }
    return { loading: false, data: j as T };
  } catch (e: any) {
    return { loading: false, data: null, error: e?.message || String(e) };
  }
}

type SubTab = 'sources' | 'scans' | 'classifications' | 'glossary' | 'domains' | 'dq' | 'sensitivity' | 'lineage';

/**
 * PurviewStatusBanner — one wiring-state banner above the sub-tabs, driven by
 * GET /api/governance/purview/status (→ probePurview). Renders the
 * NotConfiguredBar honest gate when the account is unset (reason:
 * 'not_configured'), the UAMI lacks a Data Map role (reason: 'role_missing' —
 * the 403 this task fixes), or the host is unreachable (reason:
 * 'upstream_error'). When reason === 'live' it renders nothing so the sub-tabs
 * show real data. Fail-open: a failed probe is silent (the per-section fetches
 * still surface their own gates).
 */
interface PurviewStatus {
  ok: boolean;
  configured: boolean;
  account: string | null;
  reason: 'live' | 'not_configured' | 'role_missing' | 'upstream_error';
  message?: string;
  hint?: NotConfiguredHint;
}

function PurviewStatusBanner() {
  const s = useStyles();
  const [status, setStatus] = useState<PurviewStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/governance/purview/status');
        const j = (await r.json()) as PurviewStatus;
        if (!cancelled) setStatus(j);
      } catch {
        /* fail-open — per-section fetches still surface their own gates */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!status || status.reason === 'live') return null;

  const surface =
    status.reason === 'role_missing'
      ? 'Microsoft Purview Data Map (managed identity not authorized)'
      : 'Microsoft Purview Data Map';
  return (
    <div className={s.statusBannerWrap}>
      <NotConfiguredBar
        surface={surface}
        hint={status.hint}
        rawError={status.message}
        portalLink="https://web.purview.azure.com/"
        portalLabel="Open Microsoft Purview"
      />
    </div>
  );
}

export function PurviewPanel() {
  const s = useStyles();
  const [tab, setTab] = useState<SubTab>('sources');

  return (
    <div>
      <PurviewStatusBanner />
      <TabList
        className={s.subTabs}
        selectedValue={tab}
        onTabSelect={(_e: SelectTabEvent, d: SelectTabData) => setTab(d.value as SubTab)}
        size="small"
      >
        <Tab value="sources">Data sources</Tab>
        <Tab value="scans">Scans</Tab>
        <Tab value="classifications">Classifications</Tab>
        <Tab value="glossary">Glossary</Tab>
        <Tab value="domains">Domains</Tab>
        <Tab value="dq">Data quality</Tab>
        <Tab value="sensitivity">Sensitivity</Tab>
        <Tab value="lineage">Lineage</Tab>
      </TabList>

      {tab === 'sources' && <DataSourcesSection />}
      {tab === 'scans' && <ScansSection />}
      {tab === 'classifications' && <ClassificationsSection />}
      {tab === 'glossary' && <GlossarySection />}
      {tab === 'domains' && <DomainsSection />}
      {tab === 'dq' && <DataQualitySection />}
      {tab === 'sensitivity' && <SensitivitySection />}
      {tab === 'lineage' && <LineageSection />}
    </div>
  );
}

// -----------------------------------------------------------------
// Data sources
// -----------------------------------------------------------------

interface SourcesPayload {
  ok: boolean;
  sources?: Array<{ id: string; name: string; kind?: string; endpoint?: string; collectionId?: string }>;
}

type RegisteredSource = NonNullable<SourcesPayload['sources']>[number];

interface DiscoverPayload {
  ok: boolean;
  sources?: DiscoveredPurviewSource[];
  code?: string;
  error?: string;
}
interface CollectionsPayload {
  ok: boolean;
  collections?: Array<{ name: string; friendlyName?: string; parentCollection?: string }>;
}

/** Fluent icon for a Purview source, keyed by the visual tile slug. */
function SourceKindIcon({ slug, className }: { slug?: string; className?: string }): ReactElement {
  switch (slug) {
    case 'storage-adls': return <Cloud24Regular className={className} />;
    case 'azure-sql-database': return <Database24Regular className={className} />;
    case 'synapse-serverless-sql-pool': return <DataArea24Regular className={className} />;
    case 'kql-database': return <Flash24Regular className={className} />;
    case 'cosmos-account': return <Molecule24Regular className={className} />;
    case 'postgres': return <Database24Regular className={className} />;
    default: return <DatabaseSearch24Regular className={className} />;
  }
}

/** Slug lookup for a REGISTERED source (maps its Purview kind → visual slug). */
function slugForKind(kind?: string): string | undefined {
  return kind ? PURVIEW_KIND_SPEC[kind]?.tileSlug : undefined;
}

function DataSourcesSection() {
  const s = useStyles();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [state, setState] = useState<ApiState<SourcesPayload>>(emptyState());
  const [filter, setFilter] = useState('');
  const [scanTarget, setScanTarget] = useState<RegisteredSource | null>(null);

  const load = useCallback(async () => {
    setState((p) => ({ ...p, loading: true }));
    setState(await fetchJson<SourcesPayload>('/api/admin/security/purview/sources'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (name: string) => {
    if (!(await confirm({
      title: `De-register data source "${name}"?`,
      body: 'This removes the source from the Purview Data Map. Existing scan results are retained but no new scans will run.',
      danger: true,
      confirmLabel: 'De-register',
    }))) return;
    const r = await clientFetch(`/api/admin/security/purview/sources?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Delete failed: ${j?.error || r.statusText}`);
    }
    await load();
  };

  return (
    <div className={s.section}>
      {confirmDialog}
      <SetupScanDialog source={scanTarget} onOpenChange={(o) => { if (!o) setScanTarget(null); }} />
      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Registered data sources</Subtitle2>
        <Input
          className={s.filter}
          size="small"
          value={filter}
          onChange={(_: unknown, d: any) => setFilter(d.value)}
          placeholder="Filter by name or kind"
          contentBefore={<Search20Regular />}
          aria-label="Filter data sources"
        />
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
        <AutoAddAllDialog onDone={load} />
        <RegisterSourceWizard onRegistered={load} />
      </div>

      {state.loading && <Spinner label="Loading sources…" />}
      {state.notConfigured && (
        <NotConfiguredBar
          surface="Purview data sources"
          hint={state.notConfigured}
          portalLink="https://web.purview.azure.com/resource/sources"
          portalLabel="Open Purview Data sources"
        />
      )}
      {!state.loading && !state.notConfigured && state.error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load data sources (HTTP {state.errorStatus})</MessageBarTitle>
            {state.error}
          </MessageBarBody>
        </MessageBar>
      )}
      {!state.loading && state.data?.ok && (state.data.sources || []).length === 0 && (
        <div className={s.emptyState}>
          <DatabaseSearch24Regular className={s.emptyIcon} />
          <Caption1 block>
            No data sources registered yet. Click <strong>Register source</strong> to pick one from your
            Loom estate, or <strong>Auto-add all sources</strong> to register everything at once.
          </Caption1>
        </div>
      )}
      {!state.loading && state.data?.ok && (() => {
        const rows = (state.data!.sources || []).filter((src) => {
          const q = filter.trim().toLowerCase();
          if (!q) return true;
          return (src.name || '').toLowerCase().includes(q) || (src.kind || '').toLowerCase().includes(q);
        });
        if ((state.data!.sources || []).length === 0) return null;
        if (rows.length === 0) {
          return (
            <Caption1 block className={s.muted}>
              No data sources match “{filter}”.
            </Caption1>
          );
        }
        return (
          <Table size="small" aria-label="Registered data sources" className={s.table}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Endpoint</TableHeaderCell>
                <TableHeaderCell>Collection</TableHeaderCell>
                <TableHeaderCell className={s.actionCell}><span className={s.srOnly}>Actions</span></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((src) => (
                <TableRow key={src.id || src.name}>
                  <TableCell>
                    <span className={s.sectionTitle}>
                      <SourceKindIcon slug={slugForKind(src.kind)} />
                      <strong>{src.name}</strong>
                    </span>
                  </TableCell>
                  <TableCell><Badge appearance="outline">{src.kind || 'Unknown'}</Badge></TableCell>
                  <TableCell><code className={s.codeWrap}>{src.endpoint || '—'}</code></TableCell>
                  <TableCell>{src.collectionId || '—'}</TableCell>
                  <TableCell className={s.actionCell}>
                    <Button icon={<ScanObject24Regular />} appearance="subtle" size="small"
                      onClick={() => setScanTarget(src)}
                      aria-label={`Register ${src.name} for scanning`} title="Register for scanning" />
                    <Button icon={<Delete20Regular />} appearance="subtle" size="small"
                      onClick={() => remove(src.name)} aria-label={`De-register ${src.name}`} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        );
      })()}
    </div>
  );
}

// -----------------------------------------------------------------
// Register-source WIZARD — auto-populated from the Loom estate (no freeform)
// -----------------------------------------------------------------

function RegisterSourceWizard({ onRegistered }: { onRegistered: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<'loom' | 'custom'>('loom');

  const [discovery, setDiscovery] = useState<ApiState<DiscoverPayload>>(emptyState());
  const [collections, setCollections] = useState<ApiState<CollectionsPayload>>(emptyState());

  const [selectedId, setSelectedId] = useState('');
  const [custom, setCustom] = useState<{ kind: string; endpoint: string }>({
    kind: PURVIEW_SOURCE_KIND_SPECS[0].kind,
    endpoint: '',
  });

  const [name, setName] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [setupScan, setSetupScan] = useState(false);
  const [scanName, setScanName] = useState('');
  const [runNow, setRunNow] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep(1); setMode('loom'); setSelectedId('');
    setCustom({ kind: PURVIEW_SOURCE_KIND_SPECS[0].kind, endpoint: '' });
    setName(''); setCollectionName(''); setSetupScan(false); setScanName(''); setRunNow(false);
    setSubmitting(false); setSubmitError(null);
  }, []);

  // Load the estate + collections when the wizard opens.
  useEffect(() => {
    if (!open) return;
    reset();
    (async () => {
      setDiscovery({ loading: true, data: null });
      setDiscovery(await fetchJson<DiscoverPayload>('/api/admin/security/purview/discover'));
      setCollections({ loading: true, data: null });
      const c = await fetchJson<CollectionsPayload>('/api/admin/security/purview/collections');
      setCollections(c);
      const cols = c.data?.collections || [];
      const root = cols.find((x) => !x.parentCollection) || cols[0];
      if (root) setCollectionName(root.name);
    })();
  }, [open, reset]);

  const sources = discovery.data?.sources || [];
  const selected = sources.find((x) => x.armResourceId === selectedId);
  const activeKind = mode === 'loom' ? selected?.kind : custom.kind;
  const spec = activeKind ? PURVIEW_KIND_SPEC[activeKind] : undefined;
  const activeEndpoint = mode === 'loom' ? selected?.endpoint || '' : custom.endpoint.trim();
  const cols = collections.data?.collections || [];

  const step1Ready = mode === 'loom' ? Boolean(selected) : Boolean(custom.endpoint.trim());

  const goStep2 = () => {
    // Prefill the source name + scan name on entry to the Configure step.
    const suggested = mode === 'loom'
      ? (selected?.suggestedName || '')
      : toPurviewSourceName((custom.endpoint.trim().replace(/^[a-z]+:\/\//i, '').split(/[./]/)[0]) || 'source');
    const nm = name || suggested;
    setName(nm);
    if (!scanName) setScanName(toPurviewSourceName(`scan-${nm}`));
    setStep(2);
  };

  const step2Ready = Boolean(name.trim());

  const register = async () => {
    if (!activeKind) return;
    setSubmitting(true); setSubmitError(null);
    try {
      const properties: Record<string, unknown> = mode === 'loom'
        ? { ...(selected?.properties || {}) }
        : { [(spec?.endpointProperty || 'endpoint')]: custom.endpoint.trim() };
      if (collectionName) {
        properties.collection = { referenceName: collectionName, type: 'CollectionReference' };
      }
      const r = await clientFetch('/api/admin/security/purview/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), kind: activeKind, properties }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setSubmitError(j?.error || `Register failed (HTTP ${r.status})`);
        return;
      }
      // Optional: define (and optionally run) a first System scan on the source.
      if (setupScan && spec) {
        const sr = await clientFetch('/api/governance/scans', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            define: true,
            source: name.trim(),
            scan: (scanName.trim() || toPurviewSourceName(`scan-${name.trim()}`)),
            kind: spec.scanKind,
            scanRulesetName: spec.scanRulesetName,
            scanRulesetType: 'System',
            ...(collectionName ? { collection: collectionName } : {}),
            run: runNow,
          }),
        });
        if (!sr.ok) {
          const j = await sr.json().catch(() => ({}));
          setSubmitError(`Source registered, but scan setup failed: ${j?.error || `HTTP ${sr.status}`}. You can configure the scan from the Scans tab.`);
          onRegistered();
          return;
        }
      }
      setOpen(false);
      onRegistered();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_: unknown, d: any) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add20Regular />}>Register source</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register a data source</DialogTitle>
          <DialogContent>
            <div className={s.stepper}>
              {(['Source', 'Configure', 'Review'] as const).map((label, i) => {
                const n = (i + 1) as 1 | 2 | 3;
                const cls = n === step ? `${s.stepPill} ${s.stepPillActive}`
                  : n < step ? `${s.stepPill} ${s.stepPillDone}` : s.stepPill;
                return (
                  <span key={label} className={cls}>
                    {n < step ? <CheckmarkCircle20Regular /> : <span>{n}</span>} {label}
                  </span>
                );
              })}
            </div>

            <div className={s.wizardBody}>
              {/* STEP 1 — pick a source from the Loom estate, or a custom source */}
              {step === 1 && (
                <>
                  <div className={s.toolbar}>
                    <Button appearance={mode === 'loom' ? 'primary' : 'secondary'} size="small"
                      icon={<Sparkle24Regular />} onClick={() => setMode('loom')}>Loom estate</Button>
                    <Button appearance={mode === 'custom' ? 'primary' : 'secondary'} size="small"
                      onClick={() => setMode('custom')}>Custom source</Button>
                  </div>

                  {mode === 'loom' && (
                    <>
                      {discovery.loading && <Spinner label="Discovering data sources across your subscriptions…" />}
                      {discovery.notConfigured && (
                        <NotConfiguredBar surface="Source discovery" hint={discovery.notConfigured} />
                      )}
                      {!discovery.loading && discovery.data && !discovery.data.ok && (
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>No sources discovered</MessageBarTitle>
                            {discovery.data.error || 'Grant the Loom managed identity Reader to discover sources, or use the Custom source path.'}
                          </MessageBarBody>
                        </MessageBar>
                      )}
                      {!discovery.loading && discovery.data?.ok && sources.length === 0 && (
                        <Caption1 block className={s.muted}>
                          No registerable Azure data sources were found in the subscriptions Loom can read.
                          Use <strong>Custom source</strong> to register one manually.
                        </Caption1>
                      )}
                      {!discovery.loading && sources.length > 0 && (
                        <div className={s.pickerList} role="listbox" aria-label="Discovered data sources">
                          {sources.map((src) => {
                            const sel = src.armResourceId === selectedId;
                            return (
                              <button
                                type="button"
                                key={src.armResourceId}
                                className={sel ? `${s.pickerRow} ${s.pickerRowSelected}` : s.pickerRow}
                                onClick={() => setSelectedId(src.armResourceId)}
                                role="option"
                                aria-selected={sel}
                              >
                                <SourceKindIcon slug={src.tileSlug} className={s.pickerIcon} />
                                <span className={s.pickerText}>
                                  <Body1>{src.suggestedName}</Body1>
                                  <Caption1 className={s.pickerSub}>
                                    {src.label} · {src.endpoint}
                                  </Caption1>
                                  <Caption1 className={s.pickerSub}>
                                    {src.resourceGroup}{src.subscriptionName ? ` · ${src.subscriptionName}` : ''}
                                  </Caption1>
                                </span>
                                {sel && <CheckmarkCircle20Regular className={s.okIcon} />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}

                  {mode === 'custom' && (
                    <div className={s.fieldStack}>
                      <MessageBar intent="info">
                        <MessageBarBody>
                          Use this for a source outside the discovered Loom estate. Pick a supported kind,
                          then supply its endpoint.
                        </MessageBarBody>
                      </MessageBar>
                      <Field label="Kind">
                        <Dropdown
                          value={PURVIEW_KIND_SPEC[custom.kind]?.label || custom.kind}
                          selectedOptions={[custom.kind]}
                          onOptionSelect={(_: unknown, d: any) => setCustom({ ...custom, kind: d.optionValue || custom.kind })}
                        >
                          {PURVIEW_SOURCE_KIND_SPECS.map((k) => (
                            <Option key={k.kind} value={k.kind} text={k.label}>{k.label}</Option>
                          ))}
                        </Dropdown>
                      </Field>
                      <Field label={PURVIEW_KIND_SPEC[custom.kind]?.endpointLabel || 'Endpoint'}
                        hint={`e.g. ${PURVIEW_KIND_SPEC[custom.kind]?.endpointExample || ''}`}>
                        <Input value={custom.endpoint}
                          onChange={(_: unknown, d: any) => setCustom({ ...custom, endpoint: d.value })} />
                      </Field>
                    </div>
                  )}
                </>
              )}

              {/* STEP 2 — name + collection mapping + optional scan */}
              {step === 2 && (
                <>
                  <Field label="Source name" hint="Purview reference name (letters, digits, - and _)">
                    <Input value={name} onChange={(_: unknown, d: any) => setName(toPurviewSourceName(d.value))} />
                  </Field>
                  {collections.notConfigured ? (
                    <NotConfiguredBar surface="Purview collections" hint={collections.notConfigured} />
                  ) : cols.length > 0 ? (
                    <Field label="Collection" hint="The Data Map collection the source lands in.">
                      <Dropdown
                        value={cols.find((c) => c.name === collectionName)?.friendlyName || collectionName}
                        selectedOptions={[collectionName]}
                        onOptionSelect={(_: unknown, d: any) => setCollectionName(d.optionValue || collectionName)}
                      >
                        {cols.map((c) => (
                          <Option key={c.name} value={c.name} text={c.friendlyName || c.name}>
                            {c.friendlyName || c.name}{c.parentCollection ? '' : ' (root)'}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  ) : (
                    <Caption1 block className={s.muted}>
                      No sub-collections found — the source registers into the account root collection.
                    </Caption1>
                  )}

                  <div className={s.scanBox}>
                    <Switch checked={setupScan} label="Set up a scan for this source"
                      onChange={(_: unknown, d: any) => setSetupScan(d.checked)} />
                    {setupScan && !spec && (
                      <MessageBar intent="warning">
                        <MessageBarBody>Scan defaults aren’t available for this kind — register the source, then configure a scan from the Scans tab.</MessageBarBody>
                      </MessageBar>
                    )}
                    {setupScan && spec && (
                      <>
                        <Field label="Scan name">
                          <Input value={scanName} onChange={(_: unknown, d: any) => setScanName(toPurviewSourceName(d.value))} />
                        </Field>
                        <Caption1 className={s.muted}>
                          Ruleset <code className={s.code}>{spec.scanRulesetName}</code> (System) · managed-identity scan
                          <code className={s.code}> {spec.scanKind}</code>
                        </Caption1>
                        <Switch checked={runNow} label="Run the scan immediately after registering"
                          onChange={(_: unknown, d: any) => setRunNow(d.checked)} />
                      </>
                    )}
                  </div>
                </>
              )}

              {/* STEP 3 — review + register */}
              {step === 3 && (
                <>
                  <div className={s.reviewGrid}>
                    <Text className={s.reviewKey}>Name</Text>
                    <Text className={s.reviewVal}>{name}</Text>
                    <Text className={s.reviewKey}>Kind</Text>
                    <Text className={s.reviewVal}>{spec?.label || activeKind}</Text>
                    <Text className={s.reviewKey}>{spec?.endpointLabel || 'Endpoint'}</Text>
                    <Text className={s.reviewVal}>{activeEndpoint}</Text>
                    <Text className={s.reviewKey}>Collection</Text>
                    <Text className={s.reviewVal}>
                      {collectionName ? (cols.find((c) => c.name === collectionName)?.friendlyName || collectionName) : 'Root collection'}
                    </Text>
                    <Text className={s.reviewKey}>Scan</Text>
                    <Text className={s.reviewVal}>
                      {setupScan && spec
                        ? `${scanName} — ${spec.scanRulesetName}${runNow ? ' · run now' : ''}`
                        : 'Not set up'}
                    </Text>
                  </div>
                  {submitError && (
                    <MessageBar intent="error">
                      <MessageBarBody><MessageBarTitle>Register failed</MessageBarTitle>{submitError}</MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <div className={s.wizardFooter}>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <span className={s.grow} />
              {step > 1 && (
                <Button icon={<ChevronLeft20Regular />} onClick={() => setStep((p) => (p - 1) as 1 | 2 | 3)} disabled={submitting}>
                  Back
                </Button>
              )}
              {step === 1 && (
                <Button appearance="primary" iconPosition="after" icon={<ChevronRight20Regular />}
                  disabled={!step1Ready} onClick={goStep2}>Next</Button>
              )}
              {step === 2 && (
                <Button appearance="primary" iconPosition="after" icon={<ChevronRight20Regular />}
                  disabled={!step2Ready} onClick={() => setStep(3)}>Review</Button>
              )}
              {step === 3 && (
                <Button appearance="primary" icon={<Add20Regular />} disabled={submitting || !activeKind} onClick={register}>
                  {submitting ? 'Registering…' : 'Register'}
                </Button>
              )}
            </div>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// -----------------------------------------------------------------
// Auto-add ALL discovered sources (bulk register with live progress)
// -----------------------------------------------------------------

interface BulkResult { name: string; label: string; slug?: string; status: 'ok' | 'error'; error?: string }

function AutoAddAllDialog({ onDone }: { onDone: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [discovery, setDiscovery] = useState<ApiState<DiscoverPayload>>(emptyState());
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<BulkResult[]>([]);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRunning(false); setDone(0); setResults([]); setStarted(false);
    (async () => {
      setDiscovery({ loading: true, data: null });
      setDiscovery(await fetchJson<DiscoverPayload>('/api/admin/security/purview/discover'));
    })();
  }, [open]);

  const sources = discovery.data?.sources || [];

  const registerAll = async () => {
    setStarted(true); setRunning(true); setDone(0); setResults([]);
    const acc: BulkResult[] = [];
    for (const src of sources) {
      let res: BulkResult;
      try {
        const r = await clientFetch('/api/admin/security/purview/sources', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: src.suggestedName, kind: src.kind, properties: src.properties }),
        });
        if (r.ok) {
          res = { name: src.suggestedName, label: src.label, slug: src.tileSlug, status: 'ok' };
        } else {
          const j = await r.json().catch(() => ({}));
          res = { name: src.suggestedName, label: src.label, slug: src.tileSlug, status: 'error', error: j?.error || `HTTP ${r.status}` };
        }
      } catch (e: any) {
        res = { name: src.suggestedName, label: src.label, slug: src.tileSlug, status: 'error', error: e?.message || String(e) };
      }
      acc.push(res);
      setResults([...acc]);
      setDone(acc.length);
    }
    setRunning(false);
    onDone();
  };

  const okCount = results.filter((r) => r.status === 'ok').length;
  const errCount = results.filter((r) => r.status === 'error').length;

  return (
    <Dialog open={open} onOpenChange={(_: unknown, d: any) => { if (!running) setOpen(d.open); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button icon={<Sparkle24Regular />}>Auto-add all sources</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Auto-add all Loom sources</DialogTitle>
          <DialogContent>
            <div className={s.wizardBody}>
              {discovery.loading && <Spinner label="Discovering data sources…" />}
              {discovery.notConfigured && <NotConfiguredBar surface="Source discovery" hint={discovery.notConfigured} />}
              {!discovery.loading && discovery.data && !discovery.data.ok && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No sources discovered</MessageBarTitle>
                    {discovery.data.error}
                  </MessageBarBody>
                </MessageBar>
              )}
              {!discovery.loading && discovery.data?.ok && sources.length === 0 && (
                <Caption1 block className={s.muted}>No registerable Azure data sources were found.</Caption1>
              )}
              {!discovery.loading && sources.length > 0 && !started && (
                <Body1 block>
                  {sources.length} data source{sources.length === 1 ? '' : 's'} discovered across your subscriptions.
                  Registering each into the Purview Data Map root collection. Re-registering an existing source is safe.
                </Body1>
              )}
              {started && (
                <>
                  <ProgressBar value={sources.length ? done / sources.length : 0} />
                  <Caption1 block>
                    {done} of {sources.length} · {okCount} registered{errCount ? ` · ${errCount} failed` : ''}
                  </Caption1>
                  <Divider />
                  <div className={s.bulkList}>
                    {results.map((r) => (
                      <div key={r.name} className={s.bulkRow}>
                        {r.status === 'ok'
                          ? <CheckmarkCircle20Regular className={s.okIcon} />
                          : <Warning20Regular className={s.errIcon} />}
                        <SourceKindIcon slug={r.slug} />
                        <strong>{r.name}</strong>
                        <span className={s.muted}>{r.error ? `— ${r.error}` : r.label}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)} disabled={running}>
              {started && !running ? 'Close' : 'Cancel'}
            </Button>
            {!started && (
              <Button appearance="primary" icon={<Sparkle24Regular />}
                disabled={running || sources.length === 0} onClick={registerAll}>
                Register all {sources.length || ''}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// -----------------------------------------------------------------
// Register a source FOR SCANNING (per-row action → define + optionally run)
// -----------------------------------------------------------------

function SetupScanDialog({ source, onOpenChange }: { source: RegisteredSource | null; onOpenChange: (open: boolean) => void }) {
  const s = useStyles();
  const [scanName, setScanName] = useState('');
  const [runNow, setRunNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const spec = useMemo(() => (source?.kind ? PURVIEW_KIND_SPEC[source.kind] : undefined), [source?.kind]);

  useEffect(() => {
    if (source) {
      setScanName(toPurviewSourceName(`scan-${source.name}`));
      setRunNow(true); setBusy(false); setError(null); setOkMsg(null);
    }
  }, [source]);

  const submit = async () => {
    if (!source || !spec) return;
    setBusy(true); setError(null); setOkMsg(null);
    try {
      const r = await clientFetch('/api/governance/scans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          define: true,
          source: source.name,
          scan: scanName.trim() || toPurviewSourceName(`scan-${source.name}`),
          kind: spec.scanKind,
          scanRulesetName: spec.scanRulesetName,
          scanRulesetType: 'System',
          run: runNow,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j?.error || `Scan setup failed (HTTP ${r.status})`);
        return;
      }
      setOkMsg(runNow
        ? `Scan "${scanName}" created and a run was triggered${j?.runId ? ` (runId ${j.runId})` : ''}.`
        : `Scan "${scanName}" created. Trigger it from the Scans tab when ready.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(source)} onOpenChange={(_: unknown, d: any) => { if (!busy) onOpenChange(d.open); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register “{source?.name}” for scanning</DialogTitle>
          <DialogContent>
            <div className={s.fieldStack}>
              {!spec ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Kind not in the auto-scan catalog</MessageBarTitle>
                    This source’s kind (<code className={s.code}>{source?.kind || 'unknown'}</code>) has no default
                    Loom scan ruleset. Configure a scan directly from the Scans tab or the Purview portal.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <>
                  <Field label="Scan name">
                    <Input value={scanName} onChange={(_: unknown, d: any) => setScanName(toPurviewSourceName(d.value))} />
                  </Field>
                  <Caption1 className={s.muted}>
                    Ruleset <code className={s.code}>{spec.scanRulesetName}</code> (System) · managed-identity scan
                    <code className={s.code}> {spec.scanKind}</code>
                  </Caption1>
                  <Switch checked={runNow} label="Run the scan immediately"
                    onChange={(_: unknown, d: any) => setRunNow(d.checked)} />
                  {error && (
                    <MessageBar intent="error">
                      <MessageBarBody>{error}</MessageBarBody>
                    </MessageBar>
                  )}
                  {okMsg && (
                    <MessageBar intent="success">
                      <MessageBarBody>{okMsg}</MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => onOpenChange(false)} disabled={busy}>{okMsg ? 'Close' : 'Cancel'}</Button>
            {spec && !okMsg && (
              <Button appearance="primary" icon={<ScanObject24Regular />} disabled={busy || !scanName.trim()} onClick={submit}>
                {busy ? 'Setting up…' : (runNow ? 'Create & run scan' : 'Create scan')}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// -----------------------------------------------------------------
// Scans
// -----------------------------------------------------------------

interface ScansPayload {
  ok: boolean;
  scans?: Array<{ id: string; name: string; kind?: string }>;
}
interface RunsPayload {
  ok: boolean;
  runs?: Array<{ runId: string; status?: string; startTime?: string; endTime?: string; errorMessage?: string }>;
}

function ScansSection() {
  const s = useStyles();
  const [sources, setSources] = useState<ApiState<SourcesPayload>>(emptyState());
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [scans, setScans] = useState<ApiState<ScansPayload>>(emptyState());
  const [runs, setRuns] = useState<Record<string, ApiState<RunsPayload>>>({});

  useEffect(() => {
    (async () => {
      setSources((p) => ({ ...p, loading: true }));
      const r = await fetchJson<SourcesPayload>('/api/admin/security/purview/sources');
      setSources(r);
      const first = r.data?.sources?.[0]?.name;
      if (first) setSelectedSource(first);
    })();
  }, []);

  useEffect(() => {
    if (!selectedSource) return;
    (async () => {
      setScans({ loading: true, data: null });
      setScans(await fetchJson<ScansPayload>(`/api/admin/security/purview/scans?source=${encodeURIComponent(selectedSource)}`));
    })();
  }, [selectedSource]);

  const triggerRun = async (scanName: string) => {
    if (!selectedSource) return;
    const r = await clientFetch('/api/admin/security/purview/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: selectedSource, scan: scanName }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Trigger failed: ${j?.error || r.statusText}`);
      return;
    }
    const j = await r.json();
    alert(`Run triggered. runId: ${j.runId}`);
  };

  const loadRuns = async (scanName: string) => {
    setRuns((p) => ({ ...p, [scanName]: { loading: true, data: null } }));
    const r = await fetchJson<RunsPayload>(
      `/api/admin/security/purview/scans?source=${encodeURIComponent(selectedSource)}&scan=${encodeURIComponent(scanName)}&runs=1`,
    );
    setRuns((p) => ({ ...p, [scanName]: r }));
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Scans</Subtitle2>
        {sources.data?.sources && (
          <Dropdown
            value={selectedSource}
            selectedOptions={[selectedSource]}
            onOptionSelect={(_: unknown, d: any) => setSelectedSource(d.optionValue || '')}
            placeholder="Pick a source"
          >
            {sources.data.sources.map((src) => (
              <Option key={src.name} value={src.name}>{src.name}</Option>
            ))}
          </Dropdown>
        )}
      </div>
      {sources.notConfigured && (
        <NotConfiguredBar
          surface="Purview scans"
          hint={sources.notConfigured}
          portalLink="https://web.purview.azure.com/resource/sources"
          portalLabel="Open Purview Scans"
        />
      )}
      {selectedSource && scans.loading && <Spinner label="Loading scans…" />}
      {selectedSource && scans.data?.ok && (scans.data.scans || []).length === 0 && (
        <Caption1 block className={s.muted}>
          No scans defined on source <code className={s.code}>{selectedSource}</code>. Configure one in the Purview portal.
        </Caption1>
      )}
      {selectedSource && scans.data?.ok && (scans.data.scans || []).length > 0 && (
        <Table size="small" aria-label="Scans" className={s.table}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Last runs</TableHeaderCell>
              <TableHeaderCell className={s.actionCell}><span className={s.srOnly}>Run scan</span></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scans.data.scans!.map((scan) => {
              const r = runs[scan.name];
              return (
                <TableRow key={scan.id || scan.name}>
                  <TableCell><strong>{scan.name}</strong></TableCell>
                  <TableCell><Badge appearance="outline">{scan.kind || '—'}</Badge></TableCell>
                  <TableCell>
                    {r?.loading && <Spinner size="extra-tiny" />}
                    {r?.data?.runs && r.data.runs.length > 0 && (
                      <Caption1>{r.data.runs[0].status} · {r.data.runs[0].startTime?.slice(0, 16)}</Caption1>
                    )}
                    {!r && <Button size="small" onClick={() => loadRuns(scan.name)}>Show runs</Button>}
                  </TableCell>
                  <TableCell className={s.actionCell}>
                    <Button size="small" icon={<Play20Regular />} appearance="primary"
                      onClick={() => triggerRun(scan.name)}>Run</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Classifications — defers to existing /api/governance/classifications
// -----------------------------------------------------------------

interface ClsPayload {
  ok: boolean;
  classifications?: Array<{ name: string; count: number }>;
}

function ClassificationsSection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<ClsPayload>>(emptyState());
  useEffect(() => {
    (async () => {
      setState({ loading: true, data: null });
      setState(await fetchJson<ClsPayload>('/api/governance/classifications'));
    })();
  }, []);

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Classification hits</Subtitle2>
        <a className={s.linkOut} href="/governance/classifications">
          Open classifications page <Open16Regular />
        </a>
      </div>
      {state.loading && <Spinner label="Loading classifications…" />}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody>
        </MessageBar>
      )}
      {state.notConfigured && (
        <NotConfiguredBar surface="Classifications" hint={state.notConfigured} />
      )}
      {!state.loading && !state.error && !state.notConfigured && state.data?.ok && (state.data.classifications || []).length === 0 && (
        <Caption1 block className={s.muted}>
          No classification hits recorded yet. Run a Purview scan to populate classification results.
        </Caption1>
      )}
      {state.data?.ok && (state.data.classifications || []).length > 0 && (
        <Table size="small" aria-label="Classifications" className={s.table}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Classification</TableHeaderCell>
              <TableHeaderCell>Hits</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.classifications!.slice(0, 50).map((c) => (
              <TableRow key={c.name}>
                <TableCell><Badge>{c.name}</Badge></TableCell>
                <TableCell><strong>{c.count}</strong></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Glossary
// -----------------------------------------------------------------

interface GlossaryPayload {
  ok: boolean;
  terms?: Array<{ guid: string; name?: string; longDescription?: string; status?: string; glossaryGuid?: string }>;
}

function GlossarySection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<GlossaryPayload>>(emptyState());
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', shortDescription: '', longDescription: '' });

  const load = useCallback(async () => {
    setState({ loading: true, data: null });
    setState(await fetchJson<GlossaryPayload>('/api/admin/security/purview/glossary'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const firstGlossary = state.data?.terms?.[0]?.glossaryGuid;

  const create = async () => {
    if (!firstGlossary) {
      alert('No glossary detected. Create one in the Purview portal first.');
      return;
    }
    setCreating(true);
    try {
      const r = await clientFetch('/api/admin/security/purview/glossary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          glossaryGuid: firstGlossary,
          shortDescription: form.shortDescription || undefined,
          longDescription: form.longDescription || undefined,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Create failed: ${j?.error || r.statusText}`);
      } else {
        setOpen(false);
        setForm({ name: '', shortDescription: '', longDescription: '' });
        await load();
      }
    } finally { setCreating(false); }
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Glossary terms</Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
        <Dialog open={open} onOpenChange={(_: unknown, d: any) => setOpen(d.open)}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!firstGlossary}>Create term</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Create glossary term</DialogTitle>
              <DialogContent>
                <div className={s.fieldStack}>
                  <Field label="Name">
                    <Input value={form.name} onChange={(_: unknown, d: any) => setForm({ ...form, name: d.value })} />
                  </Field>
                  <Field label="Short description">
                    <Input value={form.shortDescription} onChange={(_: unknown, d: any) => setForm({ ...form, shortDescription: d.value })} />
                  </Field>
                  <Field label="Long description">
                    <Textarea value={form.longDescription} onChange={(_: unknown, d: any) => setForm({ ...form, longDescription: d.value })} rows={4} />
                  </Field>
                </div>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button appearance="primary" disabled={!form.name.trim() || creating} onClick={create}>
                  {creating ? 'Creating…' : 'Create'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
      {state.loading && <Spinner label="Loading glossary…" />}
      {state.notConfigured && <NotConfiguredBar surface="Glossary" hint={state.notConfigured} portalLink="https://web.purview.azure.com/resource/glossary" portalLabel="Open Purview Glossary" />}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.terms || []).length === 0 && (
        <Caption1 block className={s.muted}>
          No glossary terms found in this Purview account. Create one above (requires at least one glossary to exist).
        </Caption1>
      )}
      {state.data?.ok && (state.data.terms || []).length > 0 && (
        <Table size="small" aria-label="Glossary terms" className={s.table}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Term</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.terms!.slice(0, 50).map((t) => (
              <TableRow key={t.guid}>
                <TableCell><strong>{t.name}</strong></TableCell>
                <TableCell><Badge appearance="outline">{t.status || 'Draft'}</Badge></TableCell>
                <TableCell><Caption1>{(t.longDescription || '').slice(0, 120)}</Caption1></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Domains
// -----------------------------------------------------------------

interface DomainsPayload {
  ok: boolean;
  domains?: Array<{ id: string; name: string; description?: string; type?: string }>;
}

function DomainsSection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<DomainsPayload>>(emptyState());
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', type: 'Functional' });

  const load = useCallback(async () => {
    setState({ loading: true, data: null });
    setState(await fetchJson<DomainsPayload>('/api/admin/security/purview/domains'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const r = await clientFetch('/api/admin/security/purview/domains', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Create failed: ${j?.error || r.statusText}`);
      } else {
        setOpen(false);
        setForm({ name: '', description: '', type: 'Functional' });
        await load();
      }
    } finally { setCreating(false); }
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Governance domains</Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
        <Dialog open={open} onOpenChange={(_: unknown, d: any) => setOpen(d.open)}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add20Regular />}>Create domain</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Create governance domain</DialogTitle>
              <DialogContent>
                <div className={s.fieldStack}>
                  <Field label="Name">
                    <Input value={form.name} onChange={(_: unknown, d: any) => setForm({ ...form, name: d.value })} />
                  </Field>
                  <Field label="Description">
                    <Textarea value={form.description} onChange={(_: unknown, d: any) => setForm({ ...form, description: d.value })} rows={3} />
                  </Field>
                  <Field label="Type">
                    <Dropdown value={form.type} selectedOptions={[form.type]} onOptionSelect={(_: unknown, d: any) => setForm({ ...form, type: d.optionValue || 'Functional' })}>
                      <Option value="Functional">Functional</Option>
                      <Option value="LineOfBusiness">Line of business</Option>
                      <Option value="DataDomain">Data domain</Option>
                    </Dropdown>
                  </Field>
                </div>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button appearance="primary" disabled={!form.name.trim() || creating} onClick={create}>
                  {creating ? 'Creating…' : 'Create'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
      {state.loading && <Spinner label="Loading domains…" />}
      {state.notConfigured && <NotConfiguredBar surface="Governance domains" hint={state.notConfigured} portalLink="https://web.purview.azure.com/resource/domains" portalLabel="Open Purview Domains" />}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.domains || []).length === 0 && (
        <Caption1 block className={s.muted}>No governance domains yet. Create one to start grouping data products.</Caption1>
      )}
      {state.data?.ok && (state.data.domains || []).length > 0 && (
        <Table size="small" aria-label="Governance domains" className={s.table}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell>Id</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.domains!.map((d) => (
              <TableRow key={d.id}>
                <TableCell><strong>{d.name}</strong></TableCell>
                <TableCell><Badge appearance="outline">{d.type || '—'}</Badge></TableCell>
                <TableCell><Caption1>{(d.description || '').slice(0, 100)}</Caption1></TableCell>
                <TableCell><code className={s.code}>{d.id}</code></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Data Quality
// -----------------------------------------------------------------

interface DqPayload {
  ok: boolean;
  rules?: Array<{ id: string; name?: string; description?: string; expression?: string; scope?: string; enabled?: boolean }>;
  note?: string;
}

function DataQualitySection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<DqPayload>>(emptyState());
  useEffect(() => {
    (async () => {
      setState({ loading: true, data: null });
      setState(await fetchJson<DqPayload>('/api/admin/security/purview/dataquality'));
    })();
  }, []);

  return (
    <div className={s.section}>
      <div className={s.sectionTitle}>
        <Subtitle2>Data quality rules</Subtitle2>
        <Badge appearance="tint" color="warning">Preview</Badge>
      </div>
      {state.loading && <Spinner label="Loading DQ rules…" />}
      {state.notConfigured && <NotConfiguredBar surface="Data quality" hint={state.notConfigured} portalLink="https://web.purview.azure.com/resource/dataquality" portalLabel="Open Purview Data Quality" />}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && state.data.note && (
        <MessageBar intent="info">
          <MessageBarBody>{state.data.note}</MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.rules || []).length > 0 && (
        <Table size="small" aria-label="DQ rules" className={s.table}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Rule</TableHeaderCell>
              <TableHeaderCell>Scope</TableHeaderCell>
              <TableHeaderCell>Expression</TableHeaderCell>
              <TableHeaderCell>Enabled</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.rules!.map((r) => (
              <TableRow key={r.id}>
                <TableCell><strong>{r.name}</strong></TableCell>
                <TableCell>{r.scope || '—'}</TableCell>
                <TableCell><code className={s.code}>{(r.expression || '').slice(0, 120)}</code></TableCell>
                <TableCell>{r.enabled ? <Badge color="success">on</Badge> : <Badge color="subtle">off</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Sensitivity / Lineage — link out to existing surfaces
// -----------------------------------------------------------------

function SensitivitySection() {
  const s = useStyles();
  return (
    <div className={s.section}>
      <Subtitle2 block className={s.sectionTitle}>Sensitivity coverage</Subtitle2>
      <Caption1 block className={s.linkCaption}>
        Loom already ships a real sensitivity coverage view at <code className={s.code}>/governance/sensitivity</code> backed by Cosmos. Open it for per-type label distribution + unlabeled-item drilldown.
      </Caption1>
      <a className={s.linkOut} href="/governance/sensitivity">
        Open sensitivity coverage <Open16Regular />
      </a>
    </div>
  );
}

function LineageSection() {
  const s = useStyles();
  return (
    <div className={s.section}>
      <Subtitle2 block className={s.sectionTitle}>Lineage</Subtitle2>
      <Caption1 block className={s.linkCaption}>
        Lineage already has a dedicated page at <code className={s.code}>/governance/lineage</code> with upstream/downstream graph rendering. Open it for asset-level lineage exploration.
      </Caption1>
      <a className={s.linkOut} href="/governance/lineage">
        Open lineage explorer <Open16Regular />
      </a>
    </div>
  );
}

'use client';

import { clientFetch } from '@/lib/client-fetch';
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

import { useCallback, useEffect, useState } from 'react';
import { shorthands,
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  Spinner, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, Subtitle2,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Input, Field, Dropdown, Option, Textarea,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, Add20Regular, Delete20Regular, Play20Regular, Open16Regular,
  Search20Regular, DatabaseSearch24Regular,
} from '@fluentui/react-icons';
import { NotConfiguredBar, type NotConfiguredHint } from './not-configured-bar';

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

function DataSourcesSection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<SourcesPayload>>(emptyState());
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ name: '', kind: 'AzureSqlDatabase', endpoint: '' });

  const load = useCallback(async () => {
    setState((p) => ({ ...p, loading: true }));
    setState(await fetchJson<SourcesPayload>('/api/admin/security/purview/sources'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const r = await clientFetch('/api/admin/security/purview/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          kind: form.kind,
          properties: { endpoint: form.endpoint.trim() },
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Register failed: ${j?.error || r.statusText}`);
      } else {
        setOpen(false);
        setForm({ name: '', kind: 'AzureSqlDatabase', endpoint: '' });
        await load();
      }
    } finally { setCreating(false); }
  };

  const remove = async (name: string) => {
    if (!confirm(`De-register data source "${name}"?`)) return;
    const r = await clientFetch(`/api/admin/security/purview/sources?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Delete failed: ${j?.error || r.statusText}`);
    }
    await load();
  };

  return (
    <div className={s.section}>
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
        <Dialog open={open} onOpenChange={(_: unknown, d: any) => setOpen(d.open)}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add20Regular />}>Register source</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Register a Purview data source</DialogTitle>
              <DialogContent>
                <div className={s.fieldStack}>
                  <Field label="Name (Purview reference name)">
                    <Input value={form.name} onChange={(_: unknown, d: any) => setForm({ ...form, name: d.value })} placeholder="prod-finance-sql" />
                  </Field>
                  <Field label="Kind">
                    <Dropdown value={form.kind} selectedOptions={[form.kind]} onOptionSelect={(_: unknown, d: any) => setForm({ ...form, kind: d.optionValue || form.kind })}>
                      <Option value="AzureSqlDatabase">Azure SQL Database</Option>
                      <Option value="AzureDataLakeStorageGen2">Azure Data Lake Storage Gen2</Option>
                      <Option value="AzureSynapseAnalytics">Azure Synapse Analytics</Option>
                      <Option value="AzureDatabricks">Azure Databricks</Option>
                      <Option value="AzureBlobStorage">Azure Blob Storage</Option>
                      <Option value="Snowflake">Snowflake</Option>
                      <Option value="Oracle">Oracle</Option>
                      <Option value="SapEcc">SAP ECC</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Endpoint" hint="e.g. https://contoso.database.windows.net or https://contoso.dfs.core.windows.net">
                    <Input value={form.endpoint} onChange={(_: unknown, d: any) => setForm({ ...form, endpoint: d.value })} />
                  </Field>
                </div>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button appearance="primary" disabled={!form.name.trim() || !form.endpoint.trim() || creating} onClick={create}>
                  {creating ? 'Registering…' : 'Register'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
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
            No data sources registered yet. Click <strong>Register source</strong> to add one.
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
                  <TableCell><strong>{src.name}</strong></TableCell>
                  <TableCell><Badge appearance="outline">{src.kind || 'Unknown'}</Badge></TableCell>
                  <TableCell><code className={s.codeWrap}>{src.endpoint || '—'}</code></TableCell>
                  <TableCell>{src.collectionId || '—'}</TableCell>
                  <TableCell className={s.actionCell}>
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

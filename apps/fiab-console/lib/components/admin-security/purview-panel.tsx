'use client';

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
 * purview_not_configured` renders the NotConfiguredBar with the bicep +
 * env + role remediation. Other 4xx/5xx render an error MessageBar.
 */

import { useCallback, useEffect, useState } from 'react';
import {
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
} from '@fluentui/react-icons';
import { NotConfiguredBar, type NotConfiguredHint } from './not-configured-bar';

const useStyles = makeStyles({
  subTabs: { marginBottom: 12 },
  section: {
    padding: 12, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  toolbar: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' },
  fieldStack: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 360 },
  linkOut: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '8px 12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
    textDecoration: 'none', color: tokens.colorBrandForeground1,
    fontSize: 13,
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
    if (r.status === 503 && j?.code?.endsWith('_not_configured')) {
      return { loading: false, data: null, notConfigured: j.hint, error: j.error, errorStatus: 503 };
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

export function PurviewPanel() {
  const s = useStyles();
  const [tab, setTab] = useState<SubTab>('sources');

  return (
    <div>
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
  const [form, setForm] = useState({ name: '', kind: 'AzureSqlDatabase', endpoint: '' });

  const load = useCallback(async () => {
    setState((p) => ({ ...p, loading: true }));
    setState(await fetchJson<SourcesPayload>('/api/admin/security/purview/sources'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const r = await fetch('/api/admin/security/purview/sources', {
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
    const r = await fetch(`/api/admin/security/purview/sources?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Delete failed: ${j?.error || r.statusText}`);
    }
    await load();
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>Registered data sources</Subtitle2>
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
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
          No data sources registered yet. Click <strong>Register source</strong> to add one.
        </Caption1>
      )}
      {!state.loading && state.data?.ok && (state.data.sources || []).length > 0 && (
        <Table size="small" aria-label="Registered data sources">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Endpoint</TableHeaderCell>
              <TableHeaderCell>Collection</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.sources!.map((src) => (
              <TableRow key={src.id || src.name}>
                <TableCell><strong>{src.name}</strong></TableCell>
                <TableCell><Badge appearance="outline">{src.kind || 'Unknown'}</Badge></TableCell>
                <TableCell><code style={{ fontSize: 11 }}>{src.endpoint || '—'}</code></TableCell>
                <TableCell>{src.collectionId || '—'}</TableCell>
                <TableCell>
                  <Button icon={<Delete20Regular />} appearance="subtle" size="small"
                    onClick={() => remove(src.name)} aria-label={`Delete ${src.name}`} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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
    const r = await fetch('/api/admin/security/purview/scans', {
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
        <Subtitle2 style={{ marginRight: 'auto' }}>Scans</Subtitle2>
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
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
          No scans defined on source <code>{selectedSource}</code>. Configure one in the Purview portal.
        </Caption1>
      )}
      {selectedSource && scans.data?.ok && (scans.data.scans || []).length > 0 && (
        <Table size="small" aria-label="Scans">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Last runs</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
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
                  <TableCell>
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
        <Subtitle2 style={{ marginRight: 'auto' }}>Classification hits</Subtitle2>
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
      {state.data?.ok && (state.data.classifications || []).length > 0 && (
        <Table size="small" aria-label="Classifications">
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
      const r = await fetch('/api/admin/security/purview/glossary', {
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
        <Subtitle2 style={{ marginRight: 'auto' }}>Glossary terms</Subtitle2>
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
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
          No glossary terms found in this Purview account. Create one above (requires at least one glossary to exist).
        </Caption1>
      )}
      {state.data?.ok && (state.data.terms || []).length > 0 && (
        <Table size="small" aria-label="Glossary terms">
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
      const r = await fetch('/api/admin/security/purview/domains', {
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
        <Subtitle2 style={{ marginRight: 'auto' }}>Governance domains</Subtitle2>
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
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No governance domains yet. Create one to start grouping data products.</Caption1>
      )}
      {state.data?.ok && (state.data.domains || []).length > 0 && (
        <Table size="small" aria-label="Governance domains">
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
                <TableCell><code style={{ fontSize: 11 }}>{d.id}</code></TableCell>
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
      <Subtitle2 block style={{ marginBottom: 8 }}>Data quality rules <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
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
        <Table size="small" aria-label="DQ rules">
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
                <TableCell><code style={{ fontSize: 11 }}>{(r.expression || '').slice(0, 120)}</code></TableCell>
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
      <Subtitle2 block style={{ marginBottom: 8 }}>Sensitivity coverage</Subtitle2>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 8 }}>
        Loom already ships a real sensitivity coverage view at <code>/governance/sensitivity</code> backed by Cosmos. Open it for per-type label distribution + unlabeled-item drilldown.
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
      <Subtitle2 block style={{ marginBottom: 8 }}>Lineage</Subtitle2>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 8 }}>
        Lineage already has a dedicated page at <code>/governance/lineage</code> with upstream/downstream graph rendering. Open it for asset-level lineage exploration.
      </Caption1>
      <a className={s.linkOut} href="/governance/lineage">
        Open lineage explorer <Open16Regular />
      </a>
    </div>
  );
}

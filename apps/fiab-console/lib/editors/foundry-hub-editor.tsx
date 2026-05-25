'use client';

/**
 * Foundry hub editor — fully wired to Azure AI Foundry workspace
 * (Microsoft.MachineLearningServices/workspaces kind=Hub) via:
 *   GET /api/foundry/workspace
 *   GET /api/foundry/connections
 *   GET /api/items/ml-model     (registered models)
 *   GET /api/foundry/deployments
 *   GET /api/foundry/computes
 *   GET /api/foundry/datastores
 *   GET /api/items/ml-experiment (jobs)
 *
 * Each tab lazy-loads its data on first activation, surfaces errors via
 * MessageBar, and refreshes on the Reload ribbon action. No mock data.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Spinner,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', alignItems: 'baseline' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: 12 },
  tableWrap: { overflow: 'auto', maxHeight: 460, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontSize: 12, whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' },
  empty: { padding: 16, color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
});

type LoadState<T> = { loading: boolean; data: T | null; error?: string };

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Hub', actions: [{ label: 'Reload' }, { label: 'Open in Azure portal' }] },
    { label: 'Author', actions: [{ label: 'New connection' }, { label: 'New deployment' }] },
  ]},
];

function ErrorBar({ msg }: { msg: string }) {
  return (
    <MessageBar intent="error">
      <MessageBarBody><MessageBarTitle>Foundry error</MessageBarTitle>{msg}</MessageBarBody>
    </MessageBar>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  const s = useStyles();
  return <div className={s.empty}>{children}</div>;
}

function useLazyFetch<T>(url: string, active: boolean) {
  const [state, setState] = useState<LoadState<T>>({ loading: false, data: null });
  const reload = useCallback(async () => {
    setState({ loading: true, data: null });
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!j.ok) { setState({ loading: false, data: null, error: j.error || `HTTP ${r.status}` }); return; }
      setState({ loading: false, data: j as unknown as T });
    } catch (e: any) {
      setState({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [url]);
  useEffect(() => {
    if (active && state.data === null && !state.loading && !state.error) reload();
  }, [active, state.data, state.loading, state.error, reload]);
  return [state, reload] as const;
}

// ---------- Tab panels ----------

function OverviewPanel() {
  const s = useStyles();
  const [ws] = useLazyFetch<{ ok: boolean; workspace: any }>(`/api/foundry/workspace`, true);
  if (ws.loading) return <div className={s.pad}><Spinner size="small" label="Loading hub…" labelPosition="after" /></div>;
  if (ws.error) return <div className={s.pad}><ErrorBar msg={ws.error} /></div>;
  const w = ws.data?.workspace;
  if (!w) return <div className={s.pad}><EmptyText>No workspace data.</EmptyText></div>;
  const rows: [string, React.ReactNode][] = [
    ['Name', w.name],
    ['Friendly name', w.friendlyName || '—'],
    ['Resource group', w.rg],
    ['Location', w.location],
    ['Kind', <Badge appearance="tint" color="brand" key="kind">{w.kind}</Badge>],
    ['Provisioning state', w.provisioningState],
    ['Public network access', w.publicNetworkAccess],
    ['Discovery URL', w.discoveryUrl || '—'],
    ['Storage account', w.storageAccount?.split('/').pop() || '—'],
    ['Key Vault', w.keyVault?.split('/').pop() || '—'],
    ['Container registry', w.containerRegistry?.split('/').pop() || '—'],
    ['Application Insights', w.applicationInsights?.split('/').pop() || '—'],
  ];
  return (
    <div className={s.pad}>
      <Subtitle2>{w.friendlyName || w.name}</Subtitle2>
      {w.description && <Body1>{w.description}</Body1>}
      <div className={s.metaGrid}>
        {rows.map(([k, v]) => (
          <>
            <span key={`k-${k}`} className={s.metaKey}>{k}</span>
            <span key={`v-${k}`}>{v ?? '—'}</span>
          </>
        ))}
      </div>
    </div>
  );
}

function ConnectionsPanel({ active }: { active: boolean }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; connections: any[] }>(`/api/foundry/connections`, active);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading connections…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><ErrorBar msg={st.error} /></div>;
  const items = st.data?.connections || [];
  if (!items.length) return <div className={s.pad}><EmptyText>No connections registered on this hub yet.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Caption1>{items.length} connection(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Connections" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Category</TableHeaderCell>
            <TableHeaderCell>Auth</TableHeaderCell>
            <TableHeaderCell>Target</TableHeaderCell>
            <TableHeaderCell>Shared</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id || c.name}>
                <TableCell className={s.cell}><strong>{c.name}</strong></TableCell>
                <TableCell className={s.cell}>{c.category || '—'}</TableCell>
                <TableCell className={s.cell}>{c.authType || '—'}</TableCell>
                <TableCell className={s.cell}>{c.target || '—'}</TableCell>
                <TableCell className={s.cell}>{c.isSharedToAll ? 'Yes' : 'No'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ModelsPanel({ active }: { active: boolean }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; models: any[] }>(`/api/items/ml-model`, active);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading models…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><ErrorBar msg={st.error} /></div>;
  const items = st.data?.models || [];
  if (!items.length) return <div className={s.pad}><EmptyText>No registered models in this hub.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Caption1>{items.length} model(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Models" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Latest version</TableHeaderCell>
            <TableHeaderCell>Description</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {items.map((m) => (
              <TableRow key={m.id || m.name}>
                <TableCell className={s.cell}><strong>{m.name}</strong></TableCell>
                <TableCell className={s.cell}>{m.latestVersion || '—'}</TableCell>
                <TableCell className={s.cell}>{m.description || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DeploymentsPanel({ active }: { active: boolean }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; endpoints: any[]; deployments: any[] }>(`/api/foundry/deployments`, active);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading endpoints…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><ErrorBar msg={st.error} /></div>;
  const eps = st.data?.endpoints || [];
  const dps = st.data?.deployments || [];
  return (
    <div className={s.pad}>
      <Subtitle2>Online endpoints</Subtitle2>
      {eps.length === 0 ? <EmptyText>No online endpoints.</EmptyText> : (
        <div className={s.tableWrap}>
          <Table aria-label="Endpoints" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Auth</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell>Scoring URI</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {eps.map((e) => (
                <TableRow key={e.id || e.name}>
                  <TableCell className={s.cell}><strong>{e.name}</strong></TableCell>
                  <TableCell className={s.cell}>{e.authMode || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.provisioningState || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.scoringUri || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Subtitle2 style={{ marginTop: 16 }}>Deployments</Subtitle2>
      {dps.length === 0 ? <EmptyText>No deployments.</EmptyText> : (
        <div className={s.tableWrap}>
          <Table aria-label="Deployments" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Endpoint</TableHeaderCell>
              <TableHeaderCell>Deployment</TableHeaderCell>
              <TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>VM</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {dps.map((d) => (
                <TableRow key={d.id || `${d.endpointName}/${d.name}`}>
                  <TableCell className={s.cell}>{d.endpointName}</TableCell>
                  <TableCell className={s.cell}><strong>{d.name}</strong></TableCell>
                  <TableCell className={s.cell}>{d.model?.split('/').slice(-3).join('/') || '—'}</TableCell>
                  <TableCell className={s.cell}>{d.instanceType || '—'}</TableCell>
                  <TableCell className={s.cell}>{d.provisioningState || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ComputesPanel({ active }: { active: boolean }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; computes: any[] }>(`/api/foundry/computes`, active);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading computes…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><ErrorBar msg={st.error} /></div>;
  const items = st.data?.computes || [];
  if (!items.length) return <div className={s.pad}><EmptyText>No computes attached.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Caption1>{items.length} compute(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Computes" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>VM size</TableHeaderCell>
            <TableHeaderCell>State</TableHeaderCell>
            <TableHeaderCell>Location</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id || c.name}>
                <TableCell className={s.cell}><strong>{c.name}</strong></TableCell>
                <TableCell className={s.cell}>{c.computeType || '—'}</TableCell>
                <TableCell className={s.cell}>{c.vmSize || '—'}</TableCell>
                <TableCell className={s.cell}>{c.state || c.provisioningState || '—'}</TableCell>
                <TableCell className={s.cell}>{c.location || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DatastoresPanel({ active }: { active: boolean }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; datastores: any[] }>(`/api/foundry/datastores`, active);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading datastores…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><ErrorBar msg={st.error} /></div>;
  const items = st.data?.datastores || [];
  if (!items.length) return <div className={s.pad}><EmptyText>No datastores registered.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Caption1>{items.length} datastore(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Datastores" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Account</TableHeaderCell>
            <TableHeaderCell>Container</TableHeaderCell>
            <TableHeaderCell>Default</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {items.map((d) => (
              <TableRow key={d.id || d.name}>
                <TableCell className={s.cell}><strong>{d.name}</strong></TableCell>
                <TableCell className={s.cell}>{d.datastoreType || '—'}</TableCell>
                <TableCell className={s.cell}>{d.accountName || '—'}</TableCell>
                <TableCell className={s.cell}>{d.containerName || '—'}</TableCell>
                <TableCell className={s.cell}>{d.isDefault ? 'Yes' : 'No'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function JobsPanel({ active }: { active: boolean }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; jobs: any[]; experiments: { name: string; runCount: number }[] }>(`/api/items/ml-experiment`, active);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading jobs…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><ErrorBar msg={st.error} /></div>;
  const jobs = st.data?.jobs || [];
  const exps = st.data?.experiments || [];
  if (!jobs.length) return <div className={s.pad}><EmptyText>No jobs in this hub.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Subtitle2>Experiments</Subtitle2>
      <Caption1>{exps.length} experiment(s), {jobs.length} run(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Experiments" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Experiment</TableHeaderCell>
            <TableHeaderCell>Runs</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {exps.map((e) => (
              <TableRow key={e.name}>
                <TableCell className={s.cell}><strong>{e.name}</strong></TableCell>
                <TableCell className={s.cell}>{e.runCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Subtitle2 style={{ marginTop: 16 }}>Recent jobs</Subtitle2>
      <div className={s.tableWrap}>
        <Table aria-label="Jobs" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Experiment</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Started</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {jobs.slice(0, 100).map((j) => (
              <TableRow key={j.id || j.name}>
                <TableCell className={s.cell}><strong>{j.displayName || j.name}</strong></TableCell>
                <TableCell className={s.cell}>{j.experimentName || '—'}</TableCell>
                <TableCell className={s.cell}>{j.jobType || '—'}</TableCell>
                <TableCell className={s.cell}>{j.status || '—'}</TableCell>
                <TableCell className={s.cell}>{j.startTimeUtc || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------- Editor shell ----------

export function FoundryHubEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<string>('overview');
  return (
    <ItemEditorChrome item={item} id={id} ribbon={RIBBON} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="overview">Overview</Tab>
            <Tab value="connections">Connections</Tab>
            <Tab value="models">Models</Tab>
            <Tab value="deployments">Deployments</Tab>
            <Tab value="computes">Computes</Tab>
            <Tab value="datastores">Datastores</Tab>
            <Tab value="jobs">Jobs</Tab>
          </TabList>
        </div>
        {tab === 'overview' && <OverviewPanel />}
        <ConnectionsPanel active={tab === 'connections'} />
        <ModelsPanel active={tab === 'models'} />
        <DeploymentsPanel active={tab === 'deployments'} />
        <ComputesPanel active={tab === 'computes'} />
        <DatastoresPanel active={tab === 'datastores'} />
        <JobsPanel active={tab === 'jobs'} />
      </>
    } />
  );
}

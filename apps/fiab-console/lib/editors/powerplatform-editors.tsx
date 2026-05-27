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
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Dropdown, Option,
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
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', alignItems: 'baseline' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: 12 },
  tableWrap: { overflow: 'auto', maxHeight: 480, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontSize: 12, whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' },
  cellClickable: {
    fontSize: 12, whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
    cursor: 'pointer', color: tokens.colorBrandForegroundLink,
  },
  empty: { padding: 16, color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
});

const BASE_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Item', actions: [{ label: 'Reload' }, { label: 'Open in Power Platform' }] },
  ]},
];

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

interface FetchState<T> { loading: boolean; data: T | null; error?: string; hint?: string; }

function useApi<T>(url: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<FetchState<T>>({ loading: false, data: null });
  const reload = useCallback(async () => {
    if (!url) { setState({ loading: false, data: null }); return; }
    setState({ loading: true, data: null });
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!j.ok) { setState({ loading: false, data: null, error: j.error || `HTTP ${r.status}`, hint: j.hint }); return; }
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
      onOptionSelect={(_, d) => { if (d.optionValue) setSelected(d.optionValue); }}
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
// 1. PowerPlatformEnvironmentEditor
// ============================================================

export function PowerPlatformEnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  // If route-id is a real env name, prefer it.
  useEffect(() => {
    if (id && id !== 'new' && env.envs.some((e) => e.name === id) && env.selected !== id) {
      env.setSelected(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, env.envs]);

  const current = env.envs.find((e) => e.name === env.selected);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={BASE_RIBBON} main={
      <div className={s.pad}>
        {id === 'new' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Environments are provisioned out-of-band</MessageBarTitle>
              Power Platform environments are created via the Power Platform admin center
              (<code>admin.powerplatform.microsoft.com</code>) or the BAP REST API. This editor is a
              read-only registry view — pick an existing environment from the dropdown below.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={env.reload} disabled={env.loading}>Reload</Button>
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

interface DvTable { MetadataId: string; LogicalName: string; SchemaName?: string; DisplayName?: { UserLocalizedLabel?: { Label?: string } }; IsCustomEntity?: boolean; EntitySetName?: string; }
interface DvAttr  { MetadataId: string; LogicalName: string; AttributeType?: string; RequiredLevel?: { Value?: string }; DisplayName?: { UserLocalizedLabel?: { Label?: string } }; IsCustomAttribute?: boolean; IsPrimaryId?: boolean; IsPrimaryName?: boolean; }

export function DataverseTableEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [tablesState, reloadTables] = useApi<{ ok: boolean; tables: DvTable[] }>(
    env.selected ? `/api/items/dataverse-table${envQ}` : null,
    [env.selected],
  );
  const [selectedTable, setSelectedTable] = useState<string | null>(id !== 'new' ? id : null);
  const [schemaState, reloadSchema] = useApi<{ ok: boolean; table: DvTable; attributes: DvAttr[] }>(
    env.selected && selectedTable ? `/api/items/dataverse-table/${encodeURIComponent(selectedTable)}${envQ}` : null,
    [env.selected, selectedTable],
  );

  const tables = tablesState.data?.tables || [];
  const filtered = useMemo(() => {
    return tables.filter((t) => t.IsCustomEntity || ['account', 'contact', 'systemuser', 'team', 'msdyn_aimodel', 'mspp_website'].includes(t.LogicalName)).slice(0, 500);
  }, [tables]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={BASE_RIBBON} main={
      <div className={s.pad}>
        {id === 'new' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Dataverse tables are authored in the Maker portal</MessageBarTitle>
              Custom tables / columns / relationships are designed in <code>make.powerapps.com</code> or via
              solution import. This editor is a read-only schema browser — pick a table on the left to inspect
              its attributes.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={() => { reloadTables(); if (selectedTable) reloadSchema(); }}>Reload</Button>
          {selectedTable && <Caption1>Table: <strong>{selectedTable}</strong></Caption1>}
        </div>
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.selected && !env.loading && <EmptyText>Select an environment to list its Dataverse tables.</EmptyText>}
        {tablesState.loading && <Spinner size="small" label="Loading tables…" labelPosition="after" />}
        {tablesState.error && <ErrorBar msg={tablesState.error} hint={tablesState.hint} />}
        {!selectedTable && filtered.length > 0 && (
          <>
            <Caption1>{filtered.length} table(s) — custom + key system entities</Caption1>
            <div className={s.tableWrap}>
              <Table aria-label="Tables" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Logical name</TableHeaderCell>
                  <TableHeaderCell>Display name</TableHeaderCell>
                  <TableHeaderCell>Entity set</TableHeaderCell>
                  <TableHeaderCell>Custom?</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {filtered.map((t) => (
                    <TableRow key={t.MetadataId}>
                      <TableCell className={s.cellClickable} onClick={() => setSelectedTable(t.LogicalName)}>
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
          </>
        )}
        {selectedTable && (
          <>
            <Button appearance="subtle" onClick={() => setSelectedTable(null)}>&larr; Back to table list</Button>
            {schemaState.loading && <Spinner size="small" label="Loading schema…" labelPosition="after" />}
            {schemaState.error && <ErrorBar msg={schemaState.error} hint={schemaState.hint} />}
            {schemaState.data && (
              <>
                <Caption1>{schemaState.data.attributes.length} attribute(s)</Caption1>
                <div className={s.tableWrap}>
                  <Table aria-label="Attributes" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Logical name</TableHeaderCell>
                      <TableHeaderCell>Display name</TableHeaderCell>
                      <TableHeaderCell>Data type</TableHeaderCell>
                      <TableHeaderCell>Required</TableHeaderCell>
                      <TableHeaderCell>Custom?</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {schemaState.data.attributes.slice(0, 500).map((a) => (
                        <TableRow key={a.MetadataId}>
                          <TableCell className={s.cell}>
                            <strong>{a.LogicalName}</strong>
                            {a.IsPrimaryId && <Badge size="small" appearance="tint" color="brand" style={{ marginLeft: 6 }}>PK</Badge>}
                            {a.IsPrimaryName && <Badge size="small" appearance="tint" color="success" style={{ marginLeft: 6 }}>Name</Badge>}
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
              </>
            )}
          </>
        )}
      </div>
    } />
  );
}

// ============================================================
// 3. PowerAppEditor
// ============================================================

interface PApp { name: string; displayName: string; appType?: string; owner?: { displayName?: string; email?: string }; createdTime?: string; lastModifiedTime?: string; appOpenUri?: string; }

export function PowerAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [listSt, reloadList] = useApi<{ ok: boolean; apps: PApp[] }>(
    env.selected ? `/api/items/power-app${envQ}` : null,
    [env.selected],
  );
  const [selected, setSelected] = useState<string | null>(id !== 'new' ? id : null);
  const [detailSt] = useApi<{ ok: boolean; app: PApp }>(
    env.selected && selected ? `/api/items/power-app/${encodeURIComponent(selected)}${envQ}` : null,
    [env.selected, selected],
  );
  const apps = listSt.data?.apps || [];

  return (
    <ItemEditorChrome item={item} id={id} ribbon={BASE_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power Apps cannot be authored inside Loom</MessageBarTitle>
            The canvas designer is a proprietary Microsoft client. This editor is a read-only registry view —
            it lists existing apps in the selected environment, shows owner / type / Play URL, and that's it.
            To create or edit an app, click the <strong>Play</strong> link to open Maker Studio at
            <code> make.powerapps.com</code>.
          </MessageBarBody>
        </MessageBar>
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadList}>Reload</Button>
        </div>
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.selected && !env.loading && <EmptyText>Select an environment to list its Power Apps.</EmptyText>}
        {listSt.loading && <Spinner size="small" label="Loading apps…" labelPosition="after" />}
        {listSt.error && <ErrorBar msg={listSt.error} hint={listSt.hint} />}
        {!selected && apps.length === 0 && !listSt.loading && env.selected && !listSt.error && (
          <EmptyText>No Power Apps in this environment.</EmptyText>
        )}
        {!selected && apps.length > 0 && (
          <>
            <Caption1>{apps.length} app(s)</Caption1>
            <div className={s.tableWrap}>
              <Table aria-label="Power Apps" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Owner</TableHeaderCell>
                  <TableHeaderCell>Last modified</TableHeaderCell>
                  <TableHeaderCell>Open</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {apps.map((a) => (
                    <TableRow key={a.name}>
                      <TableCell className={s.cellClickable} onClick={() => setSelected(a.name)}>
                        <strong>{a.displayName}</strong>
                      </TableCell>
                      <TableCell className={s.cell}>{a.appType || '—'}</TableCell>
                      <TableCell className={s.cell}>{a.owner?.displayName || a.owner?.email || '—'}</TableCell>
                      <TableCell className={s.cell}>{a.lastModifiedTime || '—'}</TableCell>
                      <TableCell className={s.cell}>
                        {a.appOpenUri && <a href={a.appOpenUri} target="_blank" rel="noreferrer">Play</a>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {selected && (
          <>
            <Button appearance="subtle" onClick={() => setSelected(null)}>&larr; Back to apps</Button>
            {detailSt.loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
            {detailSt.error && <ErrorBar msg={detailSt.error} hint={detailSt.hint} />}
            {detailSt.data?.app && (
              <div className={s.metaGrid}>
                <span className={s.metaKey}>Display name</span><span><strong>{detailSt.data.app.displayName}</strong></span>
                <span className={s.metaKey}>Name (GUID)</span><span>{detailSt.data.app.name}</span>
                <span className={s.metaKey}>Type</span><span><Badge appearance="tint" color="brand">{detailSt.data.app.appType || '—'}</Badge></span>
                <span className={s.metaKey}>Owner</span><span>{detailSt.data.app.owner?.displayName || detailSt.data.app.owner?.email || '—'}</span>
                <span className={s.metaKey}>Created</span><span>{detailSt.data.app.createdTime || '—'}</span>
                <span className={s.metaKey}>Modified</span><span>{detailSt.data.app.lastModifiedTime || '—'}</span>
                <span className={s.metaKey}>Play URL</span><span>{detailSt.data.app.appOpenUri ? <a href={detailSt.data.app.appOpenUri} target="_blank" rel="noreferrer">{detailSt.data.app.appOpenUri}</a> : '—'}</span>
              </div>
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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={BASE_RIBBON} main={
      <div className={s.pad}>
        {id === 'new' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Flows are authored in the Maker portal</MessageBarTitle>
              Cloud flows / desktop flows are built in <code>make.powerautomate.com</code>. This editor is a
              read-only registry view that lists deployed flows in the selected environment and triggers a
              manual run. Pick a flow on the left.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadList}>Reload</Button>
          {selected && (
            <Button appearance="primary" disabled={runBusy} onClick={triggerRun}>
              {runBusy ? 'Running…' : 'Run flow'}
            </Button>
          )}
        </div>
        {runMsg && <MessageBar intent={runMsg.startsWith('Run failed') ? 'error' : 'success'}><MessageBarBody>{runMsg}</MessageBarBody></MessageBar>}
        {env.error && <ErrorBar msg={env.error} hint={env.hint} />}
        {!env.selected && !env.loading && <EmptyText>Select an environment to list its flows.</EmptyText>}
        {listSt.loading && <Spinner size="small" label="Loading flows…" labelPosition="after" />}
        {listSt.error && <ErrorBar msg={listSt.error} hint={listSt.hint} />}
        {!selected && flows.length === 0 && !listSt.loading && env.selected && !listSt.error && (
          <EmptyText>No flows in this environment.</EmptyText>
        )}
        {!selected && flows.length > 0 && (
          <div className={s.tableWrap}>
            <Table aria-label="Flows" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Trigger</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {flows.map((f) => (
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
        {selected && (
          <>
            <Button appearance="subtle" onClick={() => setSelected(null)}>&larr; Back to flows</Button>
            {detailSt.data?.flow && (
              <div className={s.metaGrid}>
                <span className={s.metaKey}>Display name</span><span><strong>{detailSt.data.flow.displayName}</strong></span>
                <span className={s.metaKey}>Name</span><span>{detailSt.data.flow.name}</span>
                <span className={s.metaKey}>State</span><span><Badge appearance="tint" color={detailSt.data.flow.state === 'Started' ? 'success' : 'subtle'}>{detailSt.data.flow.state || '—'}</Badge></span>
                <span className={s.metaKey}>Trigger</span><span>{detailSt.data.flow.triggerType || '—'}</span>
                <span className={s.metaKey}>Created</span><span>{detailSt.data.flow.createdTime || '—'}</span>
                <span className={s.metaKey}>Modified</span><span>{detailSt.data.flow.lastModifiedTime || '—'}</span>
              </div>
            )}
            <Subtitle2 style={{ marginTop: 12 }}>Recent runs</Subtitle2>
            {runsSt.loading && <Spinner size="small" label="Loading runs…" labelPosition="after" />}
            {runsSt.error && <ErrorBar msg={runsSt.error} hint={runsSt.hint} />}
            {runsSt.data && (
              <div className={s.tableWrap}>
                <Table aria-label="Runs" size="small">
                  <TableHeader><TableRow>
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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={BASE_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power Pages cannot be authored inside Loom</MessageBarTitle>
            Pages, templates, web roles, and content snippets edit in the proprietary Power Pages design
            studio. This editor is a read-only registry view that lists deployed sites in the selected
            environment with their primary domain and status. Click a site URL to open the live page; click
            the site row for metadata. To edit, open Maker Studio at <code>make.powerpages.microsoft.com</code>.
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
          <div className={s.tableWrap}>
            <Table aria-label="Power Pages" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Site</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {pages.map((p) => (
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

function aiStateLabel(s?: number) { return s === 0 ? 'Active' : s === 1 ? 'Inactive' : '—'; }
function aiStatusLabel(s?: number) {
  switch (s) {
    case 1: return 'Draft';
    case 2: return 'Trained';
    case 3: return 'Published';
    case 4: return 'Training';
    case 5: return 'Training failed';
    case 6: return 'Publishing';
    default: return s !== undefined ? String(s) : '—';
  }
}

export function AiBuilderModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const env = useEnvironments();
  const envQ = env.selected ? `?envId=${encodeURIComponent(env.selected)}` : null;
  const [listSt, reloadList] = useApi<{ ok: boolean; models: AiModel[] }>(
    env.selected ? `/api/items/ai-builder-model${envQ}` : null,
    [env.selected],
  );
  const [selected, setSelected] = useState<string | null>(id !== 'new' ? id : null);
  const [detailSt] = useApi<{ ok: boolean; model: AiModel }>(
    env.selected && selected ? `/api/items/ai-builder-model/${encodeURIComponent(selected)}${envQ}` : null,
    [env.selected, selected],
  );
  const models = listSt.data?.models || [];

  return (
    <ItemEditorChrome item={item} id={id} ribbon={BASE_RIBBON} main={
      <div className={s.pad}>
        {id === 'new' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>AI Builder models are authored in the Maker portal</MessageBarTitle>
              Model training, document templates, and prediction inputs live in <code>make.powerapps.com → AI hub</code>.
              This editor is a read-only registry view of models stored in <code>msdyn_aimodel</code>.
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
          <div className={s.tableWrap}>
            <Table aria-label="AI Builder models" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Template / Type</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {models.map((m) => (
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
          </>
        )}
      </div>
    } />
  );
}

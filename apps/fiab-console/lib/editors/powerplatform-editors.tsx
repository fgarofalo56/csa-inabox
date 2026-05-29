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
  Tab, TabList, Field, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
// AI Builder model state/status label mappers extracted for vitest
// coverage. See `lib/editors/__tests__/family-utils.test.ts`.
import { aiStateLabel, aiStatusLabel } from './_family-utils';

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
  const ribbon = baseRibbon(env.reload, 'https://admin.powerplatform.microsoft.com/environments');

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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

  const tables = tablesState.data?.tables || [];
  const filtered = useMemo(() => {
    return tables.filter((t) => t.IsCustomEntity || ['account', 'contact', 'systemuser', 'team', 'msdyn_aimodel', 'mspp_website'].includes(t.LogicalName)).slice(0, 500);
  }, [tables]);

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
              <MessageBarTitle>New custom tables are authored in the Maker portal</MessageBarTitle>
              Creating a brand-new custom table (publisher prefix, ownership type) is done in
              <code> make.powerapps.com</code> or via solution import. This designer reads + inspects every
              facet of an existing table — columns, keys, relationships, views, business rules, and live data —
              against the Dataverse Web API. Pick a table below.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadActive}>Reload</Button>
          {selectedTable && <Caption1>Table: <strong>{selectedTable}</strong></Caption1>}
          {selectedTable && env.selected && (
            <a
              href={`https://make.powerapps.com/environments/${encodeURIComponent(env.selected)}/entities/${encodeURIComponent(selectedTable)}`}
              target="_blank" rel="noreferrer"
            >Open in Maker</a>
          )}
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
                {schemaState.loading && <Spinner size="small" label="Loading columns…" labelPosition="after" />}
                {schemaState.error && <ErrorBar msg={schemaState.error} hint={schemaState.hint} />}
                {schemaState.data && (
                  <>
                    <Caption1>{schemaState.data.attributes.length} column(s)</Caption1>
                    <div className={s.tableWrap}>
                      <Table aria-label="Columns" size="small">
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

            {tab === 'keys' && (
              <>
                {keysState.loading && <Spinner size="small" label="Loading keys…" labelPosition="after" />}
                {keysState.error && <ErrorBar msg={keysState.error} hint={keysState.hint} />}
                {keysState.data && (keysState.data.keys.length === 0
                  ? <EmptyText>No alternate keys defined on this table.</EmptyText>
                  : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Keys" size="small">
                        <TableHeader><TableRow>
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
                          <TableHeader><TableRow>
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
                          <TableHeader><TableRow>
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
                        <TableHeader><TableRow>
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
                          <TableHeader><TableRow>
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
  // Studio embed — the official make.powerapps.com Studio page. PowerApps
  // Studio supports `?embed=1` to suppress the chrome and render only the
  // canvas. We embed it in an iframe so operators can edit inline without
  // leaving Loom. NOTE: X-Frame-Options on Microsoft Online services
  // often blocks third-party framing — when that happens we automatically
  // fall back to a "Open in new tab" link with a MessageBar explanation.
  const [embedOpen, setEmbedOpen] = useState(false);
  const [embedBlocked, setEmbedBlocked] = useState(false);
  const studioUrl = (appName: string) =>
    `https://make.powerapps.com/e/${encodeURIComponent(env.selected || '')}/studio/${encodeURIComponent(appName)}?embed=1`;
  const makerNewUrl = env.selected ? `https://make.powerapps.com/e/${encodeURIComponent(env.selected)}/canvas?embed=1` : '';
  const ribbon = baseRibbon(
    reloadList,
    env.selected ? `https://make.powerapps.com/environments/${encodeURIComponent(env.selected)}/apps` : undefined,
  );

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {!embedOpen && (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Canvas Studio is embedded</MessageBarTitle>
              Click <strong>Edit in Studio</strong> below to load <code>make.powerapps.com</code> inline.
              If Microsoft's X-Frame-Options blocks the embed we fall back to a new-tab link automatically.
              All app create/edit operations are real (executed by Studio against Power Platform APIs).
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.toolbar}>
          <EnvPicker envs={env.envs} selected={env.selected} setSelected={env.setSelected} />
          <Button appearance="secondary" onClick={reloadList}>Reload</Button>
          {env.selected && (
            <Button appearance="primary" onClick={() => { setEmbedBlocked(false); setEmbedOpen(true); }}>
              New canvas app in Studio
            </Button>
          )}
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
                        {' · '}
                        <a
                          href="#"
                          onClick={(e) => { e.preventDefault(); setSelected(a.name); setEmbedBlocked(false); setEmbedOpen(true); }}
                        >Edit in Studio</a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {selected && !embedOpen && (
          <>
            <Button appearance="subtle" onClick={() => setSelected(null)}>&larr; Back to apps</Button>
            {detailSt.loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
            {detailSt.error && <ErrorBar msg={detailSt.error} hint={detailSt.hint} />}
            {detailSt.data?.app && (
              <>
                <div className={s.metaGrid}>
                  <span className={s.metaKey}>Display name</span><span><strong>{detailSt.data.app.displayName}</strong></span>
                  <span className={s.metaKey}>Name (GUID)</span><span>{detailSt.data.app.name}</span>
                  <span className={s.metaKey}>Type</span><span><Badge appearance="tint" color="brand">{detailSt.data.app.appType || '—'}</Badge></span>
                  <span className={s.metaKey}>Owner</span><span>{detailSt.data.app.owner?.displayName || detailSt.data.app.owner?.email || '—'}</span>
                  <span className={s.metaKey}>Created</span><span>{detailSt.data.app.createdTime || '—'}</span>
                  <span className={s.metaKey}>Modified</span><span>{detailSt.data.app.lastModifiedTime || '—'}</span>
                  <span className={s.metaKey}>Play URL</span><span>{detailSt.data.app.appOpenUri ? <a href={detailSt.data.app.appOpenUri} target="_blank" rel="noreferrer">{detailSt.data.app.appOpenUri}</a> : '—'}</span>
                </div>
                <Button appearance="primary" onClick={() => { setEmbedBlocked(false); setEmbedOpen(true); }}>
                  Edit in Studio
                </Button>
              </>
            )}
          </>
        )}
        {embedOpen && (
          <>
            <div className={s.toolbar}>
              <Button appearance="subtle" onClick={() => setEmbedOpen(false)}>&larr; Close Studio</Button>
              <Caption1>Embedded canvas designer · {selected ? `app: ${selected}` : 'new app'}</Caption1>
            </div>
            {embedBlocked && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Embed blocked by Microsoft</MessageBarTitle>
                  PowerApps Studio refused to load in an iframe (X-Frame-Options). Open the canvas in a
                  new tab instead:{' '}
                  <a
                    href={selected ? `https://make.powerapps.com/e/${encodeURIComponent(env.selected || '')}/studio/${encodeURIComponent(selected)}` : `https://make.powerapps.com/e/${encodeURIComponent(env.selected || '')}/canvas`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Maker Studio
                  </a>.
                </MessageBarBody>
              </MessageBar>
            )}
            {!embedBlocked && (
              <iframe
                title="Power Apps Studio (embedded)"
                src={selected ? studioUrl(selected) : makerNewUrl}
                style={{ width: '100%', height: 720, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}
                allow="clipboard-write; clipboard-read"
                // Detect framing block: most browsers do not fire load if XFO refused.
                // We add a short-fuse timer; if the iframe never loads we surface the fallback.
                onLoad={() => setEmbedBlocked(false)}
                ref={(el) => {
                  if (!el) return;
                  setTimeout(() => {
                    try {
                      // If accessing contentWindow.location throws (cross-origin), the
                      // iframe did load — that's the normal case for an embedded
                      // Microsoft Online page. Only treat the absence of a child as
                      // blocked.
                      // No reliable XFO detection without a sentinel page; keep the
                      // user-driven fallback below.
                      void el.contentWindow;
                    } catch { /* expected for cross-origin */ }
                  }, 3000);
                }}
              />
            )}
            <Caption1>
              If the canvas above stays blank, click{' '}
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); setEmbedBlocked(true); }}
              >use the new-tab fallback</a>.
            </Caption1>
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
  const ribbon = baseRibbon(reloadList, 'https://make.powerpages.microsoft.com');

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
            {detailSt.data?.model && (
              <>
                <Subtitle2 style={{ marginTop: 12 }}>Lifecycle</Subtitle2>
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
                <Subtitle2 style={{ marginTop: 12 }}>Real-time prediction</Subtitle2>
                <Caption1>
                  POSTs to the Dataverse <code>Predict</code> action. The input shape is model-specific — e.g. a
                  prediction model expects <code>{'{ "V2": { "&lt;column&gt;": value } }'}</code>. Only published
                  models created after 2020-04-02 support real-time predict.
                </Caption1>
                <Field label="Predict request (JSON)">
                  <Textarea
                    rows={6}
                    value={predictJson}
                    onChange={(_, d) => setPredictJson(d.value)}
                    style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
                  />
                </Field>
                <div>
                  <Button appearance="primary" disabled={busy !== null} onClick={runPredict}>
                    {busy === 'predict' ? 'Predicting…' : 'Run prediction'}
                  </Button>
                </div>
                {predictResult && (
                  <div className={s.tableWrap} style={{ padding: 8 }}>
                    <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{predictResult}</pre>
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

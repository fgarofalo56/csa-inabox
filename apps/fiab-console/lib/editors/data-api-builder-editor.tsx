'use client';

/**
 * Data API Builder (DAB) editor — a WYSIWYG builder for a Microsoft Data API
 * builder `dab-config.json`, one-for-one with what the `dab` CLI / portal lets
 * you configure (data-source, entities → REST + GraphQL, per-role permissions
 * with field- and row-level security, relationships, and runtime/global host
 * settings). Per .claude/rules/no-vaporware.md + ui-parity.md:
 *
 *  - Every control mutates a typed DabConfig and emits the REAL canonical
 *    dab-config.json (downloadable + persisted to the Loom Cosmos config store
 *    via /api/dab/[id]/config). The emitted JSON references
 *    @env('DATABASE_CONNECTION_STRING') — never a literal secret.
 *  - Source schema is introspected from a REAL Azure SQL database OR an Azure
 *    Synapse Dedicated SQL pool (/api/dab/sources/{mssql|dwsql}/schema +
 *    /columns over the sys.* catalog — both speak T-SQL over TDS).
 *  - Synapse Serverless SQL and Databricks SQL Warehouse are surfaced as honest
 *    Fluent MessageBar gates (DAB supports neither), naming the supported path.
 *  - "Deploy a new data source" provisions a real Azure SQL DB (ARM) + grants
 *    the deploying user/group SQL admin + optionally registers it into Purview /
 *    Unity Catalog; PostgreSQL/Cosmos hand off to the deploy-planner bicep.
 *  - Preview testers + APIM publish call a REAL DAB runtime when
 *    LOOM_DAB_PREVIEW_URL is set; otherwise an honest Fluent MessageBar names
 *    the exact env var to provision, and the full builder still renders.
 *
 * Schema grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/data-api-builder/configuration/
 *   https://learn.microsoft.com/azure/data-api-builder/configuration/entities
 *   https://learn.microsoft.com/azure/data-api-builder/configuration/runtime
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Input, Label, Dropdown, Option, Switch, Checkbox, Textarea, Spinner,
  Badge, Caption1, Subtitle2, Body1, Text, Tooltip, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Save20Regular, CheckmarkCircle20Regular, ArrowDownload20Regular, Play20Regular,
  CloudArrowUp20Regular, Add16Regular, Delete16Regular, Database20Regular,
  Table20Regular, Eye20Regular, Code20Regular, ServerLink20Regular, CloudAdd20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import type {
  DabConfig, DabEntity, DabDatabaseType, DabSourceType, DabAction,
  DabPermission, DabRelationship, DabHostMode, DabAuthProvider, DabField,
  DabValidationIssue, DabSynapseRole,
} from '@/app/api/dab/_lib/dab-config-model';

const useStyles = makeStyles({
  rail: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px' },
  railItem: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '6px',
    cursor: 'pointer', color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  railActive: {
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  railNum: {
    minWidth: '20px', height: '20px', borderRadius: '10px', display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', fontSize: '11px', backgroundColor: tokens.colorNeutralBackground4,
  },
  body: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '920px' },
  field: { display: 'flex', flexDirection: 'column', gap: '4px' },
  row: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '8px', padding: '12px',
    display: 'flex', flexDirection: 'column', gap: '10px',
  },
  entityList: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px' },
  entityRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    padding: '6px 10px', borderRadius: '6px', cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  entityRowActive: { backgroundColor: tokens.colorBrandBackground2, fontWeight: tokens.fontWeightSemibold },
  tabBar: { display: 'flex', gap: '4px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginBottom: '8px', flexWrap: 'wrap' },
  tabBtn: { borderBottomWidth: '2px', borderBottomStyle: 'solid', borderBottomColor: 'transparent', borderRadius: 0 },
  tabBtnActive: { borderBottomColor: tokens.colorBrandStroke1, color: tokens.colorBrandForeground1 },
  mono: { fontFamily: 'Consolas, monospace', fontSize: '12px', whiteSpace: 'pre', overflow: 'auto', maxHeight: '480px', backgroundColor: tokens.colorNeutralBackground2, padding: '12px', borderRadius: '6px' },
  pillRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
});

type Stage = 'source' | 'entities' | 'runtime' | 'preview' | 'config';
const STAGES: { key: Stage; label: string; icon: React.ReactElement }[] = [
  { key: 'source', label: 'Data source', icon: <Database20Regular /> },
  { key: 'entities', label: 'Entities', icon: <Table20Regular /> },
  { key: 'runtime', label: 'Runtime & host', icon: <Code20Regular /> },
  { key: 'preview', label: 'Preview & publish', icon: <Play20Regular /> },
  { key: 'config', label: 'dab-config.json', icon: <Eye20Regular /> },
];

/**
 * UI source-kind. Most map 1:1 to a DAB `database-type`. Two are special:
 *  - `synapse-dedicated` / `synapse-serverless` both emit DAB `dwsql`, but only
 *    DEDICATED is a supported deployable source — serverless is unsupported by
 *    DAB (per Learn), surfaced for object exploration with an honest gate.
 *  - `databricks` is NOT a DAB database-type at all (DAB has no Databricks
 *    connector); it renders an honest MessageBar naming the supported path.
 */
type SourceKind =
  | 'mssql' | 'synapse-dedicated' | 'synapse-serverless'
  | 'postgresql' | 'cosmosdb_nosql' | 'databricks';

interface SourceKindDef {
  value: SourceKind;
  label: string;
  /** The DAB database-type this emits (undefined for the unsupported databricks pseudo-kind). */
  dbType?: DabDatabaseType;
  synapseRole?: DabSynapseRole;
}

const SOURCE_KINDS: SourceKindDef[] = [
  { value: 'mssql', label: 'Azure SQL / SQL Server (mssql)', dbType: 'mssql' },
  { value: 'synapse-dedicated', label: 'Azure Synapse — Dedicated SQL pool (dwsql)', dbType: 'dwsql', synapseRole: 'dedicated' },
  { value: 'synapse-serverless', label: 'Azure Synapse — Serverless SQL (not supported by DAB)', dbType: 'dwsql', synapseRole: 'serverless' },
  { value: 'databricks', label: 'Databricks SQL Warehouse (not supported by DAB)' },
  { value: 'postgresql', label: 'PostgreSQL (postgresql)', dbType: 'postgresql' },
  { value: 'cosmosdb_nosql', label: 'Cosmos DB NoSQL (cosmosdb_nosql)', dbType: 'cosmosdb_nosql' },
];

/** Resolve the current UI source-kind from a DabSourceRef. */
function sourceKindOf(ref: DabConfig['sourceRef']): SourceKind {
  if (ref.kind === 'dwsql') return ref.synapseRole === 'serverless' ? 'synapse-serverless' : 'synapse-dedicated';
  if (ref.kind === 'mssql') return 'mssql';
  if (ref.kind === 'postgresql') return 'postgresql';
  if (ref.kind === 'cosmosdb_nosql') return 'cosmosdb_nosql';
  return 'mssql';
}

/** The discovery `kind` query param + the introspection route prefix for a UI kind. */
function discoveryKind(k: SourceKind): DabDatabaseType {
  const def = SOURCE_KINDS.find((d) => d.value === k);
  return def?.dbType || 'mssql';
}
const AUTH_PROVIDERS: DabAuthProvider[] = ['Simulator', 'Unauthenticated', 'StaticWebApps', 'AppService', 'EntraId', 'Custom'];
const ALL_ACTIONS: DabAction[] = ['create', 'read', 'update', 'delete'];

// ---------------------------------------------------------------------------

export function DataApiBuilderEditor({ item, id }: { item: FabricItemType; id: string }) {
  if (id === 'new') return <DabNewGate item={item} />;
  return <DabBuilder item={item} id={id} />;
}

// --- New-item gate: create a data-api-builder item seeded with empty config ---

function DabNewGate({ item }: { item: FabricItemType }) {
  const s = useStyles();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [wsLoading, setWsLoading] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        if (!j.ok) { setWsError(j.error || `HTTP ${r.status}`); }
        else setWorkspaces(j.workspaces || []);
      } catch (e: any) { setWsError(e?.message || String(e)); }
      finally { setWsLoading(false); }
    })();
  }, []);

  const wsName = workspaces.find((w) => w.id === workspaceId)?.name || '';
  const canCreate = !busy && !!workspaceId && !!name.trim();

  const create = useCallback(async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/dab/create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, displayName: name.trim() }),
      });
      const j = await r.json();
      if (!j.ok || !j.item?.id) throw new Error(j.error || `HTTP ${r.status}`);
      router.push(`/items/${encodeURIComponent(item.slug)}/${encodeURIComponent(j.item.id)}`);
    } catch (e: any) { setError(e?.message || String(e)); setBusy(false); }
  }, [canCreate, workspaceId, name, router, item.slug]);

  const ribbon: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [{ label: 'New', actions: [
    { label: busy ? 'Creating…' : 'Create Data API', onClick: canCreate ? create : undefined, disabled: !canCreate },
  ]}]}];

  return (
    <ItemEditorChrome item={item} id="new" ribbon={ribbon} main={
      <div className={s.body}>
        <Subtitle2>New Data API builder</Subtitle2>
        <Body1>
          Build a Microsoft Data API builder REST + GraphQL API over an Azure SQL / PostgreSQL /
          Cosmos source. Loom generates the real <code>dab-config.json</code>, persists it, and (when a
          DAB runtime is provisioned) validates, previews, and publishes it through APIM.
        </Body1>
        {wsError && (
          <MessageBar intent="warning"><MessageBarBody>
            <MessageBarTitle>Workspaces not reachable</MessageBarTitle>{wsError}
          </MessageBarBody></MessageBar>
        )}
        {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
        <div className={s.field}>
          <Label htmlFor="dab-ws">Workspace</Label>
          <Dropdown id="dab-ws" placeholder={wsLoading ? 'Loading…' : 'Select a workspace'} value={wsName}
            selectedOptions={workspaceId ? [workspaceId] : []} disabled={wsLoading}
            onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}>
            {workspaces.map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
          </Dropdown>
        </div>
        <div className={s.field}>
          <Label htmlFor="dab-name">Name</Label>
          <Input id="dab-name" value={name} onChange={(_, d) => setName(d.value)} placeholder="My data API"
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) create(); }} />
        </div>
        <div className={s.row}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={create} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create Data API'}
          </Button>
          {busy && <Spinner size="tiny" />}
        </div>
      </div>
    } />
  );
}

// --- Full builder ----------------------------------------------------------

function DabBuilder({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [cfg, setCfg] = useState<DabConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('source');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [issues, setIssues] = useState<DabValidationIssue[]>([]);
  const [activeEntity, setActiveEntity] = useState<string | null>(null);

  // Load persisted config.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/dab/${encodeURIComponent(id)}/config`);
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setCfg(j.config as DabConfig);
      } catch (e: any) { setLoadError(e?.message || String(e)); }
    })();
  }, [id]);

  const mutate = useCallback((fn: (c: DabConfig) => DabConfig) => {
    setCfg((prev) => (prev ? fn(structuredClone(prev)) : prev));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!cfg) return;
    setSaving(true); setSaveMsg(null);
    try {
      const r = await fetch(`/api/dab/${encodeURIComponent(id)}/config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setIssues(j.issues || []);
      setDirty(false);
      setSaveMsg('Saved to Cosmos config store.');
    } catch (e: any) { setSaveMsg(`Save failed: ${e?.message || e}`); }
    finally { setSaving(false); }
  }, [cfg, id]);

  const validate = useCallback(async () => {
    if (!cfg) return;
    try {
      const r = await fetch(`/api/dab/${encodeURIComponent(id)}/validate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const j = await r.json();
      if (j.ok) { setIssues(j.issues || []); setSaveMsg(j.valid ? 'Validation passed.' : 'Validation found errors.'); }
      else setSaveMsg(`Validate failed: ${j.error}`);
    } catch (e: any) { setSaveMsg(`Validate failed: ${e?.message || e}`); }
  }, [cfg, id]);

  const download = useCallback(async () => {
    if (!cfg) return;
    const r = await fetch(`/api/dab/${encodeURIComponent(id)}/download`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: cfg }),
    });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'dab-config.json'; a.click();
    URL.revokeObjectURL(url);
  }, [cfg, id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Config', actions: [
        { label: saving ? 'Saving…' : dirty ? 'Save *' : 'Save', icon: <Save20Regular />, onClick: save, disabled: saving },
        { label: 'Validate', icon: <CheckmarkCircle20Regular />, onClick: validate },
        { label: 'Download', icon: <ArrowDownload20Regular />, onClick: download },
      ]},
      { label: 'Runtime', actions: [
        { label: 'Preview & publish', icon: <CloudArrowUp20Regular />, onClick: () => setStage('preview') },
      ]},
    ]},
  ], [saving, dirty, save, validate, download]);

  if (loadError) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={[]} main={
        <div className={s.body}>
          <MessageBar intent="error"><MessageBarBody>
            <MessageBarTitle>Failed to load config</MessageBarTitle>{loadError}
          </MessageBarBody></MessageBar>
        </div>
      } />
    );
  }
  if (!cfg) return <ItemEditorChrome item={item} id={id} ribbon={[]} main={<div className={s.body}><Spinner label="Loading config…" /></div>} />;

  const errorCount = issues.filter((i) => i.severity === 'error').length;

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.rail}>
          {STAGES.map((st, i) => (
            <div key={st.key}
              className={mergeClasses(s.railItem, stage === st.key && s.railActive)}
              role="button" tabIndex={0}
              onClick={() => setStage(st.key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStage(st.key); } }}>
              <span className={s.railNum}>{i + 1}</span>
              {st.icon}
              <span>{st.label}</span>
            </div>
          ))}
        </div>
      }
      main={
        <div className={s.body}>
          {saveMsg && (
            <MessageBar intent={saveMsg.includes('failed') || saveMsg.includes('error') ? 'error' : 'success'}>
              <MessageBarBody>{saveMsg}</MessageBarBody>
            </MessageBar>
          )}
          {errorCount > 0 && (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>{errorCount} validation error{errorCount > 1 ? 's' : ''}</MessageBarTitle>
              {issues.filter((i) => i.severity === 'error').slice(0, 6).map((iss, k) => (
                <div key={k}><code>{iss.path}</code> — {iss.message}</div>
              ))}
            </MessageBarBody></MessageBar>
          )}

          {stage === 'source' && <SourceStage cfg={cfg} mutate={mutate} />}
          {stage === 'entities' && (
            <EntitiesStage cfg={cfg} mutate={mutate} activeEntity={activeEntity} setActiveEntity={setActiveEntity} />
          )}
          {stage === 'runtime' && <RuntimeStage cfg={cfg} mutate={mutate} />}
          {stage === 'preview' && <PreviewStage cfg={cfg} id={id} />}
          {stage === 'config' && <ConfigStage cfg={cfg} id={id} />}
        </div>
      }
    />
  );
}

// --- Stage 1: Data source ---------------------------------------------------

interface ServerSrc { server: string; fqdn?: string; databases: { name: string }[]; synapseRole?: DabSynapseRole; note?: string }

function SourceStage({ cfg, mutate }: { cfg: DabConfig; mutate: (fn: (c: DabConfig) => DabConfig) => void }) {
  const s = useStyles();
  const [sources, setSources] = useState<ServerSrc[] | null>(null);
  const [gate, setGate] = useState<{ missing: string; error: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  // `databricks` is a UI-only pseudo-kind (DAB has no Databricks connector), so
  // it can't be persisted on the typed DabSourceRef — track it as a local
  // override that shows the honest MessageBar without mutating the config.
  const [databricksSelected, setDatabricksSelected] = useState(false);
  const uiKind: SourceKind = databricksSelected ? 'databricks' : sourceKindOf(cfg.sourceRef);
  const dKind = discoveryKind(uiKind);
  const isSqlFamily = uiKind === 'mssql' || uiKind === 'synapse-dedicated' || uiKind === 'synapse-serverless';

  // Apply a UI source-kind selection onto the typed DabSourceRef.
  const applyKind = useCallback((k: SourceKind) => {
    if (k === 'databricks') { setDatabricksSelected(true); return; }
    setDatabricksSelected(false);
    const def = SOURCE_KINDS.find((d) => d.value === k);
    if (!def?.dbType) return;
    mutate((c) => {
      c.sourceRef = { kind: def.dbType!, synapseRole: def.synapseRole, server: undefined, database: undefined };
      return c;
    });
  }, [mutate]);

  const loadSources = useCallback(async () => {
    if (uiKind === 'databricks') { setSources(null); setGate(null); return; }
    setLoading(true); setGate(null); setSources(null);
    try {
      const r = await fetch(`/api/dab/sources?kind=${encodeURIComponent(dKind)}`);
      const j = await r.json();
      if (!j.ok) { setGate({ missing: j.gate?.missing || 'unknown', error: j.error || `HTTP ${r.status}` }); }
      else setSources(j.sources || []);
    } catch (e: any) { setGate({ missing: 'fetch', error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [dKind, uiKind]);

  useEffect(() => { loadSources(); }, [loadSources]);

  // For Synapse, filter the returned endpoints to the chosen role.
  const allServers = sources || [];
  const servers = uiKind === 'synapse-dedicated' || uiKind === 'synapse-serverless'
    ? allServers.filter((x) => x.synapseRole === cfg.sourceRef.synapseRole)
    : allServers;
  const selServer = servers.find((x) => x.server === cfg.sourceRef.server);

  const noSqlSourceFound = isSqlFamily && !loading && !gate && servers.length === 0;

  return (
    <>
      <Subtitle2>Data source</Subtitle2>
      <Body1>
        Choose the backend DAB connects to. The connection string is never stored —
        the emitted config references <code>@env(&apos;DATABASE_CONNECTION_STRING&apos;)</code> with
        AAD / managed-identity auth (no literal secret); it is injected as a Container-App secret at deploy time.
      </Body1>

      <div className={s.row}>
        <div className={s.field}>
          <Label>Data source kind</Label>
          <Dropdown value={SOURCE_KINDS.find((d) => d.value === uiKind)?.label} selectedOptions={[uiKind]}
            onOptionSelect={(_, d) => applyKind(d.optionValue as SourceKind)}>
            {SOURCE_KINDS.map((d) => <Option key={d.value} value={d.value}>{d.label}</Option>)}
          </Dropdown>
        </div>
        {uiKind !== 'databricks' && (
          <Button onClick={loadSources} disabled={loading}>{loading ? 'Loading…' : 'Refresh sources'}</Button>
        )}
        <Button appearance="primary" icon={<CloudAdd20Regular />} onClick={() => setShowDeploy((v) => !v)}>
          Deploy a new data source
        </Button>
      </div>

      {/* Honest gate: Synapse Serverless is NOT a deployable DAB source. */}
      {uiKind === 'synapse-serverless' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Synapse Serverless SQL is not supported by Data API builder</MessageBarTitle>
          Per Microsoft Learn, DAB&apos;s <code>dwsql</code> database-type supports the Synapse
          {' '}<strong>Dedicated</strong> SQL pool only — the Serverless (on-demand) pool isn&apos;t supported as a
          DAB source. You can still browse its objects below for exploration, but you can&apos;t publish an API from it.
          <br /><Caption1>
            Supported alternatives: use the <strong>Dedicated SQL pool</strong> (dwsql), or mirror the
            serverless-queried data into an Azure SQL Database / Dedicated pool and point DAB there. To run
            ad-hoc serverless queries, use the Synapse Serverless SQL editor directly.
          </Caption1>
        </MessageBarBody></MessageBar>
      )}

      {/* Honest gate: Databricks has NO DAB connector. */}
      {uiKind === 'databricks' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Databricks SQL Warehouse is not a Data API builder source</MessageBarTitle>
          Data API builder has no native Databricks connector. Its supported database-types are
          {' '}<code>mssql</code>, <code>dwsql</code> (Synapse Dedicated), <code>postgresql</code>,
          {' '}<code>mysql</code>, <code>cosmosdb_nosql</code>, and <code>cosmosdb_postgresql</code> — none of
          which speak the Databricks SQL (Spark Thrift / ODBC) protocol.
          <br /><Caption1>
            Supported alternatives: (1) mirror the Databricks Delta tables into an Azure SQL Database or a
            Synapse Dedicated SQL pool and point DAB at that, or (2) query the warehouse directly from Loom&apos;s
            Databricks SQL editor. Switch the kind above to mssql / dwsql to continue building a DAB API.
          </Caption1>
        </MessageBarBody></MessageBar>
      )}

      {gate && uiKind !== 'databricks' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Source discovery gated</MessageBarTitle>
          {gate.error} <br /><Caption1>Set <code>{gate.missing}</code>, or enter the server + database manually below.</Caption1>
        </MessageBarBody></MessageBar>
      )}

      {/* No discoverable source → offer to deploy one. */}
      {noSqlSourceFound && (
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>No data source discovered</MessageBarTitle>
          No {uiKind === 'mssql' ? 'Azure SQL' : 'Synapse SQL'} source was found.
          {' '}<Button size="small" appearance="transparent" icon={<CloudAdd20Regular />} onClick={() => setShowDeploy(true)}>Deploy a new data source</Button>
          {' '}or enter a server + database manually below.
        </MessageBarBody></MessageBar>
      )}

      {isSqlFamily && servers.length > 0 && (
        <div className={s.row}>
          <div className={s.field}>
            <Label>Server / endpoint</Label>
            <Dropdown placeholder="Select a server" value={cfg.sourceRef.server || ''} selectedOptions={cfg.sourceRef.server ? [cfg.sourceRef.server] : []}
              onOptionSelect={(_, d) => mutate((c) => { c.sourceRef.server = d.optionValue; c.sourceRef.database = undefined; return c; })}>
              {servers.map((sv) => <Option key={sv.server} value={sv.server} text={sv.server}>{sv.fqdn || sv.server}</Option>)}
            </Dropdown>
          </div>
          <div className={s.field}>
            <Label>Database{uiKind === 'synapse-dedicated' ? ' / pool' : ''}</Label>
            <Dropdown placeholder="Select a database" value={cfg.sourceRef.database || ''} selectedOptions={cfg.sourceRef.database ? [cfg.sourceRef.database] : []}
              disabled={!selServer || (selServer?.databases || []).length === 0}
              onOptionSelect={(_, d) => mutate((c) => { c.sourceRef.database = d.optionValue; return c; })}>
              {(selServer?.databases || []).map((db) => <Option key={db.name} value={db.name}>{db.name}</Option>)}
            </Dropdown>
          </div>
        </div>
      )}
      {selServer?.note && <Caption1>{selServer.note}</Caption1>}

      {showDeploy && <DeploySourcePanel cfg={cfg} mutate={mutate} onClose={() => setShowDeploy(false)} onDeployed={loadSources} />}

      {/* Manual entry — always available so the surface renders even when gated. */}
      {uiKind !== 'databricks' && (
        <div className={s.card}>
          <Caption1>Manual source entry (server FQDN + database)</Caption1>
          <div className={s.row}>
            <div className={s.field}>
              <Label>Server / account</Label>
              <Input value={cfg.sourceRef.server || ''} onChange={(_, d) => mutate((c) => { c.sourceRef.server = d.value || undefined; return c; })} placeholder={isSqlFamily ? 'myserver.database.windows.net' : 'myserver'} />
            </div>
            <div className={s.field}>
              <Label>Database</Label>
              <Input value={cfg.sourceRef.database || ''} onChange={(_, d) => mutate((c) => { c.sourceRef.database = d.value || undefined; return c; })} placeholder="mydb" />
            </div>
          </div>
          {uiKind === 'cosmosdb_nosql' && (
            <div className={s.field}>
              <Label>GraphQL schema (.gql) — required for Cosmos (schema-less)</Label>
              <Textarea value={cfg.sourceRef.graphqlSchema || ''} resize="vertical"
                onChange={(_, d) => mutate((c) => { c.sourceRef.graphqlSchema = d.value || undefined; return c; })}
                placeholder={'type Book @model {\n  id: ID!\n  title: String\n}'} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

// --- Deploy-a-new-source panel ----------------------------------------------

interface DeployStep { step: string; state: 'done' | 'gated' | 'error' | 'skipped'; detail: string; gate?: { missing: string } }

function DeploySourcePanel({ cfg, mutate, onClose, onDeployed }: {
  cfg: DabConfig; mutate: (fn: (c: DabConfig) => DabConfig) => void; onClose: () => void; onDeployed: () => void;
}) {
  const s = useStyles();
  const [target, setTarget] = useState<'sql' | 'postgresql' | 'cosmos'>('sql');
  const [name, setName] = useState('');
  const [adminGroupSid, setAdminGroupSid] = useState('');
  const [registerPurview, setRegisterPurview] = useState(true);
  const [registerUc, setRegisterUc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState<any>(null);
  const [result, setResult] = useState<{ ok: boolean; steps?: DeployStep[]; error?: string; remediation?: any; source?: any } | null>(null);

  useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/dab/deploy-source'); setCaps(await r.json()); } catch { /* non-fatal */ }
    })();
  }, []);

  const deploy = useCallback(async () => {
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/dab/deploy-source', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, name: name.trim(), adminGroupSid: adminGroupSid.trim() || undefined, registerPurview, registerUnityCatalog: registerUc }),
      });
      const j = await r.json();
      setResult(j);
      if (j.ok && j.source) {
        // Register the freshly-deployed source so it's usable as a DAB source.
        mutate((c) => { c.sourceRef = { kind: j.source.kind, server: j.source.server, database: j.source.database }; return c; });
        onDeployed();
      }
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [target, name, adminGroupSid, registerPurview, registerUc, mutate, onDeployed]);

  const sqlGate = caps?.capabilities?.sql?.gate;
  const purviewConfigured = caps?.registration?.purview?.configured;
  const ucConfigured = caps?.registration?.unityCatalog?.configured;

  return (
    <div className={s.card}>
      <div className={s.row} style={{ justifyContent: 'space-between' }}>
        <Caption1><ServerLink20Regular style={{ verticalAlign: 'middle' }} /> Deploy a new data source &amp; register it</Caption1>
        <Button size="small" appearance="subtle" onClick={onClose}>Close</Button>
      </div>
      <Body1>
        Provision a relational source and hand it to this DAB API. SQL Database is created in-product (real ARM);
        PostgreSQL and Cosmos provision through the deploy-planner bicep and surface the exact knob + command.
      </Body1>
      <div className={s.row}>
        <div className={s.field}>
          <Label>Source type</Label>
          <Dropdown value={target} selectedOptions={[target]} onOptionSelect={(_, d) => setTarget(d.optionValue as any)}>
            <Option value="sql">Azure SQL Database</Option>
            <Option value="postgresql">PostgreSQL Flexible Server</Option>
            <Option value="cosmos">Cosmos DB</Option>
          </Dropdown>
        </div>
        <div className={s.field}>
          <Label>New database / resource name</Label>
          <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="myapidb" />
        </div>
      </div>
      {target === 'sql' && (
        <>
          {sqlGate && (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>SQL deploy gated</MessageBarTitle>
              Needs <code>{sqlGate.missing}</code>.
            </MessageBarBody></MessageBar>
          )}
          <div className={s.field}>
            <Label>Optional admin group object id (Entra group to grant SQL admin)</Label>
            <Input value={adminGroupSid} onChange={(_, d) => setAdminGroupSid(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
            <Caption1>Leave blank to grant the deploying user ({caps?.deployer?.upn || 'you'}) as the server Entra admin.</Caption1>
          </div>
          <div className={s.pillRow}>
            <Checkbox label={`Register in Purview${purviewConfigured ? '' : ' (gated — not configured)'}`} checked={registerPurview} onChange={(_, d) => setRegisterPurview(d.checked === true)} />
            <Checkbox label={`Create Unity Catalog${ucConfigured ? '' : ' (gated — not configured)'}`} checked={registerUc} onChange={(_, d) => setRegisterUc(d.checked === true)} />
          </div>
        </>
      )}
      <div className={s.row}>
        <Button appearance="primary" icon={<CloudAdd20Regular />} onClick={deploy} disabled={busy || !name.trim()}>
          {busy ? 'Deploying…' : 'Deploy & register'}
        </Button>
        {busy && <Spinner size="tiny" />}
      </div>

      {result && !result.ok && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Deploy gated / failed</MessageBarTitle>
          {result.error}
          {result.remediation && (
            <Caption1>
              {result.remediation.message}
              {result.remediation.module && <><br />Module: <code>{result.remediation.module}</code></>}
              {result.remediation.command && <><br /><code>{result.remediation.command}</code></>}
            </Caption1>
          )}
        </MessageBarBody></MessageBar>
      )}
      {result?.ok && result.steps && (
        <div className={s.card}>
          <Caption1>Source created — registered as <code>{result.source?.database}</code> on <code>{result.source?.fqdn}</code> and selected as this API&apos;s source.</Caption1>
          {result.steps.map((st, i) => (
            <div key={i}>
              <Badge size="small" color={st.state === 'done' ? 'success' : st.state === 'error' ? 'danger' : st.state === 'gated' ? 'warning' : 'informative'}>{st.state}</Badge>
              {' '}<strong>{st.step}</strong> — {st.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Stage 2: Entities ------------------------------------------------------

type EntityTab = 'general' | 'rest' | 'graphql' | 'fields' | 'permissions' | 'relationships' | 'cache';

interface SchemaObjs {
  tables: { objectId: number; schema: string; name: string }[];
  views: { objectId: number; schema: string; name: string }[];
  procedures: { objectId: number; schema: string; name: string }[];
}

function EntitiesStage({ cfg, mutate, activeEntity, setActiveEntity }: {
  cfg: DabConfig; mutate: (fn: (c: DabConfig) => DabConfig) => void;
  activeEntity: string | null; setActiveEntity: (n: string | null) => void;
}) {
  const s = useStyles();
  const [schema, setSchema] = useState<SchemaObjs | null>(null);
  // The gate carries the structured SQL-login remediation (audit B3) so the
  // editor surfaces the exact "CREATE USER … FROM EXTERNAL PROVIDER" grant
  // (gate.remediation) and the missing knob (gate.missing) inline, instead of a
  // raw driver string.
  const [schemaGate, setSchemaGate] = useState<{ error: string; missing?: string; remediation?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [entityTab, setEntityTab] = useState<EntityTab>('general');

  const loadSchema = useCallback(async () => {
    const k = cfg.sourceRef.kind;
    const introspectable = k === 'mssql' || k === 'dwsql';
    if (!introspectable || !cfg.sourceRef.server || !cfg.sourceRef.database) {
      setSchemaGate({ error: 'Select an Azure SQL / Synapse (dwsql) server + database on the Data source stage to introspect tables/views/procedures.' });
      return;
    }
    setLoading(true); setSchemaGate(null);
    try {
      const r = await fetch(`/api/dab/sources/${k}/schema?server=${encodeURIComponent(cfg.sourceRef.server)}&database=${encodeURIComponent(cfg.sourceRef.database)}`);
      const j = await r.json();
      if (!j.ok) setSchemaGate({ error: j.error || `HTTP ${r.status}`, missing: j.gate?.missing, remediation: j.gate?.remediation });
      else setSchema({ tables: j.tables, views: j.views, procedures: j.procedures });
    } catch (e: any) { setSchemaGate({ error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [cfg.sourceRef]);

  useEffect(() => { loadSchema(); }, [loadSchema]);

  const addEntity = useCallback((obj: { schema: string; name: string }, type: DabSourceType) => {
    const entName = obj.name.replace(/[^A-Za-z0-9_]/g, '_');
    mutate((c) => {
      if (c.entities.some((e) => e.name === entName)) return c;
      const ent: DabEntity = {
        name: entName,
        source: { object: obj.schema === 'dbo' ? obj.name : `${obj.schema}.${obj.name}`, type },
        rest: { enabled: true, path: `/${entName.toLowerCase()}`, ...(type === 'stored-procedure' ? { methods: ['get', 'post'] } : {}) },
        graphql: { enabled: true, singular: entName, plural: `${entName}s`, ...(type === 'stored-procedure' ? { operation: 'mutation' as const } : {}) },
        permissions: [{ role: 'anonymous', actions: type === 'stored-procedure' ? [{ action: 'execute' }] : [{ action: 'read' }] }],
      };
      c.entities.push(ent);
      return c;
    });
    setActiveEntity(entName);
  }, [mutate, setActiveEntity]);

  const active = cfg.entities.find((e) => e.name === activeEntity) || null;

  return (
    <>
      <Subtitle2>Entities</Subtitle2>
      <Body1>Map database objects to REST + GraphQL entities. Each entity carries its own source, methods, fields, permissions, relationships, and cache.</Body1>

      <div className={s.row}>
        <Button onClick={loadSchema} disabled={loading}>{loading ? 'Introspecting…' : 'Refresh schema'}</Button>
        <Caption1>{cfg.entities.length} entit{cfg.entities.length === 1 ? 'y' : 'ies'} defined</Caption1>
      </div>

      {schemaGate && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Schema not introspected</MessageBarTitle>
          {schemaGate.error}
          {schemaGate.remediation && (
            <><br /><Caption1 style={{ display: 'block', marginTop: 4, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{schemaGate.remediation}</Caption1></>
          )}
          {schemaGate.missing && !schemaGate.remediation && (
            <><br /><Caption1>Set <code>{schemaGate.missing}</code>.</Caption1></>
          )}
        </MessageBarBody></MessageBar>
      )}

      {schema && (
        <div className={s.card}>
          <Caption1>Add from database (real sys.* introspection)</Caption1>
          <SchemaPickerGroup label="Tables" objs={schema.tables} onAdd={(o) => addEntity(o, 'table')} existing={cfg.entities} />
          <SchemaPickerGroup label="Views" objs={schema.views} onAdd={(o) => addEntity(o, 'view')} existing={cfg.entities} />
          <SchemaPickerGroup label="Stored procedures" objs={schema.procedures} onAdd={(o) => addEntity(o, 'stored-procedure')} existing={cfg.entities} />
        </div>
      )}

      <Divider />

      {/* Defined entities + editor */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: 12 }}>
        <div className={s.entityList}>
          {cfg.entities.length === 0 && <Caption1>No entities yet.</Caption1>}
          {cfg.entities.map((e) => (
            <div key={e.name} className={mergeClasses(s.entityRow, activeEntity === e.name && s.entityRowActive)}
              role="button" tabIndex={0} onClick={() => setActiveEntity(e.name)}
              onKeyDown={(ev) => { if (ev.key === 'Enter') setActiveEntity(e.name); }}>
              <span>{e.name}</span>
              <Tooltip content="Remove entity" relationship="label">
                <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Remove ${e.name}`}
                  onClick={(ev) => { ev.stopPropagation(); mutate((c) => { c.entities = c.entities.filter((x) => x.name !== e.name); return c; }); if (activeEntity === e.name) setActiveEntity(null); }} />
              </Tooltip>
            </div>
          ))}
        </div>

        <div>
          {!active && <Caption1>Select an entity to edit its REST, GraphQL, fields, permissions, relationships, and cache.</Caption1>}
          {active && (
            <>
              <div className={s.tabBar}>
                {(['general', 'rest', 'graphql', 'fields', 'permissions', 'relationships', 'cache'] as EntityTab[]).map((t) => (
                  <Button key={t} appearance="subtle" size="small"
                    className={mergeClasses(s.tabBtn, entityTab === t && s.tabBtnActive)}
                    onClick={() => setEntityTab(t)}>{t}</Button>
                ))}
              </div>
              <EntityDetail cfg={cfg} entity={active} tab={entityTab} mutate={mutate} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

function SchemaPickerGroup({ label, objs, onAdd, existing }: {
  label: string; objs: { objectId: number; schema: string; name: string }[];
  onAdd: (o: { objectId: number; schema: string; name: string }) => void; existing: DabEntity[];
}) {
  const s = useStyles();
  if (!objs || objs.length === 0) return null;
  return (
    <div>
      <Caption1>{label} ({objs.length})</Caption1>
      <div className={s.pillRow}>
        {objs.slice(0, 200).map((o) => {
          const ent = o.name.replace(/[^A-Za-z0-9_]/g, '_');
          const added = existing.some((e) => e.name === ent);
          return (
            <Button key={o.objectId} size="small" appearance={added ? 'subtle' : 'outline'} disabled={added}
              icon={<Add16Regular />} onClick={() => onAdd(o)}>
              {o.schema}.{o.name}{added ? ' ✓' : ''}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function EntityDetail({ cfg, entity, tab, mutate }: {
  cfg: DabConfig; entity: DabEntity; tab: EntityTab; mutate: (fn: (c: DabConfig) => DabConfig) => void;
}) {
  const s = useStyles();
  const [cols, setCols] = useState<{ name: string; dataType: string; isPrimaryKey: boolean }[] | null>(null);

  // Load columns lazily for fields/permissions tabs (mssql + dwsql tables/views).
  useEffect(() => {
    const k = cfg.sourceRef.kind;
    if ((tab !== 'fields' && tab !== 'permissions') || (k !== 'mssql' && k !== 'dwsql')) return;
    if (!cfg.sourceRef.server || !cfg.sourceRef.database) return;
    // Resolve objectId via schema endpoint is costly; instead re-introspect columns by object name match.
    (async () => {
      try {
        const sr = await fetch(`/api/dab/sources/${k}/schema?server=${encodeURIComponent(cfg.sourceRef.server!)}&database=${encodeURIComponent(cfg.sourceRef.database!)}`);
        const sj = await sr.json();
        if (!sj.ok) return;
        const all = [...(sj.tables || []), ...(sj.views || [])];
        const obj = entity.source.object.includes('.') ? entity.source.object : `dbo.${entity.source.object}`;
        const [schemaName, objName] = obj.split('.');
        const match = all.find((o: any) => o.schema === schemaName && o.name === objName);
        if (!match) return;
        const cr = await fetch(`/api/dab/sources/${k}/columns?server=${encodeURIComponent(cfg.sourceRef.server!)}&database=${encodeURIComponent(cfg.sourceRef.database!)}&objectId=${match.objectId}`);
        const cj = await cr.json();
        if (cj.ok) setCols(cj.columns);
      } catch { /* non-fatal */ }
    })();
  }, [tab, entity.source.object, cfg.sourceRef]);

  const setEntity = (fn: (e: DabEntity) => void) => mutate((c) => {
    const e = c.entities.find((x) => x.name === entity.name);
    if (e) fn(e);
    return c;
  });

  if (tab === 'general') {
    return (
      <div className={s.card}>
        <div className={s.field}>
          <Label>Source object (read-only)</Label>
          <Input value={entity.source.object} readOnly />
        </div>
        <div className={s.field}>
          <Label>Source type</Label>
          <Dropdown value={entity.source.type} selectedOptions={[entity.source.type]}
            onOptionSelect={(_, d) => setEntity((e) => { e.source.type = d.optionValue as DabSourceType; })}>
            {(['table', 'view', 'stored-procedure'] as DabSourceType[]).map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
        </div>
        <div className={s.field}>
          <Label>Description</Label>
          <Input value={entity.description || ''} onChange={(_, d) => setEntity((e) => { e.description = d.value || undefined; })} />
        </div>
      </div>
    );
  }

  if (tab === 'rest') {
    return (
      <div className={s.card}>
        <Switch checked={entity.rest.enabled} label="REST enabled"
          onChange={(_, d) => setEntity((e) => { e.rest.enabled = d.checked; })} />
        <div className={s.field}>
          <Label>REST path</Label>
          <Input value={entity.rest.path || ''} onChange={(_, d) => setEntity((e) => { e.rest.path = d.value; })} placeholder={`/${entity.name.toLowerCase()}`} />
        </div>
        {entity.source.type === 'stored-procedure' && (
          <div>
            <Label>Methods (stored-procedure only)</Label>
            <div className={s.pillRow}>
              {(['get', 'post', 'put', 'patch', 'delete'] as const).map((m) => (
                <Checkbox key={m} label={m.toUpperCase()} checked={entity.rest.methods?.includes(m) || false}
                  onChange={(_, d) => setEntity((e) => {
                    const set = new Set(e.rest.methods || []);
                    if (d.checked) set.add(m); else set.delete(m);
                    e.rest.methods = Array.from(set);
                  })} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (tab === 'graphql') {
    return (
      <div className={s.card}>
        <Switch checked={entity.graphql.enabled} label="GraphQL enabled"
          onChange={(_, d) => setEntity((e) => { e.graphql.enabled = d.checked; })} />
        <div className={s.row}>
          <div className={s.field}>
            <Label>Singular type</Label>
            <Input value={entity.graphql.singular || ''} onChange={(_, d) => setEntity((e) => { e.graphql.singular = d.value || undefined; })} />
          </div>
          <div className={s.field}>
            <Label>Plural type</Label>
            <Input value={entity.graphql.plural || ''} onChange={(_, d) => setEntity((e) => { e.graphql.plural = d.value || undefined; })} />
          </div>
        </div>
        {entity.source.type === 'stored-procedure' && (
          <div className={s.field}>
            <Label>Operation</Label>
            <Dropdown value={entity.graphql.operation || 'mutation'} selectedOptions={[entity.graphql.operation || 'mutation']}
              onOptionSelect={(_, d) => setEntity((e) => { e.graphql.operation = d.optionValue as 'query' | 'mutation'; })}>
              <Option value="query">query</Option><Option value="mutation">mutation</Option>
            </Dropdown>
          </div>
        )}
      </div>
    );
  }

  if (tab === 'fields') {
    return (
      <div className={s.card}>
        <Caption1>Column → exposed-field alias + primary-key designation (DAB 2.0 fields[]).</Caption1>
        {!cols && <Caption1>Loading columns… (requires an mssql source)</Caption1>}
        {cols && (
          <Table size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Column</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Alias</TableHeaderCell><TableHeaderCell>Primary key</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {cols.map((c) => {
                const f = (entity.fields || []).find((x) => x.name === c.name);
                return (
                  <TableRow key={c.name}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell><Caption1>{c.dataType}</Caption1></TableCell>
                    <TableCell>
                      <Input size="small" value={f?.alias || ''} placeholder="(none)"
                        onChange={(_, d) => setEntity((e) => upsertField(e, c.name, { alias: d.value || undefined }))} />
                    </TableCell>
                    <TableCell>
                      <Checkbox checked={f?.primaryKey ?? c.isPrimaryKey}
                        onChange={(_, d) => setEntity((e) => upsertField(e, c.name, { primaryKey: d.checked === true }))} />
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

  if (tab === 'permissions') {
    return <PermissionsTab entity={entity} cols={cols} setEntity={setEntity} />;
  }

  if (tab === 'relationships') {
    return <RelationshipsTab cfg={cfg} entity={entity} setEntity={setEntity} />;
  }

  // cache
  return (
    <div className={s.card}>
      <Switch checked={entity.cache?.enabled || false} label="Entity caching enabled"
        onChange={(_, d) => setEntity((e) => { e.cache = { ...(e.cache || {}), enabled: d.checked }; })} />
      {entity.cache?.enabled && (
        <div className={s.row}>
          <div className={s.field}>
            <Label>TTL seconds</Label>
            <Input type="number" value={String(entity.cache?.ttlSeconds ?? 5)}
              onChange={(_, d) => setEntity((e) => { e.cache = { enabled: true, ...e.cache, ttlSeconds: Number(d.value) }; })} />
          </div>
          <div className={s.field}>
            <Label>Level</Label>
            <Dropdown value={entity.cache?.level || 'L1L2'} selectedOptions={[entity.cache?.level || 'L1L2']}
              onOptionSelect={(_, d) => setEntity((e) => { e.cache = { enabled: true, ...e.cache, level: d.optionValue as 'L1' | 'L1L2' }; })}>
              <Option value="L1">L1</Option><Option value="L1L2">L1L2</Option>
            </Dropdown>
          </div>
        </div>
      )}
    </div>
  );
}

function upsertField(e: DabEntity, name: string, patch: Partial<DabField>) {
  e.fields = e.fields || [];
  const f = e.fields.find((x) => x.name === name);
  if (f) Object.assign(f, patch);
  else e.fields.push({ name, ...patch });
  // Drop empty field entries.
  e.fields = e.fields.filter((x) => x.alias || x.primaryKey || x.description);
}

function PermissionsTab({ entity, cols, setEntity }: {
  entity: DabEntity; cols: { name: string }[] | null; setEntity: (fn: (e: DabEntity) => void) => void;
}) {
  const s = useStyles();
  const isSp = entity.source.type === 'stored-procedure';
  return (
    <div className={s.card}>
      <Caption1>Per-role access. Anonymous = unauthenticated; Authenticated = any signed-in user; or a custom role (selected via the X-MS-API-ROLE header).</Caption1>
      {entity.permissions.map((perm, pi) => (
        <div key={pi} className={s.card}>
          <div className={s.row}>
            <div className={s.field}>
              <Label>Role</Label>
              <Input value={perm.role} onChange={(_, d) => setEntity((e) => { e.permissions[pi].role = d.value; })} placeholder="anonymous" />
            </div>
            <Button size="small" appearance="subtle" icon={<Delete16Regular />}
              onClick={() => setEntity((e) => { e.permissions = e.permissions.filter((_, k) => k !== pi); })}>Remove role</Button>
          </div>
          <div>
            <Label>Actions</Label>
            <div className={s.pillRow}>
              {(isSp ? (['execute'] as DabAction[]) : ALL_ACTIONS).map((a) => {
                const has = perm.actions.some((x) => x.action === a || x.action === '*');
                return (
                  <Checkbox key={a} label={a} checked={has}
                    onChange={(_, d) => setEntity((e) => {
                      const p = e.permissions[pi];
                      if (d.checked) { if (!p.actions.some((x) => x.action === a)) p.actions.push({ action: a }); }
                      else p.actions = p.actions.filter((x) => x.action !== a && x.action !== '*');
                    })} />
                );
              })}
            </div>
          </div>
          {!isSp && (
            <>
              <div className={s.field}>
                <Label>Field exclude (comma-separated — column-level security)</Label>
                <Input value={(perm.actions[0]?.fields?.exclude || []).join(', ')}
                  placeholder="ssn, salary"
                  onChange={(_, d) => setEntity((e) => {
                    const list = d.value.split(',').map((x) => x.trim()).filter(Boolean);
                    for (const a of e.permissions[pi].actions) a.fields = { ...(a.fields || {}), exclude: list.length ? list : undefined };
                  })} />
              </div>
              <div className={s.field}>
                <Label>Database policy (row-level — OData over @item.* / @claims.*)</Label>
                <Input value={perm.actions.find((a) => a.policyDatabase)?.policyDatabase || ''}
                  placeholder="@item.owner_id eq @claims.oid"
                  onChange={(_, d) => setEntity((e) => {
                    for (const a of e.permissions[pi].actions) {
                      if (a.action !== 'create') a.policyDatabase = d.value || undefined;
                    }
                  })} />
              </div>
            </>
          )}
        </div>
      ))}
      <Button size="small" icon={<Add16Regular />}
        onClick={() => setEntity((e) => { e.permissions.push({ role: 'authenticated', actions: [{ action: isSp ? 'execute' : 'read' }] }); })}>
        Add role
      </Button>
      {cols && cols.length > 0 && <Caption1>Columns available: {cols.map((c) => c.name).join(', ')}</Caption1>}
    </div>
  );
}

function RelationshipsTab({ cfg, entity, setEntity }: {
  cfg: DabConfig; entity: DabEntity; setEntity: (fn: (e: DabEntity) => void) => void;
}) {
  const s = useStyles();
  const others = cfg.entities.filter((e) => e.name !== entity.name);
  return (
    <div className={s.card}>
      <Caption1>Relationships surface as nested GraphQL fields. Pick a target entity, cardinality, and the join fields (and a linking object for many-to-many).</Caption1>
      {(entity.relationships || []).map((r, ri) => (
        <div key={ri} className={s.card}>
          <div className={s.row}>
            <div className={s.field}>
              <Label>Name</Label>
              <Input value={r.name} onChange={(_, d) => setEntity((e) => { e.relationships![ri].name = d.value; })} />
            </div>
            <div className={s.field}>
              <Label>Cardinality</Label>
              <Dropdown value={r.cardinality} selectedOptions={[r.cardinality]}
                onOptionSelect={(_, d) => setEntity((e) => { e.relationships![ri].cardinality = d.optionValue as 'one' | 'many'; })}>
                <Option value="one">one</Option><Option value="many">many</Option>
              </Dropdown>
            </div>
            <div className={s.field}>
              <Label>Target entity</Label>
              <Dropdown value={r.targetEntity} selectedOptions={r.targetEntity ? [r.targetEntity] : []}
                onOptionSelect={(_, d) => setEntity((e) => { e.relationships![ri].targetEntity = d.optionValue || ''; })}>
                {others.map((o) => <Option key={o.name} value={o.name}>{o.name}</Option>)}
              </Dropdown>
            </div>
            <Button size="small" appearance="subtle" icon={<Delete16Regular />}
              onClick={() => setEntity((e) => { e.relationships = (e.relationships || []).filter((_, k) => k !== ri); })}>Remove</Button>
          </div>
          <div className={s.row}>
            <div className={s.field}>
              <Label>Source fields (comma)</Label>
              <Input value={(r.sourceFields || []).join(', ')}
                onChange={(_, d) => setEntity((e) => { e.relationships![ri].sourceFields = csv(d.value); })} placeholder="id" />
            </div>
            <div className={s.field}>
              <Label>Target fields (comma)</Label>
              <Input value={(r.targetFields || []).join(', ')}
                onChange={(_, d) => setEntity((e) => { e.relationships![ri].targetFields = csv(d.value); })} placeholder="author_id" />
            </div>
          </div>
          <div className={s.row}>
            <div className={s.field}>
              <Label>Linking object (many-to-many)</Label>
              <Input value={r.linkingObject || ''}
                onChange={(_, d) => setEntity((e) => { e.relationships![ri].linkingObject = d.value || undefined; })} placeholder="dbo.book_author" />
            </div>
            {r.linkingObject && (
              <>
                <div className={s.field}>
                  <Label>Linking source fields</Label>
                  <Input value={(r.linkingSourceFields || []).join(', ')}
                    onChange={(_, d) => setEntity((e) => { e.relationships![ri].linkingSourceFields = csv(d.value); })} placeholder="book_id" />
                </div>
                <div className={s.field}>
                  <Label>Linking target fields</Label>
                  <Input value={(r.linkingTargetFields || []).join(', ')}
                    onChange={(_, d) => setEntity((e) => { e.relationships![ri].linkingTargetFields = csv(d.value); })} placeholder="author_id" />
                </div>
              </>
            )}
          </div>
        </div>
      ))}
      <Button size="small" icon={<Add16Regular />} disabled={others.length === 0}
        onClick={() => setEntity((e) => { e.relationships = [...(e.relationships || []), { name: `rel_${(e.relationships?.length || 0) + 1}`, cardinality: 'many', targetEntity: others[0]?.name || '' }]; })}>
        Add relationship
      </Button>
      {others.length === 0 && <Caption1>Define at least two entities to relate them.</Caption1>}
    </div>
  );
}

function csv(v: string): string[] { return v.split(',').map((x) => x.trim()).filter(Boolean); }

// --- Stage 3: Runtime & host ------------------------------------------------

function RuntimeStage({ cfg, mutate }: { cfg: DabConfig; mutate: (fn: (c: DabConfig) => DabConfig) => void }) {
  const s = useStyles();
  const rt = cfg.runtime;
  const setRt = (fn: (r: DabConfig['runtime']) => void) => mutate((c) => { fn(c.runtime); return c; });
  return (
    <>
      <Subtitle2>Runtime &amp; host</Subtitle2>
      <div className={s.card}>
        <Caption1>REST</Caption1>
        <Switch checked={rt.rest.enabled} label="REST enabled" onChange={(_, d) => setRt((r) => { r.rest.enabled = d.checked; })} />
        <div className={s.row}>
          <div className={s.field}><Label>Base path</Label><Input value={rt.rest.path} onChange={(_, d) => setRt((r) => { r.rest.path = d.value; })} /></div>
          <Switch checked={rt.rest.requestBodyStrict} label="request-body-strict" onChange={(_, d) => setRt((r) => { r.rest.requestBodyStrict = d.checked; })} />
        </div>
      </div>
      <div className={s.card}>
        <Caption1>GraphQL</Caption1>
        <Switch checked={rt.graphql.enabled} label="GraphQL enabled" onChange={(_, d) => setRt((r) => { r.graphql.enabled = d.checked; })} />
        <div className={s.row}>
          <div className={s.field}><Label>Base path</Label><Input value={rt.graphql.path} onChange={(_, d) => setRt((r) => { r.graphql.path = d.value; })} /></div>
          <Switch checked={rt.graphql.allowIntrospection} label="allow-introspection" onChange={(_, d) => setRt((r) => { r.graphql.allowIntrospection = d.checked; })} />
        </div>
      </div>
      <div className={s.card}>
        <Caption1>Host</Caption1>
        <div className={s.row}>
          <div className={s.field}>
            <Label>Mode</Label>
            <Dropdown value={rt.host.mode} selectedOptions={[rt.host.mode]} onOptionSelect={(_, d) => setRt((r) => { r.host.mode = d.optionValue as DabHostMode; })}>
              <Option value="development">development</Option><Option value="production">production</Option>
            </Dropdown>
          </div>
          <div className={s.field}>
            <Label>Auth provider</Label>
            <Dropdown value={rt.host.authProvider} selectedOptions={[rt.host.authProvider]} onOptionSelect={(_, d) => setRt((r) => { r.host.authProvider = d.optionValue as DabAuthProvider; })}>
              {AUTH_PROVIDERS.map((p) => <Option key={p} value={p}>{p}</Option>)}
            </Dropdown>
          </div>
        </div>
        {(rt.host.authProvider === 'EntraId' || rt.host.authProvider === 'Custom') && (
          <div className={s.row}>
            <div className={s.field}><Label>JWT audience</Label><Input value={rt.host.jwtAudience || ''} onChange={(_, d) => setRt((r) => { r.host.jwtAudience = d.value || undefined; })} placeholder="<app-id>" /></div>
            <div className={s.field}><Label>JWT issuer</Label><Input value={rt.host.jwtIssuer || ''} onChange={(_, d) => setRt((r) => { r.host.jwtIssuer = d.value || undefined; })} placeholder="https://login.microsoftonline.com/<tid>/v2.0" /></div>
          </div>
        )}
        <div className={s.field}>
          <Label>CORS origins (comma-separated)</Label>
          <Input value={rt.host.corsOrigins.join(', ')} onChange={(_, d) => setRt((r) => { r.host.corsOrigins = csv(d.value); })} placeholder="https://loom.example.com" />
        </div>
        <Switch checked={rt.host.corsAllowCredentials} label="CORS allow-credentials" onChange={(_, d) => setRt((r) => { r.host.corsAllowCredentials = d.checked; })} />
      </div>
      <div className={s.card}>
        <Caption1>Global cache &amp; pagination</Caption1>
        <Switch checked={rt.cache.enabled} label="Global cache enabled" onChange={(_, d) => setRt((r) => { r.cache.enabled = d.checked; })} />
        <div className={s.row}>
          <div className={s.field}><Label>Cache TTL seconds</Label><Input type="number" value={String(rt.cache.ttlSeconds)} onChange={(_, d) => setRt((r) => { r.cache.ttlSeconds = Number(d.value); })} /></div>
          <div className={s.field}><Label>Default page size</Label><Input type="number" value={String(rt.pagination.defaultPageSize)} onChange={(_, d) => setRt((r) => { r.pagination.defaultPageSize = Number(d.value); })} /></div>
          <div className={s.field}><Label>Max page size</Label><Input type="number" value={String(rt.pagination.maxPageSize)} onChange={(_, d) => setRt((r) => { r.pagination.maxPageSize = Number(d.value); })} /></div>
        </div>
      </div>
    </>
  );
}

// --- Stage 4: Preview & publish --------------------------------------------

function PreviewStage({ cfg, id }: { cfg: DabConfig; id: string }) {
  const s = useStyles();
  const [probe, setProbe] = useState<{ ok: boolean; gate?: { missing: string }; error?: string; baseUrl?: string; probe?: any } | null>(null);
  const [probing, setProbing] = useState(false);

  // REST tester state.
  const [restEntity, setRestEntity] = useState('');
  const [restRole, setRestRole] = useState('');
  const [restFilter, setRestFilter] = useState('');
  const [restResult, setRestResult] = useState<string | null>(null);
  // GraphQL tester state.
  const [gqlQuery, setGqlQuery] = useState('{\n  # write a query\n}');
  const [gqlResult, setGqlResult] = useState<string | null>(null);
  // Publish state.
  const [apiId, setApiId] = useState(`dab-${id.substring(0, 8)}`);
  const [apiPath, setApiPath] = useState(`dab/${id.substring(0, 8)}`);
  const [publishResult, setPublishResult] = useState<string | null>(null);

  const doProbe = useCallback(async () => {
    setProbing(true);
    try {
      const r = await fetch(`/api/dab/${encodeURIComponent(id)}/preview/probe`);
      const j = await r.json();
      setProbe(j);
    } catch (e: any) { setProbe({ ok: false, error: e?.message || String(e) }); }
    finally { setProbing(false); }
  }, [id]);

  useEffect(() => { doProbe(); }, [doProbe]);

  const entityOptions = cfg.entities.filter((e) => e.rest.enabled);
  const selEntity = cfg.entities.find((e) => e.name === restEntity);

  const runRest = useCallback(async () => {
    if (!selEntity) return;
    setRestResult('Running…');
    try {
      const r = await fetch(`/api/dab/${encodeURIComponent(id)}/preview/rest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          restBasePath: cfg.runtime.rest.path,
          entityPath: selEntity.rest.path || `/${selEntity.name.toLowerCase()}`,
          filter: restFilter || undefined, first: 10,
          role: restRole || undefined,
        }),
      });
      const j = await r.json();
      setRestResult(JSON.stringify(j, null, 2));
    } catch (e: any) { setRestResult(`Error: ${e?.message || e}`); }
  }, [selEntity, cfg.runtime.rest.path, restFilter, restRole, id]);

  const runGql = useCallback(async () => {
    setGqlResult('Running…');
    try {
      const r = await fetch(`/api/dab/${encodeURIComponent(id)}/preview/graphql`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graphqlPath: cfg.runtime.graphql.path, query: gqlQuery, role: restRole || undefined }),
      });
      const j = await r.json();
      setGqlResult(JSON.stringify(j, null, 2));
    } catch (e: any) { setGqlResult(`Error: ${e?.message || e}`); }
  }, [gqlQuery, cfg.runtime.graphql.path, restRole, id]);

  const publish = useCallback(async () => {
    setPublishResult('Publishing…');
    try {
      const r = await fetch(`/api/dab/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiId, path: apiPath, restBasePath: cfg.runtime.rest.path }),
      });
      const j = await r.json();
      setPublishResult(JSON.stringify(j, null, 2));
    } catch (e: any) { setPublishResult(`Error: ${e?.message || e}`); }
  }, [apiId, apiPath, cfg.runtime.rest.path, id]);

  const gated = probe && !probe.ok && probe.gate;

  return (
    <>
      <Subtitle2>Preview &amp; publish</Subtitle2>
      <div className={s.row}>
        <Button onClick={doProbe} disabled={probing}>{probing ? 'Probing…' : 'Probe runtime'}</Button>
        {probe?.ok && <Badge color="success">Runtime live{probe.baseUrl ? ` · ${probe.baseUrl}` : ''}</Badge>}
        {probe && !probe.ok && <Badge color="warning">Runtime unavailable</Badge>}
      </div>

      {gated && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>DAB runtime not provisioned</MessageBarTitle>
          {probe?.error || `Set ${probe?.gate?.missing}.`}<br />
          <Caption1>
            Set <code>{probe?.gate?.missing}</code> to the shared preview DAB Container App URL. It deploys
            from <code>platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep</code>. The full builder above still
            saves your config and emits the real dab-config.json regardless.
          </Caption1>
        </MessageBarBody></MessageBar>
      )}

      {/* REST tester — always rendered; calls real runtime when live. */}
      <div className={s.card}>
        <Caption1>REST tester (real GET against the runtime)</Caption1>
        <div className={s.row}>
          <div className={s.field}>
            <Label>Entity</Label>
            <Dropdown placeholder="Select entity" value={restEntity} selectedOptions={restEntity ? [restEntity] : []}
              onOptionSelect={(_, d) => setRestEntity(d.optionValue || '')}>
              {entityOptions.map((e) => <Option key={e.name} value={e.name}>{e.name}</Option>)}
            </Dropdown>
          </div>
          <div className={s.field}><Label>X-MS-API-ROLE</Label><Input value={restRole} onChange={(_, d) => setRestRole(d.value)} placeholder="anonymous" /></div>
          <div className={s.field}><Label>$filter</Label><Input value={restFilter} onChange={(_, d) => setRestFilter(d.value)} placeholder="id gt 1" /></div>
          <Button appearance="primary" icon={<Play20Regular />} onClick={runRest} disabled={!selEntity || !probe?.ok}>Send</Button>
        </div>
        {restResult && <pre className={s.mono}>{restResult}</pre>}
      </div>

      {/* GraphQL tester */}
      <div className={s.card}>
        <Caption1>GraphQL tester (real POST /graphql)</Caption1>
        <Textarea value={gqlQuery} resize="vertical" onChange={(_, d) => setGqlQuery(d.value)} />
        <div className={s.row}>
          <Button appearance="primary" icon={<Play20Regular />} onClick={runGql} disabled={!probe?.ok}>Run</Button>
        </div>
        {gqlResult && <pre className={s.mono}>{gqlResult}</pre>}
      </div>

      {/* Publish to APIM */}
      <div className={s.card}>
        <Caption1>Publish to APIM (imports the runtime&apos;s OpenAPI as a REST API)</Caption1>
        <div className={s.row}>
          <div className={s.field}><Label>API id</Label><Input value={apiId} onChange={(_, d) => setApiId(d.value)} /></div>
          <div className={s.field}><Label>API path</Label><Input value={apiPath} onChange={(_, d) => setApiPath(d.value)} /></div>
          <Button appearance="primary" icon={<CloudArrowUp20Regular />} onClick={publish} disabled={!probe?.ok}>Publish</Button>
        </div>
        {publishResult && <pre className={s.mono}>{publishResult}</pre>}
      </div>
    </>
  );
}

// --- Stage 5: dab-config.json preview ---------------------------------------

function ConfigStage({ cfg, id }: { cfg: DabConfig; id: string }) {
  const s = useStyles();
  const [json, setJson] = useState<string>('Loading…');
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/dab/${encodeURIComponent(id)}/validate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: cfg }),
        });
        const j = await r.json();
        setJson(j.json || JSON.stringify(j, null, 2));
      } catch (e: any) { setJson(`Error: ${e?.message || e}`); }
    })();
  }, [cfg, id]);
  return (
    <>
      <Subtitle2>dab-config.json</Subtitle2>
      <Body1>The canonical config DAB&apos;s engine consumes. The connection string is referenced via <code>@env()</code> — never embedded.</Body1>
      <pre className={s.mono}>{json}</pre>
    </>
  );
}

'use client';

/**
 * Catalog → Unity Catalog — the one-navigation home for the FULL Unity Catalog
 * capability set, cloud-aware:
 *
 *   - Commercial → Databricks Unity Catalog (all capabilities).
 *   - Azure Government → self-hosted OSS Unity Catalog (loom-unity) — every
 *     capability the OSS server implements (catalogs / schemas / tables /
 *     volumes / functions / models / grants / external locations / storage
 *     credentials / temporary credentials) works against the real backend;
 *     Databricks-only families render an honest per-cloud capability note
 *     naming the Loom-native equivalent, never a dead pane.
 *
 * Panes: Explore (object tree CRUD) · Grants (securable ACLs) · Storage
 * (external locations + credentials) · Sharing (Delta Sharing) · Capabilities
 * (the live support matrix from /api/catalog/unity/capabilities).
 *
 * Every control calls the real BFF → real UC REST per no-vaporware.md. The
 * backend switch is transparent: the same routes serve both backends
 * (lib/azure/uc-backend.ts). Fabric is never required (no-fabric-dependency).
 */

import { clientFetch } from '@/lib/client-fetch';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import {
  Badge, Body1, Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody,
  DialogContent, DialogSurface, DialogTitle, DialogTrigger, Dropdown, Field,
  Input, MessageBar, MessageBarBody, MessageBarTitle, Option, Spinner, Subtitle2,
  Tab, TabList, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, ArrowSync24Regular, Delete24Regular, Database24Regular,
  Key24Regular, LockClosed24Regular, Share24Regular, CloudArrowUp24Regular,
  CheckmarkCircle24Filled, DismissCircle24Regular, Warning24Regular,
} from '@fluentui/react-icons';

// ============================================================
// Types (BFF payload shapes)
// ============================================================

interface UcCapabilityRow {
  id: string; label: string; loomSurface: string; note?: string;
  databricks: 'full' | 'partial' | 'none'; oss: 'full' | 'partial' | 'none';
  supported: boolean; support: 'full' | 'partial' | 'none';
}
interface CapabilitiesPayload {
  ok: boolean; backend: 'databricks' | 'oss'; cloud: string; configured: boolean;
  gate?: { title: string; detail: string; envVar?: string; bicepModule?: string };
  capabilities: UcCapabilityRow[];
}
interface Catalog { name: string; comment?: string; owner?: string; catalog_type?: string; isolation_mode?: string; }
interface Schema { name: string; full_name?: string; catalog_name?: string; comment?: string; owner?: string; }
interface TableRow { name: string; full_name?: string; table_type?: string; data_source_format?: string; comment?: string; owner?: string; }
interface VolumeRow { name: string; full_name?: string; volume_type?: string; storage_location?: string; comment?: string; }
interface FunctionRow { name: string; full_name?: string; data_type?: string; full_data_type?: string; comment?: string; external_language?: string; }
interface ModelRow { name: string; full_name?: string; comment?: string; owner?: string; }
interface GrantRow { principal: string; privileges: string[]; }
interface ExtLocRow { name: string; url: string; credential_name?: string; read_only?: boolean; comment?: string; owner?: string; }
interface CredRow { name: string; comment?: string; owner?: string; read_only?: boolean; azure_managed_identity?: { access_connector_id?: string }; }
interface ShareRow { name: string; comment?: string; owner?: string; }

// Curated privilege sets per securable — the union both backends accept; the
// BFF normalizes spelling (underscores ↔ spaces) per backend.
const PRIVS_BY_SECURABLE: Record<string, string[]> = {
  METASTORE: ['CREATE_CATALOG', 'CREATE_EXTERNAL_LOCATION', 'CREATE_STORAGE_CREDENTIAL', 'CREATE_CONNECTION', 'CREATE_SHARE', 'CREATE_RECIPIENT', 'CREATE_PROVIDER'],
  CATALOG: ['USE_CATALOG', 'USE_SCHEMA', 'CREATE_SCHEMA', 'CREATE_TABLE', 'CREATE_FUNCTION', 'CREATE_VOLUME', 'CREATE_MODEL', 'SELECT', 'MODIFY', 'EXECUTE', 'READ_VOLUME', 'WRITE_VOLUME', 'BROWSE', 'MANAGE'],
  SCHEMA: ['USE_SCHEMA', 'CREATE_TABLE', 'CREATE_FUNCTION', 'CREATE_VOLUME', 'CREATE_MODEL', 'SELECT', 'MODIFY', 'EXECUTE', 'READ_VOLUME', 'WRITE_VOLUME', 'MANAGE'],
  TABLE: ['SELECT', 'MODIFY', 'MANAGE'],
  VOLUME: ['READ_VOLUME', 'WRITE_VOLUME', 'MANAGE'],
  FUNCTION: ['EXECUTE', 'MANAGE'],
  REGISTERED_MODEL: ['EXECUTE', 'MANAGE'],
  EXTERNAL_LOCATION: ['CREATE_EXTERNAL_TABLE', 'CREATE_EXTERNAL_VOLUME', 'READ_FILES', 'WRITE_FILES', 'CREATE_MANAGED_STORAGE', 'BROWSE', 'MANAGE'],
  STORAGE_CREDENTIAL: ['CREATE_EXTERNAL_LOCATION', 'CREATE_EXTERNAL_TABLE', 'READ_FILES', 'WRITE_FILES', 'MANAGE'],
};
// Databricks-only privileges hidden on the OSS backend (OSS UC 0.5 spec set).
const DBX_ONLY_PRIVS = new Set(['BROWSE', 'MANAGE', 'CREATE_CONNECTION', 'CREATE_SHARE', 'CREATE_RECIPIENT', 'CREATE_PROVIDER', 'CREATE_MANAGED_STORAGE']);

const useStyles = makeStyles({
  muted: { color: tokens.colorNeutralForeground3 },
  mutedBlock: { color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalM },
  cellStack: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  mb: { marginBottom: tokens.spacingVerticalM },
  mt: { marginTop: tokens.spacingVerticalM },
  spinner: { marginTop: tokens.spacingVerticalXXL },
  tabs: { marginBottom: tokens.spacingVerticalL },
  pickerRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) auto',
    gap: tokens.spacingHorizontalM, alignItems: 'end', marginBottom: tokens.spacingVerticalM,
  },
  grantsRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0,220px) minmax(0,1fr) auto auto',
    gap: tokens.spacingHorizontalM, alignItems: 'end', marginBottom: tokens.spacingVerticalM,
  },
  formGrid: {
    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
    gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS,
  },
  privGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalS,
  },
  sectionGap: { marginTop: tokens.spacingVerticalL },
  actionsRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  supportIconOk: { color: tokens.colorPaletteGreenForeground1 },
  supportIconWarn: { color: tokens.colorPaletteMarigoldForeground1 },
  supportIconNo: { color: tokens.colorNeutralForeground3 },
  footer: {
    display: 'flex', justifyContent: 'flex-end',
    marginTop: tokens.spacingVerticalL, paddingTop: tokens.spacingVerticalM,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

// ============================================================
// Small helpers
// ============================================================

function useJson<T = any>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gated, setGated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const run = useCallback(async (url: string, init?: RequestInit) => {
    setLoading(true); setError(null); setGated(null);
    try {
      const r = await clientFetch(url, init);
      const j = await r.json();
      if (!j.ok) {
        if (j.gated || j.code === 'not_configured') setGated(j.error || 'Not configured');
        else setError(j.error || `HTTP ${r.status}`);
        setData(null);
        return null;
      }
      setData(j); return j as T;
    } catch (e: any) { setError(e?.message || String(e)); setData(null); return null; }
    finally { setLoading(false); }
  }, []);
  return { data, error, gated, loading, run, setError };
}

function BackendBadge({ cap }: { cap: CapabilitiesPayload | null }) {
  if (!cap) return null;
  return cap.backend === 'oss'
    ? <Badge appearance="tint" color="brand">OSS Unity Catalog (loom-unity) · {cap.cloud}</Badge>
    : <Badge appearance="tint" color="success">Databricks Unity Catalog · {cap.cloud}</Badge>;
}

// ============================================================
// Page
// ============================================================

export default function UnityCatalogPage() {
  const s = useStyles();
  const [tab, setTab] = useState<'explore' | 'grants' | 'storage' | 'sharing' | 'capabilities'>('explore');
  const [cap, setCap] = useState<CapabilitiesPayload | null>(null);
  const [capError, setCapError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/catalog/unity/capabilities');
        const j = await r.json();
        if (j.ok) setCap(j); else setCapError(j.error || 'failed');
      } catch (e: any) { setCapError(e?.message || String(e)); }
    })();
  }, []);

  const oss = cap?.backend === 'oss';

  return (
    <CatalogShell
      sectionTitle="Unity Catalog"
      explainer={
        <>
          The full Unity Catalog capability set, cloud-aware. Commercial deployments govern through
          <strong> Databricks Unity Catalog</strong>; Azure Government deployments govern through the
          self-hosted <strong>OSS Unity Catalog</strong> server (<code>loom-unity</code>) — same REST
          surface, no Databricks or Fabric dependency. Browse and manage catalogs, schemas, tables,
          volumes, functions and models; grant privileges on any securable; manage external locations
          and storage credentials; and share data via Delta Sharing. Where a capability is
          backend-specific, an honest note names the Loom-native equivalent.
        </>
      }
    >
      {capError && (
        <MessageBar intent="error" className={s.mb}>
          <MessageBarBody><MessageBarTitle>Couldn&apos;t resolve the Unity Catalog backend</MessageBarTitle>{capError}</MessageBarBody>
        </MessageBar>
      )}
      {cap && !cap.configured && cap.gate && (
        <MessageBar intent="warning" className={s.mb}>
          <MessageBarBody>
            <MessageBarTitle>{cap.gate.title}</MessageBarTitle>
            {cap.gate.detail}
            {cap.gate.envVar && <> Env var: <code>{cap.gate.envVar}</code>.</>}
            {cap.gate.bicepModule && <> Bicep: <code>{cap.gate.bicepModule}</code>.</>}
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Governance backend"
        actions={<BackendBadge cap={cap} />}
      >
        <TileGrid>
          <ItemTile
            type="unity-catalog"
            title={oss ? 'OSS Unity Catalog' : 'Databricks Unity Catalog'}
            subtitle={oss ? 'Self-hosted loom-unity Container App — Azure-native, Gov-ready' : 'Metastore-governed catalogs across your workspaces'}
            meta={cap ? (cap.configured ? 'Connected' : 'Not configured') : 'Resolving…'}
            badge={cap?.configured
              ? <Badge appearance="tint" color="success">Live</Badge>
              : <Badge appearance="outline" color="warning">Setup needed</Badge>}
          />
          <ItemTile
            type="access-policy"
            title="Grants & privileges"
            subtitle="Securable ACLs on every object"
            meta="Catalogs · schemas · tables · volumes · functions · models · locations · credentials"
            badge={<Badge appearance="tint" color="brand">Both clouds</Badge>}
          />
          <ItemTile
            type="delta-share"
            title="Delta Sharing"
            subtitle={oss ? 'Loom Marketplace shares in Gov' : 'Shares, recipients & providers'}
            meta={oss ? 'OSS UC has no sharing server — Loom Marketplace covers it' : 'Bidirectional D2D + open sharing'}
            badge={oss
              ? <Badge appearance="outline" color="informative">Loom-native</Badge>
              : <Badge appearance="tint" color="success">Available</Badge>}
          />
        </TileGrid>
      </Section>

      <TabList
        className={s.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as typeof tab)}
      >
        <Tab value="explore" icon={<Database24Regular />}>Explore</Tab>
        <Tab value="grants" icon={<LockClosed24Regular />}>Grants</Tab>
        <Tab value="storage" icon={<CloudArrowUp24Regular />}>Storage</Tab>
        <Tab value="sharing" icon={<Share24Regular />}>Sharing</Tab>
        <Tab value="capabilities" icon={<Key24Regular />}>Capabilities</Tab>
      </TabList>

      {tab === 'explore' && <ExplorePane oss={oss} onGrant={(sec, name) => { setTab('grants'); window.dispatchEvent(new CustomEvent('uc-grant-seed', { detail: { securable: sec, fullName: name } })); }} />}
      {tab === 'grants' && <GrantsPane oss={oss} />}
      {tab === 'storage' && <StoragePane oss={oss} />}
      {tab === 'sharing' && <SharingPane oss={oss} />}
      {tab === 'capabilities' && <CapabilitiesPane cap={cap} />}
    </CatalogShell>
  );
}

// ============================================================
// Explore — catalogs → schemas → tables/volumes/functions/models
// ============================================================

function ExplorePane({ oss, onGrant }: { oss: boolean; onGrant: (securable: string, fullName: string) => void }) {
  const s = useStyles();
  const catalogsQ = useJson<{ catalogs: Catalog[] }>();
  const [catalog, setCatalog] = useState('');
  const [schema, setSchema] = useState('');
  const schemasQ = useJson<{ schemas: Schema[] }>();
  const objectsQ = useJson<{ tables: TableRow[]; volumes: VolumeRow[]; functions: FunctionRow[] }>();
  const modelsQ = useJson<{ models: ModelRow[] }>();
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const loadCatalogs = useCallback(() => { catalogsQ.run('/api/databricks/unity-catalog/catalogs'); }, [catalogsQ.run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadCatalogs(); }, [loadCatalogs]);
  useEffect(() => {
    setSchema('');
    if (catalog) schemasQ.run(`/api/databricks/unity-catalog/schemas?catalog=${encodeURIComponent(catalog)}`);
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (catalog && schema) {
      objectsQ.run(`/api/databricks/unity-catalog/tables?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`);
      modelsQ.run(`/api/databricks/unity-catalog/models?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`);
    }
  }, [catalog, schema]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshObjects = useCallback(() => {
    if (catalog && schema) {
      objectsQ.run(`/api/databricks/unity-catalog/tables?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`);
      modelsQ.run(`/api/databricks/unity-catalog/models?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`);
    }
  }, [catalog, schema]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(desc: string, url: string, init?: RequestInit, after?: () => void) {
    setActionErr(null); setActionOk(null);
    try {
      const r = await clientFetch(url, init);
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setActionOk(desc);
      after?.();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const fullOf = (name: string) => `${catalog}.${schema}.${name}`;

  const tableColumns: LoomColumn<TableRow>[] = [
    { key: 'name', label: 'Table', width: 260, filterType: 'text', getValue: (t) => t.name, render: (t) => (
      <div className={s.cellStack}><strong>{t.name}</strong>{t.comment && <Caption1 className={s.muted}>{t.comment}</Caption1>}</div>) },
    { key: 'type', label: 'Type', width: 140, filterType: 'select', filterOptions: ['MANAGED', 'EXTERNAL', 'VIEW', 'MATERIALIZED_VIEW', 'STREAMING_TABLE'], getValue: (t) => t.table_type || '—', render: (t) => (
      <Badge appearance="outline" color={t.table_type === 'VIEW' ? 'brand' : 'informative'}>{t.table_type || '—'}</Badge>) },
    { key: 'format', label: 'Format', width: 110, getValue: (t) => t.data_source_format || '—', render: (t) => t.data_source_format || '—' },
    { key: 'owner', label: 'Owner', width: 160, filterType: 'text', getValue: (t) => t.owner || '—', render: (t) => t.owner || '—' },
    { key: 'actions', label: '', width: 190, getValue: () => '', render: (t) => (
      <span className={s.actionsRow}>
        <Button size="small" appearance="secondary" icon={<LockClosed24Regular />} onClick={() => onGrant('TABLE', t.full_name || fullOf(t.name))}>Grants</Button>
        <Button size="small" appearance="subtle" icon={<Delete24Regular />} aria-label={`Drop table ${t.name}`}
          onClick={() => act(`Dropped table ${t.name}`, `/api/databricks/unity-catalog/tables?full_name=${encodeURIComponent(t.full_name || fullOf(t.name))}`, { method: 'DELETE' }, refreshObjects)} />
      </span>) },
  ];
  const volumeColumns: LoomColumn<VolumeRow>[] = [
    { key: 'name', label: 'Volume', width: 240, filterType: 'text', getValue: (v) => v.name, render: (v) => (
      <div className={s.cellStack}><strong>{v.name}</strong>{v.storage_location && <Caption1 className={s.muted}>{v.storage_location}</Caption1>}</div>) },
    { key: 'type', label: 'Type', width: 120, getValue: (v) => v.volume_type || '—', render: (v) => <Badge appearance="outline">{v.volume_type || '—'}</Badge> },
    { key: 'actions', label: '', width: 190, getValue: () => '', render: (v) => (
      <span className={s.actionsRow}>
        <Button size="small" appearance="secondary" icon={<LockClosed24Regular />} onClick={() => onGrant('VOLUME', v.full_name || fullOf(v.name))}>Grants</Button>
        <Button size="small" appearance="subtle" icon={<Delete24Regular />} aria-label={`Drop volume ${v.name}`}
          onClick={() => act(`Dropped volume ${v.name}`, `/api/databricks/unity-catalog/volumes?full_name=${encodeURIComponent(v.full_name || fullOf(v.name))}`, { method: 'DELETE' }, refreshObjects)} />
      </span>) },
  ];
  const functionColumns: LoomColumn<FunctionRow>[] = [
    { key: 'name', label: 'Function', width: 240, filterType: 'text', getValue: (f) => f.name, render: (f) => (
      <div className={s.cellStack}><strong>{f.name}</strong>{f.comment && <Caption1 className={s.muted}>{f.comment}</Caption1>}</div>) },
    { key: 'returns', label: 'Returns', width: 150, getValue: (f) => f.full_data_type || f.data_type || '—', render: (f) => f.full_data_type || f.data_type || '—' },
    { key: 'lang', label: 'Language', width: 110, getValue: (f) => f.external_language || 'SQL', render: (f) => f.external_language || 'SQL' },
    { key: 'actions', label: '', width: 190, getValue: () => '', render: (f) => (
      <span className={s.actionsRow}>
        <Button size="small" appearance="secondary" icon={<LockClosed24Regular />} onClick={() => onGrant('FUNCTION', f.full_name || fullOf(f.name))}>Grants</Button>
        <Button size="small" appearance="subtle" icon={<Delete24Regular />} aria-label={`Drop function ${f.name}`}
          onClick={() => act(`Dropped function ${f.name}`, `/api/databricks/unity-catalog/functions?full_name=${encodeURIComponent(f.full_name || fullOf(f.name))}`, { method: 'DELETE' }, refreshObjects)} />
      </span>) },
  ];
  const modelColumns: LoomColumn<ModelRow>[] = [
    { key: 'name', label: 'Model', width: 260, filterType: 'text', getValue: (m) => m.name, render: (m) => (
      <div className={s.cellStack}><strong>{m.name}</strong>{m.comment && <Caption1 className={s.muted}>{m.comment}</Caption1>}</div>) },
    { key: 'owner', label: 'Owner', width: 180, getValue: (m) => m.owner || '—', render: (m) => m.owner || '—' },
    { key: 'actions', label: '', width: 120, getValue: () => '', render: (m) => (
      <Button size="small" appearance="secondary" icon={<LockClosed24Regular />} onClick={() => onGrant('REGISTERED_MODEL', m.full_name || fullOf(m.name))}>Grants</Button>) },
  ];

  const catalogs = catalogsQ.data?.catalogs || [];
  const schemas = schemasQ.data?.schemas || [];

  return (
    <>
      {actionErr && <MessageBar intent="error" className={s.mb}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}
      {actionOk && <MessageBar intent="success" className={s.mb}><MessageBarBody>{actionOk}</MessageBarBody></MessageBar>}
      {catalogsQ.gated && (
        <MessageBar intent="warning" className={s.mb}>
          <MessageBarBody><MessageBarTitle>Unity Catalog not configured</MessageBarTitle>{catalogsQ.gated}</MessageBarBody>
        </MessageBar>
      )}
      {catalogsQ.error && <MessageBar intent="error" className={s.mb}><MessageBarBody>{catalogsQ.error}</MessageBarBody></MessageBar>}

      <Section
        title="Objects"
        actions={
          <span className={s.actionsRow}>
            <CreateCatalogDialog oss={oss} onCreated={loadCatalogs} />
            <CreateSchemaDialog catalog={catalog} onCreated={() => catalog && schemasQ.run(`/api/databricks/unity-catalog/schemas?catalog=${encodeURIComponent(catalog)}`)} />
            <CreateVolumeDialog catalog={catalog} schema={schema} onCreated={refreshObjects} />
            <Button size="small" icon={<ArrowSync24Regular />} onClick={() => { loadCatalogs(); refreshObjects(); }}>Refresh</Button>
          </span>
        }
      >
        <div className={s.pickerRow}>
          <Field label="Catalog" hint={catalogsQ.loading ? 'Loading…' : `${catalogs.length} catalog${catalogs.length === 1 ? '' : 's'}`}>
            <Dropdown
              placeholder={catalogs.length ? 'Select a catalog…' : 'No catalogs'}
              value={catalog}
              selectedOptions={catalog ? [catalog] : []}
              onOptionSelect={(_, d) => {
                // Reset the schema IN THE SAME batch as the catalog switch —
                // resetting it in the [catalog] effect leaves one render where
                // the objects effect sees (newCatalog, oldSchema) and fires a
                // listUcTables 404 (seen live: samples.default after finance).
                setCatalog(d.optionValue || '');
                setSchema('');
              }}
            >
              {catalogs.map((c) => (
                <Option key={c.name} value={c.name} text={c.name}>
                  <div className={s.cellStack}><strong>{c.name}</strong>{c.comment && <Caption1 className={s.muted}>{c.comment}</Caption1>}</div>
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Schema" hint={schemasQ.loading ? 'Loading…' : catalog ? `${schemas.length} schema${schemas.length === 1 ? '' : 's'}` : 'Pick a catalog first'}>
            <Dropdown
              placeholder={catalog ? (schemas.length ? 'Select a schema…' : 'No schemas') : 'Pick a catalog first'}
              disabled={!catalog}
              value={schema}
              selectedOptions={schema ? [schema] : []}
              onOptionSelect={(_, d) => setSchema(d.optionValue || '')}
            >
              {schemas.map((sc) => (
                <Option key={sc.name} value={sc.name} text={sc.name}>
                  <div className={s.cellStack}><strong>{sc.name}</strong>{sc.comment && <Caption1 className={s.muted}>{sc.comment}</Caption1>}</div>
                </Option>
              ))}
            </Dropdown>
          </Field>
          <span className={s.actionsRow}>
            {catalog && (
              <>
                <Button size="small" appearance="secondary" icon={<LockClosed24Regular />} onClick={() => onGrant('CATALOG', catalog)}>Catalog grants</Button>
                {schema && <Button size="small" appearance="secondary" icon={<LockClosed24Regular />} onClick={() => onGrant('SCHEMA', `${catalog}.${schema}`)}>Schema grants</Button>}
              </>
            )}
          </span>
        </div>

        {objectsQ.loading && <Spinner label="Loading objects…" />}
        {objectsQ.error && <MessageBar intent="error" className={s.mb}><MessageBarBody>{objectsQ.error}</MessageBarBody></MessageBar>}

        {catalog && schema && objectsQ.data && (
          <>
            <Subtitle2>Tables &amp; views</Subtitle2>
            <LoomDataTable<TableRow>
              ariaLabel="Unity Catalog tables"
              columns={tableColumns}
              rows={objectsQ.data.tables || []}
              getRowId={(t) => t.full_name || t.name}
              empty="No tables in this schema yet — create one from a lakehouse, notebook, or pipeline."
            />
            <div className={s.sectionGap} />
            <Subtitle2>Volumes</Subtitle2>
            <LoomDataTable<VolumeRow>
              ariaLabel="Unity Catalog volumes"
              columns={volumeColumns}
              rows={objectsQ.data.volumes || []}
              getRowId={(v) => v.full_name || v.name}
              empty="No volumes — create one with the New volume button above."
            />
            <div className={s.sectionGap} />
            <Subtitle2>Functions</Subtitle2>
            <LoomDataTable<FunctionRow>
              ariaLabel="Unity Catalog functions"
              columns={functionColumns}
              rows={objectsQ.data.functions || []}
              getRowId={(f) => f.full_name || f.name}
              empty="No functions — CREATE FUNCTION from a SQL editor or notebook registers them here."
            />
            <div className={s.sectionGap} />
            <Subtitle2>Registered models</Subtitle2>
            {modelsQ.gated ? (
              <MessageBar intent="info"><MessageBarBody>{modelsQ.gated}</MessageBarBody></MessageBar>
            ) : (
              <LoomDataTable<ModelRow>
                ariaLabel="Unity Catalog registered models"
                columns={modelColumns}
                rows={modelsQ.data?.models || []}
                getRowId={(m) => m.full_name || m.name}
                empty="No registered models in this schema."
              />
            )}
          </>
        )}
        {!(catalog && schema) && !catalogsQ.gated && (
          <Body1 className={s.muted}>Pick a catalog and schema to browse its tables, volumes, functions, and models.</Body1>
        )}
      </Section>
    </>
  );
}

// ---- Create dialogs (wizard-style forms, per loom_no_freeform_config) ----

function CreateCatalogDialog({ oss, onCreated }: { oss: boolean; onCreated: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [storageRoot, setStorageRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/catalogs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), comment: comment.trim() || undefined, storage_root: storageRoot.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setOpen(false); setName(''); setComment(''); setStorageRoot('');
      onCreated();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" appearance="primary" icon={<Add24Regular />}>New catalog</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create catalog</DialogTitle>
          <DialogContent>
            {err && <MessageBar intent="error" className={s.mb}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            <Field required label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="sales" /></Field>
            <Field label="Comment"><Input value={comment} onChange={(_, d) => setComment(d.value)} placeholder="Curated sales data" /></Field>
            <Field label="Storage root (optional)" hint={oss ? 'abfss://… or file:///… — defaults to the metastore root' : 'abfss://… — defaults to the metastore root'}>
              <Input value={storageRoot} onChange={(_, d) => setStorageRoot(d.value)} placeholder="abfss://container@account.dfs.core.windows.net/sales" />
            </Field>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
            <Button appearance="primary" disabled={busy || !name.trim()} onClick={create}>{busy ? 'Creating…' : 'Create'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function CreateSchemaDialog({ catalog, onCreated }: { catalog: string; onCreated: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/schemas', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), catalog_name: catalog, comment: comment.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setOpen(false); setName(''); setComment('');
      onCreated();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" appearance="secondary" icon={<Add24Regular />} disabled={!catalog}>New schema</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create schema in {catalog}</DialogTitle>
          <DialogContent>
            {err && <MessageBar intent="error" className={s.mb}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            <Field required label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="bronze" /></Field>
            <Field label="Comment"><Input value={comment} onChange={(_, d) => setComment(d.value)} placeholder="Raw landing zone" /></Field>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
            <Button appearance="primary" disabled={busy || !name.trim()} onClick={create}>{busy ? 'Creating…' : 'Create'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function CreateVolumeDialog({ catalog, schema, onCreated }: { catalog: string; schema: string; onCreated: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [volType, setVolType] = useState<'MANAGED' | 'EXTERNAL'>('MANAGED');
  const [storage, setStorage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/volumes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), catalog_name: catalog, schema_name: schema, volume_type: volType,
          storage_location: volType === 'EXTERNAL' ? storage.trim() : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setOpen(false); setName(''); setStorage('');
      onCreated();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" appearance="secondary" icon={<Add24Regular />} disabled={!catalog || !schema}>New volume</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create volume in {catalog}.{schema}</DialogTitle>
          <DialogContent>
            {err && <MessageBar intent="error" className={s.mb}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            <Field required label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="raw_files" /></Field>
            <Field label="Type">
              <Dropdown value={volType} selectedOptions={[volType]} onOptionSelect={(_, d) => setVolType((d.optionValue as 'MANAGED' | 'EXTERNAL') || 'MANAGED')}>
                <Option value="MANAGED" text="MANAGED">MANAGED — Unity Catalog manages the storage</Option>
                <Option value="EXTERNAL" text="EXTERNAL">EXTERNAL — bring your own abfss:// path</Option>
              </Dropdown>
            </Field>
            {volType === 'EXTERNAL' && (
              <Field required label="Storage location">
                <Input value={storage} onChange={(_, d) => setStorage(d.value)} placeholder="abfss://container@account.dfs.core.windows.net/path" />
              </Field>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
            <Button appearance="primary" disabled={busy || !name.trim() || (volType === 'EXTERNAL' && !storage.trim())} onClick={create}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Grants — securable ACLs (both backends)
// ============================================================

function GrantsPane({ oss }: { oss: boolean }) {
  const s = useStyles();
  const [securable, setSecurable] = useState('CATALOG');
  const [fullName, setFullName] = useState('');
  const [effective, setEffective] = useState(false);
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gated, setGated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [principal, setPrincipal] = useState('');
  const [privs, setPrivs] = useState<Set<string>>(new Set());

  // Seed from the Explore pane's "Grants" buttons.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { securable: string; fullName: string };
      if (d?.securable) setSecurable(d.securable);
      if (d?.fullName) setFullName(d.fullName);
    };
    window.addEventListener('uc-grant-seed', h);
    return () => window.removeEventListener('uc-grant-seed', h);
  }, []);

  const privileges = useMemo(
    () => (PRIVS_BY_SECURABLE[securable] || []).filter((p) => !oss || !DBX_ONLY_PRIVS.has(p)),
    [securable, oss],
  );

  const load = useCallback(async () => {
    if (!fullName.trim() && securable !== 'METASTORE') { setErr('Enter the securable full name (e.g. main.sales or main.sales.orders).'); return; }
    setBusy(true); setErr(null); setGated(null); setNote(null);
    try {
      const p = new URLSearchParams({ securable_type: securable, full_name: fullName.trim() });
      if (effective) p.set('effective', 'true');
      const r = await clientFetch(`/api/databricks/unity-catalog/grants?${p.toString()}`);
      const j = await r.json();
      if (!j.ok) {
        if (j.code === 'not_configured') setGated(j.error);
        else setErr(j.error || `HTTP ${r.status}`);
        setGrants(null); return;
      }
      setGrants(j.grants || []);
      if (j.note) setNote(j.note);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [securable, fullName, effective]);

  const apply = useCallback(async (mode: 'add' | 'remove', principalOverride?: string, privsOverride?: string[]) => {
    const prin = (principalOverride ?? principal).trim();
    const list = privsOverride ?? [...privs];
    if (!prin || list.length === 0) { setErr('Pick a principal and at least one privilege.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/grants', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          securable_type: securable, full_name: fullName.trim(),
          changes: [mode === 'add' ? { principal: prin, add: list } : { principal: prin, remove: list }],
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setGrants(j.grants || []);
      setPrivs(new Set());
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [securable, fullName, principal, privs]);

  const grantColumns: LoomColumn<GrantRow>[] = [
    { key: 'principal', label: 'Principal', width: 280, filterType: 'text', getValue: (g) => g.principal, render: (g) => <strong>{g.principal}</strong> },
    { key: 'privileges', label: 'Privileges', filterType: 'text', getValue: (g) => g.privileges.join(' '), render: (g) => (
      <span className={s.actionsRow}>{g.privileges.map((p) => <Badge key={p} appearance="tint" color={p.includes('inherited') ? 'informative' : 'brand'}>{p}</Badge>)}</span>) },
    { key: 'actions', label: '', width: 130, getValue: () => '', render: (g) => (
      <Button size="small" appearance="subtle" icon={<Delete24Regular />}
        disabled={effective}
        onClick={() => apply('remove', g.principal, g.privileges.filter((p) => !p.includes('inherited')))}>
        Revoke all
      </Button>) },
  ];

  return (
    <Section title="Grants & privileges" actions={oss
      ? <Badge appearance="tint" color="brand">OSS permissions API</Badge>
      : <Badge appearance="tint" color="success">Databricks grants API</Badge>}
    >
      <Body1 className={s.mutedBlock}>
        Grant and revoke privileges on any Unity Catalog securable. Both backends implement the same
        <code> /permissions/&#123;securable&#125;/&#123;name&#125;</code> REST surface
        {oss ? ' — the OSS server enforces them when its authorization mode is enabled.' : '.'}
      </Body1>
      {gated && <MessageBar intent="warning" className={s.mb}><MessageBarBody>{gated}</MessageBarBody></MessageBar>}
      {err && <MessageBar intent="error" className={s.mb}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {note && <MessageBar intent="info" className={s.mb}><MessageBarBody>{note}</MessageBarBody></MessageBar>}

      <div className={s.grantsRow}>
        <Field label="Securable type">
          <Dropdown value={securable} selectedOptions={[securable]} onOptionSelect={(_, d) => { setSecurable(d.optionValue || 'CATALOG'); setPrivs(new Set()); }}>
            {Object.keys(PRIVS_BY_SECURABLE).map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Full name" hint={securable === 'METASTORE' ? 'Not needed for the metastore' : 'e.g. main, main.sales, main.sales.orders'}>
          <Input value={fullName} onChange={(_, d) => setFullName(d.value)} placeholder="catalog[.schema[.object]]" disabled={securable === 'METASTORE'} />
        </Field>
        <Checkbox
          label="Effective (inherited)"
          checked={effective}
          disabled={oss}
          onChange={(_, d) => setEffective(!!d.checked)}
        />
        <Button appearance="primary" disabled={busy} onClick={load}>{busy ? 'Loading…' : 'Load grants'}</Button>
      </div>
      {oss && <Caption1 className={s.mutedBlock}>Effective (inherited) permission expansion is Databricks-only — the OSS backend shows the direct grants.</Caption1>}

      {grants && (
        <LoomDataTable<GrantRow>
          ariaLabel="Unity Catalog grants"
          columns={grantColumns}
          rows={grants}
          getRowId={(g) => g.principal}
          empty="No grants on this securable yet — add one below."
        />
      )}

      <div className={s.sectionGap} />
      <Subtitle2>Grant / revoke</Subtitle2>
      <div className={s.formGrid}>
        <Field label="Principal" hint="A user (UPN), group name, or service principal application id">
          <Input value={principal} onChange={(_, d) => setPrincipal(d.value)} placeholder="data-engineers or user@contoso.com" />
        </Field>
      </div>
      <div className={s.privGrid}>
        {privileges.map((p) => (
          <Checkbox
            key={p}
            label={p.replace(/_/g, ' ')}
            checked={privs.has(p)}
            onChange={() => setPrivs((old) => { const n = new Set(old); if (n.has(p)) n.delete(p); else n.add(p); return n; })}
          />
        ))}
      </div>
      <span className={s.actionsRow}>
        <Button appearance="primary" icon={<Add24Regular />} disabled={busy || !principal.trim() || privs.size === 0} onClick={() => apply('add')}>Grant</Button>
        <Button appearance="secondary" icon={<Delete24Regular />} disabled={busy || !principal.trim() || privs.size === 0} onClick={() => apply('remove')}>Revoke</Button>
      </span>
    </Section>
  );
}

// ============================================================
// Storage — external locations + storage credentials
// ============================================================

function StoragePane({ oss }: { oss: boolean }) {
  const s = useStyles();
  const locQ = useJson<{ externalLocations: ExtLocRow[] }>();
  const credQ = useJson<{ storageCredentials: CredRow[] }>();
  const [actionErr, setActionErr] = useState<string | null>(null);

  const loadAll = useCallback(() => {
    locQ.run('/api/databricks/unity-catalog/external-locations');
    credQ.run('/api/databricks/unity-catalog/storage-credentials');
  }, [locQ.run, credQ.run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadAll(); }, [loadAll]);

  async function del(url: string) {
    setActionErr(null);
    try {
      const r = await clientFetch(url, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      loadAll();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const locColumns: LoomColumn<ExtLocRow>[] = [
    { key: 'name', label: 'External location', width: 220, filterType: 'text', getValue: (l) => l.name, render: (l) => (
      <div className={s.cellStack}><strong>{l.name}</strong>{l.comment && <Caption1 className={s.muted}>{l.comment}</Caption1>}</div>) },
    { key: 'url', label: 'URL', filterType: 'text', getValue: (l) => l.url, render: (l) => <code>{l.url}</code> },
    { key: 'credential', label: 'Credential', width: 180, getValue: (l) => l.credential_name || '—', render: (l) => l.credential_name || '—' },
    { key: 'mode', label: 'Mode', width: 110, getValue: (l) => (l.read_only ? 'Read-only' : 'Read/write'), render: (l) => (
      <Badge appearance="outline" color={l.read_only ? 'warning' : 'success'}>{l.read_only ? 'Read-only' : 'Read/write'}</Badge>) },
    { key: 'actions', label: '', width: 80, getValue: () => '', render: (l) => (
      <Button size="small" appearance="subtle" icon={<Delete24Regular />} aria-label={`Delete external location ${l.name}`}
        onClick={() => del(`/api/databricks/unity-catalog/external-locations?name=${encodeURIComponent(l.name)}`)} />) },
  ];
  const credColumns: LoomColumn<CredRow>[] = [
    { key: 'name', label: 'Storage credential', width: 220, filterType: 'text', getValue: (c) => c.name, render: (c) => (
      <div className={s.cellStack}><strong>{c.name}</strong>{c.comment && <Caption1 className={s.muted}>{c.comment}</Caption1>}</div>) },
    { key: 'identity', label: 'Identity', filterType: 'text', getValue: (c) => c.azure_managed_identity?.access_connector_id || '—', render: (c) => (
      <Caption1 className={s.muted}>{c.azure_managed_identity?.access_connector_id || '—'}</Caption1>) },
    { key: 'owner', label: 'Owner', width: 160, getValue: (c) => c.owner || '—', render: (c) => c.owner || '—' },
    { key: 'actions', label: '', width: 80, getValue: () => '', render: (c) => (
      <Button size="small" appearance="subtle" icon={<Delete24Regular />} aria-label={`Delete storage credential ${c.name}`}
        onClick={() => del(`/api/databricks/unity-catalog/storage-credentials?name=${encodeURIComponent(c.name)}`)} />) },
  ];

  return (
    <>
      {actionErr && <MessageBar intent="error" className={s.mb}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}
      <Section
        title="External locations"
        actions={
          <span className={s.actionsRow}>
            <CreateExternalLocationDialog credentials={credQ.data?.storageCredentials || []} onCreated={loadAll} />
            <Button size="small" icon={<ArrowSync24Regular />} onClick={loadAll}>Refresh</Button>
          </span>
        }
      >
        <Body1 className={s.mutedBlock}>
          An external location pairs an <code>abfss://</code> path with a storage credential so Unity
          Catalog can govern external tables and volumes there.
        </Body1>
        {locQ.gated ? (
          <MessageBar intent="warning"><MessageBarBody>{locQ.gated}</MessageBarBody></MessageBar>
        ) : locQ.error ? (
          <MessageBar intent="error"><MessageBarBody>{locQ.error}</MessageBarBody></MessageBar>
        ) : locQ.loading ? <Spinner label="Loading…" /> : (
          <LoomDataTable<ExtLocRow>
            ariaLabel="Unity Catalog external locations"
            columns={locColumns}
            rows={locQ.data?.externalLocations || []}
            getRowId={(l) => l.name}
            empty="No external locations yet — create one with a storage credential."
          />
        )}
      </Section>

      <Section
        title="Storage credentials"
        actions={<CreateStorageCredentialDialog oss={oss} onCreated={loadAll} />}
      >
        <Body1 className={s.mutedBlock}>
          {oss
            ? 'On the OSS backend these are Unity Catalog "credentials" (purpose STORAGE) served by loom-unity — same surface, Loom rewrites the path transparently.'
            : 'Azure-native only: each credential wraps a Databricks Access Connector managed identity — no secrets cross this surface.'}
        </Body1>
        {credQ.gated ? (
          <MessageBar intent="warning"><MessageBarBody>{credQ.gated}</MessageBarBody></MessageBar>
        ) : credQ.error ? (
          <MessageBar intent="error"><MessageBarBody>{credQ.error}</MessageBarBody></MessageBar>
        ) : credQ.loading ? <Spinner label="Loading…" /> : (
          <LoomDataTable<CredRow>
            ariaLabel="Unity Catalog storage credentials"
            columns={credColumns}
            rows={credQ.data?.storageCredentials || []}
            getRowId={(c) => c.name}
            empty="No storage credentials yet."
          />
        )}
      </Section>
    </>
  );
}

function CreateExternalLocationDialog({ credentials, onCreated }: { credentials: CredRow[]; onCreated: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/external-locations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), credential_name: credential.trim(), read_only: readOnly, skip_validation: true }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setOpen(false); setName(''); setUrl(''); setCredential('');
      onCreated();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" appearance="primary" icon={<Add24Regular />}>New external location</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create external location</DialogTitle>
          <DialogContent>
            {err && <MessageBar intent="error" className={s.mb}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            <Field required label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="lake_bronze" /></Field>
            <Field required label="URL"><Input value={url} onChange={(_, d) => setUrl(d.value)} placeholder="abfss://bronze@account.dfs.core.windows.net/" /></Field>
            <Field required label="Storage credential" hint={credentials.length ? undefined : 'Create a storage credential first'}>
              <Dropdown
                placeholder={credentials.length ? 'Select…' : 'No credentials yet'}
                value={credential}
                selectedOptions={credential ? [credential] : []}
                onOptionSelect={(_, d) => setCredential(d.optionValue || '')}
              >
                {credentials.map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>)}
              </Dropdown>
            </Field>
            <Checkbox label="Read-only" checked={readOnly} onChange={(_, d) => setReadOnly(!!d.checked)} />
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
            <Button appearance="primary" disabled={busy || !name.trim() || !url.trim() || !credential.trim()} onClick={create}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function CreateStorageCredentialDialog({ oss, onCreated }: { oss: boolean; onCreated: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [connector, setConnector] = useState('');
  const [mi, setMi] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/storage-credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), access_connector_id: connector.trim(),
          managed_identity_id: mi.trim() || undefined, comment: comment.trim() || undefined, skip_validation: true,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setOpen(false); setName(''); setConnector(''); setMi(''); setComment('');
      onCreated();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" appearance="primary" icon={<Add24Regular />}>New storage credential</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create storage credential</DialogTitle>
          <DialogContent>
            {err && <MessageBar intent="error" className={s.mb}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            <Field required label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="lake_mi" /></Field>
            <Field required label={oss ? 'Managed identity / connector resource id' : 'Access Connector ARM id'}
              hint={oss ? 'The identity loom-unity vends credentials for' : '/subscriptions/…/providers/Microsoft.Databricks/accessConnectors/…'}>
              <Input value={connector} onChange={(_, d) => setConnector(d.value)} placeholder="/subscriptions/…/accessConnectors/lake-connector" />
            </Field>
            <Field label="User-assigned MI id (optional)" hint="Omit for the connector's system-assigned identity">
              <Input value={mi} onChange={(_, d) => setMi(d.value)} placeholder="/subscriptions/…/userAssignedIdentities/…" />
            </Field>
            <Field label="Comment"><Input value={comment} onChange={(_, d) => setComment(d.value)} /></Field>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
            <Button appearance="primary" disabled={busy || !name.trim() || !connector.trim()} onClick={create}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Sharing — Delta Sharing (Databricks) / Loom Marketplace (OSS)
// ============================================================

function SharingPane({ oss }: { oss: boolean }) {
  const s = useStyles();
  const sharesQ = useJson<{ shares?: ShareRow[] }>();
  useEffect(() => {
    if (!oss) sharesQ.run('/api/marketplace/sharing/shares');
  }, [oss]); // eslint-disable-line react-hooks/exhaustive-deps

  const shareColumns: LoomColumn<ShareRow>[] = [
    { key: 'name', label: 'Share', width: 260, filterType: 'text', getValue: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
    { key: 'comment', label: 'Comment', getValue: (r) => r.comment || '—', render: (r) => r.comment || '—' },
    { key: 'owner', label: 'Owner', width: 180, getValue: (r) => r.owner || '—', render: (r) => r.owner || '—' },
  ];

  return (
    <Section
      title="Delta Sharing"
      actions={
        <Link href="/marketplace" passHref legacyBehavior>
          <Button as="a" size="small" appearance="primary" icon={<Share24Regular />}>Open Marketplace share explorer</Button>
        </Link>
      }
    >
      {oss ? (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Delta Sharing runs through Loom Marketplace on this backend</MessageBarTitle>
            The OSS Unity Catalog server (0.5) does not implement the Delta Sharing server
            (shares / recipients / providers). In Azure Government, Loom Marketplace provides the
            equivalent capability — publish data products, grant subscriber access, and consume
            shared data — without a Databricks dependency. Full share management is in the
            Marketplace share explorer.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <>
          <Body1 className={s.mutedBlock}>
            Outbound shares on the Unity Catalog metastore. Recipients, providers, inbound mounts, and
            share contents are managed in the Marketplace share explorer — this is the catalog-side view.
          </Body1>
          {sharesQ.gated && <MessageBar intent="warning" className={s.mb}><MessageBarBody>{sharesQ.gated}</MessageBarBody></MessageBar>}
          {sharesQ.error && <MessageBar intent="error" className={s.mb}><MessageBarBody>{sharesQ.error}</MessageBarBody></MessageBar>}
          {sharesQ.loading ? <Spinner label="Loading shares…" /> : !sharesQ.gated && !sharesQ.error && (
            <LoomDataTable<ShareRow>
              ariaLabel="Delta shares"
              columns={shareColumns}
              rows={sharesQ.data?.shares || []}
              getRowId={(r) => r.name}
              empty="No shares yet — create one in the Marketplace share explorer."
            />
          )}
        </>
      )}
    </Section>
  );
}

// ============================================================
// Capabilities — the live support matrix
// ============================================================

function CapabilitiesPane({ cap }: { cap: CapabilitiesPayload | null }) {
  const s = useStyles();
  if (!cap) return <Spinner label="Resolving backend…" className={s.spinner} />;

  const icon = (v: 'full' | 'partial' | 'none') =>
    v === 'full' ? <CheckmarkCircle24Filled className={s.supportIconOk} />
      : v === 'partial' ? <Warning24Regular className={s.supportIconWarn} />
      : <DismissCircle24Regular className={s.supportIconNo} />;

  const columns: LoomColumn<UcCapabilityRow>[] = [
    { key: 'label', label: 'Capability', width: 280, filterType: 'text', getValue: (c) => c.label, render: (c) => (
      <div className={s.cellStack}><strong>{c.label}</strong><Caption1 className={s.muted}>{c.loomSurface}</Caption1></div>) },
    { key: 'databricks', label: 'Databricks UC', width: 130, filterType: 'select', filterOptions: ['full', 'partial', 'none'], getValue: (c) => c.databricks, render: (c) => icon(c.databricks) },
    { key: 'oss', label: 'OSS UC (Gov)', width: 130, filterType: 'select', filterOptions: ['full', 'partial', 'none'], getValue: (c) => c.oss, render: (c) => icon(c.oss) },
    { key: 'active', label: 'This deployment', width: 140, getValue: (c) => c.support, render: (c) => (
      c.support === 'none'
        ? <Badge appearance="outline" color="informative">Loom-native fallback</Badge>
        : c.support === 'partial'
          ? <Badge appearance="tint" color="warning">Partial</Badge>
          : <Badge appearance="tint" color="success">Wired</Badge>) },
    { key: 'note', label: 'Notes', getValue: (c) => c.note || '', render: (c) => <Caption1 className={s.muted}>{c.note || '—'}</Caption1> },
  ];

  return (
    <Section
      title="Capability matrix"
      actions={<BackendBadge cap={cap} />}
    >
      <Body1 className={s.mutedBlock}>
        Live per-backend support for the full Unity Catalog capability set. This deployment uses the
        <strong> {cap.backend === 'oss' ? 'OSS Unity Catalog (loom-unity)' : 'Databricks Unity Catalog'}</strong> backend
        in <strong>{cap.cloud}</strong>. Where the active backend lacks a capability, the note names the
        Loom-native equivalent — nothing dead-gates. Full doc:
        <code> docs/fiab/unity-catalog-capability-matrix.md</code>.
      </Body1>
      <LoomDataTable<UcCapabilityRow>
        ariaLabel="Unity Catalog capability matrix"
        columns={columns}
        rows={cap.capabilities}
        getRowId={(c) => c.id}
        empty="No capabilities reported."
      />
    </Section>
  );
}

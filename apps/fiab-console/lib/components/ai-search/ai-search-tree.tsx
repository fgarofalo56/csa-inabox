'use client';

/**
 * AiSearchServiceTree — the Azure AI Search service navigator.
 *
 * The AI Search equivalent of the ADF Factory Resources / Synapse Workspace
 * Resources / Databricks Workspace navigators. Once the search service is known
 * (env-pinned LOOM_AI_SEARCH_SERVICE), the editor's left pane becomes this typed
 * navigator: one group per AI Search top-level object type with a live count and
 * a ＋ New affordance, a "Filter by name" box, and a top "Add new" menu —
 * collapsing the portal's left sidebar (Indexes / Indexers / Data sources /
 * Skillsets / Synonym maps / Aliases) into one tree.
 *
 * Every count comes from a real AI Search data-plane list call; every create/
 * delete/lifecycle hits the real REST through the service-level BFF routes:
 *   - Indexes       → /api/ai-search/indexes      (list / create starter / delete; click opens the index editor)
 *   - Indexers      → /api/ai-search/indexers      (list / create / delete / run / reset / status)
 *   - Data sources  → /api/ai-search/datasources   (list / create / delete)
 *   - Skillsets     → /api/ai-search/skillsets     (list / create from JSON / delete)
 *   - Synonym maps  → /api/ai-search/synonymmaps   (list / create / delete)
 *   - Aliases       → /api/ai-search/aliases       (list / create / delete)
 *
 * Debug sessions (ARM management-plane) are wired here too: list / create /
 * delete + a portal deep-link to the visual skill-graph trace (portal-only
 * rendering). The semantic-configuration + vector-profile designers live in the
 * index Schema tab (foundry-sub-editors). The one remaining portal flow not yet
 * authored — the coordinated Import-data wizard — renders as an honest ⚠️
 * "coming" row naming what's missing. No mocks.
 *
 * The service is the env-pinned default. When unconfigured the routes 503 and
 * the whole tree shows a single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option, Textarea,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Open16Regular,
  Search20Regular, Warning20Regular, Play16Regular, ArrowCounterclockwise16Regular,
  DocumentBulletList20Regular, DataUsage20Regular, Database20Regular,
  BrainCircuit20Regular, TextBulletListSquare20Regular, BranchFork20Regular,
  Bug20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 240 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
});

const R = {
  indexes: '/api/ai-search/indexes',
  indexers: '/api/ai-search/indexers',
  datasources: '/api/ai-search/datasources',
  skillsets: '/api/ai-search/skillsets',
  synonymmaps: '/api/ai-search/synonymmaps',
  aliases: '/api/ai-search/aliases',
  debugSessions: '/api/ai-search/debug-sessions',
};

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface IndexRow { name: string; fieldCount: number; vectorEnabled?: boolean }
interface IndexerRow { name: string; targetIndexName?: string; dataSourceName?: string; skillsetName?: string }
interface DataSourceRow { name: string; type?: string; container?: string }
interface SkillsetRow { name: string; skillCount: number }
interface SynonymMapRow { name: string; ruleCount: number; format?: string }
interface AliasRow { name: string; indexes: string[] }
interface DebugSessionRow { name: string; indexerName?: string; status?: string; provisioningState?: string }

type CreateGroup = 'index' | 'indexer' | 'datasource' | 'skillset' | 'synonymmap' | 'alias' | 'debugsession';

function statusColor(status?: string) {
  if (status === 'success') return 'success' as const;
  if (status === 'inProgress') return 'warning' as const;
  if (status === 'transientFailure' || status === 'error') return 'danger' as const;
  return 'informative' as const;
}

export interface AiSearchServiceTreeProps {
  /** Currently selected index (highlighted in the tree). */
  selectedIndex?: string | null;
  /** Open / bind an index in the host editor (selecting opens the index editor / search explorer). */
  onOpenIndex?: (name: string) => void;
  /** Start a brand-new index in the host editor. Falls back to the inline starter-index dialog when absent. */
  onNewIndex?: () => void;
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
}

/** A typed, AI-Search-faithful service navigator. */
export function AiSearchServiceTree({
  selectedIndex = null, onOpenIndex, onNewIndex, refreshKey = 0,
}: AiSearchServiceTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [indexes, setIndexes] = useState<IndexRow[]>([]);
  const [indexers, setIndexers] = useState<IndexerRow[]>([]);
  const [dataSources, setDataSources] = useState<DataSourceRow[]>([]);
  const [skillsets, setSkillsets] = useState<SkillsetRow[]>([]);
  const [synonymMaps, setSynonymMaps] = useState<SynonymMapRow[]>([]);
  const [aliases, setAliases] = useState<AliasRow[]>([]);

  // Debug sessions (ARM management-plane). Gated separately: they need the ARM
  // env (LOOM_AI_SEARCH_SUB/RG/SERVICE), distinct from the data-plane gate.
  const [debugSessions, setDebugSessions] = useState<DebugSessionRow[]>([]);
  const [debugGate, setDebugGate] = useState<{ missing: string[]; storageConfigured?: boolean } | null>(null);
  const [debugPortalUrl, setDebugPortalUrl] = useState<string | null>(null);
  const [debugStorageConn, setDebugStorageConn] = useState('');

  // Per-indexer last status (lazy, on demand).
  const [indexerStatus, setIndexerStatus] = useState<Record<string, string>>({});

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreateGroup | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // shared name
  const [cName, setCName] = useState('');
  // indexer
  const [cDataSource, setCDataSource] = useState('');
  const [cTargetIndex, setCTargetIndex] = useState('');
  const [cSkillset, setCSkillset] = useState('');
  // datasource
  const [cDsType, setCDsType] = useState('azureblob');
  const [cDsConn, setCDsConn] = useState('');
  const [cDsContainer, setCDsContainer] = useState('');
  const [cDsQuery, setCDsQuery] = useState('');
  // skillset (JSON)
  const [cSkillsetJson, setCSkillsetJson] = useState('');
  // synonym map
  const [cSynonyms, setCSynonyms] = useState('');
  // alias
  const [cAliasIndex, setCAliasIndex] = useState('');
  // debug session
  const [cDebugIndexer, setCDebugIndexer] = useState('');

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ix, idr, ds, sk, sm, al] = await Promise.all([
        fetch(R.indexes).then(readJson),
        fetch(R.indexers).then(readJson),
        fetch(R.datasources).then(readJson),
        fetch(R.skillsets).then(readJson),
        fetch(R.synonymmaps).then(readJson),
        fetch(R.aliases).then(readJson),
      ]);
      for (const b of [ix, idr, ds, sk, sm, al]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (ix.ok) setIndexes(ix.indexes || []); else setError(ix.error || 'failed to list indexes');
      if (idr.ok) setIndexers(idr.indexers || []);
      if (ds.ok) setDataSources(ds.dataSources || []);
      if (sk.ok) setSkillsets(sk.skillsets || []);
      if (sm.ok) setSynonymMaps(sm.synonymMaps || []);
      if (al.ok) setAliases(al.aliases || []);
      // Debug sessions live on the ARM plane — load separately so their own
      // (ARM) gate doesn't block the data-plane tree.
      await loadDebugSessions();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDebugSessions = useCallback(async () => {
    try {
      const res = await fetch(R.debugSessions);
      const body = await readJson(res);
      if (body?.code === 'not_configured') {
        setDebugGate({ missing: body.missing || [] });
        setDebugSessions([]); setDebugPortalUrl(null);
        return;
      }
      setDebugGate(null);
      setDebugSessions(body.ok ? (body.sessions || []) : []);
      setDebugPortalUrl(body.portalUrl || null);
      setDebugGate(body.ok ? { missing: [], storageConfigured: !!body.storageConfigured } : null);
    } catch {
      // Surface as an empty list with no gate; the main error bar covers hard failures.
      setDebugSessions([]);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  // ---------------------------------------------------------------
  // Create / delete / lifecycle (real REST)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreateGroup) => {
    setCreateGroup(g); setCreateError(null);
    setCName(''); setCDataSource(''); setCTargetIndex(''); setCSkillset('');
    setCDsType('azureblob'); setCDsConn(''); setCDsContainer(''); setCDsQuery('');
    setCSkillsetJson(''); setCSynonyms(''); setCAliasIndex(''); setCDebugIndexer('');
  }, []);

  const submitCreate = useCallback(async () => {
    if (!createGroup) return;
    setBusy(true); setCreateError(null);
    try {
      let route = R.indexes; let payload: any = {};
      if (createGroup === 'index') {
        if (!cName.trim()) { setCreateError('Name is required.'); setBusy(false); return; }
        route = R.indexes; payload = { name: cName.trim() };
      } else if (createGroup === 'indexer') {
        if (!cName.trim() || !cDataSource || !cTargetIndex) { setCreateError('Name, data source and target index are required.'); setBusy(false); return; }
        route = R.indexers; payload = { name: cName.trim(), dataSourceName: cDataSource, targetIndexName: cTargetIndex, ...(cSkillset ? { skillsetName: cSkillset } : {}) };
      } else if (createGroup === 'datasource') {
        if (!cName.trim() || !cDsConn.trim() || !cDsContainer.trim()) { setCreateError('Name, connection string and container are required.'); setBusy(false); return; }
        route = R.datasources; payload = { name: cName.trim(), type: cDsType, connectionString: cDsConn.trim(), container: cDsContainer.trim(), ...(cDsQuery.trim() ? { query: cDsQuery.trim() } : {}) };
      } else if (createGroup === 'skillset') {
        let def: any;
        try { def = JSON.parse(cSkillsetJson); } catch (e: any) { setCreateError(`Invalid JSON: ${e?.message}`); setBusy(false); return; }
        if (cName.trim() && !def.name) def.name = cName.trim();
        route = R.skillsets; payload = { definition: def };
      } else if (createGroup === 'synonymmap') {
        if (!cName.trim() || !cSynonyms.trim()) { setCreateError('Name and rules are required.'); setBusy(false); return; }
        route = R.synonymmaps; payload = { name: cName.trim(), synonyms: cSynonyms };
      } else if (createGroup === 'alias') {
        if (!cName.trim() || !cAliasIndex) { setCreateError('Name and target index are required.'); setBusy(false); return; }
        route = R.aliases; payload = { name: cName.trim(), index: cAliasIndex };
      } else if (createGroup === 'debugsession') {
        if (!cName.trim() || !cDebugIndexer) { setCreateError('Session name and indexer are required.'); setBusy(false); return; }
        route = R.debugSessions;
        payload = { name: cName.trim(), indexerName: cDebugIndexer, ...(debugStorageConn.trim() ? { storageConnStr: debugStorageConn.trim() } : {}) };
      }
      const res = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await readJson(res);
      // Debug sessions gate on ARM env, not the data-plane gate — surface as inline error.
      if (createGroup !== 'debugsession' && applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setCreateError(body.error || 'create failed'); setBusy(false); return; }
      setCreateGroup(null);
      if (createGroup === 'debugsession') { await loadDebugSessions(); } else { await loadAll(); }
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, cName, cDataSource, cTargetIndex, cSkillset, cDsType, cDsConn, cDsContainer, cDsQuery, cSkillsetJson, cSynonyms, cAliasIndex, cDebugIndexer, debugStorageConn, loadAll, loadDebugSessions]);

  const delDebugSession = useCallback(async (name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${R.debugSessions}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadDebugSessions();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadDebugSessions]);

  const del = useCallback(async (route: string, name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${route}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  const indexerAction = useCallback(async (action: 'run' | 'reset' | 'status', indexer: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(R.indexers, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, indexer }) });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || `${action} failed`); setBusy(false); return; }
      if (action === 'status') {
        const st = body.status?.lastResult?.status || body.status?.status || 'unknown';
        setIndexerStatus((m) => ({ ...m, [indexer]: st }));
      }
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, []);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fIndexes = useMemo(() => indexes.filter((x) => match(x.name)), [indexes, f]);
  const fIndexers = useMemo(() => indexers.filter((x) => match(x.name)), [indexers, f]);
  const fDataSources = useMemo(() => dataSources.filter((x) => match(x.name)), [dataSources, f]);
  const fSkillsets = useMemo(() => skillsets.filter((x) => match(x.name)), [skillsets, f]);
  const fSynonymMaps = useMemo(() => synonymMaps.filter((x) => match(x.name)), [synonymMaps, f]);
  const fAliases = useMemo(() => aliases.filter((x) => match(x.name)), [aliases, f]);

  const indexNames = useMemo(() => indexes.map((i) => i.name), [indexes]);
  const dataSourceNames = useMemo(() => dataSources.map((d) => d.name), [dataSources]);
  const skillsetNames = useMemo(() => skillsets.map((sk) => sk.name), [skillsets]);
  const indexerNames = useMemo(() => indexers.map((ix) => ix.name), [indexers]);
  const fDebugSessions = useMemo(() => debugSessions.filter((x) => match(x.name)), [debugSessions, f]);

  // ---------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------
  const groupHeader = (label: string, icon: React.ReactElement, count: number, onAdd?: () => void, addTitle?: string) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
  );

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Search service</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Search not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console Container App to a deployed{' '}
            <code>Microsoft.Search/searchServices</code> name (or its{' '}
            <code>&lt;service&gt;.search.windows.net</code> host). The navigator stays here; objects
            appear once the service is reachable. The Loom UAMI must hold{' '}
            <strong>Search Service Contributor</strong> + <strong>Search Index Data Contributor</strong>{' '}
            on the service. Provisioned by{' '}
            <code>platform/fiab/bicep/modules/admin-plane/ai-search.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Search service</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Add new" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="Add new" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<DocumentBulletList20Regular />} onClick={() => (onNewIndex ? onNewIndex() : openCreate('index'))}>Index</MenuItem>
                <MenuItem icon={<DataUsage20Regular />} onClick={() => openCreate('indexer')}>Indexer</MenuItem>
                <MenuItem icon={<Database20Regular />} onClick={() => openCreate('datasource')}>Data source</MenuItem>
                <MenuItem icon={<BrainCircuit20Regular />} onClick={() => openCreate('skillset')}>Skillset</MenuItem>
                <MenuItem icon={<TextBulletListSquare20Regular />} onClick={() => openCreate('synonymmap')}>Synonym map</MenuItem>
                <MenuItem icon={<BranchFork20Regular />} onClick={() => openCreate('alias')}>Alias</MenuItem>
                <MenuItem icon={<Bug20Regular />} onClick={() => openCreate('debugsession')} disabled={!!debugGate?.missing?.length}>Debug session</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh search service" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input size="small" contentBefore={<Search20Regular />} placeholder="Filter by name" value={filter} onChange={(_, d) => setFilter(d.value)} />
      </Field>

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading search service…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Service error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="Azure AI Search service" defaultOpenItems={['g-indexes']}>
          {/* Indexes */}
          <TreeItem itemType="branch" value="g-indexes">
            {groupHeader('Indexes', <DocumentBulletList20Regular />, indexes.length, () => (onNewIndex ? onNewIndex() : openCreate('index')), 'New index')}
            <Tree>
              {fIndexes.length === 0 && <TreeItem itemType="leaf" value="ix-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No indexes'}</Caption1></TreeItemLayout></TreeItem>}
              {fIndexes.map((i) => (
                <TreeItem key={i.name} itemType="leaf" value={`ix-${i.name}`}>
                  <TreeItemLayout iconBefore={<DocumentBulletList20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: onOpenIndex ? 'pointer' : undefined, fontWeight: selectedIndex === i.name ? tokens.fontWeightSemibold : undefined }}
                        onClick={() => onOpenIndex?.(i.name)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenIndex) { e.preventDefault(); onOpenIndex(i.name); } }}
                      >
                        {i.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Caption1>{i.fieldCount} fields</Caption1>
                        {i.vectorEnabled && <Badge size="small" appearance="tint" color="brand">vector</Badge>}
                        {onOpenIndex && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenIndex(i.name)} aria-label={`Open ${i.name}`} /></Tooltip>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.indexes, i.name)} aria-label={`Delete ${i.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Indexers */}
          <TreeItem itemType="branch" value="g-indexers">
            {groupHeader('Indexers', <DataUsage20Regular />, indexers.length, () => openCreate('indexer'), 'New indexer')}
            <Tree>
              {fIndexers.length === 0 && <TreeItem itemType="leaf" value="idr-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No indexers'}</Caption1></TreeItemLayout></TreeItem>}
              {fIndexers.map((ix) => (
                <TreeItem key={ix.name} itemType="leaf" value={`idr-${ix.name}`}>
                  <TreeItemLayout iconBefore={<DataUsage20Regular />}>
                    <span className={s.leafRow}>
                      <span>{ix.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {ix.targetIndexName && <Caption1>→ {ix.targetIndexName}</Caption1>}
                        {indexerStatus[ix.name] && <Badge size="small" appearance="filled" color={statusColor(indexerStatus[ix.name])}>{indexerStatus[ix.name]}</Badge>}
                        <Tooltip content="Run now" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => indexerAction('run', ix.name)} aria-label={`Run ${ix.name}`} /></Tooltip>
                        <Tooltip content="Reset (full reindex next run)" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowCounterclockwise16Regular />} disabled={busy} onClick={() => indexerAction('reset', ix.name)} aria-label={`Reset ${ix.name}`} /></Tooltip>
                        <Tooltip content="Check status" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={() => indexerAction('status', ix.name)} aria-label={`Status of ${ix.name}`} /></Tooltip>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.indexers, ix.name)} aria-label={`Delete ${ix.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Data sources */}
          <TreeItem itemType="branch" value="g-datasources">
            {groupHeader('Data sources', <Database20Regular />, dataSources.length, () => openCreate('datasource'), 'New data source')}
            <Tree>
              {fDataSources.length === 0 && <TreeItem itemType="leaf" value="ds-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No data sources'}</Caption1></TreeItemLayout></TreeItem>}
              {fDataSources.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`ds-${d.name}`}>
                  <TreeItemLayout iconBefore={<Database20Regular />}>
                    <span className={s.leafRow}>
                      <span>{d.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {d.type && <Badge size="small" appearance="tint">{d.type}</Badge>}
                        {d.container && <Caption1>{d.container}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.datasources, d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Skillsets */}
          <TreeItem itemType="branch" value="g-skillsets">
            {groupHeader('Skillsets', <BrainCircuit20Regular />, skillsets.length, () => openCreate('skillset'), 'New skillset')}
            <Tree>
              {fSkillsets.length === 0 && <TreeItem itemType="leaf" value="sk-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No skillsets'}</Caption1></TreeItemLayout></TreeItem>}
              {fSkillsets.map((sk) => (
                <TreeItem key={sk.name} itemType="leaf" value={`sk-${sk.name}`}>
                  <TreeItemLayout iconBefore={<BrainCircuit20Regular />}>
                    <span className={s.leafRow}>
                      <span>{sk.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Caption1>{sk.skillCount} skills</Caption1>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.skillsets, sk.name)} aria-label={`Delete ${sk.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Synonym maps */}
          <TreeItem itemType="branch" value="g-synonymmaps">
            {groupHeader('Synonym maps', <TextBulletListSquare20Regular />, synonymMaps.length, () => openCreate('synonymmap'), 'New synonym map')}
            <Tree>
              {fSynonymMaps.length === 0 && <TreeItem itemType="leaf" value="sm-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No synonym maps'}</Caption1></TreeItemLayout></TreeItem>}
              {fSynonymMaps.map((sm) => (
                <TreeItem key={sm.name} itemType="leaf" value={`sm-${sm.name}`}>
                  <TreeItemLayout iconBefore={<TextBulletListSquare20Regular />}>
                    <span className={s.leafRow}>
                      <span>{sm.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Caption1>{sm.ruleCount} rules</Caption1>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.synonymmaps, sm.name)} aria-label={`Delete ${sm.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Aliases */}
          <TreeItem itemType="branch" value="g-aliases">
            {groupHeader('Aliases', <BranchFork20Regular />, aliases.length, () => openCreate('alias'), 'New alias')}
            <Tree>
              {fAliases.length === 0 && <TreeItem itemType="leaf" value="al-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No aliases'}</Caption1></TreeItemLayout></TreeItem>}
              {fAliases.map((a) => (
                <TreeItem key={a.name} itemType="leaf" value={`al-${a.name}`}>
                  <TreeItemLayout iconBefore={<BranchFork20Regular />}>
                    <span className={s.leafRow}>
                      <span>{a.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {a.indexes?.[0] && <Caption1>→ {a.indexes[0]}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.aliases, a.name)} aria-label={`Delete ${a.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Debug sessions (ARM management-plane). Create/list/delete + portal
              deep-link to the visual skill-graph trace (portal-only rendering). */}
          <TreeItem itemType="branch" value="g-debug-sessions">
            {groupHeader('Debug sessions', <Bug20Regular />, debugSessions.length, (!debugGate?.missing?.length ? () => openCreate('debugsession') : undefined), 'New debug session')}
            <Tree>
              {debugGate?.missing?.length ? (
                <TreeItem itemType="leaf" value="dbg-gate">
                  <Tooltip content={`Set ${debugGate.missing.join(', ')} on the Console Container App to enable debug sessions (ARM management plane). Bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep`} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>ARM not configured — set {debugGate.missing.join(', ')}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">config</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ) : (
                <>
                  {fDebugSessions.length === 0 && <TreeItem itemType="leaf" value="dbg-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No debug sessions'}</Caption1></TreeItemLayout></TreeItem>}
                  {fDebugSessions.map((dbg) => (
                    <TreeItem key={dbg.name} itemType="leaf" value={`dbg-${dbg.name}`}>
                      <TreeItemLayout iconBefore={<Bug20Regular />}>
                        <span className={s.leafRow}>
                          <span>{dbg.name}</span>
                          <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                            {dbg.indexerName && <Caption1>↳ {dbg.indexerName}</Caption1>}
                            {(dbg.status || dbg.provisioningState) && <Badge size="small" appearance="filled" color={statusColor(dbg.status)}>{dbg.status || dbg.provisioningState}</Badge>}
                            {debugPortalUrl && <Tooltip content="Open session trace in portal (visual skill graph is portal-only)" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => window.open(`${debugPortalUrl}/${encodeURIComponent(dbg.name)}`, '_blank', 'noopener')} aria-label={`Open ${dbg.name} in portal`} /></Tooltip>}
                            <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => delDebugSession(dbg.name)} aria-label={`Delete ${dbg.name}`} /></Tooltip>
                          </span>
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  ))}
                  {debugPortalUrl && (
                    <TreeItem itemType="leaf" value="dbg-portal">
                      <TreeItemLayout iconBefore={<Open16Regular />}>
                        <span role="button" tabIndex={0} style={{ cursor: 'pointer', color: tokens.colorBrandForeground1 }}
                          onClick={() => window.open(debugPortalUrl, '_blank', 'noopener')}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.open(debugPortalUrl, '_blank', 'noopener'); } }}>
                          Open debug-sessions blade in portal
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  )}
                </>
              )}
            </Tree>
          </TreeItem>

          {/* Honest gate row — the one remaining portal flow not yet authored in Loom. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Import data wizard', 'Portal "Import data" / "Import and vectorize data" wizard that creates datasource+skillset+index+indexer in one coordinated flow. Create the pieces individually using ＋ New for each object type above; the coordinated wizard is not yet built.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`nw-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">coming</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Create dialog */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'index' ? 'index'
                : createGroup === 'indexer' ? 'indexer'
                : createGroup === 'datasource' ? 'data source'
                : createGroup === 'skillset' ? 'skillset'
                : createGroup === 'synonymmap' ? 'synonym map'
                : createGroup === 'debugsession' ? 'debug session'
                : 'alias'}
            </DialogTitle>
            <DialogContent>
              {createGroup !== 'skillset' && (
                <Field label="Name" required>
                  <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="lowercase-with-dashes" />
                </Field>
              )}

              {createGroup === 'index' && (
                <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                  Creates a minimal starter index (a key <code>id</code> field + a searchable <code>content</code> field)
                  via <code>POST /indexes</code>. Add fields, analyzers, vector profiles and semantic configuration in the
                  index Schema (JSON) editor after it opens.
                </Caption1>
              )}

              {createGroup === 'indexer' && (
                <>
                  <Field label="Data source" required style={{ marginTop: 8 }}>
                    <Dropdown value={cDataSource} selectedOptions={cDataSource ? [cDataSource] : []} placeholder={dataSourceNames.length ? 'Select a data source' : 'No data sources — create one first'} onOptionSelect={(_, d) => setCDataSource(d.optionValue || '')}>
                      {dataSourceNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Target index" required style={{ marginTop: 8 }}>
                    <Dropdown value={cTargetIndex} selectedOptions={cTargetIndex ? [cTargetIndex] : []} placeholder={indexNames.length ? 'Select an index' : 'No indexes — create one first'} onOptionSelect={(_, d) => setCTargetIndex(d.optionValue || '')}>
                      {indexNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Skillset (optional, for AI enrichment)" style={{ marginTop: 8 }}>
                    <Dropdown value={cSkillset} selectedOptions={cSkillset ? [cSkillset] : []} placeholder="None" onOptionSelect={(_, d) => setCSkillset(d.optionValue || '')}>
                      <Option value="" text="None">None</Option>
                      {skillsetNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    Creates the indexer via <code>PUT /indexers/{'{name}'}</code>. Per Azure, creating an indexer also
                    runs it once. Configure field mappings + schedule in the index editor / Schema JSON.
                  </Caption1>
                </>
              )}

              {createGroup === 'datasource' && (
                <>
                  <Field label="Type" style={{ marginTop: 8 }}>
                    <Dropdown value={cDsType} selectedOptions={[cDsType]} onOptionSelect={(_, d) => setCDsType(d.optionValue || 'azureblob')}>
                      {['azureblob', 'adlsgen2', 'azuretable', 'azuresql', 'cosmosdb', 'mysql', 'onelake'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Connection string" required style={{ marginTop: 8 }}>
                    <Input value={cDsConn} onChange={(_, d) => setCDsConn(d.value)} placeholder="DefaultEndpointsProtocol=… OR ResourceId=… (managed identity)" />
                  </Field>
                  <Field label="Container / table / collection" required style={{ marginTop: 8 }}>
                    <Input value={cDsContainer} onChange={(_, d) => setCDsContainer(d.value)} placeholder="my-container" />
                  </Field>
                  <Field label="Query (optional)" style={{ marginTop: 8 }}>
                    <Input value={cDsQuery} onChange={(_, d) => setCDsQuery(d.value)} placeholder="blob path prefix / SQL query / Cosmos query" />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    Creates the connection via <code>PUT /datasources/{'{name}'}</code>. For managed-identity auth use a
                    <code>ResourceId=…</code> connection string and grant the search service identity access to the source.
                  </Caption1>
                </>
              )}

              {createGroup === 'skillset' && (
                <>
                  <Field label="Skillset definition (JSON)" required>
                    <Textarea
                      value={cSkillsetJson}
                      onChange={(_, d) => setCSkillsetJson(d.value)}
                      resize="vertical"
                      style={{ minHeight: 220, fontFamily: 'Consolas, monospace', fontSize: 12 }}
                      placeholder={'{\n  "name": "my-skillset",\n  "skills": [\n    {\n      "@odata.type": "#Microsoft.Skills.Text.V3.EntityRecognitionSkill",\n      "categories": ["Organization"],\n      "context": "/document",\n      "inputs": [{ "name": "text", "source": "/document/content" }],\n      "outputs": [{ "name": "organizations", "targetName": "orgs" }]\n    }\n  ]\n}'}
                    />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    Skillsets are rich (built-in + custom skills, knowledge stores, projections) — authored as a full JSON
                    definition and sent via <code>PUT /skillsets/{'{name}'}</code>. A guided skill-by-skill designer is not
                    built yet (see "Not yet wired").
                  </Caption1>
                </>
              )}

              {createGroup === 'synonymmap' && (
                <>
                  <Field label="Rules (solr format, one per line)" required style={{ marginTop: 8 }}>
                    <Textarea
                      value={cSynonyms}
                      onChange={(_, d) => setCSynonyms(d.value)}
                      resize="vertical"
                      style={{ minHeight: 120, fontFamily: 'Consolas, monospace', fontSize: 12 }}
                      placeholder={'USA, United States, United States of America\nUK => United Kingdom'}
                    />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    Equivalency rules are comma-separated; explicit mappings use <code>=&gt;</code>. Sent via
                    <code> PUT /synonymmaps/{'{name}'}</code>. Attach the map to a field in the index Schema
                    (<code>synonymMaps</code>) to take effect.
                  </Caption1>
                </>
              )}

              {createGroup === 'alias' && (
                <>
                  <Field label="Target index" required style={{ marginTop: 8 }}>
                    <Dropdown value={cAliasIndex} selectedOptions={cAliasIndex ? [cAliasIndex] : []} placeholder={indexNames.length ? 'Select an index' : 'No indexes — create one first'} onOptionSelect={(_, d) => setCAliasIndex(d.optionValue || '')}>
                      {indexNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    An alias maps a stable name to exactly one index (<code>PUT /aliases/{'{name}'}</code>), so you can
                    re-point queries to a rebuilt index with zero client changes.
                  </Caption1>
                </>
              )}

              {createGroup === 'debugsession' && (
                <>
                  <Field label="Indexer to trace" required style={{ marginTop: 8 }}>
                    <Dropdown value={cDebugIndexer} selectedOptions={cDebugIndexer ? [cDebugIndexer] : []} placeholder={indexerNames.length ? 'Select an indexer' : 'No indexers — create one first'} onOptionSelect={(_, d) => setCDebugIndexer(d.optionValue || '')}>
                      {indexerNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Storage connection string (session state)" style={{ marginTop: 8 }}>
                    <Input value={debugStorageConn} onChange={(_, d) => setDebugStorageConn(d.value)} placeholder="DefaultEndpointsProtocol=… (or leave blank to use LOOM_AI_SEARCH_DEBUG_STORAGE_CONN)" />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    A debug session captures a single-document enrichment trace for the chosen indexer + skillset, written to
                    the <code>ms-az-cognitive-search-debugsession</code> container on the storage account. The search service&apos;s
                    managed identity needs <strong>Storage Blob Data Contributor</strong> on that account
                    (bicep: <code>ai-search.bicep debugSessionStorageId</code>). In a private-endpoint-locked deployment the session
                    also requires a shared private link from the search service to storage and <code>executionEnvironment:&quot;private&quot;</code>
                    on the indexer. The visual skill-graph trace is rendered in the Azure portal — open the session there to inspect it.
                  </Caption1>
                  {debugGate && !debugGate.storageConfigured && !debugStorageConn.trim() && (
                    <MessageBar intent="warning" style={{ marginTop: 8 }}><MessageBarBody>
                      No <code>LOOM_AI_SEARCH_DEBUG_STORAGE_CONN</code> is set — supply a storage connection string above, or set the env var on the Console Container App.
                    </MessageBarBody></MessageBar>
                  )}
                </>
              )}

              {createError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

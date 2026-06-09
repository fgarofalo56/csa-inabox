'use client';

/**
 * CosmosTree — the Azure Cosmos DB **Data Explorer studio** databases pane,
 * one-for-one with the live studio's left region
 * (temp/ref-cosmos-data-explorer-studio.png).
 *
 * The studio's left region has, top to bottom:
 *   - a command row: a **＋ New…** split-dropdown (New Database / New Container /
 *     New SQL Query / New Stored Procedure / New UDF / New Trigger), a Refresh
 *     icon, and a collapse caret
 *   - a "Search databases only" box with a sort toggle
 *   - a **Home** row (opens the welcome tab)
 *   - the databases list: each database row → chevron → **Containers**; each
 *     container → **Items / Settings / Stored Procedures / User Defined
 *     Functions / Triggers** nodes.
 *
 * Every node here routes to a work-area tab via onOpen(action). Counts +
 * create/delete hit the real ARM control plane through the navigator BFF:
 *   - Databases  → /api/cosmos/databases   (list / create / delete)
 *   - Containers → /api/cosmos/containers   (list / create / delete, +pk +RU +ttl)
 *   - Scripts    → /api/cosmos/scripts      (read-only sprocs / triggers / UDFs)
 *   - Account    → /api/cosmos/account      (header chip)
 *
 * Document read/write, throughput-scale write, indexing-policy write, and
 * script authoring run on data-plane / write surfaces some of which aren't
 * wired yet; those open a work-area tab that renders an honest Fluent
 * MessageBar gate (never a dead node, never fake data) per no-vaporware.md.
 *
 * When the navigator account is unconfigured the routes 503 and the whole pane
 * shows a single honest infra-gate MessageBar naming the env var + role.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular,
  Database20Regular, Table20Regular, Code20Regular,
  Search20Regular, DocumentDatabase20Regular,
  Flow20Regular, MathFormula20Regular, ArrowSort20Regular,
  Home16Regular, Settings20Regular, DocumentBulletList20Regular,
  DataHistogram20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 6, padding: 6, height: '100%', minWidth: 240 },
  // Studio command row: ＋New… split button + Refresh + collapse caret.
  cmdRow: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 2px 0' },
  newBtn: { minWidth: 92 },
  spacer: { flex: 1 },
  searchRow: { display: 'flex', alignItems: 'center', gap: 4 },
  rowLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  rowActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  acctChip: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', padding: '0 2px' },
  mutedRow: { color: tokens.colorNeutralForeground3 },
  homeRow: { cursor: 'pointer' },
  leafBtn: { cursor: 'pointer', textAlign: 'left', width: '100%' },
});

const DB_ROUTE = '/api/cosmos/databases';
const CONTAINER_ROUTE = '/api/cosmos/containers';
const SCRIPTS_ROUTE = '/api/cosmos/scripts';
const ACCOUNT_ROUTE = '/api/cosmos/account';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface ThroughputInfo {
  mode: 'manual' | 'autoscale' | 'serverless' | 'unknown';
  ru?: number;
  maxRu?: number;
  minRu?: number;
}
interface DatabaseRow { id: string; name: string; throughput?: ThroughputInfo }
interface ContainerRow { id: string; name: string; partitionKey?: string; partitionKeyKind?: string; defaultTtl?: number | null; throughput?: ThroughputInfo }
interface SprocRow { id: string; name: string }
interface TriggerRow { id: string; name: string; triggerType?: string; triggerOperation?: string }
interface UdfRow { id: string; name: string }
interface ScriptsBundle { storedProcedures: SprocRow[]; triggers: TriggerRow[]; userDefinedFunctions: UdfRow[] }
interface AccountInfo {
  name: string; location?: string; documentEndpoint?: string;
  capabilities: string[]; serverless: boolean; provisioningState?: string; enableFreeTier?: boolean;
}

function throughputLabel(t?: ThroughputInfo): string | null {
  if (!t) return null;
  if (t.mode === 'serverless') return 'Serverless';
  if (t.mode === 'autoscale' && t.maxRu) return `Auto ${t.maxRu} RU/s`;
  if (t.mode === 'manual' && t.ru) return `${t.ru} RU/s`;
  return null;
}

type CreateKind = 'database' | 'container';

/** A work-area action a tree node routes to. */
export type CosmosAction =
  | 'home'
  | 'items'
  | 'settings'
  | 'metrics'
  | 'newSqlQuery'
  | 'graph'
  | 'newStoredProcedure'
  | 'newUdf'
  | 'newTrigger'
  | 'storedProcedure'
  | 'trigger'
  | 'udf';

export interface CosmosSelection {
  /** Which work-area tab the node opens. */
  action: CosmosAction;
  db?: string;
  container?: string;
  /** Partition-key path of the selected container (e.g. "/tenantId"), when known. */
  partitionKey?: string;
  /** Default TTL (seconds) of the container, when known. */
  defaultTtl?: number | null;
  /** Throughput shape of the container/db, for the Scale tab. */
  throughput?: ThroughputInfo;
  /** Name of a specific script (sproc/trigger/udf), when the node is a script. */
  scriptName?: string;
}

export interface CosmosTreeProps {
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
  /** Notify the host when a node is opened (routes to a work-area tab). */
  onOpen?: (sel: CosmosSelection) => void;
}

/**
 * A studio-faithful Cosmos DB Data Explorer databases pane.
 */
export function CosmosTree({ refreshKey = 0, onOpen }: CosmosTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [sortAsc, setSortAsc] = useState(true);
  const [gate, setGate] = useState<{ missing: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);

  // Lazy caches keyed by db / db|container.
  const [containersByDb, setContainersByDb] = useState<Record<string, ContainerRow[]>>({});
  const [scriptsByKey, setScriptsByKey] = useState<Record<string, ScriptsBundle>>({});
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());

  // ---- create dialog ----
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [createDb, setCreateDb] = useState('');         // target db for a container
  const [createId, setCreateId] = useState('');
  const [createPk, setCreatePk] = useState('/id');
  const [tpMode, setTpMode] = useState<'none' | 'manual' | 'autoscale'>('none');
  const [tpValue, setTpValue] = useState('400');
  const [createError, setCreateError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) {
      setGate({ missing: body.missing, hint: body.hint });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------
  // Loaders (real ARM REST through the BFF)
  // ---------------------------------------------------------------
  const loadTop = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ar, dr] = await Promise.all([
        fetch(ACCOUNT_ROUTE).then(readJson),
        fetch(DB_ROUTE).then(readJson),
      ]);
      if (applyGate(ar) || applyGate(dr)) { setLoading(false); return; }
      setGate(null);
      if (ar.ok) setAccount(ar.account); else setAccount(null);
      if (dr.ok) setDatabases(dr.databases || []);
      else setError(dr.error || 'failed to list databases');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTop();
    // Reset lazy caches on a forced refresh so stale counts never linger.
    setContainersByDb({});
    setScriptsByKey({});
  }, [loadTop, refreshKey]);

  const loadContainers = useCallback(async (db: string) => {
    setError(null);
    try {
      const r = await fetch(`${CONTAINER_ROUTE}?db=${encodeURIComponent(db)}`).then(readJson);
      if (applyGate(r)) return;
      if (r.ok) setContainersByDb((m) => ({ ...m, [db]: r.containers || [] }));
      else setError(r.error || `failed to list containers for ${db}`);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  const loadScripts = useCallback(async (db: string, container: string) => {
    setError(null);
    const key = `${db}|${container}`;
    try {
      const r = await fetch(`${SCRIPTS_ROUTE}?db=${encodeURIComponent(db)}&container=${encodeURIComponent(container)}`).then(readJson);
      if (applyGate(r)) return;
      if (r.ok) {
        setScriptsByKey((m) => ({
          ...m,
          [key]: {
            storedProcedures: r.storedProcedures || [],
            triggers: r.triggers || [],
            userDefinedFunctions: r.userDefinedFunctions || [],
          },
        }));
      } else setError(r.error || `failed to list scripts for ${container}`);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  // Open/close → trigger lazy loads. (Container nodes carry no scripts cache
  // key directly; expanding a container loads scripts so its Stored Procedures /
  // Triggers / UDFs counts fill in.)
  const onOpenChange = useCallback((_: unknown, data: { open: boolean; value: unknown }) => {
    const value = String(data.value);
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (data.open) next.add(value); else next.delete(value);
      return next;
    });
    if (!data.open) return;
    if (value.startsWith('db-')) {
      const db = value.slice(3);
      if (!containersByDb[db]) void loadContainers(db);
    } else if (value.startsWith('cont-')) {
      const [db, container] = value.slice('cont-'.length).split('|');
      if (db && container && !scriptsByKey[`${db}|${container}`]) void loadScripts(db, container);
    }
  }, [containersByDb, scriptsByKey, loadContainers, loadScripts]);

  // ---------------------------------------------------------------
  // Create / delete (real ARM REST)
  // ---------------------------------------------------------------
  const openCreate = useCallback((kind: CreateKind, db?: string) => {
    setCreateKind(kind);
    setCreateDb(db || '');
    setCreateId('');
    setCreatePk('/id');
    setTpMode('none');
    setTpValue('400');
    setCreateError(null);
  }, []);

  const throughputPayload = useCallback(() => {
    const n = parseInt(tpValue, 10);
    if (tpMode === 'manual' && n > 0) return { throughput: n };
    if (tpMode === 'autoscale' && n > 0) return { maxThroughput: n };
    return {};
  }, [tpMode, tpValue]);

  const submitCreate = useCallback(async () => {
    if (!createKind) return;
    setBusy(true); setCreateError(null);
    try {
      if (createKind === 'database') {
        if (!createId.trim()) { setCreateError('Database id is required.'); setBusy(false); return; }
        const r = await fetch(DB_ROUTE, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: createId.trim(), ...throughputPayload() }),
        }).then(readJson);
        if (applyGate(r)) { setBusy(false); return; }
        if (!r.ok) { setCreateError(r.error || 'create failed'); setBusy(false); return; }
        setCreateKind(null);
        await loadTop();
      } else {
        if (!createDb.trim()) { setCreateError('Target database is required.'); setBusy(false); return; }
        if (!createId.trim()) { setCreateError('Container id is required.'); setBusy(false); return; }
        if (!createPk.trim()) { setCreateError('Partition key is required (e.g. /id).'); setBusy(false); return; }
        const r = await fetch(CONTAINER_ROUTE, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ db: createDb.trim(), id: createId.trim(), partitionKey: createPk.trim(), ...throughputPayload() }),
        }).then(readJson);
        if (applyGate(r)) { setBusy(false); return; }
        if (!r.ok) { setCreateError(r.error || 'create failed'); setBusy(false); return; }
        const db = createDb.trim();
        setCreateKind(null);
        await loadContainers(db);
      }
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createKind, createId, createDb, createPk, throughputPayload, loadTop, loadContainers]);

  const deleteDatabase = useCallback(async (db: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${DB_ROUTE}?db=${encodeURIComponent(db)}`, { method: 'DELETE' }).then(readJson);
      if (applyGate(r)) { setBusy(false); return; }
      if (!r.ok) { setError(r.error || 'delete failed'); setBusy(false); return; }
      await loadTop();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadTop]);

  const deleteContainer = useCallback(async (db: string, container: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${CONTAINER_ROUTE}?db=${encodeURIComponent(db)}&container=${encodeURIComponent(container)}`, { method: 'DELETE' }).then(readJson);
      if (applyGate(r)) { setBusy(false); return; }
      if (!r.ok) { setError(r.error || 'delete failed'); setBusy(false); return; }
      await loadContainers(db);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadContainers]);

  // ---------------------------------------------------------------
  // Filtering + sorting (db names; matching containers stay visible)
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fDatabases = useMemo(() => {
    const arr = databases.filter((d) => match(d.name));
    arr.sort((a, b) => sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases, f, sortAsc]);

  // ---------------------------------------------------------------
  // Gate / render
  // ---------------------------------------------------------------
  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.acctChip}><span style={{ fontWeight: tokens.fontWeightSemibold }}>Data Explorer</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB account not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console Container App.{' '}
            {gate.hint || (
              <>Provide <code>LOOM_COSMOS_ACCOUNT</code> (the Cosmos account to navigate — distinct
              from Loom&apos;s own store), <code>LOOM_COSMOS_ACCOUNT_RG</code>, and{' '}
              <code>LOOM_SUBSCRIPTION_ID</code>, then grant the Console UAMI the{' '}
              <strong>Cosmos DB Operator</strong> (or <strong>DocumentDB Account Contributor</strong>)
              role at the account scope.</>
            )}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  const containerScriptCount = (db: string, c: string, k: keyof ScriptsBundle): string => {
    const b = scriptsByKey[`${db}|${c}`];
    return b ? ` (${b[k].length})` : '';
  };

  return (
    <div className={s.root}>
      {/* Studio command row: ＋New… split dropdown + Refresh. */}
      <div className={s.cmdRow}>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="primary" className={s.newBtn} icon={<Add20Regular />}>
              New…
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Database20Regular />} onClick={() => openCreate('database')}>New Database</MenuItem>
              <MenuItem
                icon={<Table20Regular />}
                onClick={() => openCreate('container', databases[0]?.name)}
                disabled={databases.length === 0}
              >
                New Container
              </MenuItem>
              <MenuItem icon={<Search20Regular />} onClick={() => onOpen?.({ action: 'newSqlQuery', db: databases[0]?.name })} disabled={databases.length === 0}>New SQL Query</MenuItem>
              <MenuItem icon={<Code20Regular />} onClick={() => onOpen?.({ action: 'newStoredProcedure', db: databases[0]?.name })} disabled={databases.length === 0}>New Stored Procedure</MenuItem>
              <MenuItem icon={<MathFormula20Regular />} onClick={() => onOpen?.({ action: 'newUdf', db: databases[0]?.name })} disabled={databases.length === 0}>New UDF</MenuItem>
              <MenuItem icon={<Flow20Regular />} onClick={() => onOpen?.({ action: 'newTrigger', db: databases[0]?.name })} disabled={databases.length === 0}>New Trigger</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
        <span className={s.spacer} />
        <Tooltip content="Refresh" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadTop} disabled={loading} aria-label="Refresh" />
        </Tooltip>
      </div>

      {account && (
        <div className={s.acctChip}>
          <Badge size="small" appearance="tint" icon={<DocumentDatabase20Regular />}>{account.name}</Badge>
          {account.location && <Caption1>{account.location}</Caption1>}
          {account.serverless && <Badge size="small" appearance="outline">Serverless</Badge>}
          {account.enableFreeTier && <Badge size="small" appearance="outline" color="success">Free tier</Badge>}
        </div>
      )}

      {/* "Search databases only" + sort toggle, like the studio. */}
      <div className={s.searchRow}>
        <Field style={{ flex: 1 }}>
          <Input
            size="small"
            contentBefore={<Search20Regular />}
            placeholder="Search databases only"
            value={filter}
            onChange={(_, d) => setFilter(d.value)}
          />
        </Field>
        <Tooltip content={sortAsc ? 'Sort A→Z (click for Z→A)' : 'Sort Z→A (click for A→Z)'} relationship="label">
          <Button
            size="small" appearance="subtle" icon={<ArrowSort20Regular />}
            onClick={() => setSortAsc((v) => !v)}
            aria-label="Toggle database sort order"
          />
        </Tooltip>
      </div>

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading Cosmos account…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Cosmos error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      {/* Home row (opens the welcome tab), then the databases list. */}
      <Button
        appearance="subtle" size="small" className={s.homeRow}
        icon={<Home16Regular />}
        style={{ justifyContent: 'flex-start' }}
        onClick={() => onOpen?.({ action: 'home' })}
      >
        Home
      </Button>

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree
          aria-label="Cosmos DB Data Explorer"
          openItems={Array.from(openItems)}
          onOpenChange={onOpenChange as any}
        >
          {fDatabases.length === 0 && (
            <TreeItem itemType="leaf" value="db-empty">
              <TreeItemLayout><Caption1>{f ? 'No matches' : 'No databases'}</Caption1></TreeItemLayout>
            </TreeItem>
          )}
          {fDatabases.map((db) => {
            const containers = containersByDb[db.name];
            const tp = throughputLabel(db.throughput);
            return (
              <TreeItem key={db.name} itemType="branch" value={`db-${db.name}`}>
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  <span className={s.rowLayout}>
                    <span>{db.name}</span>
                    <span className={s.rowActions} onClick={(e) => e.stopPropagation()}>
                      {tp && <Badge size="small" appearance="tint">{tp}</Badge>}
                      <Tooltip content="New container" relationship="label">
                        <Button size="small" appearance="subtle" icon={<Add20Regular />} disabled={busy} onClick={() => openCreate('container', db.name)} aria-label={`New container in ${db.name}`} />
                      </Tooltip>
                      <Tooltip content="Delete database" relationship="label">
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => deleteDatabase(db.name)} aria-label={`Delete ${db.name}`} />
                      </Tooltip>
                    </span>
                  </span>
                </TreeItemLayout>
                <Tree>
                  {!containers && (
                    <TreeItem itemType="leaf" value={`c-loading-${db.name}`}>
                      <TreeItemLayout><Caption1>Expand the database to load containers…</Caption1></TreeItemLayout>
                    </TreeItem>
                  )}
                  {containers && containers.length === 0 && (
                    <TreeItem itemType="leaf" value={`c-empty-${db.name}`}>
                      <TreeItemLayout><Caption1>No containers</Caption1></TreeItemLayout>
                    </TreeItem>
                  )}
                  {(containers || []).filter((c) => match(c.name)).map((c) => {
                    const ctp = throughputLabel(c.throughput);
                    const sel = (action: CosmosAction, extra?: Partial<CosmosSelection>): CosmosSelection => ({
                      action, db: db.name, container: c.name,
                      partitionKey: c.partitionKey, defaultTtl: c.defaultTtl, throughput: c.throughput,
                      ...extra,
                    });
                    const scripts = scriptsByKey[`${db.name}|${c.name}`];
                    return (
                      <TreeItem key={c.name} itemType="branch" value={`cont-${db.name}|${c.name}`}>
                        <TreeItemLayout iconBefore={<Table20Regular />}>
                          <span className={s.rowLayout}>
                            <span>{c.name}</span>
                            <span className={s.rowActions} onClick={(e) => e.stopPropagation()}>
                              {c.partitionKey && <Caption1>{c.partitionKey}</Caption1>}
                              {ctp && <Badge size="small" appearance="tint">{ctp}</Badge>}
                              <Tooltip content="Delete container" relationship="label">
                                <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => deleteContainer(db.name, c.name)} aria-label={`Delete ${c.name}`} />
                              </Tooltip>
                            </span>
                          </span>
                        </TreeItemLayout>
                        <Tree>
                          {/* Items — opens the document/query tab. */}
                          <TreeItem itemType="leaf" value={`items-${db.name}|${c.name}`}>
                            <TreeItemLayout
                              iconBefore={<DocumentBulletList20Regular />}
                              onClick={() => onOpen?.(sel('items'))}
                            >
                              <span className={s.leafBtn}>Items</span>
                            </TreeItemLayout>
                          </TreeItem>
                          {/* Settings — opens the Scale & Settings tab. */}
                          <TreeItem itemType="leaf" value={`settings-${db.name}|${c.name}`}>
                            <TreeItemLayout
                              iconBefore={<Settings20Regular />}
                              onClick={() => onOpen?.(sel('settings'))}
                            >
                              <span className={s.leafBtn}>Settings</span>
                            </TreeItemLayout>
                          </TreeItem>
                          {/* Metrics — opens the RU/storage/429 Azure Monitor charts. */}
                          <TreeItem itemType="leaf" value={`metrics-${db.name}|${c.name}`}>
                            <TreeItemLayout
                              iconBefore={<DataHistogram20Regular />}
                              onClick={() => onOpen?.(sel('metrics'))}
                            >
                              <span className={s.leafBtn}>Metrics</span>
                            </TreeItemLayout>
                          </TreeItem>
                          {/* Stored Procedures */}
                          <TreeItem itemType="branch" value={`sp-${db.name}|${c.name}`}>
                            <TreeItemLayout iconBefore={<Code20Regular />}>
                              Stored Procedures{containerScriptCount(db.name, c.name, 'storedProcedures')}
                            </TreeItemLayout>
                            <Tree>
                              {scripts?.storedProcedures.length === 0 && (
                                <TreeItem itemType="leaf" value={`sp-empty-${db.name}|${c.name}`}>
                                  <TreeItemLayout><Caption1>No stored procedures</Caption1></TreeItemLayout>
                                </TreeItem>
                              )}
                              {scripts?.storedProcedures.map((sp) => (
                                <TreeItem key={`sp-${sp.name}`} itemType="leaf" value={`spx-${db.name}|${c.name}|${sp.name}`}>
                                  <TreeItemLayout iconBefore={<Code20Regular />} onClick={() => onOpen?.(sel('storedProcedure', { scriptName: sp.name }))}>
                                    <span className={s.leafBtn}>{sp.name}</span>
                                  </TreeItemLayout>
                                </TreeItem>
                              ))}
                            </Tree>
                          </TreeItem>
                          {/* User Defined Functions */}
                          <TreeItem itemType="branch" value={`udf-${db.name}|${c.name}`}>
                            <TreeItemLayout iconBefore={<MathFormula20Regular />}>
                              User Defined Functions{containerScriptCount(db.name, c.name, 'userDefinedFunctions')}
                            </TreeItemLayout>
                            <Tree>
                              {scripts?.userDefinedFunctions.length === 0 && (
                                <TreeItem itemType="leaf" value={`udf-empty-${db.name}|${c.name}`}>
                                  <TreeItemLayout><Caption1>No user defined functions</Caption1></TreeItemLayout>
                                </TreeItem>
                              )}
                              {scripts?.userDefinedFunctions.map((u) => (
                                <TreeItem key={`udf-${u.name}`} itemType="leaf" value={`udfx-${db.name}|${c.name}|${u.name}`}>
                                  <TreeItemLayout iconBefore={<MathFormula20Regular />} onClick={() => onOpen?.(sel('udf', { scriptName: u.name }))}>
                                    <span className={s.leafBtn}>{u.name}</span>
                                  </TreeItemLayout>
                                </TreeItem>
                              ))}
                            </Tree>
                          </TreeItem>
                          {/* Triggers */}
                          <TreeItem itemType="branch" value={`tg-${db.name}|${c.name}`}>
                            <TreeItemLayout iconBefore={<Flow20Regular />}>
                              Triggers{containerScriptCount(db.name, c.name, 'triggers')}
                            </TreeItemLayout>
                            <Tree>
                              {scripts?.triggers.length === 0 && (
                                <TreeItem itemType="leaf" value={`tg-empty-${db.name}|${c.name}`}>
                                  <TreeItemLayout><Caption1>No triggers</Caption1></TreeItemLayout>
                                </TreeItem>
                              )}
                              {scripts?.triggers.map((tg) => (
                                <TreeItem key={`tg-${tg.name}`} itemType="leaf" value={`tgx-${db.name}|${c.name}|${tg.name}`}>
                                  <TreeItemLayout iconBefore={<Flow20Regular />} onClick={() => onOpen?.(sel('trigger', { scriptName: tg.name }))}>
                                    <span className={s.rowLayout}>
                                      <span className={s.leafBtn}>{tg.name}</span>
                                      <span className={s.rowActions}>
                                        {tg.triggerType && <Badge size="small" appearance="outline">{tg.triggerType}</Badge>}
                                        {tg.triggerOperation && <Caption1>{tg.triggerOperation}</Caption1>}
                                      </span>
                                    </span>
                                  </TreeItemLayout>
                                </TreeItem>
                              ))}
                            </Tree>
                          </TreeItem>
                          {!scripts && (
                            <TreeItem itemType="leaf" value={`sc-loading-${db.name}|${c.name}`}>
                              <TreeItemLayout><Caption1>Expand the container to load scripts…</Caption1></TreeItemLayout>
                            </TreeItem>
                          )}
                        </Tree>
                      </TreeItem>
                    );
                  })}
                </Tree>
              </TreeItem>
            );
          })}
        </Tree>
      </div>

      {/* Create dialog (database / container) */}
      <Dialog open={createKind !== null} onOpenChange={(_, d) => { if (!d.open) setCreateKind(null); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>New {createKind === 'container' ? 'container' : 'database'}</DialogTitle>
            <DialogContent>
              {createKind === 'container' && (
                <Field label="Database" required style={{ marginBottom: 8 }}>
                  <Dropdown
                    value={createDb}
                    selectedOptions={createDb ? [createDb] : []}
                    placeholder="Select a database"
                    onOptionSelect={(_, d) => setCreateDb(d.optionValue || '')}
                  >
                    {databases.map((db) => <Option key={db.name} value={db.name} text={db.name}>{db.name}</Option>)}
                  </Dropdown>
                </Field>
              )}

              <Field label={createKind === 'container' ? 'Container id' : 'Database id'} required>
                <Input value={createId} onChange={(_, d) => setCreateId(d.value)} placeholder={createKind === 'container' ? 'my-container' : 'my-database'} />
              </Field>

              {createKind === 'container' && (
                <Field label="Partition key" required style={{ marginTop: 8 }}>
                  <Input value={createPk} onChange={(_, d) => setCreatePk(d.value)} placeholder="/id" />
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    A leading slash is added if omitted. Cosmos NoSQL containers require a partition key.
                  </Caption1>
                </Field>
              )}

              <Field label="Throughput" style={{ marginTop: 8 }}>
                <Dropdown
                  value={tpMode === 'none' ? (createKind === 'container' ? 'Shared (use database RU/s)' : 'None (serverless / per-container)') : tpMode === 'manual' ? 'Manual' : 'Autoscale'}
                  selectedOptions={[tpMode]}
                  onOptionSelect={(_, d) => setTpMode((d.optionValue as any) || 'none')}
                >
                  <Option value="none" text={createKind === 'container' ? 'Shared (use database RU/s)' : 'None (serverless / per-container)'}>
                    {createKind === 'container' ? 'Shared (use database RU/s)' : 'None (serverless / per-container)'}
                  </Option>
                  <Option value="manual" text="Manual">Manual</Option>
                  <Option value="autoscale" text="Autoscale">Autoscale</Option>
                </Dropdown>
              </Field>
              {tpMode !== 'none' && (
                <Field label={tpMode === 'autoscale' ? 'Max RU/s' : 'RU/s'} style={{ marginTop: 8 }}>
                  <Input type="number" value={tpValue} onChange={(_, d) => setTpValue(d.value)} />
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {tpMode === 'autoscale' ? 'Autoscale minimum is 1000 max RU/s (scales 10%–100%).' : 'Manual minimum is 400 RU/s.'}
                  </Caption1>
                </Field>
              )}

              {createError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateKind(null)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={submitCreate}
                disabled={busy || !createId.trim() || (createKind === 'container' && (!createDb.trim() || !createPk.trim()))}
              >
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

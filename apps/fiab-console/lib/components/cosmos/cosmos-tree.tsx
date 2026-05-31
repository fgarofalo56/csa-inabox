'use client';

/**
 * CosmosTree — the Azure Cosmos DB account "Data Explorer" navigator (parity
 * wave 7). The Cosmos equivalent of the ADF Factory Resources / Synapse
 * Workspace Resources / Databricks Workspace panes.
 *
 * Once the navigator account is known (env-pinned LOOM_COSMOS_ACCOUNT, distinct
 * from Loom's OWN internal Cosmos store), the editor's left pane becomes this
 * typed tree, mirroring the portal Data Explorer:
 *
 *   Databases (n)
 *     └─ <db>  [shared RU/s badge]
 *         Containers (n)            ← lazy-expanded
 *           └─ <container>  [pk + RU/s badge]
 *               Stored procedures (n)   ← lazy-expanded
 *               Triggers (n)
 *               User-defined functions (n)
 *
 * Every count comes from a real ARM control-plane list call; every
 * create/delete hits the real ARM REST through the navigator BFF routes:
 *   - Databases  → /api/cosmos/databases   (list / create / delete)
 *   - Containers → /api/cosmos/containers   (list / create / delete)
 *   - Scripts    → /api/cosmos/scripts      (read-only sprocs / triggers / UDFs)
 *   - Account    → /api/cosmos/account      (header chip)
 *
 * Things the portal Data Explorer exposes but we don't yet wire (the document
 * grid / item editor, the indexing-policy editor, conflict-resolution policy,
 * script authoring) render as honest ⚠️ "coming" rows — never a fake surface.
 *
 * When the navigator account is unconfigured the routes 503 and the whole tree
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
  Search20Regular, Warning20Regular, DocumentDatabase20Regular,
  Flow20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 260 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  rowLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  rowActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  acctChip: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  mutedRow: { color: tokens.colorNeutralForeground3 },
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
interface ContainerRow { id: string; name: string; partitionKey?: string; throughput?: ThroughputInfo }
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

export interface CosmosSelection {
  db: string;
  container?: string;
  /** Partition-key path of the selected container (e.g. "/tenantId"), when known. */
  partitionKey?: string;
}

export interface CosmosTreeProps {
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
  /** Notify the host when a database/container is selected (for the main pane). */
  onSelect?: (sel: CosmosSelection) => void;
}

/**
 * A typed, portal-faithful Cosmos DB Data Explorer navigator.
 */
export function CosmosTree({ refreshKey = 0, onSelect }: CosmosTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);

  // Lazy caches keyed by db / db|container.
  const [containersByDb, setContainersByDb] = useState<Record<string, ContainerRow[]>>({});
  const [scriptsByKey, setScriptsByKey] = useState<Record<string, ScriptsBundle>>({});
  const [openItems, setOpenItems] = useState<Set<string>>(new Set(['g-databases']));

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

  // Open/close → trigger lazy loads.
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
    } else if (value.startsWith('scripts-')) {
      const [db, container] = value.slice('scripts-'.length).split('|');
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
    setTpValue(kind === 'container' ? '400' : '400');
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
  // Filtering (db + container names)
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fDatabases = useMemo(() => databases.filter((d) => match(d.name)), [databases, f]);

  // ---------------------------------------------------------------
  // Gate / render
  // ---------------------------------------------------------------
  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Data Explorer</span></div>
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

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Data Explorer</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="New" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="New" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Database20Regular />} onClick={() => openCreate('database')}>New database</MenuItem>
                <MenuItem
                  icon={<Table20Regular />}
                  onClick={() => openCreate('container', databases[0]?.name)}
                  disabled={databases.length === 0}
                >
                  New container
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadTop} disabled={loading} aria-label="Refresh" />
          </Tooltip>
        </span>
      </div>

      {account && (
        <div className={s.acctChip}>
          <Badge size="small" appearance="tint" icon={<DocumentDatabase20Regular />}>{account.name}</Badge>
          {account.location && <Caption1>{account.location}</Caption1>}
          {account.serverless && <Badge size="small" appearance="outline">Serverless</Badge>}
          {account.enableFreeTier && <Badge size="small" appearance="outline" color="success">Free tier</Badge>}
        </div>
      )}

      <Field>
        <Input
          size="small"
          contentBefore={<Search20Regular />}
          placeholder="Filter databases by name"
          value={filter}
          onChange={(_, d) => setFilter(d.value)}
        />
      </Field>

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading Cosmos account…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Cosmos error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree
          aria-label="Cosmos DB Data Explorer"
          openItems={Array.from(openItems)}
          onOpenChange={onOpenChange as any}
        >
          {/* Databases group */}
          <TreeItem itemType="branch" value="g-databases">
            <TreeItemLayout iconBefore={<Database20Regular />}>
              <span className={s.rowLayout}>
                <span>Databases ({databases.length})</span>
                <span className={s.rowActions} onClick={(e) => e.stopPropagation()}>
                  <Tooltip content="New database" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={() => openCreate('database')} disabled={busy} aria-label="New database" />
                  </Tooltip>
                </span>
              </span>
            </TreeItemLayout>
            <Tree>
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
                        <span
                          role="button" tabIndex={0}
                          style={{ cursor: 'pointer' }}
                          onClick={() => onSelect?.({ db: db.name })}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.({ db: db.name }); } }}
                        >
                          {db.name}
                        </span>
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
                      {/* Containers under this database */}
                      <TreeItem itemType="branch" value={`containers-${db.name}`}>
                        <TreeItemLayout iconBefore={<Table20Regular />}>
                          Containers{containers ? ` (${containers.length})` : ''}
                        </TreeItemLayout>
                        <Tree>
                          {!containers && (
                            <TreeItem itemType="leaf" value={`c-loading-${db.name}`}>
                              <TreeItemLayout><Caption1>Expand the database to load…</Caption1></TreeItemLayout>
                            </TreeItem>
                          )}
                          {containers && containers.length === 0 && (
                            <TreeItem itemType="leaf" value={`c-empty-${db.name}`}>
                              <TreeItemLayout><Caption1>No containers</Caption1></TreeItemLayout>
                            </TreeItem>
                          )}
                          {(containers || []).filter((c) => match(c.name)).map((c) => {
                            const ctp = throughputLabel(c.throughput);
                            const scripts = scriptsByKey[`${db.name}|${c.name}`];
                            return (
                              <TreeItem key={c.name} itemType="branch" value={`scripts-${db.name}|${c.name}`}>
                                <TreeItemLayout iconBefore={<Table20Regular />}>
                                  <span className={s.rowLayout}>
                                    <span
                                      role="button" tabIndex={0}
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => onSelect?.({ db: db.name, container: c.name, partitionKey: c.partitionKey })}
                                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.({ db: db.name, container: c.name, partitionKey: c.partitionKey }); } }}
                                    >
                                      {c.name}
                                    </span>
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
                                  {/* Server-side scripts (read-only lists) */}
                                  <TreeItem itemType="leaf" value={`sp-${db.name}|${c.name}`}>
                                    <TreeItemLayout iconBefore={<Code20Regular />}>
                                      <span className={s.rowLayout}>
                                        <span>Stored procedures{scripts ? ` (${scripts.storedProcedures.length})` : ''}</span>
                                      </span>
                                    </TreeItemLayout>
                                  </TreeItem>
                                  {scripts?.storedProcedures.map((sp) => (
                                    <TreeItem key={`sp-${sp.name}`} itemType="leaf" value={`spx-${db.name}|${c.name}|${sp.name}`}>
                                      <TreeItemLayout iconBefore={<Code20Regular />}><Caption1>{sp.name}</Caption1></TreeItemLayout>
                                    </TreeItem>
                                  ))}
                                  <TreeItem itemType="leaf" value={`tg-${db.name}|${c.name}`}>
                                    <TreeItemLayout iconBefore={<Flow20Regular />}>
                                      <span>Triggers{scripts ? ` (${scripts.triggers.length})` : ''}</span>
                                    </TreeItemLayout>
                                  </TreeItem>
                                  {scripts?.triggers.map((tg) => (
                                    <TreeItem key={`tg-${tg.name}`} itemType="leaf" value={`tgx-${db.name}|${c.name}|${tg.name}`}>
                                      <TreeItemLayout iconBefore={<Flow20Regular />}>
                                        <span className={s.rowLayout}>
                                          <Caption1>{tg.name}</Caption1>
                                          <span className={s.rowActions}>
                                            {tg.triggerType && <Badge size="small" appearance="outline">{tg.triggerType}</Badge>}
                                            {tg.triggerOperation && <Caption1>{tg.triggerOperation}</Caption1>}
                                          </span>
                                        </span>
                                      </TreeItemLayout>
                                    </TreeItem>
                                  ))}
                                  <TreeItem itemType="leaf" value={`udf-${db.name}|${c.name}`}>
                                    <TreeItemLayout iconBefore={<ArrowSync20Regular />}>
                                      <span>User-defined functions{scripts ? ` (${scripts.userDefinedFunctions.length})` : ''}</span>
                                    </TreeItemLayout>
                                  </TreeItem>
                                  {scripts?.userDefinedFunctions.map((u) => (
                                    <TreeItem key={`udf-${u.name}`} itemType="leaf" value={`udfx-${db.name}|${c.name}|${u.name}`}>
                                      <TreeItemLayout iconBefore={<ArrowSync20Regular />}><Caption1>{u.name}</Caption1></TreeItemLayout>
                                    </TreeItem>
                                  ))}
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
                    </Tree>
                  </TreeItem>
                );
              })}
            </Tree>
          </TreeItem>

          {/* Honest "coming" rows — the portal Data Explorer exposes these
              data-plane surfaces; the navigator discloses them rather than
              faking them (per no-vaporware.md). */}
          <TreeItem itemType="branch" value="g-coming">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Indexing policy editor', 'Edit includedPaths/excludedPaths/composite indexes on the container resource (properties.resource.indexingPolicy); read/write not wired yet.'],
                ['Conflict resolution policy', 'Last-Writer-Wins vs custom stored-procedure conflict resolution for multi-region writes; not wired yet.'],
                ['Stored procedure / trigger / UDF authoring', 'Create/edit/execute script bodies (data-plane JS editor); the navigator lists existing scripts read-only for now.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`coming-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span className={s.mutedRow}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">coming</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
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

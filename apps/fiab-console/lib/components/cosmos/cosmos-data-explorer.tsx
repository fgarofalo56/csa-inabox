'use client';

/**
 * CosmosDataExplorer — the Items / document Data Explorer surface, parity with
 * the Azure portal Cosmos DB Data Explorer's "Items" tab.
 *
 * Workflow mirrored from the portal:
 *   - pick a database + container in the left navigator (CosmosTree); the host
 *     editor passes the selection in
 *   - a Monaco SQL query box (default `SELECT * FROM c`) + Execute button runs
 *     a real data-plane query (POST /api/cosmos/items)
 *   - a results grid lists the returned documents (id + partition-key value +
 *     a JSON viewer per row), with an RU-charge + doc-count readout and a
 *     "Load more" button driven by the continuation token
 *   - New / Edit (Monaco JSON) / Delete item actions hit the write route
 *     (POST /api/cosmos/items/action) on the real data plane
 *
 * Every control calls the real Cosmos data plane (no mocks). When the UAMI is
 * missing the Cosmos data-plane RBAC role the routes return 403 dataplane_rbac
 * and we render a Fluent warning MessageBar naming the exact role to grant —
 * the full Data Explorer surface still renders (per no-vaporware + ui-parity).
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Caption1, Badge, Spinner, Tooltip, Divider,
  Table, TableHeader, TableHeaderCell, TableRow, TableCell, TableBody,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Add20Regular, Edit16Regular, Delete16Regular,
  ArrowSync16Regular, ChevronDown16Regular, ChevronRight16Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const ITEMS_ROUTE = '/api/cosmos/items';
const ACTION_ROUTE = '/api/cosmos/items/action';
const DEFAULT_QUERY = 'SELECT * FROM c';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', minHeight: '0' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  spacer: { flex: '1' },
  readout: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  queryRow: { display: 'flex', gap: '8px', alignItems: 'flex-start' },
  queryBox: { flex: '1', minWidth: '0' },
  resultsWrap: { flex: '1', minHeight: '0', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px' },
  idCell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
  jsonPre: {
    margin: '0', padding: '8px', maxHeight: '280px', overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    borderRadius: '4px', whiteSpace: 'pre', color: tokens.colorNeutralForeground1,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  rowActions: { display: 'flex', gap: '2px', justifyContent: 'flex-end' },
});

export interface CosmosDataExplorerProps {
  db: string;
  container: string;
  /** Partition-key path of the container (e.g. "/tenantId"); drives writes. */
  partitionKey?: string;
  /** Seed query (the studio's "New SQL Query" tab opens with `SELECT * FROM c`). */
  initialQuery?: string;
}

interface CosmosDoc { [k: string]: unknown }

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

/** Derive the partition-key value from a doc + the container's pk path. */
function pkValue(doc: CosmosDoc, pkPath?: string): unknown {
  if (!pkPath) return (doc as any).id;
  const parts = pkPath.replace(/^\//, '').split('/').filter(Boolean);
  let cur: any = doc;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function pkDisplay(v: unknown): string {
  if (v === undefined) return '(none)';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function CosmosDataExplorer({ db, container, partitionKey, initialQuery }: CosmosDataExplorerProps) {
  const s = useStyles();

  const [query, setQuery] = useState(initialQuery || DEFAULT_QUERY);
  // Per-execution Query Stats (RU + count for the last Execute, like the studio).
  const [lastStats, setLastStats] = useState<{ charge: number; count: number } | null>(null);
  const [docs, setDocs] = useState<CosmosDoc[]>([]);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [requestCharge, setRequestCharge] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rbacGate, setRbacGate] = useState<{ role: string; hint: string } | null>(null);
  const [configGate, setConfigGate] = useState<{ missing: string; hint?: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // ---- item editor dialog ----
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'new' | 'edit'>('new');
  const [editorText, setEditorText] = useState('{\n  "id": ""\n}');
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the query + results when the selected container changes.
  useEffect(() => {
    setQuery(initialQuery || DEFAULT_QUERY);
    setLastStats(null);
    setDocs([]);
    setContinuation(null);
    setRequestCharge(0);
    setError(null);
    setRbacGate(null);
    setConfigGate(null);
    setExpanded(new Set());
  }, [db, container]);

  function applyGates(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) {
      setConfigGate({ missing: body.missing, hint: body.hint });
      return true;
    }
    if (body?.code === 'dataplane_rbac') {
      setRbacGate({ role: body.role || 'Cosmos DB Built-in Data Contributor', hint: body.hint || body.error });
      return true;
    }
    return false;
  }

  const runQuery = useCallback(async (opts: { append?: boolean } = {}) => {
    setLoading(true); setError(null);
    if (!opts.append) { setRbacGate(null); setConfigGate(null); }
    try {
      const r = await fetch(ITEMS_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          db, container,
          query: query.trim() || DEFAULT_QUERY,
          crossPartition: true,
          maxItems: 100,
          continuation: opts.append ? continuation : null,
        }),
      }).then(readJson);
      if (applyGates(r)) { setLoading(false); return; }
      if (!r.ok) { setError(r.error || 'query failed'); setLoading(false); return; }
      const page = r.documents || [];
      setDocs((prev) => opts.append ? [...prev, ...page] : page);
      setContinuation(r.continuation || null);
      setRequestCharge(opts.append ? requestCharge + (r.requestCharge || 0) : (r.requestCharge || 0));
      // Query Stats reflect the most recent Execute/page (real RU + row count).
      setLastStats({ charge: r.requestCharge || 0, count: page.length });
      if (!opts.append) setExpanded(new Set());
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [db, container, query, continuation, requestCharge]);

  // Auto-run the default query when a container is first selected.
  useEffect(() => {
    if (db && container) void runQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, container]);

  const openNew = useCallback(() => {
    setEditorMode('new');
    const seed: Record<string, unknown> = { id: '' };
    if (partitionKey && partitionKey !== '/id') {
      seed[partitionKey.replace(/^\//, '').split('/')[0]] = '';
    }
    setEditorText(JSON.stringify(seed, null, 2));
    setEditorError(null);
    setEditorOpen(true);
  }, [partitionKey]);

  const openEdit = useCallback((doc: CosmosDoc) => {
    setEditorMode('edit');
    setEditorText(JSON.stringify(doc, null, 2));
    setEditorError(null);
    setEditorOpen(true);
  }, []);

  const saveItem = useCallback(async () => {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(editorText);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('must be a JSON object');
    } catch (e: any) {
      setEditorError(`Invalid JSON: ${e?.message || e}`);
      return;
    }
    if (!('id' in doc) || String((doc as any).id || '').trim() === '') {
      setEditorError('The document must have a non-empty "id".');
      return;
    }
    setSaving(true); setEditorError(null);
    try {
      const r = await fetch(ACTION_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'upsert', db, container, document: doc, partitionKeyPath: partitionKey }),
      }).then(readJson);
      if (applyGates(r)) { setEditorOpen(false); setSaving(false); return; }
      if (!r.ok) { setEditorError(r.error || 'save failed'); setSaving(false); return; }
      setEditorOpen(false);
      await runQuery();
    } catch (e: any) {
      setEditorError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [editorText, db, container, partitionKey, runQuery]);

  const deleteDoc = useCallback(async (doc: CosmosDoc) => {
    const id = String((doc as any).id || '');
    if (!id) { setError('Cannot delete: document has no id.'); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch(ACTION_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'delete', db, container, id, partitionKey: pkValue(doc, partitionKey) }),
      }).then(readJson);
      if (applyGates(r)) { setLoading(false); return; }
      if (!r.ok) { setError(r.error || 'delete failed'); setLoading(false); return; }
      await runQuery();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [db, container, partitionKey, runQuery]);

  const toggleRow = useCallback((i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const pkLabel = useMemo(() => partitionKey || '/id', [partitionKey]);

  return (
    <div className={s.root}>
      {/* Config gate (env not wired) — honest, full surface still renders below. */}
      {configGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB account not configured</MessageBarTitle>
            Set <code>{configGate.missing}</code> on the Console Container App.{' '}
            {configGate.hint}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Data-plane RBAC gate (the big one this feature surfaces). */}
      {rbacGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB data-plane role required</MessageBarTitle>
            The Console managed identity can navigate this account but cannot read or
            write documents. Grant the{' '}
            <strong>{rbacGate.role}</strong> data-plane role to the UAMI via a Cosmos
            DB <code>sqlRoleAssignments</code>{' '}
            (<code>Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments</code>) at
            the account scope — the control-plane &quot;Cosmos DB Operator&quot; role
            does not grant document access. {rbacGate.hint}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.toolbar}>
        <Tooltip content="New item" relationship="label">
          <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={openNew}>New item</Button>
        </Tooltip>
        <Tooltip content="Run query (real Cosmos data-plane SQL)" relationship="label">
          <Button size="small" appearance="secondary" icon={<Play20Regular />} onClick={() => void runQuery()} disabled={loading}>Execute Query</Button>
        </Tooltip>
        <Tooltip content="Refresh" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={() => void runQuery()} disabled={loading} aria-label="Refresh" />
        </Tooltip>
        <span className={s.spacer} />
        <div className={s.readout}>
          <Badge size="small" appearance="tint">{docs.length} {docs.length === 1 ? 'item' : 'items'}</Badge>
          <Tooltip content="Cumulative RU request charge across all executed pages" relationship="label">
            <Badge size="small" appearance="tint" color="informative">{requestCharge.toFixed(2)} RU total</Badge>
          </Tooltip>
          {lastStats && (
            <Tooltip content="Query Stats — request charge + rows for the last Execute" relationship="label">
              <Badge size="small" appearance="outline" color="brand">
                Last: {lastStats.charge.toFixed(2)} RU · {lastStats.count} row{lastStats.count === 1 ? '' : 's'}
              </Badge>
            </Tooltip>
          )}
          <Caption1 className={s.muted}>pk {pkLabel}</Caption1>
          {loading && <Spinner size="tiny" />}
        </div>
      </div>

      <div className={s.queryRow}>
        <div className={s.queryBox}>
          <MonacoTextarea
            value={query}
            onChange={setQuery}
            language="sql"
            height={90}
            ariaLabel="Cosmos SQL query"
          />
        </div>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Query error</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.resultsWrap}>
        <Table size="small" aria-label="Cosmos documents">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: 36 }} />
              <TableHeaderCell>id</TableHeaderCell>
              <TableHeaderCell>{pkLabel}</TableHeaderCell>
              <TableHeaderCell style={{ width: 96, textAlign: 'right' }}>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={4}>
                  <Caption1 className={s.muted}>
                    {rbacGate || configGate
                      ? 'Resolve the gate above to load documents.'
                      : 'No documents. Run a query or create a New item.'}
                  </Caption1>
                </TableCell>
              </TableRow>
            )}
            {docs.map((doc, i) => {
              const id = String((doc as any).id ?? '');
              const isOpen = expanded.has(i);
              return (
                <Fragment key={`f-${i}-${id}`}>
                  <TableRow key={`r-${i}-${id}`}>
                    <TableCell>
                      <Button
                        size="small" appearance="subtle"
                        icon={isOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                        onClick={() => toggleRow(i)}
                        aria-label={isOpen ? `Collapse ${id}` : `Expand ${id}`}
                      />
                    </TableCell>
                    <TableCell className={s.idCell}>{id || <span className={s.muted}>(no id)</span>}</TableCell>
                    <TableCell className={s.idCell}>{pkDisplay(pkValue(doc, partitionKey))}</TableCell>
                    <TableCell>
                      <div className={s.rowActions}>
                        <Tooltip content="Edit JSON" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => openEdit(doc)} aria-label={`Edit ${id}`} />
                        </Tooltip>
                        <Tooltip content="Delete" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => void deleteDoc(doc)} aria-label={`Delete ${id}`} />
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow key={`j-${i}-${id}`}>
                      <TableCell colSpan={4}>
                        <pre className={s.jsonPre}>{JSON.stringify(doc, null, 2)}</pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {continuation && (
        <div>
          <Button size="small" appearance="subtle" onClick={() => void runQuery({ append: true })} disabled={loading}>
            Load more…
          </Button>
        </div>
      )}

      {/* Item editor dialog (Monaco JSON) — New / Edit. */}
      <Dialog open={editorOpen} onOpenChange={(_, d) => { if (!d.open) setEditorOpen(false); }}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>{editorMode === 'new' ? 'New item' : 'Edit item'}</DialogTitle>
            <DialogContent>
              <Caption1 className={s.muted} style={{ display: 'block', marginBottom: 6 }}>
                Container <code>{container}</code> · partition key <code>{pkLabel}</code>.
                The document must include an <code>id</code>{partitionKey && partitionKey !== '/id'
                  ? <> and the partition-key field (<code>{partitionKey}</code>)</>
                  : null}.
              </Caption1>
              <MonacoTextarea
                value={editorText}
                onChange={setEditorText}
                language="json"
                height={340}
                ariaLabel="Document JSON"
              />
              {editorError && (
                <MessageBar intent="error" style={{ marginTop: 10 }}>
                  <MessageBarBody><MessageBarTitle>Cannot save</MessageBarTitle>{editorError}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setEditorOpen(false)} disabled={saving}>Cancel</Button>
              <Button appearance="primary" onClick={() => void saveItem()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Divider />
      <Caption1 className={s.muted}>
        Documents are read and written over the real Cosmos DB data plane
        (<code>{db}/{container}/docs</code> on the account&apos;s
        <code> documents.azure.com</code> endpoint) using the Console managed
        identity. Cross-partition queries fan out automatically; deletes and
        upserts are scoped to the partition-key value derived from each document.
      </Caption1>
    </div>
  );
}

export default CosmosDataExplorer;

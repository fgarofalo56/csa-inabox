'use client';

/**
 * AnalyzeConnectionDialog — "Analyze data" for a SAVED Loom Connection. Once a
 * connection is added it is no longer a dead credential record: this dialog lets
 * you BROWSE its real schema → tables/views tree and PREVIEW the top rows of any
 * object, right from the Connections page. It is the connection-scoped twin of
 * the report designer's Navigator, pointed at the connection-keyed routes:
 *   • POST /api/connections/[id]/objects   → the lazy Fluent Tree (real introspect)
 *   • POST /api/connections/[id]/preview   → top-N rows (real SELECT/take)
 *
 * Real backend only (no-vaporware): every node + row is a live Azure read; any
 * introspection / preview failure surfaces an honest Fluent MessageBar naming the
 * verbatim backend remediation (env / role / connection). NO Fabric / Power BI /
 * OneLake host is reached (no-fabric-dependency). Fluent v9 + Loom tokens; no
 * hard-coded px / hex (web3-ui).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Spinner, Caption1, Subtitle1, Subtitle2,
  Tooltip, Tree, TreeItem, TreeItemLayout, SearchBox,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss24Regular, DatabaseSearch20Regular, Database20Regular,
  Table20Regular, DocumentTable20Regular, Folder20Regular,
  DocumentDatabase20Regular, ArrowClockwise20Regular,
  TableSearch20Regular, Eye20Regular, DatabasePlugConnected20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { CONN_TYPE_LABEL } from '@/lib/azure/connectable-types';
import type { ConnectionType } from '@/lib/azure/connections-store';

/** One node in the browse tree (the /objects `nodes` wire shape). */
interface NavNode {
  id: string;
  name: string;
  kind: 'catalog' | 'database' | 'schema' | 'folder' | 'table' | 'view' | 'container' | 'file';
  expandable?: boolean;
  childToken?: string;
  selectable?: boolean;
  objectRef?: unknown;
  schema?: string;
  meta?: { format?: string; rowEstimate?: number; type?: string };
}

interface PreviewData { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }

const useStyles = makeStyles({
  surface: { maxWidth: '1120px', width: '94vw' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  split: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 360px) minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    minHeight: 0, minWidth: 0,
  },
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minWidth: 0, minHeight: 0,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalM,
  },
  paneHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  spacer: { flex: 1 },
  treeScroll: { overflowY: 'auto', overflowX: 'hidden', minHeight: '46vh', maxHeight: '60vh', minWidth: 0 },
  rowLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%', minWidth: 0 },
  rowName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, cursor: 'pointer' },
  rowMeta: { marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexShrink: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  statePad: { padding: tokens.spacingVerticalS },
  previewScroll: {
    overflow: 'auto', minHeight: '46vh', maxHeight: '60vh', minWidth: 0,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalS,
  },
  cell: { whiteSpace: 'nowrap', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block' },
});

function nodeIcon(kind: NavNode['kind']): ReactElement {
  switch (kind) {
    case 'catalog':
    case 'database': return <Database20Regular />;
    case 'schema':
    case 'folder': return <Folder20Regular />;
    case 'view': return <DocumentTable20Regular />;
    case 'container': return <DocumentDatabase20Regular />;
    case 'file': return <DocumentTable20Regular />;
    case 'table':
    default: return <Table20Regular />;
  }
}

function nodeLabel(n: NavNode): string {
  return n.schema ? `${n.schema}.${n.name}` : n.name;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

export interface AnalyzeConnectionDialogProps {
  open: boolean;
  connectionId: string;
  connectionName: string;
  connType: ConnectionType;
  onDismiss: () => void;
}

export function AnalyzeConnectionDialog({
  open, connectionId, connectionName, connType, onDismiss,
}: AnalyzeConnectionDialogProps) {
  const s = useStyles();

  const objectsUrl = `/api/connections/${encodeURIComponent(connectionId)}/objects`;
  const previewUrl = `/api/connections/${encodeURIComponent(connectionId)}/preview`;

  const [rootNodes, setRootNodes] = useState<NavNode[] | null>(null);
  const [rootErr, setRootErr] = useState<{ error: string; missing?: string } | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [childrenByToken, setChildrenByToken] = useState<Record<string, NavNode[]>>({});
  const [childErrByToken, setChildErrByToken] = useState<Record<string, string>>({});
  const [loadingTokens, setLoadingTokens] = useState<Set<string>>(new Set());
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const nodesById = useRef<Map<string, NavNode>>(new Map());
  const [filter, setFilter] = useState('');

  const [highlighted, setHighlighted] = useState<NavNode | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewErr, setPreviewErr] = useState<{ error: string; missing?: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const registerNodes = useCallback((nodes: NavNode[]) => {
    for (const n of nodes) nodesById.current.set(n.id, n);
  }, []);

  const fetchLevel = useCallback(async (parentToken: string | null): Promise<
    { ok: true; nodes: NavNode[] } | { ok: false; error: string; missing?: string }
  > => {
    try {
      const r = await clientFetch(
        objectsUrl,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: parentToken }) },
        30000,
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) return { ok: false, error: j?.error || `HTTP ${r.status}`, missing: j?.missing };
      return { ok: true, nodes: Array.isArray(j.nodes) ? j.nodes : [] };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, [objectsUrl]);

  const loadRoots = useCallback(async () => {
    setRootLoading(true); setRootErr(null);
    const res = await fetchLevel(null);
    if (res.ok) { registerNodes(res.nodes); setRootNodes(res.nodes); }
    else { setRootNodes([]); setRootErr({ error: res.error, missing: res.missing }); }
    setRootLoading(false);
  }, [fetchLevel, registerNodes]);

  const loadChildren = useCallback(async (node: NavNode) => {
    const token = node.childToken;
    if (!token || childrenByToken[token]) return;
    setLoadingTokens((prev) => new Set(prev).add(token));
    setChildErrByToken((m) => { const n = { ...m }; delete n[token]; return n; });
    const res = await fetchLevel(token);
    if (res.ok) {
      registerNodes(res.nodes);
      setChildrenByToken((m) => ({ ...m, [token]: res.nodes }));
    } else {
      setChildErrByToken((m) => ({ ...m, [token]: res.missing ? `${res.error} (set ${res.missing})` : res.error }));
    }
    setLoadingTokens((prev) => { const n = new Set(prev); n.delete(token); return n; });
  }, [childrenByToken, fetchLevel, registerNodes]);

  useEffect(() => {
    if (!open) return;
    nodesById.current = new Map();
    setRootNodes(null); setRootErr(null);
    setChildrenByToken({}); setChildErrByToken({}); setLoadingTokens(new Set());
    setOpenItems(new Set());
    setHighlighted(null); setPreview(null); setPreviewErr(null);
    setFilter('');
    void loadRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId]);

  const onOpenChange = useCallback((_: unknown, data: { open: boolean; value: unknown }) => {
    const value = String(data.value);
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (data.open) next.add(value); else next.delete(value);
      return next;
    });
    if (!data.open) return;
    const node = nodesById.current.get(value);
    if (node && node.expandable && node.childToken) void loadChildren(node);
  }, [loadChildren]);

  const runPreview = useCallback(async (node: NavNode) => {
    setHighlighted(node);
    setPreview(null); setPreviewErr(null);
    if (!node.selectable || !node.objectRef) return;
    setPreviewLoading(true);
    try {
      const r = await clientFetch(
        previewUrl,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectRef: node.objectRef, limit: 100 }) },
        30000,
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setPreviewErr({ error: j?.error || `HTTP ${r.status}`, missing: j?.missing }); return; }
      setPreview({ columns: j.columns || [], rows: j.rows || [], truncated: !!j.truncated });
    } catch (e: any) {
      setPreviewErr({ error: e?.message || String(e) });
    } finally {
      setPreviewLoading(false);
    }
  }, [previewUrl]);

  const filterMatch = useCallback((name: string) => {
    const f = filter.trim().toLowerCase();
    return !f || name.toLowerCase().includes(f);
  }, [filter]);

  const renderNodes = useCallback((nodes: NavNode[]): ReactElement[] => {
    return nodes
      .filter((n) => filterMatch(n.name) || n.expandable)
      .map((node) => {
        const isBranch = !!(node.expandable && node.childToken);
        const meta = node.meta;
        const metaBadge = meta?.format || meta?.type
          || (typeof meta?.rowEstimate === 'number' ? `${meta.rowEstimate.toLocaleString()} rows` : '');

        const layout = (
          <TreeItemLayout iconBefore={nodeIcon(node.kind)}>
            <span className={s.rowLayout}>
              <span
                className={s.rowName}
                title={node.name}
                onClick={(e) => { if (node.selectable) { e.stopPropagation(); void runPreview(node); } }}
              >
                {node.name}
              </span>
              <span className={s.rowMeta}>
                {metaBadge && <Badge size="small" appearance="tint" color="informative">{metaBadge}</Badge>}
                {node.selectable && (
                  <Tooltip content="Preview top 100 rows" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<Eye20Regular />}
                      aria-label={`Preview ${node.name}`}
                      onClick={(e) => { e.stopPropagation(); void runPreview(node); }}
                    />
                  </Tooltip>
                )}
              </span>
            </span>
          </TreeItemLayout>
        );

        if (!isBranch) {
          return <TreeItem key={node.id} itemType="leaf" value={node.id}>{layout}</TreeItem>;
        }

        const token = node.childToken as string;
        const kids = childrenByToken[token];
        const kidErr = childErrByToken[token];
        const kidLoading = loadingTokens.has(token);
        return (
          <TreeItem key={node.id} itemType="branch" value={node.id}>
            {layout}
            <Tree>
              {kidLoading && !kids && (
                <TreeItem itemType="leaf" value={`${node.id}::loading`}>
                  <TreeItemLayout><Spinner size="tiny" label="Loading objects…" /></TreeItemLayout>
                </TreeItem>
              )}
              {kidErr && (
                <TreeItem itemType="leaf" value={`${node.id}::err`}>
                  <TreeItemLayout><Caption1 className={s.muted}>{kidErr}</Caption1></TreeItemLayout>
                </TreeItem>
              )}
              {kids && kids.length === 0 && !kidErr && (
                <TreeItem itemType="leaf" value={`${node.id}::empty`}>
                  <TreeItemLayout><Caption1 className={s.muted}>No objects</Caption1></TreeItemLayout>
                </TreeItem>
              )}
              {kids && kids.length > 0 && renderNodes(kids)}
              {!kids && !kidLoading && !kidErr && (
                <TreeItem itemType="leaf" value={`${node.id}::hint`}>
                  <TreeItemLayout><Caption1 className={s.muted}>Expand to load…</Caption1></TreeItemLayout>
                </TreeItem>
              )}
            </Tree>
          </TreeItem>
        );
      });
  }, [s, childrenByToken, childErrByToken, loadingTokens, filterMatch, runPreview]);

  const typeLabel = useMemo(() => CONN_TYPE_LABEL[connType] || connType, [connType]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onDismiss(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={onDismiss} />}
          >
            <span className={s.titleRow}>
              <DatabaseSearch20Regular />
              <Subtitle1>Analyze data</Subtitle1>
              <Badge appearance="tint" color="brand" size="small">
                <DatabasePlugConnected20Regular /> {connectionName} · {typeLabel}
              </Badge>
              <Badge appearance="outline" color="subtle" size="small">Azure-native · no Fabric required</Badge>
            </span>
          </DialogTitle>

          <DialogContent>
            <div className={s.split}>
              {/* LEFT — object tree */}
              <div className={s.pane}>
                <div className={s.paneHead}>
                  <Subtitle2>Objects</Subtitle2>
                  <span className={s.spacer} />
                  <Tooltip content="Refresh" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<ArrowClockwise20Regular />}
                      aria-label="Refresh objects" disabled={rootLoading} onClick={() => void loadRoots()}
                    />
                  </Tooltip>
                </div>

                <SearchBox
                  placeholder="Filter objects…"
                  value={filter}
                  onChange={(_, d) => setFilter(d.value)}
                  aria-label="Filter objects"
                />

                {rootLoading && rootNodes === null && (
                  <div className={s.statePad}><Spinner size="tiny" label="Introspecting the connection…" /></div>
                )}

                {rootErr && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Could not browse this connection</MessageBarTitle>
                      {rootErr.error}{rootErr.missing ? ` — set ${rootErr.missing}.` : ''}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {rootNodes && rootNodes.length === 0 && !rootErr && (
                  <EmptyState
                    icon={<DatabaseSearch20Regular />}
                    title="No objects found"
                    body="This connection exposed no tables, views, or containers. Check its database / catalog, or your RBAC on it."
                  />
                )}

                {rootNodes && rootNodes.length > 0 && (
                  <div className={s.treeScroll}>
                    <Tree
                      aria-label="Connection objects"
                      openItems={Array.from(openItems)}
                      onOpenChange={onOpenChange as any}
                    >
                      {renderNodes(rootNodes)}
                    </Tree>
                  </div>
                )}
              </div>

              {/* RIGHT — preview */}
              <div className={s.pane}>
                <div className={s.paneHead}>
                  <Subtitle2>Preview</Subtitle2>
                  {highlighted && <Caption1 className={s.muted}>{nodeLabel(highlighted)}</Caption1>}
                  <span className={s.spacer} />
                  {highlighted?.selectable && (
                    <Tooltip content="Reload preview" relationship="label">
                      <Button
                        size="small" appearance="subtle" icon={<TableSearch20Regular />}
                        aria-label="Reload preview" disabled={previewLoading}
                        onClick={() => highlighted && void runPreview(highlighted)}
                      />
                    </Tooltip>
                  )}
                </div>

                {!highlighted && (
                  <EmptyState
                    icon={<Eye20Regular />}
                    title="Select an object to preview"
                    body="Click a table, view, or container in the tree to see its first 100 rows — a real read against the live Azure backend."
                  />
                )}

                {previewLoading && (
                  <div className={s.statePad}><Spinner size="tiny" label="Reading top 100 rows…" /></div>
                )}

                {previewErr && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Could not preview</MessageBarTitle>
                      {previewErr.error}{previewErr.missing ? ` — set ${previewErr.missing}.` : ''}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {preview && preview.columns.length > 0 && (
                  <div className={s.previewScroll}>
                    <Caption1 className={s.muted}>
                      {preview.rows.length} row(s){preview.truncated ? ' (truncated to 100)' : ''}
                    </Caption1>
                    <Table size="small" aria-label="Object preview">
                      <TableHeader>
                        <TableRow>
                          {preview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.rows.map((row, i) => (
                          <TableRow key={i}>
                            {preview.columns.map((c) => (
                              <TableCell key={c}><span className={s.cell}>{formatCell(row[c])}</span></TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {preview && preview.columns.length === 0 && !previewErr && !previewLoading && (
                  <Caption1 className={s.muted}>The object returned no columns.</Caption1>
                )}
              </div>
            </div>
          </DialogContent>

          <DialogActions>
            <Button appearance="secondary" onClick={onDismiss}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default AnalyzeConnectionDialog;

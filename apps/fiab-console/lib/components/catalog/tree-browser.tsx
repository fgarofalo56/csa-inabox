'use client';

/**
 * TreeBrowser — generic lazy-loaded tree rooted at a single source. Each
 * node click expands by hitting /api/catalog/browse with the path so far.
 *
 * This intentionally avoids a heavy tree library — Fluent's Tree is fine
 * but doesn't lazy-load well. We render an indented list with disclosure
 * triangles and cache children in a Map keyed by `source|path|`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Caption1, makeStyles, tokens, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { ChevronRight16Regular, ChevronDown16Regular, Folder16Regular, Document16Regular, Open16Regular } from '@fluentui/react-icons';

interface TreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren: boolean;
  meta?: Record<string, unknown>;
}

const useStyles = makeStyles({
  root: { fontFamily: 'var(--loom-font-mono, monospace)', fontSize: 13 },
  row: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 4, cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover } },
  rowActive: { backgroundColor: tokens.colorBrandBackground2 },
  kind: { color: tokens.colorNeutralForeground3, fontSize: 11, marginLeft: 4 },
  err: { color: tokens.colorPaletteRedForeground1, fontSize: 12, padding: 8 },
});

interface Props {
  source: 'purview' | 'unity-catalog' | 'onelake';
  onSelect?: (node: TreeNode, path: string[]) => void;
}

export function TreeBrowser({ source, onSelect }: Props) {
  const s = useStyles();
  const [roots, setRoots] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, TreeNode[]>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const fetchPath = useCallback(async (path: string[]): Promise<TreeNode[]> => {
    const params = new URLSearchParams({ source });
    if (path.length) params.set('path', path.join('|'));
    const r = await fetch(`/api/catalog/browse?${params.toString()}`);
    const j = await r.json();
    if (!j.ok) {
      const err = new Error(j.error || 'browse failed');
      (err as any).hint = j.hint;
      throw err;
    }
    return j.nodes as TreeNode[];
  }, [source]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setHint(null);
    fetchPath([]).then((nodes) => { if (alive) { setRoots(nodes); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e?.message || String(e)); setHint(e?.hint); setLoading(false); } });
    return () => { alive = false; };
  }, [source, fetchPath]);

  async function toggle(node: TreeNode, parentPath: string[]) {
    const key = [...parentPath, node.id].join('|');
    if (expanded.has(key)) {
      const next = new Set(expanded); next.delete(key); setExpanded(next);
      return;
    }
    if (!children.has(key)) {
      const nb = new Set(busy); nb.add(key); setBusy(nb);
      try {
        const kids = await fetchPath([...parentPath, node.id]);
        const nc = new Map(children); nc.set(key, kids); setChildren(nc);
      } catch (e: any) {
        const nc = new Map(children); nc.set(key, [{ id: '_err', label: e?.message || 'failed', kind: 'error', hasChildren: false }]); setChildren(nc);
      } finally {
        const nb2 = new Set(busy); nb2.delete(key); setBusy(nb2);
      }
    }
    const next = new Set(expanded); next.add(key); setExpanded(next);
  }

  function renderNode(node: TreeNode, depth: number, parentPath: string[]) {
    const key = [...parentPath, node.id].join('|');
    const isExpanded = expanded.has(key);
    const isBusy = busy.has(key);
    const childNodes = children.get(key);
    const Chev = isExpanded ? ChevronDown16Regular : ChevronRight16Regular;
    const Icon = node.hasChildren ? Folder16Regular : Document16Regular;
    return (
      <div key={key}>
        <div
          className={s.row}
          style={{ paddingLeft: 6 + depth * 16 }}
          onClick={() => {
            if (node.hasChildren) toggle(node, parentPath);
            else if (onSelect) onSelect(node, parentPath);
          }}
          role="treeitem"
          aria-expanded={node.hasChildren ? isExpanded : undefined}
          tabIndex={0}
        >
          {node.hasChildren ? <Chev /> : <span style={{ width: 16 }} />}
          <Icon />
          <span>{node.label}</span>
          <span className={s.kind}>{node.kind}</span>
          {isBusy && <Spinner size="tiny" />}
        </div>
        {isExpanded && childNodes && childNodes.map((c) => renderNode(c, depth + 1, [...parentPath, node.id]))}
      </div>
    );
  }

  if (loading) return <Spinner label="Loading tree…" />;
  if (error) return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <strong>Tree unavailable:</strong> {error}
        {hint && <pre style={{ fontSize: 11, marginTop: 8, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}
      </MessageBarBody>
    </MessageBar>
  );
  if (!roots || roots.length === 0) return <Caption1>No nodes returned for this source.</Caption1>;

  return (
    <div className={s.root} role="tree" aria-label={`Browse ${source}`}>
      {roots.map((r) => renderNode(r, 0, []))}
    </div>
  );
}

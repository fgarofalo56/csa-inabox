'use client';

/**
 * TreeBrowser — generic lazy-loaded tree rooted at a single source. Each
 * node click expands by hitting /api/catalog/browse with the path so far.
 *
 * This intentionally avoids a heavy tree library — Fluent's Tree is fine
 * but doesn't lazy-load well. We render an indented list with disclosure
 * triangles and cache children in a Map keyed by `source|path|`.
 *
 * Node kinds the route emits:
 *   - unity-catalog: metastore | catalog | schema | table | volume | gate
 *   - onelake:       workspace | <fabric item type, lower-cased>
 *   - purview:       domain | data-product
 *
 * The `gate` kind is an honest infra/permission gate (e.g. the Databricks
 * account-admin 403 on metastore listing). It renders an inline MessageBar
 * with remediation steps instead of leaking a raw REST error into the tree,
 * and the rest of the tree still renders.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Caption1, makeStyles, tokens, MessageBar, MessageBarBody, MessageBarTitle,
  Link, Button, Tooltip,
} from '@fluentui/react-components';
import {
  ChevronRight16Regular, ChevronDown16Regular,
  ChevronDoubleRight16Regular, ChevronDoubleLeft16Regular,
  Folder16Regular, Document16Regular,
  Database16Regular, DatabaseStack16Regular, Table16Regular, FolderOpen16Regular,
  Box16Regular, DocumentData16Regular, Notebook16Regular, Flow16Regular,
  DataHistogram16Regular, BranchRequest16Regular,
  FolderOpen20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

interface TreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren: boolean;
  meta?: Record<string, unknown>;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '13px' },
  sourceBar: { marginBottom: '10px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '30px',
    padding: '4px 10px 4px 6px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
  },
  rowLeaf: { cursor: 'default' },
  chevron: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  icon: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
  },
  label: {
    flexGrow: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground1,
  },
  kindBadge: {
    flexShrink: 0,
    fontSize: '11px',
    lineHeight: '16px',
    padding: '0 8px',
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground3,
    textTransform: 'lowercase',
  },
  spinnerSlot: { display: 'flex', alignItems: 'center', flexShrink: 0 },
  gateRow: { padding: '4px 6px' },
  gateBar: { width: '100%' },
  remList: { margin: '6px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' },
});

/** Map a node kind to a Fluent icon. Falls back to folder/document. */
function iconFor(kind: string, hasChildren: boolean) {
  switch (kind) {
    case 'metastore': return DatabaseStack16Regular;
    case 'catalog': return Database16Regular;
    case 'schema': return FolderOpen16Regular;
    case 'table': return Table16Regular;
    case 'volume': return Box16Regular;
    case 'workspace': return Folder16Regular;
    case 'lakehouse': return DatabaseStack16Regular;
    case 'warehouse': return Database16Regular;
    case 'kqldatabase': return DataHistogram16Regular;
    case 'semanticmodel': return DocumentData16Regular;
    case 'report': return DocumentData16Regular;
    case 'notebook': return Notebook16Regular;
    case 'datapipeline':
    case 'pipeline': return Flow16Regular;
    case 'mirroreddatabase': return Database16Regular;
    case 'dataflow': return BranchRequest16Regular;
    case 'domain': return Folder16Regular;
    case 'data-product': return Box16Regular;
    default: return hasChildren ? Folder16Regular : Document16Regular;
  }
}

interface Props {
  source: 'purview' | 'unity-catalog' | 'onelake';
  onSelect?: (node: TreeNode, path: string[]) => void;
}

const SOURCE_BANNER: Record<Props['source'], { title: string; body: string } | null> = {
  'unity-catalog': null,
  purview: null,
  onelake: {
    title: 'OneLake — CSA Loom workspaces',
    body: 'The CSA Loom workspaces the Console identity can see. Expand a workspace to browse its OneLake items — lakehouses, warehouses, semantic models, reports, KQL databases, notebooks, and pipelines.',
  },
};

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
    setExpanded(new Set()); setChildren(new Map());
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
        const nc = new Map(children);
        nc.set(key, [{
          id: '_err',
          label: e?.message || 'failed to load',
          kind: 'gate',
          hasChildren: false,
          meta: { title: 'Could not load children', detail: e?.message || 'Unknown error', reason: e?.message },
        }]);
        setChildren(nc);
      } finally {
        const nb2 = new Set(busy); nb2.delete(key); setBusy(nb2);
      }
    }
    const next = new Set(expanded); next.add(key); setExpanded(next);
  }

  function renderGate(node: TreeNode, depth: number, key: string) {
    const m = (node.meta || {}) as Record<string, any>;
    const title = m.title || 'Not available';
    const detail = m.detail || m.reason || node.label;
    const remediation: string[] = Array.isArray(m.remediation) ? m.remediation : [];
    return (
      <div key={key} className={s.gateRow} style={{ paddingLeft: 6 + depth * 18 }}>
        <MessageBar intent="warning" className={s.gateBar}>
          <MessageBarBody>
            <MessageBarTitle>{title}</MessageBarTitle>
            <div>{detail}</div>
            {remediation.length > 0 && (
              <ul className={s.remList}>
                {remediation.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
            {m.learnMore && (
              <div style={{ marginTop: tokens.spacingVerticalSNudge }}>
                <Link href={m.learnMore} target="_blank" rel="noreferrer">Learn more</Link>
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  function renderNode(node: TreeNode, depth: number, parentPath: string[]) {
    const key = [...parentPath, node.id].join('|');
    if (node.kind === 'gate' || node.kind === 'error') return renderGate(node, depth, key);

    const isExpanded = expanded.has(key);
    const isBusy = busy.has(key);
    const childNodes = children.get(key);
    const Chev = isExpanded ? ChevronDown16Regular : ChevronRight16Regular;
    const Icon = iconFor(node.kind, node.hasChildren);
    const typeSuffix = (node.meta?.type as string) || node.kind;

    return (
      <div key={key} role="group">
        <div
          className={`${s.row} ${node.hasChildren ? '' : s.rowLeaf}`}
          style={{ paddingLeft: 6 + depth * 18 }}
          onClick={() => {
            if (node.hasChildren) toggle(node, parentPath);
            else if (onSelect) onSelect(node, parentPath);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (node.hasChildren) toggle(node, parentPath);
              else if (onSelect) onSelect(node, parentPath);
            } else if (e.key === 'ArrowRight' && node.hasChildren && !isExpanded) {
              toggle(node, parentPath);
            } else if (e.key === 'ArrowLeft' && node.hasChildren && isExpanded) {
              toggle(node, parentPath);
            }
          }}
          role="treeitem"
          aria-expanded={node.hasChildren ? isExpanded : undefined}
          aria-label={`${node.label} (${typeSuffix})`}
          tabIndex={0}
        >
          <span className={s.chevron}>{node.hasChildren ? <Chev /> : null}</span>
          <span className={s.icon}><Icon /></span>
          <span className={s.label} title={node.label}>{node.label}</span>
          <span className={s.kindBadge}>{typeSuffix}</span>
          {isBusy && <span className={s.spinnerSlot}><Spinner size="tiny" /></span>}
        </div>
        {isExpanded && childNodes && (
          childNodes.length === 0
            ? (
              <Caption1
                style={{ paddingLeft: 6 + (depth + 1) * 18, display: 'block', padding: '4px 0', color: tokens.colorNeutralForeground3 }}
                role="status"
                aria-label="No items in this folder"
              >
                No items in this folder
              </Caption1>
            )
            : childNodes.map((c) => renderNode(c, depth + 1, [...parentPath, node.id]))
        )}
      </div>
    );
  }

  if (loading) return <Spinner label="Loading tree…" />;
  if (error) return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Tree unavailable</MessageBarTitle>
        <div>{error}</div>
        {hint && <pre style={{ fontSize: tokens.fontSizeBase100, marginTop: tokens.spacingVerticalS, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}
      </MessageBarBody>
    </MessageBar>
  );

  const banner = SOURCE_BANNER[source];

  return (
    <div>
      {banner && (
        <MessageBar intent="info" className={s.sourceBar}>
          <MessageBarBody>
            <MessageBarTitle>{banner.title}</MessageBarTitle>
            <div>{banner.body}</div>
          </MessageBarBody>
        </MessageBar>
      )}
      {(!roots || roots.length === 0)
        ? (
          <EmptyState
            icon={<FolderOpen20Regular />}
            title="Nothing to browse"
            body="No items were returned for this source. The service may not be configured or the Console identity may not have read access."
          />
        )
        : (
          <>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', padding: '2px 0 6px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, marginBottom: tokens.spacingVerticalXS }}>
              <Tooltip content="Expand all top-level nodes" relationship="label">
                <Button size="small" appearance="subtle" icon={<ChevronDoubleRight16Regular />}
                  onClick={() => { (roots || []).forEach((r) => { if (r.hasChildren && !expanded.has(r.id)) toggle(r, []); }); }}>
                  Expand all
                </Button>
              </Tooltip>
              <Tooltip content="Collapse every expanded node" relationship="label">
                <Button size="small" appearance="subtle" icon={<ChevronDoubleLeft16Regular />}
                  onClick={() => setExpanded(new Set())} disabled={expanded.size === 0}>
                  Collapse all
                </Button>
              </Tooltip>
              <Caption1 style={{ marginLeft: 'auto', color: tokens.colorNeutralForeground3 }}>{expanded.size} open</Caption1>
            </div>
            <div className={s.root} role="tree" aria-label={`Browse ${source}`}>
              {roots.map((r) => renderNode(r, 0, []))}
            </div>
          </>
        )}
    </div>
  );
}

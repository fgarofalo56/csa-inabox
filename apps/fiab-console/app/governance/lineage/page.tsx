'use client';

/**
 * /governance/lineage — the UNIFIED Loom lineage surface.
 *
 * One page, one shared canvas (@xyflow/react `LineageCanvas`), a SCOPE switch:
 *
 *   • Governed  — every item in the caller's tenant, edges derived from typed
 *     references in each item's state (GET /api/governance/lineage). Overlays
 *     the label-propagation status as a per-node corner pip. When Microsoft
 *     Purview is bound, its lineage edges merge in — but Purview is NOT
 *     required, so the surface is NOT named "Purview lineage".
 *   • Mesh      — the caller's Weave / Thread integration graph, "what feeds
 *     what" across editors (GET /api/thread/edges).
 *   • Federated — cross-source lineage for a single resolved asset (Purview
 *     entity GUID / Unity Catalog table / OneLake workspace) via the shared
 *     LineagePanel (GET /api/catalog/lineage/item).
 *
 * All three scopes render on the SAME theme-aware LineageCanvas + itemVisual()
 * registry, so /thread (Mesh) and /catalog/lineage (Federated) — the sibling
 * lineage entry points — look and behave identically. `?scope=` selects the
 * scope; `?focusId=` (Governed) focuses one item's chain.
 */

import { clientFetch } from '@/lib/client-fetch';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Spinner, Badge, Body1, Button, Input, Field, Dropdown, Option,
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Flowchart24Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { Toolbar } from '@/lib/components/ui/section';
import {
  LineageCanvas, type CanvasLineageNode, type CanvasLineageEdge,
} from '@/lib/components/catalog/lineage-canvas';
import { LineagePanel } from '@/lib/components/catalog/lineage-panel';
import {
  STATUS_LABEL, type PropagationStatus,
} from '@/lib/governance/label-propagation';

// ── Scopes ──────────────────────────────────────────────────────────────────

type Scope = 'governed' | 'mesh' | 'federated';
const SCOPES: { value: Scope; label: string; hint: string }[] = [
  { value: 'governed',  label: 'Governed',  hint: 'Every item in your tenant, edges from typed references in item state (Purview edges merged when bound).' },
  { value: 'mesh',      label: 'Mesh',      hint: 'Your Weave / Thread integration graph — what feeds what across editors.' },
  { value: 'federated', label: 'Federated', hint: 'Cross-source lineage for one resolved asset — Purview + Unity Catalog + OneLake.' },
];

// ── Governed-scope wire model (GET /api/governance/lineage) ──────────────────

interface NodePropagation {
  status: PropagationStatus; currentLabel: string; expectedLabel: string; lastRunAt?: string;
}
interface GovNode {
  id: string; label: string; type: string; workspaceId: string; propagation?: NodePropagation;
}
interface GovEdge { from: string; to: string; via: string; }

/** SVG dot fill per propagation status — mirrors the governance STATUS_COLOR tokens. */
const PROP_DOT: Record<PropagationStatus, string> = {
  'in-sync': '#0e700e',
  pending: '#bc4b09',
  overridden: '#0f6cbd',
  unlabeled: '#8a8886',
  'no-upstream': '#c8c6c4',
};

// ── Mesh-scope wire model (GET /api/thread/edges) ────────────────────────────

interface ThreadEdge {
  id: string;
  fromItemId: string; fromType: string; fromName?: string;
  toItemId: string; toType: string; toName?: string;
  toExternal?: boolean; toLink?: string;
  action: string; createdAt: string;
}
const ACTION_LABEL: Record<string, string> = {
  'analyze-in-notebook': 'Analyze in a Notebook',
  'add-data-agent-source': 'Data Agent source',
  'build-powerbi-model': 'Power BI model',
  'publish-as-api': 'Published as API',
};

const useStyles = makeStyles({
  legend: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL, alignItems: 'center',
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
  },
  hint: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  fedForm: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) auto',
    gap: tokens.spacingHorizontalM, alignItems: 'flex-end',
    maxWidth: '100%', marginBottom: tokens.spacingVerticalL,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
  },
});

// ── Governed scope ───────────────────────────────────────────────────────────

function GovernedScope({ focusId }: { focusId: string | null }) {
  const s = useStyles();
  const [nodes, setNodes] = useState<GovNode[]>([]);
  const [edges, setEdges] = useState<GovEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [propMeta, setPropMeta] = useState<{ source: string; lastRunAt: string | null; pending: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/governance/lineage');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setNodes(j.nodes || []);
      setEdges(j.edges || []);
      setSource(j.source || 'cosmos');
      setPropMeta(j.propagation || null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Adapt the governance graph onto the shared LineageCanvas model. Types stay
  // Loom slugs so styleForType()/itemVisual() draw the canonical brand visual;
  // label-propagation status rides along as a corner pip.
  const canvasNodes: CanvasLineageNode[] = useMemo(() => nodes.map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    source: 'loom',
    openHref: `/items/${n.type}/${n.id}`,
    statusDot: n.propagation ? {
      color: PROP_DOT[n.propagation.status],
      title:
        `${STATUS_LABEL[n.propagation.status]}` +
        (n.propagation.expectedLabel ? ` — expected: ${n.propagation.expectedLabel}` : '') +
        (n.propagation.currentLabel ? ` · current: ${n.propagation.currentLabel}` : ''),
    } : undefined,
  })), [nodes]);
  const canvasEdges: CanvasLineageEdge[] = useMemo(
    () => edges.map((e) => ({ from: e.from, to: e.to, type: e.via })),
    [edges],
  );

  return (
    <>
      <Toolbar
        actions={
          <>
            <Badge appearance="tint" color="informative" size="medium">{nodes.length} items</Badge>
            <Badge appearance="tint" color="informative" size="medium">{edges.length} edges</Badge>
            <Badge appearance="outline" color={source === 'purview' ? 'brand' : 'informative'} size="small">
              source: {source || 'catalog'}
            </Badge>
            {propMeta && (
              <Badge
                appearance="tint"
                color={propMeta.pending > 0 ? 'warning' : 'success'}
                size="large"
                title={
                  propMeta.lastRunAt
                    ? `Label propagation last ran ${new Date(propMeta.lastRunAt).toLocaleString()} (source: ${propMeta.source})`
                    : 'Label-propagation timer Function has not written state yet — status shown is computed live'
                }
              >
                {propMeta.pending > 0 ? `${propMeta.pending} label propagation pending` : 'Labels in sync'}
              </Badge>
            )}
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          </>
        }
      />

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load lineage</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Building lineage graph…" />}

      {!loading && !error && canvasNodes.length === 0 && (
        <MessageBar>
          <MessageBarBody>
            No items found in your workspaces yet. Create a notebook, lakehouse, or pipeline and edges will start appearing here.
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && !error && canvasNodes.length > 0 && (
        <>
          <LineageCanvas nodes={canvasNodes} edges={canvasEdges} focusId={focusId || undefined} />
          <div className={s.legend}>
            <strong>Label propagation:</strong>
            {(['in-sync', 'pending', 'overridden', 'unlabeled', 'no-upstream'] as PropagationStatus[]).map((st) => (
              <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                <span style={{ width: 10, height: 10, background: PROP_DOT[st], borderRadius: tokens.borderRadiusCircular, display: 'inline-block' }} />
                {STATUS_LABEL[st]}
              </span>
            ))}
            <span style={{ marginLeft: 'auto' }}>Click a node to focus its upstream + downstream chain</span>
          </div>
        </>
      )}
    </>
  );
}

// ── Mesh scope ────────────────────────────────────────────────────────────────

function threadEdgesToGraph(edges: ThreadEdge[]): { nodes: CanvasLineageNode[]; edges: CanvasLineageEdge[] } {
  const nodes = new Map<string, CanvasLineageNode>();
  const out: CanvasLineageEdge[] = [];
  const keyFor = (id: string, external?: boolean, link?: string) => (external ? `ext:${link || id}` : id);
  for (const e of edges) {
    const fromKey = keyFor(e.fromItemId);
    const toKey = keyFor(e.toItemId, e.toExternal, e.toLink);
    if (!nodes.has(fromKey)) {
      nodes.set(fromKey, { id: fromKey, label: e.fromName || e.fromItemId, type: e.fromType, source: 'loom', openHref: `/items/${e.fromType}/${e.fromItemId}` });
    }
    if (!nodes.has(toKey)) {
      nodes.set(toKey, { id: toKey, label: e.toName || e.toItemId, type: e.toType, source: 'loom', openHref: e.toExternal ? (e.toLink || undefined) : `/items/${e.toType}/${e.toItemId}` });
    }
    out.push({ from: fromKey, to: toKey, type: ACTION_LABEL[e.action] || e.action });
  }
  return { nodes: [...nodes.values()], edges: out };
}

function MeshScope() {
  const [edges, setEdges] = useState<ThreadEdge[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await clientFetch('/api/thread/edges');
      const j = await r.json();
      if (!r.ok || j?.ok === false) { setError(j?.error || `HTTP ${r.status}`); setEdges([]); return; }
      setEdges(j.edges || []);
    } catch (e: any) { setError(e?.message || String(e)); setEdges([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const graph = useMemo(() => threadEdgesToGraph(edges || []), [edges]);

  return (
    <>
      <Toolbar
        actions={
          <>
            <Badge appearance="tint" color="informative" size="medium">{graph.nodes.length} items</Badge>
            <Badge appearance="tint" color="informative" size="medium">{graph.edges.length} edges</Badge>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={edges == null}>Refresh</Button>
          </>
        }
      />
      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not load the mesh graph</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {edges == null && <Spinner label="Loading mesh lineage…" />}
      {edges != null && !error && graph.edges.length === 0 && (
        <EmptyState
          icon={<Flowchart24Regular />}
          title="No lineage yet"
          body="Open any item's editor and choose Weave to wire it into another Loom service — analyze a dataset in a Notebook, add a Data Agent source, build a Power BI model, or publish it as an API."
        />
      )}
      {edges != null && !error && graph.edges.length > 0 && (
        <LineageCanvas nodes={graph.nodes} edges={graph.edges} />
      )}
    </>
  );
}

// ── Federated scope ──────────────────────────────────────────────────────────

function FederatedScope() {
  const s = useStyles();
  const [source, setSource] = useState<'unity-catalog' | 'purview' | 'onelake'>('unity-catalog');
  const [id, setId] = useState('');
  const [host, setHost] = useState('');
  const [committed, setCommitted] = useState<{ source: any; id: string; host?: string } | null>(null);
  return (
    <>
      <div className={s.fedForm}>
        <Field label="Source">
          <Dropdown value={source} selectedOptions={[source]} onOptionSelect={(_, d) => setSource(d.optionValue as any)}>
            <Option value="unity-catalog">Unity Catalog (table)</Option>
            <Option value="purview">Purview (entity GUID)</Option>
            <Option value="onelake">OneLake (workspace ID)</Option>
          </Dropdown>
        </Field>
        <Field label="Asset ID">
          <Input value={id} onChange={(_, d) => setId(d.value)} placeholder="main.bronze.customers / 0e1a-…-9f / 1234-…-abc" />
        </Field>
        {source === 'unity-catalog' && (
          <Field label="Workspace hostname">
            <Input value={host} onChange={(_, d) => setHost(d.value)} placeholder="adb-…azuredatabricks.net" />
          </Field>
        )}
        <Button appearance="primary" disabled={!id} onClick={() => setCommitted({ source, id, host })}>Resolve</Button>
      </div>
      {committed
        ? <LineagePanel source={committed.source} id={committed.id} host={committed.host} workspaceId={committed.source === 'onelake' ? committed.id : undefined} />
        : <MessageBar><MessageBarBody>Enter a Unity Catalog table, Purview entity GUID, or OneLake workspace ID and choose <strong>Resolve</strong> to overlay its cross-source lineage.</MessageBarBody></MessageBar>}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function LineageInner() {
  const s = useStyles();
  const router = useRouter();
  const searchParams = useSearchParams();

  const scope: Scope = ((): Scope => {
    const q = searchParams?.get('scope');
    return q === 'mesh' || q === 'federated' ? q : 'governed';
  })();
  const focusId = searchParams?.get('focusId') || null;

  const setScope = (next: Scope) => {
    const params = new URLSearchParams(searchParams?.toString() || '');
    params.set('scope', next);
    if (next !== 'governed') params.delete('focusId');
    router.replace(`/governance/lineage?${params.toString()}`);
  };

  const activeHint = SCOPES.find((x) => x.value === scope)?.hint;

  return (
    <GovernanceShell sectionTitle="Lineage">
      <TabList
        selectedValue={scope}
        onTabSelect={(_e: SelectTabEvent, d: SelectTabData) => setScope(d.value as Scope)}
        style={{ marginBottom: tokens.spacingVerticalS }}
      >
        {SCOPES.map((sc) => <Tab key={sc.value} value={sc.value}>{sc.label}</Tab>)}
      </TabList>
      <Body1 className={s.hint}>{activeHint}</Body1>

      {scope === 'governed' && <GovernedScope focusId={focusId} />}
      {scope === 'mesh' && <MeshScope />}
      {scope === 'federated' && <FederatedScope />}
    </GovernanceShell>
  );
}

export default function GovernanceLineagePage() {
  return (
    <Suspense fallback={<Spinner label="Loading lineage…" />}>
      <LineageInner />
    </Suspense>
  );
}

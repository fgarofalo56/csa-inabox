'use client';

/**
 * Graph + Vector editors — Cosmos Gremlin, Cypher, GQL, and Vector store.
 *
 * Real wiring:
 *  - Cosmos Gremlin: real query via /api/items/cosmos-gremlin-graph/[id]/query
 *    (gremlin npm + AAD or account-key auth). Surfaces 501 deferred messages
 *    when runtime not configured.
 *  - Cypher / GQL: KQL backends (ADX `make-graph` + `graph-match` for Cypher
 *    semantics) are dispatched via the existing /api/items/kql-database/[id]/query
 *    route, so no new BFF endpoints required here.
 *  - Vector store: backend picker (Cosmos vCore / AI Search / pgvector) +
 *    create-index form. Live similarity test is fully wired against Azure AI
 *    Search: POST /api/items/vector-store/[id]/search dispatches to
 *    foundry-client.vectorSearch() (k-NN + optional hybrid). Requires the
 *    LOOM_AI_SEARCH_SERVICE env var and the Console UAMI 'Search Index Data
 *    Contributor' RBAC on the search service (see ai-search.bicep) — without
 *    them the route returns a 503 honest gate naming both. The non-ai-search
 *    backends (cosmos-nosql / cosmos-vcore / pgvector) persist their spec to
 *    Cosmos and surface an honest infra gate in the editor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Badge, Button, Input, Label, Spinner,
  Tab, TabList, Textarea, Dropdown, Option, Field, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Add20Regular, Search20Regular, ArrowClockwise20Regular,
  Save20Regular, DocumentSearch24Regular, Database24Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ForceDirectedGraph, extractGraph } from '@/lib/components/graph/force-directed-graph';
import { cypherToKql, TranslationError } from '@/lib/azure/cypher-kql-translator';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  editor: {
    width: '100%', minHeight: 160,
    fontFamily: 'Consolas, monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  treePad: { padding: 12, display: 'flex', flexDirection: 'column', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  // Vector store surfaces
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  searchRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  fullField: { flex: 1, minWidth: 220 },
  kField: { width: 96 },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  jsonView: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    maxHeight: 320, overflow: 'auto', margin: 0,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, textAlign: 'center',
    ...shorthands.padding(tokens.spacingVerticalXXXL, tokens.spacingHorizontalL),
    color: tokens.colorNeutralForeground3,
  },
  emptyIcon: { color: tokens.colorNeutralForeground4 },
  scoreCell: { fontVariantNumeric: 'tabular-nums', fontFamily: tokens.fontFamilyMonospace },
  monoCell: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
});

const SAMPLE_GREMLIN = `// Find vertices labeled "person", their friends, and the company they work for.
g.V().hasLabel('person')
  .out('knows').hasLabel('person')
  .out('worksAt').hasLabel('company')
  .path().by('name').by(label).by('name')
  .limit(10)`;

const SAMPLE_CYPHER = `// Cypher dialect — translated to KQL graph operators on ADX.
// Find all 2-hop paths between two persons.
let edges = print src='a', dst='b', kind='knows';
edges
| make-graph src --> dst with_node_id=name
| graph-match (p1)-[k:knows]->(p2)
  where p1.name == 'Alice'
  project p1.name, p2.name, k`;

const SAMPLE_GQL = `// GQL (ISO/IEC 39075:2024) — pattern-matching against the same graph backend.
MATCH (p1:Person {name:'Alice'})-[:KNOWS]->(p2:Person)
RETURN p2.name AS friend, p2.title AS title
LIMIT 25`;

function ResultsPreview({ result }: { result: any }) {
  const s = useStyles();
  if (!result) return null;
  if (result.deferred) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Runtime deferred</MessageBarTitle>
          {result.error}
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!result.ok) {
    return (
      <MessageBar intent="error">
        <MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{result.error || 'Unknown error'}</MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <pre style={{ fontSize: 12, maxHeight: 320, overflow: 'auto', background: tokens.colorNeutralBackground3, padding: 8, borderRadius: 4 }}>
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}

// ============================================================
// Cosmos Gremlin
// ============================================================
const QUICK_EDGES = `// List the first 25 edges with both endpoints' labels and the edge label.
g.E().limit(25).project('from', 'edge', 'to')
  .by(outV().label())
  .by(label())
  .by(inV().label())`;
const QUICK_VERTICES = `// List the first 25 vertices with their label + name (if present).
g.V().limit(25).project('label', 'name', 'id')
  .by(label())
  .by(coalesce(values('name'), constant('')))
  .by(id())`;

export function CosmosGremlinGraphEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // v3.28 Phase 4.5: endpoint is read-only — it reflects the server-side
  // env binding. Letting users type a fake endpoint into a textbox that
  // does nothing is vaporware per `no-vaporware.md`.
  const endpoint = process.env.NEXT_PUBLIC_LOOM_COSMOS_GREMLIN_ENDPOINT || '';
  const [query, setQuery] = useState<string>(SAMPLE_GREMLIN);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const runGremlin = useCallback(async (gremlin: string) => {
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`/api/items/cosmos-gremlin-graph/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: gremlin }),
      });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id]);

  const run = useCallback(() => runGremlin(query), [query, runGremlin]);
  // v3.27: wire Edges / Vertices ribbon buttons — used to emit nothing.
  // They now load the matching quick query into the editor + execute it.
  const showVertices = useCallback(() => { setQuery(QUICK_VERTICES); runGremlin(QUICK_VERTICES); }, [runGremlin]);
  const showEdges = useCallback(() => { setQuery(QUICK_EDGES); runGremlin(QUICK_EDGES); }, [runGremlin]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: loading ? 'Running…' : 'Run', onClick: loading ? undefined : run, disabled: loading },
        { label: 'Edges', onClick: loading ? undefined : showEdges, disabled: loading },
        { label: 'Vertices', onClick: loading ? undefined : showVertices, disabled: loading },
      ]},
    ]},
  ], [loading, run, showEdges, showVertices]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.field}><Label>Gremlin endpoint (server-bound)</Label>
            <Input value={endpoint || '— not configured —'} readOnly placeholder="wss://<acct>.gremlin.cosmos.azure.com:443/" />
            <Caption1>Configured via <code>LOOM_COSMOS_GREMLIN_ENDPOINT</code>. Editing here is not honored by the BFF.</Caption1>
          </div>
          <Caption1 style={{ marginTop: 8 }}>Use the buttons below to quick-load <code>g.V()</code> / <code>g.E()</code> previews.</Caption1>
          <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
            <Button size="small" onClick={showVertices} disabled={loading}>Vertices</Button>
            <Button size="small" onClick={showEdges} disabled={loading}>Edges</Button>
          </div>
        </div>
      }
      main={
        <div className={s.pad}>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Cosmos Gremlin runtime</MessageBarTitle>
              Real traversal execution gated on <code>LOOM_COSMOS_GREMLIN_ENDPOINT</code> + <code>gremlin</code> npm
              package. When not configured the BFF returns 501 with a deferred-reason payload (rendered here).
              When the response contains vertices + edges the force-directed view renders below the raw JSON.
            </MessageBarBody>
          </MessageBar>
          <MonacoTextarea value={query} onChange={setQuery} language="javascript" height={200} minHeight={160} ariaLabel="Gremlin query" />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run}>Run</Button>
            <Button appearance="secondary" disabled={loading} onClick={showVertices}>Quick: Vertices</Button>
            <Button appearance="secondary" disabled={loading} onClick={showEdges}>Quick: Edges</Button>
          </div>
          <GremlinViz result={result} />
          <ResultsPreview result={result} />
        </div>
      }
    />
  );
}

// ============================================================
// GremlinViz — renders the force-directed graph when the result has
// recognizable vertices/edges; quietly hides when there's nothing useful
// to visualize.
// ============================================================
function GremlinViz({ result }: { result: any }) {
  const graph = useMemo(() => {
    if (!result || !result.ok) return null;
    const g = extractGraph(result);
    if (g.nodes.length === 0) return null;
    return g;
  }, [result]);
  if (!graph) return null;
  return (
    <div>
      <Caption1 style={{ marginBottom: 4 }}>Force-directed graph view ({graph.nodes.length} nodes, {graph.edges.length} edges)</Caption1>
      <ForceDirectedGraph nodes={graph.nodes} edges={graph.edges} />
    </div>
  );
}

// ============================================================
// Cypher (KQL graph backend)
// ============================================================
export function CypherGraphEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [query, setQuery] = useState<string>(SAMPLE_CYPHER);
  const [mode, setMode] = useState<'cypher' | 'kql'>('cypher');
  const [translated, setTranslated] = useState<string>('');
  const [translateErr, setTranslateErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [sourceTable, setSourceTable] = useState('GraphSnapshot');

  const run = useCallback(async () => {
    setLoading(true); setResult(null); setTranslateErr(null); setTranslated('');
    try {
      let kqlBody = query;
      if (mode === 'cypher') {
        try {
          kqlBody = cypherToKql(query, sourceTable);
          setTranslated(kqlBody);
        } catch (e) {
          const tErr = e instanceof TranslationError ? e : new TranslationError(String(e));
          setTranslateErr(`${tErr.message}${tErr.hint ? ` — ${tErr.hint}` : ''}`);
          setLoading(false);
          return;
        }
      }
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: kqlBody }),
      });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id, query, mode, sourceTable]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: loading ? 'Running…' : 'Run', onClick: loading ? undefined : run, disabled: loading },
        { label: `Mode: ${mode === 'cypher' ? 'Cypher' : 'KQL'}`, onClick: () => setMode(mode === 'cypher' ? 'kql' : 'cypher') },
      ]},
    ]},
  ], [loading, run, mode]);

  const cypherGraph = useMemo(() => {
    if (!result || !result.ok) return null;
    const g = extractGraph(result);
    if (g.nodes.length === 0) return null;
    return g;
  }, [result]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={<div className={s.treePad}>
        <Caption1>Cypher → KQL bridge. Backed by ADX <code>make-graph</code> + <code>graph-match</code>.</Caption1>
        <div className={s.field} style={{ marginTop: 8 }}>
          <Label>Source table</Label>
          <Input value={sourceTable} onChange={(_: unknown, d: any) => setSourceTable(d.value)} placeholder="GraphSnapshot" />
          <Caption1>The ADX table that holds the graph snapshot (output of <code>make-graph</code>).</Caption1>
        </div>
      </div>}
      main={
        <div className={s.pad}>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>openCypher on ADX</MessageBarTitle>
              Type Cypher; the translator emits KQL <code>graph-match</code> and runs it against{' '}
              <code>{sourceTable}</code>. Switch <em>Mode</em> in the ribbon to write raw KQL.
            </MessageBarBody>
          </MessageBar>
          <MonacoTextarea value={query} onChange={setQuery} language={mode === 'cypher' ? 'sql' : 'kql'} height={180} minHeight={140} ariaLabel="Cypher / KQL editor" />
          {translateErr && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Cypher → KQL translation failed</MessageBarTitle>
                {translateErr} — switch to Mode: KQL and write the query by hand, or simplify the pattern.
              </MessageBarBody>
            </MessageBar>
          )}
          {translated && (
            <div>
              <Caption1>Translated KQL:</Caption1>
              <pre style={{ fontFamily: 'Consolas, monospace', fontSize: 12, backgroundColor: tokens.colorNeutralBackground2, padding: 8, borderRadius: 4, whiteSpace: 'pre-wrap' }}>{translated}</pre>
            </div>
          )}
          <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run}>Run</Button>
          {cypherGraph && (
            <div>
              <Caption1 style={{ marginBottom: 4 }}>Force-directed graph view ({cypherGraph.nodes.length} nodes, {cypherGraph.edges.length} edges)</Caption1>
              <ForceDirectedGraph nodes={cypherGraph.nodes} edges={cypherGraph.edges} />
            </div>
          )}
          <ResultsPreview result={result} />
        </div>
      }
    />
  );
}

// ============================================================
// GQL
// ============================================================
type GqlBackend = 'adx-graph' | 'fabric-graph' | 'cosmos-gremlin-translate' | 'persist-only';

export function GqlGraphEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [query, setQuery] = useState<string>(SAMPLE_GQL);
  const [backend, setBackend] = useState<GqlBackend>('adx-graph');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // v3.27: F-vaporware fix — Run button now actually does something.
  // For Fabric Graph backend we POST to the Fabric Graph executeQuery
  // route (501 deferred until LOOM_FABRIC_GRAPH_WORKSPACE wires the
  // workspace). For Cosmos-Gremlin-translate we dispatch a best-effort
  // Cypher-style query through the cosmos-gremlin-graph route. For
  // persist-only we honestly save the query to item state without
  // pretending to execute it.
  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      if (backend === 'adx-graph') {
        // Azure-native default — runs make-graph + graph-match on ADX (no Fabric).
        const r = await fetch(`/api/items/gql-graph/${id}/query`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, backend: 'adx', mode: 'kql-graph' }),
        });
        setResult(await r.json());
      } else if (backend === 'fabric-graph') {
        const r = await fetch(`/api/items/gql-graph/${id}/query`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, backend: 'fabric' }),
        });
        setResult(await r.json());
      } else if (backend === 'cosmos-gremlin-translate') {
        const r = await fetch(`/api/items/cosmos-gremlin-graph/${id}/query`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, lang: 'gql' }),
        });
        setResult(await r.json());
      } else {
        const r = await fetch(`/api/cosmos-items/gql-graph/${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: { query, backend } }),
        });
        const j = await r.json();
        setResult(j.ok ? { ok: true, persisted: true, message: 'Query persisted to item state. No backend dispatched (backend=persist-only).' } : j);
      }
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [backend, id, query]);

  const gqlGraph = useMemo(() => {
    if (!result || !result.ok) return null;
    const g = extractGraph(result);
    if (g.nodes.length === 0) return null;
    return g;
  }, [result]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: loading ? 'Running…' : backend === 'persist-only' ? 'Save query' : 'Run', onClick: loading ? undefined : run, disabled: loading },
      ]},
    ]},
  ], [loading, run, backend]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Caption1>ISO GQL standard. Pick a backend below.</Caption1>
          <div className={s.field} style={{ marginTop: 8 }}>
            <Label>Backend</Label>
            <select value={backend} onChange={(e) => setBackend(e.target.value as GqlBackend)} style={{ padding: 6 }}>
              <option value="adx-graph">Azure Data Explorer (KQL graph — default, no Fabric)</option>
              <option value="cosmos-gremlin-translate">Cosmos Gremlin (best-effort translate)</option>
              <option value="persist-only">Persist-only (no dispatch)</option>
              <option value="fabric-graph">Fabric Graph REST (opt-in — gated on workspace)</option>
            </select>
          </div>
        </div>
      }
      main={
        <div className={s.pad}>
          <MessageBar intent={backend === 'persist-only' ? 'warning' : 'info'}>
            <MessageBarBody>
              <MessageBarTitle>
                {backend === 'fabric-graph' && 'Fabric Graph REST'}
                {backend === 'cosmos-gremlin-translate' && 'Cosmos Gremlin best-effort'}
                {backend === 'persist-only' && 'Persist-only mode'}
              </MessageBarTitle>
              {backend === 'fabric-graph' && (
                <>Fabric Graph <code>executeQuery</code> endpoint is preview. Run dispatches to <code>/api/items/gql-graph/[id]/query</code> — returns 501 with a documented gate when <code>LOOM_FABRIC_GRAPH_WORKSPACE</code> isn't bound.</>
              )}
              {backend === 'cosmos-gremlin-translate' && (
                <>The Cosmos Gremlin route accepts <code>lang: 'gql'</code> for best-effort pattern translation. Complex GQL paths may fall back to Gremlin equivalents or return a translation-failed error.</>
              )}
              {backend === 'persist-only' && (
                <>Run saves the query to item state and does <strong>not</strong> dispatch — this is the honest no-backend mode. Switch the backend dropdown to actually execute.</>
              )}
            </MessageBarBody>
          </MessageBar>
          <MonacoTextarea value={query} onChange={setQuery} language="sql" height={200} minHeight={160} ariaLabel="GQL editor" />
          <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run}>
            {loading ? 'Running…' : backend === 'persist-only' ? 'Save query' : 'Run'}
          </Button>
          {result?.translated && (
            <div>
              <Caption1>Translated Gremlin:</Caption1>
              <pre style={{ fontFamily: 'Consolas, monospace', fontSize: 12, backgroundColor: tokens.colorNeutralBackground2, padding: 8, borderRadius: 4, whiteSpace: 'pre-wrap' }}>{result.translated}</pre>
            </div>
          )}
          {gqlGraph && (
            <div>
              <Caption1 style={{ marginBottom: 4 }}>Force-directed graph view ({gqlGraph.nodes.length} nodes, {gqlGraph.edges.length} edges)</Caption1>
              <ForceDirectedGraph nodes={gqlGraph.nodes} edges={gqlGraph.edges} />
            </div>
          )}
          <ResultsPreview result={result} />
        </div>
      }
    />
  );
}

// ============================================================
// Vector store
// ============================================================
// v3.27: added `cosmos-nosql` — the Microsoft-recommended native vector
// backend on Cosmos DB for NoSQL (DiskANN with VectorEmbeddingPolicy +
// vector index in the indexingPolicy).
type VectorBackend = 'cosmos-nosql' | 'cosmos-vcore' | 'ai-search' | 'pgvector';

const VECTOR_BACKEND_DESCRIPTIONS: Record<VectorBackend, string> = {
  'cosmos-nosql': 'Cosmos DB for NoSQL — DiskANN vector index (recommended for new workloads)',
  'cosmos-vcore': 'Cosmos vCore (Mongo vector index)',
  'ai-search': 'Azure AI Search (vector profile)',
  pgvector: 'PostgreSQL pgvector',
};

// Native AI Search vector backend is fully wired (create index / add docs /
// vector search). The other backends persist their spec to Cosmos and show an
// honest gate — they aren't reachable from this Loom build's network plane.
const AI_SEARCH_BACKEND: VectorBackend = 'ai-search';

/**
 * Renders live k-NN search hits as a sortable results table when the rows share a
 * tabular shape, falling back to formatted JSON for arbitrary payloads. The raw
 * backend response is always available via the "Raw JSON" toggle.
 */
function VectorSearchResults({ result }: { result: any }) {
  const s = useStyles();
  const rows: any[] = Array.isArray(result.result?.value)
    ? result.result.value
    : Array.isArray(result.result) ? result.result : [];
  const [sortKey, setSortKey] = useState<string>('@search.score');
  const [sortDesc, setSortDesc] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  // Derive the column set (cap scalar columns; collapse vector/object fields).
  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows.slice(0, 25)) {
      for (const key of Object.keys(row || {})) {
        const v = (row as any)[key];
        if (Array.isArray(v) || (v && typeof v === 'object')) continue;
        seen.add(key);
      }
    }
    const all = Array.from(seen);
    // Score columns first, then id-ish, then the rest.
    return all.sort((a, b) => {
      const rank = (k: string) => (k.startsWith('@search') ? 0 : /id|key/i.test(k) ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    }).slice(0, 8);
  }, [rows]);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => {
      const av = a?.[sortKey], bv = b?.[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv : String(av).localeCompare(String(bv));
      return sortDesc ? -cmp : cmp;
    });
  }, [rows, sortKey, sortDesc]);

  const toggleSort = (key: string) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else { setSortKey(key); setSortDesc(true); }
  };

  const isScore = (k: string) => k === '@search.score' || k === '@search.rerankerScore';

  return (
    <>
      <div className={s.toolbar}>
        <Caption1>{result.count ?? rows.length} result(s)</Caption1>
        {result.result?.['@search.coverage'] != null && (
          <Badge appearance="tint" color="informative">coverage {result.result['@search.coverage']}%</Badge>
        )}
        <Button size="small" appearance="subtle" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? 'Table view' : 'Raw JSON'}
        </Button>
      </div>
      {showRaw || columns.length === 0 ? (
        <pre className={s.jsonView}>{JSON.stringify(result.result?.value || result.result, null, 2)}</pre>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Vector search results" size="small">
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHeaderCell
                    key={c}
                    onClick={() => toggleSort(c)}
                    sortDirection={sortKey === c ? (sortDesc ? 'descending' : 'ascending') : undefined}
                    style={{ cursor: 'pointer' }}
                  >
                    {c.replace('@search.', '')}
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row, i) => (
                <TableRow key={row?.id ?? row?.key ?? i}>
                  {columns.map((c) => {
                    const v = row?.[c];
                    const display = isScore(c) && typeof v === 'number' ? v.toFixed(4) : String(v ?? '');
                    return (
                      <TableCell key={c} className={isScore(c) ? s.scoreCell : undefined}>
                        {isScore(c) && typeof v === 'number'
                          ? <Badge appearance="tint" color="brand">{display}</Badge>
                          : display}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

export function VectorStoreEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<'schema' | 'documents' | 'search'>('schema');
  const [backend, setBackend] = useState<VectorBackend>('ai-search');
  const [indexName, setIndexName] = useState<string>('docs-vec');
  const [dim, setDim] = useState<number>(1536);
  const [metric, setMetric] = useState<'cosine' | 'euclidean' | 'dotProduct'>('cosine');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Live index schema (from AI Search) + action results.
  const [liveIndex, setLiveIndex] = useState<any>(null);
  const [schemaMsg, setSchemaMsg] = useState<any>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<any>(null);

  // Documents tab.
  const [docsText, setDocsText] = useState<string>('[\n  { "id": "1", "content": "hello world", "embedding": [] }\n]');
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<any>(null);

  // Search tab.
  const [searchVec, setSearchVec] = useState<string>('');
  const [searchText, setSearchText] = useState<string>('');
  const [k, setK] = useState<number>(5);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<any>(null);

  const isAiSearch = backend === AI_SEARCH_BACKEND;

  // Load persisted spec.
  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/${encodeURIComponent('vector-store')}/${encodeURIComponent(id)}`);
        if (cancelled || r.status === 404) return;
        const j = await r.json();
        if (j?.ok && j.item?.state) {
          const st = j.item.state;
          if (st.backend) setBackend(st.backend);
          if (st.indexName) setIndexName(st.indexName);
          if (typeof st.dim === 'number') setDim(st.dim);
          if (st.metric) setMetric(st.metric);
          setSavedAt(j.item.updatedAt || null);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const persistSpec = useCallback(async () => {
    setSaving(true);
    try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
    try {
      const isNew = !id || id === 'new';
      const r = isNew
        ? await fetch(`/api/items/vector-store`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default', displayName: indexName, state: { backend, indexName, dim, metric } }),
          })
        : await fetch(`/api/cosmos-items/${encodeURIComponent('vector-store')}/${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: { backend, indexName, dim, metric } }),
          });
      const j = await r.json();
      if (j?.ok) {
        setDirty(false);
        setSavedAt(j.item?.updatedAt || new Date().toISOString());
        try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: indexName } })); } catch {}
      }
      return j;
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    finally { setSaving(false); }
  }, [id, backend, indexName, dim, metric]);

  // Load the live AI Search index schema.
  const loadSchema = useCallback(async () => {
    if (!isAiSearch || !indexName) return;
    setSchemaMsg(null); setLiveIndex(null); setSchemaLoading(true);
    try {
      const r = await fetch(`/api/items/vector-store/${encodeURIComponent(id || 'new')}/index?name=${encodeURIComponent(indexName)}`);
      const j = await r.json();
      if (!j.ok) { setSchemaMsg(j); return; }
      setLiveIndex(j.exists ? j.index : null);
      if (!j.exists) setSchemaMsg({ ok: true, info: `Index "${indexName}" not created yet — click Create index.` });
    } catch (e: any) { setSchemaMsg({ ok: false, error: e?.message || String(e) }); }
    finally { setSchemaLoading(false); }
  }, [isAiSearch, indexName, id]);

  useEffect(() => { if (isAiSearch) loadSchema(); }, [isAiSearch, loadSchema]);

  // Create / update the real AI Search vector index.
  const createIndex = useCallback(async () => {
    await persistSpec();
    if (!isAiSearch) { setCreateResult({ ok: false, deferred: true, error: `Live index creation is wired for the ai-search backend only. The "${backend}" spec was persisted to Cosmos; provision that backend and switch this Loom build to reach it.` }); return; }
    setCreating(true); setCreateResult(null);
    try {
      const r = await fetch(`/api/items/vector-store/${encodeURIComponent(id || 'new')}/index`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ indexName, dim, metric }),
      });
      const j = await r.json();
      setCreateResult(j);
      if (j.ok) await loadSchema();
    } catch (e: any) { setCreateResult({ ok: false, error: e?.message || String(e) }); }
    finally { setCreating(false); }
  }, [persistSpec, isAiSearch, backend, id, indexName, dim, metric, loadSchema]);

  const uploadDocs = useCallback(async () => {
    setUploading(true); setUploadResult(null);
    try {
      let documents: any;
      try { documents = JSON.parse(docsText); } catch (e: any) { setUploadResult({ ok: false, error: `Invalid JSON: ${e?.message || e}` }); return; }
      if (!Array.isArray(documents)) documents = [documents];
      const r = await fetch(`/api/items/vector-store/${encodeURIComponent(id || 'new')}/index`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ indexName, documents }),
      });
      setUploadResult(await r.json());
    } catch (e: any) { setUploadResult({ ok: false, error: e?.message || String(e) }); }
    finally { setUploading(false); }
  }, [docsText, indexName, id]);

  const runSearch = useCallback(async () => {
    setSearching(true); setSearchResult(null);
    try {
      let vector: number[];
      try { vector = JSON.parse(searchVec); } catch { setSearchResult({ ok: false, error: 'Query vector must be a JSON number array, e.g. [0.1, 0.2, …]' }); return; }
      const r = await fetch(`/api/items/vector-store/${encodeURIComponent(id || 'new')}/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ indexName, vector, k, text: searchText || undefined }),
      });
      setSearchResult(await r.json());
    } catch (e: any) { setSearchResult({ ok: false, error: e?.message || String(e) }); }
    finally { setSearching(false); }
  }, [searchVec, searchText, k, indexName, id]);

  // Ctrl+S persists the spec.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!saving) persistSpec(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, persistSpec]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Index', actions: [
        { label: saving ? 'Saving…' : 'Save spec', icon: <Save20Regular />, onClick: saving ? undefined : () => persistSpec(), disabled: saving },
        { label: creating ? 'Creating…' : 'Create index', icon: <Add20Regular />, onClick: creating ? undefined : createIndex, disabled: creating },
        { label: 'Reload schema', icon: <ArrowClockwise20Regular />, onClick: loadSchema, disabled: !isAiSearch },
      ]},
      { label: 'Test', actions: [
        { label: 'Documents', icon: <Add20Regular />, onClick: () => setTab('documents') },
        { label: 'Vector search', icon: <Search20Regular />, onClick: () => setTab('search') },
      ]},
    ]},
  ], [saving, persistSpec, creating, createIndex, loadSchema, isAiSearch]);

  const vectorField = useMemo(() => {
    const f = (liveIndex?.fields || []).find((x: any) => x.type?.includes('Collection(Edm.Single)'));
    return f?.name || 'embedding';
  }, [liveIndex]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.sectionHeader}>
            <Database24Regular className={s.emptyIcon} />
            <Subtitle2>Index spec</Subtitle2>
          </div>
          <Field label="Backend" hint="Azure-native vector store backing this index.">
            <Dropdown
              value={VECTOR_BACKEND_DESCRIPTIONS[backend]}
              selectedOptions={[backend]}
              onOptionSelect={(_, d) => { if (d.optionValue) { setBackend(d.optionValue as VectorBackend); setDirty(true); } }}
            >
              {(['ai-search', 'cosmos-nosql', 'cosmos-vcore', 'pgvector'] as VectorBackend[]).map(b => (
                <Option key={b} value={b} text={VECTOR_BACKEND_DESCRIPTIONS[b]}>{VECTOR_BACKEND_DESCRIPTIONS[b]}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Index name">
            <Input value={indexName} onChange={(_: unknown, d: any) => { setIndexName(d.value); setDirty(true); }} />
          </Field>
          <Field label="Dimensions" hint="Length of each embedding vector (e.g. 1536 for text-embedding-3-small).">
            <Input type="number" value={String(dim)} onChange={(_: unknown, d: any) => { setDim(Number(d.value || '0')); setDirty(true); }} />
          </Field>
          <Field label="Metric">
            <Dropdown
              value={metric}
              selectedOptions={[metric]}
              onOptionSelect={(_, d) => { if (d.optionValue) { setMetric(d.optionValue as any); setDirty(true); } }}
            >
              <Option value="cosine">cosine</Option>
              <Option value="euclidean">euclidean</Option>
              <Option value="dotProduct">dotProduct</Option>
            </Dropdown>
          </Field>
          <Divider />
          {dirty
            ? <Badge appearance="outline" color="warning">Unsaved spec</Badge>
            : savedAt
              ? <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>
              : <Badge appearance="tint" color="informative">New spec</Badge>}
        </div>
      }
      main={
        <>
          <div style={{ padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={tab} onTabSelect={(_: unknown, d: any) => setTab(d.value)}>
              <Tab value="schema">Index schema</Tab>
              <Tab value="documents">Add documents</Tab>
              <Tab value="search">Vector search</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            {!isAiSearch && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>{VECTOR_BACKEND_DESCRIPTIONS[backend]} — config-only in this build</MessageBarTitle>
                  The spec persists to Cosmos, but this Loom build only reaches the <strong>Azure AI Search</strong> data plane.
                  To run live index/search here, switch the backend to <code>ai-search</code> and set <code>LOOM_AI_SEARCH_SERVICE</code>
                  (+ grant the Console UAMI <em>Search Index Data Contributor</em>). For {backend}, provision the resource and wire its endpoint.
                </MessageBarBody>
              </MessageBar>
            )}

            {tab === 'schema' && (
              <>
                <div className={s.toolbar}>
                  <Button appearance="primary" icon={creating ? <Spinner size="tiny" /> : <Add20Regular />} onClick={createIndex} disabled={creating || saving}>
                    {creating ? 'Creating…' : 'Create / update index'}
                  </Button>
                  <Button icon={<Save20Regular />} onClick={() => persistSpec()} disabled={saving}>{saving ? 'Saving…' : 'Save spec'}</Button>
                  <Button icon={<ArrowClockwise20Regular />} onClick={loadSchema} disabled={!isAiSearch || schemaLoading}>Reload schema</Button>
                </div>
                {createResult && (
                  <MessageBar intent={createResult.ok ? 'success' : createResult.deferred ? 'warning' : 'error'}>
                    <MessageBarBody>
                      <MessageBarTitle>{createResult.ok ? `Index "${indexName}" created` : createResult.deferred ? 'AI Search not provisioned' : 'Create failed'}</MessageBarTitle>
                      {createResult.error || (createResult.ok ? `${createResult.index?.fields?.length || 0} fields, ${dim}-dim ${metric} vector field.` : '')}
                      {createResult.hint && <><br />{createResult.hint}</>}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {schemaMsg && !schemaMsg.ok && (
                  <MessageBar intent={schemaMsg.deferred ? 'warning' : 'error'}>
                    <MessageBarBody>{schemaMsg.error}{schemaMsg.hint && <><br />{schemaMsg.hint}</>}</MessageBarBody>
                  </MessageBar>
                )}
                {schemaMsg?.info && <MessageBar intent="info"><MessageBarBody>{schemaMsg.info}</MessageBarBody></MessageBar>}
                {schemaLoading && <Spinner size="small" label="Loading live index schema…" labelPosition="after" />}
                {!schemaLoading && !liveIndex && isAiSearch && !schemaMsg && (
                  <div className={s.emptyState}>
                    <Database24Regular className={s.emptyIcon} fontSize={40} />
                    <Subtitle2>No live index yet</Subtitle2>
                    <Caption1>Set the index name, dimensions, and metric on the left, then choose <strong>Create / update index</strong> to provision it on Azure AI Search.</Caption1>
                  </div>
                )}
                {liveIndex && (
                  <>
                    <div className={s.sectionHeader}>
                      <Database24Regular className={s.emptyIcon} />
                      <Subtitle2>Live index fields — {liveIndex.name}</Subtitle2>
                      <Badge appearance="tint" color="success">{(liveIndex.fields || []).length} fields</Badge>
                    </div>
                    <Table aria-label="Index fields" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Field</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Dimensions</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {(liveIndex.fields || []).map((f: any) => (
                          <TableRow key={f.name}>
                            <TableCell><strong>{f.name}</strong></TableCell>
                            <TableCell className={s.monoCell}>{f.type}</TableCell>
                            <TableCell>{f.key ? <Badge appearance="tint" color="brand">key</Badge> : ''}</TableCell>
                            <TableCell className={s.scoreCell}>{f.dimensions || ''}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
              </>
            )}

            {tab === 'documents' && (
              <>
                <div className={s.sectionHeader}>
                  <Add20Regular className={s.emptyIcon} />
                  <Subtitle2>Add documents (mergeOrUpload)</Subtitle2>
                </div>
                <Caption1>Paste a JSON array of documents. Each must carry the index key (<code>id</code>) and the vector field (<code>{vectorField}</code>: number[{dim}]).</Caption1>
                <MonacoTextarea value={docsText} onChange={setDocsText} language="json" height={220} minHeight={160} ariaLabel="Documents JSON" />
                <div className={s.toolbar}>
                  <Button appearance="primary" icon={uploading ? <Spinner size="tiny" /> : <Add20Regular />} onClick={uploadDocs} disabled={uploading}>{uploading ? 'Uploading…' : 'Upload documents'}</Button>
                </div>
                {uploadResult && (
                  <MessageBar intent={uploadResult.ok ? 'success' : uploadResult.deferred ? 'warning' : 'error'}>
                    <MessageBarBody>
                      {uploadResult.ok ? `Uploaded ${uploadResult.uploaded} document(s).` : uploadResult.error}
                      {uploadResult.hint && <><br />{uploadResult.hint}</>}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}

            {tab === 'search' && (
              <>
                <div className={s.sectionHeader}>
                  <Search20Regular className={s.emptyIcon} />
                  <Subtitle2>Vector similarity search</Subtitle2>
                </div>
                <Field label={`Query vector (JSON number array, ${dim}-dim)`} hint="Paste an embedding to find its nearest neighbours via k-NN.">
                  <Textarea value={searchVec} onChange={(_: unknown, d: any) => setSearchVec(d.value)} rows={3} placeholder="[0.12, -0.04, …]" />
                </Field>
                <div className={s.searchRow}>
                  <Field className={s.fullField} label="Hybrid text (optional)" hint="Adds BM25 keyword ranking fused with the vector score.">
                    <Input value={searchText} onChange={(_: unknown, d: any) => setSearchText(d.value)} placeholder="keyword filter (BM25 + vector)" />
                  </Field>
                  <Field className={s.kField} label="k (neighbors)">
                    <Input type="number" min={1} value={String(k)} onChange={(_: unknown, d: any) => setK(Number(d.value || '5'))} />
                  </Field>
                  <Button appearance="primary" icon={searching ? <Spinner size="tiny" /> : <Search20Regular />} onClick={runSearch} disabled={searching || !searchVec.trim()}>{searching ? 'Searching…' : 'Search'}</Button>
                </div>
                {searching && <Spinner size="small" label="Running k-NN…" labelPosition="after" />}
                {!searching && !searchResult && (
                  <div className={s.emptyState}>
                    <DocumentSearch24Regular className={s.emptyIcon} fontSize={40} />
                    <Subtitle2>No results yet</Subtitle2>
                    <Caption1>Paste a query vector and choose <strong>Search</strong> to run a live k-NN query against the index.</Caption1>
                  </div>
                )}
                {!searching && searchResult && (
                  searchResult.ok ? (
                    <VectorSearchResults result={searchResult} />
                  ) : (
                    <MessageBar intent={searchResult.deferred ? 'warning' : 'error'}>
                      <MessageBarBody>
                        <MessageBarTitle>{searchResult.deferred ? 'Backend not provisioned' : 'Search failed'}</MessageBarTitle>
                        {searchResult.error}{searchResult.hint && <><br />{searchResult.hint}</>}
                      </MessageBarBody>
                    </MessageBar>
                  )
                )}
              </>
            )}
          </div>
        </>
      }
    />
  );
}

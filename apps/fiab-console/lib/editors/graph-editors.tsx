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
 *    create-index form. Live similarity test deferred to v3.x — for now we
 *    persist the index spec into item state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Badge, Button, Input, Label, Spinner,
  Tab, TabList, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Play20Regular, Add20Regular, Search20Regular } from '@fluentui/react-icons';
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
  treePad: { padding: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
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
    setSchemaMsg(null); setLiveIndex(null);
    try {
      const r = await fetch(`/api/items/vector-store/${encodeURIComponent(id || 'new')}/index?name=${encodeURIComponent(indexName)}`);
      const j = await r.json();
      if (!j.ok) { setSchemaMsg(j); return; }
      setLiveIndex(j.exists ? j.index : null);
      if (!j.exists) setSchemaMsg({ ok: true, info: `Index "${indexName}" not created yet — click Create index.` });
    } catch (e: any) { setSchemaMsg({ ok: false, error: e?.message || String(e) }); }
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
        { label: saving ? 'Saving…' : 'Save spec', onClick: saving ? undefined : () => persistSpec(), disabled: saving },
        { label: creating ? 'Creating…' : 'Create index', onClick: creating ? undefined : createIndex, disabled: creating },
        { label: 'Reload schema', onClick: loadSchema, disabled: !isAiSearch },
      ]},
      { label: 'Test', actions: [
        { label: 'Documents', onClick: () => setTab('documents') },
        { label: 'Vector search', onClick: () => setTab('search') },
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
          <div className={s.field}>
            <Label>Backend</Label>
            <select value={backend} onChange={(e) => { setBackend(e.target.value as VectorBackend); setDirty(true); }} style={{ padding: 6 }}>
              {(['ai-search', 'cosmos-nosql', 'cosmos-vcore', 'pgvector'] as VectorBackend[]).map(b => (
                <option key={b} value={b}>{VECTOR_BACKEND_DESCRIPTIONS[b]}</option>
              ))}
            </select>
          </div>
          <div className={s.field}><Label>Index name</Label><Input value={indexName} onChange={(_: unknown, d: any) => { setIndexName(d.value); setDirty(true); }} /></div>
          <div className={s.field}><Label>Dimensions</Label><Input type="number" value={String(dim)} onChange={(_: unknown, d: any) => { setDim(Number(d.value || '0')); setDirty(true); }} /></div>
          <div className={s.field}>
            <Label>Metric</Label>
            <select value={metric} onChange={(e) => { setMetric(e.target.value as any); setDirty(true); }} style={{ padding: 6 }}>
              <option value="cosine">cosine</option>
              <option value="euclidean">euclidean</option>
              <option value="dotProduct">dotProduct</option>
            </select>
          </div>
          {dirty && <Badge appearance="outline" color="warning">unsaved spec</Badge>}
          {savedAt && !dirty && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>}
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
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button appearance="primary" icon={<Add20Regular />} onClick={createIndex} disabled={creating || saving}>
                    {creating ? 'Creating…' : 'Create / update index'}
                  </Button>
                  <Button onClick={() => persistSpec()} disabled={saving}>{saving ? 'Saving…' : 'Save spec'}</Button>
                  <Button onClick={loadSchema} disabled={!isAiSearch}>Reload schema</Button>
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
                {liveIndex && (
                  <>
                    <Subtitle2>Live index fields — {liveIndex.name}</Subtitle2>
                    <Table aria-label="Index fields" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Field</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Dimensions</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {(liveIndex.fields || []).map((f: any) => (
                          <TableRow key={f.name}>
                            <TableCell><strong>{f.name}</strong></TableCell>
                            <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.type}</TableCell>
                            <TableCell>{f.key ? 'yes' : ''}</TableCell>
                            <TableCell>{f.dimensions || ''}</TableCell>
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
                <Subtitle2>Add documents (mergeOrUpload)</Subtitle2>
                <Caption1>Paste a JSON array of documents. Each must carry the index key (<code>id</code>) and the vector field (<code>{vectorField}</code>: number[{dim}]).</Caption1>
                <MonacoTextarea value={docsText} onChange={setDocsText} language="json" height={220} minHeight={160} ariaLabel="Documents JSON" />
                <Button appearance="primary" icon={<Add20Regular />} onClick={uploadDocs} disabled={uploading}>{uploading ? 'Uploading…' : 'Upload documents'}</Button>
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
                <Subtitle2>Vector similarity search</Subtitle2>
                <div className={s.field}><Label>Query vector (JSON number array, {dim}-dim)</Label>
                  <Textarea value={searchVec} onChange={(_: unknown, d: any) => setSearchVec(d.value)} rows={3} placeholder="[0.12, -0.04, …]" />
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className={s.field} style={{ flex: 1 }}><Label>Hybrid text (optional)</Label>
                    <Input value={searchText} onChange={(_: unknown, d: any) => setSearchText(d.value)} placeholder="keyword filter (BM25 + vector)" />
                  </div>
                  <div className={s.field}><Label>k (neighbors)</Label>
                    <Input type="number" value={String(k)} onChange={(_: unknown, d: any) => setK(Number(d.value || '5'))} style={{ width: 80 }} />
                  </div>
                  <Button appearance="primary" icon={<Search20Regular />} onClick={runSearch} disabled={searching}>{searching ? 'Searching…' : 'Search'}</Button>
                </div>
                {searching && <Spinner size="small" label="Running k-NN…" labelPosition="after" />}
                {searchResult && (
                  searchResult.ok ? (
                    <>
                      <Caption1>{searchResult.count} result(s)</Caption1>
                      <pre style={{ fontSize: 12, maxHeight: 320, overflow: 'auto', background: tokens.colorNeutralBackground3, padding: 8, borderRadius: 4 }}>
                        {JSON.stringify(searchResult.result?.value || searchResult.result, null, 2)}
                      </pre>
                    </>
                  ) : (
                    <MessageBar intent={searchResult.deferred ? 'warning' : 'error'}>
                      <MessageBarBody>{searchResult.error}{searchResult.hint && <><br />{searchResult.hint}</>}</MessageBarBody>
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

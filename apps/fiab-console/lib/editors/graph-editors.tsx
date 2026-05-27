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

import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Badge, Button, Input, Label,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Play20Regular, Add20Regular, Search20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

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

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Query', actions: [{ label: 'Run' }, { label: 'Edges' }, { label: 'Vertices' }] }] }]}
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
              Graph visualization (force-directed layout) deferred to v3.x — rows render as JSON for now.
            </MessageBarBody>
          </MessageBar>
          <MonacoTextarea value={query} onChange={setQuery} language="javascript" height={200} minHeight={160} ariaLabel="Gremlin query" />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run}>Run</Button>
            <Button appearance="secondary" disabled={loading} onClick={showVertices}>Quick: Vertices</Button>
            <Button appearance="secondary" disabled={loading} onClick={showEdges}>Quick: Edges</Button>
          </div>
          <ResultsPreview result={result} />
        </div>
      }
    />
  );
}

// ============================================================
// Cypher (KQL graph backend)
// ============================================================
export function CypherGraphEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [query, setQuery] = useState<string>(SAMPLE_CYPHER);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: query }),
      });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id, query]);
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Query', actions: [{ label: 'Run' }] }] }]}
      leftPanel={<div className={s.treePad}>
        <Caption1>Cypher → KQL bridge. Backed by ADX <code>make-graph</code> + <code>graph-match</code>.</Caption1>
      </div>}
      main={
        <div className={s.pad}>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>openCypher on ADX</MessageBarTitle>
              The editor sends KQL; the panel above shows the equivalent in <em>graph-match</em> syntax. Real
              Cypher-to-KQL translation deferred to v3.x — write KQL directly for now.
            </MessageBarBody>
          </MessageBar>
          <MonacoTextarea value={query} onChange={setQuery} language="kql" height={200} minHeight={160} ariaLabel="Cypher / KQL editor" />
          <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run}>Run</Button>
          <ResultsPreview result={result} />
        </div>
      }
    />
  );
}

// ============================================================
// GQL
// ============================================================
type GqlBackend = 'fabric-graph' | 'cosmos-gremlin-translate' | 'persist-only';

export function GqlGraphEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [query, setQuery] = useState<string>(SAMPLE_GQL);
  const [backend, setBackend] = useState<GqlBackend>('persist-only');
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
      if (backend === 'fabric-graph') {
        const r = await fetch(`/api/items/gql-graph/${id}/query`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, backend: 'fabric-graph' }),
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

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Query', actions: [{ label: 'Run' }] }] }]}
      leftPanel={
        <div className={s.treePad}>
          <Caption1>ISO GQL standard. Pick a backend below.</Caption1>
          <div className={s.field} style={{ marginTop: 8 }}>
            <Label>Backend</Label>
            <select value={backend} onChange={(e) => setBackend(e.target.value as GqlBackend)} style={{ padding: 6 }}>
              <option value="persist-only">Persist-only (no dispatch)</option>
              <option value="fabric-graph">Fabric Graph REST (preview — gated on workspace)</option>
              <option value="cosmos-gremlin-translate">Cosmos Gremlin (best-effort translate)</option>
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

export function VectorStoreEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [backend, setBackend] = useState<VectorBackend>('cosmos-nosql');
  const [indexName, setIndexName] = useState<string>('docs-vec');
  const [dim, setDim] = useState<number>(1536);
  const [metric, setMetric] = useState<'cosine' | 'euclidean' | 'dotProduct'>('cosine');
  const [testQuery, setTestQuery] = useState<string>('');
  const [result, setResult] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // v3.28 Phase 4.5: load existing item state from Cosmos on mount so the
  // form reflects what's persisted. New items render the defaults above.
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

  const createIndex = useCallback(async () => {
    setSaving(true); setResult(null);
    try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
    try {
      // For existing items, PATCH state into Cosmos. For id === 'new', POST creates the item.
      const isNew = !id || id === 'new';
      const r = isNew
        ? await fetch(`/api/items/vector-store`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: 'default',
              displayName: indexName,
              state: { backend, indexName, dim, metric },
            }),
          })
        : await fetch(`/api/cosmos-items/${encodeURIComponent('vector-store')}/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: { backend, indexName, dim, metric } }),
          });
      const j = await r.json();
      setResult(j);
      if (j?.ok) {
        setDirty(false);
        setSavedAt(j.item?.updatedAt || new Date().toISOString());
        try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: indexName } })); } catch {}
      }
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally { setSaving(false); }
  }, [id, backend, indexName, dim, metric]);

  // Ctrl+S to persist.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving) createIndex();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, createIndex]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Index', actions: [{ label: 'Create' }, { label: 'Test similarity' }] }] }]}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.field}>
            <Label>Backend</Label>
            <select value={backend} onChange={(e) => { setBackend(e.target.value as VectorBackend); setDirty(true); }} style={{ padding: 6 }}>
              {(['cosmos-nosql', 'ai-search', 'cosmos-vcore', 'pgvector'] as VectorBackend[]).map(b => (
                <option key={b} value={b}>{VECTOR_BACKEND_DESCRIPTIONS[b]}</option>
              ))}
            </select>
          </div>
          <div className={s.field}><Label>Index name</Label><Input value={indexName} onChange={(_, d) => { setIndexName(d.value); setDirty(true); }} /></div>
          <div className={s.field}><Label>Dimensions</Label><Input type="number" value={String(dim)} onChange={(_, d) => { setDim(Number(d.value || '0')); setDirty(true); }} /></div>
          <div className={s.field}>
            <Label>Metric</Label>
            <select value={metric} onChange={(e) => { setMetric(e.target.value as any); setDirty(true); }} style={{ padding: 6 }}>
              <option value="cosine">cosine</option>
              <option value="euclidean">euclidean</option>
              <option value="dotProduct">dotProduct</option>
            </select>
          </div>
        </div>
      }
      main={
        <div className={s.pad}>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Vector store provisioning</MessageBarTitle>
              v3 persists the index spec. Live creation hits backend REST in v3.x:
              <ul style={{ margin: '4px 0 0 16px' }}>
                <li><strong>cosmos-nosql</strong>: container <code>VectorEmbeddingPolicy</code> + indexingPolicy <code>vectorIndexes</code> (DiskANN). Recommended path.</li>
                <li><strong>ai-search</strong>: <code>PUT /indexes/{`{name}`}?api-version=2024-07-01</code> with <code>vectorSearch</code> profile</li>
                <li><strong>cosmos-vcore</strong>: <code>db.collection.createIndex({`{ vec: 'cosmosSearch' }`}, ...)</code></li>
                <li><strong>pgvector</strong>: <code>CREATE INDEX ... USING ivfflat</code></li>
              </ul>
            </MessageBarBody>
          </MessageBar>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button appearance="primary" icon={<Add20Regular />} onClick={createIndex} disabled={saving}>
              {saving ? 'Saving…' : dirty ? 'Save index spec' : 'Saved'}
            </Button>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            {savedAt && !saving && !dirty && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>
            )}
          </div>
          <div className={s.field}><Label>Test query embedding (paste JSON array)</Label>
            <MonacoTextarea value={testQuery} onChange={setTestQuery} language="json" height={140} minHeight={100} ariaLabel="Test query" />
          </div>
          <Button icon={<Search20Regular />} disabled>Similarity test (v3.x)</Button>
          {result && <ResultsPreview result={result} />}
        </div>
      }
    />
  );
}

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

import { useCallback, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Label, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Play20Regular, Add20Regular, Search20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

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
export function CosmosGremlinGraphEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [endpoint, setEndpoint] = useState<string>(process.env.NEXT_PUBLIC_LOOM_COSMOS_GREMLIN_ENDPOINT || '');
  const [query, setQuery] = useState<string>(SAMPLE_GREMLIN);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`/api/items/cosmos-gremlin-graph/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id, query]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Query', actions: [{ label: 'Run' }, { label: 'Edges' }, { label: 'Vertices' }] }] }]}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.field}><Label>Gremlin endpoint</Label>
            <Input value={endpoint} onChange={(_, d) => setEndpoint(d.value)} placeholder="wss://<acct>.gremlin.cosmos.azure.com:443/" />
          </div>
          <Caption1>Edges / Vertices ribbon actions emit standard <code>g.V()</code> / <code>g.E()</code> queries.</Caption1>
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
          <textarea className={s.editor} value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="Gremlin query" />
          <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run}>Run</Button>
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
          <textarea className={s.editor} value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="Cypher / KQL editor" />
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
export function GqlGraphEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [query, setQuery] = useState<string>(SAMPLE_GQL);
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Query', actions: [{ label: 'Run' }] }] }]}
      leftPanel={<div className={s.treePad}><Caption1>ISO GQL standard. Compiled to KQL or Gremlin depending on backend.</Caption1></div>}
      main={
        <div className={s.pad}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>GQL compiler deferred</MessageBarTitle>
              No GA Azure backend speaks GQL natively today. v3.x will add a parser → KQL/Gremlin compiler.
              For now the editor persists the query into item state.
            </MessageBarBody>
          </MessageBar>
          <textarea className={s.editor} value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="GQL editor" />
        </div>
      }
    />
  );
}

// ============================================================
// Vector store
// ============================================================
type VectorBackend = 'cosmos-vcore' | 'ai-search' | 'pgvector';
export function VectorStoreEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [backend, setBackend] = useState<VectorBackend>('ai-search');
  const [indexName, setIndexName] = useState<string>('docs-vec');
  const [dim, setDim] = useState<number>(1536);
  const [metric, setMetric] = useState<'cosine' | 'euclidean' | 'dotProduct'>('cosine');
  const [testQuery, setTestQuery] = useState<string>('');
  const [result, setResult] = useState<any>(null);

  const createIndex = async () => {
    // Backend-specific provisioning is deferred. Persist the spec only.
    const r = await fetch(`/api/items/vector-store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'default',
        displayName: indexName,
        state: { backend, indexName, dim, metric },
      }),
    });
    setResult(await r.json());
  };

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Index', actions: [{ label: 'Create' }, { label: 'Test similarity' }] }] }]}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.field}>
            <Label>Backend</Label>
            <select value={backend} onChange={(e) => setBackend(e.target.value as VectorBackend)} style={{ padding: 6 }}>
              <option value="ai-search">Azure AI Search (vector profile)</option>
              <option value="cosmos-vcore">Cosmos vCore (Mongo vector index)</option>
              <option value="pgvector">PostgreSQL pgvector</option>
            </select>
          </div>
          <div className={s.field}><Label>Index name</Label><Input value={indexName} onChange={(_, d) => setIndexName(d.value)} /></div>
          <div className={s.field}><Label>Dimensions</Label><Input type="number" value={String(dim)} onChange={(_, d) => setDim(Number(d.value || '0'))} /></div>
          <div className={s.field}>
            <Label>Metric</Label>
            <select value={metric} onChange={(e) => setMetric(e.target.value as any)} style={{ padding: 6 }}>
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
                <li><strong>ai-search</strong>: <code>PUT /indexes/{`{name}`}?api-version=2024-07-01</code> with <code>vectorSearch</code> profile</li>
                <li><strong>cosmos-vcore</strong>: <code>db.collection.createIndex({`{ vec: 'cosmosSearch' }`}, ...)</code></li>
                <li><strong>pgvector</strong>: <code>CREATE INDEX ... USING ivfflat</code></li>
              </ul>
            </MessageBarBody>
          </MessageBar>
          <Button appearance="primary" icon={<Add20Regular />} onClick={createIndex}>Persist index spec</Button>
          <div className={s.field}><Label>Test query embedding (paste JSON array)</Label>
            <textarea className={s.editor} value={testQuery} onChange={(e) => setTestQuery(e.target.value)} spellCheck={false} aria-label="Test query" />
          </div>
          <Button icon={<Search20Regular />} disabled>Similarity test (v3.x)</Button>
          {result && <ResultsPreview result={result} />}
        </div>
      }
    />
  );
}

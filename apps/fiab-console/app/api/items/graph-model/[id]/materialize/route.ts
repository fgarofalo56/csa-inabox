/**
 * POST /api/items/graph-model/[id]/materialize
 *   Materialize a saved graph-model schema (nodes[] + edges[]) into ADX
 *   tables in `loomdb-default` (or the body's `database`). Each node type
 *   becomes a table (id:string, plus property columns); each edge type
 *   becomes a table (src:string, dst:string, plus property columns).
 *
 *   Body: { database?: string, nodes: [{name, properties: [{name,type}]}],
 *           edges: [{name, properties: [{name,type}]}] }
 *
 *   Returns: { ok, created: [{kind:'node'|'edge', name, command, ok, error?}] }
 *   Each command runs independently — one failure does not abort the rest.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeMgmtCommand, defaultDatabase, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Prop = { name: string; type?: string };
type Decl = { name: string; properties?: Prop[] };

function kustoType(t?: string): string {
  const v = (t || 'string').toLowerCase();
  if (['int', 'long', 'real', 'bool', 'datetime', 'dynamic', 'guid', 'decimal', 'timespan'].includes(v)) return v;
  if (v === 'number' || v === 'float' || v === 'double') return 'real';
  if (v === 'boolean') return 'bool';
  return 'string';
}

function safeIdent(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}

function buildCreate(table: string, columns: { name: string; type: string }[]): string {
  const cols = columns.map((c) => `${safeIdent(c.name)}:${c.type}`).join(', ');
  return `.create-merge table ${safeIdent(table)} (${cols})`;
}

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const db = String(body?.database || defaultDatabase());
  const nodes: Decl[] = Array.isArray(body?.nodes) ? body.nodes : [];
  const edges: Decl[] = Array.isArray(body?.edges) ? body.edges : [];
  if (nodes.length === 0 && edges.length === 0) {
    return NextResponse.json({ ok: false, error: 'No node or edge definitions provided' }, { status: 400 });
  }
  const results: Array<{ kind: 'node' | 'edge'; name: string; command: string; ok: boolean; error?: string }> = [];

  for (const n of nodes) {
    if (!n?.name) continue;
    const cmd = buildCreate(`Node_${n.name}`, [
      { name: 'id', type: 'string' },
      ...(n.properties || []).map((p) => ({ name: p.name, type: kustoType(p.type) })),
    ]);
    try {
      await executeMgmtCommand(db, cmd);
      results.push({ kind: 'node', name: n.name, command: cmd, ok: true });
    } catch (e: any) {
      results.push({ kind: 'node', name: n.name, command: cmd, ok: false, error: e?.message || String(e) });
    }
  }
  for (const e of edges) {
    if (!e?.name) continue;
    const cmd = buildCreate(`Edge_${e.name}`, [
      { name: 'src', type: 'string' },
      { name: 'dst', type: 'string' },
      ...(e.properties || []).map((p) => ({ name: p.name, type: kustoType(p.type) })),
    ]);
    try {
      await executeMgmtCommand(db, cmd);
      results.push({ kind: 'edge', name: e.name, command: cmd, ok: true });
    } catch (err: any) {
      const status = err instanceof KustoError ? err.status : 502;
      results.push({ kind: 'edge', name: e.name, command: cmd, ok: false, error: `${status}: ${err?.message || String(err)}` });
    }
  }

  return NextResponse.json({ ok: true, database: db, created: results });
}

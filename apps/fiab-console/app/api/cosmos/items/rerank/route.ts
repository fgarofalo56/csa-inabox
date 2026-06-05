/**
 * POST /api/cosmos/items/rerank
 *   body: { db, container, intent, field, maxItems? }
 *
 * Runs a real Azure Cosmos DB for NoSQL **semantic reranker** query (Build 2026
 * public preview): SELECT TOP n * FROM c ORDER BY RANK semantic_rerank(@intent, c.<field>)
 * — re-orders the container's documents by semantic relevance of <field> to the
 * <intent> text. The reranker is a gated preview; when it isn't enabled on the
 * account the data plane returns a syntax/feature error, which we surface
 * honestly (no-vaporware) rather than faking a result.
 *
 * Docs: https://devblogs.microsoft.com/cosmosdb/announcing-the-public-preview-of-semantic-reranker-in-azure-cosmos-db-for-nosql/
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryItems } from '@/lib/azure/cosmos-data-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { db?: string; container?: string; intent?: string; field?: string; maxItems?: number }

// Cosmos field paths are property identifiers; allow letters/digits/_/. only so
// the path can be embedded in the ORDER BY RANK clause (it can't be a parameter).
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 }); }
  const db = body.db?.trim();
  const container = body.container?.trim();
  const intent = (body.intent || '').trim();
  const field = (body.field || '').trim();
  if (!db || !container) return NextResponse.json({ ok: false, error: 'db and container are required' }, { status: 400 });
  if (!intent) return NextResponse.json({ ok: false, error: 'intent (the reranking query text) is required' }, { status: 400 });
  if (!SAFE_FIELD.test(field)) {
    return NextResponse.json({ ok: false, error: 'field must be a simple document property path (e.g. text or content.body)' }, { status: 400 });
  }
  const n = Number.isFinite(body.maxItems) && (body.maxItems as number) > 0 ? Math.min(Math.floor(body.maxItems as number), 50) : 20;

  // semantic_rerank caps at ~50 candidate docs / 2048 tokens per call.
  const query = `SELECT TOP ${n} * FROM c ORDER BY RANK semantic_rerank(@intent, c.${field})`;

  try {
    const result = await queryItems(db, container, query, {
      crossPartition: true,
      parameters: [{ name: '@intent', value: intent }],
    });
    return NextResponse.json({ ok: true, ...result, query });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Honest preview gate: the reranker is waitlisted; surface the real reason.
    if (/semantic_rerank|rerank|not enabled|not supported|BadRequest|syntax/i.test(msg)) {
      return NextResponse.json({
        ok: false,
        code: 'rerank_preview',
        error: `Semantic reranker query failed: ${msg}`,
        hint:
          'The Cosmos DB for NoSQL semantic reranker is a gated public preview — enable it on the account ' +
          '(request access), and ensure the reranked field holds text. Limits: ~50 candidate docs / 2048 tokens per call; billed per 1K rerank calls.',
        query,
      }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: e?.status || 502 });
  }
}

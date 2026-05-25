import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stub - real impl chains the Loom Data Agents (PydanticAI orchestrator
// + AOAI + grounded retrieval over catalog/lineage). Returns a polite
// fallback so the Data Agent pane renders.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1]?.content || '(empty)';
  return NextResponse.json({
    content: `Data Agent is online but not yet wired to the orchestrator in this deploy. You said: "${String(last).substring(0, 200)}"`,
    citations: [],
  });
}

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stub - real impl dispatches to Databricks notebook job runner OR a
// per-user Jupyter kernel session. Returns a placeholder so the
// Notebook pane renders.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const language = body?.language || 'python';
  const source = (body?.source || '').toString();
  return NextResponse.json({
    output: `[stub] ${language} kernel not wired in this deploy. Submitted ${source.length} chars.`,
  });
}

/**
 * GET /api/aml/runs/[runId]/artifact?path=<file>[&download=1]
 *
 * Streams a single MLflow run artifact for preview (inline) or download
 * (attachment). Caps at 1 MiB to preview; larger files force download.
 * Real backend: getArtifactBlob → MLflow artifacts/get-artifact.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getArtifactBlob, MlflowNotConfiguredError, MlflowError } from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const runId = decodeURIComponent((await ctx.params).runId);
  const path = req.nextUrl.searchParams.get('path');
  const download = req.nextUrl.searchParams.get('download') === '1';
  if (!path) return NextResponse.json({ ok: false, error: 'path required' }, { status: 400 });
  try {
    const { body, contentType, truncated } = await getArtifactBlob(runId, path);
    const file = path.split('/').pop() || 'artifact';
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'x-truncated': truncated ? '1' : '0',
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${file.replace(/"/g, '')}"`,
      },
    });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) return NextResponse.json({ ok: false, configured: false, hint: e.hint }, { status: 503 });
    const status = e instanceof MlflowError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

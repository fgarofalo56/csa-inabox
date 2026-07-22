/**
 * GET /api/aml/runs/[runId]/artifact?path=<file>[&download=1]
 *
 * Streams a single MLflow run artifact for preview (inline) or download
 * (attachment). Caps at 1 MiB to preview; larger files force download.
 * Real backend: getArtifactBlob → MLflow artifacts/get-artifact.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { getArtifactBlob, MlflowNotConfiguredError, MlflowError } from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ runId: string }>(async (req, { params }) => {
  const runId = decodeURIComponent(params.runId);
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
    if (e instanceof MlflowNotConfiguredError) return apiHonestGateError('svc-aml', { missing: e.missing, message: e.hint });
    const status = e instanceof MlflowError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});

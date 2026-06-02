/**
 * GET /api/dab/[id]/preview/probe
 *   → probe the configured DAB runtime's /health. Honest-gates when
 *     LOOM_DAB_PREVIEW_URL is unset (the full builder still renders).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../../items/_lib/item-crud';
import { dabRuntimeGate, dabRuntimeTarget, probeRuntime } from '../../../_lib/dab-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const gate = dabRuntimeGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, gate, error: `DAB runtime not provisioned. Set ${gate.missing} to the shared preview DAB Container App URL (deploys from platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep).` },
      { status: 503 },
    );
  }
  const probe = await probeRuntime();
  return NextResponse.json({ ok: true, baseUrl: dabRuntimeTarget()?.baseUrl, probe });
}

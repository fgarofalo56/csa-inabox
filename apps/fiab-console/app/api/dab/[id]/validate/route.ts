/**
 * POST /api/dab/[id]/validate
 *   body { config } → run `dab validate`-parity checks (schema + cross-reference)
 *   and return the emitted canonical dab-config.json so the editor can preview it.
 *   When a runtime is configured we additionally probe its /health to report
 *   whether the config could be applied; otherwise we honest-gate that part.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../items/_lib/item-crud';
import { emitDabConfigJson, validateDabConfig, type DabConfig } from '../../_lib/dab-config-model';
import { dabRuntimeGate, probeRuntime } from '../../_lib/dab-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const config = body?.config as DabConfig | undefined;
  if (!config || typeof config !== 'object') return jerr('config is required', 400);

  const issues = validateDabConfig(config);
  const json = emitDabConfigJson(config);
  const valid = issues.every((i) => i.severity !== 'error');

  const gate = dabRuntimeGate();
  let runtimeProbe: { configured: boolean; gate?: { missing: string }; health?: unknown } = {
    configured: !gate,
    ...(gate ? { gate } : {}),
  };
  if (!gate) {
    const probe = await probeRuntime();
    runtimeProbe = { configured: true, health: probe };
  }

  return NextResponse.json({ ok: true, valid, issues, json, runtime: runtimeProbe });
}

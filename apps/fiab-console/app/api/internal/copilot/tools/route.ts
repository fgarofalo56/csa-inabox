/**
 * GET /api/internal/copilot/tools
 *
 * Internal, token-gated mirror of GET /api/copilot/tools. Returns the SAME
 * registered orchestrator tool schemas — used by the MAF orchestration tier
 * (`loom-copilot-maf`) to build the AOAI `tools` array for its agent loop.
 *
 * Auth: `x-loom-internal-token` must match `LOOM_INTERNAL_TOKEN` (shared secret,
 * Bicep-wired to both apps). NOT cookie-authenticated — the MAF app has no MSAL
 * session. Fails closed when the env var is unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRegistry } from '@/lib/azure/copilot-orchestrator';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isValidInternalToken(req.headers.get(INTERNAL_TOKEN_HEADER))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  const reg = getRegistry();
  const tools = reg.list().map((t) => ({
    name: t.name,
    description: t.description,
    service: t.service,
    parameters: t.parameters,
  }));
  return NextResponse.json({ ok: true, count: tools.length, tools });
}

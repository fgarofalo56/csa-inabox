/**
 * GET /api/governance/pdp-mode
 *
 * Returns the active Policy Decision Point enforcement mode so the policy-
 * authoring UI can state honestly whether Access policies are being ENFORCED,
 * only SHADOW-evaluated (the default — evaluated + logged, never blocks), or
 * OFF. The mode is a deployment-wide, non-sensitive config value (the value of
 * LOOM_PDP_ENFORCE), so this is a plain session-gated read — every signed-in
 * policy author needs to know which mode is live before they trust a policy to
 * take effect.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpEnforceMode } from '@/lib/auth/pdp/enforce';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const mode = pdpEnforceMode();
  return NextResponse.json({
    ok: true,
    mode, // 'shadow' (default) | 'enforce' | 'off'
    // `true` when Access policies actually block requests (enforce only).
    enforcing: mode === 'enforce',
    envVar: 'LOOM_PDP_ENFORCE',
  });
}

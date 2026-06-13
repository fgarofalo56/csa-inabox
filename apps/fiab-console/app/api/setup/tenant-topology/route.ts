/**
 * GET /api/setup/tenant-topology  (audit-t157)
 *
 * Returns the deployed hub's coordinates for the Setup Wizard. This is the
 * first-run discriminator AND the source of hub coordinates for the "Add
 * landing zone" (dlz-attach) flow:
 *
 *   { ok: true, exists: false }                       → no hub yet → FIRST RUN
 *                                                        (the /setup wizard runs
 *                                                        topology='tenant')
 *   { ok: true, exists: true, topology: {…coords…} }  → a hub exists → only
 *                                                        dlz-attach is allowed;
 *                                                        the /admin wizard reads
 *                                                        boundary/region/hub ids
 *                                                        from here (read-only,
 *                                                        never free-typed)
 *   { ok: false, error }                              → auth / Cosmos infra
 *
 * Secrets (App Insights connection string) are masked — the wizard only needs
 * the non-secret coordinates to render + the orchestrator fills the rest server
 * side from the same doc (loom-no-freeform-config + no-vaporware).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getTenantTopologySafe } from '@/lib/setup/tenant-topology';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const state = await getTenantTopologySafe();
  if (state.error) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not read tenant topology: ${state.error}`,
        hint:
          'The Console identity could not reach the Loom Cosmos DB. Confirm LOOM_COSMOS_ENDPOINT ' +
          'is set and the Console UAMI has the Cosmos DB Built-in Data Reader role on the account.',
      },
      { status: 502 },
    );
  }

  if (!state.exists || !state.topology) {
    // No hub deployed yet → first-run install path.
    return NextResponse.json({ ok: true, exists: false });
  }

  // Mask the only secret-ish field; expose the rest the wizard renders read-only.
  const { hubAppInsightsConnectionString, ...rest } = state.topology;
  return NextResponse.json({
    ok: true,
    exists: true,
    topology: {
      ...rest,
      hubAppInsightsConnectionStringSet: !!hubAppInsightsConnectionString,
    },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/deploy — Setup Orchestrator gate.
 *
 * The Setup Wizard's "Deploy" step requires a real Setup Orchestrator
 * service (FastAPI in setup-orchestrator/) that kicks off `azd deploy`
 * and tracks progress in Cosmos. That service is NOT deployed in the
 * current Loom environment — per .claude/rules/no-vaporware.md this
 * route returns 503 with the exact remediation rather than a fake
 * deploymentId that animates a stub progress UI.
 *
 * Until the Orchestrator service ships:
 *   - The Bicep parameters captured in the wizard are still echoed back
 *     so the user can copy them and run the deploy locally.
 *   - The UI should render an honest Fluent MessageBar pointing at the
 *     deploy commands below.
 */
export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));

  return NextResponse.json(
    {
      ok: false,
      error: 'Setup Orchestrator service is not deployed in this environment',
      remediation: {
        message: 'The Setup Wizard captures Bicep parameters but cannot run the deploy from the browser yet. Copy the parameters below and run the deploy locally:',
        commands: [
          'az login --tenant <your-tenant>',
          'az deployment sub create -l eastus2 \\',
          '  -f platform/fiab/bicep/main.bicep \\',
          '  -p platform/fiab/bicep/params/commercial-full.bicepparam',
          'bash scripts/csa-loom/post-deploy-bootstrap.sh',
        ],
        learnMoreUrl: '/learn?topic=setup-wizard',
        capturedConfig: body,
      },
    },
    { status: 503 },
  );
}

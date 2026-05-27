import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per no-vaporware.md: the legacy /data-agent pane is superseded by the
// real cross-item Copilot orchestrator at /copilot (which streams from
// /api/copilot/orchestrate against a real AOAI deployment on the Loom
// Foundry hub). This stub used to return a polite fake "you said: ..."
// echo that looked like a working agent — that's vaporware. Return an
// honest 503 with remediation so the pane surfaces a MessageBar.
export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  return NextResponse.json(
    {
      ok: false,
      error: 'legacy-data-agent-deprecated',
      remediation: {
        message:
          'The legacy /data-agent pane is not wired to a real backend in this deploy. ' +
          'Use the cross-item Copilot orchestrator at /copilot — it streams against the ' +
          'real AOAI deployment on the Loom Foundry hub and has registered tools across ' +
          'Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, and Foundry.',
        redirectTo: '/copilot',
        env: ['LOOM_FOUNDRY_HUB_ENDPOINT', 'LOOM_FOUNDRY_AOAI_DEPLOYMENT'],
        bicepModule: 'platform/fiab/bicep/modules/foundry/foundry-hub.bicep',
      },
    },
    { status: 503 },
  );
}

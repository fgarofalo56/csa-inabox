/**
 * POST /api/admin/parity-autopilot/run — WS-10.5 Parity Autopilot run trigger.
 *
 * Body: {
 *   slug: string,            // parity-doc slug (docs/fiab/parity/<slug>.md)
 *   docMarkdown: string,     // the raw parity-doc markdown (read script-side)
 *   imageBase64: string,     // base64 PNG/JPEG of the captured surface (Track-0)
 *   contentType?: string,    // default image/png
 *   route?: string,          // route override for the run doc
 *   capturedAt?, theme?, url?,// capture metadata for the run ledger + issue body
 *   dryRun?: boolean         // run diff + plan but do NOT file issues
 * }
 *
 * Pipeline (all REAL, no mocks): parse doc → AOAI vision diff → per-gap
 * plan-model + gh-issue filing → persist a run doc to the parity-autopilot-runs
 * Cosmos container. Honest gates (no AOAI vision deployment; no GitHub token) are
 * recorded INTO the run doc rather than fabricated — no-vaporware.md.
 *
 * Gated to tenant admins (enforceCapability 'admin.parity-autopilot', Admin).
 * This is also the endpoint the scheduled workflow (loom-parity-autopilot.yml)
 * drives via scripts/csa-loom/parity-autopilot.mjs with a minted session.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiHonestError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { runParityAutopilot } from '@/lib/parity/parity-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const CAP = 'admin.parity-autopilot';

export async function POST(req: NextRequest) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }

  const slug = String(body?.slug ?? '').trim();
  const docMarkdown = typeof body?.docMarkdown === 'string' ? body.docMarkdown : '';
  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
  if (!slug) return apiError('slug is required', 400);
  if (!docMarkdown) return apiError('docMarkdown is required (the parity doc content)', 400);
  if (!imageBase64) return apiError('imageBase64 is required (the captured screenshot)', 400);

  try {
    const run = await runParityAutopilot({
      slug,
      docMarkdown,
      imageBase64,
      contentType: typeof body?.contentType === 'string' ? body.contentType : undefined,
      routeOverride: typeof body?.route === 'string' ? body.route : undefined,
      capturedAt: typeof body?.capturedAt === 'string' ? body.capturedAt : undefined,
      theme: typeof body?.theme === 'string' ? body.theme : undefined,
      url: typeof body?.url === 'string' ? body.url : undefined,
      dryRun: body?.dryRun === true,
      ranBy: session!.claims.upn || session!.claims.oid || 'admin',
    });
    return apiOk({ run });
  } catch (e) {
    return apiHonestError(e, 500, 'Parity Autopilot run failed');
  }
}

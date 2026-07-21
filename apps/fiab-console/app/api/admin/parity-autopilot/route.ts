/**
 * GET /api/admin/parity-autopilot — WS-10.5 admin surface data.
 *
 * Returns the recent Parity Autopilot run ledger (from the parity-autopilot-runs
 * Cosmos container) + the currently OPEN auto-filed gap issues (from the real
 * GitHub REST API, label `parity-autopilot`). Both are REAL reads; when GitHub
 * egress is not configured the `issues` block reports an honest gate naming
 * LOOM_FEEDBACK_GITHUB_TOKEN (no-vaporware.md). Read-only — the run trigger is
 * the sibling POST /run route.
 *
 * Gated to tenant admins (enforceCapability 'admin.parity-autopilot', Reader).
 */
import { apiOk, apiHonestError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { listParityRuns } from '@/lib/parity/parity-run';
import { listParityGapIssues } from '@/lib/parity/parity-issue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CAP = 'admin.parity-autopilot';

export async function GET() {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Reader');
  if (gate) return gate;

  try {
    const [runs, issuesResult] = await Promise.all([listParityRuns(25), listParityGapIssues({ state: 'open', limit: 50 })]);
    return apiOk({
      runs,
      issues: issuesResult.issues,
      githubGated: issuesResult.gated || false,
      githubGateReason: issuesResult.reason,
      githubError: issuesResult.error,
    });
  } catch (e) {
    return apiHonestError(e, 500, 'Failed to load Parity Autopilot data');
  }
}

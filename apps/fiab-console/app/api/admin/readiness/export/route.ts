/**
 * GET /api/admin/readiness/export — the "ready-to-run" tenant profile (H3).
 *
 *   ?format=json  (default) → the machine-readable TenantProfile.
 *   ?format=md              → a readable markdown report.
 *
 * Both are computed from the SAME real sources as /api/admin/readiness (the gate
 * registry env-presence checks + the live self-audit probes) — no fabricated
 * status (no-vaporware.md). The report carries a timestamp, the environment
 * (subscription / resource groups / cloud — NO secret values), the ready
 * capabilities, and every gated dependency with its exact remediation, so a
 * team can share its readiness posture. Downloaded with a filename.
 *
 * Admin-scoped to the same capability as the gate registry.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { GATES, allGateStatuses } from '@/lib/gates/registry';
import {
  buildTenantProfile, renderProfileMarkdown, GATE_PROBE_MAP,
  type ProbeLite, type TenantEnvironment,
} from '@/lib/admin/readiness';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const envVal = (k: string) => (process.env[k] || '').trim() || undefined;

/** Present, non-secret deployment identity for the export header. */
function tenantEnvironment(): TenantEnvironment {
  return {
    app: envVal('LOOM_CONSOLE_APP_NAME') || 'loom-console',
    subscription: envVal('LOOM_SUBSCRIPTION_ID'),
    adminResourceGroup: envVal('LOOM_ADMIN_RG'),
    dlzResourceGroup: envVal('LOOM_DLZ_RG'),
    tenant: envVal('LOOM_ENTRA_TENANT_ID') || envVal('AZURE_TENANT_ID'),
    cloud: detectLoomCloud(),
  };
}

async function collectProbes(): Promise<ProbeLite[]> {
  const wanted = new Set(Object.values(GATE_PROBE_MAP));
  try {
    const { runSelfAudit } = await import('@/lib/admin/self-audit');
    const report = await runSelfAudit(new Date().toISOString());
    return report.results
      .filter((r) => wanted.has(r.id))
      .map((r) => ({ id: r.id, status: r.status, detail: r.detail, remediation: r.remediation }));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  const gate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (gate) return gate;

  const format = (req.nextUrl.searchParams.get('format') || 'json').toLowerCase();
  const now = new Date().toISOString();
  const stamp = now.slice(0, 19).replace(/[:T]/g, '-');

  const statuses = allGateStatuses();
  const probes = await collectProbes();
  const profile = buildTenantProfile(
    { gates: GATES, statuses, probes },
    { generatedAt: now, cloud: detectLoomCloud(), environment: tenantEnvironment() },
  );

  if (format === 'md' || format === 'markdown') {
    const md = renderProfileMarkdown(profile);
    return new NextResponse(md, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="loom-readiness-${stamp}.md"`,
      },
    });
  }

  return new NextResponse(JSON.stringify({ ok: true, profile }, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="loom-readiness-${stamp}.json"`,
    },
  });
}

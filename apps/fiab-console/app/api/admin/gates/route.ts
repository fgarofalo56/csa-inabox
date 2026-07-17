/**
 * GET /api/admin/gates — the COMPLETE gate registry + live status in ONE call.
 *
 * Returns every gate in lib/gates/registry.ts (derived from self-audit
 * ENV_CHECKS — the single declarative source) with its LIVE evaluation:
 * 'configured' (every required value present or auto-resolved default) or
 * 'blocked' (missing values; the owning surfaces honest-gate). The evaluation
 * is the REAL env-presence check the per-client *ConfigGate() helpers gate on
 * — no synthetic status (no-vaporware.md). Also reports whether the runtime
 * env-write path (ACA revision / AKS rolling update) is available so the UI
 * can be honest about what "Fix it" will do.
 *
 * Read-scoped to the same admin capability as env-config (the registry names
 * every deployment env var, an estate-level concern).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { GATES, allGateStatuses } from '@/lib/gates/registry';
import { envWriteAvailability } from '@/lib/admin/env-apply';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  const gate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (gate) return gate;

  const statuses = allGateStatuses();
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const gates = GATES.map((g) => {
    const st = byId.get(g.id);
    return {
      ...g,
      status: st?.status ?? 'blocked',
      missing: st?.missing ?? [],
      detail: st?.check.detail,
      portalSteps: st?.check.portalSteps,
      fixScript: st?.check.fixScript,
    };
  });
  const configured = gates.filter((g) => g.status === 'configured').length;
  const { platform, writeConfigured, writeError } = envWriteAvailability();

  return NextResponse.json({
    ok: true,
    count: gates.length,
    configured,
    blocked: gates.length - configured,
    gates,
    platform,
    writeConfigured,
    writeError,
    cloud: detectLoomCloud(),
  });
}

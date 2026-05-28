/**
 * GET /api/copilot/status — orchestrator diagnostic.
 *
 * Loads on the /copilot-loom page so the user sees an honest banner
 * showing whether AOAI is reachable, how many tools are registered,
 * and which dependencies are blocked. Mirrors the no-vaporware rule:
 * if AOAI isn't wired, the user gets the exact env var / Foundry-hub
 * step needed to fix it, not a blank chat box.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  getRegistry,
  listSessions,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const reg = getRegistry();
  const tools = reg.list();
  const byService: Record<string, number> = {};
  for (const t of tools) {
    byService[t.service] = (byService[t.service] ?? 0) + 1;
  }

  let aoai: { ok: boolean; endpoint?: string; deployment?: string; apiVersion?: string; error?: string; remediation?: string } = { ok: false };
  try {
    const t = await resolveAoaiTarget();
    aoai = { ok: true, endpoint: t.endpoint, deployment: t.deployment, apiVersion: t.apiVersion };
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      aoai = {
        ok: false,
        error: e.message,
        remediation:
          'Deploy a gpt-4o or gpt-4 model to your Azure AI Foundry hub, then either ' +
          '(a) register the Foundry connection so the orchestrator auto-discovers it, ' +
          'or (b) set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT env vars on the Loom Console Container App.',
      };
    } else {
      aoai = { ok: false, error: e?.message || String(e) };
    }
  }

  let recentSessionCount = 0;
  try {
    const userOid = session.claims.oid || session.claims.upn || '';
    if (userOid) {
      const ss = await listSessions(userOid, 50);
      recentSessionCount = ss.length;
    }
  } catch {
    // Cosmos not provisioned yet — leave at 0 silently.
  }

  return NextResponse.json({
    ok: true,
    aoai,
    tools: {
      count: tools.length,
      byService,
    },
    sessions: { recent: recentSessionCount },
    ready: aoai.ok && tools.length > 0,
  });
}

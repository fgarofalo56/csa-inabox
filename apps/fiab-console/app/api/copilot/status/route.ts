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
import { isSafetyConfigured } from '@/lib/azure/foundry-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { detectLoomCloud, isGovCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // Active sovereign boundary — surfaced regardless of AOAI config so the pane
  // can badge the cloud and pick the right AI Studio portal deep-link.
  const cloud = detectLoomCloud();
  // Commercial / GCC create AOAI in ai.azure.com; GCC-High / IL5 / DoD in ai.azure.us.
  const portalDeepLink = isGovCloud() ? 'https://ai.azure.us' : 'https://ai.azure.com';

  const reg = getRegistry();
  const tools = reg.list();
  const byService: Record<string, number> = {};
  for (const t of tools) {
    byService[t.service] = (byService[t.service] ?? 0) + 1;
  }

  let aoai: {
    ok: boolean;
    endpoint?: string;
    deployment?: string;
    model?: string;
    apiVersion?: string;
    error?: string;
    remediation?: string;
    portalDeepLink?: string;
  } = { ok: false };
  try {
    // Load the tenant's admin-selected Copilot/Foundry config and pass it —
    // the admin picker is the source of truth. Calling resolveAoaiTarget() bare
    // ignored the saved config and falsely reported "not reachable" even when
    // the orchestrate route (which DOES pass the config) could chat fine.
    const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
    const t = await resolveAoaiTarget(tenantConfig);
    aoai = {
      ok: true,
      endpoint: t.endpoint,
      deployment: t.deployment,
      // `model` is the task-contract alias of `deployment` consumed by the pane.
      model: t.deployment,
      apiVersion: t.apiVersion,
    };
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      aoai = {
        ok: false,
        error: e.message,
        remediation:
          'Set the Copilot chat model under Admin → Tenant settings → Copilot & Agents: pick your ' +
          'Foundry account + a deployed gpt-4o / gpt-4.1-class chat deployment (this is the source of truth). ' +
          'Deploy such a model to your Azure AI Foundry hub first if none exists. ' +
          '(Env fallback: LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT on the Console Container App.)',
        // Deep-link to the cloud-correct AI Foundry portal so the pane's
        // MessageBar "Configure in AI Studio" link goes to the right sovereign UI.
        portalDeepLink,
      };
    } else {
      aoai = { ok: false, error: e?.message || String(e), portalDeepLink };
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
    // Top-level task-contract fields the copilot pane reads to decide whether to
    // render the chat panel or the honest-gate MessageBar.
    configured: aoai.ok,
    cloud,
    endpoint: aoai.ok ? aoai.endpoint : undefined,
    model: aoai.ok ? aoai.deployment : undefined,
    aoai,
    // Whether the AI Content Safety pipeline is wired. When false the pane
    // shows an honest "prompts are not filtered" warning MessageBar (the
    // copilot still works — honest-gate, not a silent pass).
    contentSafety: isSafetyConfigured(),
    tools: {
      count: tools.length,
      byService,
    },
    sessions: { recent: recentSessionCount },
    ready: aoai.ok && tools.length > 0,
  });
}

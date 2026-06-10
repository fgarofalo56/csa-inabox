/**
 * Ops Admin Copilot — classify endpoint.
 *
 *   POST /api/admin/ops-copilot   { prompt: string }
 *
 * 1. Validates the session (401 if absent).
 * 2. RBAC gate: when LOOM_OPS_ADMIN_ENTRA_GROUP is set, the caller must be a
 *    (transitive) member of that Entra group. If not → 403 with an honest
 *    `rbacGate` message naming the group + the Azure RBAC the action needs.
 *    (Unset env → any signed-in admin, matching the rest of the admin pane.)
 * 3. Resolves the tenant's AOAI target and classifies the NL prompt into a
 *    single OpsIntention (reading current Azure state for the diff). NOTHING is
 *    mutated here — execution happens at /api/admin/ops-copilot/execute after
 *    the admin approves the diff.
 * 4. The pending intention is persisted to the Cosmos copilot-sessions
 *    container (kind 'ops-intention') bound to callerOid so only the same admin
 *    can execute it.
 *
 * Real AOAI, real ARM reads, real Graph. No mocks. Azure-native (no Fabric).
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { graphBase, graphScope } from '@/lib/azure/cloud-endpoints';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { classifyOpsIntent, OpsUnconfiguredError } from '@/lib/copilot/ops-tools';
import { OPS_COPILOT_PERSONAS, OPS_PERSONA_ID } from '@/lib/azure/copilot-personas';
import { copilotSessionsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const persona = OPS_COPILOT_PERSONAS[OPS_PERSONA_ID];

/**
 * True when `callerOid` is a transitive member of LOOM_OPS_ADMIN_ENTRA_GROUP.
 * Unset env → true (any signed-in admin). Uses Microsoft Graph transitiveMembers
 * (covered by the Console UAMI's existing Group.Read.All AppRole). A Graph
 * outage is fail-CLOSED for a configured group (returns false) so we never let
 * an unverified caller through.
 */
async function callerIsOpsAdmin(callerOid: string): Promise<boolean> {
  const groupId = (process.env.LOOM_OPS_ADMIN_ENTRA_GROUP || '').trim();
  if (!groupId) return true;
  if (!callerOid) return false;
  let token: string;
  try {
    const t = await credential.getToken(graphScope());
    if (!t?.token) return false;
    token = t.token;
  } catch {
    return false;
  }
  // Direct membership-by-id existence check first (cheap), then enumerate.
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json', ConsistencyLevel: 'eventual' };
  try {
    const res = await fetch(`${graphBase()}/groups/${groupId}/transitiveMembers/${callerOid}?$select=id`, {
      headers,
      cache: 'no-store',
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
  } catch {
    return false;
  }
  // Fallback: checkMemberGroups resolves nested membership for the user.
  try {
    const res = await fetch(`${graphBase()}/users/${callerOid}/checkMemberGroups`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ groupIds: [groupId] }),
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const j = await res.json();
    return Array.isArray(j?.value) && j.value.includes(groupId);
  } catch {
    return false;
  }
}

function rbacGateMessage(): string {
  const grp = process.env.LOOM_OPS_ADMIN_ENTRA_GROUP || 'LOOM_OPS_ADMIN_ENTRA_GROUP';
  const actions = (persona?.requiredArmActions || []).join(', ');
  return (
    `You are not a member of the Ops Admin group (${grp}). ` +
    `Ask a Global Admin to add your account to that Entra group. ` +
    (actions ? `The group's identity also needs the Azure RBAC actions: ${actions}.` : '')
  );
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const callerOid = session.claims.oid || session.claims.upn || session.claims.email || '';

  let body: { prompt?: string } = {};
  try { body = await req.json(); } catch {}
  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  }

  // RBAC gate (honest, names the group + role).
  if (!(await callerIsOpsAdmin(callerOid))) {
    return NextResponse.json({ ok: false, rbacGate: rbacGateMessage() }, { status: 403 });
  }

  // Resolve AOAI — surface AOAI-missing as 503 so the pane can deep-link.
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid);
  let target;
  try {
    target = await resolveAoaiTarget(tenantConfig);
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Classify (reads current Azure state, no mutation).
  let cls;
  try {
    cls = await classifyOpsIntent(prompt, target, persona.systemPrompt);
  } catch (e: any) {
    if (e instanceof OpsUnconfiguredError) {
      // Honest infra gate — the resource named isn't provisioned in this deployment.
      return NextResponse.json({ ok: false, configGate: e.message }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // A clarify result needs no approval/execution.
  if (cls.intention.action === 'clarify') {
    return NextResponse.json({ ok: true, clarify: cls.intention.question });
  }

  // Persist the pending intention bound to this caller for the execute step.
  const intentionId = `ops-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const c = await copilotSessionsContainer();
    await c.items.create({
      id: intentionId,
      sessionId: intentionId,
      userOid: callerOid,
      kind: 'ops-intention',
      intention: cls.intention,
      diffSummary: cls.diffSummary,
      prompt,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `Could not stage intention: ${e?.message || e}` }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    intentionId,
    intention: cls.intention,
    diffSummary: cls.diffSummary,
    diff: cls.diff || [],
  });
}

/**
 * /api/aml/compute-instances/mine — the caller's OWN Azure ML Compute Instance.
 *
 * Azure ML Compute Instances are single-user: only the user a CI is *assigned*
 * to (personalComputeInstanceSettings.assignedUser) can start / run on it. A
 * shared default CI therefore can't make notebooks multi-user. This route makes
 * every signed-in user provision (or attach) a CI owned by THEM.
 *
 * GET  — returns the caller's per-user CI (if it exists), the deterministic name
 *        it would be created as, the per-user policy (enabled? default VM size /
 *        idle TTL), and the tenant quota state so the picker can offer
 *        "Create my compute instance" or show an honest quota gate. Real ARM:
 *          GET .../workspaces/{ws}/computes?api-version=2024-10-01
 *        filtered to computeType==='ComputeInstance' and assignedUser===caller.
 *
 * POST — creates the caller's per-user CI as a *personal* compute instance:
 *          PUT .../workspaces/{ws}/computes/{ci-loom-<oid>}?api-version=2024-10-01
 *          body …personalComputeInstanceSettings.assignedUser={ objectId, tenantId }
 *        Then best-effort sets the idle-shutdown TTL. Body (optional):
 *          { vmSize?, idleTtl? } — otherwise the bicep per-user defaults apply.
 *        Enforces LOOM_AML_CI_MAX (honest 409 quota gate) before creating.
 *
 * Honest gates (per no-vaporware.md): 200 { configured:false } when no AML
 * workspace env; 403 → "AzureML Compute Operator" role gate; 409 when the tenant
 * per-user CI ceiling is hit. Azure-native — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listCIs,
  createCI,
  updateCiIdleShutdown,
  ciIsRunning,
  ciIsStopped,
  amlIsConfigured,
  amlConfig,
  perUserCiConfig,
  perUserCiName,
  isPerUserCi,
  ciIsOwnedBy,
  AmlNotConfiguredError,
  AmlError,
  type AmlComputeInstance,
} from '@/lib/azure/aml-client';
import { computeRoleGate } from '@/lib/azure/foundry-compute-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ISO-8601 idle-TTL durations the UI offers (dropdown only — no freeform). */
const ALLOWED_TTL = new Set(['PT15M', 'PT30M', 'PT1H', 'PT2H', 'PT3H', 'PT4H']);
/** VM sizes the UI offers for a per-user CI (dropdown only — no freeform). */
const ALLOWED_VM = new Set([
  'Standard_DS3_v2', 'Standard_DS11_v2', 'Standard_DS12_v2', 'Standard_E4ds_v4', 'Standard_NC6s_v3',
]);

function ciView(ci: AmlComputeInstance) {
  return {
    name: ci.name,
    vmSize: ci.vmSize,
    state: ci.state,
    running: ciIsRunning(ci.state),
    stopped: ciIsStopped(ci.state),
    assignedUserObjectId: ci.assignedUserObjectId,
  };
}

/** The AAD tenant id CIs are assigned in (single-tenant deployment env). */
function tenantId(): string {
  return (process.env.AZURE_TENANT_ID || process.env.LOOM_TENANT_ID || '').trim();
}

function notConfigured() {
  const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
  return NextResponse.json(
    { ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint },
    { status: 200 },
  );
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const oid = s.claims.oid;
  const policy = perUserCiConfig();
  const myName = perUserCiName(oid);

  if (!amlIsConfigured()) {
    return NextResponse.json({
      ok: false, configured: false, enabled: policy.enabled, myName, policy,
      error: 'Azure ML workspace not configured',
      hint: new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']).hint,
    }, { status: 200 });
  }

  try {
    const cfg = amlConfig();
    const cis = await listCIs();
    const mine = cis.find((c) => ciIsOwnedBy(c, oid)) || null;
    const perUserCount = cis.filter(isPerUserCi).length;
    return NextResponse.json({
      ok: true,
      configured: true,
      enabled: policy.enabled,
      workspace: cfg.workspace,
      myName,
      policy,
      mine: mine ? ciView(mine) : null,
      quota: {
        used: perUserCount,
        max: policy.maxPerTenant,
        atLimit: perUserCount >= policy.maxPerTenant,
      },
    });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) return notConfigured();
    if (e instanceof AmlError && e.status === 403) {
      return NextResponse.json(computeRoleGate('list your compute instances'), { status: 403 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: Request) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const oid = s.claims.oid;
  const tid = tenantId();
  const policy = perUserCiConfig();
  const myName = perUserCiName(oid);

  if (!policy.enabled) {
    return NextResponse.json(
      { ok: false, error: 'Per-user Compute Instances are disabled in this deployment (LOOM_AML_PERUSER_ENABLED=false).' },
      { status: 403 },
    );
  }
  if (!oid || !tid) {
    return NextResponse.json(
      { ok: false, error: 'Cannot provision a per-user Compute Instance: the signed-in user is missing an AAD objectId or the tenant id (AZURE_TENANT_ID) is not configured.' },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const vmSize = body?.vmSize ? String(body.vmSize).trim() : policy.vmSize;
  const idleTtl = body?.idleTtl ? String(body.idleTtl).trim() : policy.idleTtl;
  if (!ALLOWED_VM.has(vmSize)) {
    return NextResponse.json({ ok: false, error: `vmSize must be one of ${[...ALLOWED_VM].join(', ')}` }, { status: 400 });
  }
  if (!ALLOWED_TTL.has(idleTtl)) {
    return NextResponse.json({ ok: false, error: `idleTtl must be one of ${[...ALLOWED_TTL].join(', ')}` }, { status: 400 });
  }

  if (!amlIsConfigured()) return notConfigured();

  try {
    // If the caller already owns a CI, return it (idempotent attach) rather than
    // 409-ing on a duplicate ARM PUT.
    const existing = await listCIs();
    const already = existing.find((c) => ciIsOwnedBy(c, oid));
    if (already) {
      return NextResponse.json({ ok: true, name: already.name, state: already.state || 'Unknown', mine: ciView(already), reused: true });
    }

    // Honest per-tenant quota gate (cost guard). Counts Loom-managed per-user
    // CIs across the workspace against LOOM_AML_CI_MAX.
    const perUserCount = existing.filter(isPerUserCi).length;
    if (perUserCount >= policy.maxPerTenant) {
      return NextResponse.json({
        ok: false,
        quotaGate: true,
        error: `Per-user Compute Instance limit reached (${perUserCount}/${policy.maxPerTenant}). An administrator can raise LOOM_AML_CI_MAX, or stop/delete unused Compute Instances in the Azure ML workspace to free capacity.`,
        quota: { used: perUserCount, max: policy.maxPerTenant, atLimit: true },
      }, { status: 409 });
    }

    const ci = await createCI(myName, {
      vmSize,
      idleTimeBeforeShutdown: idleTtl,
      assignedUser: { objectId: oid, tenantId: tid },
    });
    // Best-effort: also set the idle-shutdown via the dedicated action (some API
    // versions ignore idleTimeBeforeShutdown in the create body). Non-fatal.
    try { await updateCiIdleShutdown(myName, idleTtl); } catch { /* create succeeded; TTL is a nicety */ }

    return NextResponse.json(
      { ok: true, name: ci.name, state: ci.state || 'Creating', provisioningState: ci.provisioningState || 'Creating', mine: ciView(ci) },
      { status: 202 },
    );
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) return notConfigured();
    if (e instanceof AmlError && e.status === 403) {
      return NextResponse.json(computeRoleGate('create your compute instance'), { status: 403 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

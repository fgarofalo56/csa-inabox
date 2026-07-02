/**
 * /api/aml/compute-instances
 *
 * GET  — Lists the Azure Machine Learning workspace's Compute Instances (CI) —
 *        the compute a notebook runs on, on the AML path. Real ARM:
 *          GET .../workspaces/{ws}/computes?api-version=2024-10-01
 *        filtered to computeType === 'ComputeInstance'. Also surfaces
 *        LOOM_AML_DEFAULT_COMPUTE so the editor can auto-select the bicep
 *        default CI once it exists.
 *
 * POST — Creates a Compute Instance. Body { name, vmSize, idleTtl? }. Real ARM:
 *          PUT .../workspaces/{ws}/computes/{name}?api-version=2024-10-01
 *
 * Honest gate: when the AML workspace env isn't configured we return 200 with
 * { ok: false, configured: false, hint } so the editor's CI picker shows a
 * Fluent MessageBar. A 403 surfaces the "AzureML Compute Operator" role gate.
 * Azure-native default — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listCIs, createCI, ciIsRunning, ciIsStopped, amlIsConfigured, amlConfig, AmlNotConfiguredError, AmlError } from '@/lib/azure/aml-client';
import { computeRoleGate } from '@/lib/azure/foundry-compute-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The deterministic CI name the bicep default Compute Instance is created as. */
function defaultComputeName(): string | null {
  return process.env.LOOM_AML_DEFAULT_COMPUTE?.trim() || null;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json(
      { ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint, instances: [], defaultCompute: defaultComputeName() },
      { status: 200 },
    );
  }

  try {
    const cfg = amlConfig();
    const cis = await listCIs();
    return NextResponse.json({
      ok: true,
      configured: true,
      workspace: cfg.workspace,
      // The bicep-provisioned default CI name (LOOM_AML_DEFAULT_COMPUTE) so the
      // editor auto-selects it when nothing else is chosen.
      defaultCompute: defaultComputeName(),
      instances: cis.map((c) => ({
        name: c.name,
        vmSize: c.vmSize,
        state: c.state,
        running: ciIsRunning(c.state),
        stopped: ciIsStopped(c.state),
      })),
    });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json({ ok: false, configured: false, error: e.message, hint: e.hint, instances: [], defaultCompute: defaultComputeName() }, { status: 200 });
    }
    if (e instanceof AmlError && e.status === 403) {
      return NextResponse.json(computeRoleGate('list compute instances'), { status: 403 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/** A CI name must match the AML compute naming rules (3-24, alnum + hyphen). */
const CI_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]{2,23}$/;
/** ISO-8601 idle-TTL durations the UI offers (dropdown only — no freeform). */
const ALLOWED_TTL = new Set(['PT15M', 'PT30M', 'PT1H', 'PT2H', 'PT3H', 'PT4H']);

export async function POST(req: Request) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const name = String(body?.name || '').trim();
  const vmSize = String(body?.vmSize || '').trim();
  const idleTtl = body?.idleTtl ? String(body.idleTtl).trim() : undefined;

  if (!CI_NAME_RE.test(name)) {
    return NextResponse.json(
      { ok: false, error: 'name must be 3-24 chars, start with a letter, and use only letters, numbers, and hyphens' },
      { status: 400 },
    );
  }
  if (!vmSize) {
    return NextResponse.json({ ok: false, error: 'vmSize is required' }, { status: 400 });
  }
  if (idleTtl && !ALLOWED_TTL.has(idleTtl)) {
    return NextResponse.json({ ok: false, error: `idleTtl must be one of ${[...ALLOWED_TTL].join(', ')}` }, { status: 400 });
  }

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json({ ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint }, { status: 200 });
  }

  try {
    const ci = await createCI(name, { vmSize, idleTimeBeforeShutdown: idleTtl });
    return NextResponse.json(
      { ok: true, name: ci.name, state: ci.state || 'Creating', provisioningState: ci.provisioningState || 'Creating' },
      { status: 202 },
    );
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json({ ok: false, configured: false, error: e.message, hint: e.hint }, { status: 200 });
    }
    if (e instanceof AmlError && e.status === 403) {
      return NextResponse.json(computeRoleGate('create compute instances'), { status: 403 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

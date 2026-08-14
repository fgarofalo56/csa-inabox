/**
 * POST /api/setup/validate-adoption
 *
 * THE validation step the Setup Wizard has been telling operators to run.
 *
 * ## Why this route exists (#3376, and the root of #3342)
 *
 * `planBlockers()` emits `"<svc>: adoption has not been validated yet — run the
 * validation step."` for every `adopt` decision with no fitness verdict, and the
 * wizard disables Next on any blocker. Measured 2026-08-13: `evaluateFitness()`
 * had **zero production callers**, so that verdict could never arrive and the
 * step the message named **did not exist**. Because `recommendFor()` picks
 * `adopt` whenever a candidate is found, that dead end was the DEFAULT outcome
 * on a brownfield tenant.
 *
 * `docs/fiab/deployment/brownfield.md` then handed the customer five `az`
 * commands to answer the question themselves — `deploy-integrity.md` R5.4
 * ("validate the chosen existing resource is actually usable ... and say
 * precisely what is wrong when it is not") unimplemented, with the shortfall
 * passed to the customer, and `auto-bind-by-default.md` §5 (the platform asking
 * a human to perform what it can perform itself).
 *
 * This route performs those reads with the operator's own token.
 *
 * ## Honesty contract
 *
 * Every verdict is derived from an ARM read that actually happened. A read that
 * 403s, 404s or times out produces `unknown` — never `unusable`, and never a
 * silent pass. Each result carries `established`: the reads attempted and their
 * outcomes, so a verdict can only assert what the probe observed
 * (deploy-integrity R7). Checks needing a data plane this route holds no token
 * for at plan time stay `unknown` with the remediation `fitness.ts` writes.
 *
 * Gated on `admin.deploy-dlz` — the same capability as `POST /api/setup/deploy`
 * and `GET /api/setup/discover-services`, since this reads across the
 * subscriptions a deployment plan spans.
 *
 * Request:
 *   { hubRegion: string,
 *     hubTenantId?: string,
 *     adoptions: [{ serviceKey, target: { name, rg, sub } }] }
 *   — or —
 *   { hubRegion: string, plan: { services: { <key>: { mode, target } } } }
 *
 * Response:
 *   { ok: true, credentialTier, results: [{ serviceKey, verdict, checks, established }] }
 *   { ok: false, error, code?, hint? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { withSession } from '@/lib/api/route-toolkit';
import { acquireCredentials } from '@/lib/deploy/discovery-scanner';
import {
  probeAdoptions,
  targetIsWellFormed,
  type AdoptTarget,
  type ProbeContext,
} from '@/lib/deploy/fitness-probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Each probe is bounded at 12s and they run concurrently; this is the ceiling. */
export const maxDuration = 60;

interface AdoptionInput {
  serviceKey: string;
  target: AdoptTarget;
}

/**
 * PURE: pull the adopt decisions out of either accepted request shape.
 *
 * Returns the well-formed adoptions AND the malformed ones separately — a
 * coordinate this route cannot build a scope from is REPORTED, never dropped.
 * Silently skipping it would leave the plan with no verdict for that service
 * and the operator staring at the same "run the validation step" blocker.
 */
export function collectAdoptions(body: any): {
  adoptions: AdoptionInput[];
  malformed: { serviceKey: string; why: string }[];
} {
  const adoptions: AdoptionInput[] = [];
  const malformed: { serviceKey: string; why: string }[] = [];

  const push = (serviceKey: string, target: any) => {
    const t: AdoptTarget = {
      name: String(target?.name ?? ''),
      rg: String(target?.rg ?? target?.resourceGroup ?? ''),
      sub: String(target?.sub ?? target?.subscriptionId ?? ''),
    };
    if (!targetIsWellFormed(t)) {
      malformed.push({
        serviceKey,
        why: 'the adopt target is missing a valid subscription id, resource group or resource name',
      });
      return;
    }
    adoptions.push({ serviceKey, target: t });
  };

  if (Array.isArray(body?.adoptions)) {
    for (const a of body.adoptions) {
      if (a?.serviceKey) push(String(a.serviceKey), a.target);
    }
  } else if (body?.plan?.services && typeof body.plan.services === 'object') {
    for (const [serviceKey, d] of Object.entries<any>(body.plan.services)) {
      if (d?.mode === 'adopt') push(serviceKey, d.target);
    }
  }
  return { adoptions, malformed };
}

export const POST = withSession(async (req: NextRequest, { session }) => {
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'a JSON body is required' }, { status: 400 });
  }

  // The hub region is COMPARED against, not guessed. Defaulting it to '' would
  // make every cross-region check fail against an empty string and report a
  // perfectly good resource as unusable — asserting something not established.
  const hubRegion = String(body?.hubRegion ?? '').trim();
  if (!hubRegion) {
    return NextResponse.json(
      {
        ok: false,
        error: 'hubRegion is required',
        hint:
          'The region check compares each adopted resource against the hub region. Without it this route would have to guess, and a guessed comparison would report an in-region resource as cross-region.',
      },
      { status: 400 },
    );
  }

  const { adoptions, malformed } = collectAdoptions(body);
  if (adoptions.length === 0 && malformed.length === 0) {
    return NextResponse.json({ ok: true, credentialTier: null, results: [], malformed: [] });
  }

  // Same credential ladder as discovery: the signed-in operator first (at first
  // run they are typically Owner while the Console UAMI may not yet hold Reader
  // on the subscriptions holding the candidates), Console UAMI second.
  const creds = await acquireCredentials(session.claims?.oid);
  const token = creds.userToken || creds.uamiToken;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: 'no credential could be acquired to read the adopted resources',
        code: 'not_configured',
        hint:
          creds.uamiError ||
          'Sign in again so the Console can use your delegated ARM token, or grant the Console identity Reader on the subscriptions holding the resources you are adopting.',
      },
      { status: 503 },
    );
  }

  const ctx: ProbeContext = {
    hubRegion,
    hubTenantId: String(body?.hubTenantId ?? session.claims?.tid ?? process.env.AZURE_TENANT_ID ?? ''),
    consolePrincipalId: (process.env.LOOM_CONSOLE_PRINCIPAL_ID || '').trim() || undefined,
  };

  const probed = await probeAdoptions(adoptions, ctx, token, undefined);

  return NextResponse.json({
    ok: true,
    credentialTier: creds.userToken ? 'user' : 'uami',
    results: probed.map((p) => ({
      serviceKey: p.serviceKey,
      verdict: p.fitness.verdict,
      checks: p.fitness.checks,
      established: p.established,
    })),
    // Reported, not dropped — see collectAdoptions.
    malformed,
  });
});

/**
 * GET  /api/admin/scaling/container-apps — list Loom container apps + current
 *      scale + the workload profiles each app's OWN managed environment declares.
 * POST /api/admin/scaling/container-apps — { name, workloadProfileName?, minReplicas?, maxReplicas? }
 *
 * Real ARM PATCH against Microsoft.App/containerApps/{name}.
 *
 * ── #3895: THE PICKER OFFERED PROFILES THE ENVIRONMENT DOES NOT HAVE ────────
 *
 * This route used to validate `workloadProfileName` against a HARD-CODED set of
 * nine names. An app can only be bound to a profile its managed ENVIRONMENT
 * declares, and the live Commercial environment `cae-csa-loom-centralus`
 * declares exactly two (`Consumption`, `D8`) — so seven of the eight
 * non-Consumption options passed this check and were then rejected by ARM with a
 * raw 400. The operator could not tell "unavailable in my environment" from
 * "the platform is broken".
 *
 * The hard-coded list is gone from the decision path. GET returns each app's
 * `availableProfiles`, read from its environment, so the picker is populated
 * from the estate; POST re-validates the same way inside
 * `updateContainerAppScale`, so a hand-crafted request cannot bypass the UI.
 *
 * `cloud-parity.md`: the declared set is per-environment and therefore
 * per-cloud. Reading it is the only implementation that is correct in
 * Commercial and in every sovereign boundary at once — a second hard-coded list
 * would have re-created the defect there.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import {
  listContainerAppsWithProfiles, updateContainerAppScale, AcaNotConfiguredError,
} from '@/lib/azure/container-apps-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  try {
    // Each app carries the profiles ITS environment declares (#3895). One ARM
    // read per distinct environment; a per-environment read failure rides along
    // as `profilesError` instead of failing the whole list, so the replica
    // controls keep working when only the profile read is denied.
    const apps = await listContainerAppsWithProfiles();
    return NextResponse.json({ ok: true, apps });
  } catch (e: any) {
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({
        ok: false, error: e.message,
        hint: `Set ${e.missing.join(', ')} on loom-console.`,
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as {
    name?: string;
    workloadProfileName?: string;
    minReplicas?: number;
    maxReplicas?: number;
  };
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  // #3895 — the profile is validated against the app's ENVIRONMENT, inside
  // `updateContainerAppScale`, because only the environment knows the answer.
  // What is checked here is the SHAPE, so a free-form string never reaches an
  // ARM URL or a message: a name is at most 63 chars of alphanumerics and
  // hyphens (ARM's own rule for the profile name).
  if (body.workloadProfileName !== undefined
      && (typeof body.workloadProfileName !== 'string' || !/^[A-Za-z0-9-]{1,63}$/.test(body.workloadProfileName))) {
    return NextResponse.json({
      ok: false,
      error: 'workloadProfileName must be 1-63 characters of letters, digits or hyphens. '
        + 'The set actually selectable is declared by the app\'s managed environment and is returned '
        + 'per app as `availableProfiles` by GET on this route.',
    }, { status: 400 });
  }
  if (typeof body.minReplicas === 'number' && body.minReplicas < 0) {
    return NextResponse.json({ ok: false, error: 'minReplicas must be >= 0' }, { status: 400 });
  }
  if (typeof body.maxReplicas === 'number' && (body.maxReplicas < 1 || body.maxReplicas > 1000)) {
    return NextResponse.json({ ok: false, error: 'maxReplicas must be 1-1000' }, { status: 400 });
  }
  try {
    const app = await updateContainerAppScale(body.name, {
      workloadProfileName: body.workloadProfileName,
      minReplicas: body.minReplicas,
      maxReplicas: body.maxReplicas,
    });
    return NextResponse.json({ ok: true, app });
  } catch (e: any) {
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status: e?.status || 502 });
  }
}

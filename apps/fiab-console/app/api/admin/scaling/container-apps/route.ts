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
 *
 * ── #4279: THIS ROUTE WAS A SECOND DOOR TO AN UNRECOVERABLE SCALE-TO-ZERO ───
 *
 * `minReplicas: 0` was accepted for ANY app. The only replica check was
 * `minReplicas < 0`, so zero — the one value that is destructive rather than
 * merely small — sailed through to an ARM PATCH. The console's own spinner on
 * /admin/scaling lets an operator type it, so this was reachable from the UI,
 * not only from a hand-crafted request.
 *
 * `loom-risingwave-aca.bicep` states the consequence in the deploy's own words:
 * "a scaled-to-zero replica loses every MV definition and its progress". The
 * Brain's executor was guarded against exactly this in #4257/#4261; this route
 * predates that executor and had NONE of its scaffolding.
 *
 * The fix reuses that SAME derivation — `refuseScaleToZero`, which reads the
 * compiled deploy template rather than a hand-maintained name list. It is
 * deliberately NOT a second parallel check: a hand list here would drift from
 * the bicep the day someone adds a stateful service, which is the failure mode
 * deriving from the template exists to prevent. One derivation, every caller.
 *
 * It FAILS CLOSED. Per #4261's review rounds every "I could not establish this"
 * state refuses — an unreadable template is not an empty one, and treating it as
 * empty would let one bad read permit every scale-to-zero on the estate
 * (deploy-integrity.md R7).
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  listContainerAppsWithProfiles, updateContainerAppScale, AcaNotConfiguredError,
} from '@/lib/azure/container-apps-arm-client';
import { refuseScaleToZero, scaleToZeroRefusalReason } from '@/lib/brain-actions/scalability';
import { withDlzAccess } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withDlzAccess('scaling', async (_req: NextRequest) => {
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
});

export const POST = withDlzAccess('scaling', async (req: NextRequest) => {
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
  // The TYPE gate is load-bearing for the #4279 guard below, not hygiene. The
  // previous `typeof === 'number' && < 0` test let a STRING pass untouched, so
  // `minReplicas: '0'` missed both the negative check and a `=== 0` guard and
  // would still have reached ARM as a scale-to-zero. Narrowing to a
  // non-negative INTEGER here means the guard below sees only real numbers and
  // cannot be stepped around with a type.
  if (body.minReplicas !== undefined
      && (typeof body.minReplicas !== 'number' || !Number.isInteger(body.minReplicas) || body.minReplicas < 0)) {
    return NextResponse.json({ ok: false, error: 'minReplicas must be a non-negative integer' }, { status: 400 });
  }
  if (typeof body.maxReplicas === 'number' && (body.maxReplicas < 1 || body.maxReplicas > 1000)) {
    return NextResponse.json({ ok: false, error: 'maxReplicas must be 1-1000' }, { status: 400 });
  }
  // ── #4279 — the DEPLOY decides scale-to-zero, and it decides BEFORE ARM ────
  // Zero is not "a small number": for a service whose state lives in-process it
  // is unrecoverable data loss, and the deploy template is the only source that
  // knows which services those are. `refuseScaleToZero` is the same derivation
  // the Brain executor uses (#4257/#4261) — reused, never re-implemented, so a
  // new stateful service is covered here the day its bicep pins it.
  //
  // It fails CLOSED: an unreadable/absent/empty template, and a subject shadowed
  // by an unresolved app name, all REFUSE rather than fall through to allow.
  if (body.minReplicas === 0) {
    const refusal = refuseScaleToZero(body.name);
    if (refusal) {
      return NextResponse.json({
        ok: false,
        refusal: refusal.kind,
        error: `REFUSED: ${scaleToZeroRefusalReason(refusal)} No ARM call was made — `
          + 'nothing was changed in Azure.',
      }, { status: 409 });
    }
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
});

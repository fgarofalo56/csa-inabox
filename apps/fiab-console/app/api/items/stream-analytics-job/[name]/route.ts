/**
 * GET  /api/items/stream-analytics-job/[name]
 *   Detail for a single ASA job, including inputs, outputs and the
 *   current transformation (query). Real ARM call; honest gate on
 *   missing config.
 *
 * POST /api/items/stream-analytics-job/[name]?provision=1
 *   The Fix-it target for the 404 below — runs the REAL Phase-2 provisioner
 *   (`lib/install/provisioners/stream-analytics-job.ts`) so the item's backing
 *   Microsoft.StreamAnalytics/streamingjobs resource is created and recorded.
 *
 * #3573 — THREE distinct conditions used to collapse into one message:
 *
 *   | condition                          | was            | now |
 *   |------------------------------------|----------------|-----|
 *   | LOOM_ASA_RG / _SUB unset           | 501 + HINT     | 501 + HINT (unchanged) |
 *   | ASA configured, job does not exist | 502 + the SAME HINT | 404, named honestly, with a Fix-it |
 *   | anything else (403, throttle, DNS) | 502 + the SAME HINT | 502, no HINT |
 *
 * The middle row is why the editor showed "Stream Analytics not configured"
 * over deployments where it was configured perfectly well, and the bottom row
 * is a `deploy-integrity.md` R7 violation in its own right: the hint asserted a
 * cause ("provision an ASA job and set LOOM_ASA_RG") for errors where the code
 * had established nothing of the kind.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getJob,
  AsaNotConfiguredError,
  AsaJobNotFoundError,
} from '@/lib/azure/stream-analytics-client';
import { loadOwnedItem } from '../../_lib/item-crud';
import { resolveTarget } from '@/lib/install/provisioning-engine';
import { streamAnalyticsJobProvisioner, asaJobNameFor } from '@/lib/install/provisioners/stream-analytics-job';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'stream-analytics-job';

/** Applies to the NOT-CONFIGURED condition only — the one case where the env
 *  vars really are the remediation. */
const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different).';

/**
 * The `[name]` segment is EITHER a live ASA job name (the editor's left-hand
 * list hands one over) OR a Loom item id (the editor opens on
 * `/items/stream-analytics-job/<cosmosItemId>` and threads that id straight
 * through). Resolve the second form to the job the provisioner recorded on the
 * item, so an item whose backing job was created under its sanitized display
 * name still opens.
 *
 * Returns `null` when the segment is not an item this caller can see — which is
 * the ordinary case for a real job name, and is not an error.
 */
async function itemForSegment(segment: string, tenantId: string): Promise<WorkspaceItem | null> {
  try {
    return await loadOwnedItem(segment, ITEM_TYPE, tenantId, { allowReadRoles: true });
  } catch {
    // A Cosmos read that cannot run must not turn an ARM 404 into a 500 — the
    // caller still gets the honest "no such job" answer below.
    return null;
  }
}

export const GET = withSession<{ name: string }>(async (_req: NextRequest, { session: s, params }) => {
  const name = params?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const job = await getJob(name);
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });
    }
    if (e instanceof AsaJobNotFoundError) {
      // ASA is configured and answered. Before reporting absence, resolve the
      // segment as a Loom item id: the backing job carries the item's SANITIZED
      // display name, not its id, so this is the normal path when the editor
      // opens an item rather than a list row.
      const item = await itemForSegment(name, s.claims.oid);
      const recorded = typeof (item?.state as any)?.jobName === 'string' ? (item!.state as any).jobName : '';
      if (recorded && recorded !== name) {
        try {
          const job = await getJob(recorded);
          return NextResponse.json({ ok: true, job, resolvedFrom: name });
        } catch (inner: any) {
          if (!(inner instanceof AsaJobNotFoundError)) throw inner;
          // Fall through: the RECORDED job is gone too (deleted out of band).
        }
      }
      if (item) {
        const expected = recorded || asaJobNameFor(item.displayName).name;
        // The Fix-it is offered ONLY to a caller the POST below would accept.
        // The read above deliberately allows read roles (a Viewer must still be
        // able to open the editor and be told the job is missing), but the
        // provision POST is write-scoped — so rendering the button for a Viewer
        // would be a control that refuses itself. This uses the SAME predicate
        // the POST uses (`loadOwnedItem` without `allowReadRoles`), so the two
        // cannot drift apart. It costs one extra Cosmos read, on the 404 path
        // only.
        const writable = await loadOwnedItem(name, ITEM_TYPE, s.claims.oid).catch(() => null);
        return NextResponse.json(
          {
            ok: false,
            error:
              `This job's Azure Stream Analytics resource has not been created yet — ` +
              `no streaming job named '${expected}' exists in ${e.resourceGroup}. ` +
              'Stream Analytics itself is configured and reachable.' +
              (writable
                ? ''
                : ' Creating it needs write access to this workspace; ask an owner or member to open this item.'),
            code: 'asa-job-not-provisioned',
            expectedJobName: expected,
            ...(writable
              ? {
                  fixIt: {
                    label: 'Create the streaming job',
                    method: 'POST',
                    href: `/api/items/${ITEM_TYPE}/${encodeURIComponent(name)}?provision=1&workspaceId=${encodeURIComponent(item.workspaceId)}`,
                  },
                }
              : {}),
          },
          { status: 404 },
        );
      }
      // Not an item of this type the caller can see, and no such job. Say only
      // that — no remediation is asserted, because none was established.
      return NextResponse.json(
        { ok: false, error: e.message, code: 'asa-job-not-found' },
        { status: 404 },
      );
    }
    // Unclassified. The message is whatever ARM/the transport said; no hint is
    // attached, because the code established no cause (R7).
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

/**
 * Create the item's backing streaming job — the Fix-it the 404 above hands
 * back. Runs the SAME provisioner an app install runs, so a job created here is
 * identical to one created at install time (name, SKU, identity, recorded ref).
 *
 * Write-scoped: `loadOwnedItem` without `allowReadRoles` requires the
 * Owner/Admin/Member ladder, so a read-only Viewer cannot create Azure
 * resources through this route.
 */
export const POST = withSession<{ name: string }>(async (req: NextRequest, { session: s, params }) => {
  const name = params?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  if (req.nextUrl.searchParams.get('provision') !== '1') {
    return NextResponse.json({ ok: false, error: 'provision=1 required' }, { status: 400 });
  }
  const item = await loadOwnedItem(name, ITEM_TYPE, s.claims.oid);
  if (!item) {
    return NextResponse.json(
      { ok: false, error: `No ${ITEM_TYPE} item '${name}' you can write to.` },
      { status: 404 },
    );
  }
  const result = await streamAnalyticsJobProvisioner({
    session: s,
    target: resolveTarget('shared'),
    cosmosItemId: item.id,
    workspaceId: item.workspaceId,
    displayName: item.displayName,
    content: (item.state as any)?.content || {},
    appId: (item as any)?.appId || '',
  });
  if (result.status === 'created' || result.status === 'exists') {
    return NextResponse.json({
      ok: true,
      jobName: result.secondaryIds?.jobName,
      resourceId: result.resourceId,
      steps: result.steps || [],
    });
  }
  if (result.status === 'remediation') {
    return NextResponse.json(
      { ok: false, error: result.gate?.reason || 'Provisioning is gated.', hint: result.gate?.remediation, steps: result.steps || [] },
      { status: 501 },
    );
  }
  return NextResponse.json(
    { ok: false, error: result.error || 'Provisioning failed.', steps: result.steps || [] },
    { status: 502 },
  );
});

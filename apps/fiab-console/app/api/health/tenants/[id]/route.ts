/**
 * /api/health/tenants/[id]   ([id] is the Loom `health-tenant` item id)
 *
 *   GET   Read the item's tenant: the recorded binding, the live control-plane
 *         tenant and its create job (receipts = the readback). Read-only, no
 *         side effects, so opening the editor can never start a deployment by
 *         itself. Needs read access to the item.
 *   POST  Ensure: provision-and-bind, or self-heal a stale binding. Idempotent
 *         (N calls create ONE tenant and ONE create job). Body `{retry:true}`
 *         retries a failed create job. Needs the `health.tenant-admin`
 *         capability AND write access to the item.
 *
 * Outcomes map to HTTP like this, so a client never has to guess:
 *   bound / provisioning / failed -> 200 (202 while provisioning) with `phase`
 *   control plane or stamp gate   -> 503 gate envelope (inline Fix-it)
 *   control plane unreachable     -> 502 with the control plane's own code
 */
import { NextResponse } from 'next/server';
import { withCapability, withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiError, apiOk } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { ensureHealthTenant, readBinding, realDeps } from '@/lib/install/provisioners/health-tenant';
import { cp, CpError, CpNotConfiguredError, type CpJob, type CpTenant } from '../_lib/cp-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

const ITEM_TYPE = 'health-tenant';

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req, { item }) => {
  const binding = readBinding(item.state);
  if (!binding) return apiOk({ phase: 'unbound', binding: null, tenant: null, job: null });
  let tenant: CpTenant | null = null;
  let job: CpJob | null = null;
  let liveError: { code: string; message: string } | null = null;
  try {
    tenant = await cp.getTenant(binding.tenantId);
    if (binding.createJobId) job = await cp.getJob(binding.createJobId);
  } catch (e) {
    if (e instanceof CpNotConfiguredError) {
      return apiHonestGateError('health-control-plane', { missing: e.missing, message: e.message });
    }
    if (!(e instanceof CpError)) throw e;
    // The recorded binding is still true as a RECORD; say plainly that the live read failed.
    liveError = { code: e.code, message: e.message };
  }
  return apiOk({ phase: binding.status, binding, tenant, job, liveError });
});

export const POST = withCapability<{ id: string }>('health.tenant-admin', 'Contributor', async (req, { session, params }) => {
  const item = await loadOwnedItem(params.id, ITEM_TYPE, session.claims.oid, { session });
  if (!item) return apiError('Health tenant not found', 404);
  let retry = false;
  try {
    const body = await req.json();
    retry = body?.retry === true;
  } catch { /* an empty body is a plain ensure */ }

  const outcome = await ensureHealthTenant(
    { itemId: item.id, displayName: item.displayName, state: item.state, retry },
    realDeps(item.id, item.workspaceId),
  );
  switch (outcome.phase) {
    case 'unconfigured':
      return apiHonestGateError(outcome.gateId, { missing: outcome.missing, message: outcome.message });
    case 'no-stamp':
      return apiHonestGateError(outcome.gateId, { missing: ['LOOM_HEALTH_DEFAULT_STAMP_ID'], message: outcome.message });
    case 'cp-error':
      return apiError(`${outcome.code}: ${outcome.message}`, 502, { code: outcome.code, steps: outcome.steps });
    case 'provisioning':
      return NextResponse.json({ ok: true, phase: 'provisioning', binding: outcome.binding, job: outcome.job, steps: outcome.steps }, { status: 202 });
    case 'failed':
      return NextResponse.json({ ok: true, phase: 'failed', binding: outcome.binding, job: outcome.job ?? null, error: { code: outcome.code, message: outcome.message }, steps: outcome.steps });
    case 'bound':
      return apiOk({ phase: 'bound', binding: outcome.binding, tenant: outcome.tenant, steps: outcome.steps });
  }
});

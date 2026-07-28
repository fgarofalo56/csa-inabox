/**
 * BOUNDARY EGRESS — `emitAuditEvent(ev, { webhook: false })`.
 *
 * `emitAuditEvent` has two sinks with very different trust boundaries:
 *   - the Azure Monitor DCR (`LoomAudit_CL`) — INSIDE the estate;
 *   - `emitLoomEvent` (lib/events/webhook-emitter.ts) — POSTs to whatever
 *     third-party URLs a tenant has registered, OUTSIDE the estate.
 *
 * That is correct for the admin-plane mutations the stream was built for, and
 * wrong for high-volume READ telemetry (LU-3 routes every Unity Catalog call
 * through here). Forwarding reads would ship actor UPNs + securable FQNs out of
 * the boundary, at request volume, typed as `admin.mutation` — the catch-all
 * every generic subscriber receives.
 *
 * These tests are the attack: they assert the read path does NOT reach the
 * outbound emitter, and that the default is unchanged for every pre-existing
 * mutation call site.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/events/webhook-emitter', () => ({ emitLoomEvent: vi.fn() }));

import { emitLoomEvent } from '@/lib/events/webhook-emitter';
import { emitAuditEvent, type AdminAuditEvent } from '../audit-stream';

const emitted = emitLoomEvent as unknown as ReturnType<typeof vi.fn>;

const READ_EVENT: AdminAuditEvent = {
  actorOid: 'oid-alice',
  actorUpn: 'alice@contoso.com',
  action: 'unity.catalog.list',
  targetType: 'unity:catalog',
  targetId: '*',
  tenantId: 'tid-1',
};

beforeEach(() => {
  emitted.mockReset();
  // Un-provisioned DCR → the SIEM half is a silent no-op; only the webhook half
  // is under test here.
  delete process.env.LOOM_AUDIT_DCR_ENDPOINT;
  delete process.env.LOOM_AUDIT_DCR_ID;
});

describe('emitAuditEvent — outbound webhook boundary', () => {
  it('does NOT forward to outbound webhooks when webhook:false', () => {
    emitAuditEvent(READ_EVENT, { webhook: false });
    expect(emitted).not.toHaveBeenCalled();
  });

  it('forwards by DEFAULT — every existing admin-mutation call site is unchanged', () => {
    emitAuditEvent({ ...READ_EVENT, action: 'feature-grant.upsert' });
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted.mock.calls[0][0]).toMatchObject({ type: 'permission.granted' });
  });

  it('forwards when webhook:true is explicit', () => {
    emitAuditEvent({ ...READ_EVENT, action: 'unity.grant.update' }, { webhook: true });
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('a suppressed event never reaches the emitter even if it would map to a subscribable type', () => {
    // `unity.*` has no mapping, so it would land on `admin.mutation` — the
    // subscription documented as "every admin-plane change". A read must not
    // appear there at all.
    emitAuditEvent({ ...READ_EVENT, action: 'unity.table.get' }, { webhook: false });
    emitAuditEvent({ ...READ_EVENT, action: 'unity.schema.list' }, { webhook: false });
    expect(emitted).not.toHaveBeenCalled();
  });
});

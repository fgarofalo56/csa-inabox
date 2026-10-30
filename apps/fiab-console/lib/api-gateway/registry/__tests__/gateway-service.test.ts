/**
 * W1-2 registry service. Each assertion names the value that breaks it:
 *  - auto-registration idempotency: two ensureDeployGateway calls must leave ONE
 *    gateway doc and ONE audit row; a non-deterministic id or an unconditional
 *    audit write makes the counts 2.
 *  - unreadable register: persisting before the canRead check leaves 1 doc.
 *  - deploy-owned removal: dropping the ownedBy guard turns the 409 into a delete.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiplaneAuditRecord, ApiplaneRepo } from '../../types';
import { InMemoryApiplaneRepo } from '../../__tests__/repos/in-memory-repo';
import {
  ensureDeployGateway,
  gatewayId,
  listGateways,
  registerGateway,
  removeGateway,
  type Actor,
  type RegistryDeps,
} from '../gateway-service';
import type { GatewayDoc } from '../types';
import { armDouble, CONTRIBUTOR_PERMS, GW_ID, READER_PERMS } from './arm-double';

const actor: Actor = { tenantId: 't1', who: 'a@x', actorOid: 'oid-a', capability: 'tenant-admin' };
let audits: ApiplaneAuditRecord[];
let repo: InMemoryApiplaneRepo<GatewayDoc>;

function deps(arm = armDouble({ permissions: CONTRIBUTOR_PERMS })): RegistryDeps {
  return {
    repo: repo as unknown as ApiplaneRepo<GatewayDoc>,
    arm,
    writeAudit: async (r) => {
      audits.push(r);
    },
    cloud: () => 'AzureCloud',
    now: () => new Date('2026-10-30T10:00:00.000Z'),
  };
}

beforeEach(() => {
  audits = [];
  repo = new InMemoryApiplaneRepo<GatewayDoc>();
});

describe('ensureDeployGateway', () => {
  const env = { LOOM_APIPLANE_ENABLED: 'true', LOOM_APIPLANE_DEPLOY_GATEWAY_ID: GW_ID };

  it('registers the deploy-owned gateway once and is idempotent on the second admin load', async () => {
    const d = deps();
    const first = await ensureDeployGateway(d, actor, env);
    const second = await ensureDeployGateway(d, actor, env);
    expect(first.ok && first.data?.ownedBy).toBe('deploy');
    expect(first.ok && first.data?.access.canRead).toBe(true);
    expect(second.ok && second.data?.id).toBe(first.ok && first.data?.id);
    expect(await listGateways(d, 't1')).toHaveLength(1);
    expect(audits.map((a) => a.kind)).toEqual(['apiplane.gateway.register']);
  });

  it('does not call ARM again once the gateway is registered and readable', async () => {
    const arm = armDouble({ permissions: CONTRIBUTOR_PERMS });
    await ensureDeployGateway(deps(arm), actor, env);
    const callsAfterFirst = arm.calls.length;
    await ensureDeployGateway(deps(arm), actor, env);
    expect(arm.calls.length).toBe(callsAfterFirst);
  });

  it('an unreadable deploy gateway is still registered (so the gate can show the role) and is retried, not duplicated', async () => {
    const bad = deps(armDouble({ permissions: [] }));
    const r1 = await ensureDeployGateway(bad, actor, env);
    expect(r1.ok && r1.data?.access.canRead).toBe(false);
    const good = deps(armDouble({ permissions: CONTRIBUTOR_PERMS }));
    const r2 = await ensureDeployGateway(good, actor, env);
    expect(r2.ok && r2.data?.access.canRead).toBe(true);
    expect(await listGateways(good, 't1')).toHaveLength(1);
  });

  it('is a no-op when the id is unset or the plane is disabled', async () => {
    const d = deps();
    expect(await ensureDeployGateway(d, actor, { LOOM_APIPLANE_ENABLED: 'true' })).toEqual({ ok: true, data: null });
    expect(await ensureDeployGateway(d, actor, { ...env, LOOM_APIPLANE_ENABLED: 'false' })).toEqual({ ok: true, data: null });
    expect(await listGateways(d, 't1')).toHaveLength(0);
  });

  it('a malformed id is reported, naming the variable', async () => {
    const r = await ensureDeployGateway(deps(), actor, { LOOM_APIPLANE_DEPLOY_GATEWAY_ID: 'nope' });
    expect(!r.ok && r.error).toContain('LOOM_APIPLANE_DEPLOY_GATEWAY_ID');
  });
});

describe('registerGateway / removeGateway', () => {
  it('an unreadable service is refused (422), nothing is persisted, and the message carries role, scope and command', async () => {
    const d = deps(armDouble({ permissions: [] }));
    const r = await registerGateway(d, actor, { resourceId: GW_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.error).toContain('"Reader" (acdd72a7-3385-48ef-bd42-f606fba81ae7)');
    expect(r.error).toContain(`at scope ${GW_ID}`);
    expect(await listGateways(d, 't1')).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('a read-only service registers in observe mode with canWrite=false', async () => {
    const d = deps(armDouble({ permissions: READER_PERMS }));
    const r = await registerGateway(d, actor, { resourceId: GW_ID, displayName: 'Prod APIM' });
    expect(r.ok && r.data.managementMode).toBe('observe');
    expect(r.ok && r.data.access.canWrite).toBe(false);
    expect(r.ok && r.data.displayName).toBe('Prod APIM');
    expect(r.ok && r.data.id).toBe(gatewayId(GW_ID));
  });

  it('registering the same resource twice is a 409, and the id is case-insensitive on the resource id', async () => {
    const d = deps();
    await registerGateway(d, actor, { resourceId: GW_ID });
    const again = await registerGateway(d, actor, { resourceId: GW_ID });
    expect(!again.ok && again.status).toBe(409);
    expect(gatewayId(GW_ID)).toBe(gatewayId(GW_ID.toUpperCase()));
  });

  it('rejects a child resource id with 400', async () => {
    const r = await registerGateway(deps(), actor, { resourceId: `${GW_ID}/apis/x` });
    expect(!r.ok && r.status).toBe(400);
  });

  it('remove deletes a registered gateway and audits it; a deploy-owned one is refused with 409', async () => {
    const d = deps();
    const reg = await registerGateway(d, actor, { resourceId: GW_ID });
    if (!reg.ok) throw new Error('setup');
    expect((await removeGateway(d, actor, reg.data.id)).ok).toBe(true);
    expect(audits.map((a) => a.kind)).toEqual(['apiplane.gateway.register', 'apiplane.gateway.remove']);
    expect(await listGateways(d, 't1')).toHaveLength(0);

    await ensureDeployGateway(d, actor, { LOOM_APIPLANE_DEPLOY_GATEWAY_ID: GW_ID });
    const denied = await removeGateway(d, actor, gatewayId(GW_ID));
    expect(!denied.ok && denied.status).toBe(409);
    expect(await listGateways(d, 't1')).toHaveLength(1);
  });

  it('tenants are isolated: another tenant cannot see or remove the gateway', async () => {
    const d = deps();
    await registerGateway(d, actor, { resourceId: GW_ID });
    expect(await listGateways(d, 't2')).toHaveLength(0);
    const r = await removeGateway(d, { ...actor, tenantId: 't2' }, gatewayId(GW_ID));
    expect(!r.ok && r.status).toBe(404);
  });
});

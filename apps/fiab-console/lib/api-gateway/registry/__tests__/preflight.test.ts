/**
 * W1-2 preflight. Each assertion names the value that breaks it:
 *  - canRead/canWrite pairs: a wildcard matcher that ignores notActions, or one that
 *    treats `*\/read` as write, flips the pair for READER_PERMS / the notActions case.
 *  - missingRole literals: changing the role GUID, the scope, or the az flags in
 *    buildMissingRole changes the exact string compared below.
 *  - principal: reading the oid from anywhere but the token makes `--assignee-object-id`
 *    differ from OID (the token carries a DIFFERENT sub claim to prove it).
 *  - probe: a fallback that reports canWrite=true on a 200 probe fails the canWrite=false check.
 */
import { describe, expect, it } from 'vitest';
import { actionAllowed, oidFromToken, preflightGateway } from '../preflight';
import { parseApimResourceId } from '../resource-id';
import { armDouble, CONTRIBUTOR_PERMS, fakeJwt, GW_ID, OID, READER_PERMS } from './arm-double';

const target = parseApimResourceId(GW_ID)!;
const at = () => new Date('2026-10-30T10:00:00.000Z');

describe('preflightGateway - effective permissions', () => {
  it('Reader: canRead true, canWrite false, remediation names the Contributor role, scope and command', async () => {
    const a = await preflightGateway(target, armDouble({ permissions: READER_PERMS }), at);
    expect(a.canRead).toBe(true);
    expect(a.canWrite).toBe(false);
    expect(a.source).toBe('permissions');
    expect(a.missingRole).toEqual({
      roleDefinitionId: '312a565d-c81f-4fd8-895a-4e21e48d571c',
      roleName: 'API Management Service Contributor',
      scope: GW_ID,
      azCommand: `az role assignment create --assignee-object-id ${OID} --assignee-principal-type ServicePrincipal --role 312a565d-c81f-4fd8-895a-4e21e48d571c --scope ${GW_ID}`,
    });
  });

  it('Contributor: canRead and canWrite both true, no missingRole', async () => {
    const a = await preflightGateway(target, armDouble({ permissions: CONTRIBUTOR_PERMS }), at);
    expect([a.canRead, a.canWrite]).toEqual([true, true]);
    expect(a.missingRole).toBeUndefined();
  });

  it('no permissions at the scope: canRead false and the Reader role is named', async () => {
    const a = await preflightGateway(target, armDouble({ permissions: [] }), at);
    expect([a.canRead, a.canWrite]).toEqual([false, false]);
    expect(a.missingRole?.roleDefinitionId).toBe('acdd72a7-3385-48ef-bd42-f606fba81ae7');
    expect(a.missingRole?.roleName).toBe('Reader');
    expect(a.missingRole?.scope).toBe(GW_ID);
  });

  it('notActions subtracts: Contributor-like grant with service/write excluded is read-only', async () => {
    const a = await preflightGateway(
      target,
      armDouble({ permissions: [{ actions: ['Microsoft.ApiManagement/service/*'], notActions: ['Microsoft.ApiManagement/service/write'] }] }),
      at,
    );
    expect([a.canRead, a.canWrite]).toEqual([true, false]);
  });

  it('principal comes from the ARM token oid claim, not from any other claim', async () => {
    const token = fakeJwt({ sub: 'not-this-one', oid: OID, appid: 'also-not-this' });
    const a = await preflightGateway(target, armDouble({ permissions: [], token }), at);
    expect(a.principalId).toBe(OID);
    expect(a.missingRole?.azCommand).toContain(`--assignee-object-id ${OID} `);
  });

  it('undecodable token: the command carries a placeholder and principalId is absent (nothing guessed)', async () => {
    const a = await preflightGateway(target, armDouble({ permissions: [], token: 'opaque' }), at);
    expect(a.principalId).toBeUndefined();
    expect(a.missingRole?.azCommand).toContain('--assignee-object-id <principal-object-id> ');
  });
});

describe('preflightGateway - probe fallback', () => {
  it('permissions call refused + service GET 200: canRead true, canWrite NOT claimed, no write remediation', async () => {
    const arm = armDouble({ probeStatus: 200 });
    const a = await preflightGateway(target, arm, at);
    expect(a.source).toBe('probe');
    expect(a.canRead).toBe(true);
    expect(a.canWrite).toBe(false);
    expect(a.missingRole).toBeUndefined();
    expect(arm.calls.some((u) => u.includes(`${GW_ID}?api-version=`))).toBe(true);
  });

  it('permissions call refused + service GET 403: canRead false with the Reader remediation', async () => {
    const a = await preflightGateway(target, armDouble({ probeStatus: 403 }), at);
    expect(a.source).toBe('probe');
    expect(a.canRead).toBe(false);
    expect(a.missingRole?.roleDefinitionId).toBe('acdd72a7-3385-48ef-bd42-f606fba81ae7');
  });

  it('a permissions answer is authoritative: the probe is not called when it succeeds', async () => {
    const arm = armDouble({ permissions: READER_PERMS, probeStatus: 200 });
    await preflightGateway(target, arm, at);
    expect(arm.calls).toHaveLength(1);
    expect(arm.calls[0]).toContain('/providers/Microsoft.Authorization/permissions');
  });
});

describe('helpers', () => {
  it('actionAllowed is case-insensitive and anchored (a prefix match must not grant)', () => {
    expect(actionAllowed([{ actions: ['microsoft.apimanagement/service/READ'] }], 'Microsoft.ApiManagement/service/read')).toBe(true);
    expect(actionAllowed([{ actions: ['Microsoft.ApiManagement/service/read'] }], 'Microsoft.ApiManagement/service/read/extra')).toBe(false);
  });
  it('oidFromToken returns undefined for a payload without oid', () => {
    expect(oidFromToken(fakeJwt({ sub: 'x' }))).toBeUndefined();
  });
  it('parseApimResourceId rejects child resources and other providers', () => {
    expect(parseApimResourceId(`${GW_ID}/apis/foo`)).toBeNull();
    expect(parseApimResourceId(GW_ID.replace('Microsoft.ApiManagement', 'Microsoft.Web'))).toBeNull();
    expect(parseApimResourceId(GW_ID)?.name).toBe('apim-csa-loom-eastus2');
  });
});

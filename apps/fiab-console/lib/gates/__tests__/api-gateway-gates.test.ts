/**
 * API Gateway Plane gate family (W1-6): api-gateway.gateway-role,
 * api-gateway.monitoring-reader, api-gateway.llm-logs-unavailable.
 *
 * Every assertion names the value that breaks it (assertion-design.md). All
 * imports go through the registry INDEX so an unexported family fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  API_GATEWAY_GATES,
  API_GATEWAY_READINESS_GAPS,
  GATES,
  evaluateApiGatewayGates,
  getApiGatewayGate,
  readinessGapsFor,
  type ApiGatewayGateInput,
} from '../registry';

const SCOPE =
  '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-apim/providers/Microsoft.ApiManagement/service/apim-test';
const OID = '11111111-2222-3333-4444-555555555555';

function input(over: Partial<ApiGatewayGateInput> = {}): ApiGatewayGateInput {
  return {
    boundary: 'Commercial',
    resourceId: SCOPE,
    managementMode: 'observe',
    access: { canRead: true, canWrite: false, checkedAt: '2026-10-30T00:00:00.000Z', source: 'permissions', principalId: OID },
    telemetryProbe: 'ok',
    llmLogs: 'offered',
    ...over,
  };
}

describe('api-gateway gate family is defined and does not pollute the env-derived registry', () => {
  it('defines exactly the three ids, none of them in GATES (GATES === ENV_CHECKS census is untouched)', () => {
    expect(API_GATEWAY_GATES.map((g) => g.id)).toEqual([
      'api-gateway.gateway-role',
      'api-gateway.monitoring-reader',
      'api-gateway.llm-logs-unavailable',
    ]);
    // Breaks if a family gate leaks into GATES (census test would then fail on orphans).
    expect(GATES.filter((g) => g.id.startsWith('api-gateway.'))).toEqual([]);
  });

  it('role-grant gates carry kind role-grant; the llm-logs gate is a declared gap with NO Fix-it', () => {
    expect(getApiGatewayGate('api-gateway.gateway-role')!.fixit!.kind).toBe('role-grant');
    expect(getApiGatewayGate('api-gateway.monitoring-reader')!.fixit!.kind).toBe('role-grant');
    expect(getApiGatewayGate('api-gateway.llm-logs-unavailable')!.fixit).toBeNull();
  });
});

describe('api-gateway.monitoring-reader (paired positive / negative)', () => {
  it('POSITIVE: a denied telemetry probe yields the gate with a role-grant Fix-it for Monitoring Reader at the literal scope', () => {
    const r = evaluateApiGatewayGates(input({ telemetryProbe: 'denied' }));
    expect(r.map((x) => x.gate.id)).toEqual(['api-gateway.monitoring-reader']);
    const g = r[0];
    expect(g.fixit!.kind).toBe('role-grant');
    // Breaks if the role id is swapped for Reader/Contributor or retyped wrong.
    expect(g.roleGrant!.roleDefinitionId).toBe('43d0d8ad-25c7-4714-9337-8ba259a9fe05');
    expect(g.roleGrant!.roleName).toBe('Monitoring Reader');
    expect(g.roleGrant!.scope).toBe(SCOPE);
    expect(g.roleGrant!.azCommand).toBe(
      `az role assignment create --assignee-object-id ${OID} --assignee-principal-type ServicePrincipal ` +
        `--role 43d0d8ad-25c7-4714-9337-8ba259a9fe05 --scope ${SCOPE}`,
    );
    expect(g.fixit!.grantNote).toContain(g.roleGrant!.azCommand);
  });

  it('NEGATIVE: the same double with the probe ok (Monitoring Reader present) yields NO gate', () => {
    expect(evaluateApiGatewayGates(input({ telemetryProbe: 'ok' }))).toEqual([]);
  });

  it('NEGATIVE: unprobed is not a finding (unknown is not "denied")', () => {
    expect(evaluateApiGatewayGates(input({ telemetryProbe: 'unprobed' }))).toEqual([]);
  });
});

describe('api-gateway.gateway-role', () => {
  it('canRead=false yields the gate; the role is the missingRole W1-2 preflight reported (Reader), not retyped', () => {
    const r = evaluateApiGatewayGates(
      input({
        access: {
          canRead: false, canWrite: false, checkedAt: 'x', source: 'permissions', principalId: OID,
          missingRole: {
            roleDefinitionId: 'acdd72a7-3385-48ef-bd42-f606fba81ae7', roleName: 'Reader', scope: SCOPE,
            azCommand: 'az role assignment create PREFLIGHT-COMMAND',
          },
        },
      }),
    );
    expect(r.map((x) => x.gate.id)).toEqual(['api-gateway.gateway-role']);
    expect(r[0].roleGrant!.azCommand).toBe('az role assignment create PREFLIGHT-COMMAND');
    expect(r[0].fixit!.kind).toBe('role-grant');
  });

  it('manage requested with canWrite=false yields API Management Service Contributor at the scope', () => {
    const r = evaluateApiGatewayGates(input({ managementMode: 'manage' }));
    expect(r.map((x) => x.gate.id)).toEqual(['api-gateway.gateway-role']);
    expect(r[0].roleGrant!.roleDefinitionId).toBe('312a565d-c81f-4fd8-895a-4e21e48d571c');
    expect(r[0].roleGrant!.scope).toBe(SCOPE);
  });

  it('NEGATIVE: observe mode with canWrite=false and read ok yields NO gate (write is not required)', () => {
    expect(evaluateApiGatewayGates(input({ managementMode: 'observe' }))).toEqual([]);
  });

  it('NEGATIVE: manage mode with read+write yields NO gate', () => {
    const a = input().access;
    expect(evaluateApiGatewayGates(input({ managementMode: 'manage', access: { ...a, canWrite: true } }))).toEqual([]);
  });
});

describe('api-gateway.llm-logs-unavailable and the readiness listing', () => {
  it('GCC-High with the category rejected yields the gate, no Fix-it, and the W4 / 2026-12-01 gap row', () => {
    const r = evaluateApiGatewayGates(input({ boundary: 'GCC-High', llmLogs: 'rejected' }));
    expect(r.map((x) => x.gate.id)).toEqual(['api-gateway.llm-logs-unavailable']);
    expect(r[0].fixit).toBeNull();
    const row = r[0].gaps!.find((g) => g.gap === 'GatewayLlmLogs absent')!;
    expect(row.boundary).toBe('GCC-High');
    expect(row.owner.startsWith('W4:')).toBe(true);
    expect(row.review).toBe('2026-12-01');
    expect(row.substitute).toBe('llm-emit-token-metric and GatewayLogs');
  });

  it('NEGATIVE: Commercial with the category offered yields NO gate', () => {
    expect(evaluateApiGatewayGates(input({ llmLogs: 'offered' }))).toEqual([]);
  });

  it('not-measured (IL5) still fires: missing telemetry is never reported healthy', () => {
    const r = evaluateApiGatewayGates(input({ boundary: 'IL5', llmLogs: 'not-measured' }));
    expect(r.map((x) => x.gate.id)).toEqual(['api-gateway.llm-logs-unavailable']);
    expect(r[0].gaps![0].measured).toBe(false);
  });

  it('readiness lists the W0-9 gaps with owner strings per boundary (5 GCC-High, 1 IL5, 1 GCC, 0 Commercial)', () => {
    expect(readinessGapsFor('GCC-High')).toHaveLength(5);
    expect(readinessGapsFor('IL5')).toHaveLength(1);
    expect(readinessGapsFor('GCC')).toHaveLength(1);
    expect(readinessGapsFor('Commercial')).toEqual([]);
    expect(API_GATEWAY_READINESS_GAPS).toHaveLength(7);
    const byGap = (b: 'GCC-High' | 'IL5' | 'GCC', needle: string) =>
      readinessGapsFor(b).find((g) => g.gap.startsWith(needle))!;
    expect(byGap('GCC-High', 'MCP API type').owner.startsWith('W6:')).toBe(true);
    expect(byGap('GCC-High', 'Agent ID').owner).toBe('operator: grant Application.Read.All (Q19), then re-run identity');
    expect(byGap('IL5', 'Everything').owner).toContain('IL5 deploy run');
    expect(byGap('GCC', 'Everything').owner).toBe('measured when a GCC tenant exists');
    // Every row has a non-empty owner and review: no ownerless gap (cloud-parity.md).
    for (const g of API_GATEWAY_READINESS_GAPS) {
      expect(g.owner.length, `gap ${g.gap}`).toBeGreaterThan(10);
      expect(g.review.length, `gap ${g.gap}`).toBeGreaterThan(0);
    }
  });
});

// #5422 W2-2b B2a: the dedicated per-tenant FHIR identity, the stamp PG role-job identity, and the
// ServiceAccount that federates to it. Asserts on the ARM JSON `az bicep build` produces, because that is
// what ARM receives; nothing here transcribes a resource name that the compiled template can supply.
//
// LHDS_TENANT_BICEP / LHDS_STAMP_BICEP / LHDS_POSTGRES_BICEP / LHDS_ENGINES_BICEP override the compiled
// file so a mutation can be run against a SANDBOX COPY without touching the tracked tree. Not read by product code.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const health = resolve(dir, '../../../platform/fiab/bicep/modules/health');
const pick = (env: string | undefined, file: string): string => (env ? resolve(env) : resolve(health, file));

interface Arm {
  resources: Record<string, unknown>[];
  variables: Record<string, unknown>;
  outputs: Record<string, { value: unknown }>;
  parameters: Record<string, { defaultValue?: string }>;
}

function compile(file: string): Arm {
  // No skip when az is missing: a guard that silently skips watches nothing.
  const r = spawnSync('az', ['bicep', 'build', '--file', file, '--stdout'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`az bicep build failed for ${file} (exit ${String(r.status)}): ${(r.stderr || String(r.error ?? '')).slice(0, 400)}`);
  const t = JSON.parse(r.stdout) as { resources: unknown; variables?: Record<string, unknown>; outputs: Arm['outputs']; parameters: Arm['parameters'] };
  const resources = (Array.isArray(t.resources) ? t.resources : Object.values(t.resources as object)) as Record<string, unknown>[];
  return { resources, variables: t.variables ?? {}, outputs: t.outputs, parameters: t.parameters };
}

const ofType = (a: Arm, type: string): Record<string, unknown>[] => a.resources.filter((r) => r.type === type);
const UAMI = 'Microsoft.ManagedIdentity/userAssignedIdentities';
const FED_CRED = `${UAMI}/federatedIdentityCredentials`;
const ROLE = 'Microsoft.Authorization/roleAssignments';

describe('tenant.bicep: dedicated FHIR identity (decision 9)', () => {
  const t = compile(pick(process.env.LHDS_TENANT_BICEP, 'tenant.bicep'));
  const fhir = ofType(t, UAMI).find((r) => String(r.name).includes('-fhir'));
  const cred = ofType(t, FED_CRED);

  it('creates id-lhds-<stamp>-<slug>-fhir, separate from the tenant identity', () => {
    // Breaks if the -fhir identity is dropped, or the FHIR engine reuses id-lhds-<stamp>-<slug> (DICOM/Event Hubs reach).
    expect(fhir, 'fhir identity resource').toBeDefined();
    expect(ofType(t, UAMI)).toHaveLength(2);
    expect(String(fhir?.name)).toBe("[format('id-lhds-{0}-{1}-fhir', variables('stampName'), parameters('tenantSlug'))]");
  });

  it('has exactly one federated credential: AKS issuer, subject loom-health/fhir-<slug>, AzureADTokenExchange', () => {
    // Breaks if the subject names another service account or namespace, the issuer is not stamp.aksOidcIssuerUrl,
    // the audience changes, or a second credential is added without a dependsOn (credentials on one identity write serially).
    expect(cred).toHaveLength(1);
    const p = cred[0]?.properties as { issuer: string; subject: string; audiences: string[] };
    expect(p.issuer).toBe("[string(parameters('stamp').aksOidcIssuerUrl)]");
    expect(p.subject).toBe("[format('system:serviceaccount:{0}:fhir-{1}', parameters('fhirNamespace'), parameters('tenantSlug'))]");
    expect(p.audiences).toEqual(['api://AzureADTokenExchange']);
  });

  it('the namespace default is loom-health (the stamp workload namespace the manifest creates)', () => {
    // Breaks if the default drifts from engines.bicep's aksNamespace, so the credential would never match the pod.
    expect(t.parameters.fhirNamespace?.defaultValue).toBe('loom-health');
  });

  it('the FHIR identity has NO role assignment (least privilege, decision 9)', () => {
    // Guards least privilege: the FHIR identity holds only its federated credential. Breaks if any roleAssignment
    // references the fhir identity (principalId, name or dependsOn). It does NOT claim tenant.create would fail:
    // reusing one of the 4 ABAC-allowed role ids would still pass the CP condition, so this test is the guard.
    // The name is stripped of its ARM brackets because inside a role assignment it appears nested in
    // reference(resourceId(..., format(...))), unbracketed; a bracketed needle would never match.
    const fhirName = String(fhir?.name).replace(/^\[|\]$/g, '');
    const touching = ofType(t, ROLE).filter((r) => JSON.stringify(r).includes(fhirName));
    expect(touching.map((r) => String(r.name))).toEqual([]);
    // Positive pair: the tenant identity still has its role assignments, so the filter above is looking at real ones.
    expect(ofType(t, ROLE).length).toBeGreaterThanOrEqual(5);
  });

  it('outputs tenant.fhirIdentity with exactly id, name, clientId, principalId, each read from the fhir identity', () => {
    const v = (t.outputs.tenant?.value as { fhirIdentity?: Record<string, string> }).fhirIdentity;
    // Breaks if a key is renamed/dropped (the CP parser and lane B2c code against these names), or a value reads the tenant identity.
    expect(Object.keys(v ?? {}).sort()).toEqual(['clientId', 'id', 'name', 'principalId']);
    const fhirName = String(fhir?.name);
    for (const k of ['id', 'name', 'clientId', 'principalId']) expect(v?.[k], k).toContain(fhirName.replace(/^\[|\]$/g, ''));
    expect(v?.clientId).toContain('.clientId');
    expect(v?.principalId).toContain('.principalId');
  });
});

describe('stamp.bicep + postgres.bicep: stamp PG role-job identity (decision 10)', () => {
  const s = compile(pick(process.env.LHDS_STAMP_BICEP, 'stamp.bicep'));
  const pg = compile(pick(process.env.LHDS_POSTGRES_BICEP, 'postgres.bicep'));

  it('stamp creates id-lhds-<stamp>-pgadmin federated to loom-health/lhds-pg-admin via the AKS issuer', () => {
    // Breaks if the name, subject, issuer or audience change (the manifest ServiceAccount below must match the subject).
    expect(s.variables.pgAdminIdentityName).toBe("[format('id-lhds-{0}-pgadmin', parameters('stampName'))]");
    const cred = ofType(s, FED_CRED).filter((r) => JSON.stringify(r).includes('pgAdminIdentityName'));
    expect(cred).toHaveLength(1);
    const p = cred[0]?.properties as { issuer: string; subject: string; audiences: string[] };
    expect(p.subject).toBe('system:serviceaccount:loom-health:lhds-pg-admin');
    expect(p.issuer).toContain("outputs.oidcIssuerUrl.value");
    expect(p.audiences).toEqual(['api://AzureADTokenExchange']);
  });

  it('stamp outputs pgAdminIdentity { name, clientId, principalId } and nothing else', () => {
    const v = s.outputs.pgAdminIdentity?.value as Record<string, string> | undefined;
    // Breaks if a key is renamed or dropped (the CP reads the lhds-stamp-<id> outputs by these names).
    expect(Object.keys(v ?? {}).sort()).toEqual(['clientId', 'name', 'principalId']);
    expect(v?.clientId).toContain('.clientId');
    expect(v?.principalId).toContain('.principalId');
  });

  it('stamp passes the identity principal and NAME to postgres.bicep', () => {
    const mod = ofType(s, 'Microsoft.Resources/deployments').find((r) => String(r.name).includes('postgres'));
    const params = (mod?.properties as { parameters: Record<string, { value: string }> }).parameters;
    // Breaks if the principal id is replaced by clientId (the administrator resource name must be the OBJECT id) or the role name drifts from the UAMI name.
    expect(params.pgAdminPrincipalId?.value).toContain('.principalId');
    expect(params.pgAdminPrincipalName?.value).toBe("[variables('pgAdminIdentityName')]");
  });

  it('postgres registers it as a ServicePrincipal administrator beside the group administrator', () => {
    const admins = ofType(pg, 'Microsoft.DBforPostgreSQL/flexibleServers/administrators');
    const byType = Object.fromEntries(admins.map((a) => [(a.properties as { principalType: string }).principalType, a]));
    // Positive pair: the existing Group administrator must still be there (deleting the feature must not pass).
    expect(Object.keys(byType).sort()).toEqual(['Group', 'ServicePrincipal']);
    const sp = byType.ServicePrincipal as { name: string; properties: { principalName: string }; dependsOn: string[]; condition?: string };
    // Breaks if the administrator is named by anything but the object id, or maps to a role name other than the identity name.
    expect(sp.name).toContain("parameters('pgAdminPrincipalId')");
    expect(sp.properties.principalName).toBe("[parameters('pgAdminPrincipalName')]");
    expect(sp.condition).toBe("[not(empty(parameters('pgAdminPrincipalId')))]");
    // Serialised after the group administrator: parallel Entra administrator writes fail mid-update.
    expect(sp.dependsOn.some((d) => d.includes('/administrators') && d.includes("parameters('adminEntraGroupId')"))).toBe(true);
    const cfg = ofType(pg, 'Microsoft.DBforPostgreSQL/flexibleServers/configurations')[0] as { dependsOn: string[] };
    expect(cfg.dependsOn.filter((d) => d.includes('/administrators'))).toHaveLength(2);
  });
});

describe('engines.bicep: ServiceAccount lhds-pg-admin in the stamp manifest', () => {
  const e = compile(pick(process.env.LHDS_ENGINES_BICEP, 'engines.bicep'));
  const sa = String(JSON.stringify(e.variables.pgAdminServiceAccount));

  it('renders ServiceAccount lhds-pg-admin in the workload namespace, annotated with the pgadmin client id', () => {
    // Breaks if the account name drifts from the federated subject, the namespace is hard-coded, or the annotation reads another id.
    expect(sa).toContain('kind: ServiceAccount');
    expect(sa).toContain('name: lhds-pg-admin');
    expect(sa).toContain("format('  namespace: {0}', parameters('aksNamespace'))");
    expect(sa).toContain('azure.workload.identity/client-id: \\"{0}\\"');
    expect(sa).toContain("parameters('pgAdminClientId')");
    // No Role / RoleBinding for it: the Job needs only its projected token.
    expect(sa).not.toContain('kind: Role');
  });

  it('the account is part of the manifest output, and empty clientId renders none', () => {
    // Breaks if the variable is declared but not concatenated into `manifest` (a dead ServiceAccount).
    expect(JSON.stringify(e.outputs.manifest?.value)).toContain("variables('pgAdminServiceAccount')");
    expect(sa).toContain("empty(parameters('pgAdminClientId'))");
  });
});

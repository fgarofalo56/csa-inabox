// #5380: tenant.bicep reaches the two tenant storage accounts through `existing` handles
// (pixelAccount / auditAccount) while the pixelStorage / auditStorage MODULES create them.
// An `existing` handle carries no edge to the module, so ARM ran the role assignments and the
// capacity alert concurrently with the account write and every tenant deployment failed
// ResourceNotFound (lhds-tenant-g1-202611200452). This guard compiles tenant.bicep with
// `az bicep build` and asserts on the ARM JSON ARM actually receives, not on the bicep text.
//
// Everything is lifted from the compiled template: the storage deployments are found by their
// `accountName` parameter, and the dependents are every other resource whose JSON names the
// same account-name variable. Nothing below transcribes a resource name.
//
// LHDS_TENANT_BICEP overrides the compiled file so a mutation can be run against a sandbox copy
// (temp/) without touching the tracked tree. It is not read by any product code.
// A sandbox copy needs storage.bicep BESIDE it (tenant.bicep declares a module on './storage.bicep');
// without it BCP091 fails the compile and every test here goes red for the wrong reason.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const tracked = resolve(dir, '../../../platform/fiab/bicep/modules/health/tenant.bicep');
const source = process.env.LHDS_TENANT_BICEP ? resolve(process.env.LHDS_TENANT_BICEP) : tracked;

interface ArmResource {
  type: string;
  name: string;
  dependsOn?: string[];
  properties?: { parameters?: Record<string, { value?: unknown }> };
}

function azCommand(): [string, string[]] {
  if (process.platform !== 'win32') return ['az', []];
  for (const p of (process.env.PATH ?? '').split(';')) {
    const cmd = resolve(p, 'az.cmd');
    const py = resolve(p, '..', 'python.exe');
    if (existsSync(cmd) && existsSync(py)) return [py, ['-IBm', 'azure.cli']];
  }
  throw new Error('az.cmd with a sibling ..\\python.exe was not found on PATH (MSI install layout); install the Azure CLI');
}

function compile(file: string): { resources: ArmResource[] } {
  // No skip when az is missing: a guard that silently skips watches nothing. It fails, naming why.
  // No shell, so the LHDS_TENANT_BICEP path never passes through one. On win32 the CLI is az.cmd, and node
  // (>= 20.12) refuses to spawn a .cmd without a shell (EINVAL), so resolve what az.cmd itself runs:
  // `<CLI2>\python.exe -IBm azure.cli`, the MSI layout's sibling of wbin\az.cmd.
  const [bin, lead] = azCommand();
  const r = spawnSync(bin, [...lead, 'bicep', 'build', '--file', file, '--stdout'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`az bicep build failed for ${file} (exit ${String(r.status)}): ${(r.stderr || String(r.error ?? '')).slice(0, 400)}`);
  }
  const t = JSON.parse(r.stdout) as { resources: ArmResource[] | Record<string, ArmResource> };
  return { resources: Array.isArray(t.resources) ? t.resources : Object.values(t.resources) };
}

const template = compile(source);
const deploymentType = 'Microsoft.Resources/deployments';

// Storage deployments keyed by the account-name expression they create, e.g. variables('pixelAccountName').
const storageDeployments = template.resources
  .filter((r) => r.type === deploymentType && typeof r.properties?.parameters?.accountName?.value === 'string')
  .map((r) => {
    const accountExpr = String(r.properties!.parameters!.accountName!.value).replace(/^\[|\]$/g, '');
    // The exact string ARM's compiler emits in dependsOn for a module edge.
    const edge = `[resourceId('${deploymentType}', ${r.name.replace(/^\[|\]$/g, '')})]`;
    return { accountExpr, edge, name: r.name };
  });

const dependentsOf = (accountExpr: string): ArmResource[] =>
  template.resources.filter((r) => r.type !== deploymentType && JSON.stringify(r).includes(accountExpr));

describe('tenant.bicep orders every reference to a tenant storage account after the module that creates it (#5380)', () => {
  it('finds exactly the pixel and audit storage deployments, each creating a distinct account variable', () => {
    // Inputs that break it: a storage module losing its accountName param binding, a third storage
    // module, or both modules bound to the same variable (the dependents scan below would then be blind).
    expect(storageDeployments.map((d) => d.accountExpr).sort()).toEqual([
      "variables('auditAccountName')",
      "variables('pixelAccountName')",
    ]);
  });

  it('the pixel account dependents are the role assignment and the capacity alert, and the audit dependent is the role assignment', () => {
    // Positive control for the edge assertion below: it pins that the scan reaches the resources #5380
    // broke. Inputs that break it: pixelRole/auditRole/capacityAlert no longer referencing the account
    // (scan finds nothing, so the edge test would pass vacuously), or a NEW reference to an account
    // (it must then be reviewed and added here, and the edge test already covers it).
    const types = (expr: string): string[] => dependentsOf(expr).map((r) => r.type).sort();
    expect(types("variables('pixelAccountName')")).toEqual(['Microsoft.Authorization/roleAssignments', 'Microsoft.Insights/metricAlerts']);
    expect(types("variables('auditAccountName')")).toEqual(['Microsoft.Authorization/roleAssignments']);
  });

  it('every resource that references a tenant storage account dependsOn the storage deployment that creates it', () => {
    // Inputs that break it (one RED per input, mutation receipt in the PR): deleting `dependsOn: [ pixelStorage ]`
    // from pixelRole, deleting it from capacityAlert, deleting `dependsOn: [ auditStorage ]` from auditRole,
    // or pointing any of them at the OTHER storage module.
    let checked = 0;
    for (const d of storageDeployments) {
      for (const r of dependentsOf(d.accountExpr)) {
        expect(r.dependsOn ?? [], `${r.type} ${r.name} must dependsOn ${d.name}`).toContain(d.edge);
        checked += 1;
      }
    }
    // Breaks if the loops above ran zero times (an empty template, or a scan that matched nothing).
    expect(checked).toBe(3);
  });
});

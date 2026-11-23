import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const bicep = resolve(dir, '../../../platform/fiab/bicep');
const read = (p: string): string => readFileSync(resolve(bicep, p), 'utf8').replace(/\r\n/g, '\n');
const cp = read('modules/health/control-plane.bicep');
const health = read('health.bicep');

describe('stamp self-registration wiring (#5377)', () => {
  it('the four stamp env names the service reads are the ones bicep emits, as one all-or-nothing block', () => {
    // Breaks if bicep renames a var (the service would then refuse to start on a partial set) or emits it unconditionally.
    expect(cp).toMatch(/var stampEnv = empty\(stampId\) \? \[\] : \[[\s\S]*LOOM_HEALTH_CP_STAMP_ID[\s\S]*LOOM_HEALTH_CP_STAMP_REGION[\s\S]*LOOM_HEALTH_CP_STAMP_CLASS[\s\S]*LOOM_HEALTH_CP_STAMP_BASE_URL[\s\S]*\]/);
    expect(cp).toContain('var cpEnv = concat(authEnv, tlsEnv, stampEnv, pdpEnv, engineImageEnv, pdpSigningEnv, [');
    const src = readFileSync(resolve(dir, '../src/registry/self-register.ts'), 'utf8');
    for (const n of ['LOOM_HEALTH_CP_STAMP_ID', 'LOOM_HEALTH_CP_STAMP_REGION', 'LOOM_HEALTH_CP_STAMP_CLASS', 'LOOM_HEALTH_CP_STAMP_BASE_URL']) {
      expect(src, n).toContain(n);
      expect(cp, n).toContain(n);
    }
  });

  it('health.bicep passes the stamp id and region that name the stamp resource group, and the ingress URL as https', () => {
    // Breaks if the region diverges from rg-csa-loom-health-<id>-<region> (the ARM read would 404) or the base URL is not https.
    expect(health).toContain("name: 'rg-csa-loom-health-${healthStampName}-${healthLocation}'");
    expect(health).toContain('stampId: healthStampName');
    expect(health).toContain('stampRegion: healthLocation');
    expect(health).toContain("stampBaseUrl: empty(cpIngressFqdn) ? '' : 'https://${cpIngressFqdn}'");
    expect(health).toContain("== 'DEV' ? 'S'");
  });

  it('grants Contributor + a CONDITIONED RBAC Administrator on the stamp resource group only, never Owner or User Access Administrator (#5380)', () => {
    // Operator decision on #5380 replaced #5379's Reader. Inputs that break this test:
    //  - Owner 8e3af657-a8ff-443c-a75c-2fe8c4bcb635 or User Access Administrator 18d7d88d-d35e-4fb5-a5c3-7773c20a72d9 anywhere in the file;
    //  - a `scope:` on either assignment (it would leave the stamp resource group);
    //  - the RBAC Administrator assignment losing its `condition:` or `conditionVersion: '2.0'` (it would become unrestricted);
    //  - either assignment losing its `!skipRoleGrants` gate or pointing at another principal.
    // The condition's role SET is pinned against tenant.bicep by scripts/ci/__tests__/health-cp-stamp-rg-grants.test.mjs.
    expect(cp).toContain("var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'");
    expect(cp).toContain("var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'");
    expect(cp).not.toContain('8e3af657-a8ff-443c-a75c-2fe8c4bcb635');
    expect(cp).not.toContain('18d7d88d-d35e-4fb5-a5c3-7773c20a72d9');
    expect(cp).not.toContain('resource cpStampReader');
    const block = (name: string): string => {
      const start = cp.indexOf(`resource ${name} `);
      expect(start, name).toBeGreaterThan(-1);
      return cp.slice(start, cp.indexOf('\n}\n', start) + 2);
    };
    for (const name of ['cpStampContributor', 'cpStampRbacAdmin']) {
      const b = block(name);
      expect(b, name).toContain('!skipRoleGrants');
      expect(b, name).toContain('principalId: cpIdentity.properties.principalId');
      expect(b, name).not.toContain('scope:');
    }
    expect(block('cpStampContributor')).toContain('contributorRoleId');
    const admin = block('cpStampRbacAdmin');
    expect(admin).toContain('rbacAdministratorRoleId');
    expect(admin).toContain('condition: rbacAdminCondition');
    expect(admin).toContain("conditionVersion: '2.0'");
  });
});

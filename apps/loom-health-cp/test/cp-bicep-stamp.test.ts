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
    expect(cp).toContain('var cpEnv = concat(authEnv, tlsEnv, stampEnv, [');
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

  it('grants Reader (acdd72a7...) on the stamp resource group only, never Contributor or Owner', () => {
    // Input that breaks it: Contributor b24988ac-6180-42a0-ab88-20f7382dd24c or Owner 8e3af657-a8ff-443c-a75c-2fe8c4bcb635.
    expect(cp).toContain("var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'");
    expect(cp).not.toContain('b24988ac-6180-42a0-ab88-20f7382dd24c');
    expect(cp).not.toContain('8e3af657-a8ff-443c-a75c-2fe8c4bcb635');
    const block = cp.slice(cp.indexOf('resource cpStampReader'), cp.indexOf('// ── Ingress TLS certificate'));
    expect(block).toContain('!skipRoleGrants');
    expect(block).toContain('principalId: cpIdentity.properties.principalId');
    expect(block).not.toContain('scope:');
  });
});

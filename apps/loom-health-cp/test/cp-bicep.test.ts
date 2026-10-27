import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const bicep = resolve(dir, '../../../platform/fiab/bicep');
const cp = readFileSync(resolve(bicep, 'modules/health/control-plane.bicep'), 'utf8');
const health = readFileSync(resolve(bicep, 'health.bicep'), 'utf8');

describe('control-plane.bicep key vault grant (W1-2 follow-up)', () => {
  it('grants Key Vault Crypto Officer (14b46e9e...), not Key Vault Administrator or Contributor, on the vault only', () => {
    // Input that breaks it: Key Vault Administrator 00482a5a-887f-4fb3-b363-3b7fe8e74483 (adds secrets and
    // certificates) or a resourceGroup() scope.
    expect(cp).toContain("var kvCryptoOfficerRoleId = '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'");
    expect(cp).not.toContain('00482a5a-887f-4fb3-b363-3b7fe8e74483');
    const block = cp.slice(cp.indexOf('resource cpKeyOfficer'), cp.indexOf('resource cosmosPe '));
    expect(block).toContain('scope: stampVault');
    expect(block).toContain('principalId: cpIdentity.properties.principalId');
    expect(block).toContain('!skipRoleGrants');
  });

  it('health.bicep passes the stamp vault id to the control plane', () => {
    // Input that breaks it: dropping the argument leaves keyVaultId empty and the grant silently absent.
    expect(health).toMatch(/keyVaultId: healthStamp!\.outputs\.stamp\.keyVaultId/);
  });
});

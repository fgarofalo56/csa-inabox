import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const bicep = resolve(dir, '../../../platform/fiab/bicep');
const read = (p: string): string => readFileSync(resolve(bicep, p), 'utf8').replace(/\r\n/g, '\n');
const cp = read('modules/health/control-plane.bicep');
const health = read('health.bicep');
const ingress = read('modules/health/ingress.bicep');
const network = read('modules/health/network.bicep');
const workflow = readFileSync(resolve(dir, '../../../.github/workflows/deploy-health.yml'), 'utf8').replace(/\r\n/g, '\n');

describe('ingress TLS issued by the control plane (#5345)', () => {
  it('grants Key Vault Certificates Officer (a4417e6f...) on the vault only, never Administrator', () => {
    // Input that breaks it: Key Vault Administrator 00482a5a-887f-4fb3-b363-3b7fe8e74483, or a resourceGroup() scope.
    expect(cp).toContain("var kvCertificatesOfficerRoleId = 'a4417e6f-fecd-4de8-b567-7b0420556985'");
    expect(cp).not.toContain('00482a5a-887f-4fb3-b363-3b7fe8e74483');
    const block = cp.slice(cp.indexOf('resource cpCertOfficer'), cp.indexOf('// ── Authorization server signing key'));
    expect(block).toContain('scope: stampVault');
    expect(block).toContain('principalId: cpIdentity.properties.principalId');
    expect(block).toContain('!skipRoleGrants');
  });

  it('the control plane receives the vault URL, FQDN and cert name only when it issues the certificate', () => {
    // Breaks if the env rows are emitted unconditionally (a supplied CA certificate would then also be issued over).
    expect(cp).toMatch(/var tlsEnv = issueIngressCert \? \[[\s\S]*LOOM_HEALTH_CP_TLS_VAULT_URL[\s\S]*LOOM_HEALTH_CP_TLS_FQDN[\s\S]*LOOM_HEALTH_CP_TLS_CERT_NAME[\s\S]*\] : \[\]/);
    expect(cp).toContain('var cpEnv = concat(authEnv, tlsEnv, [');
    expect(health).toContain("tlsFqdn: cpIssuesIngressCert ? cpIngressFqdn : ''");
    expect(health).toContain('tlsVaultUrl: healthStamp!.outputs.stamp.keyVaultUri');
  });

  it('the vault URL comes from the vault output, with no hard-coded cloud host', () => {
    // Breaks if a literal vault.azure.net / usgovcloudapi.net is introduced into the TLS wiring (cloud parity).
    for (const src of [cp, ingress]) {
      for (const line of src.split('\n').filter((l) => /tls|Tls|cert/i.test(l) && !l.trim().startsWith('//') && !l.includes('@description'))) {
        // Substring checks, not an unanchored host regex (CodeQL js/regex/missing-regexp-anchor).
        const hardCoded = ['vault.azure.net', 'usgovcloudapi.net'].filter((h) => line.includes(h));
        expect(hardCoded, `hard-coded cloud host in: ${line.trim()}`).toEqual([]);
      }
    }
  });

  it('the deploymentScript, staging account, script identity and snet-script are gone', () => {
    // Breaks if any of the replaced pieces is reintroduced.
    expect(existsSync(resolve(bicep, 'modules/health/tls-cert.bicep'))).toBe(false);
    expect(existsSync(resolve(bicep, 'modules/health/tls-cert.sh'))).toBe(false);
    expect(ingress).not.toContain('tls-cert.bicep');
    expect(ingress).not.toMatch(/scriptSubnetId|deploymentScripts/);
    expect(network).not.toMatch(/snet-script|scriptPrefix|scriptSubnetId/);
  });

  it('the gateway listener is built only from issuedTlsSecretUri (phase 2) and reads the versionless secret', () => {
    // Breaks if the listener is built in phase 1 (the gateway would fail resolving a missing secret).
    expect(ingress).toContain('var issuedReady = selfSigned && !empty(issuedTlsSecretUri)');
    expect(ingress).toContain('var hasTls = suppliedTls || issuedReady');
    expect(ingress).toContain("var expectedIssuedSecretUri = '${kv.properties.vaultUri}secrets/${issuedCertificateName}'");
  });

  it('deploy-health waits on ARM, fails closed, then passes the URI to a second deploy and probes the FQDN', () => {
    // Breaks if the wait reads the data plane (private vault), passes no URI, or stops probing the served subject.
    expect(workflow).toContain('az resource show --ids "$KV_ID/secrets/$CERT" --api-version 2024-11-01');
    expect(workflow).toContain('issuedTlsSecretUri="$TLS_URI"');
    expect(workflow).toContain('openssl s_client -connect "$FQDN:443" -servername "$FQDN"');
    expect(workflow).not.toMatch(/az keyvault (certificate|secret) show/);
    expect(workflow).toContain('whether the certificate exists is UNKNOWN');
  });
});

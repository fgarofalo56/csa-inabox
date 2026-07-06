/**
 * Pure-helper unit tests for workspace-egress-client (rel-T89 outbound access
 * protection). These exercise the deterministic validate/normalize/compile
 * helpers + rule naming — no live ARM, no Cosmos. Per no-vaporware.md the ARM
 * write path (NSG securityRules converge) is validated live (see the parity
 * doc's E2E receipt), not mocked here.
 */
import { describe, it, expect } from 'vitest';
import {
  isValidFqdn, isKnownServiceTag, validateDestination, validateEgressPolicy,
  normalizeEgressPolicy, compileEgressRules, egressRuleName, egressDenyRuleName,
  type WorkspaceEgressPolicy,
} from '@/lib/clients/workspace-egress-client';

const NSG_ID =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-net/providers/Microsoft.Network/networkSecurityGroups/nsg-compute';

describe('isValidFqdn', () => {
  it('accepts hostnames and wildcard FQDNs', () => {
    expect(isValidFqdn('contoso.com')).toBe(true);
    expect(isValidFqdn('*.blob.core.windows.net')).toBe(true);
  });
  it('rejects schemes, paths, spaces, and bare labels', () => {
    expect(isValidFqdn('https://contoso.com')).toBe(false);
    expect(isValidFqdn('contoso.com/path')).toBe(false);
    expect(isValidFqdn('contoso com')).toBe(false);
    expect(isValidFqdn('localhost')).toBe(false);
  });
});

describe('isKnownServiceTag', () => {
  it('accepts base and region-scoped tags case-insensitively', () => {
    expect(isKnownServiceTag('Storage')).toBe(true);
    expect(isKnownServiceTag('storage.eastus')).toBe(true);
    expect(isKnownServiceTag('AzureActiveDirectory')).toBe(true);
  });
  it('rejects unknown tags', () => {
    expect(isKnownServiceTag('NotATag')).toBe(false);
  });
});

describe('validateDestination', () => {
  it('validates by type', () => {
    expect(validateDestination({ type: 'service-tag', value: 'Sql' })).toBeNull();
    expect(validateDestination({ type: 'ip', value: '10.0.0.0/24' })).toBeNull();
    expect(validateDestination({ type: 'fqdn', value: 'contoso.com' })).toBeNull();
    expect(validateDestination({ type: 'ip', value: 'not-a-cidr' })).toMatch(/invalid IPv4/);
    expect(validateDestination({ type: 'service-tag', value: 'Nope' })).toMatch(/unknown Azure service tag/);
  });
});

describe('validateEgressPolicy', () => {
  it('requires workspaceId + a full NSG ARM id', () => {
    expect(validateEgressPolicy({ workspaceId: '', nsgId: NSG_ID })).toMatch(/workspaceId/);
    expect(validateEgressPolicy({ workspaceId: 'ws', nsgId: 'nsg-compute' })).toMatch(/full ARM id/);
    expect(validateEgressPolicy({ workspaceId: 'ws', nsgId: NSG_ID, destinations: [{ type: 'ip', value: 'x' }] })).toMatch(/invalid IPv4/);
    expect(validateEgressPolicy({ workspaceId: 'ws', nsgId: NSG_ID, destinations: [{ type: 'service-tag', value: 'Storage' }] })).toBeNull();
  });
});

describe('normalizeEgressPolicy', () => {
  it('dedupes destinations, defaults ports/protocol, and defaults defaultDeny=true', () => {
    const p = normalizeEgressPolicy(
      {
        workspaceId: 'finance',
        nsgId: NSG_ID,
        destinations: [
          { type: 'service-tag', value: 'Storage' },
          { type: 'service-tag', value: 'Storage' }, // dup
          { type: 'ip', value: '10.0.0.0/24' },
        ],
      },
      { tenantId: 'tid', updatedBy: 'oid' },
    );
    expect(p.defaultDeny).toBe(true);
    expect(p.destinations).toHaveLength(2);
    const tag = p.destinations.find((d) => d.type === 'service-tag')!;
    expect(tag.ports).toBe('443');
    expect(tag.protocol).toBe('Tcp');
    const ip = p.destinations.find((d) => d.type === 'ip')!;
    expect(ip.ports).toBe('*');
    expect(ip.protocol).toBe('*');
    expect(p.tenantId).toBe('tid');
  });
});

describe('compileEgressRules', () => {
  const base: WorkspaceEgressPolicy = {
    id: 'egress:ws1', workspaceId: 'ws1', nsgId: NSG_ID, nsgName: 'nsg-compute',
    defaultDeny: true, tenantId: 'tid', updatedAt: 'now',
    destinations: [
      { id: 'service-tag:sql', type: 'service-tag', value: 'Sql', protocol: 'Tcp', ports: '1433' },
      { id: 'ip:10.0.0.0/24', type: 'ip', value: '10.0.0.0/24', protocol: '*', ports: '*' },
      { id: 'fqdn:contoso.com', type: 'fqdn', value: 'contoso.com', protocol: 'Tcp', ports: '443' },
    ],
  };

  it('emits Allow rules for tag/ip, a deny rule, and routes FQDN to firewallRequired', () => {
    const c = compileEgressRules(base);
    expect(c.allowRules).toHaveLength(2);
    expect(c.allowRules.every((r) => r.access === 'Allow')).toBe(true);
    const sql = c.allowRules.find((r) => r.destinationAddressPrefix === 'Sql')!;
    expect(sql.destinationPortRange).toBe('1433');
    expect(c.denyRule).not.toBeNull();
    expect(c.denyRule!.access).toBe('Deny');
    expect(c.denyRule!.destinationAddressPrefix).toBe('Internet');
    expect(c.firewallRequired.map((d) => d.value)).toEqual(['contoso.com']);
  });

  it('omits the deny rule when defaultDeny is off', () => {
    const c = compileEgressRules({ ...base, defaultDeny: false });
    expect(c.denyRule).toBeNull();
  });
});

describe('rule naming', () => {
  it('prefixes loom-egress and stays ARM-safe (<=80, valid final char)', () => {
    const name = egressRuleName('finance-analytics', { id: 'x', type: 'ip', value: '10.0.0.0/24' });
    expect(name.startsWith('loom-egress-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(/[a-zA-Z0-9_]$/.test(name)).toBe(true);
    expect(egressDenyRuleName('finance-analytics')).toBe('loom-egress-financeanalytics-deny-internet');
  });
});

import { describe, it, expect } from 'vitest';
import { shapeNsg, shapeNsgRule, type NsgInfo } from '../network-discovery';

const SUB = '00000000-0000-0000-0000-000000000000';

describe('shapeNsgRule', () => {
  it('maps a singular-prefix rule with all fields', () => {
    const r = shapeNsgRule({
      name: 'DenyInternetInbound',
      properties: {
        priority: 4000,
        access: 'Deny',
        direction: 'Inbound',
        protocol: '*',
        sourceAddressPrefix: 'Internet',
        sourcePortRange: '*',
        destinationAddressPrefix: '*',
        destinationPortRange: '*',
      },
    });
    expect(r).toEqual({
      name: 'DenyInternetInbound',
      direction: 'Inbound',
      access: 'Deny',
      priority: 4000,
      protocol: '*',
      sourcePrefix: 'Internet',
      destPrefix: '*',
      sourcePort: '*',
      destPort: '*',
    });
  });

  it('joins plural prefixes/ports and prefers them over the singular field', () => {
    const r = shapeNsgRule({
      name: 'AllowMulti',
      properties: {
        priority: 100,
        access: 'Allow',
        direction: 'Outbound',
        protocol: 'Tcp',
        sourceAddressPrefixes: ['10.0.0.0/24', '10.0.1.0/24'],
        destinationAddressPrefixes: ['10.0.5.0/24'],
        destinationPortRanges: ['443', '8443'],
      },
    });
    expect(r.sourcePrefix).toBe('10.0.0.0/24, 10.0.1.0/24');
    expect(r.destPrefix).toBe('10.0.5.0/24');
    expect(r.destPort).toBe('443, 8443');
    // Missing singular sourcePort falls back to '*'
    expect(r.sourcePort).toBe('*');
  });

  it('coerces a string priority and defaults missing fields', () => {
    const r = shapeNsgRule({ name: 'x', properties: { priority: '200' } });
    expect(r.priority).toBe(200);
    expect(r.protocol).toBe('*');
    expect(r.sourcePrefix).toBe('*');
  });
});

describe('shapeNsg', () => {
  const raw = {
    id: `/subscriptions/${SUB}/resourceGroups/rg-net/providers/Microsoft.Network/networkSecurityGroups/nsg-snet-functions`,
    name: 'nsg-snet-functions',
    location: 'eastus',
    properties: {
      securityRules: [
        { name: 'AllowVnetInbound', properties: { priority: 100, access: 'Allow', direction: 'Inbound', protocol: '*', sourceAddressPrefix: 'VirtualNetwork', destinationAddressPrefix: 'VirtualNetwork' } },
        { name: 'DenyInternetInbound', properties: { priority: 4000, access: 'Deny', direction: 'Inbound', protocol: '*', sourceAddressPrefix: 'Internet', destinationAddressPrefix: '*' } },
      ],
      subnets: [
        { id: `/subscriptions/${SUB}/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet-hub/subnets/snet-functions` },
      ],
    },
  };

  it('extracts id, name, resourceGroup, attached subnets, and rules', () => {
    const n: NsgInfo = shapeNsg(raw, SUB);
    expect(n.name).toBe('nsg-snet-functions');
    expect(n.resourceGroup).toBe('rg-net');
    expect(n.subscriptionId).toBe(SUB);
    expect(n.subnetIds).toHaveLength(1);
    expect(n.subnetIds[0].endsWith('/subnets/snet-functions')).toBe(true);
    expect(n.rules).toHaveLength(2);
  });

  it('sorts rules by direction then ascending priority', () => {
    const n = shapeNsg(raw, SUB);
    // Both inbound; lower priority first
    expect(n.rules.map((r) => r.priority)).toEqual([100, 4000]);
  });

  it('merges defaultSecurityRules with custom rules', () => {
    const withDefaults = {
      ...raw,
      properties: {
        ...raw.properties,
        defaultSecurityRules: [
          { name: 'DenyAllInbound', properties: { priority: 65500, access: 'Deny', direction: 'Inbound', protocol: '*' } },
        ],
      },
    };
    const n = shapeNsg(withDefaults, SUB);
    expect(n.rules).toHaveLength(3);
    expect(n.rules.some((r) => r.name === 'DenyAllInbound')).toBe(true);
  });

  it('degrades gracefully on an empty/partial payload', () => {
    const n = shapeNsg({ id: '', properties: {} }, SUB);
    expect(n.name).toBe('nsg');
    expect(n.rules).toEqual([]);
    expect(n.subnetIds).toEqual([]);
  });
});

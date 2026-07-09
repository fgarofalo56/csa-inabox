/**
 * Contract test for the AI Search service-administration ARM shaping
 * (lib/azure/aisearch-admin.ts, AIF-17). Locks the normalization of a raw ARM
 * `Microsoft.Search/searchServices` resource into the editor's Service tab
 * model (identity / networking / auth mode / semantic tier), so the panel reads
 * real ARM fields (no mocks pretending to be a backend).
 *
 * Grounded in Microsoft Learn:
 *   - searchServices resource properties (publicNetworkAccess, networkRuleSet,
 *     authOptions, disableLocalAuth, semanticSearch, encryptionWithCmk):
 *     https://learn.microsoft.com/rest/api/searchmanagement/services/get
 */
import { describe, it, expect } from 'vitest';
import { shapeProps, validateScale, ALLOWED_PARTITIONS, REPLICA_MIN, REPLICA_MAX } from '../aisearch-admin';

describe('shapeProps — ARM search-service normalization', () => {
  it('shapes a PE-locked, AAD-only, standard-semantic service', () => {
    const raw = {
      id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Search/searchServices/search-loom',
      name: 'search-loom', location: 'centralus', sku: { name: 'standard' },
      identity: { type: 'SystemAssigned', principalId: 'pid-123' },
      properties: {
        replicaCount: 2, partitionCount: 3, provisioningState: 'succeeded', status: 'running',
        publicNetworkAccess: 'disabled',
        networkRuleSet: { bypass: 'AzureServices', ipRules: [{ value: '1.2.3.4' }] },
        disableLocalAuth: true,
        privateEndpointConnections: [{ name: 'pe-search', properties: { privateLinkServiceConnectionState: { status: 'Approved' } } }],
        semanticSearch: 'standard',
        encryptionWithCmk: { enforcement: 'Disabled' },
      },
    };
    const p = shapeProps(raw);
    expect(p.name).toBe('search-loom');
    expect(p.sku).toBe('standard');
    expect(p.replicaCount).toBe(2);
    expect(p.partitionCount).toBe(3);
    expect(p.identityType).toBe('SystemAssigned');
    expect(p.publicNetworkAccess).toBe('disabled');
    expect(p.ipRules).toEqual(['1.2.3.4']);
    expect(p.authMode).toBe('aadOnly');
    expect(p.privateEndpointCount).toBe(1);
    expect(p.privateEndpoints[0]).toEqual({ name: 'pe-search', status: 'Approved' });
    expect(p.semanticSearch).toBe('standard');
    expect(p.cmkEnforcement).toBe('Disabled');
  });

  it('derives aadOrApiKey auth mode and enabled network access', () => {
    const p = shapeProps({
      id: 'x', name: 'n', location: 'l', sku: { name: 'basic' },
      properties: {
        publicNetworkAccess: 'enabled',
        disableLocalAuth: false,
        authOptions: { aadOrApiKey: { aadAuthFailureMode: 'http401WithBearerChallenge' } },
        semanticSearch: 'free',
      },
    });
    expect(p.authMode).toBe('aadOrApiKey');
    expect(p.aadFailureMode).toBe('http401WithBearerChallenge');
    expect(p.publicNetworkAccess).toBe('enabled');
    expect(p.semanticSearch).toBe('free');
    expect(p.privateEndpointCount).toBe(0);
  });

  it('defaults sensibly on a sparse resource', () => {
    const p = shapeProps({ properties: {} });
    expect(p.replicaCount).toBe(1);
    expect(p.partitionCount).toBe(1);
    expect(p.authMode).toBe('apiKeyOnly');
    expect(p.publicNetworkAccess).toBe('enabled');
    expect(p.ipRules).toEqual([]);
    expect(p.semanticSearch).toBe('standard');
  });
});

describe('validateScale — replica/partition scale request (AIF-17)', () => {
  it('accepts an in-range replica + partition change', () => {
    expect(validateScale({ replicaCount: 3, partitionCount: 6 })).toEqual({ ok: true });
    expect(validateScale({ replicaCount: REPLICA_MIN })).toEqual({ ok: true });
    expect(validateScale({ replicaCount: REPLICA_MAX })).toEqual({ ok: true });
    expect(validateScale({ partitionCount: 1 })).toEqual({ ok: true });
    expect(validateScale({ partitionCount: 12 })).toEqual({ ok: true });
  });

  it('rejects an empty request (nothing to change)', () => {
    const r = validateScale({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/replica or partition/i);
  });

  it('rejects out-of-range replica counts', () => {
    expect(validateScale({ replicaCount: 0 }).ok).toBe(false);
    expect(validateScale({ replicaCount: 13 }).ok).toBe(false);
    expect(validateScale({ replicaCount: 2.5 }).ok).toBe(false);
    expect(validateScale({ replicaCount: Number.NaN }).ok).toBe(false);
  });

  it('rejects a partition count outside the accepted set (e.g. 5, 7, 8)', () => {
    for (const bad of [0, 5, 7, 8, 10, 24]) {
      const r = validateScale({ partitionCount: bad });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/partitionCount must be one of/);
    }
    // every accepted value passes
    for (const good of ALLOWED_PARTITIONS) {
      expect(validateScale({ partitionCount: good }).ok).toBe(true);
    }
  });

  it('rejects when only one field is invalid even if the other is valid', () => {
    expect(validateScale({ replicaCount: 3, partitionCount: 5 }).ok).toBe(false);
    expect(validateScale({ replicaCount: 20, partitionCount: 6 }).ok).toBe(false);
  });
});

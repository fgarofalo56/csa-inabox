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
import { shapeProps } from '../aisearch-admin';

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

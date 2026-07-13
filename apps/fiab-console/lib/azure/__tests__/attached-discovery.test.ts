/**
 * Pins the brownfield attach discovery helpers (attached-discovery): the ARG
 * query builder (type filter + kind subset), the row→candidate mapper (incl.
 * coordinate extraction + non-target drop), and the ?kinds= param parser.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDiscoveryQuery,
  argRowToCandidate,
  argRowsToCandidates,
  coordsFromArmId,
  parseKindsParam,
} from '../attached-discovery';

const synapseId =
  '/subscriptions/sub-1/resourceGroups/rg-data/providers/Microsoft.Synapse/workspaces/ws1';

describe('attached-discovery', () => {
  it('builds an ARG query over all kinds by default', () => {
    const q = buildDiscoveryQuery();
    expect(q).toContain('resources');
    expect(q.toLowerCase()).toContain("'microsoft.synapse/workspaces'");
    expect(q.toLowerCase()).toContain("'microsoft.kusto/clusters'");
    expect(q).toContain('project id, name, type, kind, location, resourceGroup, subscriptionId, subName');
  });

  it('narrows the ARG query to a kind subset', () => {
    const q = buildDiscoveryQuery(['synapse', 'adx']);
    expect(q.toLowerCase()).toContain("'microsoft.synapse/workspaces'");
    expect(q.toLowerCase()).toContain("'microsoft.kusto/clusters'");
    expect(q.toLowerCase()).not.toContain("'microsoft.purview/accounts'");
  });

  it('extracts sub + rg from an ARM id', () => {
    expect(coordsFromArmId(synapseId)).toEqual({ subscriptionId: 'sub-1', resourceGroup: 'rg-data' });
  });

  it('maps an ARG row to a candidate', () => {
    const c = argRowToCandidate({
      id: synapseId, name: 'ws1', type: 'microsoft.synapse/workspaces',
      subscriptionId: 'sub-1', subName: 'Data Sub', resourceGroup: 'rg-data', location: 'eastus2',
    });
    expect(c).toMatchObject({
      kind: 'synapse', name: 'ws1', armResourceId: synapseId,
      subscriptionId: 'sub-1', subscriptionName: 'Data Sub', resourceGroup: 'rg-data', location: 'eastus2',
    });
  });

  it('drops non-target rows and rows outside a requested kind set', () => {
    const rows = [
      { id: synapseId, name: 'ws1', type: 'microsoft.synapse/workspaces', subscriptionId: 'sub-1', resourceGroup: 'rg' },
      { id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Web/sites/app', name: 'app', type: 'microsoft.web/sites', subscriptionId: 's', resourceGroup: 'r' },
    ];
    expect(argRowsToCandidates(rows)).toHaveLength(1);
    expect(argRowsToCandidates(rows, ['adx'])).toHaveLength(0);
  });

  it('parses ?kinds= into a validated list, dropping junk', () => {
    expect(parseKindsParam('synapse,adx,bogus')).toEqual(['synapse', 'adx']);
    expect(parseKindsParam('')).toBeUndefined();
    expect(parseKindsParam(null)).toBeUndefined();
    expect(parseKindsParam('nope')).toBeUndefined();
  });
});

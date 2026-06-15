/**
 * network-discovery-binding.test — PE → Loom-service/domain join (ARG).
 *
 * Verifies the PURE shaping + apply logic (no ARM / identity I/O):
 *   - shapeLoomBinding normalises the `loom-domain` tag (`loom-domain:<id>` OR
 *     the bare `<id>`) and lowercases the join-key id.
 *   - applyLoomBindings stamps connectedResourceType + loomDomain on the matching
 *     endpoint, joining case-insensitively on the backing resource's ARM id, and
 *     leaves unmatched / untagged endpoints untouched.
 *
 * These functions back the /admin/network topology's "Loom service bound to each
 * private endpoint" enrichment (task #220) — real ARG data, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  shapeLoomBinding,
  applyLoomBindings,
  type LoomServiceBinding,
  type PrivateEndpointInfo,
} from '../network-discovery';

const SUB = '00000000-0000-0000-0000-000000000000';
const synapseId =
  `/subscriptions/${SUB}/resourceGroups/rg-csa-loom-dlz-finance-eastus2/providers/Microsoft.Synapse/workspaces/syn-finance`;

function pe(partial: Partial<PrivateEndpointInfo>): PrivateEndpointInfo {
  return {
    id: partial.id || 'pe-1',
    name: partial.name || 'pe-1',
    subscriptionId: SUB,
    groupIds: partial.groupIds || ['Dev'],
    dns: partial.dns || [],
    connectedResourceId: partial.connectedResourceId,
    connectedResourceName: partial.connectedResourceName,
    ...partial,
  };
}

describe('shapeLoomBinding', () => {
  it('parses the prefixed `loom-domain:<id>` tag form + lowercases the id', () => {
    const b = shapeLoomBinding({
      id: synapseId,
      type: 'Microsoft.Synapse/workspaces',
      tags: { 'loom-domain': 'loom-domain:finance' },
    });
    expect(b.resourceId).toBe(synapseId.toLowerCase());
    expect(b.resourceType).toBe('Microsoft.Synapse/workspaces');
    expect(b.loomDomain).toBe('finance');
  });

  it('parses the bare `<id>` tag form', () => {
    const b = shapeLoomBinding({ id: synapseId, type: 'X', tags: { 'loom-domain': 'finance' } });
    expect(b.loomDomain).toBe('finance');
  });

  it('leaves loomDomain undefined when untagged or empty', () => {
    expect(shapeLoomBinding({ id: synapseId, type: 'X', tags: {} }).loomDomain).toBeUndefined();
    expect(shapeLoomBinding({ id: synapseId, type: 'X', tags: { 'loom-domain': '  ' } }).loomDomain).toBeUndefined();
    expect(shapeLoomBinding({ id: synapseId }).loomDomain).toBeUndefined();
  });

  it('degrades gracefully on an empty row', () => {
    const b = shapeLoomBinding({});
    expect(b.resourceId).toBe('');
    expect(b.resourceType).toBeUndefined();
    expect(b.loomDomain).toBeUndefined();
  });
});

describe('applyLoomBindings', () => {
  it('stamps type + domain on the matching endpoint (case-insensitive id join)', () => {
    const endpoints = [pe({ connectedResourceId: synapseId, connectedResourceName: 'syn-finance' })];
    const bindings: LoomServiceBinding[] = [
      { resourceId: synapseId.toLowerCase(), resourceType: 'Microsoft.Synapse/workspaces', loomDomain: 'finance' },
    ];
    applyLoomBindings(endpoints, bindings);
    expect(endpoints[0].connectedResourceType).toBe('Microsoft.Synapse/workspaces');
    expect(endpoints[0].loomDomain).toBe('finance');
  });

  it('leaves endpoints with no matching binding untouched', () => {
    const endpoints = [pe({ connectedResourceId: synapseId })];
    applyLoomBindings(endpoints, [
      { resourceId: '/subscriptions/x/resourcegroups/y/providers/microsoft.storage/storageaccounts/z' },
    ]);
    expect(endpoints[0].connectedResourceType).toBeUndefined();
    expect(endpoints[0].loomDomain).toBeUndefined();
  });

  it('ignores endpoints with no connectedResourceId', () => {
    const endpoints = [pe({ connectedResourceId: undefined })];
    applyLoomBindings(endpoints, [{ resourceId: synapseId.toLowerCase(), loomDomain: 'finance' }]);
    expect(endpoints[0].loomDomain).toBeUndefined();
  });
});

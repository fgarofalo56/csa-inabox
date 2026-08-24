/**
 * LOOM BRAIN — node identity.
 *
 * The assertions here protect the property described in `graph/node-id.ts`:
 * ARM ids arrive in inconsistent casing from Resource Graph, ARM GETs and bicep
 * `resourceId()` expressions, and if identity is case-SENSITIVE the same
 * resource becomes two nodes, each holding half its edges. The failure is
 * silent and it manufactures exactly the finding this system reports — a real
 * resource with a real ARM id and zero inbound edges.
 */
import { describe, it, expect } from 'vitest';
import {
  azureResourceNodeId,
  buildGraph,
  canonicalPath,
  codeModuleNodeId,
  deployArtifactNodeId,
  edgeId,
  loomItemNodeId,
  type ExtractionResult,
  type NodeId,
} from '../../graph';

const SUB = '11111111-1111-1111-1111-111111111111';

describe('azureResourceNodeId', () => {
  it('THE INVARIANT: two casings of the same ARM id produce ONE id', () => {
    const a = azureResourceNodeId(
      `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.App/containerApps/loom-capacity-broker`,
    );
    const b = azureResourceNodeId(
      `/SUBSCRIPTIONS/${SUB.toUpperCase()}/RESOURCEGROUPS/RG-LOOM/PROVIDERS/MICROSOFT.APP/CONTAINERAPPS/LOOM-CAPACITY-BROKER`,
    );
    expect(a).toBe(b);
  });

  it('strips trailing slashes and surrounding whitespace', () => {
    const bare = azureResourceNodeId(`/subscriptions/${SUB}/resourceGroups/rg/providers/x/y/z`);
    expect(azureResourceNodeId(`  /subscriptions/${SUB}/resourceGroups/rg/providers/x/y/z/  `)).toBe(bare);
  });

  it('DIFFERENT resources still get different ids — the normalization is not over-eager', () => {
    const a = azureResourceNodeId(`/subscriptions/${SUB}/resourceGroups/rg/providers/x/y/alpha`);
    const b = azureResourceNodeId(`/subscriptions/${SUB}/resourceGroups/rg/providers/x/y/beta`);
    expect(a).not.toBe(b);
  });

  it('THROWS on an empty id rather than minting a colliding prefix', () => {
    // A returned `azure:` would be shared by every empty id, merging unrelated
    // resources into one node. Failing loudly is the only safe answer.
    expect(() => azureResourceNodeId('')).toThrow(/empty ARM resource id/i);
    expect(() => azureResourceNodeId('   ')).toThrow(/empty ARM resource id/i);
  });

  it('the built graph resolves a mixed-casing reference to the SAME node', () => {
    const arm = `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.App/containerApps/svc`;
    const id = azureResourceNodeId(arm);
    const from = azureResourceNodeId(
      `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.App/containerApps/caller`,
    );
    const ex: ExtractionResult = {
      source: 'resource-graph',
      nodes: [
        {
          id,
          kind: 'azure-resource',
          displayName: 'svc',
          source: 'resource-graph',
          resourceId: arm,
          resourceType: 'Microsoft.App/containerApps',
          subscriptionId: SUB,
          resourceGroup: 'rg-loom',
          tags: {},
        },
        {
          id: from,
          kind: 'azure-resource',
          displayName: 'caller',
          source: 'resource-graph',
          resourceId: arm.replace('/svc', '/caller'),
          resourceType: 'Microsoft.App/containerApps',
          subscriptionId: SUB,
          resourceGroup: 'rg-loom',
          tags: {},
        },
      ],
      edges: [
        {
          provenance: 'configured',
          from,
          // The SHOUTED form of the same ARM id — as a different Azure API
          // would legitimately hand it back.
          targetRef: arm.toUpperCase(),
          emptyValue: false,
          evidence: { artifact: 'test', extractor: 'container-app-env' },
        },
      ],
      population: {
        subject: 'nodes',
        examined: 2,
        edgesExamined: 1,
        scope: 'test',
        blind: false,
        byProvenance: { declared: 0, configured: 1, imports: 0, observed: 0, owns: 0 },
      },
      skipped: [],
    };

    const g = buildGraph([ex]);
    const inbound = g.inboundEdges(id, 'configured');
    expect(inbound.result).toHaveLength(1);
    expect(g.report.edgesByResolution.dangling).toBe(0);
  });
});

describe('path-based ids', () => {
  it('canonicalPath normalizes Windows separators and a leading ./', () => {
    expect(canonicalPath('lib\\brain\\types.ts')).toBe('lib/brain/types.ts');
    expect(canonicalPath('./lib/brain/types.ts')).toBe('lib/brain/types.ts');
    expect(canonicalPath('lib/brain/')).toBe('lib/brain');
  });

  it('the same module reached via either separator is ONE node', () => {
    expect(codeModuleNodeId('lib\\brain\\types.ts')).toBe(codeModuleNodeId('lib/brain/types.ts'));
  });

  it('deploy artifacts and code modules never collide on the same path', () => {
    expect(deployArtifactNodeId('a/b.ts')).not.toBe(codeModuleNodeId('a/b.ts'));
  });

  it('loomItemNodeId requires both parts', () => {
    expect(loomItemNodeId('lakehouse', 'lh1')).toBe('loom:lakehouse/lh1');
    expect(() => loomItemNodeId('lakehouse', '')).toThrow();
    expect(() => loomItemNodeId('', 'lh1')).toThrow();
  });
});

describe('edgeId', () => {
  const from = 'azure:x' as NodeId;

  it('is deterministic for the same inputs', () => {
    expect(edgeId('declared', from, 'target', 'f:1:V')).toBe(edgeId('declared', from, 'target', 'f:1:V'));
  });

  it('separates two wires that differ ONLY by provenance', () => {
    expect(edgeId('declared', from, 't', 'd')).not.toBe(edgeId('configured', from, 't', 'd'));
  });

  it('separates two wires to the same target from different symbols', () => {
    // Without the discriminator the second would overwrite the first and one
    // real wire would vanish from every count.
    expect(edgeId('configured', from, 't', 'f:1:A')).not.toBe(edgeId('configured', from, 't', 'f:2:B'));
  });

  it('gives an EMPTY target a stable, explicit id rather than an ambiguous blank', () => {
    const id = edgeId('declared', from, '', 'main.bicep:4730:LOOM_BROKER_URL');
    expect(id).toContain('<empty>');
    expect(id).toBe(edgeId('declared', from, '   ', 'main.bicep:4730:LOOM_BROKER_URL'));
  });
});

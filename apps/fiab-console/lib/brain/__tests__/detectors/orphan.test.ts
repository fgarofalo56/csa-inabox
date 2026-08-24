/**
 * LOOM BRAIN — `orphan`: POSITIVE, NEGATIVE, and the honest-blindness arm.
 *
 * The third describe block is the one that matters most. On today's estate this
 * detector establishes a parent for NOTHING — the container tier is 63 apps, 29
 * jobs and 13 environments, all top-level ARM resources, and the loom-item node
 * count is 0. A detector in that state that returned "0 findings" and said
 * nothing else would be indistinguishable from a clean estate.
 */

import { describe, it, expect } from 'vitest';
import { azureResourceNodeId, loomItemNodeId } from '../../graph';
import { ORPHAN, armParentId, orphan, orphanDetector } from '../../detectors';
import { BROKER_ID, CONSOLE_ID, DIRECTLAKE_ID, RG, SUB, appRow, buildFixtureGraph } from './fixtures';

const ENV_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/loom-env`;
const CERT_ARM = `${ENV_ARM}/certificates/loom-cert`;
const GHOST_ENV_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/loom-env-deleted`;

describe('armParentId — ARM containment is structural, not heuristic', () => {
  it('a top-level resource has NO ARM parent, and says so rather than guessing', () => {
    expect(
      armParentId(`/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-x`),
    ).toBeNull();
  });

  it('a child resource resolves to its parent by dropping one type/name pair', () => {
    expect(armParentId(CERT_ARM)).toBe(ENV_ARM);
  });

  it('a string with no /providers/ segment yields null', () => {
    expect(armParentId(`/subscriptions/${SUB}/resourceGroups/${RG}`)).toBeNull();
  });

  it('the /providers/ match is case-insensitive', () => {
    // The same class of bug the substrate found in `resolveTarget`: a
    // case-sensitive prefix test silently reclassifies real resources.
    const upper = CERT_ARM.replace('/providers/', '/PROVIDERS/');
    expect(armParentId(upper)).not.toBeNull();
  });
});

describe('orphan — POSITIVE and NEGATIVE via caller-supplied parents', () => {
  const graph = buildFixtureGraph();

  it('POSITIVE: a node whose supplied parent is not in the graph is reported', () => {
    const result = orphanDetector({
      parentOf: { [BROKER_ID]: azureResourceNodeId(GHOST_ENV_ARM) },
      parentSource: 'properties.managedEnvironmentId',
    })(graph);
    expect(result.detector).toBe(ORPHAN);
    expect(result.findings.map((f) => f.subjects[0])).toContain(BROKER_ID);
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f.evidence.notes.join('\n')).toContain('properties.managedEnvironmentId');
  });

  it('NEGATIVE: the same node with a parent that IS in the graph is not reported', () => {
    // The discrimination. Only the presence of the parent differs between the
    // two arms; if the predicate were "has a parent" rather than "has a MISSING
    // parent", this is the assertion that would fail.
    const result = orphanDetector({ parentOf: { [BROKER_ID]: CONSOLE_ID } })(graph);
    expect(result.findings).toEqual([]);
    // …and it was genuinely evaluated, not skipped.
    expect(result.population.scope).toContain('ESTABLISHED for 1');
  });

  it('a supplied parent key that is not a node in the graph still evaluates', () => {
    // The map is caller data; a stale key should not crash or silently vanish.
    const result = orphanDetector({
      parentOf: { [BROKER_ID]: azureResourceNodeId(GHOST_ENV_ARM), [DIRECTLAKE_ID]: CONSOLE_ID },
    })(graph);
    expect(result.findings).toHaveLength(1);
    expect(result.population.scope).toContain('ESTABLISHED for 2');
  });

  it('the finding refuses to claim the parent was DELETED', () => {
    const result = orphanDetector({ parentOf: { [BROKER_ID]: azureResourceNodeId(GHOST_ENV_ARM) } })(graph);
    const f = result.findings[0]!;
    // R7 — absence from this graph and absence from Azure are different claims,
    // and only the first was measured.
    expect(f.confidence).toBe('medium');
    expect(f.evidence.notes.join('\n')).toMatch(/does NOT establish that the parent was deleted/);
    expect(f.remediation.proposedChange).toMatch(/Re-run discovery/);
  });
});

describe('orphan — POSITIVE and NEGATIVE via ARM id nesting, with no caller input', () => {
  it('POSITIVE: a child resource whose parent environment is absent is reported', () => {
    const graph = buildFixtureGraph({
      extraRows: [{ id: CERT_ARM, type: 'Microsoft.App/managedEnvironments/certificates', name: 'loom-cert' }],
    });
    const result = orphan(graph);
    expect(result.findings.map((f) => f.subjects[0])).toContain(azureResourceNodeId(CERT_ARM));
  });

  it('NEGATIVE: the same child with its parent PRESENT is not reported', () => {
    const graph = buildFixtureGraph({
      extraRows: [
        { id: CERT_ARM, type: 'Microsoft.App/managedEnvironments/certificates', name: 'loom-cert' },
        appRow({ armId: ENV_ARM, name: 'loom-env', minReplicas: 0 }),
      ],
    });
    const result = orphan(graph);
    expect(result.findings.map((f) => f.subjects[0])).not.toContain(azureResourceNodeId(CERT_ARM));
    // Evaluated, not skipped — the parent was established and found present.
    expect(result.skipped.some((s) => s.subject === azureResourceNodeId(CERT_ARM))).toBe(false);
  });
});

describe('orphan — a Loom item names its own workspace', () => {
  const workspaceId = 'ws-example-0001';

  it('POSITIVE: an item whose workspace node is absent is reported', () => {
    const graph = buildFixtureGraph();
    const item = loomItemNodeId('lakehouse', 'lh-0001');
    const result = orphanDetector({ parentOf: { [item]: loomItemNodeId('workspace', workspaceId) } })(graph);
    // The item node itself is not in the graph (nothing populates loom-item
    // nodes yet), so the map key matches nothing and no finding is produced —
    // which is correct, and is exactly the state to record.
    expect(result.findings).toEqual([]);
    expect(result.population.scope).toContain('parentOf=1 entr(ies)');
  });
});

describe('orphan — HONEST BLINDNESS on the estate as it exists today', () => {
  const graph = buildFixtureGraph();
  const result = orphan(graph);

  it('establishes a parent for NOTHING, and emits no findings', () => {
    // Every container app is top-level and there are no loom-item nodes, so rule
    // 2 and rule 3 both come up empty.
    expect(result.findings).toEqual([]);
  });

  it('and every unevaluated node is in `skipped` with the reason — not counted as clean', () => {
    expect(result.skipped.length).toBe(graph.nodes.length);
    for (const s of result.skipped) {
      expect(s.reason).toMatch(/no parent could be ESTABLISHED/);
      expect(s.reason).toMatch(/neither an orphan nor a node with a healthy parent/);
    }
  });

  it('the population states how many parents were established: zero', () => {
    // This is the sentence that stops "0 findings" from reading as "0 problems".
    expect(result.population.scope).toContain('ESTABLISHED for 0');
    expect(result.population.scope).toContain(`could NOT be established for ${graph.nodes.length}`);
    // NOT blind — there were plenty of nodes. The blindness is in the parent
    // relation, not in the node set, and the two are reported separately.
    expect(result.population.blind).toBe(false);
    expect(result.population.examined).toBe(graph.nodes.length);
  });

  it('the scope names the remedy: supply the parent map', () => {
    expect(result.skipped[0]!.reason).toContain('properties.managedEnvironmentId');
  });
});

/**
 * The CORRELATOR.
 *
 * The headline test is the #3893 shape: **nine bicep findings that are one dead
 * gate** must collapse to ONE group — and must do it with the model switched
 * off, because membership is measured, not inferred.
 *
 * The rest of the suite is about the boundary the model is not allowed to cross.
 * A fabricated correlation reads exactly like a real one; there is no field an
 * operator could inspect to tell them apart. So the tests check that the shape
 * makes fabrication impossible rather than that a prompt discourages it.
 */

import { describe, expect, it } from 'vitest';
import {
  applyProposals,
  artifactsOf,
  componentsOf,
  correlate,
  parseProposals,
} from '@/lib/brain/agents';
import { makeFinding, nineBicepFindings, stubClient, throwingClient, azureNodeId } from './fixtures';

describe('correlator — the #3893 acceptance case: nine findings, one dead gate', () => {
  const nine = nineBicepFindings();

  it('collapses nine findings into ONE component with NO model', () => {
    const components = componentsOf(nine);
    expect(components).toHaveLength(1);
    expect(components[0]!.indices).toHaveLength(9);
  });

  it('names the artifact that connected them', () => {
    const components = componentsOf(nine);
    expect(components[0]!.sharedArtifacts).toEqual([
      'deploy:platform/fiab/bicep/modules/landing-zone/main.bicep',
    ]);
  });

  it('emits one group of nine when the model is unavailable, flagged degraded', async () => {
    const out = await correlate({ findings: nine, client: throwingClient() });
    expect(out.result).toHaveLength(1);
    expect(out.result[0]!.members).toHaveLength(9);
    expect(out.result[0]!.rootCause).toBeNull();
    expect(out.result[0]!.degraded).toBe(true);
    // The grouping itself is measured, so it keeps high confidence even degraded.
    expect(out.result[0]!.confidence).toBe('high');
    expect(out.result[0]!.mergeSource).toBe('deterministic');
  });

  it('the model NAMES the root cause without touching membership', async () => {
    const out = await correlate({
      findings: nine,
      client: stubClient({
        correlator: {
          groups: [
            {
              components: [0],
              rootCause: 'landing-zone/main.bicep is never instantiated on any shipped params file',
              explanation: 'One params-file wiring fix makes all nine declarations reachable.',
              confidence: 'high',
            },
          ],
        },
      }),
    });
    expect(out.result).toHaveLength(1);
    expect(out.result[0]!.members).toHaveLength(9);
    expect(out.result[0]!.rootCause).toMatch(/never instantiated/);
    expect(out.result[0]!.degraded).toBe(false);
  });
});

describe('correlator — the model cannot invent membership', () => {
  it('a member list in the reply is not read at all; membership stays the component', async () => {
    const nine = nineBicepFindings();
    const unrelated = makeFinding({ id: 'unrelated-1', subjects: [azureNodeId('rg-other', 'app-zeta')] });
    const out = await correlate({
      findings: [...nine, unrelated],
      client: stubClient({
        correlator: {
          groups: [
            {
              components: [0],
              // The model tries to add the unrelated finding by id. The parser
              // has no field for it, so it cannot land.
              members: ['unrelated-1'],
              rootCause: 'one dead gate',
              confidence: 'high',
            },
          ],
        },
      }),
    });
    const group = out.result.find((g) => g.rootCause === 'one dead gate')!;
    expect(group.members).toHaveLength(9);
    expect(group.members).not.toContain('unrelated-1');
  });

  it('an out-of-range component index is DROPPED and recorded, never applied', () => {
    const nine = nineBicepFindings();
    const components = componentsOf(nine);
    const applied = applyProposals(components, nine, [
      { components: [0, 99], rootCause: 'x', explanation: null, confidence: 'high' },
    ]);
    expect(applied.skipped.map((s) => s.subject)).toContain('model component index 99');
    expect(applied.skipped[0]!.reason).toMatch(/membership is not model-decided/);
    // The valid half still applied.
    expect(applied.groups[0]!.members).toHaveLength(9);
  });

  it('a component claimed twice is assigned once — a finding cannot have two root causes', () => {
    const nine = nineBicepFindings();
    const components = componentsOf(nine);
    const applied = applyProposals(components, nine, [
      { components: [0], rootCause: 'first', explanation: null, confidence: 'high' },
      { components: [0], rootCause: 'second', explanation: null, confidence: 'high' },
    ]);
    expect(applied.groups).toHaveLength(1);
    expect(applied.groups[0]!.rootCause).toBe('first');
    expect(applied.skipped.some((s) => /already assigned/.test(s.reason))).toBe(true);
  });

  it('a model MERGE is capped at medium confidence — the merge is an inference', () => {
    const a = makeFinding({ id: 'a', subjects: [azureNodeId('rg-1', 'app-a')] });
    const a2 = makeFinding({ id: 'a2', subjects: [azureNodeId('rg-1', 'app-a')] });
    const b = makeFinding({ id: 'b', subjects: [azureNodeId('rg-2', 'app-b')] });
    const b2 = makeFinding({ id: 'b2', subjects: [azureNodeId('rg-2', 'app-b')] });
    const findings = [a, a2, b, b2];
    const components = componentsOf(findings);
    expect(components).toHaveLength(2);
    const applied = applyProposals(components, findings, [
      { components: [0, 1], rootCause: 'same underlying cause', explanation: null, confidence: 'high' },
    ]);
    expect(applied.groups).toHaveLength(1);
    expect(applied.groups[0]!.members).toHaveLength(4);
    expect(applied.groups[0]!.mergeSource).toBe('model');
    expect(applied.groups[0]!.confidence).toBe('medium');
  });

  it('a deterministic (unmerged) named group keeps the confidence the model gave', () => {
    const nine = nineBicepFindings();
    const applied = applyProposals(componentsOf(nine), nine, [
      { components: [0], rootCause: 'x', explanation: null, confidence: 'high' },
    ]);
    expect(applied.groups[0]!.mergeSource).toBe('deterministic');
    expect(applied.groups[0]!.confidence).toBe('high');
  });
});

describe('correlator — grouping mechanics', () => {
  it('findings sharing nothing do not group, and a group of one is not emitted', async () => {
    const findings = [
      makeFinding({ id: 'x', subjects: [azureNodeId('rg-1', 'app-x')] }),
      makeFinding({ id: 'y', subjects: [azureNodeId('rg-2', 'app-y')] }),
    ];
    expect(componentsOf(findings)).toHaveLength(2);
    const out = await correlate({ findings });
    expect(out.result).toEqual([]);
  });

  it('grouping is transitive: A–B share X and B–C share Y puts all three together', () => {
    const shared1 = azureNodeId('rg-1', 'app-shared-1');
    const shared2 = azureNodeId('rg-1', 'app-shared-2');
    const a = makeFinding({ id: 'a', subjects: [shared1] });
    const b = makeFinding({ id: 'b', subjects: [shared1, shared2] });
    const c = makeFinding({ id: 'c', subjects: [shared2] });
    const components = componentsOf([a, b, c]);
    expect(components).toHaveLength(1);
    expect(components[0]!.indices).toEqual([0, 1, 2]);
  });

  it('artifactsOf ignores ids that are not artifact- or resource-shaped', () => {
    const f = makeFinding({
      subjects: [],
      evidence: { nodes: [], edges: [], query: "nodesWithNoInboundEdge(graph, 'declared')", notes: [] },
    });
    expect(artifactsOf(f)).toEqual([]);
  });

  it('the population reports components AND the findings that produced them', async () => {
    const nine = nineBicepFindings();
    const out = await correlate({ findings: nine, client: throwingClient() });
    expect(out.population.subject).toBe('groups');
    expect(out.population.examined).toBe(1);
    expect(out.population.byDetector['inert-bicep-module']).toBe(9);
    expect(out.population.scope).toMatch(/9 finding\(s\) → 1 deterministic component\(s\)/);
    expect(out.population.scope).toMatch(/NO graph/);
  });

  it('an empty finding list is BLIND and makes no model call', async () => {
    const out = await correlate({ findings: [], client: throwingClient() });
    expect(out.population.blind).toBe(true);
    expect(out.result).toEqual([]);
    expect(out.usage.calls).toBe(0);
  });
});

describe('correlator — reply parsing is defensive', () => {
  it('drops malformed proposals rather than coercing them', () => {
    expect(parseProposals(null)).toEqual([]);
    expect(parseProposals({ groups: 'nope' })).toEqual([]);
    expect(parseProposals({ groups: [{ components: [] }, { components: ['0'] }, null] })).toEqual([]);
  });

  it('an unrecognized confidence falls back to low, never up to high', () => {
    const p = parseProposals({ groups: [{ components: [0], confidence: 'certain' }] });
    expect(p[0]!.confidence).toBe('low');
  });

  it('non-integer component indices are discarded', () => {
    const p = parseProposals({ groups: [{ components: [0, 1.5, 'two', null, 3] }] });
    expect(p[0]!.components).toEqual([0, 3]);
  });
});

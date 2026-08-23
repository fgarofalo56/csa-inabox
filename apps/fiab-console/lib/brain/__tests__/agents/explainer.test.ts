/**
 * The EXPLAINER.
 *
 * The property under test is that **the evidence a reader sees is never
 * something a model wrote**. Prose is the model's contribution; the evidence
 * block is built from the finding's own fields and is byte-identical whether the
 * model answered, failed, or was never configured.
 *
 * The second property is the number guard: a numeric token in the prose that the
 * model was not given is surfaced rather than trusted. That includes numbers the
 * model DERIVED — a percentage it computed is not an established fact, and this
 * whole system exists because a confident number without a measurement behind it
 * is how the estate went two weeks with a dead deploy path.
 */

import { describe, expect, it } from 'vitest';
import { evidenceBlock, explain, parseNarrative, unverifiedNumbers } from '@/lib/brain/agents';
import {
  blindFinding,
  costedFinding,
  makeFinding,
  stubClient,
  throwingClient,
} from './fixtures';

describe('explainer — the evidence block is deterministic', () => {
  it('carries the population, the query and the provenance counts', () => {
    const block = evidenceBlock(makeFinding());
    expect(block).toMatch(/EVIDENCE \(measured — not model-authored\)/);
    expect(block).toMatch(/query\s+: nodesWithNoInboundEdge\(graph, 'configured'\)/);
    expect(block).toMatch(/examined\s+: 29 node\(s\), 61 edge\(s\)/);
    expect(block).toMatch(/declared=12 configured=9/);
  });

  it('shouts when the population is BLIND — a reader must not have to notice it', () => {
    const block = evidenceBlock(blindFinding());
    expect(block).toMatch(/\*\* POPULATION IS BLIND/);
    expect(block).toMatch(/establishes nothing/);
  });

  it('renders a cost through formatCostFigure, so a derived figure cannot read as a bill', () => {
    const block = evidenceBlock(costedFinding());
    expect(block).toMatch(/DERIVED estimate — not a bill/);
    expect(block).not.toMatch(/\(billed/);
  });

  it('states when there is no cost rather than omitting the line', () => {
    expect(evidenceBlock(makeFinding())).toMatch(/cost\s+: \(none established\)/);
  });

  it('records the approval literals, so the recommend-only posture is visible', () => {
    expect(evidenceBlock(makeFinding())).toMatch(
      /approval\s+: requiresHumanApproval=true, mutatesAzure=false/,
    );
  });

  it('is IDENTICAL with and without a model — the model cannot author evidence', async () => {
    const f = makeFinding({ id: 'stable' });
    const withModel = await explain({
      findings: [f],
      client: stubClient({ explainer: { headline: 'h', prose: 'Some prose.' } }),
    });
    const without = await explain({ findings: [f] });
    expect(withModel.result[0]!.evidenceBlock).toBe(without.result[0]!.evidenceBlock);
  });
});

describe('explainer — the number guard', () => {
  it('flags a number the model was never given', () => {
    expect(unverifiedNumbers('There are 47 apps affected.', 'examined 29 nodes')).toEqual(['47']);
  });

  it('does not flag a number that appears in what the model was given', () => {
    expect(unverifiedNumbers('There are 29 apps affected.', 'examined 29 nodes')).toEqual([]);
  });

  it('flags a DERIVED number — a percentage the model computed is not a fact', () => {
    expect(unverifiedNumbers('That is 37% of the estate.', 'examined 23 of 63')).toEqual(['37']);
  });

  it('treats 2 and 2.0 as the same number', () => {
    expect(unverifiedNumbers('minReplicas is 2.0', 'minReplicas 2')).toEqual([]);
  });

  it('reports each unverified number once, however often it is repeated', () => {
    expect(unverifiedNumbers('99 and 99 and 99', 'nothing')).toEqual(['99']);
  });

  it('surfaces the flag on the narrative without deleting the prose', async () => {
    const out = await explain({
      findings: [makeFinding()],
      client: stubClient({ explainer: { headline: 'h', prose: 'A fleet of 4242 apps is affected.' } }),
    });
    expect(out.result[0]!.unverifiedNumbers).toEqual(['4242']);
    // Suppressing the sentence would hide that the model hallucinated.
    expect(out.result[0]!.modelProse).toMatch(/4242/);
  });
});

describe('explainer — degradation', () => {
  it('a model outage degrades ONE narrative and loses no evidence', async () => {
    const out = await explain({ findings: [makeFinding()], client: throwingClient() });
    const n = out.result[0]!;
    expect(n.degraded).toBe(true);
    expect(n.modelProse).toBeNull();
    expect(n.body).toBe(n.evidenceBlock);
    expect(n.headline).toMatch(/always-on/); // falls back to the finding's own title
    expect(out.population.modelUnavailable).toBe(1);
  });

  it('the body ends in measured evidence, so a reader finishes on facts', async () => {
    const out = await explain({
      findings: [makeFinding()],
      client: stubClient({ explainer: { headline: 'h', prose: 'Prose first.' } }),
    });
    const n = out.result[0]!;
    expect(n.body.startsWith('Prose first.')).toBe(true);
    expect(n.body.endsWith(n.evidenceBlock)).toBe(true);
  });

  it('a reply with no prose field degrades and is recorded in skipped', async () => {
    const out = await explain({
      findings: [makeFinding({ id: 'no-prose' })],
      client: stubClient({ explainer: { headline: 'only a headline' } }),
    });
    expect(out.result[0]!.degraded).toBe(true);
    expect(out.skipped.some((s) => s.subject === 'no-prose')).toBe(true);
    // The model DID answer, so it counts as consulted — a distinct state from an outage.
    expect(out.population.modelConsulted).toBe(1);
  });

  it('parses defensively — non-string fields are absent, not coerced', () => {
    expect(parseNarrative({ headline: 42, prose: null })).toEqual({ headline: null, prose: null });
    expect(parseNarrative(null)).toEqual({ headline: null, prose: null });
    expect(parseNarrative({ prose: '   ' })).toEqual({ headline: null, prose: null });
  });

  it('an empty finding list is BLIND', async () => {
    const out = await explain({ findings: [] });
    expect(out.population.blind).toBe(true);
    expect(out.result).toEqual([]);
  });
});

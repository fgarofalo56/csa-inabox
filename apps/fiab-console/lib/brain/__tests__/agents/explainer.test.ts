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
import {
  evidenceBlock,
  explain,
  modelChallengeBlock,
  MODEL_CHALLENGE_HEADER,
  parseNarrative,
  unverifiedNumbers,
  type Critique,
} from '@/lib/brain/agents';
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

/**
 * R7 — the EVIDENCE header must not describe text a model wrote.
 *
 * Until 2026-08-23 `evidenceBlock` announced itself as
 * `EVIDENCE (measured — not model-authored)` and then appended `c.claim`,
 * verbatim model output, ~25 lines further down. A review demonstrated it with a
 * marker string: a fabricated challenge rendered inside a block whose header
 * told the reader it was not model-authored.
 *
 * Every assertion below uses a MARKER rather than a real-looking sentence, so a
 * pass cannot come from the text happening to be absent for some other reason.
 */
describe('explainer — model-authored text never lands under the measured header', () => {
  const MARKER = 'HALLUCINATED-BY-THE-MODEL-a7f31d';

  function critiqueWithChallenge(): Critique {
    return {
      findingId: 'f-1',
      verdict: 'downgraded',
      deterministic: [
        {
          code: 'no-evidence',
          severity: 'refutes',
          statement: 'MEASURED-STATEMENT-b4c8 the evidence chain is empty',
          establishedBy: 'finding.evidence.nodes',
        },
      ],
      modelChallenges: [
        { claim: `${MARKER} reached via a private link nobody recorded`, wouldRefute: false, checkable: `${MARKER}-CHECK query the private endpoint table` },
      ],
      resultingConfidence: 'low',
      modelConsulted: true,
    };
  }

  it('the evidence block contains the MEASURED critic half and NOT the model half', () => {
    const block = evidenceBlock(makeFinding(), critiqueWithChallenge());
    // Positive control — the deterministic refutation IS here, so a pass below
    // cannot come from the critique being ignored wholesale.
    expect(block).toContain('MEASURED-STATEMENT-b4c8');
    expect(block).toContain('EVIDENCE (measured — not model-authored)');
    // The property.
    expect(block).not.toContain(MARKER);
    expect(block).not.toContain('challenge     :');
  });

  it('the model half is rendered under a header that says it is model-authored', () => {
    const block = modelChallengeBlock(critiqueWithChallenge());
    expect(block).toContain(MODEL_CHALLENGE_HEADER);
    expect(MODEL_CHALLENGE_HEADER).toContain('model-authored');
    expect(block).toContain(MARKER);
    expect(block).toContain(`${MARKER}-CHECK`);
  });

  it('is empty when the Critic consulted no model, so no empty header is emitted', () => {
    expect(modelChallengeBlock(undefined)).toBe('');
    expect(
      modelChallengeBlock({ ...critiqueWithChallenge(), modelChallenges: [] }),
    ).toBe('');
  });

  it('the body ends on measured evidence, with the model span labelled above it', async () => {
    const critiques = new Map([['f-1', critiqueWithChallenge()]]);
    const out = await explain({
      findings: [makeFinding({ id: 'f-1' })],
      critiques,
      client: stubClient({ explainer: { headline: 'H', prose: 'PROSE-MARKER-c9' } }),
    });
    const body = out.result[0]!.body;
    // All three spans are present …
    expect(body).toContain('PROSE-MARKER-c9');
    expect(body).toContain(MARKER);
    expect(body).toContain('EVIDENCE (measured — not model-authored)');
    // … in this order, and the measured one is LAST.
    expect(body.indexOf('PROSE-MARKER-c9')).toBeLessThan(body.indexOf(MODEL_CHALLENGE_HEADER));
    expect(body.indexOf(MODEL_CHALLENGE_HEADER)).toBeLessThan(
      body.indexOf('EVIDENCE (measured — not model-authored)'),
    );
    // The `evidenceBlock` field itself stays free of model text.
    expect(out.result[0]!.evidenceBlock).not.toContain(MARKER);
    expect(body.endsWith(out.result[0]!.evidenceBlock)).toBe(true);
  });
});

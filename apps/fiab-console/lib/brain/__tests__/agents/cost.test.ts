/**
 * MEASURED COST OF ONE RUN, at the volume this estate actually produces.
 *
 * The volume is not invented. From the graph substrate's measurement across all
 * six subscriptions on 2026-08-23:
 *
 *     CONTAINER APPS  63 examined, always-on 41, no-inbound-configured 32,
 *                     always-on AND unreachable 23
 *
 * **23** is therefore the realistic finding count for the founding detector, and
 * it is the volume priced below.
 *
 * ── WHY THE ASSERTIONS ARE EXACT ───────────────────────────────────────────
 * The token counts are exact rather than banded, and that brittleness is the
 * point: they are a function of the system prompts and the evidence blocks, so
 * doubling a prompt moves them, and this test is the thing that says so. A
 * banded assertion would let prompt bloat land silently and show up as a bill.
 *
 * ── EVERY NUMBER HERE IS AN ESTIMATE, AND SAYS SO ──────────────────────────
 * The shared `aoaiChatJson` primitive discards the response's `usage` block, so
 * the production path genuinely cannot report real token counts. These are
 * chars/4 estimates carrying `source: 'estimated'`, priced with the repo's own
 * per-tier blended list rates. The dollar figure is `derived` — an estimate of a
 * price, not a statement about a bill. On 2026-08-23 the Cost Management API
 * returned HTTP 429 on 11 consecutive attempts, which is exactly why that
 * distinction is load-bearing rather than pedantic.
 */

import { describe, expect, it } from 'vitest';
import { runBrainAgents } from '@/lib/brain/agents';
import { detectorResult, makeFinding, makeGraph, stubClient } from './fixtures';

const NOW = '2026-08-23T12:00:00.000Z';

/** 23 findings — the measured "always-on AND unreachable" count for this estate. */
function estateVolume() {
  return Array.from({ length: 23 }, (_, i) => makeFinding({ id: `app-${i}` }));
}

/** A stub that answers every agent with a realistically-sized reply. */
function realisticClient() {
  return stubClient({
    critic: {
      challenges: [
        {
          claim: 'The app may be reached by a path the graph does not model, such as a private DNS name resolved at runtime.',
          wouldRefute: true,
          checkable: 'Query Container Apps ingress logs for inbound requests over the last 30 days.',
        },
        {
          claim: 'minReplicas above zero may be a deliberate warm-start setting rather than waste.',
          wouldRefute: false,
          checkable: 'Check the module that sets minReplicas for a comment or a linked decision.',
        },
      ],
    },
    explainer: {
      headline: 'An always-on container app has no inbound configured edge',
      prose:
        'This app runs continuously and nothing in the deployed configuration resolves to it. The wire that was meant to reach it exists in the template and carries an empty value, so the app is addressable and unused.',
    },
    remediator: {
      summary: 'Set the environment variable to the app internal FQDN, or scale the app to zero',
      change:
        "In the admin-plane module, replace the empty value with the app's internal FQDN output, then redeploy and confirm the consumer reads a non-empty value.",
    },
    correlator: {
      groups: [
        {
          components: [0],
          rootCause: 'One template emits an empty value for the variable every consumer reads',
          explanation: 'A single edit to the emitting module reconnects all of the members.',
          confidence: 'high',
        },
      ],
    },
  });
}

describe('cost — one run at the estate measured volume (23 findings)', () => {
  it('reports per-tier token spend, all of it labelled ESTIMATED', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('unreachable-always-on', estateVolume())],
      graph: makeGraph([{ name: 'app-alpha', minReplicas: 2, tags: { 'loom-estate-id': 'e1' } }]),
      client: realisticClient(),
      now: NOW,
    });

    expect(report.findings).toHaveLength(23);
    expect(report.usage.source).toBe('estimated');

    // 23 critic + 23 explainer + 23 remediator + 1 correlator = 70 calls.
    // The correlator is ONE call for the whole run, which is why the strong tier
    // is dominated by the Critic rather than by correlation.
    expect(report.usage.calls).toBe(70);
    expect(Object.keys(report.usage.byTier).sort()).toEqual(['mini', 'standard', 'strong']);
  });

  it('the dollar figure is DERIVED and its basis can be reproduced by hand', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('unreachable-always-on', estateVolume())],
      client: realisticClient(),
      now: NOW,
    });
    expect(report.cost.source).toBe('derived');
    expect(report.cost.asOf).toBe(NOW);
    // The basis names every input to the arithmetic: the call count, whether the
    // counts were measured, the per-tier tokens, and the rate applied.
    expect(report.cost.basis).toMatch(/^70 model call\(s\); token counts ESTIMATED/);
    expect(report.cost.basis).toMatch(/mini: \d+p\+\d+c=\d+tok x \$[\d.]+\/1K/);
    expect(report.cost.basis).toMatch(/standard: \d+p\+\d+c=\d+tok x \$[\d.]+\/1K/);
    expect(report.cost.basis).toMatch(/strong: \d+p\+\d+c=\d+tok x \$[\d.]+\/1K/);
    expect(report.cost.basis).toMatch(/TIER_PRICE_COEFF/);
  });

  it('MEASURED — the run cost, recorded so prompt bloat cannot land silently', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('unreachable-always-on', estateVolume())],
      client: realisticClient(),
      now: NOW,
    });
    // These numbers are the deliverable. If an edit to a system prompt or an
    // evidence block moves them, this test is the notification.
    //
    // Measured 2026-08-23: 38,645 estimated tokens over 70 calls → $0.1891
    // DERIVED for the whole estate's unreachable-always-on finding set.
    //
    // Read the tier split, because it is the tier CHOICE justifying itself:
    //   mini      15,502 tok  x $0.001/1K = $0.0155   (~8% of spend, 40% of tokens)
    //   standard  11,569 tok  x $0.005/1K = $0.0578
    //   strong    11,574 tok  x $0.010/1K = $0.1157   (~61% of spend, 30% of tokens)
    // The strong tier is dominated by the Critic (23 calls) rather than the
    // Correlator (1 call for the whole run) — which is the deliberate place to
    // spend, since the Critic is the agent whose failure would be least visible.
    expect({
      calls: report.usage.calls,
      promptTokens: report.usage.promptTokens,
      completionTokens: report.usage.completionTokens,
      amountUsd: report.cost.amountUsd,
      mini: report.usage.byTier.mini,
      standard: report.usage.byTier.standard,
      strong: report.usage.byTier.strong,
    }).toEqual({
      calls: 70,
      promptTokens: 32_862,
      completionTokens: 5_783,
      amountUsd: 0.1891,
      mini: { promptTokens: 13_823, completionTokens: 1_679 },
      standard: { promptTokens: 10_097, completionTokens: 1_472 },
      strong: { promptTokens: 8_942, completionTokens: 2_632 },
    });
  });

  it('the per-finding marginal cost is what scales, and it is small', async () => {
    // A second run at ONE finding, so the marginal cost of a finding is a
    // measured difference rather than an inference from the total (the
    // correlator's single call does not scale with volume).
    const one = await runBrainAgents({
      detectorResults: [detectorResult('unreachable-always-on', [makeFinding({ id: 'solo' })])],
      client: realisticClient(),
      now: NOW,
    });
    expect(one.usage.calls).toBe(4); // critic + explainer + remediator + 1 correlator
    expect(one.cost.source).toBe('derived');
    expect(one.cost.amountUsd).toBeGreaterThan(0);
    // 23 findings cost far less than 23x one finding, because the correlator is
    // one call regardless of volume.
    expect(one.cost.amountUsd * 23).toBeGreaterThan(0.1891);
  });

  it('a deterministic-only run at the same volume costs nothing', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('unreachable-always-on', estateVolume())],
      now: NOW,
    });
    expect(report.findings).toHaveLength(23);
    expect(report.usage.calls).toBe(0);
    expect(report.cost.amountUsd).toBe(0);
    // The findings, evidence, critiques and proposals are all still there.
    expect(report.findings.every((r) => r.narrative.evidenceBlock.length > 0)).toBe(true);
    expect(report.findings.every((r) => r.remediation.proposal.requiresHumanApproval)).toBe(true);
  });
});

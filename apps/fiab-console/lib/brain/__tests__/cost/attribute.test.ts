/**
 * LOOM BRAIN cost — attribution, and the DEGRADE gate.
 *
 * THE GATE THIS FILE IS: "a test that a missing export degrades to derived WITH
 * the label, rather than to zero or to a throw."
 *
 * All three failure modes are checked, because they are genuinely different
 * bugs with the same symptom on screen:
 *
 *   → THROW   kills the whole cost surface for one missing file. On 2026-08-23
 *             "no export" was the REAL state of the world, so a throw here
 *             would have made the cost layer unusable on the day it shipped.
 *   → ZERO    an always-on service showing $0.00 reads as "nothing to see",
 *             which is the exact opposite of what an unreachable always-on
 *             service means. This is the dangerous one.
 *   → UNLABELLED  a derived number rendered like a bill is a false claim (R7).
 */

import { describe, expect, it } from 'vitest';
import { buildGraph, makePopulation } from '../../graph/graph';
import type { BrainNode, ExtractionResult } from '../../types';
import { attributeCost, attributionFor } from '../../cost/attribute';
import { readCostExport } from '../../cost/export-reader';
import { BILLED_MARKER, DERIVED_MARKER } from '../../cost/figure';
import { CONTAINER_APPS_RATES_USGOV } from '../../cost/rate-card';
import { BROKER_SCALE, SCALE_TO_ZERO, containerAppArmId, containerAppNode, SUB_A } from './fixtures';

function graphOf(nodes: readonly BrainNode[]) {
  const extraction: ExtractionResult = {
    source: 'resource-graph',
    nodes,
    edges: [],
    population: makePopulation({
      subject: 'nodes',
      nodes,
      edges: [],
      scope: `${nodes.length} synthetic node(s)`,
    }),
    skipped: [],
  };
  return buildGraph([extraction]);
}

const BROKER_ARM = containerAppArmId(SUB_A, 'rg-loom', 'loom-capacity-broker');
const broker = containerAppNode({
  name: 'loom-capacity-broker',
  location: 'centralus',
  scale: BROKER_SCALE,
});
const console_ = containerAppNode({
  name: 'loom-console',
  location: 'centralus',
  scale: { minReplicas: 2, cpu: 0.5, memory: '1Gi', source: 'resource-graph' },
});
/** Scale never read — the NOT-MEASURED case. */
const unmeasured = containerAppNode({ name: 'loom-unmeasured', location: 'centralus' });

describe('D1 — a MISSING export degrades to derived, labelled', () => {
  const graph = graphOf([broker, console_]);
  const result = attributeCost(graph, { bound: 'lower' });

  it('does NOT throw', () => {
    expect(() => attributeCost(graph, { bound: 'lower' })).not.toThrow();
  });

  it('does NOT produce $0.00 — every app is priced', () => {
    expect(result.attributions).toHaveLength(2);
    for (const a of result.attributions) {
      expect(a.figure.amountUsd).toBeGreaterThan(0);
    }
  });

  it('EVERY figure is labelled derived', () => {
    expect(result.billedCount).toBe(0);
    expect(result.derivedCount).toBe(2);
    for (const a of result.attributions) {
      expect(a.figure.source).toBe('derived');
      expect(a.rendered).toContain(DERIVED_MARKER);
      expect(a.rendered).not.toContain(BILLED_MARKER);
    }
  });

  it('records billedSource="none" so the caller cannot mistake this for billing', () => {
    expect(result.billedSource).toBe('none');
    expect(result.exportCompleteness).toBeNull();
  });

  it('names the degrade reason AND the remediation (the bicep module)', () => {
    expect(result.degradeReason).toContain('NO Cost Management export');
    expect(result.degradeReason).toContain('cost-export.bicep');
    expect(result.degradeReason).toContain('~24h');
  });

  it('the row population is BLIND — zero billing rows were read', () => {
    expect(result.rowPopulation.blind).toBe(true);
    expect(result.rowPopulation.examined).toBe(0);
    expect(result.rowPopulation.scope).toContain('no Cost Management export supplied');
  });

  it('the rollup has zero billed dollars and a derived subtotal', () => {
    expect(result.rollup.billedUsd).toBe(0);
    expect(result.rollup.billedCount).toBe(0);
    expect(result.rollup.derivedUsd).toBeGreaterThan(0);
    expect(result.rollup.dominantSource).toBe('derived');
  });

  it('carries the full band, not only the bound that was picked', () => {
    const a = attributionFor(result, broker.id);
    expect(a?.band).toBeDefined();
    expect(a!.band!.lower.amountUsd).toBeLessThan(a!.band!.upper.amountUsd);
  });

  it('the picked bound is the one requested — no silent default', () => {
    const lower = attributionFor(attributeCost(graph, { bound: 'lower' }), broker.id);
    const upper = attributionFor(attributeCost(graph, { bound: 'upper' }), broker.id);
    expect(lower!.figure.amountUsd).toBeLessThan(upper!.figure.amountUsd);
    expect(lower!.figure.basis).toContain('LOWER bound');
    expect(upper!.figure.basis).toContain('UPPER bound');
  });
});

describe('D2 — an UNPRICEABLE resource produces no figure, and a reason', () => {
  const result = attributeCost(graphOf([broker, unmeasured]), { bound: 'lower' });

  it('is absent from attributions entirely — not present with $0.00', () => {
    expect(attributionFor(result, unmeasured.id)).toBeUndefined();
    expect(result.attributions).toHaveLength(1);
  });

  it('appears in skipped with the NOT-MEASURED reason', () => {
    expect(result.unpricedCount).toBe(1);
    expect(result.skipped.some((s) => s.subject === unmeasured.id)).toBe(true);
    expect(result.skipped.find((s) => s.subject === unmeasured.id)?.reason).toContain(
      'NOT counted as $0.00',
    );
  });

  it('the rollup does not silently absorb it as a zero', () => {
    expect(result.rollup.derivedCount).toBe(1);
  });
});

describe('billed-first: a resource WITH a bill uses the bill', () => {
  const csv = [
    'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
    `2026-08-22,${BROKER_ARM},31.00,USD`,
  ].join('\n');
  const exportRead = readCostExport({
    exportName: 'loom-brain-daily',
    manifest: {
      blobName: 'manifest.json',
      json: JSON.stringify({
        dataRowCount: 1,
        blobs: [{ blobName: 'p.csv' }],
        runInfo: { endDate: '2026-08-22T23:59:59Z' },
      }),
    },
    partitions: [{ blobName: 'p.csv', csv }],
  });
  const result = attributeCost(graphOf([broker, console_]), {
    bound: 'upper',
    export: exportRead,
  });

  it('the billed resource carries the BILLED figure, not the derived estimate', () => {
    const a = attributionFor(result, broker.id);
    expect(a?.figure.source).toBe('billed');
    expect(a?.figure.amountUsd).toBeCloseTo(31.0, 6);
    expect(a?.rendered).toContain(BILLED_MARKER);
    expect(a?.band).toBeUndefined();
  });

  it('a resource with NO row still falls through to derived, labelled', () => {
    const a = attributionFor(result, console_.id);
    expect(a?.figure.source).toBe('derived');
    expect(a?.rendered).toContain(DERIVED_MARKER);
  });

  it('counts each source separately', () => {
    expect(result.billedCount).toBe(1);
    expect(result.derivedCount).toBe(1);
    expect(result.billedSource).toBe('export');
  });

  it('D3 — billed and derived are NEVER summed into one number', () => {
    expect(result.rollup.billedUsd).toBeCloseTo(31.0, 6);
    expect(result.rollup.derivedUsd).toBeGreaterThan(0);
    expect(result.rollup.dominantSource).toBe('derived');
    expect('totalUsd' in (result.rollup as unknown as Record<string, unknown>)).toBe(false);
  });

  it('names why the answer is still partly derived even with a complete export', () => {
    expect(result.exportCompleteness).toBe('complete');
    expect(result.degradeReason).toContain('had no row in it');
  });

  it('degradeReason is null ONLY when a complete export covered everything', () => {
    const only = attributeCost(graphOf([broker]), { bound: 'upper', export: exportRead });
    expect(only.degradeReason).toBeNull();
    expect(only.derivedCount).toBe(0);
  });
});

describe('an INCOMPLETE export is passed through, never quoted as whole', () => {
  const csv = [
    'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
    `2026-08-22,${BROKER_ARM},31.00,USD`,
  ].join('\n');
  const partial = readCostExport({
    exportName: 'loom-brain-daily',
    manifest: {
      blobName: 'manifest.json',
      json: JSON.stringify({
        blobs: [{ blobName: 'p.csv' }, { blobName: 'p2.csv' }],
        runInfo: { endDate: '2026-08-22T23:59:59Z' },
      }),
    },
    partitions: [{ blobName: 'p.csv', csv }],
  });

  it('surfaces the incompleteness on the attribution result', () => {
    const result = attributeCost(graphOf([broker, console_]), { bound: 'upper', export: partial });
    expect(result.exportCompleteness).toBe('incomplete');
    expect(result.degradeReason).toContain("completeness is 'incomplete'");
    expect(result.degradeReason).toContain('may double-count');
  });
});

describe('population (PRP §3.2) — three counts, three meanings', () => {
  it('a filter matching NOTHING is BLIND on the graph population', () => {
    const result = attributeCost(graphOf([broker]), {
      bound: 'lower',
      filter: { resourceType: 'Microsoft.Sql/servers', describe: 'SQL servers' },
    });
    expect(result.population.blind).toBe(true);
    expect(result.population.examined).toBe(0);
    expect(result.attributions).toHaveLength(0);
  });

  it('an EMPTY graph is blind rather than a clean $0.00', () => {
    const result = attributeCost(graphOf([]), { bound: 'lower' });
    expect(result.population.blind).toBe(true);
    expect(result.resourcePopulation.blind).toBe(true);
    expect(result.rollup.blind).toBe(true);
  });

  it('resources that EXIST but none priceable is blind on resourcePopulation', () => {
    // The state that would otherwise render as a confident $0.00 over real apps.
    const result = attributeCost(graphOf([unmeasured]), { bound: 'lower' });
    expect(result.population.blind).toBe(false);
    expect(result.population.examined).toBe(1);
    expect(result.resourcePopulation.blind).toBe(true);
    expect(result.unpricedCount).toBe(1);
  });

  it('the graph population names the filter that produced it', () => {
    const result = attributeCost(graphOf([broker]), { bound: 'lower' });
    expect(result.population.scope).toContain('Container Apps');
    expect(result.population.scope).toContain('billed-first then derived');
  });
});

describe('cloud parity through the attribution layer', () => {
  it('a Gov-region app is priced with the Gov card, unprompted', () => {
    const govApp = containerAppNode({
      name: 'loom-capacity-broker',
      location: 'usgovvirginia',
      scale: BROKER_SCALE,
    });
    const result = attributeCost(graphOf([govApp]), { bound: 'upper' });
    const a = attributionFor(result, govApp.id);
    expect(a?.band?.card.cloud).toBe('usgov');
    expect(a?.figure.amountUsd).toBeCloseTo(99.864, 6);
  });

  it('an explicit card overrides, and the override is visible in the basis', () => {
    const result = attributeCost(graphOf([broker]), {
      bound: 'upper',
      card: CONTAINER_APPS_RATES_USGOV,
    });
    expect(attributionFor(result, broker.id)?.figure.basis).toContain('usgov/usgovvirginia');
  });
});

describe('a scale-to-zero app is priced at a MEASURED zero, and stays labelled', () => {
  it('reports $0.00 with the "not a claim the app is free" note', () => {
    const zero = containerAppNode({
      name: 'loom-scale-to-zero',
      location: 'centralus',
      scale: SCALE_TO_ZERO,
    });
    const result = attributeCost(graphOf([zero]), { bound: 'upper' });
    const a = attributionFor(result, zero.id);
    expect(a?.figure.amountUsd).toBe(0);
    expect(a?.figure.source).toBe('derived');
    expect(a?.figure.basis).toContain('NOT a claim');
    // Distinguishable from the unpriceable case: this one IS an attribution.
    expect(result.unpricedCount).toBe(0);
    expect(result.resourcePopulation.blind).toBe(false);
  });
});

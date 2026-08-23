/**
 * LOOM BRAIN — the cost model: every figure is DERIVED, and every refusal has a
 * reason.
 *
 * Two properties this suite exists to hold:
 *
 *   1. THE MODEL CANNOT PRODUCE A BILL. Cost Management returned HTTP 429 on 11
 *      consecutive attempts over ~35 minutes on 2026-08-23, so nothing in the
 *      Brain has seen a billed number. `billedCost` is not imported by the cost
 *      model, and the guard below asserts that at the SOURCE level rather than
 *      trusting the output of the cases it happens to test.
 *
 *   2. GOV IS PRICED AT GOV RATES. `cloud-parity.md` — a Commercial-only
 *      capability is incomplete. A cost model that hard-codes Commercial rates
 *      does not merely lack Gov support; it reports a confidently wrong number,
 *      understating Gov by 25% on vCPU and 33% on memory. Both are measured from
 *      the public retail prices API and both are asserted here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatCostFigure } from '../../graph';
import {
  CONTAINER_APPS_RETAIL_RATES,
  RATES_READ_AT,
  RATES_SOURCE,
  SECONDS_PER_MONTH,
  estimateAlwaysOnMonthlyCost,
  memoryGiB,
} from '../../detectors/cost-model';
import { BROKER_ARM, RG, SUB, appRow } from './fixtures';
import { extractFromResourceGraph } from '../../graph';

/** Build a single AzureResourceNode through the real extractor, not by hand. */
function node(row: Parameters<typeof appRow>[0]) {
  const ex = extractFromResourceGraph([appRow(row)], {});
  const n = ex.nodes.find((x) => x.kind === 'azure-resource');
  if (!n || n.kind !== 'azure-resource') throw new Error('fixture produced no azure node');
  return n;
}

describe('memoryGiB — an unparseable value is null, never 0', () => {
  it('parses Gi and Mi', () => {
    expect(memoryGiB('1Gi')).toBe(1);
    expect(memoryGiB('2Gi')).toBe(2);
    expect(memoryGiB('0.5Gi')).toBe(0.5);
    expect(memoryGiB('512Mi')).toBeCloseTo(0.5, 6);
    expect(memoryGiB('  4  ')).toBe(4);
  });

  it('returns null on anything it does not recognise', () => {
    // Treating an unreadable size as 0 GiB would silently halve every estimate
    // that hit it, and nothing would show that it happened.
    expect(memoryGiB('lots')).toBeNull();
    expect(memoryGiB('')).toBeNull();
    expect(memoryGiB('-1Gi')).toBeNull();
    expect(memoryGiB('1Ti')).toBeNull();
  });
});

describe('estimateAlwaysOnMonthlyCost — the measured founding case', () => {
  it('prices the broker at $23.65/mo idle, reproducibly', () => {
    const broker = node({
      armId: BROKER_ARM,
      name: 'loom-capacity-broker',
      minReplicas: 2,
      cpu: 0.5,
      memory: '1Gi',
      fqdn: 'loom-capacity-broker.internal.example.invalid',
    });
    const est = estimateAlwaysOnMonthlyCost(broker);
    expect(est.kind).toBe('priced');
    if (est.kind !== 'priced') throw new Error('unreachable');

    // 2 x 0.5 vCPU x 2,628,000 s x $0.000003 =  $7.884
    // 2 x 1 GiB   x 2,628,000 s x $0.000003 = $15.768
    expect(est.figure.amountUsd).toBeCloseTo(23.65, 2);
    expect(est.figure.source).toBe('derived');
    // The ACTIVE upper bound is computed and named, so the regime is never left
    // implicit: 2 x 0.5 x 2,628,000 x $0.000024 = $63.07 + $15.77 = $78.84.
    expect(est.activeUpperBoundUsd).toBeCloseTo(78.84, 2);
    expect(est.figure.basis).toContain('78.84');
    expect(est.figure.asOf).toBe(RATES_READ_AT);
    expect(est.figure.basis).toContain(RATES_SOURCE);
  });

  it('the basis lets a reader reproduce the number by hand', () => {
    const broker = node({ armId: BROKER_ARM, name: 'b', minReplicas: 2, cpu: 0.5, memory: '1Gi' });
    const est = estimateAlwaysOnMonthlyCost(broker);
    if (est.kind !== 'priced') throw new Error('unreachable');
    const b = est.figure.basis;
    for (const part of ['2 always-on replica(s)', '0.5 vCPU', String(SECONDS_PER_MONTH), 'IDLE', 'centralus']) {
      expect(b).toContain(part);
    }
    // …and states what it deliberately does NOT net off.
    expect(b).toContain('free grant');
    expect(b).toContain('cannot be attributed to one app');
  });

  it('renders with its provenance always attached', () => {
    const broker = node({ armId: BROKER_ARM, name: 'b', minReplicas: 2, cpu: 0.5, memory: '1Gi' });
    const est = estimateAlwaysOnMonthlyCost(broker);
    if (est.kind !== 'priced') throw new Error('unreachable');
    expect(formatCostFigure(est.figure)).toMatch(/^\$23\.65 \(DERIVED estimate — not a bill;/);
  });
});

describe('estimateAlwaysOnMonthlyCost — every refusal names what was missing', () => {
  it('minReplicas 0 is not priced, and says it scales to zero', () => {
    const n = node({ armId: `${BROKER_ARM}-z`, name: 'z', minReplicas: 0, cpu: 0.5, memory: '1Gi' });
    const est = estimateAlwaysOnMonthlyCost(n);
    expect(est.kind).toBe('not-priced');
    if (est.kind !== 'not-priced') throw new Error('unreachable');
    expect(est.reason).toMatch(/scales to zero/);
  });

  it('NOT MEASURED scale is not priced, and is distinguished from minReplicas 0', () => {
    const n = node({ armId: `${BROKER_ARM}-u`, name: 'u', noScale: true });
    const est = estimateAlwaysOnMonthlyCost(n);
    if (est.kind !== 'not-priced') throw new Error('unreachable');
    expect(est.reason).toMatch(/NOT MEASURED/);
    expect(est.reason).toMatch(/Absent scale is not minReplicas 0/);
  });

  it('an unknown region is not priced, and refuses to substitute another region', () => {
    const n = node({
      armId: `${BROKER_ARM}-r`,
      name: 'r',
      minReplicas: 1,
      cpu: 0.5,
      memory: '1Gi',
      location: 'atlantisnorth',
    });
    const est = estimateAlwaysOnMonthlyCost(n);
    if (est.kind !== 'not-priced') throw new Error('unreachable');
    expect(est.reason).toMatch(/no retail rate was read for region 'atlantisnorth'/);
    expect(est.reason).toMatch(/confidently wrong/);
    // It lists what it DOES know, so the caller can see the gap.
    expect(est.reason).toContain('centralus');
    expect(est.reason).toContain('usgovvirginia');
  });

  it('an unparseable memory string is not priced', () => {
    const ex = extractFromResourceGraph(
      [
        {
          id: `${BROKER_ARM}-m`,
          type: 'Microsoft.App/containerApps',
          name: 'm',
          resourceGroup: RG,
          subscriptionId: SUB,
          location: 'centralus',
          tags: {},
          properties: {
            template: {
              containers: [{ name: 'm', resources: { cpu: 0.5, memory: 'plenty' } }],
              scale: { minReplicas: 1 },
            },
          },
        },
      ],
      {},
    );
    const n = ex.nodes.find((x) => x.kind === 'azure-resource')!;
    if (n.kind !== 'azure-resource') throw new Error('unreachable');
    const est = estimateAlwaysOnMonthlyCost(n);
    if (est.kind !== 'not-priced') throw new Error('unreachable');
    expect(est.reason).toMatch(/not in a form this model can parse/);
  });
});

describe('CLOUD PARITY — Gov is priced at Gov rates, not Commercial ones', () => {
  it('the rate table covers both Commercial and both Gov regions', () => {
    // A table with only Commercial regions would make every Gov finding
    // unpriced — or, worse, silently priced at Commercial rates.
    for (const r of ['centralus', 'eastus', 'usgovvirginia', 'usgovarizona']) {
      expect(CONTAINER_APPS_RETAIL_RATES[r], `missing rates for ${r}`).toBeDefined();
    }
  });

  it('Gov rates are HIGHER than Commercial, as measured from the retail API', () => {
    const com = CONTAINER_APPS_RETAIL_RATES.centralus!;
    const gov = CONTAINER_APPS_RETAIL_RATES.usgovvirginia!;
    expect(gov.vcpuActivePerSecond).toBeGreaterThan(com.vcpuActivePerSecond);
    expect(gov.vcpuIdlePerSecond).toBeGreaterThan(com.vcpuIdlePerSecond);
    expect(gov.memoryIdlePerGiBSecond).toBeGreaterThan(com.memoryIdlePerGiBSecond);
  });

  it('the SAME resource in Gov prices HIGHER than in Commercial', () => {
    // The end-to-end proof that the region actually reaches the arithmetic. A
    // model that read the table and then used a constant would pass the two
    // assertions above and fail this one.
    const shape = { name: 'x', minReplicas: 2, cpu: 0.5, memory: '1Gi' } as const;
    const com = estimateAlwaysOnMonthlyCost(node({ ...shape, armId: `${BROKER_ARM}-c`, location: 'centralus' }));
    const gov = estimateAlwaysOnMonthlyCost(node({ ...shape, armId: `${BROKER_ARM}-g`, location: 'usgovvirginia' }));
    if (com.kind !== 'priced' || gov.kind !== 'priced') throw new Error('unreachable');
    expect(gov.figure.amountUsd).toBeGreaterThan(com.figure.amountUsd);
    // 2 x 0.5 x 2,628,000 x 0.000004 = $10.512 + 2 x 1 x 2,628,000 x 0.000004 = $21.024 => $31.54
    expect(gov.figure.amountUsd).toBeCloseTo(31.54, 2);
    expect(gov.figure.basis).toContain('usgovvirginia');
  });

  it('region matching is case-insensitive, as ARM region names arrive in mixed case', () => {
    const n = node({ armId: `${BROKER_ARM}-C`, name: 'x', minReplicas: 1, cpu: 0.5, memory: '1Gi', location: 'CentralUS' });
    expect(estimateAlwaysOnMonthlyCost(n).kind).toBe('priced');
  });
});

describe('THE SOURCE GUARD — the cost model cannot construct a billed figure', () => {
  const SRC = join(__dirname, '..', '..', 'detectors', 'cost-model.ts');
  const text = readFileSync(SRC, 'utf8');
  // Strip comments: this module's own prose discusses `billedCost` at length, and
  // a guard that fires on its own documentation is a guard that gets weakened
  // until it stops firing at all.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('POPULATION: the guard actually read the module', () => {
    expect(text.length).toBeGreaterThan(1000);
    expect(code).toContain('estimateAlwaysOnMonthlyCost');
  });

  it('CONTROL: the matcher can actually fire', () => {
    // Without this, a broken regex and a clean file are indistinguishable —
    // both produce zero hits.
    expect(/\bbilledCost\s*\(/.test('return billedCost(1, "b", "d");')).toBe(true);
  });

  it('`billedCost` is never called, and is not even imported', () => {
    expect(/\bbilledCost\s*\(/.test(code)).toBe(false);
    expect(/import[\s\S]{0,200}billedCost/.test(code)).toBe(false);
  });

  it("no figure is constructed with source 'billed'", () => {
    expect(/source\s*:\s*['"]billed['"]/.test(code)).toBe(false);
  });
});

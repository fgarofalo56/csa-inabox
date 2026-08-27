/**
 * LOOM BRAIN cost — the DERIVED fallback.
 *
 * Two things are under test, and the second matters more than the first:
 *
 *   THE ARITHMETIC   measured SKU × published rate, checked to the cent against
 *                    numbers computed by hand from `./rate-card.ts`.
 *
 *   THE REFUSALS     every input the module cannot price must produce a SKIP
 *                    WITH A REASON — never `$0.00`. A $0.00 for an always-on
 *                    service whose scale could not be read is the cheapest form
 *                    of the R7 failure: it reads as "nothing to see" about the
 *                    exact class of resource this whole program exists to find.
 *
 * The founding example is the worked case: `loom-capacity-broker`, minReplicas
 * 2 at 0.5 vCPU / 1 GiB, healthy, internal FQDN, zero inbound `configured`
 * edges.
 */

import { describe, expect, it } from 'vitest';
import {
  boundOf,
  deriveContainerAppCost,
  isBand,
  parseMemoryGib,
} from '../../cost/derived';
import { DERIVED_MARKER, renderCost } from '../../cost/figure';
import {
  CONTAINER_APPS_RATES_COMMERCIAL,
  CONTAINER_APPS_RATES_USGOV,
  SECONDS_PER_MONTH,
} from '../../cost/rate-card';
import { BROKER_SCALE, SCALE_TO_ZERO, containerAppNode } from './fixtures';

// Computed by hand from the measured cards, so the test does not simply mirror
// the implementation's own expression:
//   always-on replica-seconds = 2 x 2_628_000        = 5_256_000
//   vCPU-seconds              = 5_256_000 x 0.5      = 2_628_000
//   GiB-seconds               = 5_256_000 x 1        = 5_256_000
// Commercial lower = 2_628_000 x 0.000003 + 5_256_000 x 0.000003 = 23.652
// Commercial upper = 2_628_000 x 0.000024 + 5_256_000 x 0.000003 = 78.840
// Gov        lower = 2_628_000 x 0.000004 + 5_256_000 x 0.000004 = 31.536
// Gov        upper = 2_628_000 x 0.00003  + 5_256_000 x 0.000004 = 99.864
const BROKER_COMMERCIAL_LOWER = 23.652;
const BROKER_COMMERCIAL_UPPER = 78.84;
const BROKER_GOV_LOWER = 31.536;
const BROKER_GOV_UPPER = 99.864;

describe('the founding example — loom-capacity-broker, priced', () => {
  const broker = containerAppNode({
    name: 'loom-capacity-broker',
    location: 'centralus',
    scale: BROKER_SCALE,
  });

  it('produces a band, not a single number', () => {
    const out = deriveContainerAppCost(broker);
    expect(isBand(out)).toBe(true);
  });

  it('prices the always-on floor to the cent at Commercial list rates', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error(`expected a band, got skip: ${out.reason}`);
    expect(out.lower.amountUsd).toBeCloseTo(BROKER_COMMERCIAL_LOWER, 6);
    expect(out.upper.amountUsd).toBeCloseTo(BROKER_COMMERCIAL_UPPER, 6);
  });

  it('counts 5,256,000 always-on replica-seconds in a 730-hour month', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.alwaysOnReplicaSeconds).toBe(2 * SECONDS_PER_MONTH);
  });

  it('BOTH bounds are labelled derived — neither can become a bill', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.lower.source).toBe('derived');
    expect(out.upper.source).toBe('derived');
    expect(renderCost(out.lower)).toContain(DERIVED_MARKER);
    expect(renderCost(out.upper)).toContain(DERIVED_MARKER);
  });

  it('each bound names WHICH bound it is, so a floor is never read as a ceiling', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.lower.basis).toContain('LOWER bound');
    expect(out.upper.basis).toContain('UPPER bound');
  });

  it('each bound states that the active/idle split is NOT MEASURED', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.lower.basis).toContain('NOT MEASURED');
    expect(out.upper.basis).toContain('NOT MEASURED');
  });

  it('each bound carries the rate and the source, so the number is reproducible', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.lower.basis).toContain('prices.azure.com');
    expect(out.lower.basis).toContain(String(CONTAINER_APPS_RATES_COMMERCIAL.vcpuIdleUsdPerSecond));
    expect(out.upper.basis).toContain(String(CONTAINER_APPS_RATES_COMMERCIAL.vcpuActiveUsdPerSecond));
  });

  it('lower is strictly below upper — the band has width because the split is unknown', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.lower.amountUsd).toBeLessThan(out.upper.amountUsd);
  });

  it('boundOf picks the named bound', () => {
    const out = deriveContainerAppCost(broker);
    if (!isBand(out)) throw new Error('expected a band');
    expect(boundOf(out, 'lower').amountUsd).toBeCloseTo(BROKER_COMMERCIAL_LOWER, 6);
    expect(boundOf(out, 'upper').amountUsd).toBeCloseTo(BROKER_COMMERCIAL_UPPER, 6);
  });
});

describe('cloud parity — the SAME resource costs more in Gov', () => {
  it('prices a Gov-region broker above the Commercial one, on both bounds', () => {
    const gov = deriveContainerAppCost(
      containerAppNode({ name: 'loom-capacity-broker', location: 'usgovvirginia', scale: BROKER_SCALE }),
    );
    if (!isBand(gov)) throw new Error(`expected a band, got skip: ${gov.reason}`);
    expect(gov.lower.amountUsd).toBeCloseTo(BROKER_GOV_LOWER, 6);
    expect(gov.upper.amountUsd).toBeCloseTo(BROKER_GOV_UPPER, 6);
    expect(gov.lower.amountUsd).toBeGreaterThan(BROKER_COMMERCIAL_LOWER);
    expect(gov.upper.amountUsd).toBeGreaterThan(BROKER_COMMERCIAL_UPPER);
  });

  it('uses the Gov card, and says so in the basis', () => {
    const gov = deriveContainerAppCost(
      containerAppNode({ name: 'x', location: 'usgovvirginia', scale: BROKER_SCALE }),
    );
    if (!isBand(gov)) throw new Error('expected a band');
    expect(gov.card.cloud).toBe('usgov');
    expect(gov.lower.basis).toContain('usgov/usgovvirginia');
  });

  it('an UNCLASSIFIABLE region is skipped, NOT silently priced at Commercial rates', () => {
    const out = deriveContainerAppCost(
      containerAppNode({ name: 'x', location: 'atlantis', scale: BROKER_SCALE }),
    );
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('no rate card');
    expect(out.reason).toContain('atlantis');
    expect(out.reason).toContain('refusing to substitute');
  });

  it('a MISSING region is skipped for the same reason', () => {
    const out = deriveContainerAppCost(containerAppNode({ name: 'x', scale: BROKER_SCALE }));
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('(absent)');
  });

  it('an explicit card overrides region resolution, so a caller can price anywhere', () => {
    const out = deriveContainerAppCost(
      containerAppNode({ name: 'x', location: 'atlantis', scale: BROKER_SCALE }),
      { card: CONTAINER_APPS_RATES_USGOV },
    );
    if (!isBand(out)) throw new Error(`expected a band, got skip: ${out.reason}`);
    expect(out.lower.amountUsd).toBeCloseTo(BROKER_GOV_LOWER, 6);
  });
});

describe('every refusal is a SKIP WITH A REASON, never $0.00', () => {
  it('absent scale facts: NOT MEASURED, not zero', () => {
    const out = deriveContainerAppCost(containerAppNode({ name: 'x', location: 'centralus' }));
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('NOT MEASURED');
    expect(out.reason).toContain('NOT counted as $0.00');
  });

  it('absent cpu: skipped', () => {
    const out = deriveContainerAppCost(
      containerAppNode({
        name: 'x',
        location: 'centralus',
        scale: { minReplicas: 1, memory: '1Gi', source: 'resource-graph' },
      }),
    );
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('scale.cpu absent');
  });

  it('absent memory: skipped', () => {
    const out = deriveContainerAppCost(
      containerAppNode({
        name: 'x',
        location: 'centralus',
        scale: { minReplicas: 1, cpu: 0.5, source: 'resource-graph' },
      }),
    );
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('scale.memory absent');
  });

  it('a BARE-NUMBER memory is rejected rather than guessed at a unit', () => {
    const out = deriveContainerAppCost(
      containerAppNode({
        name: 'x',
        location: 'centralus',
        scale: { minReplicas: 1, cpu: 0.5, memory: '1', source: 'resource-graph' },
      }),
    );
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('a bare number is rejected rather than guessed');
  });

  it('a MILLI memory quantity is skipped, and the reason says milli is not mega', () => {
    const out = deriveContainerAppCost(
      containerAppNode({
        name: 'x',
        location: 'centralus',
        scale: { minReplicas: 2, cpu: 0.5, memory: '512m', source: 'resource-graph' },
      }),
    );
    // Under the previous case-insensitive match this parsed as 512 MiB and
    // produced a confident band at 0.5 GiB per replica. The true reading is
    // 0.512 bytes. There is no magnitude check downstream that would have
    // caught either the wrong number or the absurd one, so the refusal has to
    // happen at the parse — and it has to SAY milli, or the author is left to
    // spot a one-letter case difference on their own.
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain("'512m'");
    expect(out.reason).toContain('MILLI');
    expect(out.reason).toContain('0.512 bytes');
    expect(out.reason).toContain("'512Mi'");
  });

  it('the milli explanation appears ONLY for a milli quantity', () => {
    const out = deriveContainerAppCost(
      containerAppNode({
        name: 'x',
        location: 'centralus',
        scale: { minReplicas: 1, cpu: 0.5, memory: 'lots', source: 'resource-graph' },
      }),
    );
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('could not be parsed as GiB');
    expect(out.reason).not.toContain('MILLI');
  });

  it('a non-Container-App resource is declined, not mis-priced with this card', () => {
    const node = containerAppNode({ name: 'x', location: 'centralus', scale: BROKER_SCALE });
    const other = { ...node, resourceType: 'Microsoft.Storage/storageAccounts' };
    const out = deriveContainerAppCost(other);
    expect(isBand(out)).toBe(false);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.reason).toContain('Microsoft.Storage/storageAccounts');
  });

  it('every skip names the node it is about, so it can be chased', () => {
    const node = containerAppNode({ name: 'unmeasured-app', location: 'centralus' });
    const out = deriveContainerAppCost(node);
    if (isBand(out)) throw new Error('unreachable');
    expect(out.subject).toBe(node.id);
  });
});

describe('minReplicas 0 is a MEASURED zero, and says what it does not claim', () => {
  const out = deriveContainerAppCost(
    containerAppNode({ name: 'scale-to-zero-app', location: 'centralus', scale: SCALE_TO_ZERO }),
  );

  it('produces a band of $0.00 — this one IS establishable', () => {
    if (!isBand(out)) throw new Error(`expected a band, got skip: ${out.reason}`);
    expect(out.lower.amountUsd).toBe(0);
    expect(out.upper.amountUsd).toBe(0);
  });

  it('states that $0.00 is the always-on FLOOR, not "the app is free"', () => {
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.lower.basis).toContain('NOT a claim');
    expect(out.lower.basis).toContain('Request-driven usage is NOT MEASURED');
  });

  it('is still labelled derived — a measured zero is not a billed zero', () => {
    if (!isBand(out)) throw new Error('expected a band');
    expect(out.lower.source).toBe('derived');
  });
});

describe('parseMemoryGib', () => {
  it('parses the forms Container Apps authors', () => {
    expect(parseMemoryGib('1Gi')).toBe(1);
    expect(parseMemoryGib('0.5Gi')).toBe(0.5);
    expect(parseMemoryGib('2Gi')).toBe(2);
    expect(parseMemoryGib('512Mi')).toBeCloseTo(0.5, 9);
    expect(parseMemoryGib(' 1Gi ')).toBe(1);
  });

  it('returns null rather than guessing', () => {
    expect(parseMemoryGib('1')).toBeNull();
    expect(parseMemoryGib('')).toBeNull();
    expect(parseMemoryGib(undefined)).toBeNull();
    expect(parseMemoryGib('lots')).toBeNull();
    expect(parseMemoryGib('-1Gi')).toBeNull();
    expect(parseMemoryGib('1GB')).toBeNull();
  });
});

/**
 * The suffix is Kubernetes quantity notation, where CASE IS MEANING.
 *
 * This block exists because the parser used to match the suffix with `/i` and
 * lower-case it before the lookup, which folded milli `m` into mega `M`: '512m'
 * — 0.512 BYTES — was priced as 512 MiB. That is a factor of 1,048,576,000 on
 * the memory term, and the memory term is two thirds of the founding example's
 * lower bound (15.768 of 23.652). Nothing upstream stopped a milli quantity
 * from arriving; ACA merely happens to author 'Gi', which makes the absence of
 * an incident luck rather than a guard.
 *
 * Every expectation below is an EXACT value, not a range. `toBeCloseTo` cannot
 * tell a 1024-based conversion from a 1000-based one at the small end, and that
 * distinction is the other half of this fix — a decimal 'G' is 1e9 bytes, not
 * 2^30, and reading it as the latter overstates the term by 7.4%.
 */
describe('parseMemoryGib — the suffix set, matched exactly', () => {
  it('binary (IEC) suffixes are powers of 1024', () => {
    // 1024 / 2^30 ; 512 x 2^20 / 2^30 ; 2^30 / 2^30 ; 2^40 / 2^30
    expect(parseMemoryGib('1Ki')).toBe(9.5367431640625e-7);
    expect(parseMemoryGib('512Mi')).toBe(0.5);
    expect(parseMemoryGib('1Gi')).toBe(1);
    expect(parseMemoryGib('1Ti')).toBe(1024);
  });

  it('decimal (SI) suffixes are powers of 1000, NOT 1024', () => {
    // 1e3 / 2^30 ; 1e6 / 2^30 ; 512e6 / 2^30 ; 1e9 / 2^30 ; 1e12 / 2^30
    expect(parseMemoryGib('1k')).toBe(9.313225746154785e-7);
    expect(parseMemoryGib('1M')).toBe(0.0009313225746154785);
    expect(parseMemoryGib('512M')).toBe(0.476837158203125);
    expect(parseMemoryGib('1G')).toBe(0.9313225746154785);
    expect(parseMemoryGib('1T')).toBe(931.3225746154785);
  });

  it('the binary spelling of a letter is larger than the decimal one', () => {
    const decimal = parseMemoryGib('512M');
    const binary = parseMemoryGib('512Mi');
    if (decimal === null || binary === null) throw new Error('both spellings must parse');
    expect(binary).toBeGreaterThan(decimal);
    // 2^20 / 1e6 — the whole reason the two bases are kept apart.
    expect(binary / decimal).toBeCloseTo(1.048576, 12);
  });

  it("MILLI 'm' is REFUSED — one thousandth of a byte is never mega", () => {
    expect(parseMemoryGib('512m')).toBeNull();
    expect(parseMemoryGib('1m')).toBeNull();
    expect(parseMemoryGib('0.5m')).toBeNull();
    expect(parseMemoryGib('512 m')).toBeNull();
    // Same digits, one letter of difference, three different outcomes. Before
    // the fix '512m', '512M' and '512Mi' all returned exactly 0.5 GiB.
    expect(parseMemoryGib('512M')).toBe(0.476837158203125);
    expect(parseMemoryGib('512Mi')).toBe(0.5);
  });

  it('an unrecognised or wrongly-cased suffix is declined, not folded', () => {
    // 'gi' parsed as 1 GiB before this fix, under the case-insensitive match.
    // It is not a suffix in this notation, and the tolerance that accepted it
    // is the same tolerance that turned milli into mega — so it goes too.
    // Declining costs a skip with a reason; accepting costs a wrong number that
    // looks exactly like a right one.
    expect(parseMemoryGib('1gi')).toBeNull();
    expect(parseMemoryGib('1MI')).toBeNull();
    expect(parseMemoryGib('1g')).toBeNull();
    // The decimal kilo is lower-case 'k'. A bare 'K' is not a suffix, and is
    // not assumed to mean either 'k' or 'Ki'.
    expect(parseMemoryGib('1K')).toBeNull();
    expect(parseMemoryGib('1t')).toBeNull();
    expect(parseMemoryGib('1Q')).toBeNull();
    expect(parseMemoryGib('1 quibble')).toBeNull();
  });
});

/**
 * The unit reaches the arithmetic. A parser test alone would not prove that —
 * `parseMemoryGib` could be right and its result still be discarded, or the
 * caller could re-derive the conversion itself. So the same two spellings are
 * priced end to end.
 *
 * Hand-computed from `./rate-card.ts` rather than from the implementation's
 * expression:
 *   always-on replica-seconds       = 2 x 2_628_000                = 5_256_000
 *   vCPU-seconds                    = 5_256_000 x 0.5              = 2_628_000
 *   GiB-seconds, '512Mi' (0.5 GiB)  = 5_256_000 x 0.5              = 2_628_000
 *   GiB-seconds, '512M'  (512e6 B)  = 5_256_000 x 0.476837158203125
 *                                                   = 2_506_256.103515625
 *   lower('512Mi') = 2_628_000 x 0.000003 + 2_628_000 x 0.000003         = 15.768
 *   lower('512M')  = 2_628_000 x 0.000003 + 2_506_256.103515625 x 0.000003
 *                                                        = 15.402768310546875
 */
describe('binary vs decimal memory reaches the priced figure', () => {
  const priced = (memory: string) =>
    deriveContainerAppCost(
      containerAppNode({
        name: 'x',
        location: 'centralus',
        scale: { minReplicas: 2, cpu: 0.5, memory, source: 'resource-graph' },
      }),
    );

  it("'512M' prices below '512Mi', because 1e6 bytes is less than 2^20", () => {
    const binary = priced('512Mi');
    const decimal = priced('512M');
    if (!isBand(binary) || !isBand(decimal)) throw new Error('both spellings must price');
    expect(binary.lower.amountUsd).toBeCloseTo(15.768, 9);
    expect(decimal.lower.amountUsd).toBeCloseTo(15.402768310546875, 9);
    expect(decimal.lower.amountUsd).toBeLessThan(binary.lower.amountUsd);
  });

  it('the basis echoes the GiB the unit actually meant, not the digits authored', () => {
    const decimal = priced('512M');
    if (!isBand(decimal)) throw new Error('expected a band');
    expect(decimal.lower.basis).toContain('0.476837158203125 GiB');
  });
});

describe('the pricing window is a parameter', () => {
  it('pricing one hour costs 1/730th of the month', () => {
    const node = containerAppNode({ name: 'x', location: 'centralus', scale: BROKER_SCALE });
    const month = deriveContainerAppCost(node);
    const hour = deriveContainerAppCost(node, { seconds: 3600 });
    if (!isBand(month) || !isBand(hour)) throw new Error('expected bands');
    expect(hour.upper.amountUsd * 730).toBeCloseTo(month.upper.amountUsd, 6);
  });
});

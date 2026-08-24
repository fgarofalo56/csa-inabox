/**
 * C4 — the unbounded publication edge.
 *
 * The narrow arms here are the ones this repo actually lost to: three of the four
 * #3876 bypasses drive a lexical enumerator's write count to ZERO, and the fifth
 * sink has no `write()` in source at all.
 *
 * ANTI-FIXTURE NOTE (taxonomy §5.6): the sensitive payload marker is the literal
 * `FIXTURE-TOKEN-A`, a NON-SECRET token. No control in this file asserts that a
 * leak still carries a real value — that shape turns closing a leak into a test
 * failure, and this repo tripped on it once already.
 */

import { describe, expect, it } from 'vitest';
import { detectUnboundedPublication, securityFindingsOf } from '@/lib/brain/security';
import {
  SINK_ALIASED,
  SINK_BOUNDED,
  SINK_BY_DESIGN,
  SINK_INHERITED_FD,
  SINK_INHERITED_FD_SAFE,
  SINK_ISSUE_TITLE,
  SINK_PREFIX_ONLY,
  c4Node,
  graphOf,
} from './fixtures/corpus';

describe('C4 — the unbounded publication edge', () => {
  it('POSITIVE: fires on an unbounded stderr write', () => {
    const findings = securityFindingsOf(
      detectUnboundedPublication(graphOf([c4Node('fx:c4:raw', [SINK_PREFIX_ONLY])])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C4-unbounded-publication');
    expect(findings[0].severity).toBe('critical');
  });

  it('POSITIVE (NARROW, prefix-only): fires when the expression STARTS WITH the boundary', () => {
    // #3876 bypass 1 — `write(formatStdout(a) + raw)` passes a
    // `arg.startsWith(fn + "(")` classifier while `raw` is never examined.
    const findings = securityFindingsOf(
      detectUnboundedPublication(graphOf([c4Node('fx:c4:prefix', [SINK_PREFIX_ONLY])])),
    );
    expect(findings[0].evidence.facts.join('\n')).toContain('STARTS WITH the boundary');
  });

  it('POSITIVE (NARROW, aliased): fires on a sink a lexical enumerator counts as ZERO writes', () => {
    // #3876 bypass 2 — `const out = process.stdout; out.write(raw)`.
    const findings = securityFindingsOf(
      detectUnboundedPublication(graphOf([c4Node('fx:c4:alias', [SINK_ALIASED])])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain("access path 'alias'");
  });

  it('POSITIVE (NARROW, inherited fd): fires with NO write() in the module at all', () => {
    // scripts/ci/deploy-retry.mjs:800 — stdio: ['inherit','inherit','pipe'].
    // Note `carriesSensitive: false` on this sink: the parent emits nothing. The
    // finding is about the CHILD's bytes, which is why a carriesSensitive-gated
    // predicate would miss it.
    expect(SINK_INHERITED_FD.carriesSensitive).toBe(false);
    const findings = securityFindingsOf(
      detectUnboundedPublication(graphOf([c4Node('fx:c4:fd', [SINK_INHERITED_FD])])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('INHERITED FD');
    // The child's behaviour was never established — UNKNOWN, reported as unknown.
    expect(findings[0].confidence).toBe('medium');
  });

  it('POSITIVE: fires on the issue TITLE, which is a separate sink from the body', () => {
    const findings = securityFindingsOf(
      detectUnboundedPublication(graphOf([c4Node('fx:c4:title', [SINK_ISSUE_TITLE])])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('built separately from the body');
  });

  it('NEGATIVE CONTROL: does NOT fire on a wholly bounded write', () => {
    expect(
      securityFindingsOf(detectUnboundedPublication(graphOf([c4Node('fx:c4:ok', [SINK_BOUNDED])]))),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on a disclosed unredactedByDesign exception', () => {
    expect(
      securityFindingsOf(
        detectUnboundedPublication(graphOf([c4Node('fx:c4:by-design', [SINK_BY_DESIGN])])),
      ),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on a spawn whose child is PROVEN to redact', () => {
    expect(
      securityFindingsOf(
        detectUnboundedPublication(graphOf([c4Node('fx:c4:fd-safe', [SINK_INHERITED_FD_SAFE])])),
      ),
    ).toEqual([]);
  });

  describe('the sink COUNT is asserted from inside the detector (§5.4)', () => {
    it('fires a population finding when the declared count has drifted', () => {
      const node = c4Node('fx:c4:drift', [SINK_BOUNDED, SINK_BY_DESIGN], 'drifting-publisher', 1);
      const result = detectUnboundedPublication(graphOf([node]));
      const pop = result.findings.filter((f) => f.findingClass === 'POP-population-integrity');
      expect(pop).toHaveLength(1);
      expect(pop[0].title).toContain('declares 1 publication sink(s) and has 2');
      // No SECURITY finding — both sinks are safe. The drift is the whole story.
      expect(securityFindingsOf(result)).toEqual([]);
    });

    it('does not fire the count finding when the declaration matches', () => {
      const node = c4Node('fx:c4:nodrift', [SINK_BOUNDED, SINK_BY_DESIGN]);
      const result = detectUnboundedPublication(graphOf([node]));
      expect(result.findings).toEqual([]);
    });
  });

  it('POPULATION: every access path is enumerated, including the ones with no write()', () => {
    const node = c4Node('fx:c4:all', [
      SINK_BOUNDED,
      SINK_ALIASED,
      SINK_PREFIX_ONLY,
      SINK_INHERITED_FD,
      SINK_ISSUE_TITLE,
    ]);
    const result = detectUnboundedPublication(graphOf([node]));
    expect(result.population.judged).toEqual([node.id]);
    expect(result.population.unjudged).toEqual([]);
    // Four of the five leak; the bounded one does not.
    expect(securityFindingsOf(result)).toHaveLength(4);
  });
});

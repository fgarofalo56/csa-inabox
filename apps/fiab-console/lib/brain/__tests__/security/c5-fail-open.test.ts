/**
 * C5 — fail-open. The population-integrity control here is the one the taxonomy
 * calls the single most transferable idea in this repo's guard corpus.
 */

import { describe, expect, it } from 'vitest';
import { detectFailOpen, securityFindingsOf } from '@/lib/brain/security';
import {
  MODES_ALL_REFUSING,
  MODES_TWO_OF_NINE_INVERTED,
  c5Node,
  graphOf,
} from './fixtures/corpus';

describe('C5 — fail-open (verdict totality)', () => {
  it('POSITIVE: fires on a probe that answers ALLOW on a failure mode', () => {
    const node = c5Node('fx:c5:open', {
      subject: 'graphUserInGroup',
      failureModes: [
        { name: 'network-error', verdict: 'deny' },
        { name: 'proxy-2xx-interstitial', verdict: 'allow' },
      ],
      unknownMapsTo: 'deny',
      emptyStateReachableOnReadError: false,
      adoptedFix: false,
    });
    const findings = securityFindingsOf(detectFailOpen(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].title).toContain('proxy-2xx-interstitial');
  });

  it('POSITIVE (NARROW): fires on 2 inverted modes out of 9 — one per mode', () => {
    // #3834's exact shape. A detector that samples one failure path, or that
    // asserts only "there is a catch", reports this node clean.
    const node = c5Node('fx:c5:two-of-nine', {
      subject: 'graphUserInGroup',
      failureModes: MODES_TWO_OF_NINE_INVERTED,
      unknownMapsTo: 'deny',
      emptyStateReachableOnReadError: false,
      adoptedFix: false,
    });
    const findings = securityFindingsOf(detectFailOpen(graphOf([node])));
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.title).join('\n')).toContain('wrong-national-cloud-2xx');
    // The 6 correctly-refusing modes do not offset the 2 that invert.
    expect(findings.every((f) => f.severity === 'critical')).toBe(true);
  });

  it('POSITIVE: fires when UNKNOWN is unmodelled or mapped to ALLOW', () => {
    const unmodelled = c5Node('fx:c5:unmodelled', {
      subject: 'probeA',
      failureModes: MODES_ALL_REFUSING,
      unknownMapsTo: 'unmodelled',
      emptyStateReachableOnReadError: false,
      adoptedFix: false,
    });
    const findings = securityFindingsOf(detectFailOpen(graphOf([unmodelled])));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('not modelled at all');
  });

  it('POSITIVE: fires when an empty-state claim renders while the read FAILED', () => {
    const node = c5Node('fx:c5:empty-claim', {
      subject: 'catalogDomainsGrid',
      failureModes: MODES_ALL_REFUSING,
      unknownMapsTo: 'deny',
      emptyStateReachableOnReadError: true,
      adoptedFix: false,
    });
    const findings = securityFindingsOf(detectFailOpen(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('while the read FAILED');
  });

  it('reports a LOW-grade coverage finding when only ONE failure mode is enumerated', () => {
    // "One uninverted sample is not coverage." Graded distinctly so it triages
    // separately from an actual inversion and does not train reviewers to ignore
    // the class.
    const node = c5Node('fx:c5:one-mode', {
      subject: 'probeB',
      failureModes: [{ name: 'network-error', verdict: 'deny' }],
      unknownMapsTo: 'deny',
      emptyStateReachableOnReadError: false,
      adoptedFix: true,
    });
    const findings = securityFindingsOf(detectFailOpen(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].confidence).toBe('low');
  });

  it('NEGATIVE CONTROL: does NOT fire on a probe that refuses on every mode', () => {
    const node = c5Node('fx:c5:clean', {
      subject: 'probeClean',
      failureModes: MODES_ALL_REFUSING,
      unknownMapsTo: 'deny',
      emptyStateReachableOnReadError: false,
      adoptedFix: false,
    });
    expect(securityFindingsOf(detectFailOpen(graphOf([node])))).toEqual([]);
  });

  describe('POPULATION MEMBERSHIP IS INDEPENDENT OF THE FIX', () => {
    it('keeps a component that ADOPTED the fix in the judged population, verdict clean', () => {
      // Quoting check-empty-claim-read-evidence.mjs:36-38 — a rule keyed to the
      // unsafe pattern goes quiet on exactly the files that adopt the fix, so
      // coverage and compliance become indistinguishable. Membership here is
      // (performsRead AND rendersEmptyStateClaim); adopting the fix removes
      // NEITHER, and this test is what proves that stayed true.
      const fixed = c5Node('fx:c5:fixed', {
        subject: 'catalogDomainsGrid',
        failureModes: MODES_ALL_REFUSING,
        unknownMapsTo: 'deny',
        emptyStateReachableOnReadError: false,
        adoptedFix: true,
      });
      const result = detectFailOpen(graphOf([fixed]));
      expect(result.population.candidates).toContain(fixed.id);
      expect(result.population.judged).toContain(fixed.id);
      expect(securityFindingsOf(result)).toEqual([]);
    });

    it('a fixed and an unfixed component are BOTH judged — only the verdict differs', () => {
      const fixed = c5Node('fx:c5:pop-fixed', {
        subject: 'gridFixed',
        failureModes: MODES_ALL_REFUSING,
        unknownMapsTo: 'deny',
        emptyStateReachableOnReadError: false,
        adoptedFix: true,
      });
      const broken = c5Node('fx:c5:pop-broken', {
        subject: 'gridBroken',
        failureModes: MODES_ALL_REFUSING,
        unknownMapsTo: 'deny',
        emptyStateReachableOnReadError: true,
        adoptedFix: false,
      });
      const result = detectFailOpen(graphOf([fixed, broken]));
      expect(result.population.judged).toEqual([fixed.id, broken.id]);
      expect(securityFindingsOf(result)).toHaveLength(1);
    });
  });
});

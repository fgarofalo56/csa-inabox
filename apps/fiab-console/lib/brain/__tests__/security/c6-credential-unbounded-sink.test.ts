/**
 * C6 — a credential forwarded to an unbounded sink.
 *
 * The NARROW arm is the one already in #3717's own record: the first fix
 * addressed `ftp:` only, and a plain `http:` cross-host redirect walks straight
 * through it.
 */

import { describe, expect, it } from 'vitest';
import { detectCredentialUnboundedSink, securityFindingsOf } from '@/lib/brain/security';
import { c6Node, c7Node, graphOf } from './fixtures/corpus';

const BASE = {
  callSite: 'connectors.fetch',
  attachedCredentials: ['authorization'] as readonly string[],
  redirectPolicy: 'follow' as const,
  opener: 'language-default' as const,
  stripsCredentialOnHostChange: false,
  schemeAllowlist: null,
  defaultOpenerInstalledProcessWide: false,
};

describe('C6 — credential to an unbounded, runtime-chosen sink', () => {
  it('POSITIVE: fires on a credential-bearing call that follows redirects', () => {
    const findings = securityFindingsOf(
      detectCredentialUnboundedSink(graphOf([c6Node('fx:c6:open', BASE)])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C6-credential-unbounded-sink');
    expect(findings[0].severity).toBe('critical');
    // The absence of configuration IS the finding when the default is unsafe.
    expect(findings[0].evidence.facts.join('\n')).toContain('THE ABSENCE OF CONFIGURATION');
  });

  it('POSITIVE (NARROW): still fires after an FTP-ONLY fix', () => {
    // #3717 opened naming one file and only the ftp variant, then corrected
    // itself: the plain http cross-host redirect is the variant that matters. A
    // detector keyed to a scheme allowlist is defeated by one character.
    const findings = securityFindingsOf(
      detectCredentialUnboundedSink(
        graphOf([c6Node('fx:c6:ftp-only', { ...BASE, schemeAllowlist: ['https', 'http'] })]),
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('ftp is excluded');
    expect(findings[0].evidence.facts.join('\n')).toContain('CROSS-HOST redirect');
  });

  it('grades the FTP-only fix the SAME as no fix at all', () => {
    const none = securityFindingsOf(
      detectCredentialUnboundedSink(graphOf([c6Node('fx:c6:g1', BASE)])),
    );
    const ftpOnly = securityFindingsOf(
      detectCredentialUnboundedSink(
        graphOf([c6Node('fx:c6:g2', { ...BASE, schemeAllowlist: ['https', 'http'] })]),
      ),
    );
    expect(ftpOnly[0].severity).toBe(none[0].severity);
    expect(ftpOnly[0].confidence).toBe(none[0].confidence);
  });

  it('POSITIVE: reports the process-wide default opener EVEN WHEN every site is clean', () => {
    // The second narrow bypass: fix the six named sites, leave the default
    // installed, and site seven inherits the defect on creation. A corpus where
    // every site is fixed is exactly the state in which a per-site audit reports
    // success — so this finding must not depend on any site being dirty.
    const cleanSiteBadDefault = c6Node('fx:c6:default-opener', {
      ...BASE,
      redirectPolicy: 'none',
      opener: 'restricted',
      stripsCredentialOnHostChange: true,
      defaultOpenerInstalledProcessWide: true,
    });
    const findings = securityFindingsOf(
      detectCredentialUnboundedSink(graphOf([cleanSiteBadDefault])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('site N+1 inherits');
  });

  it('NEGATIVE CONTROL: does NOT fire when redirects are disabled', () => {
    expect(
      securityFindingsOf(
        detectCredentialUnboundedSink(
          graphOf([c6Node('fx:c6:no-redirect', { ...BASE, redirectPolicy: 'none' })]),
        ),
      ),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire when the client strips the credential on host change', () => {
    expect(
      securityFindingsOf(
        detectCredentialUnboundedSink(
          graphOf([
            c6Node('fx:c6:strips', {
              ...BASE,
              opener: 'custom',
              stripsCredentialOnHostChange: true,
            }),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on a call that attaches no credential', () => {
    expect(
      securityFindingsOf(
        detectCredentialUnboundedSink(
          graphOf([c6Node('fx:c6:anon', { ...BASE, attachedCredentials: [] })]),
        ),
      ),
    ).toEqual([]);
  });

  it('names every attached credential — a session cookie is copied too, not just the bearer', () => {
    const findings = securityFindingsOf(
      detectCredentialUnboundedSink(
        graphOf([
          c6Node('fx:c6:two-creds', {
            ...BASE,
            attachedCredentials: ['authorization', 'cookie:session'],
          }),
        ]),
      ),
    );
    expect(findings[0].evidence.facts.join('\n')).toContain('2 distinct credentials');
  });

  // ── POPULATION (#3970) ─────────────────────────────────────────────────────
  //
  // C6 had ZERO assertions about its own population object. The registry-wide
  // census added in #3946 defends every detector against CANDIDATE-level
  // narrowing, and that part is closed. What it cannot see is a skip injected
  // INSIDE this detector's predicate: the node is still counted as judged, the
  // finding simply never fires, and `judged.length === candidates.length` stays
  // true. Only a per-class positive spec catches that, and C6 had none — which
  // is also why the mutation table carries no hollow arm for it.
  //
  // The property asserted is the one specific to this class: membership is
  // (kind === 'credential-egress'), i.e. "this call site attaches a credential
  // and can be redirected", and NOTHING about whether it was fixed. A detector
  // keyed to the unsafe shape goes quiet on exactly the sites that adopt the
  // fix, so coverage and compliance become indistinguishable.
  describe('POPULATION MEMBERSHIP IS INDEPENDENT OF THE VERDICT', () => {
    it('a call site that disabled redirects is still a CANDIDATE and still JUDGED', () => {
      const fixed = c6Node('fx:c6:pop-fixed', { ...BASE, redirectPolicy: 'none' });
      const result = detectCredentialUnboundedSink(graphOf([fixed]));
      expect(result.population.candidates).toContain(fixed.id);
      expect(result.population.judged).toContain(fixed.id);
      expect(result.population.unjudged).toEqual([]);
      expect(securityFindingsOf(result)).toEqual([]);
    });

    it('a fixed and an unfixed site are BOTH judged — only the verdict differs', () => {
      const fixed = c6Node('fx:c6:pop-clean', { ...BASE, redirectPolicy: 'none' });
      const broken = c6Node('fx:c6:pop-broken', BASE);
      const result = detectCredentialUnboundedSink(graphOf([fixed, broken]));
      expect(result.population.judged).toEqual([fixed.id, broken.id]);
      expect(result.population.judged).toEqual(result.population.candidates);
      expect(securityFindingsOf(result)).toHaveLength(1);
    });

    it('every exoneration route keeps the node judged — no predicate skip removes it', () => {
      // One node per NEGATIVE CONTROL above. Each is exonerated for a different
      // reason, and every one of those reasons is a place a `continue` could be
      // injected inside the predicate. If any exit stops counting its node, this
      // equality breaks even though the findings list is unchanged.
      const nodes = [
        c6Node('fx:c6:pop-no-redirect', { ...BASE, redirectPolicy: 'none' }),
        c6Node('fx:c6:pop-strips', { ...BASE, opener: 'custom', stripsCredentialOnHostChange: true }),
        c6Node('fx:c6:pop-anon', { ...BASE, attachedCredentials: [] }),
      ];
      const result = detectCredentialUnboundedSink(graphOf(nodes));
      expect(result.population.candidates).toEqual(nodes.map((n) => n.id));
      expect(result.population.judged).toEqual(nodes.map((n) => n.id));
      expect(securityFindingsOf(result)).toEqual([]);
    });

    it('the population is SCOPED to this class, not to the whole graph', () => {
      // The other direction, and the reason the equality above is not vacuous: a
      // detector that adopted "every node is a candidate" would satisfy
      // judged === candidates trivially while judging things it cannot reason
      // about.
      const mine = c6Node('fx:c6:pop-mine', BASE);
      const foreign = c7Node('fx:c6:pop-foreign', {
        sink: 'mintSessionCookie',
        reachesPartitionKeyOrTenantScope: true,
        sources: [{ origin: 'literal', validation: 'none', bypassesMinter: false }],
        checkCopies: 1,
        checkCopiesUnderTest: 1,
      });
      const result = detectCredentialUnboundedSink(graphOf([mine, foreign]));
      expect(result.population.candidates).toEqual([mine.id]);
      expect(result.population.candidates).not.toContain(foreign.id);
      expect(result.population.declaredKinds).toEqual(['credential-egress']);
    });
  });
});

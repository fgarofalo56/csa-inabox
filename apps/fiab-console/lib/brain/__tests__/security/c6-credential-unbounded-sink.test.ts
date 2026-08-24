/**
 * C6 — a credential forwarded to an unbounded sink.
 *
 * The NARROW arm is the one already in #3717's own record: the first fix
 * addressed `ftp:` only, and a plain `http:` cross-host redirect walks straight
 * through it.
 */

import { describe, expect, it } from 'vitest';
import { detectCredentialUnboundedSink, securityFindingsOf } from '@/lib/brain/security';
import { c6Node, graphOf } from './fixtures/corpus';

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
});

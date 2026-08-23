/**
 * C6 — A CREDENTIAL FORWARDED TO AN UNBOUNDED SINK.
 *
 * Taxonomy §7 — a class the commissioned list did not contain. Every other class
 * concerns an edge that exists in the graph and is mis-predicated. This one
 * concerns an edge whose SINK NODE IS CHOSEN AT RUNTIME BY A REMOTE PARTY. There
 * is no node to reason about statically:
 *
 *     node  credential   provenance: configured  (a bearer token / session cookie)
 *     node  request      provenance: declared
 *     node  sink         provenance: NONE — chosen by the remote at runtime
 *     edge  credential -> sink   EGRESS with no static target
 *
 * ── THE INSTANCE (#3717, OPEN, sprint:active) ────────────────────────────
 *
 * Six credential-bearing `urllib.request.urlopen` sites follow cross-origin
 * redirects with `Authorization` attached. All call through Python's DEFAULT
 * GLOBAL OPENER, which:
 *
 *   - installs `FTPHandler`, `FileHandler` and `DataHandler` — NO PROXY VARIABLE
 *     REQUIRED;
 *   - permits a redirect to `('http','https','ftp','')`;
 *   - copies EVERY header except `content-length`/`content-type` onto the
 *     redirected request. `urllib` does NOT strip `Authorization` across a host
 *     change the way `requests` does.
 *
 * So a hostile or compromised upstream answering `302` hands the caller's bearer
 * token to whatever host `Location:` names. One of the six carries
 * `Authorization` AND a session cookie — both copied.
 *
 * NOT RE-VERIFIED BY THIS LANE. The taxonomy states plainly that it did not
 * independently re-open the six file:line citations; they are the issue's
 * measurement. This detector is built to the SHAPE the issue describes, and the
 * fixtures are synthetic. Nothing here asserts those six sites are still present.
 *
 * ── THE NARROW BYPASS IS ALREADY IN THE RECORD ───────────────────────────
 *
 * #3717 corrected its own original framing, and the correction is the bypass:
 * the issue was opened naming ONE file and only the `ftp:` variant, gated on a
 * proxy variable. Both were wrong, and THE CORRECTED VERSION IS WORSE — six
 * sites, no proxy variable needed, and the plain `http:` cross-host redirect (not
 * `ftp:`) is the variant that matters.
 *
 * So: FIX THE SCHEME, NOT THE ORIGIN. Any detector keyed to a SCHEME ALLOWLIST
 * rather than to ORIGIN COMPARISON is defeated by one character's difference.
 * This detector therefore treats `schemeAllowlist` as EVIDENCE ONLY — it never
 * clears a site — and says so in the finding when it sees an ftp-only fix.
 *
 * The second narrow bypass: fix the six named sites and leave the header-
 * preserving default opener installed, so SITE SEVEN INHERITS THE DEFECT ON
 * CREATION. That is a MODULE-level finding, emitted independently of whether any
 * individual call site is currently clean — which is the whole point, since by
 * construction it fires on a corpus where every site has been fixed.
 */

import { buildFinding } from '../finding-builder';
import {
  candidatesOfKind,
  detectorResult,
  type DetectorResult,
  type Population,
  type SecurityDetectorSpec,
} from '../population';
import type { CredentialEgressFacet, Finding, SecurityGraph } from '../substrate';

export const C6_DETECTOR_ID = 'security.c6.credential-unbounded-sink';

/**
 * The three things that actually bound the sink. Note what is NOT here:
 * a scheme allowlist.
 */
function sinkIsBounded(facet: CredentialEgressFacet): boolean {
  if (facet.redirectPolicy === 'none') return true;
  if (facet.redirectPolicy === 'same-origin-only') return true;
  return facet.stripsCredentialOnHostChange;
}

export function detectCredentialUnboundedSink(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'credential-egress');
  const findings: Finding[] = [];
  const judged: string[] = [];

  for (const node of nodes) {
    const facet = node.facet as CredentialEgressFacet;

    if (facet.attachedCredentials.length > 0 && !sinkIsBounded(facet)) {
      const schemeOnlyFix =
        facet.schemeAllowlist !== null && !facet.schemeAllowlist.includes('ftp');

      const facts: string[] = [
        `${facet.callSite} attaches [${facet.attachedCredentials.join(', ')}] and follows redirects`,
        `opener: ${facet.opener}; strips credential on HOST change: ${facet.stripsCredentialOnHostChange}`,
        'The sink node has no static target — the remote chooses it with a Location header, so ' +
          'there is nothing in the graph to authorize.',
      ];

      if (facet.opener === 'language-default') {
        facts.push(
          'The opener is the LANGUAGE DEFAULT, and the defect is IN the default: it copies every ' +
            'header except content-length/content-type onto the redirected request. THE ABSENCE ' +
            'OF CONFIGURATION IS THE FINDING.',
        );
      }
      if (schemeOnlyFix) {
        facts.push(
          `NARROW: a scheme allowlist is in place (${facet.schemeAllowlist?.join(', ')}) and ftp ` +
            'is excluded — but a plain http: CROSS-HOST redirect walks straight through it. ' +
            '#3717 opened against the ftp variant and corrected itself: the http cross-host ' +
            'redirect is the variant that matters. A scheme allowlist NEVER clears this site.',
        );
      }
      if (facet.attachedCredentials.length > 1) {
        facts.push(
          `${facet.attachedCredentials.length} distinct credentials are attached; all of them are ` +
            'copied across the host change, not just the bearer.',
        );
      }

      findings.push(
        buildFinding({
          id: `${C6_DETECTOR_ID}:${node.id}`,
          detectorId: C6_DETECTOR_ID,
          findingClass: 'C6-credential-unbounded-sink',
          severity: 'critical',
          confidence: 'high',
          title: `${facet.callSite} forwards a credential to a runtime-chosen host`,
          nodeIds: [node.id],
          query:
            'credential-egress where attachedCredentials is non-empty AND NOT (redirectPolicy is ' +
            'none/same-origin-only OR stripsCredentialOnHostChange) — schemeAllowlist is ' +
            'deliberately NOT part of this predicate',
          facts,
          remediationSummary:
            'Disable redirects, or compare ORIGIN before re-attaching the credential, or use a ' +
            'client that strips Authorization on a host change. Restricting the scheme does not ' +
            'address this — the http cross-host redirect is the variant that matters. DRAFT ONLY.',
          proposedPatchDescription:
            `Replace the default opener at ${facet.callSite} with one whose handler set is ` +
            'restricted and which drops credentials when the redirect target changes origin.',
        }),
      );
    }

    // The module-level defect. Emitted EVEN WHEN every call site above is clean,
    // because that is precisely when it matters: site N+1 inherits the defect on
    // creation and no per-site audit will ever notice.
    if (facet.defaultOpenerInstalledProcessWide) {
      findings.push(
        buildFinding({
          id: `${C6_DETECTOR_ID}:${node.id}:default-opener`,
          detectorId: C6_DETECTOR_ID,
          findingClass: 'C6-credential-unbounded-sink',
          severity: 'high',
          confidence: 'high',
          title:
            'The header-preserving default opener is installed process-wide — site N+1 inherits ' +
            'the defect on creation',
          nodeIds: [node.id],
          query: 'credential-egress where defaultOpenerInstalledProcessWide',
          facts: [
            'Fixing the named call sites and leaving the default installed closes the instances ' +
              'and leaves the class open.',
            'This finding is emitted independently of whether any individual call site is ' +
              'currently clean, because a corpus where every site is fixed is exactly the state ' +
              'in which a per-site audit reports success.',
          ],
          remediationSummary:
            'Install an opener whose handler set is restricted to https and which strips ' +
            'Authorization on a host change, so a newly written call site is safe by default. ' +
            'DRAFT ONLY.',
        }),
      );
    }

    // Appended ONLY after this node was actually evaluated — see c1 for why.
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C6_DETECTOR_ID,
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population);
}

export const c6Spec: SecurityDetectorSpec = {
  id: C6_DETECTOR_ID,
  taxonomyClass: 'C6',
  title: 'Credential forwarded to an unbounded, runtime-chosen sink',
  run: detectCredentialUnboundedSink,
};

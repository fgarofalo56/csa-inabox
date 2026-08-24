/**
 * LOOM BRAIN — SECURITY SUBSTRATE (LOCAL SHIM).
 *
 * ── WHY THIS FILE EXISTS, AND WHAT MUST HAPPEN TO IT ──────────────────────
 *
 * `PRPs/active/loom-brain/PRP.md` §3.1 places the graph substrate at
 * `lib/brain/types.ts` + `lib/brain/graph/**`, built by a sibling workflow, and
 * this lane was told to IMPORT those types rather than redefine them.
 *
 * MEASURED 2026-08-23, before a line of this was written:
 *
 *     ls apps/fiab-console/lib/brain            -> No such file or directory
 *     git ls-remote --heads origin | grep brain -> prp/loom-brain-register only
 *     gh pr list --state open | grep -i brain   -> #3938 (PRP), #3939 (taxonomy)
 *
 * There is no substrate branch, no substrate PR, and no `lib/brain/` directory
 * anywhere on `origin`. So there is nothing to import. The honest options were
 * (a) block, or (b) declare the shapes locally, INSIDE this lane's own directory
 * so no sibling file is trespassed on, and mark the gap loudly. This is (b).
 *
 * **THIS FILE IS A GAP, NOT A DESIGN.** When `lib/brain/types.ts` lands:
 *
 *   1. delete the `Provenance` / `SecurityNode` / `SecurityEdge` / `SecurityGraph`
 *      / `Finding` / `Evidence` / `DraftedRemediation` declarations below;
 *   2. re-export the substrate's equivalents from here so the detectors and their
 *      specs keep compiling unchanged;
 *   3. keep `Population`, `DetectorResult` and `detectorResult()` — those are
 *      this lane's contribution and are argued for in `./population.ts`.
 *
 * The shapes below are deliberately structural (no classes, no nullable-by-
 * omission fields) so that step 2 is an assignability check the compiler can
 * decide, not a hand-audit.
 *
 * ── WHAT THE SUBSTRATE MUST CARRY THAT A CALL GRAPH DOES NOT ──────────────
 *
 * `docs/fiab/brain/security-taxonomy.md` §11.6 is the load-bearing constraint
 * and it is not satisfied by nodes + call edges. Security detection needs three
 * things the waste query does not, and each is why a facet below exists:
 *
 *   1. DATA-FLOW, so a CONSUMED verdict is distinguishable from a CALL. C3 is
 *      the measured proof: on 2026-08-07 `if (gate) return gate;` was deleted
 *      from a subscription-scoped ARM deploy route, leaving the
 *      `enforceCapability` call in place. The import edge survived, the call
 *      edge survived, the guard's whole correct implementation survived — and
 *      three merge-blocking controls printed green over fully defeated
 *      authorization. A graph whose edges are calls or imports is blind to that
 *      class BY CONSTRUCTION. -> `VerdictCallFacet.pathsConsumingAsRefusal`.
 *   2. PER-NODE VERDICT TOTALITY, so an edge that answers ALLOW on failure is a
 *      finding. #3834: `graphUserInGroup` fails OPEN in 2 of 9 measured Graph
 *      failure modes. The edge is present, on-path and consumed; no reachability
 *      query over any edge set detects it. -> `VerdictTotalityFacet.failureModes`.
 *   3. CROSS-NODE DIFFERENTIAL SEMANTICS, so N implementations of one predicate
 *      can be compared. 11 tenant comparisons across 3 files, all pinned, all
 *      on-path; the reachability query returns clean and is RIGHT to. The defect
 *      is that two of them disagree. -> `PredicateImplFacet.truthTable`.
 *
 * And one thing no query provides at all: AN ASSERTED POPULATION. That lives in
 * `./population.ts` and is the reason `DetectorResult` is not `Finding[]`.
 *
 * ── RECOMMEND-ONLY IS A TYPE PROPERTY HERE, NOT A CONVENTION ──────────────
 *
 * PRP §1 decision 1: the Brain inventories, scores, ranks and drafts. It does
 * not mutate. A drafted remediation is DATA — a string, a command to SHOW, a
 * patch to PROPOSE. `DraftedRemediation` therefore declares no callable member,
 * and `assertInertRemediation()` rejects one at runtime, because a type-only
 * guarantee is erased at the boundary where a finding is serialised into a
 * queue, a Cosmos document or an agent prompt. See `./recommend-only.ts`.
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a fact came from. PRP §3.1 lists these for the waste query; the working
 * definitions below are the taxonomy's (§0.1), which sharpened two of them:
 *
 * - `imports` is EXPLICITLY NOT a call. That distinction is the whole of C3.
 * - `owns` is a tenancy/partition relation and is genuinely subtle in this
 *   codebase: `Workspace.tenantId` holds the CREATOR's Entra oid and is the
 *   Cosmos partition key, while `wsDoc.tid` holds the owning Entra tenant.
 *   `assertOwner` was deleted (#2947) precisely because a point-read on
 *   `workspacesContainer().item(id, oid)` can only answer "did this caller
 *   CREATE this", never "may this caller ACCESS it".
 */
export type Provenance =
  /** Asserted in source: a route exists, a function is exported, a guard is named. */
  | 'declared'
  /** Set by deploy/env/bicep: `LOOM_*`, allowlist entries, gate-registry rows. */
  | 'configured'
  /** A static module edge. NOT a call. */
  | 'imports'
  /** Established at runtime or by executing an analyzer: a guard run, a probe, an E2E. */
  | 'observed'
  /** A tenancy/partition relation. */
  | 'owns';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type SecurityNodeKind =
  | 'authorizer'
  | 'scoped-handler'
  | 'verdict-call'
  | 'publication'
  | 'verdict-totality'
  | 'credential-egress'
  | 'principal'
  | 'emitted-command'
  | 'predicate-impl';

/**
 * A privileged sink, named rather than inferred.
 *
 * The taxonomy is explicit that this must be maintained EXPLICITLY and not
 * derived (§4.5, negative control): distinguishing "a route that legitimately
 * needs no per-resource authorization" from C3 requires knowing the sink is not
 * privileged, and that is a `declared` property of the sink. A detector that
 * guesses will either flag every static catalogue read or miss every ARM deploy.
 */
export type PrivilegedSinkKind =
  | 'adls-posix-acl'
  | 'cosmos-write'
  | 'cosmos-cross-partition-read'
  | 'arm-deploy'
  | 'delete-cascade'
  | 'role-assignment'
  | 'secret-read'
  | 'none';

/** ── C1 facet — the unauthorized inbound edge (admin-bypass family). ────── */

/**
 * One ALLOW return, with everything needed to decide whether it is authorized.
 *
 * `mentionsVerdict` and `impliedByOwnsVerdict` are SEPARATE fields on purpose,
 * and that separation is measured rather than defensive: the round-2 fix for the
 * 2026-08-21 lakehouse bypass was itself defeated by
 *
 *     if (!denied || opts.itemType === 'lakehouse') return null;
 *
 * which MENTIONS the delegated verdict and discards it. Mentioning a verdict is
 * not reading it, so a detector keyed to `mentionsVerdict` passes that line.
 */
export interface AllowPath {
  readonly id: string;
  /** Predicates named on the path CONDITION reaching this ALLOW. */
  readonly conditionPredicates: readonly string[];
  /**
   * Literal narrowing on the path condition — THE NARROW BYPASS.
   * e.g. `["opts.itemType === 'lakehouse'"]`. Presence here must never exempt
   * and must never reduce severity; it is recorded only so the evidence can say
   * so out loud.
   */
  readonly scopeLiterals: readonly string[];
  /** Does the path condition merely MENTION a delegated verdict? */
  readonly mentionsVerdict: boolean;
  /** Is this ALLOW BOOLEAN-IMPLIED BY a verdict obtained from the `owns` resolver? */
  readonly impliedByOwnsVerdict: boolean;
  /** Which canonical resolver the implication was proved against, if any. */
  readonly ownsResolver: string | null;
}

export interface AuthorizerFacet {
  readonly kind: 'authorizer';
  readonly fnName: string;
  /**
   * Parameter names. Recorded for EVIDENCE ONLY.
   *
   * `scripts/ci/check-tid-boundary-chokepoint.mjs:2662` filters its judged
   * population with `/\bworkspace(Id|_id)?\b/i` over exactly this string, and
   * measured live on 2026-08-23 that took it from 15 candidates to 1 judged,
   * RC=0, with a live shape-1 defect in the tree. `c1` therefore MUST NOT read
   * this field in any predicate. `c1.population.test.ts` asserts that.
   */
  readonly params: readonly string[];
  /**
   * Does this decision govern a SPECIFIC resource named by caller input?
   *
   * This is the field that separates a detector from a grep. `requireTenantAdmin`
   * (`lib/auth/feature-gate.ts:157`) is BYTE-IDENTICAL in shape to the defect —
   * `if (isTenantAdmin(session)) return null;` — and is correct, because its
   * contract is "is this caller a tenant admin at all": an org-wide gate over no
   * resource. `resourceScoped: false` is what makes it a clean negative control.
   */
  readonly resourceScoped: boolean;
  readonly callerNamedResourceInputs: readonly string[];
  readonly allowPaths: readonly AllowPath[];
  readonly reachesPrivilegedSink: boolean;
  readonly privilegedSinkKinds: readonly PrivilegedSinkKind[];
}

/** ── C2 facet — the aggregate oracle. ───────────────────────────────────── */

/**
 * Anything a response reveals that was DERIVED from a caller-scoped query.
 *
 * `shape` and `channel` are both enumerated wide because the taxonomy's §3.4
 * bypasses are all "the leak is not a count in a body": a boolean is a count
 * truncated to one bit; `nextCursor` present-or-absent is an existence oracle
 * with no number in it at all; a header or a step summary is not the body.
 * No predicate in `c2` may key on either field — they exist for evidence and
 * severity only. The predicate keys on `derivedFromScopedQuery`.
 */
export interface Disclosure {
  readonly field: string;
  readonly channel: 'body' | 'header' | 'step-summary' | 'telemetry' | 'status-code' | 'timing';
  readonly shape: 'count' | 'boolean' | 'cursor-presence' | 'duration' | 'identifier' | 'enum';
  readonly derivedFromScopedQuery: boolean;
}

export interface ScopedHandlerFacet {
  readonly kind: 'scoped-handler';
  readonly handler: string;
  /** Scope-narrowing parameters the CALLER supplies (`workspaceId`, `[id]`, `itemType`). */
  readonly callerSuppliedScopeParams: readonly string[];
  /** Was the scope resolved against `owns` BEFORE it reached the data plane? */
  readonly scopeResolvedBeforeQuery: boolean;
  /**
   * The denial shape. `lib/api/route-toolkit.ts:113` is the repo's stated answer:
   * "the same 404-not-403 behaviour the hand-rolled routes use so an id can't be
   * probed for existence across tenants."
   */
  readonly denialShape: 'not-found' | 'forbidden' | 'none';
  readonly identifiersRedacted: boolean;
  readonly disclosures: readonly Disclosure[];
}

/** ── C3 facet — the discarded verdict. ──────────────────────────────────── */

export interface VerdictCallFacet {
  readonly kind: 'verdict-call';
  readonly callSite: string;
  /** One of the seven `NextResponse | null` guards, or another verdict symbol. */
  readonly symbol: string;
  readonly returnsVerdictUnion: boolean;
  /** Control-flow paths from this call to a privileged sink. */
  readonly pathsToPrivilegedSink: number;
  /** How many of those paths CONSUME the verdict as a refusal. */
  readonly pathsConsumingAsRefusal: number;
  readonly consumption: 'returned' | 'thrown' | 'logged' | 'ignored' | 'attribution-only';
  /**
   * The route sits in an authorization allowlist.
   *
   * THIS IS NEVER A POPULATION FILTER. Quoting `check-route-guards.mjs:29-31`
   * verbatim, because it is the non-obvious part of the design: "this route
   * needs no per-resource authorization" never licenses "call a gate and throw
   * its answer away". `c3` runs over allowlisted routes too.
   */
  readonly allowlisted: boolean;
  /** #3607: `ALLOWLIST_PREFIXES` premises are load-bearing for 12 routes and untested. */
  readonly allowlistPremiseTested: boolean;
  readonly sinkPrivileged: boolean;
  readonly sinkKind: PrivilegedSinkKind;
}

/** ── C4 facet — the unbounded publication edge. ─────────────────────────── */

export type PublicationSurface =
  | 'stdout'
  | 'stderr'
  | 'console'
  | 'annotation'
  | 'issue-body'
  | 'issue-title'
  | 'artifact'
  | 'step-summary'
  | 'github-output'
  | 'github-env'
  | 'inherited-fd';

/**
 * How the sink is REACHED in source.
 *
 * #3876 measured four bypasses of the checker PR #3835 added; three of them
 * drive the enumerated write count to ZERO by aliasing (`const out =
 * process.stdout`), destructuring (`const { stdout } = process`) or bracket
 * access (`process['stdout']`). A detector whose population can be driven to
 * zero by renaming is not a detector, so `accessPath` is enumerated and
 * `c4.population.test.ts` asserts every value is judged.
 */
export type PublicationAccessPath = 'member' | 'alias' | 'destructured' | 'bracket' | 'spawn-stdio';

export interface PublicationSink {
  readonly id: string;
  readonly surface: PublicationSurface;
  readonly accessPath: PublicationAccessPath;
  /**
   * The WHOLE emitted expression passes a boundary — not a prefix.
   *
   * #3876 bypass 1: the classifier was `w.arg.startsWith(`${fn}(`)`, so
   * `process.stdout.write(formatStdout(a) + raw)` passed because the argument
   * STARTS WITH an allowed boundary call while `raw` is never examined.
   */
  readonly wholeExpressionBounded: boolean;
  readonly boundary: string | null;
  /** The disclosed, deliberate exception. */
  readonly unredactedByDesign: boolean;
  readonly carriesSensitive: boolean;
  /**
   * For `inherited-fd` only: is the CHILD proven to redact?
   *
   * `scripts/ci/deploy-retry.mjs:800` is `stdio: ['inherit','inherit','pipe']`.
   * That hands the child the parent's stdout fd, so the child's bytes reach the
   * public Actions run log with NO `write` call anywhere in the parent's source.
   * Every assertion of the shape "grep for `process.stdout.write` and prove each
   * one goes through the boundary" is STRUCTURALLY BLIND to it. `null` for the
   * non-spawn surfaces.
   */
  readonly childProvenRedacting: boolean | null;
}

export interface PublicationFacet {
  readonly kind: 'publication';
  readonly module: string;
  /**
   * What the module ASSERTS its sink count is.
   *
   * Taxonomy §5.4: "COUNT the enumerated sinks and assert the count, so a new one
   * cannot appear silently." A mismatch against `sinks.length` is itself a
   * finding — see `c4`.
   */
  readonly declaredSinkCount: number;
  readonly sinks: readonly PublicationSink[];
}

/** ── C5 facet — verdict totality (fail-open). ───────────────────────────── */

export interface FailureMode {
  readonly name: string;
  readonly verdict: 'allow' | 'deny' | 'unknown';
}

export interface VerdictTotalityFacet {
  readonly kind: 'verdict-totality';
  readonly subject: string;
  /**
   * Every enumerated failure mode and what it answers.
   *
   * #3834's title is precise: fail-OPEN in 2 of 9 measured Graph failure modes.
   * The other 7 answer `'unknown'` and refuse correctly. So the class is NOT
   * "this code fails open" — it is "this code's UNKNOWN handling is non-uniform
   * across 9 paths and 2 of them invert". A detector that samples ONE failure
   * path passes; `c5` is per-mode for exactly that reason.
   */
  readonly failureModes: readonly FailureMode[];
  /** How the CALLER maps a distinguished UNKNOWN. */
  readonly unknownMapsTo: 'deny' | 'allow' | 'unmodelled';
  /** Is the "there is nothing here" render still reachable with the read's error state set? */
  readonly emptyStateReachableOnReadError: boolean;
  /**
   * ── POPULATION MEMBERSHIP IS INDEPENDENT OF THE FIX. ───────────────────
   *
   * Quoted from `scripts/ci/check-empty-claim-read-evidence.mjs:36-38`, and it
   * is the single most transferable idea in this repo's guard corpus. A token
   * rule keyed to the UNSAFE pattern goes quiet on exactly the files that adopt
   * the fix: adoption removes the file from the population, so coverage and
   * compliance become indistinguishable, and a file that NEVER had the pattern
   * scores identical to one that fixed it.
   *
   * Membership here is `performsRead && rendersEmptyStateClaim`. Adopting the
   * fix removes NEITHER. `adoptedFix` exists so a spec can prove a fixed
   * component STAYS in the judged population — never so a predicate can skip it.
   */
  readonly performsRead: boolean;
  readonly rendersEmptyStateClaim: boolean;
  readonly adoptedFix: boolean;
}

/** ── C6 facet — a credential forwarded to an unbounded sink. ────────────── */

export interface CredentialEgressFacet {
  readonly kind: 'credential-egress';
  readonly callSite: string;
  /** e.g. `['authorization']`, or `['authorization', 'cookie:loom_session']`. */
  readonly attachedCredentials: readonly string[];
  readonly redirectPolicy: 'follow' | 'none' | 'same-origin-only';
  readonly opener: 'language-default' | 'restricted' | 'custom';
  /**
   * Does the client strip the credential on a HOST change — not merely a scheme
   * change? `urllib` does not; `requests` does. This is the field the predicate
   * turns on, and `schemeAllowlist` deliberately is not.
   */
  readonly stripsCredentialOnHostChange: boolean;
  /**
   * A scheme allowlist, if one was applied.
   *
   * #3717's FIRST fix addressed `ftp:` only, and a plain `http:` cross-host
   * redirect walks straight through it. A detector keyed to a scheme allowlist
   * rather than to ORIGIN COMPARISON is defeated by one character's difference.
   */
  readonly schemeAllowlist: readonly string[] | null;
  /** Module-level: the header-preserving default opener is installed process-wide. */
  readonly defaultOpenerInstalledProcessWide: boolean;
}

/** ── C7 facet — the synthesized principal. ──────────────────────────────── */

export interface PrincipalSource {
  readonly origin: 'live-token' | 'literal' | 'env' | 'default' | 'cached-artifact';
  /**
   * `'presence'` is the measured bypass, not a lesser grade of `'value'`.
   * `.github/workflows/perf-gate.yml:135` guards with `[[ -z "${VAR:-}" ]]`,
   * which catches ABSENCE ONLY — an explicitly-set all-zeros value passes.
   */
  readonly validation: 'value' | 'presence' | 'none';
  /**
   * Does this path reach the sink WITHOUT calling the guarded minter?
   * `tests/e2e/_shared.ts:80-85` prefers a cached storage artifact and returns
   * without ever calling `mintSessionCookie()`, so a cookie minted under the
   * zero GUID BEFORE the fix is still loaded AFTER it.
   */
  readonly bypassesMinter: boolean;
}

export interface PrincipalFacet {
  readonly kind: 'principal';
  readonly sink: string;
  /**
   * In this codebase the caller's `oid` is a COSMOS PARTITION KEY — a
   * tenant/resource boundary. A placeholder oid does not merely mis-attribute;
   * it creates a SHADOW TENANT (#3818). #3804: eight UAT harnesses minted a live
   * session as an all-zeros principal and orphaned 24 workspaces.
   */
  readonly reachesPartitionKeyOrTenantScope: boolean;
  readonly sources: readonly PrincipalSource[];
  /** #3818: the placeholder-oid check exists in EIGHT independent copies... */
  readonly checkCopies: number;
  /** ...and exactly ONE is under test. Seven untested copies is the actual defect. */
  readonly checkCopiesUnderTest: number;
}

/** ── C8 facet — injection into a human-executed command. ────────────────── */

export interface CommandInterpolation {
  readonly name: string;
  readonly source: 'caller-supplied' | 'static' | 'server-derived';
  readonly escaped: boolean;
  readonly allowlisted: boolean;
  /** e.g. `'guid'`, `'hostname'`; `null` when the value is never validated. */
  readonly validatedAs: string | null;
}

export interface EmittedCommandFacet {
  readonly kind: 'emitted-command';
  readonly route: string;
  readonly field: string;
  /**
   * The sink is the OPERATOR'S TERMINAL. The route does not execute the string,
   * which is exactly what makes this a distinct class: standard taint analysis
   * terminates at "no `exec` on this path" and reports clean, while the
   * privileged execution happens off-graph, performed by a human who has every
   * reason to trust the product's own output.
   */
  readonly contentShape: 'shell-command' | 'connection-string' | 'remediation' | 'other';
  readonly interpolations: readonly CommandInterpolation[];
  /** How many command-shaped emitters exist across this module family. */
  readonly siblingEmitters: number;
  /** How many of them the allowlist/escaping actually covers. */
  readonly siblingEmittersCovered: number;
}

/** ── C9 facet — the duplicated decision. ────────────────────────────────── */

/**
 * The truth table rows over `{callerTid present/absent} x {docTid present/absent}
 * x {equal/unequal}`. Equality is only meaningful when both are present, so five
 * rows exhaust the space.
 *
 * `caller-absent` is the row that matters most and it is why the repair in
 * `bfd67ed1` (#3859) was necessary: `if (callerTid && wsDoc.tid && wsDoc.tid !==
 * callerTid) return null;` is a NON-CONTRADICTION test — a session with no `tid`
 * short-circuits and PASSES. An edge that fails to fire on missing data is not
 * an edge.
 */
export type TruthRow =
  | 'caller-absent'
  | 'doc-absent'
  | 'both-absent'
  | 'both-present-equal'
  | 'both-present-unequal';

export const TRUTH_ROWS: readonly TruthRow[] = [
  'caller-absent',
  'doc-absent',
  'both-absent',
  'both-present-equal',
  'both-present-unequal',
] as const;

export interface PredicateImplFacet {
  readonly kind: 'predicate-impl';
  /** The `owns` relation compared, e.g. `'workspace.tid ~ caller.tid'`. */
  readonly clusterKey: string;
  readonly implId: string;
  readonly canonical: boolean;
  readonly truthTable: Readonly<Record<TruthRow, 'allow' | 'deny'>>;
  /**
   * HOW the compared value was obtained. #3843's shape is a member whose truth
   * table matches canonical exactly while the tid it reads is DERIVED
   * DIFFERENTLY — the comparison is right and the input is not.
   */
  readonly inputsDerivedFrom: string;
}

export type NodeFacet =
  | AuthorizerFacet
  | ScopedHandlerFacet
  | VerdictCallFacet
  | PublicationFacet
  | VerdictTotalityFacet
  | CredentialEgressFacet
  | PrincipalFacet
  | EmittedCommandFacet
  | PredicateImplFacet;

export interface SecurityNode {
  readonly id: string;
  readonly kind: SecurityNodeKind;
  readonly provenance: Provenance;
  /** Human-readable, and SAFE TO PUBLISH — this repo is public. No estate ids. */
  readonly label: string;
  readonly facet: NodeFacet;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export type SecurityEdgeKind =
  | 'calls'
  | 'imports'
  | 'reads'
  | 'writes'
  | 'authorizes'
  | 'publishes'
  | 'egresses'
  | 'scopes'
  | 'owns';

export interface SecurityEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: SecurityEdgeKind;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/**
 * Declarations the graph carries that no traversal can derive.
 *
 * C9 cannot be decided without an EXPECTED cluster size: eleven implementations
 * of one predicate is not by itself a finding, and twelve is only a finding
 * because someone declared eleven. `check-tid-boundary-chokepoint.mjs` section 9
 * is the cheap form of this, and its own comment says why it exists: "every
 * finding of the round-5 review showed up first as that list quietly getting
 * shorter while the guard printed OK."
 */
export interface SecurityAnnotations {
  /** clusterKey -> the number of implementations the repo declares it has. */
  readonly expectedPredicateClusterSize: Readonly<Record<string, number>>;
}

export interface SecurityGraph {
  readonly nodes: readonly SecurityNode[];
  readonly edges: readonly SecurityEdge[];
  readonly annotations: SecurityAnnotations;
  /**
   * How this graph was produced. `'modelled'` means hand-authored from the
   * taxonomy's described shapes — which is what every fixture in this lane is,
   * because no extractor exists yet. A consumer that treats a `'modelled'` graph
   * as an estate measurement is making the exact error `deploy-integrity.md` R7
   * forbids, so the provenance is on the graph and not in a comment.
   */
  readonly source: 'modelled' | 'extracted' | 'observed';
}

// ---------------------------------------------------------------------------
// Findings — ONE model, two predicates (waste and security)
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'high' | 'medium' | 'low';

/** Taxonomy class ids, plus the population classes this lane adds. */
export type FindingClass =
  | 'C1-unauthorized-inbound-edge'
  | 'C2-aggregate-oracle'
  | 'C3-discarded-verdict'
  | 'C4-unbounded-publication'
  | 'C5-fail-open'
  | 'C6-credential-unbounded-sink'
  | 'C7-synthesized-principal'
  | 'C8-human-executed-command'
  | 'C9-duplicated-decision'
  /** The detector's own population shrank, or was never non-empty. */
  | 'POP-population-integrity';

export interface Evidence {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  /** The query, in words, that produced this finding. Explainable by construction. */
  readonly query: string;
  /** Free-form measured facts. Strings only — never a live handle. */
  readonly facts: readonly string[];
}

/**
 * A DRAFTED remediation. DATA ONLY.
 *
 * PRP §1 decision 1 and taxonomy §3.7: the Brain reports and drafts; it never
 * patches an authorization path on its own, because a wrong autonomous "fix" to
 * authz is worse than the gap. Note there is no `apply`, no `execute`, no
 * `handler` — and `assertInertRemediation()` in `./recommend-only.ts` enforces
 * that at runtime, since the type is erased the moment a finding is serialised.
 */
export interface DraftedRemediation {
  readonly summary: string;
  /** Commands to SHOW an operator. Never executed by anything in `lib/brain/security`. */
  readonly proposedCommands: readonly string[];
  readonly proposedPatchDescription: string | null;
  readonly requiresHumanApproval: true;
}

export interface Finding {
  readonly id: string;
  readonly detectorId: string;
  readonly findingClass: FindingClass;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly title: string;
  readonly evidence: Evidence;
  readonly remediation: DraftedRemediation;
}

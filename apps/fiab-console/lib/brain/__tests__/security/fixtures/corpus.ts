/**
 * THE FIXTURE CORPUS — a modelled graph, and the subject of the mutation arms.
 *
 * ── WHY THESE FIXTURES ARE SYNTHETIC, DELIBERATELY ───────────────────────
 *
 * Every shape below is taken from `docs/fiab/brain/security-taxonomy.md`, which
 * measured them against real defects. NONE of them references a live repo file.
 * That is a decision, not laziness, and the taxonomy itself states the reason at
 * §5.6 under "Anti-fixture, stated because this repo tripped on it":
 *
 *   "do NOT key a non-degeneracy control to the leaked value itself. A test
 *    asserting 'the raw stderr MUST still carry the id, or this test proves
 *    nothing' turns CLOSING THE LEAK into a test failure."
 *
 * The same trap applies one level up. A positive fixture pointed at
 * `security-roles/route.ts:85` (#3855, OPEN) would go GREEN — and therefore RED
 * in the suite — the day someone fixes it. A regression corpus that punishes the
 * fix is worse than no corpus. So the corpus models the SHAPES and asserts
 * nothing about the current tree.
 *
 * PUBLIC REPO. No estate identifiers, no tenant ids, no GUIDs that could be real,
 * no resource names. The C4 sensitive-payload marker is the literal string
 * `FIXTURE-TOKEN-A`, which is a non-secret token chosen precisely so a
 * non-degeneracy control can key to it without keying to a secret.
 *
 * ── HOW THE MUTATION ARMS USE THIS FILE ──────────────────────────────────
 *
 * `mutation/mutations.mjs` performs SINGLE-LINE textual substitutions here. Every
 * needle is marked with a `// MUT-<CLASS>-<ARM>` comment and CONTAINS NO NEWLINE.
 *
 * That is a defence against a measured landmine: this repo's TypeScript is 100%
 * CRLF (measured — `lib/auth/workspace-guard.ts` is CRLF=531, bareLF=0), and a
 * needle written with an LF newline matches ZERO times while reading exactly like
 * a passing test. A newline-free needle cannot express a line ending, so the
 * whole class is unreachable. The harness additionally asserts each needle
 * matched EXACTLY ONCE and aborts otherwise.
 *
 * ── THE BASELINE MUST BE COMPLETE, NOT MERELY CLEAN ──────────────────────
 *
 * `cleanBaseline()` carries at least one node of EVERY node kind. If it did not,
 * the detectors for the missing kinds would emit `POP-population-integrity`
 * (candidates === 0) — which is the point of that finding, and it means a
 * baseline that quietly stopped covering a class fails loudly instead of
 * shrinking in silence.
 */

import type {
  AllowPath,
  Disclosure,
  FailureMode,
  PredicateImplFacet,
  PublicationSink,
  SecurityGraph,
  SecurityNode,
  TruthRow,
} from '@/lib/brain/security/substrate';

export const CANONICAL_RESOLVER = 'resolveWorkspaceAccessByOid';
export const LAKEHOUSE_SCOPE = "opts.itemType === 'lakehouse'";

// ---------------------------------------------------------------------------
// C1 building blocks
// ---------------------------------------------------------------------------

/** The correct shape: the ALLOW is boolean-implied by a delegated owns-verdict. */
export const AP_CLEAN_DELEGATION: AllowPath = {
  id: 'ap-clean-delegation',
  conditionPredicates: ['isTenantAdmin'],
  scopeLiterals: [],
  mentionsVerdict: true,
  impliedByOwnsVerdict: true,
  ownsResolver: CANONICAL_RESOLVER,
};

/** Shape 1: `if (isTenantAdmin(session)) return null;` before any read. */
export const AP_ADMIN_SHORT_CIRCUIT: AllowPath = {
  id: 'ap-admin-short-circuit',
  conditionPredicates: ['isTenantAdmin'],
  scopeLiterals: [],
  mentionsVerdict: false,
  impliedByOwnsVerdict: false,
  ownsResolver: null,
};

/**
 * The NARROW bypass, measured 2026-08-21: one line scoped to a single item type,
 * which passed guard exit 0, a 27-test spec AND a 259-test suite while granting a
 * live cross-tenant ALLOW.
 */
export const AP_LAKEHOUSE_SCOPED_BYPASS: AllowPath = {
  id: 'ap-lakehouse-scoped-bypass',
  conditionPredicates: ['isTenantAdmin'],
  scopeLiterals: [LAKEHOUSE_SCOPE],
  mentionsVerdict: false,
  impliedByOwnsVerdict: false,
  ownsResolver: null,
};

/**
 * The round-2 DEFEATED FIX: `if (!denied || opts.itemType === 'lakehouse') return null;`
 * — it MENTIONS the delegated verdict and discards it.
 */
export const AP_MENTIONS_BUT_DISCARDS: AllowPath = {
  id: 'ap-mentions-but-discards',
  conditionPredicates: ['isTenantAdmin'],
  scopeLiterals: [LAKEHOUSE_SCOPE],
  mentionsVerdict: true,
  impliedByOwnsVerdict: false,
  ownsResolver: null,
};

/**
 * POSITIVE — the §2.4(c) case: an authorizer whose parameters carry no
 * `workspace`-shaped name, which is what removes it from
 * `check-tid-boundary-chokepoint.mjs`'s judged population at `:2662`.
 */
export function c1PositiveItemScoped(id = 'fx:c1:item-scoped-authorizer'): SecurityNode {
  return {
    id,
    kind: 'authorizer',
    provenance: 'declared',
    label: 'route authorizer taking (session, itemId, itemType)',
    facet: {
      kind: 'authorizer',
      fnName: 'authorizeSecurityRoles',
      params: ['session', 'itemId', 'itemType'],
      resourceScoped: true,
      callerNamedResourceInputs: ['itemId'],
      allowPaths: [AP_ADMIN_SHORT_CIRCUIT],
      reachesPrivilegedSink: true,
      privilegedSinkKinds: ['adls-posix-acl'],
    },
  };
}

/** POSITIVE (narrow) — the same authorizer with the bypass scoped to one item type. */
export function c1PositiveNarrow(id = 'fx:c1:narrow-scoped-authorizer'): SecurityNode {
  return {
    id,
    kind: 'authorizer',
    provenance: 'declared',
    label: 'authorizer with a correct delegation AND one item-type-scoped bypass',
    facet: {
      kind: 'authorizer',
      fnName: 'authorizeItemWorkspace',
      params: ['session', 'opts'],
      resourceScoped: true,
      callerNamedResourceInputs: ['opts.itemId'],
      allowPaths: [AP_CLEAN_DELEGATION, AP_LAKEHOUSE_SCOPED_BYPASS],
      reachesPrivilegedSink: true,
      privilegedSinkKinds: ['cosmos-write'],
    },
  };
}

/**
 * NEGATIVE CONTROL — `requireTenantAdmin`. BYTE-IDENTICAL in shape to the defect
 * and CORRECT: an org-wide gate over no resource. Any detector that flags this is
 * keyed to a spelling rather than to an unauthorized resource edge.
 */
export function c1NegativeOrgWideGate(id = 'fx:c1:org-wide-gate'): SecurityNode {
  return {
    id,
    kind: 'authorizer',
    provenance: 'declared',
    label: 'requireTenantAdmin — org-wide admin gate over no resource',
    facet: {
      kind: 'authorizer',
      fnName: 'requireTenantAdmin',
      params: ['session'],
      resourceScoped: false,
      callerNamedResourceInputs: [],
      allowPaths: [AP_ADMIN_SHORT_CIRCUIT],
      reachesPrivilegedSink: false,
      privilegedSinkKinds: ['none'],
    },
  };
}

/**
 * NEGATIVE CONTROL — an unfiltered cross-partition read whose result NEVER
 * becomes an authorization decision. Shape-matching flags it; edge semantics
 * does not.
 */
export function c1NegativeMappingLookup(id = 'fx:c1:mapping-lookup'): SecurityNode {
  return {
    id,
    kind: 'authorizer',
    provenance: 'declared',
    label: 'admin-triggered lookup returning an id mapping — decides nothing',
    facet: {
      kind: 'authorizer',
      fnName: 'lookupWorkspaceMapping',
      params: ['session', 'workspaceId'],
      resourceScoped: true,
      callerNamedResourceInputs: ['workspaceId'],
      allowPaths: [AP_ADMIN_SHORT_CIRCUIT],
      reachesPrivilegedSink: false,
      privilegedSinkKinds: ['none'],
    },
  };
}

// ---------------------------------------------------------------------------
// C2 building blocks
// ---------------------------------------------------------------------------

export const DISCLOSURE_COUNT: Disclosure = {
  field: 'excludedByAccess',
  channel: 'body',
  shape: 'count',
  derivedFromScopedQuery: true,
};

/** The bit-truncated bypass — a count reduced to one bit is still an oracle. */
export const DISCLOSURE_BOOLEAN: Disclosure = {
  field: 'anyExcluded',
  channel: 'body',
  shape: 'boolean',
  derivedFromScopedQuery: true,
};

/** The channel bypass — the number never enters the response body. */
export const DISCLOSURE_HEADER: Disclosure = {
  field: 'x-excluded-total',
  channel: 'header',
  shape: 'count',
  derivedFromScopedQuery: true,
};

/** The no-number-at-all bypass — pagination presence is an existence oracle. */
export const DISCLOSURE_CURSOR: Disclosure = {
  field: 'nextCursor',
  channel: 'body',
  shape: 'cursor-presence',
  derivedFromScopedQuery: true,
};

export function c2Positive(
  id: string,
  disclosures: readonly Disclosure[],
  handler = 'sweepBindings',
): SecurityNode {
  return {
    id,
    kind: 'scoped-handler',
    provenance: 'declared',
    label: `${handler} — caller-chosen scope reaching the data plane unresolved`,
    facet: {
      kind: 'scoped-handler',
      handler,
      callerSuppliedScopeParams: ['workspaceId', 'itemType'],
      scopeResolvedBeforeQuery: false,
      denialShape: 'none',
      identifiersRedacted: true,
      disclosures,
    },
  };
}

/**
 * NEGATIVE CONTROL — the SAME handler returning the SAME count, with the scope
 * resolved through the owns resolver and a 404-not-403 denial BEFORE the query.
 * The caller can only narrow to scopes they already own, so the count is theirs.
 */
export function c2NegativeResolvedScope(id = 'fx:c2:resolved-scope'): SecurityNode {
  return {
    id,
    kind: 'scoped-handler',
    provenance: 'declared',
    label: 'sweepBindings with the scope resolved before the query',
    facet: {
      kind: 'scoped-handler',
      handler: 'sweepBindingsResolved',
      callerSuppliedScopeParams: ['workspaceId', 'itemType'],
      scopeResolvedBeforeQuery: true,
      denialShape: 'not-found',
      identifiersRedacted: true,
      disclosures: [DISCLOSURE_COUNT],
    },
  };
}

// ---------------------------------------------------------------------------
// C3 building blocks
// ---------------------------------------------------------------------------

export function c3PositiveDiscarded(id = 'fx:c3:discarded'): SecurityNode {
  return {
    id,
    kind: 'verdict-call',
    provenance: 'declared',
    label: 'ARM deploy route that calls the gate and never returns it',
    facet: {
      kind: 'verdict-call',
      callSite: 'setup/deploy:POST',
      symbol: 'enforceCapability',
      returnsVerdictUnion: true,
      pathsToPrivilegedSink: 1,
      pathsConsumingAsRefusal: 0,
      consumption: 'ignored',
      allowlisted: false,
      allowlistPremiseTested: true,
      sinkPrivileged: true,
      sinkKind: 'arm-deploy',
    },
  };
}

/**
 * POSITIVE (NARROW) — the verdict IS tested and a decision IS taken, on one
 * branch. `if (gate && req.method !== 'GET') return gate;`. A consumption checker
 * that asks "is the value tested?" passes this.
 */
export function c3PositiveMethodScoped(id = 'fx:c3:method-scoped'): SecurityNode {
  return {
    id,
    kind: 'verdict-call',
    provenance: 'declared',
    label: 'gate returned on mutating methods only — GET reaches the sink unrefused',
    facet: {
      kind: 'verdict-call',
      callSite: 'items/[type]/[id]:handler',
      symbol: 'authorizeItemWorkspace',
      returnsVerdictUnion: true,
      pathsToPrivilegedSink: 4,
      pathsConsumingAsRefusal: 3,
      consumption: 'returned',
      allowlisted: false,
      allowlistPremiseTested: true,
      sinkPrivileged: true,
      sinkKind: 'cosmos-write',
    },
  };
}

/** POSITIVE (attribution) — the only guard-shaped signal is a `savedBy:` field. */
export function c3PositiveAttribution(id = 'fx:c3:attribution'): SecurityNode {
  return {
    id,
    kind: 'verdict-call',
    provenance: 'declared',
    label: 'overlay write whose only claims read is an attribution field',
    facet: {
      kind: 'verdict-call',
      callSite: 'items/dashboard/[id]:PUT',
      symbol: 'session.claims.oid',
      returnsVerdictUnion: false,
      pathsToPrivilegedSink: 1,
      pathsConsumingAsRefusal: 0,
      consumption: 'attribution-only',
      allowlisted: false,
      allowlistPremiseTested: true,
      sinkPrivileged: true,
      sinkKind: 'cosmos-write',
    },
  };
}

/**
 * NEGATIVE CONTROL — a route that legitimately needs no per-resource
 * authorization and calls no guard. Distinguishing this from C3 requires the
 * DECLARED `sinkPrivileged: false`, which is why it is a facet field.
 */
export function c3NegativeStaticCatalogue(id = 'fx:c3:static-catalogue'): SecurityNode {
  return {
    id,
    kind: 'verdict-call',
    provenance: 'declared',
    label: 'static capability-catalogue read — no privileged sink',
    facet: {
      kind: 'verdict-call',
      callSite: 'capabilities:GET',
      symbol: 'none',
      returnsVerdictUnion: false,
      pathsToPrivilegedSink: 0,
      pathsConsumingAsRefusal: 0,
      consumption: 'ignored',
      allowlisted: true,
      allowlistPremiseTested: true,
      sinkPrivileged: false,
      sinkKind: 'none',
    },
  };
}

// ---------------------------------------------------------------------------
// C4 building blocks
// ---------------------------------------------------------------------------

export const SINK_BOUNDED: PublicationSink = {
  id: 'sink-bounded',
  surface: 'stdout',
  accessPath: 'member',
  wholeExpressionBounded: true,
  boundary: 'redactAzureIdentifiers',
  unredactedByDesign: false,
  carriesSensitive: true,
  childProvenRedacting: null,
};

export const SINK_BY_DESIGN: PublicationSink = {
  id: 'sink-by-design',
  surface: 'stdout',
  accessPath: 'member',
  wholeExpressionBounded: false,
  boundary: null,
  unredactedByDesign: true,
  carriesSensitive: true,
  childProvenRedacting: null,
};

/** #3876 bypass 1 — the argument STARTS WITH a boundary call and concatenates raw. */
export const SINK_PREFIX_ONLY: PublicationSink = {
  id: 'sink-prefix-only',
  surface: 'stderr',
  accessPath: 'member',
  wholeExpressionBounded: false,
  boundary: 'redactAzureIdentifiers',
  unredactedByDesign: false,
  carriesSensitive: true,
  childProvenRedacting: null,
};

/** #3876 bypass 2 — an alias drives a lexical enumerator's write count to ZERO. */
export const SINK_ALIASED: PublicationSink = {
  id: 'sink-aliased',
  surface: 'stdout',
  accessPath: 'alias',
  wholeExpressionBounded: false,
  boundary: null,
  unredactedByDesign: false,
  carriesSensitive: true,
  childProvenRedacting: null,
};

/** The issue TITLE — built separately from the body and missed by the body fix. */
export const SINK_ISSUE_TITLE: PublicationSink = {
  id: 'sink-issue-title',
  surface: 'issue-title',
  accessPath: 'member',
  wholeExpressionBounded: false,
  boundary: null,
  unredactedByDesign: false,
  carriesSensitive: true,
  childProvenRedacting: null,
};

/** The inherited fd — NO `write()` anywhere in the parent's source. */
export const SINK_INHERITED_FD: PublicationSink = {
  id: 'sink-inherited-fd',
  surface: 'inherited-fd',
  accessPath: 'spawn-stdio',
  wholeExpressionBounded: false,
  boundary: null,
  unredactedByDesign: false,
  carriesSensitive: false,
  childProvenRedacting: null,
};

/** The same spawn, with the child PROVEN to redact. Must not fire. */
export const SINK_INHERITED_FD_SAFE: PublicationSink = {
  id: 'sink-inherited-fd-safe',
  surface: 'inherited-fd',
  accessPath: 'spawn-stdio',
  wholeExpressionBounded: false,
  boundary: null,
  unredactedByDesign: false,
  carriesSensitive: false,
  childProvenRedacting: true,
};

export function c4Node(
  id: string,
  sinks: readonly PublicationSink[],
  moduleName = 'fixture-publisher',
  declaredSinkCount = sinks.length,
): SecurityNode {
  return {
    id,
    kind: 'publication',
    provenance: 'declared',
    label: `${moduleName} — publication surfaces carrying FIXTURE-TOKEN-A`,
    facet: {
      kind: 'publication',
      module: moduleName,
      declaredSinkCount,
      sinks,
    },
  };
}

// ---------------------------------------------------------------------------
// C5 building blocks
// ---------------------------------------------------------------------------

export const MODES_ALL_REFUSING: readonly FailureMode[] = [
  { name: 'network-error', verdict: 'deny' },
  { name: 'http-401', verdict: 'deny' },
  { name: 'http-403', verdict: 'deny' },
  { name: 'malformed-body', verdict: 'unknown' },
];

/**
 * #3834's shape: 7 modes refuse correctly and 2 invert. A detector that samples
 * one failure path, or asserts only "there is a catch", reports this clean.
 */
export const MODES_TWO_OF_NINE_INVERTED: readonly FailureMode[] = [
  { name: 'network-error', verdict: 'deny' },
  { name: 'dns-failure', verdict: 'deny' },
  { name: 'http-401', verdict: 'deny' },
  { name: 'http-403', verdict: 'deny' },
  { name: 'http-500', verdict: 'deny' },
  { name: 'timeout', verdict: 'deny' },
  { name: 'malformed-body', verdict: 'unknown' },
  { name: 'proxy-2xx-interstitial', verdict: 'allow' },
  { name: 'wrong-national-cloud-2xx', verdict: 'allow' },
];

export function c5Node(
  id: string,
  opts: {
    subject: string;
    failureModes: readonly FailureMode[];
    unknownMapsTo: 'deny' | 'allow' | 'unmodelled';
    emptyStateReachableOnReadError: boolean;
    adoptedFix: boolean;
  },
): SecurityNode {
  return {
    id,
    kind: 'verdict-totality',
    provenance: 'declared',
    label: opts.subject,
    facet: {
      kind: 'verdict-totality',
      subject: opts.subject,
      failureModes: opts.failureModes,
      unknownMapsTo: opts.unknownMapsTo,
      emptyStateReachableOnReadError: opts.emptyStateReachableOnReadError,
      // Membership is (performsRead AND rendersEmptyStateClaim) and is INDEPENDENT
      // OF THE FIX — both stay true after adoption, on purpose.
      performsRead: true,
      rendersEmptyStateClaim: true,
      adoptedFix: opts.adoptedFix,
    },
  };
}

// ---------------------------------------------------------------------------
// C6 building blocks
// ---------------------------------------------------------------------------

export function c6Node(
  id: string,
  opts: {
    callSite: string;
    attachedCredentials: readonly string[];
    redirectPolicy: 'follow' | 'none' | 'same-origin-only';
    opener: 'language-default' | 'restricted' | 'custom';
    stripsCredentialOnHostChange: boolean;
    schemeAllowlist: readonly string[] | null;
    defaultOpenerInstalledProcessWide: boolean;
  },
): SecurityNode {
  return {
    id,
    kind: 'credential-egress',
    provenance: 'declared',
    label: opts.callSite,
    facet: { kind: 'credential-egress', ...opts },
  };
}

// ---------------------------------------------------------------------------
// C7 building blocks
// ---------------------------------------------------------------------------

export function c7Node(
  id: string,
  opts: {
    sink: string;
    reachesPartitionKeyOrTenantScope: boolean;
    sources: readonly {
      origin: 'live-token' | 'literal' | 'env' | 'default' | 'cached-artifact';
      validation: 'value' | 'presence' | 'none';
      bypassesMinter: boolean;
    }[];
    checkCopies: number;
    checkCopiesUnderTest: number;
  },
): SecurityNode {
  return {
    id,
    kind: 'principal',
    provenance: 'declared',
    label: opts.sink,
    facet: { kind: 'principal', ...opts },
  };
}

// ---------------------------------------------------------------------------
// C8 building blocks
// ---------------------------------------------------------------------------

export function c8Node(
  id: string,
  opts: {
    route: string;
    field: string;
    contentShape: 'shell-command' | 'connection-string' | 'remediation' | 'other';
    interpolations: readonly {
      name: string;
      source: 'caller-supplied' | 'static' | 'server-derived';
      escaped: boolean;
      allowlisted: boolean;
      validatedAs: string | null;
    }[];
    siblingEmitters: number;
    siblingEmittersCovered: number;
  },
): SecurityNode {
  return {
    id,
    kind: 'emitted-command',
    provenance: 'declared',
    label: `${opts.route} -> ${opts.field}`,
    facet: { kind: 'emitted-command', ...opts },
  };
}

// ---------------------------------------------------------------------------
// C9 building blocks
// ---------------------------------------------------------------------------

export const CLUSTER_KEY = 'workspace.tid ~ caller.tid';

/** The repaired form: a POSITIVE match, so a missing tid DENIES. */
export const TABLE_POSITIVE_MATCH: Readonly<Record<TruthRow, 'allow' | 'deny'>> = {
  'caller-absent': 'deny',
  'doc-absent': 'deny',
  'both-absent': 'deny',
  'both-present-equal': 'allow',
  'both-present-unequal': 'deny',
};

/**
 * The NON-CONTRADICTION form: `callerTid && docTid && docTid !== callerTid`
 * short-circuits and PASSES when either side is missing. An edge that fails to
 * fire on missing data is not an edge (bfd67ed1 / #3859).
 */
export const TABLE_NON_CONTRADICTION: Readonly<Record<TruthRow, 'allow' | 'deny'>> = {
  'caller-absent': 'allow',
  'doc-absent': 'allow',
  'both-absent': 'allow',
  'both-present-equal': 'allow',
  'both-present-unequal': 'deny',
};

export function c9Node(
  id: string,
  facet: Omit<PredicateImplFacet, 'kind'>,
): SecurityNode {
  return {
    id,
    kind: 'predicate-impl',
    provenance: 'owns',
    label: facet.implId,
    facet: { kind: 'predicate-impl', ...facet },
  };
}

export const C9_CANONICAL = c9Node('fx:c9:canonical', {
  clusterKey: CLUSTER_KEY,
  implId: 'resolveWorkspaceAccessByOid',
  canonical: true,
  truthTable: TABLE_POSITIVE_MATCH,
  inputsDerivedFrom: 'session.claims.tid + wsDoc.tid',
});

/** An equivalent duplicate. Duplication WITH equivalence is not a security finding. */
export const C9_EQUIVALENT_DUPLICATE = c9Node('fx:c9:equivalent-duplicate', {
  clusterKey: CLUSTER_KEY,
  implId: 'listAccessibleWorkspaces',
  canonical: false,
  truthTable: TABLE_POSITIVE_MATCH,
  inputsDerivedFrom: 'session.claims.tid + wsDoc.tid',
});

/** A member that drifted to the pre-repair shape. */
export const C9_DRIFTED = c9Node('fx:c9:drifted', {
  clusterKey: CLUSTER_KEY,
  implId: 'resolveWorkspaceRole',
  canonical: false,
  truthTable: TABLE_NON_CONTRADICTION,
  inputsDerivedFrom: 'session.claims.tid + wsDoc.tid',
});

/** #3843's shape: the table matches exactly, the INPUTS are derived differently. */
export const C9_DIFFERENT_INPUTS = c9Node('fx:c9:different-inputs', {
  clusterKey: CLUSTER_KEY,
  implId: 'itemsByTypeBoundary',
  canonical: false,
  truthTable: TABLE_POSITIVE_MATCH,
  inputsDerivedFrom: 'itemDoc.ownerTid (re-derived, not the session claim)',
});

// ---------------------------------------------------------------------------
// The clean baseline — the mutation subject
// ---------------------------------------------------------------------------

/**
 * A graph in which EVERY node of EVERY kind is clean.
 *
 * `runSecuritySweep(cleanBaseline())` must produce ZERO findings — including zero
 * `POP-population-integrity`, which is why one node of every kind is present.
 * `baseline-clean.test.ts` asserts exactly that, and the mutation arms break this
 * function and require that assertion to go RED.
 *
 * Each `// MUT-*` marker below is a single-line mutation point. The needles carry
 * no newline, so the repo's CRLF line endings cannot silently no-op them.
 */
export function cleanBaseline(): SecurityGraph {
  const nodes: SecurityNode[] = [
    // C1 — a correct delegation, plus both negative controls.
    {
      id: 'fx:base:c1',
      kind: 'authorizer',
      provenance: 'declared',
      label: 'baseline authorizer delegating to the canonical owns resolver',
      facet: {
        kind: 'authorizer',
        fnName: 'authorizeBaseline',
        params: ['session', 'itemId', 'itemType'],
        resourceScoped: true,
        callerNamedResourceInputs: ['itemId'],
        allowPaths: [AP_CLEAN_DELEGATION], // MUT-C1
        reachesPrivilegedSink: true,
        privilegedSinkKinds: ['cosmos-write'],
      },
    },
    c1NegativeOrgWideGate('fx:base:c1-org-gate'),
    c1NegativeMappingLookup('fx:base:c1-mapping'),

    // C2 — scope resolved before the query, so the count is the caller's own.
    {
      id: 'fx:base:c2',
      kind: 'scoped-handler',
      provenance: 'declared',
      label: 'baseline handler resolving the caller-supplied scope first',
      facet: {
        kind: 'scoped-handler',
        handler: 'baselineSweep',
        callerSuppliedScopeParams: ['workspaceId'],
        scopeResolvedBeforeQuery: true, // MUT-C2-SCOPE
        denialShape: 'not-found',
        identifiersRedacted: true,
        disclosures: [DISCLOSURE_COUNT], // MUT-C2-SHAPE
      },
    },

    // C3 — the verdict is consumed as a refusal on every path to the sink.
    {
      id: 'fx:base:c3',
      kind: 'verdict-call',
      provenance: 'declared',
      label: 'baseline route returning the gate unconditionally',
      facet: {
        kind: 'verdict-call',
        callSite: 'baseline:POST',
        symbol: 'enforceCapability',
        returnsVerdictUnion: true,
        pathsToPrivilegedSink: 4,
        pathsConsumingAsRefusal: 4, // MUT-C3-PATHS
        consumption: 'returned', // MUT-C3-CONSUMPTION
        allowlisted: false,
        allowlistPremiseTested: true,
        sinkPrivileged: true,
        sinkKind: 'cosmos-write',
      },
    },
    c3NegativeStaticCatalogue('fx:base:c3-static'),

    // C4 — every sink wholly bounded; the spawn's child is proven to redact.
    c4Node('fx:base:c4', [SINK_BOUNDED, SINK_BY_DESIGN, SINK_INHERITED_FD_SAFE], 'baseline-publisher'), // MUT-C4

    // C5 — every failure mode refuses; UNKNOWN maps to DENY; the fix is adopted.
    c5Node('fx:base:c5', {
      subject: 'baselineMembershipProbe',
      failureModes: MODES_ALL_REFUSING, // MUT-C5
      unknownMapsTo: 'deny', // MUT-C5-UNKNOWN
      emptyStateReachableOnReadError: false,
      adoptedFix: true,
    }),

    // C6 — redirects disabled, restricted opener, no process-wide default.
    c6Node('fx:base:c6', {
      callSite: 'baselineFetch',
      attachedCredentials: ['authorization'],
      redirectPolicy: 'none', // MUT-C6-REDIRECT
      opener: 'restricted',
      stripsCredentialOnHostChange: true, // MUT-C6-STRIP
      schemeAllowlist: null, // MUT-C6-SCHEME
      defaultOpenerInstalledProcessWide: false,
    }),

    // C7 — the principal comes from a live token; every copy is under test.
    c7Node('fx:base:c7', {
      sink: 'baselineSessionMinter',
      reachesPartitionKeyOrTenantScope: true,
      sources: [{ origin: 'live-token', validation: 'value', bypassesMinter: false }], // MUT-C7
      checkCopies: 2,
      checkCopiesUnderTest: 2,
    }),

    // C8 — every caller-supplied interpolation escaped; every sibling covered.
    c8Node('fx:base:c8', {
      route: 'baselineSetup',
      field: 'bootstrapScript',
      contentShape: 'shell-command',
      interpolations: [
        { name: 'clientId', source: 'caller-supplied', escaped: true, allowlisted: true, validatedAs: 'guid' }, // MUT-C8-ESCAPE
      ],
      siblingEmitters: 2,
      siblingEmittersCovered: 2, // MUT-C8-SIBLING
    }),

    // C9 — a canonical plus an equivalent duplicate; the declared size matches.
    C9_CANONICAL,
    C9_EQUIVALENT_DUPLICATE, // MUT-C9
  ];

  return {
    nodes,
    edges: [],
    annotations: {
      expectedPredicateClusterSize: { [CLUSTER_KEY]: 2 }, // MUT-C9-SIZE
    },
    source: 'modelled',
  };
}

/** A graph with the given nodes and no cluster declarations — for focused specs. */
export function graphOf(
  nodes: readonly SecurityNode[],
  expectedPredicateClusterSize: Record<string, number> = {},
): SecurityGraph {
  return {
    nodes,
    edges: [],
    annotations: { expectedPredicateClusterSize },
    source: 'modelled',
  };
}

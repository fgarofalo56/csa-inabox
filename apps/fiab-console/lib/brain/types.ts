/**
 * LOOM BRAIN — the shared contract.
 *
 * This module is the SUBSTRATE every other Brain module builds on: the graph
 * (`./graph`), the detectors, the agent layer, the cost layer, and the
 * visualizer. It is PURE — no React, no Azure SDK, no fetch, no I/O. Everything
 * here is data and predicates over data, which is what makes the whole Brain
 * testable without an Azure tenant.
 *
 * Four properties are enforced by the TYPE SYSTEM rather than by review, because
 * each of them is a failure this repo has actually shipped:
 *
 *   P1  AN EDGE CANNOT EXIST WITHOUT ITS PROVENANCE, and a `declared` edge can
 *       never be silently counted as a `configured` one. `BrainEdge` is a
 *       discriminated union on `provenance`; there is no default and no
 *       "unknown" member. See §Edges.
 *
 *   P2  A DANGLING EDGE CANNOT MASQUERADE AS A RESOLVED ONE. `ResolvedEdge` has
 *       `to: NodeId`; `DanglingEdge` has `to: null`. The union discriminates on
 *       BOTH `resolution` and `to`, so `{ resolution: 'dangling', to: someNode }`
 *       does not typecheck. See §The dangling distinction.
 *
 *   P3  A VERDICT CANNOT BE READ WITHOUT ITS POPULATION. Every query and every
 *       finding carries a `Population`, and `Population.blind` is true when the
 *       examined set was empty. A detector over an empty set is GREEN AND BLIND;
 *       that has been found repeatedly in this repo, so the shape makes the
 *       count impossible to omit. See §Population.
 *
 *   P4  A REMEDIATION CANNOT BE AN ACTION. `RemediationProposal` pins
 *       `requiresHumanApproval: true` and `mutatesAzure: false` as LITERAL
 *       types, so there is no assignment that produces an auto-executing
 *       proposal. See §Remediation.
 *
 * ── WHY P1 AND P2 ARE THE CENTRAL IDEA ─────────────────────────────────────
 * The founding measured example, 2026-08-23:
 *
 *   `loom-capacity-broker` runs minReplicas 2 (0.5 vCPU + 1 GiB each), is
 *   healthy, and has an internal ingress FQDN —
 *   `loom-capacity-broker-app.bicep:186 minReplicas: 2`, `:154 cpu json('0.5')`,
 *   `:155 memory '1Gi'`, `:124 external: false`.
 *
 *   And `admin-plane/main.bicep:4730` emits
 *   `{ name: 'LOOM_BROKER_URL', value: '' }` — the ONLY name any bicep emits for
 *   it. `lib/azure/capacity-broker-client.ts:95` reads
 *   `LOOM_CAPACITY_BROKER_URL || LOOM_BROKER_URL` and gets an empty string from
 *   both, so `capacityBrokerConfigured()` returns false.
 *
 * A billing service with no inbound edge. The graph shape that finds it is
 * "zero inbound edges of provenance `configured`" — and it is found ONLY if the
 * three states below stay distinct:
 *
 *   RESOLVED  the wire exists and points at a real node          → counts inbound
 *   DANGLING  the wire EXISTS but its value is '' or unresolvable → does NOT count
 *   ABSENT    no wire at all                                      → no edge exists
 *
 * Collapse DANGLING into RESOLVED and the broker looks wired (this is exactly
 * how "it's deployed so it must be used" happens). Collapse DANGLING into
 * ABSENT and the broker is still found unreachable, but the EVIDENCE CHAIN is
 * destroyed: you lose the fact that main.bicep:4730 tried to wire it and emitted
 * `''`, which is the entire remediation. So a dangling edge is EMITTED, carries
 * its `intendedTo`, and is excluded from reachability. Both halves matter.
 *
 * ── R7 (deploy-integrity): NO CLAIM THE CODE CANNOT ESTABLISH ──────────────
 * Several fields below exist purely to keep "I did not measure this" separate
 * from "I measured zero": `ScaleFacts | undefined`, `tags: … | null` with
 * `tagsError`, `Population.blind`, and `CostFigure.source`. Do not "simplify"
 * any of them into a falsy default.
 */

// ---------------------------------------------------------------------------
// Build-checked type assertions — the harness
//
// These live in a SOURCE file on purpose, copying the pattern established by
// `lib/estate/pause-state.ts`. `next build` typechecks with
// `tsconfig.build.json`, which EXCLUDES `**/__tests__/**` — so a `@ts-expect-error`
// guard written in a test file is NOT enforced by the build gate. These compile
// under the build config, cost nothing at runtime, and fail `next build` the
// moment the property they protect is weakened.
// ---------------------------------------------------------------------------

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

// ---------------------------------------------------------------------------
// §Identity
// ---------------------------------------------------------------------------

/**
 * A node identifier, branded so a raw string cannot be passed where a canonical
 * id is required.
 *
 * THE BRAND IS LOAD-BEARING, not decoration. ARM resource ids are
 * case-insensitive but are returned by Azure in inconsistent casing — Resource
 * Graph, an ARM GET and a bicep `resourceId()` expression routinely disagree on
 * the casing of `resourceGroups` / provider segments for the SAME resource. If
 * two extractors mint ids by concatenating raw strings, the same physical
 * resource becomes TWO nodes, each carrying half the edges, and every
 * reachability answer is silently wrong in the direction of "unreachable" —
 * i.e. it manufactures exactly the finding this system exists to report.
 *
 * The only sanctioned constructors are in `./graph/node-id`, and they normalize.
 */
export type NodeId = string & { readonly __brand: 'BrainNodeId' };

/** An edge identifier. Branded for the same reason as {@link NodeId}. */
export type EdgeId = string & { readonly __brand: 'BrainEdgeId' };

/**
 * Which extractor produced a node or an edge. Carried on every element so a
 * finding can name where its evidence came from, and so a graph missing an
 * entire provenance is diagnosable (see {@link GraphBuildReport}).
 */
export type ExtractorSource =
  | 'resource-graph'
  | 'bicep'
  | 'container-app-env'
  | 'source-imports'
  | 'loom-items'
  | 'telemetry'
  | 'deploy-manifest';

// ---------------------------------------------------------------------------
// §Nodes
// ---------------------------------------------------------------------------

/**
 * The four node kinds from PRP §3.1. A node is a thing that can be at the end of
 * an edge; it is NOT necessarily an Azure resource.
 */
export type NodeKind =
  /** An Azure resource, from Resource Graph or an ARM GET. */
  | 'azure-resource'
  /** A Loom logical item (lakehouse, pipeline, …) from Cosmos. */
  | 'loom-item'
  /** A deploy artifact: a bicep module, a param file, a workflow. */
  | 'deploy-artifact'
  /** A source module. */
  | 'code-module';

export const NODE_KINDS: readonly NodeKind[] = [
  'azure-resource',
  'loom-item',
  'deploy-artifact',
  'code-module',
] as const;

/**
 * Replica/size facts for a scalable resource.
 *
 * `undefined` on the node means NOT MEASURED — it does NOT mean zero, and it
 * does NOT mean "not scalable". An always-on query that treats absence as
 * `minReplicas: 0` silently exonerates every resource it failed to read, which
 * is the R7 failure in its cheapest form. {@link scaleUnknownCount} exists so
 * that population can be reported rather than absorbed.
 */
export interface ScaleFacts {
  /** Replicas that run even at zero load. `> 0` means always-on, means billed. */
  readonly minReplicas: number;
  readonly maxReplicas?: number;
  /** vCPU per replica, e.g. 0.5. */
  readonly cpu?: number;
  /** Memory per replica as authored, e.g. '1Gi'. Kept verbatim, not parsed. */
  readonly memory?: string;
  /** Where these numbers came from — a bicep literal is not a live reading. */
  readonly source: ExtractorSource;
}

/**
 * Ingress facts. `external: false` with a non-null `fqdn` is an INTERNAL
 * endpoint — reachable only from inside the Container Apps environment, which is
 * precisely the `loom-capacity-broker` shape: addressable, healthy, and wired to
 * nothing.
 */
export interface IngressFacts {
  readonly external: boolean;
  readonly fqdn: string | null;
  readonly targetPort?: number;
}

interface BrainNodeBase<K extends NodeKind> {
  readonly id: NodeId;
  readonly kind: K;
  /** Human-facing label. Never used for identity or matching. */
  readonly displayName: string;
  readonly source: ExtractorSource;
}

export interface AzureResourceNode extends BrainNodeBase<'azure-resource'> {
  /** ARM id in its ORIGINAL casing. `id` holds the normalized form. */
  readonly resourceId: string;
  /** Full ARM type, e.g. 'Microsoft.App/containerApps'. Compare case-insensitively. */
  readonly resourceType: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly location?: string;
  /**
   * Tags as discovery reported them. `null` means the tags could NOT be read —
   * which is INDETERMINATE, not "no tags". Conflating the two is how a
   * fail-open ownership inference crawls in, and per PRP §1 a wrong ownership
   * inference on this estate reaches 12 non-Loom environments.
   */
  readonly tags: Readonly<Record<string, string>> | null;
  /** Why `tags` is null. Surfaced verbatim; never summarized into a boolean. */
  readonly tagsError?: string;
  /** Absent means NOT MEASURED. See {@link ScaleFacts}. */
  readonly scale?: ScaleFacts;
  /** Absent means NOT MEASURED. */
  readonly ingress?: IngressFacts;
  /** Provisioning state verbatim from discovery, e.g. 'Succeeded'. */
  readonly provisioningState?: string;
}

export interface LoomItemNode extends BrainNodeBase<'loom-item'> {
  readonly itemType: string;
  readonly itemId: string;
  readonly workspaceId?: string;
}

export interface DeployArtifactNode extends BrainNodeBase<'deploy-artifact'> {
  /** Repo-relative path, forward slashes, e.g. 'platform/fiab/bicep/modules/admin-plane/main.bicep'. */
  readonly path: string;
  readonly artifactKind: 'bicep-module' | 'bicep-param' | 'workflow' | 'manifest';
}

export interface CodeModuleNode extends BrainNodeBase<'code-module'> {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
}

export type BrainNode =
  | AzureResourceNode
  | LoomItemNode
  | DeployArtifactNode
  | CodeModuleNode;

// ---------------------------------------------------------------------------
// §Edges — P1 and P2
// ---------------------------------------------------------------------------

/**
 * Edge provenance. THE DISCRIMINATOR. Each value answers a different question,
 * and a finding is only meaningful once you say which one you asked:
 *
 *   `declared`    bicep: a module output wired into another module's input, or
 *                 an `env:` entry. Means "the TEMPLATE says these are connected".
 *   `configured`  a LIVE env var pointing at an FQDN / endpoint / resource id.
 *                 Means "the DEPLOYMENT actually connects them".
 *   `imports`     source: module → module.
 *   `observed`    telemetry: real traffic.
 *   `owns`        an ownership tag or deploy manifest → the resource.
 *
 * The two-line summary of why this type exists:
 *
 *   `declared` without `configured`  = wired in the template, DEAD in the deployment.
 *   `configured` without `observed`  = reachable and UNUSED.
 *
 * Those are different findings with different fixes. There is deliberately no
 * 'unknown' member: an extractor that cannot tell must not emit the edge.
 */
export type EdgeProvenance =
  | 'declared'
  | 'configured'
  | 'imports'
  | 'observed'
  | 'owns';

export const EDGE_PROVENANCES: readonly EdgeProvenance[] = [
  'declared',
  'configured',
  'imports',
  'observed',
  'owns',
] as const;

/**
 * Why an edge did not resolve. Each value is a DIFFERENT remediation, so they
 * are not collapsed into a boolean.
 */
export type DanglingReason =
  /**
   * The wire exists and its value is the empty string. THE FOUNDING CASE:
   * `{ name: 'LOOM_BROKER_URL', value: '' }`.
   *
   * Note what an empty value does: it destroys the evidence of its own intent.
   * `value: 'https://${loomDirectLake!.outputs.fqdn}'` names its target; `''`
   * names nothing. That is why `intendedTo` may be supplied out-of-band, and why
   * it is nullable rather than required.
   */
  | 'empty-value'
  /** Non-empty value, but nothing in the graph matches it. */
  | 'unresolved-target'
  /** The value names a resource id that is not present in the graph. */
  | 'missing-resource';

/**
 * Where an edge was read from, precise enough to re-verify by hand. Every edge
 * carries one; a finding's evidence chain is a list of these.
 */
export interface EdgeEvidence {
  /** Repo-relative path or ARM resource id — whatever `extractor` reads from. */
  readonly artifact: string;
  /** 1-based line, when the artifact is a text file. */
  readonly line?: number;
  /** The symbol that carried the wire, e.g. 'LOOM_BROKER_URL'. */
  readonly symbol?: string;
  /**
   * The value verbatim, as authored. For a dangling `empty-value` edge this is
   * the empty string, and that is the point — the receipt shows `''` rather
   * than showing nothing.
   */
  readonly rawValue?: string;
  readonly extractor: ExtractorSource;
}

interface EdgeCommon<P extends EdgeProvenance> {
  readonly id: EdgeId;
  /** P1: required, no default, no 'unknown'. */
  readonly provenance: P;
  readonly from: NodeId;
  readonly evidence: EdgeEvidence;
}

/**
 * An edge whose target is a real node. THE ONLY KIND THAT COUNTS FOR
 * REACHABILITY.
 */
export interface ResolvedEdge<P extends EdgeProvenance = EdgeProvenance>
  extends EdgeCommon<P> {
  readonly resolution: 'resolved';
  readonly to: NodeId;
  /** P2: structurally impossible on a resolved edge. */
  readonly intendedTo?: never;
  readonly danglingReason?: never;
}

/**
 * An edge that EXISTS in the source artifact but points nowhere.
 *
 * `to` is `null`, so it is invisible to reachability — a dangling wire does not
 * make its target reachable, which is the whole `loom-capacity-broker` finding.
 * `intendedTo` records who it was MEANT to reach, so the evidence chain survives
 * and the finding can be attached to the abandoned node.
 */
export interface DanglingEdge<P extends EdgeProvenance = EdgeProvenance>
  extends EdgeCommon<P> {
  readonly resolution: 'dangling';
  /** P2: always null. This is what excludes it from reachability. */
  readonly to: null;
  /**
   * The node this wire was meant to reach, when that is KNOWN. `null` means the
   * intent could not be established (R7) — not that there is no intent.
   */
  readonly intendedTo: NodeId | null;
  readonly danglingReason: DanglingReason;
}

export type BrainEdge<P extends EdgeProvenance = EdgeProvenance> =
  | ResolvedEdge<P>
  | DanglingEdge<P>;

/** Narrowing helper. Prefer this over reading `.resolution` inline. */
export function isResolvedEdge<P extends EdgeProvenance>(
  e: BrainEdge<P>,
): e is ResolvedEdge<P> {
  return e.resolution === 'resolved';
}

/** Narrowing helper. */
export function isDanglingEdge<P extends EdgeProvenance>(
  e: BrainEdge<P>,
): e is DanglingEdge<P> {
  return e.resolution === 'dangling';
}

// ---------------------------------------------------------------------------
// Build-checked assertions for P1 / P2
// ---------------------------------------------------------------------------

/** A dangling edge shape with a non-null target must NOT be an edge. */
type DanglingWithTarget = {
  id: EdgeId;
  provenance: 'configured';
  from: NodeId;
  evidence: EdgeEvidence;
  resolution: 'dangling';
  to: NodeId;
  intendedTo: NodeId | null;
  danglingReason: DanglingReason;
};

/**
 * P2 — if `DanglingEdge.to` is ever widened from `null` to `NodeId | null`, this
 * flips to `true` and `next build` fails HERE. That widening is exactly how a
 * dangling wire would start counting as inbound reachability.
 */
type _DanglingCannotCarryATarget = Assert<
  DanglingWithTarget extends BrainEdge ? false : true
>;

/** An edge shape with no provenance at all. */
type EdgeWithoutProvenance = {
  id: EdgeId;
  from: NodeId;
  evidence: EdgeEvidence;
  resolution: 'resolved';
  to: NodeId;
};

/**
 * P1 — provenance is REQUIRED. If it is ever made optional, this flips and the
 * build fails, because an edge with no provenance is an edge whose finding
 * cannot state which question it answered.
 */
type _ProvenanceIsRequired = Assert<
  EdgeWithoutProvenance extends BrainEdge ? false : true
>;

/**
 * P2, the other direction — a resolved edge cannot carry `to: null`. Guards
 * against "just make `to` nullable everywhere", which would let a dangling edge
 * be constructed as `resolution: 'resolved'`.
 */
type ResolvedWithNullTarget = {
  id: EdgeId;
  provenance: 'declared';
  from: NodeId;
  evidence: EdgeEvidence;
  resolution: 'resolved';
  to: null;
};
type _ResolvedCannotBeNull = Assert<
  ResolvedWithNullTarget extends BrainEdge ? false : true
>;

// ---------------------------------------------------------------------------
// §Population — P3
// ---------------------------------------------------------------------------

/**
 * WHAT WAS EXAMINED. Every query and every finding carries one.
 *
 * A detector that returns zero findings over an empty node set is GREEN AND
 * BLIND, and that failure has been found repeatedly in this repo. The cure is
 * not discipline, it is shape: a query returns {@link QueryResult}, which cannot
 * be destructured to a verdict without the population being right there.
 *
 * `blind` is stored rather than derived at the call site so it cannot be
 * forgotten, and so a serialized finding still carries it.
 */
export interface Population {
  /**
   * Which set the query RANGED OVER. `blind` is computed against this one, so
   * "empty population" is never ambiguous between nodes and edges.
   */
  readonly subject: 'nodes' | 'edges';
  /** Nodes in scope BEFORE the predicate ran. */
  readonly examined: number;
  /** Edges in scope. */
  readonly edgesExamined: number;
  /** Plain-English scope, e.g. "29 azure-resource nodes of type Microsoft.App/containerApps". */
  readonly scope: string;
  /**
   * True iff the SUBJECT set was empty — `examined === 0` when `subject` is
   * 'nodes', `edgesExamined === 0` when it is 'edges'. A verdict over an empty
   * population establishes NOTHING; callers must render this, not hide it
   * behind a green tick.
   */
  readonly blind: boolean;
  /**
   * Edge counts by provenance within scope. Present on EVERY population, so
   * even a caller that asked for "all edges" cannot read an undifferentiated
   * total — a graph with zero `declared` edges is visible at a glance.
   *
   * THIS IS ALSO THE VACUOUS-TRUTH CHECK. `nodesWithNoInboundEdge(g,
   * 'configured')` over a graph containing zero `configured` edges returns EVERY
   * node, and every one of those "findings" is vacuous. `blind` does not fire
   * there — the node set was not empty — so the signal that matters is
   * `byProvenance.configured === 0`. Detector authors: read it.
   */
  readonly byProvenance: Readonly<Record<EdgeProvenance, number>>;
}

/**
 * The return shape of every graph query. Deliberately NOT a bare array.
 *
 * `const hits = query(...)` gives you an object you must reach into, which is a
 * small friction that buys a large property: no caller can log a count without
 * having had the population in hand.
 */
export interface QueryResult<T> {
  readonly result: T;
  readonly population: Population;
}

// ---------------------------------------------------------------------------
// §Cost
// ---------------------------------------------------------------------------

/**
 * Where a dollar figure came from.
 *
 * MEASURED 2026-08-23: the Cost Management API returned HTTP 429 on 11
 * consecutive attempts over ~35 minutes, so every figure produced for this
 * program so far is `derived` — a measured SKU multiplied by a published retail
 * rate. A derived figure is an ESTIMATE OF A PRICE, not a statement about a
 * bill; presenting one as billed is a false claim under R7.
 */
export type CostSource = 'billed' | 'derived';

export interface CostFigure {
  readonly amountUsd: number;
  /** REQUIRED. There is no default and no inference. */
  readonly source: CostSource;
  /**
   * REQUIRED. How the number was arrived at.
   *   derived: "2 replicas x 0.5 vCPU x <rate>/vCPU-hr, retail list 2026-08-23"
   *   billed:  "Cost Management export <name>, period 2026-08-01..2026-08-22"
   * A basis that does not let a reader reproduce the number is not a basis.
   */
  readonly basis: string;
  /** ISO-8601. For `billed`, the period end; for `derived`, when the rate was read. */
  readonly asOf: string;
}

/** A cost figure shape with no `source`. */
type CostWithoutSource = { amountUsd: number; basis: string; asOf: string };

/**
 * `source` is REQUIRED. If it is ever made optional, an unlabelled figure
 * becomes constructible and the billed/derived distinction dies quietly.
 */
type _CostSourceIsRequired = Assert<
  CostWithoutSource extends CostFigure ? false : true
>;

/**
 * Renders a figure with its provenance ALWAYS attached. Use this rather than
 * interpolating `amountUsd`, so a derived number cannot reach an operator
 * looking like a bill.
 */
export function formatCostFigure(c: CostFigure): string {
  const amount = `$${c.amountUsd.toFixed(2)}`;
  return c.source === 'billed'
    ? `${amount} (billed, ${c.basis})`
    : `${amount} (DERIVED estimate — not a bill; ${c.basis})`;
}

/** Construct a derived figure. The basis is not optional. */
export function derivedCost(amountUsd: number, basis: string, asOf: string): CostFigure {
  return { amountUsd, source: 'derived', basis, asOf };
}

/** Construct a billed figure. Only legitimate from a Cost Management export. */
export function billedCost(amountUsd: number, basis: string, asOf: string): CostFigure {
  return { amountUsd, source: 'billed', basis, asOf };
}

// ---------------------------------------------------------------------------
// §Findings and §Remediation — P4
// ---------------------------------------------------------------------------

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * The reproducible trail behind a finding: which nodes, which edges, and the
 * query that produced it. `query` is a string an engineer can re-run — a finding
 * whose derivation cannot be re-run is an assertion, not evidence.
 */
export interface EvidenceChain {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly EdgeId[];
  /** The query, as invoked. e.g. "nodesWithNoInboundEdge(graph, 'configured')". */
  readonly query: string;
  /** Anything the code ESTABLISHED. Not speculation — see R7. */
  readonly notes: readonly string[];
}

/**
 * P4 — A DRAFT, NEVER AN ACTION.
 *
 * Per PRP §1 decision 1 the Brain is recommend-only, and the measured reason is
 * blast radius: of the 13 Container App environments visible across these
 * subscriptions, ONE is Loom's. The other 12 are the operator's blog, Sentinel,
 * two Atlas estates and more. An autonomous mutation on a wrong ownership
 * inference destroys someone else's production.
 *
 * `requiresHumanApproval` and `mutatesAzure` are LITERAL types, not booleans, so
 * `{ requiresHumanApproval: false }` is a compile error rather than a policy
 * violation someone has to notice in review.
 */
export interface RemediationProposal {
  /** Literal. There is no `'action'` member and there must never be one. */
  readonly kind: 'proposal';
  readonly summary: string;
  /**
   * The change as TEXT — a diff, an `az` command, a bicep edit. It is rendered
   * for a human to apply. Nothing in `lib/brain` executes it.
   */
  readonly proposedChange: string;
  /** Literal `true`. Cannot be set false. */
  readonly requiresHumanApproval: true;
  /** Literal `false`. Cannot be set true. */
  readonly mutatesAzure: false;
}

/** A proposal shape that claims it needs no approval. */
type SelfApprovingProposal = {
  kind: 'proposal';
  summary: string;
  proposedChange: string;
  requiresHumanApproval: false;
  mutatesAzure: false;
};

/**
 * P4 — if `requiresHumanApproval` is ever widened to `boolean`, this flips to
 * `true` and `next build` fails HERE. That is the only edit that could make an
 * auto-approving proposal constructible, and it now cannot be made quietly.
 */
type _ProposalsCannotSelfApprove = Assert<
  SelfApprovingProposal extends RemediationProposal ? false : true
>;

/** A proposal shape that claims it mutates Azure. */
type MutatingProposal = {
  kind: 'proposal';
  summary: string;
  proposedChange: string;
  requiresHumanApproval: true;
  mutatesAzure: true;
};

/** P4 — nothing in the Brain may declare itself a mutation. */
type _ProposalsCannotMutate = Assert<
  MutatingProposal extends RemediationProposal ? false : true
>;

/** Construct a proposal. The only constructor; the literals are supplied here. */
export function proposal(summary: string, proposedChange: string): RemediationProposal {
  return {
    kind: 'proposal',
    summary,
    proposedChange,
    requiresHumanApproval: true,
    mutatesAzure: false,
  };
}

/**
 * One detector output.
 *
 * `population` is REQUIRED (P3): a finding must state what it examined. A
 * detector that returns `[]` reports its population through
 * {@link DetectorResult} instead, so "no findings" is never indistinguishable
 * from "no data".
 */
export interface Finding {
  readonly id: string;
  /** The detector that produced it, e.g. 'unreachable-always-on'. */
  readonly detector: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  /** Operator-readable. States what was ESTABLISHED, never a guess (R7). */
  readonly summary: string;
  /** The nodes this finding is ABOUT. */
  readonly subjects: readonly NodeId[];
  readonly evidence: EvidenceChain;
  readonly population: Population;
  readonly confidence: Confidence;
  /** Optional because not every finding has a cost. Never a derived-as-billed. */
  readonly cost?: CostFigure;
  readonly remediation: RemediationProposal;
}

/**
 * What a detector returns. NOT a bare `Finding[]`.
 *
 * PRP §3.2: "A detector that returns zero findings must report the population it
 * examined." Returning an array makes that optional; returning this makes it
 * structural. Detector authors: this is the type to implement.
 */
export interface DetectorResult {
  readonly detector: string;
  readonly findings: readonly Finding[];
  readonly population: Population;
  /**
   * Anything the detector could not evaluate, with the reason. A subject skipped
   * for lack of data is NOT a subject that passed.
   */
  readonly skipped: readonly SkippedSubject[];
}

/** A thing an extractor or detector deliberately did not process, and why. */
export interface SkippedSubject {
  /** What was skipped — a node id, a path, a raw line. */
  readonly subject: string;
  /** Why. Must be what was ESTABLISHED. */
  readonly reason: string;
}

/** The shape every detector implements. Pure: graph in, result out. */
export type Detector = (graph: BrainGraphView) => DetectorResult;

// ---------------------------------------------------------------------------
// §The graph view — what detectors and the visualizer consume
// ---------------------------------------------------------------------------

/**
 * The read-only face of a built graph. Detectors, the agent layer and the
 * visualizer take THIS, never a mutable builder — the graph is immutable once
 * built, so a detector cannot perturb the evidence another detector cites.
 *
 * Implemented by `./graph`'s `buildGraph()`. Kept as an interface here so the
 * shared contract does not depend on the implementation module.
 */
export interface BrainGraphView {
  readonly nodes: readonly BrainNode[];
  readonly edges: readonly BrainEdge[];
  /** How the graph was assembled, including what each extractor could not read. */
  readonly report: GraphBuildReport;
  node(id: NodeId): BrainNode | undefined;
  /**
   * Inbound edges that COUNT — resolved only. Dangling edges are excluded by
   * construction (their `to` is null), which is the reachability property.
   */
  inboundEdges(id: NodeId, provenance?: EdgeProvenance): QueryResult<readonly ResolvedEdge[]>;
  outboundEdges(id: NodeId, provenance?: EdgeProvenance): QueryResult<readonly ResolvedEdge[]>;
  /**
   * Inbound edges split by provenance — the `declared` vs `configured` answer as
   * DATA rather than as two separate calls a caller might forget to compare.
   *
   * On the interface, not just the implementation: a {@link Detector} receives a
   * `BrainGraphView`, and the whole point of the provenance discriminator is
   * lost if the type detectors are handed cannot express the split.
   */
  inboundEdgesByProvenance(
    id: NodeId,
  ): QueryResult<Record<EdgeProvenance, readonly ResolvedEdge[]>>;
  /** Dangling edges whose `intendedTo` is this node — the evidence chain. */
  danglingEdgesIntendedFor(id: NodeId): QueryResult<readonly DanglingEdge[]>;
}

/**
 * What building the graph established, INCLUDING its gaps.
 *
 * `edgesByProvenance` is the population check for the graph itself: a graph with
 * zero `declared` edges will make every "declared but not configured" detector
 * return clean, and it will be wrong. Report it, do not assume it.
 */
export interface GraphBuildReport {
  readonly nodesByKind: Readonly<Record<NodeKind, number>>;
  readonly edgesByProvenance: Readonly<Record<EdgeProvenance, number>>;
  readonly edgesByResolution: { readonly resolved: number; readonly dangling: number };
  readonly extractorsRun: readonly ExtractorSource[];
  /** Inputs an extractor could not parse or resolve. Never silently dropped. */
  readonly skipped: readonly SkippedSubject[];
  /** Node ids referenced by an edge but never defined. A graph integrity defect. */
  readonly danglingNodeRefs: readonly string[];
}

/**
 * What one extractor produced. Extractors are pure: data in, this out. They do
 * NOT resolve edges against the full graph — resolution happens in `buildGraph`,
 * once every node from every extractor is present, because an edge's target is
 * frequently discovered by a DIFFERENT extractor than the one that found the
 * wire.
 */
export interface ExtractionResult {
  readonly source: ExtractorSource;
  readonly nodes: readonly BrainNode[];
  /**
   * Edges with targets expressed as UNRESOLVED REFERENCES. `buildGraph` turns
   * each into a `ResolvedEdge` or a `DanglingEdge`.
   */
  readonly edges: readonly PendingEdge[];
  /** What this extractor examined — its own population (P3). */
  readonly population: Population;
  readonly skipped: readonly SkippedSubject[];
}

/**
 * An edge before target resolution.
 *
 * `targetRef` is whatever the artifact said: an FQDN, an ARM id, a module name,
 * a relative path — or the empty string. THE EMPTY STRING IS NOT A MISSING
 * FIELD. `targetRef: ''` with `emptyValue: true` is how an extractor says "the
 * wire is here and it is empty", which `buildGraph` turns into a
 * `DanglingEdge` with reason `empty-value`.
 *
 * An extractor that DROPS the empty case instead of emitting it destroys the
 * `loom-capacity-broker` evidence chain. `__tests__/graph/bicep-extractor.test.ts`
 * holds a mutation proving a test goes red when that happens.
 */
export interface PendingEdge {
  readonly provenance: EdgeProvenance;
  readonly from: NodeId;
  /** The target as authored. `''` means the wire exists and is empty. */
  readonly targetRef: string;
  /** True iff the authored value was empty. Distinguishes '' from "absent". */
  readonly emptyValue: boolean;
  /**
   * The node this wire was MEANT to reach, when the extractor can establish it
   * out-of-band. Needed precisely because `targetRef: ''` names nothing.
   */
  readonly intendedTo?: NodeId | null;
  readonly evidence: EdgeEvidence;
}

// ---------------------------------------------------------------------------
// Keep the assertion aliases referenced so they cannot be pruned as dead code,
// exactly as `lib/estate/pause-state.ts` does.
// ---------------------------------------------------------------------------

/** The build-checked invariants of this module. Do not delete. */
export type BrainTypeInvariants = [
  _DanglingCannotCarryATarget,
  _ProvenanceIsRequired,
  _ResolvedCannotBeNull,
  _CostSourceIsRequired,
  _ProposalsCannotSelfApprove,
  _ProposalsCannotMutate,
];

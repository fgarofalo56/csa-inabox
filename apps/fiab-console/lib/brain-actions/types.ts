/**
 * LOOM BRAIN ACTIONS — the shared contract for PERFORMING a recommendation
 * (#4242).
 *
 * ── WHY THIS PACKAGE EXISTS, AND WHY IT IS *NOT* `lib/brain` ───────────────
 * Four independent layers forbid the Brain itself from acting, each of them
 * deliberate and each of them still intact after this package landed:
 *
 *   1. `RemediationProposal` pins `requiresHumanApproval: true` and
 *      `mutatesAzure: false` as LITERAL types, with build-checked assertions
 *      (`_ProposalsCannotSelfApprove` / `_ProposalsCannotMutate`) in
 *      `lib/brain/types.ts`.
 *   2. `assertInertRemediation` (`lib/brain/security/recommend-only.ts`)
 *      rejects, at runtime and at any depth, any remediation object carrying a
 *      function, an accessor, or an actuator-named key — including literally
 *      `'perform'`.
 *   3. `no-mutation-controls.test.tsx` walks the rendered surface and scans the
 *      Brain's own source roots for ARM writes.
 *   4. The proposals route records decisions and performs nothing.
 *
 * The proposals route's own doc-block states the sanctioned path forward: "If a
 * future release adds execution … it belongs behind a separate route, a
 * separate capability, and its own review." THIS package is that separate
 * capability. Executors live HERE, outside `lib/brain`, keyed by DETECTOR KIND
 * in a server-side registry — never as a payload on a finding, which would trip
 * layer 2. A finding stays a proposal; performing is a separate, guarded,
 * audited record ABOUT it.
 *
 * Everything in this file is data and types. The I/O lives in `./executors`,
 * `./arm` and `./state-store`; the pure guard logic in `./guards`.
 */

/** The two executor kinds phase 1 actually implements. Both are DESTRUCTIVE. */
export type PerformExecutorKind = 'scale-to-zero' | 'delete-resource';

/**
 * One registry entry: what the platform can (or honestly cannot) do for a
 * detector kind. See `./registry` for the population and the reasons.
 */
export interface PerformRegistryEntry {
  /** The detector id, exactly as findings carry it. */
  readonly detector: string;
  /** True when a real executor exists for this class. */
  readonly performable: boolean;
  /** Which executor, when `performable`. */
  readonly executor?: PerformExecutorKind;
  /**
   * Every phase-1 executor is destructive (it removes capacity or a resource),
   * so every performable entry requires the two-step staged confirm
   * (`./state-store`), modeled on `lib/perf/auto-tune.ts`'s ARM_CLASSES
   * two-tick persistence gate.
   */
  readonly destructive?: true;
  /**
   * The HONEST reason, when not performable. Per `no-vaporware.md` this is a
   * real statement of why the platform cannot take the action — never a stub
   * that pretends, never "coming soon" without a tracked path.
   */
  readonly notPerformableReason?: string;
}

/** The perform request body. The server re-derives EVERYTHING else. */
export interface PerformRequest {
  readonly findingId: string;
  readonly detector: string;
  readonly subjectNodeId: string;
  /** Present only on the second (confirm) call of a destructive perform. */
  readonly confirmToken?: string;
}

/**
 * A guard's refusal: which guard fired and the honest, operator-readable
 * reason. Guards NEVER trust client-supplied state — every one re-derives its
 * input server-side at execute time.
 */
export interface GuardRefusal {
  readonly guard: string;
  readonly reason: string;
}

/**
 * The subject a perform acts on, resolved by the SERVER from its own snapshot
 * rebuild. The ARM resource id is derived from the server-side node fields
 * (subscription, resource group, type, name) — a client-supplied resource id is
 * never accepted anywhere in this package.
 */
export interface PerformSubject {
  readonly nodeId: string;
  readonly displayName: string;
  readonly resourceType: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  /** Server-derived ARM id, e.g. /subscriptions/…/containerApps/<name>. */
  readonly armResourceId: string;
  /** What the fresh snapshot claims the subject's minReplicas is, when measured. */
  readonly minReplicasClaimed?: number;
}

/**
 * The receipt of one executed perform: the real before/after, per
 * `no-vaporware.md`. `mutatedAzure` is a LITERAL `true` — a receipt exists only
 * when Azure was actually written, mirroring (in the opposite direction) the
 * literal `false` on `RemediationProposal`.
 */
export interface PerformReceipt {
  readonly executor: PerformExecutorKind;
  readonly detector: string;
  readonly findingId: string;
  readonly resourceId: string;
  /** State read from ARM immediately BEFORE the write. */
  readonly before: Readonly<Record<string, unknown>>;
  /** State ARM reported AFTER the write. */
  readonly after: Readonly<Record<string, unknown>>;
  readonly performedAt: string;
  /** Literal `true`. A receipt IS the record of a mutation. */
  readonly mutatedAzure: true;
}

/**
 * The per-finding recommendation lifecycle. `open` is the implicit state of a
 * finding with no document; the store only writes the others.
 *
 * This store also cures the decision-amnesia the design investigation named:
 * approve/dismiss used to be a fire-and-forget audit event, so a reload forgot
 * every decision. The proposals route now persists here too.
 */
export type RecommendationStateValue =
  | 'open'
  | 'approved'
  | 'dismissed'
  | 'staged'
  | 'performed'
  | 'failed';

/** The staged-confirm envelope carried on a `staged` state document. */
export interface StagedConfirm {
  /** SHA-256 hex of the confirm token. The raw token is never stored. */
  readonly tokenSha256: string;
  readonly detector: string;
  readonly subjectNodeId: string;
  readonly mintedAt: string;
  /** ISO-8601 expiry. A stale staging must be re-staged, not honoured. */
  readonly expiresAt: string;
}

/** One per-finding state document, as stored and as returned by the read-back. */
export interface RecommendationStateRecord {
  readonly findingId: string;
  readonly estateId: string;
  readonly state: RecommendationStateValue;
  readonly updatedAt: string;
  readonly actorOid: string;
  readonly actorUpn: string;
  readonly note?: string;
  /** The real error, verbatim, when `state === 'failed'`. */
  readonly error?: string;
  /** Present while `state === 'staged'`. */
  readonly staging?: StagedConfirm;
  /** Present when `state === 'performed'`. */
  readonly receipt?: PerformReceipt;
}

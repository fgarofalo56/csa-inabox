/**
 * LOOM BRAIN ACTIONS — MANIFEST-DERIVED OWNERSHIP BACKFILL (#4255 W2, #3922).
 *
 * ── THE PROBLEM THIS EXISTS FOR ────────────────────────────────────────────
 * Nothing on the estate carries `loom-estate-id`. Measured 2026-08-23 across
 * six subscriptions: 105 container-tier resources, ZERO tagged. Ownership is
 * the Brain's only mutation scope, so the consequence is total — every one of
 * the 17 findings is withheld, and `loom-risingwave`, which genuinely IS
 * Loom's, wears the same "ownership NOT established" banner as
 * `forzelite-dev-pgdb`, which is not. The Brain cannot prove any resource is
 * Loom's, INCLUDING ITS OWN.
 *
 * ── THE OPERATOR'S DECISION, AND WHAT IT RULES OUT ─────────────────────────
 * One click from the console, with the OPERATOR APPROVING THE LIST, candidates
 * resolved from the DEPLOY MANIFEST — never a name guess. So:
 *
 *   • No `/loom/i` over resource or RG names. Measured wrong in BOTH
 *     directions on this estate (`rg-dlz-aiml-stack-dev` holds a real Loom
 *     component and contains no "loom"; a customer called Loomis would match).
 *   • No subscription or resource-group ENUMERATION. `resolveDeployManifest`
 *     deliberately makes no `list resources` call, and neither does this: the
 *     only reliable way not to touch ten unrelated projects' resources is
 *     never to ask for them.
 *   • No widening of the ownership key to `CSA_Loom` / `csa-loom` /
 *     `loom-item`. None is estate-scoped; `loom-item` was measured claiming
 *     one resource for two unrelated estates.
 *
 * The candidate set is EXACTLY `resolveDeployManifest().entries` — the
 * established, reviewed resolution the pause path already trusts, reused
 * rather than reimplemented. Each entry names a resource this Loom install's
 * own deploy-written environment BINDS, and carries the env vars that composed
 * its id, so every row's reason is machine-readable and auditable.
 *
 * ── WHAT THE MANIFEST DOES *NOT* NAME (stated, not hidden) ─────────────────
 * The manifest names the Synapse dedicated SQL pool, the ADX cluster, the
 * Analysis Services server and the SHIR VM scale set. It does NOT name the
 * Container Apps the Brain's current findings are about. So this backfill
 * makes ownership PROVABLE for what the deploy names, and it does not by
 * itself make the 17 Container-App findings approvable — #3922 (the deploy
 * stamping the tag on every resource it creates) is what closes that, and
 * `preview.populationNote` says so on the surface rather than leaving the
 * operator to infer it from an empty list.
 *
 * ── THE PAUSE OPT-IN IS NOT THIS GATE ──────────────────────────────────────
 * `resolveDeployManifest().manifest.resourceIds` is emptied unless
 * `LOOM_ESTATE_PAUSE_ENABLED` is set. That gate exists because PAUSING is
 * cost- and availability-material (~$3,000/mo of compute, with no live resume
 * receipt). Writing a TAG is neither: it is additive, non-destructive,
 * reversible, and it is the PREREQUISITE that makes the pause path's ownership
 * check meaningful in the first place. So the candidate set reads `entries`,
 * which is ungated, and the safety here is the operator's per-resource
 * confirmation plus the server-side re-derivation below — not an env var that
 * governs a different, destructive action.
 *
 * ── NOTHING IS TRUSTED FROM THE CLIENT ─────────────────────────────────────
 * Same rule as the perform route: the client sends resource IDS, and the
 * server re-derives the whole candidate set from the manifest and a FRESH tag
 * read before writing anything. An id the fresh derivation does not produce is
 * REFUSED with the reason — a client-supplied resource id is never a target.
 */

import {
  createManifestTagReader,
  resolveDeployManifest,
  type ManifestEntry,
} from '@/lib/estate/pause-orchestrator';
import { LOOM_ESTATE_TAG_KEY, readEstateTag } from '@/lib/brain/graph';
import { armMergeTag } from './arm-tags';
import { resolveMutationEstateId } from './estate-scope';
import type { GuardRefusal } from './types';

/** Re-exported so the route and the UI name the key from one place. */
export { LOOM_ESTATE_TAG_KEY };

/**
 * What the fresh derivation established about ONE manifest-named resource.
 *
 * Only `candidate` may be tagged. The other three are all reasons NOT to, and
 * they are kept DISTINCT because collapsing them is the exact error this
 * program exists to fix — "I could not read it" is not "it is not Loom's".
 */
export type BackfillCandidateState =
  /** No `loom-estate-id` present. The tag would be ADDED. */
  | 'candidate'
  /** Already carries `loom-estate-id` = THIS estate. Nothing to do. */
  | 'already-tagged'
  /** Carries `loom-estate-id` naming a DIFFERENT estate. Never clobbered. */
  | 'foreign-estate'
  /** The tags could NOT be read. Never a candidate. */
  | 'indeterminate';

/** Why the platform believes this resource is Loom's. Machine-readable. */
export interface BackfillReason {
  /** The only source there is. Present so a consumer can assert it. */
  readonly source: 'deploy-manifest';
  /** Which manifest entry — the resource class the deploy names. */
  readonly manifestLabel: string;
  /** The exact env vars whose values composed this ARM id. */
  readonly fromEnv: readonly string[];
  /** The same fact as a sentence, for the confirmation list. */
  readonly text: string;
}

export interface BackfillCandidate {
  readonly resourceId: string;
  readonly resourceType: string;
  readonly name: string;
  readonly resourceGroup: string;
  readonly subscriptionId: string;
  readonly reason: BackfillReason;
  readonly state: BackfillCandidateState;
  /**
   * The `loom-estate-id` value ARM currently reports. `null` means READ AND
   * ABSENT; `undefined` means NOT READ (state is `indeterminate`). The two are
   * never conflated.
   */
  readonly currentEstateTag?: string | null;
  /** The full prior tag bag, when it was read. Recorded so a rollback exists. */
  readonly currentTags?: Readonly<Record<string, string>>;
  /** The verbatim read failure, when `state === 'indeterminate'`. */
  readonly readError?: string;
}

export interface BackfillPreview {
  readonly estateId: string;
  readonly tagKey: typeof LOOM_ESTATE_TAG_KEY;
  /** Every manifest-named resource, each with its state. Nothing is dropped. */
  readonly candidates: readonly BackfillCandidate[];
  /** The subset the apply would accept — `state === 'candidate'`. */
  readonly actionableResourceIds: readonly string[];
  /** How many resources the deploy env NAMES, whatever their state. */
  readonly namedByDeploy: number;
  /** Resource classes the manifest could have named but no env var did. */
  readonly unresolved: ReadonlyArray<{ readonly label: string; readonly needs: readonly string[] }>;
  /** The honest population statement — what this covers and what it does NOT. */
  readonly populationNote: string;
}

/** The apply request. The ONLY thing the client supplies. */
export interface BackfillApplyRequest {
  readonly resourceIds: readonly string[];
}

/** How one resource's apply ended. */
export type BackfillOutcomeKind =
  /** ARM confirmed the merge. */
  | 'tagged'
  /** Already carried this estate's tag; no write attempted. */
  | 'already-tagged'
  /** Server-side re-derivation rejected the id. No write attempted. */
  | 'refused'
  /** A write was attempted and did not confirm. */
  | 'failed';

/** The per-resource receipt. Real before/after, per `no-vaporware.md`. */
export interface BackfillResult {
  readonly resourceId: string;
  readonly outcome: BackfillOutcomeKind;
  /** The honest reason, verbatim, on `refused` / `failed`. */
  readonly reason?: string;
  /**
   * The `loom-estate-id` value BEFORE the write — `null` when absent. This is
   * the rollback value: restoring it (or deleting the key when `null`) undoes
   * exactly what this action did.
   */
  readonly priorEstateTag?: string | null;
  /** The full tag bag before the write, so the rollback is total, not partial. */
  readonly priorTags?: Readonly<Record<string, string>>;
  /** The full tag bag ARM reported AFTER the merge. */
  readonly afterTags?: Readonly<Record<string, string>>;
  /**
   * TRUTHFULLY stated. `true` only on a confirmed merge; `false` on a refusal
   * or an already-tagged no-op; `'unconfirmed'` when a write was attempted and
   * its outcome was not established — a failed call proves neither direction
   * (deploy-integrity R7).
   */
  readonly mutatedAzure: boolean | 'unconfirmed';
  readonly performedAt?: string;
}

export interface BackfillApplyOutcome {
  readonly estateId: string;
  readonly tagKey: typeof LOOM_ESTATE_TAG_KEY;
  readonly requested: number;
  readonly results: readonly BackfillResult[];
  readonly tagged: number;
  readonly alreadyTagged: number;
  readonly refused: number;
  readonly failed: number;
  /**
   * `true` iff at least one merge was CONFIRMED; `'unconfirmed'` when none
   * confirmed but at least one was attempted; `false` when ARM was never
   * written to at all. The audit row carries this verbatim.
   */
  readonly mutatedAzure: boolean | 'unconfirmed';
}

/** Injection seams. Every default is the real, established implementation. */
export interface BackfillDeps {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The tag read. Defaults to `createManifestTagReader()` — the 429-aware
   * reader the pause path uses for exactly these manifest entries. A THROW is
   * a failed read (`indeterminate`); `null` is also treated as a failed read,
   * because "ARM returned no tags collection" establishes nothing.
   */
  readonly readTags?: (
    resourceId: string,
  ) => Promise<Readonly<Record<string, string>> | null>;
  readonly mergeTag?: (
    resourceId: string,
    key: string,
    value: string,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly now?: () => Date;
}

/**
 * Resource class labels for the manifest's four entry types.
 *
 * This is a LABEL map, not an ownership map: an unmapped type falls back to the
 * ARM type verbatim, so a manifest entry added later is described honestly
 * rather than dropped or mislabelled. Nothing here decides whether a resource
 * is Loom's — `resolveDeployManifest` already did that, from the env.
 */
const MANIFEST_LABELS: Readonly<Record<string, string>> = {
  'microsoft.synapse/workspaces/sqlpools': 'Synapse dedicated SQL pool',
  'microsoft.kusto/clusters': 'Azure Data Explorer cluster',
  'microsoft.analysisservices/servers': 'Azure Analysis Services server',
  'microsoft.compute/virtualmachinescalesets': 'Self-hosted integration runtime (VMSS)',
};

function labelFor(resourceType: string): string {
  return MANIFEST_LABELS[resourceType.toLowerCase()] ?? resourceType;
}

function reasonFor(entry: ManifestEntry): BackfillReason {
  const label = labelFor(entry.resourceType);
  return {
    source: 'deploy-manifest',
    manifestLabel: label,
    fromEnv: entry.fromEnv,
    text:
      `This deployment's own environment names it: the ${label} '${entry.name}' in ` +
      `resource group '${entry.resourceGroup}' (subscription ${entry.subscriptionId}). ` +
      `Its ARM id was composed from ${entry.fromEnv.join(', ')} — values the platform ` +
      'bicep writes onto this console at deploy time. No name matching and no ' +
      'subscription enumeration was involved.',
  };
}

/** ARM ids are case-insensitive; compare them that way, everywhere. */
function idKey(resourceId: string): string {
  return resourceId.trim().toLowerCase();
}

/**
 * Read one entry's tags and classify it. A read that throws — or that returns
 * no tags collection at all — is INDETERMINATE, never a candidate. That
 * distinction is the same one the pause path's `discoverFromManifest` encodes,
 * and it is load-bearing in both: acting on a resource whose state could not be
 * established is exactly the failure the ownership program exists to prevent.
 */
async function classifyEntry(
  entry: ManifestEntry,
  estateId: string,
  readTags: NonNullable<BackfillDeps['readTags']>,
): Promise<BackfillCandidate> {
  const base = {
    resourceId: entry.resourceId,
    resourceType: entry.resourceType,
    name: entry.name,
    resourceGroup: entry.resourceGroup,
    subscriptionId: entry.subscriptionId,
    reason: reasonFor(entry),
  } as const;

  let tags: Readonly<Record<string, string>> | null;
  try {
    tags = await readTags(entry.resourceId);
  } catch (e) {
    return {
      ...base,
      state: 'indeterminate',
      readError:
        `The current tags of '${entry.name}' could NOT be read from ARM: ` +
        `${e instanceof Error ? e.message : String(e)}. This says the tags were NOT ` +
        'READ — it does not say the resource is untagged, and it does not say it is ' +
        'not Loom’s. Nothing will be written to it.',
    };
  }
  if (tags === null) {
    return {
      ...base,
      state: 'indeterminate',
      readError:
        `The ARM read of '${entry.name}' returned no tags collection, so its current ` +
        'tag state is UNKNOWN. Nothing will be written to it.',
    };
  }

  const current = readEstateTag(tags) ?? null;
  if (current === null) {
    return { ...base, state: 'candidate', currentEstateTag: null, currentTags: tags };
  }
  if (current === estateId) {
    return { ...base, state: 'already-tagged', currentEstateTag: current, currentTags: tags };
  }
  return { ...base, state: 'foreign-estate', currentEstateTag: current, currentTags: tags };
}

function populationNote(entries: readonly ManifestEntry[], actionable: number): string {
  return (
    `The deploy manifest names ${entries.length} resource(s) this Loom install is bound to; ` +
    `${actionable} of them can be tagged now. THE MANIFEST NAMES ONLY the resource classes ` +
    'the console carries env vars for (the Synapse dedicated SQL pool, the ADX cluster, the ' +
    'Analysis Services server and the SHIR scale set). It does NOT name the Container Apps ' +
    'the Brain’s current findings are about, so tagging these does not by itself make those ' +
    'findings approvable — #3922 (the deploy stamping ' +
    `'${LOOM_ESTATE_TAG_KEY}' on every resource it creates) is what closes that. This is ` +
    'stated rather than implied so an empty or short list is not read as "the estate is ' +
    'already tagged".'
  );
}

/**
 * PREVIEW — resolve the candidate list. WRITES NOTHING.
 *
 * Every manifest entry is returned with a state and a reason, including the
 * ones that cannot be tagged: an operator confirming a list needs to see what
 * was considered and rejected, not only what survived.
 */
export async function previewOwnershipBackfill(
  deps: BackfillDeps = {},
): Promise<{ readonly preview: BackfillPreview } | { readonly refusal: GuardRefusal }> {
  const env = deps.env ?? process.env;
  const scope = resolveMutationEstateId(env);
  if ('refusal' in scope) return { refusal: scope.refusal };

  const { entries, unresolved, namedByDeploy } = resolveDeployManifest(env);
  const readTags = deps.readTags ?? createManifestTagReader();

  const candidates: BackfillCandidate[] = [];
  for (const entry of entries) {
    candidates.push(await classifyEntry(entry, scope.estateId, readTags));
  }
  const actionableResourceIds = candidates
    .filter((c) => c.state === 'candidate')
    .map((c) => c.resourceId);

  return {
    preview: {
      estateId: scope.estateId,
      tagKey: LOOM_ESTATE_TAG_KEY,
      candidates,
      actionableResourceIds,
      namedByDeploy,
      unresolved,
      populationNote: populationNote(entries, actionableResourceIds.length),
    },
  };
}

function refuse(resourceId: string, reason: string): BackfillResult {
  return { resourceId, outcome: 'refused', reason, mutatedAzure: false };
}

/**
 * APPLY — tag ONLY the ids the caller confirmed, and only those the SERVER's
 * own fresh derivation still produces as candidates.
 *
 * The re-derivation is the whole security argument, and it is deliberately
 * total: the manifest is re-resolved from env and every entry's tags are
 * re-read HERE, in this call, immediately before any write. A resource id the
 * client sends that the fresh derivation does not produce — because it is not
 * in the manifest at all, because its tags could not be read, because it
 * already carries this estate's tag, or because it carries ANOTHER estate's —
 * is refused with that specific reason. There is no path from a client-supplied
 * string to an ARM write.
 */
export async function applyOwnershipBackfill(
  req: BackfillApplyRequest,
  deps: BackfillDeps = {},
): Promise<{ readonly outcome: BackfillApplyOutcome } | { readonly refusal: GuardRefusal }> {
  const env = deps.env ?? process.env;
  const scope = resolveMutationEstateId(env);
  if ('refusal' in scope) return { refusal: scope.refusal };
  const estateId = scope.estateId;

  const preview = await previewOwnershipBackfill({ ...deps, env });
  if ('refusal' in preview) return preview;

  const byId = new Map<string, BackfillCandidate>();
  for (const c of preview.preview.candidates) byId.set(idKey(c.resourceId), c);

  const mergeTag = deps.mergeTag ?? armMergeTag;
  const now = deps.now ?? (() => new Date());

  const results: BackfillResult[] = [];
  const seen = new Set<string>();

  for (const raw of req.resourceIds) {
    const key = idKey(raw);
    // Idempotent within one request too: a list carrying the same id twice
    // must not produce two writes and two receipts.
    if (seen.has(key)) {
      results.push(
        refuse(
          raw,
          'REFUSED: this resource id appeared more than once in the confirmed list. It was ' +
            'processed once; the duplicate was ignored so one confirmation cannot become two ' +
            'writes. Nothing extra was changed in Azure.',
        ),
      );
      continue;
    }
    seen.add(key);

    const candidate = byId.get(key);
    if (!candidate) {
      results.push(
        refuse(
          raw,
          `REFUSED: '${raw}' is not produced by a fresh resolution of this deployment's ` +
            'deploy manifest, so the platform has no evidence it belongs to this Loom ' +
            'install. The server re-derives the whole candidate set from its own environment ' +
            'and never accepts a client-supplied resource id as a target. Nothing was ' +
            'changed in Azure.',
        ),
      );
      continue;
    }

    if (candidate.state === 'indeterminate') {
      results.push(
        refuse(
          candidate.resourceId,
          `REFUSED: ${candidate.readError ?? 'the current tags could not be read'} A resource ` +
            'whose state could not be established is never tagged — "I could not read it" is ' +
            'not "it is not Loom’s", and acting on the difference is the failure this whole ' +
            'program exists to fix. Nothing was changed in Azure.',
        ),
      );
      continue;
    }

    if (candidate.state === 'foreign-estate') {
      results.push(
        refuse(
          candidate.resourceId,
          `REFUSED: '${candidate.name}' already carries ${LOOM_ESTATE_TAG_KEY}=` +
            `'${candidate.currentEstateTag}', which names a DIFFERENT Loom estate from ` +
            `'${estateId}'. Overwriting it would transfer another estate's resource to this ` +
            'one silently. Nothing was changed in Azure.',
        ),
      );
      continue;
    }

    if (candidate.state === 'already-tagged') {
      // The idempotence arm: re-running the backfill writes nothing the second
      // time and says so, rather than re-issuing a merge that would produce a
      // receipt for a change that did not happen.
      results.push({
        resourceId: candidate.resourceId,
        outcome: 'already-tagged',
        reason:
          `'${candidate.name}' already carries ${LOOM_ESTATE_TAG_KEY}='${estateId}'. No write ` +
          'was attempted.',
        priorEstateTag: candidate.currentEstateTag ?? null,
        ...(candidate.currentTags ? { priorTags: candidate.currentTags } : {}),
        mutatedAzure: false,
      });
      continue;
    }

    // state === 'candidate' — the only path to a write.
    try {
      const after = await mergeTag(candidate.resourceId, LOOM_ESTATE_TAG_KEY, estateId);
      results.push({
        resourceId: candidate.resourceId,
        outcome: 'tagged',
        priorEstateTag: null,
        ...(candidate.currentTags ? { priorTags: candidate.currentTags } : {}),
        afterTags: after,
        mutatedAzure: true,
        performedAt: now().toISOString(),
      });
    } catch (e) {
      results.push({
        resourceId: candidate.resourceId,
        outcome: 'failed',
        reason: e instanceof Error ? e.message : String(e),
        priorEstateTag: null,
        ...(candidate.currentTags ? { priorTags: candidate.currentTags } : {}),
        // A failed call establishes NEITHER outcome. Saying `false` here would
        // be a claim the code did not verify (R7).
        mutatedAzure: 'unconfirmed',
      });
    }
  }

  const tagged = results.filter((r) => r.outcome === 'tagged').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  return {
    outcome: {
      estateId,
      tagKey: LOOM_ESTATE_TAG_KEY,
      requested: req.resourceIds.length,
      results,
      tagged,
      alreadyTagged: results.filter((r) => r.outcome === 'already-tagged').length,
      refused: results.filter((r) => r.outcome === 'refused').length,
      failed,
      mutatedAzure: tagged > 0 ? true : failed > 0 ? 'unconfirmed' : false,
    },
  };
}

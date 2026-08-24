/**
 * BFF — /api/admin/brain/history  (W9, #3935)
 *
 * The change feed under the Brain's graph. `GET` reads the retained history and
 * answers "what changed?"; `POST` records the current graph as a version, if and
 * only if it differs from the last one.
 *
 * ── WHY THE VERBS SPLIT THIS WAY ───────────────────────────────────────────
 * `GET` is SAFE — it never writes, not even an observation. A read endpoint that
 * appends is a read endpoint that a prefetch, a retry or a health probe silently
 * drives, and the resulting history records the polling schedule rather than the
 * estate. `POST` is the only writer.
 *
 * The consequence is stated rather than hidden: nothing in the deployed console
 * calls `POST` yet, so on a fresh estate this endpoint honestly reports an EMPTY
 * history rather than pretending the current snapshot is a change. Wiring a
 * caller (the Brain surface on load, or a scheduled job) is tracked separately —
 * it needs a file this work item does not own.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────
 * `withTenantAdmin` from `@/lib/api/route-toolkit`, never an inline check.
 * `requireTenantAdmin` returns `NextResponse | null`, so in the hand-rolled form
 *
 *     const gate = requireTenantAdmin(session);
 *     if (gate) return gate;          // <- THE AUTHORIZATION IS THIS LINE
 *
 * the entire enforcement is the caller's `if`. Deleting that one line on
 * 2026-08-07 defeated authorization on a subscription-scoped ARM deploy path
 * while three merge-blocking controls stayed green. The wrapper removes the
 * value a caller can drop: the handler is an ARGUMENT to the gate, so there is
 * no way to keep the wrapper and skip the check.
 * `lib/brain/history/__tests__/route-authz.test.ts` exercises the REAL wrapper
 * and goes RED when that line is removed; the RCs are in the PR body.
 *
 * ── R7: A FAILURE SAYS WHAT IT ESTABLISHED ─────────────────────────────────
 * A corrupt stored version, an unknown base id and an unconfigured Cosmos
 * endpoint are three DIFFERENT states with three different remediations, and
 * none of them is "no changes". Each returns its own status and its own message.
 * An empty history rendered as a clean estate is the exact shape of the
 * 2026-08-05 incident.
 *
 * ── RECOMMEND-ONLY ─────────────────────────────────────────────────────────
 * Nothing reachable from this handler mutates Azure. The only Azure calls in the
 * tree are the read-only Resource Graph query and Cosmos writes to this
 * estate's own history container.
 */

import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiError, apiHonestError, apiOk, apiServerError } from '@/lib/api/respond';
import { resolveEstateId } from '@/lib/estate/pause-orchestrator';
import { collectEstate, ResourceGraphCollectionError } from '../_lib/arg-collect';
import { buildLiveGraph } from '../_lib/live-graph';
import {
  buildHistory,
  captureGraphVersion,
  diffVersions,
  edgeProvenanceChanged,
  edgesAddedSince,
  edgesAddedSincePrevious,
  nodeUnreachableForConsecutiveVersions,
  publicExposureGained,
  toSummary,
  GraphVersionIntegrityError,
  GraphVersionTooLargeError,
  UnknownBaseVersionError,
  type GraphHistoryStore,
} from '@/lib/brain/history';
import type { EdgeProvenance } from '@/lib/brain/graph';
import {
  BrainHistoryNotConfiguredError,
  CosmosGraphHistoryStore,
} from '@/lib/brain/history/cosmos-store';

/** Always fresh: a cached change feed is a change feed that misses the change. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * How many versions the read path loads with content.
 *
 * Bounded on purpose. The retention ceiling is 50 and loading all 50 graphs to
 * answer "what changed since last time?" would cost RU for data the answer does
 * not use. The consecutive-unreachable window is capped to this too, and the
 * cap is REPORTED in the population rather than silently applied.
 */
const READ_WINDOW = 8;

/** Default depth for the safe-prune predicate. */
const DEFAULT_CONSECUTIVE = 3;

function store(): GraphHistoryStore {
  return new CosmosGraphHistoryStore();
}

/**
 * Which provenances the capture actually COLLECTED.
 *
 * Read from `buildLiveGraph`'s own coverage report rather than assumed, because
 * a diff between two versions that disagree on coverage would report a whole
 * provenance as added or removed. `live-graph.ts` is the one place that knows —
 * the console image contains neither bicep nor the repo sources.
 */
function collectedFrom(coverage: Record<string, { collected: boolean }>): EdgeProvenance[] {
  return (Object.keys(coverage) as EdgeProvenance[]).filter((p) => coverage[p]?.collected === true);
}

function intOrDefault(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Turn a history-layer throw into an honest HTTP answer.
 *
 * Each of these is a DIFFERENT state, and none of them is "no changes":
 * a version that failed verification (the diff was refused, deliberately), a
 * base id that is not retained (refusing beats reporting the whole estate as
 * new), a graph too large for one atomic document, and a deployment with no
 * Cosmos endpoint.
 */
function honestly(e: unknown) {
  if (e instanceof GraphVersionIntegrityError) {
    return apiHonestError(
      e,
      500,
      `${e.message} Remediation: delete version '${e.versionId}' from the ` +
        'brain-graph-versions container; the next capture will re-establish a base. ' +
        'NO change verdict is being shown.',
    );
  }
  if (e instanceof UnknownBaseVersionError) {
    return apiError('unknown_base_version', 400, { detail: e.message, available: e.available });
  }
  if (e instanceof GraphVersionTooLargeError) {
    return apiHonestError(e, 507, e.message);
  }
  if (e instanceof BrainHistoryNotConfiguredError) {
    return apiHonestError(e, 503, e.message);
  }
  if (e instanceof ResourceGraphCollectionError) {
    return apiHonestError(
      e,
      e.status === 403 || e.status === 401 ? 403 : 503,
      `${e.message} (Azure Resource Graph status ${e.status}). The console identity needs ` +
        'Reader on the subscriptions to be reported. NO graph was captured and no change ' +
        'verdict has been drawn.',
    );
  }
  return apiServerError(e);
}

/**
 * GET — read the retained history and answer "what changed?".
 *
 * Query parameters:
 *   `base`        a retained version id to diff the head against. Defaults to
 *                 the version immediately before the head.
 *   `consecutive` depth for the safe-prune predicate (>= 2). Default 3.
 */
export const GET = withTenantAdmin(async (req: NextRequest) => {
  try {
    const estateId = resolveEstateId();
    const s = store();
    const summaries = await s.listSummaries(estateId);
    const params = req.nextUrl.searchParams;

    const retention = {
      maxVersions: s.policy.maxVersions,
      ttlSeconds: s.policy.ttlSeconds,
      maxDocumentBytes: s.policy.maxDocumentBytes,
      note:
        `history is bounded two ways: at most ${s.policy.maxVersions} versions per estate ` +
        `(enforced on every write) and a ${s.policy.ttlSeconds}-second container TTL as the ` +
        'backstop for an estate that stops being captured.',
    };

    // The honest empty state. NOT "no changes" — no basis. The population says
    // so, and the note says what to do about it.
    if (summaries.length === 0) {
      return apiOk({
        estateId,
        versions: [],
        retention,
        population: {
          versionsRetained: 0,
          versionsExamined: 0,
          versionsIgnoredByFormat: 0,
          nodesPerVersion: [],
          edgesPerVersion: [],
          blind: true,
          scope: 'no graph version has been captured for this estate',
        },
        note:
          'NO versions are retained for this estate, so no change verdict is possible. This is ' +
          'not a clean estate — it is an empty history. POST to this endpoint to record the ' +
          'first version.',
      });
    }

    const loaded = await s.loadRecent(estateId, READ_WINDOW);
    const history = buildHistory(estateId, loaded, summaries.length);

    if (history.versions.length < 2) {
      return apiOk({
        estateId,
        versions: summaries,
        head: toSummary(history.versions[history.versions.length - 1]),
        retention,
        population: {
          versionsRetained: summaries.length,
          versionsExamined: history.versions.length,
          versionsIgnoredByFormat: history.ignoredByFormat,
          nodesPerVersion: history.versions.map((v) => v.counts.nodes),
          edgesPerVersion: history.versions.map((v) => v.counts.edges),
          blind: true,
          scope: 'a single comparable version — no basis for a change verdict',
        },
        note:
          'only one comparable version is retained, so nothing can be reported as new. A ' +
          'second capture is required before "new since last version" means anything.',
      });
    }

    const head = history.versions[history.versions.length - 1];
    const baseParam = params.get('base');
    const since = baseParam !== null ? edgesAddedSince(history, baseParam) : edgesAddedSincePrevious(history);
    // `edgesAddedSincePrevious` is null only below two versions, handled above.
    if (since === null) return apiServerError(new Error('unreachable: history shorter than 2'));

    const base = history.versions.find((v) => v.id === since.sinceVersionId);
    if (base === undefined) return apiServerError(new Error('unreachable: base not in window'));

    const diff = diffVersions(base, head, {
      versionsRetained: summaries.length,
      versionsIgnoredByFormat: history.ignoredByFormat,
    });

    const consecutive = intOrDefault(params.get('consecutive'), DEFAULT_CONSECUTIVE, 2, READ_WINDOW);
    const unreachable = nodeUnreachableForConsecutiveVersions(history, consecutive);

    return apiOk({
      estateId,
      versions: summaries,
      head: toSummary(head),
      base: toSummary(base),
      diff,
      // The shape W8 (#3934) needs to paint "new" on the canvas: ids that join
      // straight back to the live graph and to a Finding's evidence chain.
      newEdges: since.added,
      changedEdges: since.changed,
      newNodes: since.nodesAdded,
      provenanceChanges: edgeProvenanceChanged(base, head),
      exposureGained: publicExposureGained(diff),
      unreachableForConsecutiveVersions: {
        required: unreachable.required,
        provenance: unreachable.provenance,
        minSpanMs: unreachable.minSpanMs,
        spanMs: unreachable.spanMs,
        nodes: unreachable.nodes,
        notes: unreachable.notes,
        population: unreachable.population,
      },
      retention,
      population: diff.population,
      readWindow: READ_WINDOW,
      note:
        summaries.length > READ_WINDOW
          ? `${summaries.length} versions are retained; the newest ${READ_WINDOW} were loaded ` +
            'with content. Version metadata is complete; the queries above range over the window.'
          : 'every retained version was loaded with content.',
    });
  } catch (e) {
    return honestly(e);
  }
});

/**
 * POST — capture the current graph as a version.
 *
 * Writes ONLY when the graph semantically changed. An unchanged estate returns
 * `status: 'unchanged'` with the reason, having written nothing but an
 * observation counter.
 */
export const POST = withTenantAdmin(async () => {
  try {
    const estateId = resolveEstateId();
    const collection = await collectEstate();
    const live = buildLiveGraph(collection.rows, { estateId });

    const result = await captureGraphVersion({
      graph: live.graph,
      store: store(),
      estateId,
      collectedProvenances: collectedFrom(live.coverage),
      source: 'api:POST /api/admin/brain/history',
    });

    return apiOk({
      estateId,
      status: result.status,
      unchangedReason: result.unchangedReason,
      version: toSummary(result.version),
      bytes: result.bytes,
      pruned: result.pruned,
      population: result.population,
      notes: result.notes,
      collection: {
        rowsFetched: collection.stats.rowsFetched,
        totalRecords: collection.stats.totalRecords,
        complete: collection.stats.complete,
        subscriptionsSeen: collection.stats.subscriptionsSeen,
        cloud: collection.stats.cloud,
      },
      // An INCOMPLETE pull must never be silently recorded as the estate: every
      // resource in the unread remainder would look deleted on the next diff.
      warning: collection.stats.complete
        ? null
        : 'the Resource Graph pull was INCOMPLETE, so this version records a partial estate. ' +
          'A later complete pull will diff against it and report the missing resources as ' +
          'ADDITIONS. Treat the next diff with suspicion.',
      mutatedAzure: false,
    });
  } catch (e) {
    return honestly(e);
  }
});

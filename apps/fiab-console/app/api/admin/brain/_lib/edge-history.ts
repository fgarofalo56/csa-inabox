/**
 * LOOM BRAIN — THE "NEW EDGE" LANE.
 *
 * PRP §3.7: "Growth is when new risk appears. A newly added route with no
 * authorization edge, a new env var carrying a secret to a new consumer, a newly
 * public endpoint — each is a NEW EDGE, and the Brain diffs the graph across
 * time."
 *
 * ── WHAT THIS FILE USED TO SAY, AND WHY IT NO LONGER DOES ────────────────
 *
 * It returned `{ available: false }` unconditionally with the reason "graph
 * versioning is W9 (#3935) and has not landed". #3935 landed on 2026-08-24:
 * `lib/brain/history` persists versions through `CosmosGraphHistoryStore`, and
 * `app/api/admin/brain/history` already reads them. The refusal outlived the
 * fact that justified it, so it is replaced by a real read rather than softened.
 *
 * ── THE TEMPTING WRONG ANSWERS, BOTH STILL REFUSED ───────────────────────
 *
 * Treat "no history" as an empty previous set: every edge is then new, the canvas
 * lights up entirely, and the label is a lie on the first run and every run
 * after. Treat it as "everything is old": the same lie with the sign flipped, and
 * worse, because it reads as a reassuring "nothing changed". So an absent,
 * unreachable or too-thin history is `available: false` with a reason that names
 * WHICH of those it is — never a set.
 *
 * ── WHY TWO VERSIONS ARE REQUIRED, NOT ONE ───────────────────────────────
 *
 * The baseline is the version immediately BEFORE the head, matching
 * `queries.ts#edgesAddedSincePrevious` and the default question the history route
 * answers. With a single retained version there is no version before the head, so
 * there is no baseline at all — the same state `history/route.ts` already reports
 * as "only one comparable version is retained, so nothing can be reported as
 * new". Answering it from the lone version would compare the live graph against a
 * capture that may be seconds old and report a true statement about the capture
 * schedule rather than about the estate.
 *
 * ── CLOUD PARITY ─────────────────────────────────────────────────────────
 *
 * The store is `CosmosGraphHistoryStore`, whose endpoint comes from the value the
 * platform bicep emits for EVERY boundary. There is no Commercial-only path here:
 * the same code runs in GCC, GCC-High, IL5 and DoD, and a boundary whose deploy
 * has not emitted the endpoint reaches the honest `not configured` refusal below
 * rather than a silent empty answer.
 */

import type { EdgeHistory } from './synapse-wire';
import { resolveEstateId } from '@/lib/estate/pause-orchestrator';
import { buildHistory, type GraphHistoryStore } from '@/lib/brain/history';
import {
  BrainHistoryNotConfiguredError,
  CosmosGraphHistoryStore,
} from '@/lib/brain/history/cosmos-store';

/**
 * How many versions the read pulls with content.
 *
 * Two is all this lane needs — it reads ONE version's edge ids — but a format
 * mismatch on the head would discard one of them, so the window is widened to
 * match `history/route.ts`'s `READ_WINDOW`. The two surfaces then range over the
 * same set and cannot disagree about what "the previous version" is.
 */
const READ_WINDOW = 8;

/**
 * Quoted by the tests and by the surface when the deployment has no history at
 * all. It is ONE of several reasons this lane can be unavailable — a caller must
 * read `history.reason`, never assume this string.
 */
export const NO_EDGE_HISTORY_REASON =
  'This deployment has captured fewer than two graph versions, so "new since the last version" ' +
  'cannot be answered: the baseline is the version BEFORE the head, and there is none. Nothing ' +
  'on the canvas is marked NEW and nothing is marked UNCHANGED — with one snapshot both claims ' +
  'would be invented. What is drawn is the CURRENT snapshot only. POST to ' +
  '/api/admin/brain/history to record a version.';

export interface EdgeHistoryOptions {
  /** Injected by the tests; production uses the Cosmos store. */
  readonly store?: GraphHistoryStore;
  readonly estateId?: string;
}

/**
 * The previous graph version's edge ids, if this deployment has one.
 *
 * Never throws. Every failure mode — an unconfigured endpoint, a Cosmos error, a
 * history too thin to carry a baseline — becomes an `available: false` carrying
 * its OWN reason, because collapsing them into one message would assert a cause
 * the code did not establish (deploy-integrity R7).
 */
export async function loadEdgeHistory(options: EdgeHistoryOptions = {}): Promise<EdgeHistory> {
  const estateId = options.estateId ?? resolveEstateId();
  const store = options.store ?? new CosmosGraphHistoryStore();

  let loaded;
  try {
    loaded = await store.loadRecent(estateId, READ_WINDOW);
  } catch (e) {
    if (e instanceof BrainHistoryNotConfiguredError) {
      return {
        available: false,
        reason:
          'The Brain graph history store is not reachable from this deployment, so "new since ' +
          `the last version" could not be answered. ${e.message} Nothing on the canvas is ` +
          'marked NEW and nothing is marked UNCHANGED — this is NOT "no changes", it is "not ' +
          'evaluated".',
      };
    }
    return {
      available: false,
      reason:
        'Reading the Brain graph history FAILED, so "new since the last version" could not be ' +
        `answered: ${e instanceof Error ? e.message : String(e)}. This is NOT "no changes" — no ` +
        'baseline was read, so nothing on the canvas is marked NEW or UNCHANGED. The failure is ' +
        'reported rather than swallowed because an empty set here would paint every edge as new.',
    };
  }

  // `buildHistory` discards versions whose format differs from the head's, and
  // COUNTS the discard. A format bump that leaves one comparable version must
  // reach the refusal below, not be papered over with the raw loaded length.
  const history = buildHistory(estateId, loaded, loaded.length);
  if (history.versions.length < 2) {
    return {
      available: false,
      reason:
        history.ignoredByFormat > 0
          ? `${NO_EDGE_HISTORY_REASON} ${history.ignoredByFormat} retained version(s) were ` +
            'discarded because their storage format differs from the head\'s, so the comparable ' +
            'history is shorter than the retained one.'
          : NO_EDGE_HISTORY_REASON,
    };
  }

  // The version immediately BEFORE the head — `edgesAddedSincePrevious`'s
  // baseline, so the canvas and the history route answer the same question.
  const previous = history.versions[history.versions.length - 2];
  return {
    available: true,
    previousGeneratedAt: previous.capturedAt,
    previousEdgeIds: previous.content.edges.map((e) => e.id as string),
  };
}

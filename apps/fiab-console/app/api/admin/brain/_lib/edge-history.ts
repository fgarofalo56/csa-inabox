/**
 * LOOM BRAIN — THE "NEW EDGE" LANE, AND WHY IT IS HONEST ABOUT BEING EMPTY.
 *
 * PRP §3.7: "Growth is when new risk appears. A newly added route with no
 * authorization edge, a new env var carrying a secret to a new consumer, a newly
 * public endpoint — each is a NEW EDGE, and the Brain diffs the graph across
 * time."
 *
 * A diff needs two graphs. Graph versioning is W9 (#3935) and has not landed:
 * nothing in this deployment persists a previous `BrainSnapshot`, so there is no
 * prior edge set to subtract.
 *
 * ── THE TEMPTING WRONG ANSWER ────────────────────────────────────────────
 *
 * Treat "no history" as an empty previous set. Every edge is then new, the canvas
 * lights up entirely, and the label is a lie on the first run and every run after
 * it until history exists. The opposite shortcut — treat "no history" as
 * "everything is old" — is the same lie with the sign flipped, and it is worse,
 * because it reads as a reassuring "nothing changed".
 *
 * So the state is neither: `available: false`, and the surface renders the lane
 * as NOT EVALUATED with the issue number that would make it evaluable. Nothing on
 * the canvas is marked new, and nothing is marked unchanged.
 */

import type { EdgeHistory } from './synapse-wire';

/** Named once so the route, the UI and the tests quote the same sentence. */
export const NO_EDGE_HISTORY_REASON =
  'This deployment stores no previous graph version, so "new since the last version" cannot be ' +
  'answered — graph versioning is Loom Brain W9 (#3935). Nothing on the canvas is marked NEW and ' +
  'nothing is marked UNCHANGED: with one snapshot, both claims would be invented. What is drawn ' +
  'is the CURRENT snapshot only.';

/**
 * The previous graph version, if this deployment has one.
 *
 * Always unavailable today. When #3935 lands, this returns the stored edge id set
 * and the timestamp it was taken at; every consumer already handles that branch.
 */
export function loadEdgeHistory(): EdgeHistory {
  return { available: false, reason: NO_EDGE_HISTORY_REASON };
}

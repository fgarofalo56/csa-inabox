/**
 * LOOM BRAIN — cost, population reporting.
 *
 * PRP §3.2, non-negotiable: "A detector that returns zero findings must report
 * the population it examined. A detector over an empty node set is green and
 * blind — that failure has been found repeatedly in this repo."
 *
 * The graph substrate's {@link Population} in `../types` is GRAPH-shaped: it
 * counts nodes and edges, and derives `blind` from whichever of the two the
 * query ranged over. The cost layer ranges over things that are neither — CSV
 * ROWS in an export partition, PARTITIONS listed in a manifest, RATE CARD
 * ENTRIES. Reporting "0 nodes examined" for a reader that parsed 40 000 rows
 * and attributed none of them would be a true statement about the wrong set,
 * which is worse than no statement.
 *
 * So this module supplies the same discipline over the cost layer's own
 * subjects, and `./attribute` reports BOTH: a `ReadPopulation` for the rows it
 * parsed, and the substrate's `Population` for the graph nodes it attributed
 * onto. Neither substitutes for the other.
 *
 * THE ONE RULE CARRIED OVER VERBATIM: `blind` is DERIVED from `examined`, never
 * passed in. A caller cannot hand-wave an empty set into a confident answer.
 *
 * PURE. No I/O.
 */

/** What a cost-layer read ranged over. */
export type ReadSubject =
  /** CSV data rows (header excluded) across every partition supplied. */
  | 'rows'
  /** Blob partitions of one export run. */
  | 'partitions'
  /** Azure resource nodes a cost was attributed onto. */
  | 'resources'
  /** Entries in a rate card. */
  | 'rates';

/**
 * WHAT WAS EXAMINED, for a cost-layer read.
 *
 * Mirrors {@link Population} deliberately — same field names, same `blind`
 * semantics — so a reader who has internalised one does not have to learn a
 * second vocabulary.
 */
export interface ReadPopulation {
  readonly subject: ReadSubject;
  /** Items in scope BEFORE any predicate ran. */
  readonly examined: number;
  /** Plain-English scope, e.g. "3 partition(s) of export 'loom-brain-daily'". */
  readonly scope: string;
  /**
   * True iff `examined === 0`. A verdict over an empty population establishes
   * NOTHING; callers must render this rather than hide it behind a green tick
   * or a `$0.00`.
   */
  readonly blind: boolean;
}

/**
 * Build a {@link ReadPopulation}. `blind` is derived here and only here.
 */
export function makeReadPopulation(args: {
  subject: ReadSubject;
  examined: number;
  scope: string;
}): ReadPopulation {
  return {
    subject: args.subject,
    examined: args.examined,
    scope: args.scope,
    blind: args.examined === 0,
  };
}

/**
 * Render a population for a log line or a UI caption. Always states the count,
 * and says so LOUDLY when it is zero — the whole point is that a verdict cannot
 * be quoted without the size of the set it was computed over.
 */
export function describeReadPopulation(p: ReadPopulation): string {
  return p.blind
    ? `BLIND — 0 ${p.subject} examined (${p.scope}). This establishes nothing.`
    : `${p.examined} ${p.subject} examined (${p.scope}).`;
}

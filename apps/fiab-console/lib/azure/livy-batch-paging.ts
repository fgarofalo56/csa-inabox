/**
 * Paging + recency navigation for the Synapse Livy `/batches` list.
 *
 * Split out of `synapse-dev-client.ts` (#3568 / PR #3689 review): this is the
 * part with the actual algorithm in it, and it is pure — every function here
 * takes its HTTP as a {@link FetchBatchPage} callback rather than reaching for
 * a credential, so the walk can be exercised directly against a page server
 * without standing up the dev-endpoint client. `synapse-dev-client.ts` keeps
 * the transport and binds it to these walkers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT `total` MEANS, AND WHY THIS FILE REFUSES TO GUESS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Both walkers below used to navigate by offset arithmetic on the `total` a
 * page reports, which is only sound if `total` counts the batches the POOL
 * holds (Apache Livy's `"total" -> sessionManager.size()`).
 *
 * Synapse does not document it that way. The Azure REST spec that generates
 * every Synapse Spark SDK — `specification/synapse/data-plane/
 * Microsoft.Synapse/preview/2019-11-01-preview/sparkJob.json` — describes
 * `SparkBatchJobCollection` as:
 *
 *     from    "The start index of fetched sessions."
 *     total   "Number of sessions fetched."
 *     sessions "Batch list"
 *
 * "Number of sessions FETCHED" is the length of the page in your hand, not the
 * size of the pool. That single swagger is why the JS, Java and .NET reference
 * pages all carry the identical sentence — they are generated from it.
 *
 * We cannot settle which behaviour the live service actually exhibits from
 * source alone, and a wrong guess is not a cosmetic bug:
 *
 *   pool of 137, ascending ids, `limit = 20`
 *   ├─ pool-wide reading  → tailFrom = 137-20 = 117 → probe both ends → newest
 *   └─ page-length reading → tailFrom = max(0, 20-20) = 0 → "it all fits"
 *                            shortcut → the OLDEST 20 rows, truncatedBy: null
 *
 * So this file does not pick a reading. It uses `total` ONLY where the two
 * readings cannot disagree — see {@link readTotal} — and otherwise falls
 * through to the walk-to-the-end path.
 *
 * WHAT THAT BUYS, STATED PRECISELY — "correct under both readings" would be an
 * over-claim, so it is not made:
 *
 *   Reading A (pool-wide).  `total > page length` on any pool holding more than
 *     one page, so the offset probe runs exactly as before: CORRECT, and with
 *     no extra requests.
 *   Reading B (page length). `readTotal` returns null for every page, so every
 *     call walks to the end. Correct only while the end is REACHABLE, and
 *     `LIVY_MAX_WALK_PAGES` caps that at 10 x 20 = 200 rows. On a 1000-batch
 *     pool the walk stops at batch #199 and returns ids #180-199 with
 *     `truncatedBy: 'pages'`. Those are not the newest 20 — so the answer is
 *     CORRECT-OR-DISCLOSED-INCOMPLETE, not correct.
 *
 * That distinction is the whole point of the truncation signal, and it is only
 * honest as far as the caller carries it: a surface that renders `sessions` and
 * drops `truncatedBy` turns reading B's disclosed partial back into a silent
 * wrong answer. Callers MUST surface it (`RecentSparkBatchJobs.truncatedBy`).
 */

import {
  PagingBudget,
  PAGE_DEADLINE,
  type PagingBudgetOptions,
  type PagingTruncation,
} from './paging-budget';

export interface SparkBatchJob {
  id: number;
  livyInfo?: { currentState?: string; jobCreationRequest?: unknown };
  name?: string;
  state?: string;
  appId?: string | null;
  artifactId?: string;
  result?: 'Uncertain' | 'Succeeded' | 'Failed' | 'Cancelled';
  schedulerInfo?: unknown;
  log?: string[];
  submitterId?: string;
  submitterName?: string;
  pluginInfo?: unknown;
  errorInfo?: unknown[];
  tags?: Record<string, string>;
  workspaceName?: string;
  sparkPoolName?: string;
  submittedAt?: string;
  jobType?: string;
}

/** The Livy batch SUBMIT body (POST /batches). Pure shape, no transport. */
export interface SparkBatchRequest {
  name: string;
  file: string;                 // wasbs://… or abfss://… URI to JAR / .py
  className?: string;
  args?: string[];
  jars?: string[];
  pyFiles?: string[];
  files?: string[];
  archives?: string[];
  conf?: Record<string, string>;
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  numExecutors?: number;
  tags?: Record<string, string>;
}

// The Synapse Livy batches list endpoint documents `size` as "By default it is
// 20 and that is the maximum" and 400s above it — see #3568 and
// https://learn.microsoft.com/rest/api/synapse/data-plane/spark-batch/get-spark-batch-jobs
// Before this fix the cap was left to each caller to enforce: two call sites
// hardcoded an over-cap literal (100, 25) and two forwarded an unvalidated
// caller/query-string value straight through, so patching only the reported
// call site would have left three other ways to reproduce the 400. The clamp
// lives HERE, at the shared walker, so every current and future caller
// inherits it for free. The sessions endpoint carries the IDENTICAL cap — see
// `LIVY_MAX_PAGE_SIZE` in synapse-livy-client.ts.
export const LIVY_MAX_PAGE_SIZE = 20;

/**
 * Hard ceiling on how many pages ONE bounded Livy walk may fetch: 10 x 20 =
 * 200 rows. Paired with the budget's wall clock (see `paging-budget.ts`) so a
 * walk is bounded BOTH ways — a page cap alone still allows 10 x 30s.
 */
export const LIVY_MAX_WALK_PAGES = 10;

/** Clamp a requested page size into [1, LIVY_MAX_PAGE_SIZE] for one Livy request. */
export function clampLivyPageSize(size: number): number {
  const n = Number.isFinite(size) ? Math.floor(size) : LIVY_MAX_PAGE_SIZE;
  return Math.min(LIVY_MAX_PAGE_SIZE, Math.max(1, n));
}

/** Sanity-clamp the Livy `from` offset to a non-negative integer. */
export function clampLivyFrom(from: number): number {
  const n = Number.isFinite(from) ? Math.floor(from) : 0;
  return Math.max(0, n);
}

export interface SparkBatchPage {
  from: number;
  total: number;
  sessions: SparkBatchJob[];
}

/**
 * Fetch ONE page of the Livy batches list. `timeoutMs` is the budget's
 * remaining wall clock and MUST be forwarded to the underlying fetch — a
 * request issued without it inherits the bare 30s default and escapes the
 * budget entirely.
 */
export type FetchBatchPage = (
  from: number,
  size: number,
  timeoutMs?: number,
) => Promise<SparkBatchPage>;

/**
 * The rows in a page, plus whether the body actually CARRIED a `sessions`
 * array.
 *
 * These two cases look identical downstream and mean opposite things:
 *
 *   `{"total":0,"sessions":[]}`  the server ran the list dry → walk COMPLETE
 *   `{"total":0}` / `{"error":…}` the server did not answer the question →
 *                                 the walk established NOTHING
 *
 * Collapsing the second into the first is how a broken backend hands back a
 * confident "no batch jobs". `livy-session-census.py` — shipped in this same
 * PR — already refuses to make that inference ("cannot distinguish an
 * exhausted list from a broken response"); this is the TypeScript side of the
 * same rule, so the two implementations no longer disagree on the one case
 * that decides whether a census reads as complete (`deploy-integrity.md` R7:
 * if the code does not know, it must not claim).
 */
export function pageRows(page: SparkBatchPage): { rows: SparkBatchJob[]; malformed: boolean } {
  return Array.isArray(page?.sessions)
    ? { rows: page.sessions, malformed: false }
    : { rows: [], malformed: true };
}

/**
 * The server's `total`, but ONLY when it is usable as a POOL-WIDE count.
 *
 * Returns **null** whenever the value is indistinguishable from the length of
 * the page it arrived on, because at that point the two documented readings —
 * Apache Livy's `sessionManager.size()` and Synapse's swagger "Number of
 * sessions fetched" — produce the same number and offset arithmetic on it is a
 * coin flip. The ONE observation that cannot happen under the page-length
 * reading is `total > sessions.length`: a page length can never exceed itself.
 * So that, and only that, is treated as evidence of a pool-wide count.
 *
 * Null is not a degraded answer here — it routes both walkers into their
 * walk-to-the-end path, which navigates by reading the list to its END rather
 * than by jumping to a computed offset. That path needs no `total` and no
 * direction, so it cannot be misled by either reading: it either reaches the
 * end (correct) or trips a ceiling and SAYS SO (`truncatedBy` non-null). Note
 * the second outcome is a disclosed partial, NOT a correct answer — see the
 * "WHAT THAT BUYS" note in this module's header for the 1000-batch case. The
 * cost is one extra (empty) request when a pool genuinely holds one page or
 * less; on the pools where paging actually matters (`total > 20` under the
 * pool-wide reading) the value is unambiguous and nothing extra is fetched.
 *
 * The caller must NOT substitute the page length instead. Doing so made `total`
 * 20 on a pool of any size, which drove `listRecentSparkBatchJobs`'s `tailFrom`
 * to `max(0, 20 - 20) = 0` and sent it down the "everything already fits in the
 * head window" branch — handing a "recent runs" grid the OLDEST 20 rows of an
 * ascending list with `truncatedBy: null`. A number we invented is worse than
 * an absent one, because it silences the truncation signal at the same time.
 */
export function readTotal(page: SparkBatchPage): number | null {
  const t = page?.total;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null;
  const { rows, malformed } = pageRows(page);
  if (malformed) return null;
  const total = Math.floor(t);
  return total > rows.length ? total : null;
}

/** Merge a page's rows into `acc`, de-duplicating by batch id. */
export function mergeBatches(acc: Map<number, SparkBatchJob>, rows: SparkBatchJob[] | undefined): void {
  for (const row of rows || []) {
    if (row && typeof row.id === 'number') acc.set(row.id, row);
    else if (row) acc.set(-1 - acc.size, row); // id-less row: keep it, never collide
  }
}

/** Highest batch id in a page (-Infinity when the page is empty). */
export function maxBatchId(rows: SparkBatchJob[] | undefined): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows || []) {
    if (row && typeof row.id === 'number' && row.id > max) max = row.id;
  }
  return max;
}

/**
 * A budgeted page reader for the Livy `/batches` list.
 *
 * Every fetch — INCLUDING THE FIRST — goes through `budget.claimPage()` +
 * `budget.runPage()`. That pairing is what actually bounds the walk in wall
 * clock: `runPage` hands the fetch the budget's REMAINING milliseconds as its
 * `timeoutMs` and absorbs the resulting `FetchTimeoutError` into a `time`
 * truncation. A fetch issued OUTSIDE `runPage` inherits
 * `DEFAULT_SERVER_FETCH_TIMEOUT_MS` (30s) instead and can therefore hang for
 * 30s on its own no matter what the budget says — which is precisely the hole
 * the first cut of #3568 left: it constructed the budget AFTER the first fetch
 * and never called `runPage` at all, so `claimPage()` was pure bookkeeping and
 * the "bounded in wall-clock time" claim was untrue.
 *
 * Returns null when the page cap or the wall clock is spent (at the loop top
 * OR mid-fetch); the caller keeps the rows it already has and reads
 * `budget.truncatedBy` for which ceiling tripped.
 *
 * Caveat, stated rather than overclaimed: TWO things sit outside the fetch
 * deadline. The transport acquires an AAD token before the HTTP call, and
 * `fetchWithTimeout` clears its timer in a `finally` as soon as `fetch`
 * resolves — i.e. once the RESPONSE HEADERS arrive — so the body read runs
 * unbounded too. The walk still terminates (the next `claimPage()` sees the
 * spent clock), but the true bound is "budget + at most one token acquisition +
 * at most one body read", not "budget" exactly. That is systemic to every
 * caller of `fetchWithTimeout`, not something this walk introduced.
 */
async function readBatchPage(
  budget: PagingBudget,
  fetchPage: FetchBatchPage,
  from: number,
  size: number,
): Promise<SparkBatchPage | null> {
  if (!budget.claimPage()) return null;
  const page = await budget.runPage((timeoutMs) => fetchPage(from, size, timeoutMs));
  return page === PAGE_DEADLINE ? null : page;
}

/** An explicit offset window of the Livy batches list, in SERVER order. */
export interface SparkBatchWindow {
  from: number;
  total: number;
  sessions: SparkBatchJob[];
  truncatedBy?: PagingTruncation | null;
}

/**
 * Read an EXPLICIT OFFSET WINDOW of the Livy batches list.
 *
 * `from` is an index into Livy's list in the order the server returns it, and
 * the rows come back in that same server order — this makes no recency claim.
 * Callers that want "the most recent runs" must use {@link walkRecentBatches};
 * asking this one for `from=0` and calling the result "recent" is a bug,
 * because Livy lists in ASCENDING batch-id order (insertion-ordered
 * `LinkedHashMap` + a monotonic id counter), so `from=0` is the OLDEST end.
 *
 * `size` is clamped to Livy's documented per-request maximum of 20; `from` is
 * sanity-clamped to a non-negative integer. A request for more than 20 walks
 * `from` forward across additional <=20-row requests, bounded BOTH by
 * `LIVY_MAX_WALK_PAGES` and by the `PagingBudget` wall clock — every fetch,
 * including the first, runs through {@link readBatchPage}. A ceiling breach
 * returns the rows collected so far (a partial run list beats a wedged request
 * path) and names itself in `truncatedBy`.
 */
export async function walkBatchWindow(
  fetchPage: FetchBatchPage,
  label: string,
  from = 0,
  size = LIVY_MAX_PAGE_SIZE,
  opts?: PagingBudgetOptions,
): Promise<SparkBatchWindow> {
  const safeFrom = clampLivyFrom(from);
  const requested = Number.isFinite(size) && size > 0 ? Math.floor(size) : LIVY_MAX_PAGE_SIZE;

  // Constructed BEFORE the first fetch — the wall clock starts here, so the
  // first page is inside the budget rather than a free 30s ahead of it.
  const budget = new PagingBudget(label, { maxPages: LIVY_MAX_WALK_PAGES, ...opts });

  const first = await readBatchPage(budget, fetchPage, safeFrom, clampLivyPageSize(requested));
  if (!first) {
    budget.warnIfTruncated(0);
    return { from: safeFrom, total: 0, sessions: [], truncatedBy: budget.truncatedBy };
  }

  const head = pageRows(first);
  const sessions = [...head.rows];
  const reportedTotal = readTotal(first);
  let nextFrom = safeFrom + sessions.length;
  // A body with no `sessions` array answered nothing, so it can neither end the
  // walk as "dry" nor let the result read as a complete window.
  let malformed = head.malformed;
  let ranDry = !malformed && sessions.length === 0;

  // `reportedTotal === null` — the server never gave us a count we can navigate
  // by (absent, or indistinguishable from this page's length), so there is no
  // upper bound to compare against and the ONLY honest stopping condition is a
  // page that comes back empty. Comparing against a fabricated total is what
  // answered a 60-row request with 20.
  while (
    sessions.length < requested &&
    !ranDry &&
    !malformed &&
    (reportedTotal === null || nextFrom < reportedTotal)
  ) {
    const page = await readBatchPage(
      budget,
      fetchPage,
      nextFrom,
      clampLivyPageSize(requested - sessions.length),
    );
    if (!page) break;
    const next = pageRows(page);
    if (next.malformed) {
      malformed = true;
      break;
    }
    if (next.rows.length === 0) {
      ranDry = true; // server ran dry — a complete walk, not a truncation
      break;
    }
    sessions.push(...next.rows);
    nextFrom += next.rows.length;
  }

  budget.warnIfTruncated(sessions.length);
  return {
    from: safeFrom,
    // When the server reported no usable total, the rows we actually saw are
    // the only count we can stand behind — a LOWER BOUND, not a claim about
    // the pool.
    total: reportedTotal ?? sessions.length,
    sessions: sessions.slice(0, requested),
    // `PagingTruncation` has only 'pages' | 'time'. A malformed page is neither
    // literally, but it lands in the same caller-visible class the budget's own
    // ceilings do — "this window is INCOMPLETE, do not read absence as
    // deletion" — and every consumer tests `truncatedBy` for truthiness.
    truncatedBy: budget.truncatedBy ?? (malformed ? 'pages' : null),
  };
}

/** What {@link walkRecentBatches} collected, and how complete it is. */
export interface RecentSparkBatchJobs {
  /** The newest `limit` batches the walk could reach, NEWEST FIRST (id desc). */
  sessions: SparkBatchJob[];
  /** The batch count the walk can stand behind — the server's when it gave a
   *  usable one, otherwise the number of distinct rows actually seen. */
  total: number;
  /** How many distinct batches the walk actually looked at. */
  scanned: number;
  /** Non-null when a ceiling cut the walk short — the window is INCOMPLETE. */
  truncatedBy?: PagingTruncation | null;
}

/**
 * Collect the MOST RECENT batch jobs, newest first.
 *
 * WHY THIS EXISTS — the defect it fixes. Livy returns its batch list in
 * ASCENDING batch-id order and `from` is an index into that ascending list, so
 * `from=0` is the OLDEST end. Verified against Apache Livy's server:
 * `SessionServlet.get("/")` slices `sessionManager.all().view(from, from+size)`,
 * `all()` is `sessions.values` over a `mutable.LinkedHashMap` (insertion
 * ordered), and ids come from a monotonic `AtomicInteger` — so index order IS
 * ascending id order IS oldest-first. Every "recent runs" surface in the
 * console was calling `from=0` and labelling the result recent. While `size`
 * was over the cap that at least failed LOUDLY with a 400; clamping `size`
 * alone would have converted the loud failure into a silent one — the grid
 * would fill with the pool's OLDEST runs under a "Runs" header. That is the
 * `no-vaporware.md` failure mode (a surface that looks right and shows the
 * wrong rows), so the clamp ships with the recency fix, not ahead of it.
 *
 * HOW IT AVOIDS TAKING THAT ORDERING ON FAITH. Synapse's Livy surface is a
 * Microsoft reimplementation, not literally Apache Livy, and its ordering is
 * not contractual in the REST reference. So this does not assume — it
 * MEASURES, per call: it reads the head window, then probes the tail window
 * (`from = total - pageSize`) and compares the highest batch id at each end.
 * Whichever end actually holds the newer ids is the end it walks. If Synapse
 * ever flipped to descending, this keeps returning the newest rows instead of
 * silently inverting. Rows are finally sorted by id descending, which is
 * authoritative regardless of the order the server chose (higher id = newer;
 * the same assumption `getLastLivyError` already relies on).
 *
 * That offset probe only runs when {@link readTotal} produced a count the two
 * documented `total` semantics cannot disagree about. Otherwise the walk reads
 * the list to its END, which needs no offset arithmetic and is correct either
 * way.
 *
 * The whole walk runs under ONE {@link PagingBudget} — page cap AND wall clock,
 * every fetch through {@link readBatchPage}. On a breach the caller gets the
 * newest rows reached so far plus a non-null `truncatedBy`, never an exception
 * and never a silently short list.
 */
export async function walkRecentBatches(
  fetchPage: FetchBatchPage,
  label: string,
  limit = LIVY_MAX_PAGE_SIZE,
  opts?: PagingBudgetOptions,
): Promise<RecentSparkBatchJobs> {
  const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : LIVY_MAX_PAGE_SIZE;
  const pageSize = clampLivyPageSize(want);
  const budget = new PagingBudget(label, { maxPages: LIVY_MAX_WALK_PAGES, ...opts });
  const collected = new Map<number, SparkBatchJob>();
  // Set by any page whose body carried no `sessions` array. Folded into every
  // return path below, because a walk that read a broken page has not
  // established what the newest rows are.
  let malformed = false;

  const finish = (total: number): RecentSparkBatchJobs => {
    budget.warnIfTruncated(collected.size);
    const sessions = [...collected.values()]
      .sort((a, b) => (b?.id ?? 0) - (a?.id ?? 0))
      .slice(0, want);
    return {
      sessions,
      total,
      scanned: collected.size,
      truncatedBy: budget.truncatedBy ?? (malformed ? 'pages' : null),
    };
  };

  const head = await readBatchPage(budget, fetchPage, 0, pageSize);
  if (!head) return finish(0);
  const headPage = pageRows(head);
  malformed = headPage.malformed;
  const headRows = headPage.rows;
  const reportedTotal = readTotal(head);

  /**
   * Read the list to its END, then return the newest `want` of everything seen.
   *
   * Used whenever there is no offset this walk can trust. It needs neither a
   * `total` nor a direction: a walk that ran dry has SEEN every batch, so the
   * newest `want` of them are genuinely the newest whatever order the server
   * chose and whatever `total` meant. If a ceiling stops it first, the rows
   * reached are returned with a non-null `truncatedBy` — a disclosed partial
   * beats a confident wrong answer.
   *
   * `total` is reported as the number of DISTINCT ROWS ACTUALLY SEEN, never the
   * server's claim. On the `tailFrom === 0` path below the server has already
   * contradicted itself (it claimed more batches than it put in a page it did
   * not fill), so echoing that claim next to a shorter list would be repeating
   * a number we just disproved.
   */
  const walkToEnd = async (): Promise<RecentSparkBatchJobs> => {
    mergeBatches(collected, headRows);
    let cursor = headRows.length;
    let ranDry = !malformed && headRows.length === 0;
    while (!ranDry && !malformed) {
      const page = await readBatchPage(budget, fetchPage, cursor, pageSize);
      if (!page) break; // ceiling — `claimPage`/`runPage` recorded which one
      const next = pageRows(page);
      if (next.malformed) {
        malformed = true;
        break;
      }
      if (next.rows.length === 0) {
        ranDry = true;
        break;
      }
      const before = collected.size;
      mergeBatches(collected, next.rows);
      cursor += next.rows.length;
      if (collected.size === before) break; // all duplicates — treat as dry
    }
    const result = finish(collected.size);
    // A walk that never reached the end has NOT established what the newest
    // rows are. `finish` only reports the budget's own ceilings plus a broken
    // page, so name the page ceiling here rather than returning a null
    // truncation.
    return ranDry ? result : { ...result, truncatedBy: result.truncatedBy ?? 'pages' };
  };

  if (reportedTotal === null) {
    // NO NAVIGABLE `total` FROM THE SERVER — it was absent, or equal to this
    // page's own length and therefore unusable as an offset. The probe below
    // navigates by offset arithmetic on `total`; without one there is no offset
    // to jump to, so the direction probe is impossible. The previous cut
    // papered over this by falling back to the page length, which made
    // `tailFrom` 0 and returned the ascending list's OLDEST rows under a
    // "recent" contract with `truncatedBy: null` — silently the exact defect
    // this function exists to remove.
    return walkToEnd();
  }

  const total = reportedTotal;

  // NO DISTINCT TAIL WINDOW EXISTS. `readTotal` returns a number ONLY when
  // `total > headRows.length`, so reaching here guarantees that — which makes
  // `tailFrom === 0` (i.e. `total <= pageSize`) mean the server reported MORE
  // batches than it put in a page it did not fill. The tail window would then
  // be byte-identical to the head, so probing it costs a budget slot and
  // decides nothing, and the forward walk that followed stopped at
  // `cursor < total` and could return short under a null truncation.
  //
  // This is NOT a hypothetical branch: a server returning a short page while
  // more rows remain is precisely the behaviour this module refuses to assume
  // away (it is why `readTotal` will not trust a short page's `total`), so it
  // gets the same treatment as having no usable `total` at all.
  //
  // A PREVIOUS CUT GUARDED THIS WITH `tailFrom === 0 && headRows.length >= total`
  // and a comment claiming the shortcut handled "everything fits in the head
  // window". That conjunct is a CONTRADICTION of `readTotal`'s postcondition,
  // so the branch was unreachable — measured: a `throw` as its first statement
  // left all 34 specs passing, and so did deleting the conjunct. Do not
  // reintroduce a fast path here; there is no reachable case for one.
  const tailFrom = Math.max(0, total - pageSize);
  if (tailFrom === 0) return walkToEnd();

  // Probe the far end and let the DATA say which end is newest. The two probe
  // pages are NOT both merged: exactly one end holds the newest rows, and
  // folding the other end's rows into the answer is how a "recent runs" grid
  // ends up padded with the pool's oldest batches once `limit` exceeds one page.
  const tail = await readBatchPage(budget, fetchPage, tailFrom, pageSize);
  if (!tail) {
    // The budget ran out before we learned which end is newest. Returning the
    // head window here would be returning the OLDEST rows under a "recent"
    // contract — the exact defect this function exists to remove — so return
    // nothing and say why. `truncatedBy` is non-null, so the caller can render
    // "couldn't reach the recent window" rather than "no runs".
    return finish(total);
  }
  const tailPage = pageRows(tail);
  if (tailPage.malformed) {
    // The direction is still unknown and the reason is a broken body, not a
    // ceiling. Same rule as the budget case above: no rows, and say so.
    malformed = true;
    return finish(total);
  }
  const newestAtTail = maxBatchId(tailPage.rows) > maxBatchId(headRows);

  if (newestAtTail) {
    // Ascending list: the newest live at the tail, so walk BACKWARD toward 0.
    mergeBatches(collected, tailPage.rows);
    let cursor = tailFrom;
    while (collected.size < want && cursor > 0) {
      const step = Math.min(pageSize, cursor);
      cursor -= step;
      const page = await readBatchPage(budget, fetchPage, cursor, step);
      if (!page) break;
      const next = pageRows(page);
      if (next.malformed) {
        malformed = true;
        break;
      }
      const before = collected.size;
      mergeBatches(collected, next.rows);
      if (collected.size === before) break; // ran dry / all duplicates
    }
  } else {
    // Descending (or a `total` that did not mean what we assumed): the newest
    // are already at the head, so walk FORWARD from it.
    mergeBatches(collected, headRows);
    let cursor = headRows.length;
    while (collected.size < want && cursor < total) {
      const page = await readBatchPage(budget, fetchPage, cursor, pageSize);
      if (!page) break;
      const next = pageRows(page);
      if (next.malformed) {
        malformed = true;
        break;
      }
      if (next.rows.length === 0) break;
      mergeBatches(collected, next.rows);
      cursor += next.rows.length;
    }
  }

  return finish(total);
}

/**
 * paging-budget — the shared ceiling for ARM / data-plane `nextLink` paging loops.
 *
 * `fetch-with-timeout.ts` bounds ONE HTTP round-trip and explicitly leaves the
 * loop that issues those round-trips to bound itself ("the poll loop itself is
 * responsible for bounding its own max-attempts"). A bare `while (nextLink)`
 * walk therefore inherits NO ceiling: N pages x the 30s per-request budget is an
 * unbounded await on a request path — exactly the invariant
 * {@link import('./fetch-with-timeout').withDeadline} exists to enforce ("every
 * await on a request path must be bounded").
 *
 * Measured cost of that gap (issue #2557): `pagedList('/connections')` on the
 * AOAI target-resolution path took **22.9 s** inside a route whose own
 * `maxDuration` is 60 — one slow ARM page could burn the entire route budget and
 * lose an answer that had already been computed.
 *
 * A budget bounds a loop TWO ways at once, because either alone leaves a hole:
 *   • a page CAP stops a cyclic / pathological `nextLink` chain (and a page that
 *     keeps returning an empty `value` with a link), but 50 pages x 30 s is
 *     still 25 minutes;
 *   • a WALL CLOCK stops slow pages — and, handed down as each page's
 *     `timeoutMs`, it bounds the very FIRST page too, which is the 22.9 s case
 *     a page cap alone would never have caught.
 *
 * On a breach the caller keeps the rows it already collected and logs one honest
 * warn line. ARM returns pages in server order and every current caller is a
 * list/picker rather than an exact inventory, so a truncated list beats a wedged
 * request path; {@link PagingBudget.truncatedBy} — and the
 * {@link walkPagedListResult} return shape that carries it — is exposed so a
 * caller that genuinely needs completeness can throw instead of silently
 * returning partial rows.
 *
 * TRUNCATE, NEVER THROW — the breach can land in TWO places and both must
 * behave the same:
 *   • at the loop top ({@link PagingBudget.claimPage} returns false), or
 *   • INSIDE a page fetch, because the remaining wall clock was handed to
 *     `fetchWithTimeout` as that page's `timeoutMs` and it aborts with a
 *     {@link FetchTimeoutError}.
 * The second case is the DOMINANT one on a genuinely slow tenant (the very
 * 22.9 s walk this exists for breaches mid-first-page, not at a loop top), so
 * {@link PagingBudget.runPage} absorbs OUR OWN deadline into a `time`
 * truncation rather than letting it propagate. A propagating exception would be
 * caught by callers that read "list call failed" as "the resource does not
 * exist" and surface a remediation for the wrong problem entirely — see
 * `copilot-orchestrator.resolveAoaiTarget`, which used to turn exactly this
 * into "Deploy a gpt-4o model first" for what was actually a paging deadline.
 * A caller that needs to FAIL on a deadline asks for it explicitly via
 * {@link PagingBudget.assertComplete} / {@link PagingDeadlineError}.
 *
 * No mocks — this only adds arithmetic around real calls.
 */

import { FetchTimeoutError } from './fetch-with-timeout';

/** Why a paged walk stopped short of its final page. */
export type PagingTruncation = 'pages' | 'time';

/**
 * Thrown ONLY when a caller explicitly asks a truncated walk to fail
 * ({@link assertComplete}). It exists so a deadline surfaces AS A DEADLINE:
 * the message names the wall clock and the knob, never a resource that might
 * be missing. Callers `instanceof`-check this to keep a slow backend from
 * being reported as an absent one.
 */
export class PagingDeadlineError extends Error {
  readonly label: string;
  readonly truncatedBy: PagingTruncation;
  readonly budgetMs: number;
  readonly maxPages: number;
  readonly pagesFetched: number;
  readonly collected: number;
  constructor(args: {
    label: string;
    truncatedBy: PagingTruncation;
    budgetMs: number;
    maxPages: number;
    pagesFetched: number;
    collected: number;
  }) {
    const knob =
      args.truncatedBy === 'pages' ? 'LOOM_ARM_PAGING_MAX_PAGES' : 'LOOM_ARM_PAGING_BUDGET_MS';
    super(
      `Listing ${args.label} hit its ${args.truncatedBy} ceiling after ${args.pagesFetched} page(s) ` +
        `(caps: ${args.maxPages} pages, ${args.budgetMs}ms; ${args.collected} row(s) collected). ` +
        `This is a PAGING DEADLINE — the backend is slow or the collection is larger than the cap. ` +
        `It does NOT mean the resource is missing. Raise ${knob} ` +
        `if this collection is legitimately larger.`,
    );
    this.name = 'PagingDeadlineError';
    this.label = args.label;
    this.truncatedBy = args.truncatedBy;
    this.budgetMs = args.budgetMs;
    this.maxPages = args.maxPages;
    this.pagesFetched = args.pagesFetched;
    this.collected = args.collected;
  }
}

/**
 * Sentinel returned by {@link PagingBudget.runPage} when the walk's OWN
 * deadline tripped inside the page fetch. Distinct from `null`/`undefined`
 * because a page body of `null` is a legitimate "stop cleanly" signal in the
 * ARM clients (their 404-to-null convention).
 */
export const PAGE_DEADLINE: unique symbol = Symbol('paging-budget:deadline');
export type PageDeadline = typeof PAGE_DEADLINE;

export interface PagingBudgetOptions {
  /** Hard cap on how many pages may be fetched. Default {@link defaultMaxPages}. */
  maxPages?: number;
  /** Hard wall-clock ceiling for the WHOLE walk. Default {@link defaultPagingBudgetMs}. */
  budgetMs?: number;
}

/**
 * Default page cap. 50 matches the `guard < 50` literal already hand-rolled in
 * the discovery clients (storage-discovery, network-discovery,
 * workspace-roles-client), so adopting the budget there is not a behaviour
 * change — it only ADDS the wall clock those loops lack. Override with
 * `LOOM_ARM_PAGING_MAX_PAGES`.
 *
 * Read PER BUDGET rather than once at module load, so raising the knob takes
 * effect on the next request instead of needing a container restart — the warn
 * line names the knob, and that advice has to actually be actionable.
 */
export function defaultMaxPages(): number {
  const n = Number(process.env.LOOM_ARM_PAGING_MAX_PAGES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

/**
 * Default wall-clock ceiling for a whole paged walk: 15s. Deliberately HALF the
 * 30s single-request budget so a multi-page list can never out-live the single
 * request it is made of by more than a factor of one — and well inside the 60s
 * `maxDuration` a BFF route gets. Override with `LOOM_ARM_PAGING_BUDGET_MS`
 * (also read per budget — see {@link defaultMaxPages}).
 */
export function defaultPagingBudgetMs(): number {
  const n = Number(process.env.LOOM_ARM_PAGING_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

/**
 * A one-shot ceiling for a single paged walk. Construct one per call (never
 * share across requests — the wall clock starts at construction).
 *
 * Usage — call {@link claimPage} as the loop condition so the FIRST page is
 * claimed too, and run the fetch through {@link runPage} so a deadline that
 * lands INSIDE the fetch truncates like one that lands at the loop top:
 *
 * ```ts
 * const budget = new PagingBudget('foundry /connections');
 * let next: string | null = null;
 * while (budget.claimPage()) {
 *   const page = await budget.runPage((ms) => readJson(fetchWithTimeout(next ?? firstUrl, init, ms)));
 *   if (page === PAGE_DEADLINE) break;  // wall clock spent mid-fetch — keep rows
 *   out.push(...(page?.value ?? []));
 *   if (!page?.nextLink) break;   // finished cleanly — NOT a truncation
 *   next = page.nextLink;
 * }
 * budget.warnIfTruncated(out.length);
 * ```
 */
export class PagingBudget {
  readonly label: string;
  readonly maxPages: number;
  readonly budgetMs: number;

  private readonly startedAt = Date.now();
  private pages = 0;
  private truncation: PagingTruncation | null = null;

  constructor(label: string, opts: PagingBudgetOptions = {}) {
    this.label = label;
    this.maxPages =
      opts.maxPages !== undefined && Number.isFinite(opts.maxPages) && opts.maxPages > 0
        ? Math.floor(opts.maxPages)
        : defaultMaxPages();
    this.budgetMs =
      opts.budgetMs !== undefined && Number.isFinite(opts.budgetMs) && opts.budgetMs > 0
        ? opts.budgetMs
        : defaultPagingBudgetMs();
  }

  /**
   * Claim the right to fetch ONE more page. Returns false once the page cap or
   * the wall clock is spent, recording WHICH in {@link truncatedBy}. Idempotent
   * after a breach (a second call re-reports false without re-deciding).
   */
  claimPage(): boolean {
    if (this.truncation) return false;
    if (this.pages >= this.maxPages) {
      this.truncation = 'pages';
      return false;
    }
    if (this.elapsedMs() >= this.budgetMs) {
      this.truncation = 'time';
      return false;
    }
    this.pages += 1;
    return true;
  }

  /** Wall-clock ms since the budget was constructed. */
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * Run ONE page fetch under this budget, handing it the remaining wall clock.
   *
   * If the fetch rejects with a {@link FetchTimeoutError} raised by THAT
   * deadline, it is absorbed: the budget records a `time` truncation and
   * {@link PAGE_DEADLINE} is returned so the loop stops and the caller keeps
   * the rows it already collected. This is the whole point — the breach that
   * matters in production lands inside the FIRST page fetch, not at a loop
   * top, and an exception there would be re-interpreted by callers as
   * "the resource does not exist".
   *
   * Anything else (a real network failure, a 30s per-request ceiling that is
   * NOT ours, a caller-driven abort, a JSON parse error) propagates untouched
   * — those are genuine failures, not deadlines.
   */
  async runPage<R>(fn: (timeoutMs: number) => Promise<R>): Promise<R | PageDeadline> {
    try {
      return await fn(this.remainingMs());
    } catch (err) {
      if (this.absorbDeadline(err)) return PAGE_DEADLINE;
      throw err;
    }
  }

  /**
   * True when `err` is a timeout raised by a deadline this budget handed down
   * (its `timeoutMs` can never exceed our own `budgetMs`), in which case the
   * walk is recorded as time-truncated. A `FetchTimeoutError` carrying a
   * LARGER budget came from some other ceiling (e.g. the shared 30s
   * per-request default) and is a real failure, so it is left to propagate.
   */
  absorbDeadline(err: unknown): boolean {
    if (!(err instanceof FetchTimeoutError)) return false;
    if (!(err.timeoutMs <= this.budgetMs)) return false;
    if (!this.truncation) this.truncation = 'time';
    return true;
  }

  /**
   * Milliseconds left in the walk, floored at 1 — a 0/negative `timeoutMs`
   * would make `fetchWithTimeout` abort before the request is even dispatched
   * and surface as a confusing instant failure rather than a real deadline.
   */
  remainingMs(): number {
    return Math.max(1, this.budgetMs - this.elapsedMs());
  }

  /** How many pages were actually fetched. */
  get pagesFetched(): number {
    return this.pages;
  }

  /** Non-null once the walk was cut short, naming which ceiling tripped. */
  get truncatedBy(): PagingTruncation | null {
    return this.truncation;
  }

  /**
   * Emit ONE honest warn line when the walk stopped short, naming the knob to
   * raise. No-op when the walk completed — silence means "this list is whole".
   */
  warnIfTruncated(collected: number): void {
    if (!this.truncation) return;
    const knob =
      this.truncation === 'pages' ? 'LOOM_ARM_PAGING_MAX_PAGES' : 'LOOM_ARM_PAGING_BUDGET_MS';
    console.warn(
      `[paging-budget] ${this.label}: stopped by ${this.truncation} budget after ` +
        `${this.pages} page(s) / ${this.elapsedMs()}ms ` +
        `(caps: ${this.maxPages} pages, ${this.budgetMs}ms) — returning ${collected} row(s), ` +
        `the list may be incomplete. Raise ${knob} if this collection is legitimately larger ` +
        `(read per walk — no restart needed).`,
    );
  }

  /**
   * Throw a {@link PagingDeadlineError} when the walk was cut short — the
   * opt-in escape valve for a caller that genuinely needs completeness and
   * must NOT silently act on a partial list. No-op on a complete walk.
   */
  assertComplete(collected: number): void {
    if (!this.truncation) return;
    throw new PagingDeadlineError({
      label: this.label,
      truncatedBy: this.truncation,
      budgetMs: this.budgetMs,
      maxPages: this.maxPages,
      pagesFetched: this.pages,
      collected,
    });
  }
}

/** The ARM/data-plane list envelope every caller of {@link walkPagedList} returns. */
export interface PagedEnvelope<T> {
  value?: T[];
  nextLink?: string;
}

/** What a bounded walk collected, and whether it is the WHOLE list. */
export interface PagedWalkResult<T> {
  rows: T[];
  /** Non-null when the walk was cut short — the list is INCOMPLETE. */
  truncatedBy: PagingTruncation | null;
  pagesFetched: number;
  /** The budget that governed the walk (for {@link PagingBudget.assertComplete}). */
  budget: PagingBudget;
}

/**
 * Walk a `{ value, nextLink }` list under a {@link PagingBudget}, flattening
 * every page's `value` into one array, and REPORT whether the result is whole.
 *
 * `fetchPage(next, timeoutMs)` does the actual round-trip: `next` is null for
 * the FIRST page and the previous page's `nextLink` thereafter, and `timeoutMs`
 * is the walk's REMAINING wall clock — pass it straight to `fetchWithTimeout` so
 * one slow page can't out-live the walk. Return null to stop cleanly (e.g. the
 * 404-to-null convention the ARM clients share).
 *
 * A deadline that lands inside `fetchPage` is absorbed as a `time` truncation
 * (see {@link PagingBudget.runPage}) — this function never rejects because the
 * walk ran out of wall clock, only because the backend genuinely failed.
 */
export async function walkPagedListResult<T = any>(
  label: string,
  fetchPage: (next: string | null, timeoutMs: number) => Promise<PagedEnvelope<T> | null>,
  opts?: PagingBudgetOptions,
): Promise<PagedWalkResult<T>> {
  const out: T[] = [];
  const budget = new PagingBudget(label, opts);
  let next: string | null = null;
  while (budget.claimPage()) {
    const page = await budget.runPage((timeoutMs) => fetchPage(next, timeoutMs));
    if (page === PAGE_DEADLINE) break; // wall clock spent mid-fetch — keep rows
    if (!page) break;
    if (Array.isArray(page.value)) out.push(...page.value);
    if (!page.nextLink) break; // finished cleanly — NOT a truncation
    next = page.nextLink;
  }
  budget.warnIfTruncated(out.length);
  return { rows: out, truncatedBy: budget.truncatedBy, pagesFetched: budget.pagesFetched, budget };
}

/**
 * {@link walkPagedListResult} for the common case where the caller only wants
 * the rows — a picker/list surface for which a truncated page-1 beats a wedged
 * request path. Callers that must distinguish complete from partial use
 * `walkPagedListResult` and read `truncatedBy` (or call
 * {@link PagingBudget.assertComplete}).
 *
 * Most ARM pagers in the console route through here or a hand-rolled
 * {@link PagingBudget} loop, so the bound is defined once rather than
 * re-derived per client — see #2557, and #2582 for the residual page-capped
 * batch (the discovery clients, `monitor-client`, `cmk-client`,
 * `kv-secrets-client`, `iothub-client`, the Graph membership walks, and the
 * `api/azure/connectables` / `spark-binding` routes). The remaining
 * un-clocked walks are the ARG `$skipToken` loops named in
 * `docs/fiab/arm-paging-budget.md` — they adopt this when next touched.
 */
export async function walkPagedList<T = any>(
  label: string,
  fetchPage: (next: string | null, timeoutMs: number) => Promise<PagedEnvelope<T> | null>,
  opts?: PagingBudgetOptions,
): Promise<T[]> {
  return (await walkPagedListResult<T>(label, fetchPage, opts)).rows;
}

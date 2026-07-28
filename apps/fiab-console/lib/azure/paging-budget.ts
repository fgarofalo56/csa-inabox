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
 * request path; {@link PagingBudget.truncatedBy} is exposed so a caller that
 * genuinely needs completeness can throw instead of returning partial rows.
 *
 * No mocks — this only adds arithmetic around real calls.
 */

/** Why a paged walk stopped short of its final page. */
export type PagingTruncation = 'pages' | 'time';

export interface PagingBudgetOptions {
  /** Hard cap on how many pages may be fetched. Default {@link DEFAULT_MAX_PAGES}. */
  maxPages?: number;
  /** Hard wall-clock ceiling for the WHOLE walk. Default {@link DEFAULT_PAGING_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * Default page cap. 50 matches the `guard < 50` literal already hand-rolled in
 * the discovery clients (storage-discovery, network-discovery,
 * workspace-roles-client), so adopting the budget there is not a behaviour
 * change — it only ADDS the wall clock those loops lack. Override with
 * `LOOM_ARM_PAGING_MAX_PAGES`.
 */
export const DEFAULT_MAX_PAGES: number = (() => {
  const n = Number(process.env.LOOM_ARM_PAGING_MAX_PAGES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
})();

/**
 * Default wall-clock ceiling for a whole paged walk: 15s. Deliberately HALF the
 * 30s single-request budget so a multi-page list can never out-live the single
 * request it is made of by more than a factor of one — and well inside the 60s
 * `maxDuration` a BFF route gets. Override with `LOOM_ARM_PAGING_BUDGET_MS`.
 */
export const DEFAULT_PAGING_BUDGET_MS: number = (() => {
  const n = Number(process.env.LOOM_ARM_PAGING_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

/**
 * A one-shot ceiling for a single paged walk. Construct one per call (never
 * share across requests — the wall clock starts at construction).
 *
 * Usage — call {@link claimPage} as the loop condition so the FIRST page is
 * claimed too, and hand {@link remainingMs} to the per-page fetch:
 *
 * ```ts
 * const budget = new PagingBudget('foundry /connections');
 * let next: string | null = null;
 * while (budget.claimPage()) {
 *   const res = await fetchWithTimeout(next ?? firstUrl, init, budget.remainingMs());
 *   const page = await readJson(res);
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
        : DEFAULT_MAX_PAGES;
    this.budgetMs =
      opts.budgetMs !== undefined && Number.isFinite(opts.budgetMs) && opts.budgetMs > 0
        ? opts.budgetMs
        : DEFAULT_PAGING_BUDGET_MS;
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
        `the list may be incomplete. Raise ${knob} if this collection is legitimately larger.`,
    );
  }
}

/** The ARM/data-plane list envelope every caller of {@link walkPagedList} returns. */
export interface PagedEnvelope<T> {
  value?: T[];
  nextLink?: string;
}

/**
 * Walk a `{ value, nextLink }` list under a {@link PagingBudget}, flattening
 * every page's `value` into one array.
 *
 * `fetchPage(next, timeoutMs)` does the actual round-trip: `next` is null for
 * the FIRST page and the previous page's `nextLink` thereafter, and `timeoutMs`
 * is the walk's REMAINING wall clock — pass it straight to `fetchWithTimeout` so
 * one slow page can't out-live the walk. Return null to stop cleanly (e.g. the
 * 404-to-null convention the ARM clients share).
 *
 * Every ARM pager in the console routes through here so the bound is defined
 * once, not re-derived (and re-forgotten) per client — see #2557.
 */
export async function walkPagedList<T = any>(
  label: string,
  fetchPage: (next: string | null, timeoutMs: number) => Promise<PagedEnvelope<T> | null>,
  opts?: PagingBudgetOptions,
): Promise<T[]> {
  const out: T[] = [];
  const budget = new PagingBudget(label, opts);
  let next: string | null = null;
  while (budget.claimPage()) {
    const page = await fetchPage(next, budget.remainingMs());
    if (!page) break;
    if (Array.isArray(page.value)) out.push(...page.value);
    if (!page.nextLink) break; // finished cleanly — NOT a truncation
    next = page.nextLink;
  }
  budget.warnIfTruncated(out.length);
  return out;
}

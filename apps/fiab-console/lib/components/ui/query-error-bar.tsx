'use client';

/**
 * QueryErrorBar — the ONE honest "this read failed" surface for react-query
 * consumers.
 *
 * ## Why this exists
 *
 * `deploy-integrity.md` R7: *an error must not state as fact something it did
 * not establish.* A `useQuery` whose `queryFn` can throw and whose component
 * has no error branch does exactly that — after a 500 / 403 / timeout the
 * component keeps rendering whichever branch it fell through to:
 *
 *   - `ducklake-catalog` sat on **"Reading the DuckLake catalog…"** forever —
 *     a factual claim that a read was in flight, when it had already failed.
 *   - `admin/catalog` rendered **"No tables published to the catalog yet"** — a
 *     false claim about the customer's catalog.
 *   - `assets` rendered a freshness rollup of **0**.
 *   - `power-app` rendered the **unbound** binding picker for an app that IS
 *     bound, because the record could not be read.
 *
 * Every one of those is the same bug, and it kept reappearing because the fix
 * was hand-rolled per file: `s3-gateway-editor.tsx` had the correct MessageBar
 * (pinned by a test) and **no sibling ever adopted it** — the guard-adoption
 * gap (`csa_loom_guard_adoption_gap_2026_08_01`). Copy-paste cannot be adopted;
 * a component can. This is that component, and
 * `scripts/ci/check-editor-read-failure-honesty.mjs` RULE 2 is what keeps new
 * consumers from skipping it.
 *
 * ## What it guarantees
 *
 * - Renders **nothing** unless the query actually failed, so it can be dropped
 *   at the top of any surface without changing the happy path.
 * - Reports only what was observed: the thrown error's own message, or — when
 *   there is none — an explicitly *uncertain* sentence naming the endpoint that
 *   never answered. It never invents a cause.
 * - Always offers **Retry** (`refetch`), so the failure is recoverable in place
 *   rather than by reloading the page.
 * - Leaves the surface around it standing (`ux-baseline.md`: the editor's real
 *   surface is never replaced by an error page).
 *
 * ## Not a gate
 *
 * A failed read is NOT a day-one configuration gate, so this bar deliberately
 * has no "Fix it" wizard and no gate-registry entry (`ux-baseline.md` G2 covers
 * gates — a value the platform could have set). The actionable remediation for
 * "the server did not answer" is Retry. Surfaces that ALSO have a real config
 * gate keep rendering their own gate MessageBar separately; the two states are
 * distinct and must not be conflated.
 *
 * Fluent v9 + Loom tokens. Azure-native, cloud-invariant — no Fabric.
 */

import type { ReactNode } from 'react';
import {
  Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';

/**
 * The slice of a react-query result this bar needs.
 *
 * Structural, not `UseQueryResult<T>`, so a consumer can pass any of the ~49
 * differently-typed queries in this app (and a spec can pass a literal) without
 * a cast.
 */
export interface QueryErrorLike {
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface QueryErrorBarProps {
  /** The failing query. Nothing renders while `isError` is false. */
  query: QueryErrorLike;
  /**
   * What could not be read, as it should read after "Could not read ".
   * e.g. `'the S3 gateway configuration'`, `'this lakehouse'`.
   */
  subject: string;
  /**
   * The route that was being read, e.g. `'/api/assets/status'`. Used ONLY in
   * the fallback sentence for a rejection that carries no message (a transport
   * failure), so the bar still names what did not answer instead of asserting
   * a cause it never established.
   */
  endpoint?: string;
  /**
   * One sentence stating what is definitively NOT implied by this failure —
   * the R7 half that stops a read error being read as a verdict about the
   * user's data ("This says nothing about whether tables are published").
   */
  reassurance?: ReactNode;
}

/** The error's own message, or `null` when it carries none. */
function messageOf(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  const m = (error as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m ? m : null;
}

export function QueryErrorBar({ query, subject, endpoint, reassurance }: QueryErrorBarProps) {
  if (!query.isError) return null;
  const detail = messageOf(query.error)
    // No message means the request never produced a response at all. Say that,
    // and say it as an uncertainty — do NOT claim a status the code never saw.
    ?? `The request failed before ${endpoint ?? 'the server'} answered (network or timeout).`;
  return (
    <MessageBar intent="error" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>Could not read {subject}</MessageBarTitle>
        {detail}{reassurance ? <> {reassurance}</> : null}
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" onClick={() => void query.refetch()}>Retry</Button>
      </MessageBarActions>
    </MessageBar>
  );
}

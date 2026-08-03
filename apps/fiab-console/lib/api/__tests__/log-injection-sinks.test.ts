/**
 * Log-forging regression tests for the two `lib/` sinks CodeQL found
 * (js/log-injection #587 `lib/api/respond.ts`, #718 `lib/azure/paging-budget.ts`).
 *
 * THE ATTACK. A request-derived value carrying a `\n` reaches a console.* sink.
 * Everything after the newline renders as its own, attacker-authored log record.
 * Verified against real Node before writing these tests:
 *
 *   console.error('[x] failed:', 'boom\n[api] FORGED admin=true')
 *     -> "[api] FORGED admin=true" is a SEPARATE record.
 *
 * Each test asserts the emitted record is ONE line. Revert the corresponding fix
 * and these go red; they cannot pass by accident, because the forged marker is
 * only reachable on a second line.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiServerError, apiHonestError } from '../respond';
import { PagingBudget } from '@/lib/azure/paging-budget';

/** The tail an attacker wants rendered as its own record. */
const FORGED = '[api] server error: FORGED — admin granted';

/** Join everything console.* received into the text a log reader would see. */
function rendered(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
}

afterEach(() => vi.restoreAllMocks());

describe('apiServerError — 500 path for every route (#587)', () => {
  it('cannot be used to forge a second log record', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // An Error whose MESSAGE embeds request-derived text is the realistic shape:
    // "unknown item type <x>", a driver echoing a supplied identifier, etc.
    const err = new Error(`unknown item type xyz\n${FORGED}`);
    err.stack = `Error: unknown item type xyz\n${FORGED}\n    at handler (/app/route.ts:1:1)`;

    apiServerError(err);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = rendered(spy.mock.calls[0]);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).not.toMatch(/^\[api\] server error: FORGED/m);
  });

  it('still logs the stack — a safe log must remain a USEFUL log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at handler (/app/route.ts:42:7)';

    apiServerError(err);

    const line = rendered(spy.mock.calls[0]);
    expect(line).toContain('boom');
    // Flattened, not discarded: the frame is still there, on the same record.
    expect(line).toContain('at handler (/app/route.ts:42:7)');
  });

  it('CONTROL: an ordinary error is unchanged apart from framing', () => {
    // Passes both before and after the fix — catches an over-broad "sanitizer"
    // that redacts or mangles benign text.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiServerError(new Error('ETIMEDOUT contacting Synapse'));
    expect(rendered(spy.mock.calls[0])).toContain('ETIMEDOUT contacting Synapse');
  });
});

describe('apiHonestError — the sibling CodeQL did not flag', () => {
  it('cannot be used to forge a second log record', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiHonestError(new Error(`AAS not configured\n${FORGED}`), 503);
    const line = rendered(spy.mock.calls[0]);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('CONTROL: the honest-gate message still reaches the CLIENT verbatim', async () => {
    // no-vaporware.md requires the gate text to surface exactly. Only the LOG is
    // flattened — sanitizing the response body would be the wrong fix.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = apiHonestError(new Error('Set LOOM_AAS_SERVER to enable this'), 503);
    const body = await res.json();
    expect(body.error).toBe('Set LOOM_AAS_SERVER to enable this');
    expect(res.status).toBe(503);
  });
});

describe('PagingBudget label — chokepoint for every paged walk (#718)', () => {
  /** Trip the page-cap truncation so warnIfTruncated() actually emits. */
  function tripTruncation(label: string) {
    const budget = new PagingBudget(label, { maxPages: 1, budgetMs: 60_000 });
    // claimPage() returns true for the one allowed page, then false — setting
    // truncatedBy='pages', which is what warnIfTruncated() requires to emit.
    while (budget.claimPage()) { /* consume the allowance */ }
    expect(budget.truncatedBy).toBe('pages');
    return budget;
  }

  it('cannot be used to forge a second log record', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Callers build the label from route params: `gate-options ${id}`.
    const budget = tripTruncation(`gate-options abc\n${FORGED}`);
    budget.warnIfTruncated(10);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = rendered(spy.mock.calls[0]);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('CONTROL: an ordinary label is preserved verbatim', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = tripTruncation('connectables ARG');
    budget.warnIfTruncated(10);
    expect(rendered(spy.mock.calls[0])).toContain('connectables ARG');
  });
});

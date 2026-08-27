/**
 * LOOM BRAIN — SECURITY EXTRACTION: how a verdict is CONSUMED.
 *
 * `detectors/c3-discarded-verdict.ts` states the mechanism this file exists to
 * measure: every returned-value guard in this console has the contract
 * `Promise<NextResponse | null>`, where `null` means allowed. So THE
 * AUTHORIZATION EDGE IS NOT THE CALL — the call produces a value, and the edge is
 * `if (gate) return gate;` IN THE CALLER. Delete that one line and the import,
 * the call, and the guard's entire correct implementation all survive with no
 * authorization left. On 2026-08-07 that happened to a subscription-scoped ARM
 * deploy route and every merge-blocking control in the repo printed green.
 *
 * An extractor that records "the guard is called" therefore measures nothing.
 * What has to be recorded is what the caller DID with the answer.
 *
 * ── THE FOUR CONSUMPTIONS, AND THE THREE NARROW BYPASSES ─────────────────
 *
 * `consumption` mirrors the substrate's enum, and each non-refusing value maps to
 * a bypass the taxonomy measured in the wild:
 *
 *   'returned'          the edge exists.
 *   'logged'            (b) consumed into a DEAD STORE — tested, never returned.
 *   'attribution-only'  (c) the only guard-shaped signal is a `savedBy` /
 *                       `claims.oid` field. Proves the token is PRESENT, not that
 *                       it AUTHORIZES. Measured 2026-08-08: removing bare
 *                       `claims.*` from the signal set moved 0 violations -> 205.
 *   'ignored'           the value is bound and never read at all.
 *
 * Bypass (a) — CONSUME THE VERDICT ON ONE BRANCH — is not a `consumption` value
 * but a PATH COUNT, and it is the reason {@link VerdictConsumption} carries
 * `refusalIsTotal` separately. `if (gate && req.method !== 'GET') return gate;`
 * has consumption `'returned'`: the value IS tested and a decision IS taken. A
 * checker asking "is the value tested?" passes it while GET is unauthorized. So
 * the extractor asks a second, different question — is the refusal condition
 * EXACTLY the verdict, or does it carry additional operands that can send control
 * past the refusal?
 *
 * ── THE PATH COUNTS ARE A FLOOR, AND SAY SO ──────────────────────────────
 *
 * This package does not build a control-flow graph, so it cannot enumerate paths.
 * What it can establish is:
 *
 *   - how many privileged sink CALLS the handler contains (`pathsToPrivilegedSink`);
 *   - whether the refusal is unconditional, in which case every one of them is
 *     refused, or conditional, in which case AT LEAST ONE is not.
 *
 * When the refusal is conditional the extractor records exactly ONE escaping
 * path, because one is what it PROVED. That under-counts a handler where several
 * escape. Under-counting is the safe direction here: C3's predicate is
 * `pathsConsumingAsRefusal < pathsToPrivilegedSink`, so a floor of one still
 * fires the finding, and the evidence never claims a number the analysis did not
 * establish (deploy-integrity R7).
 */

import { balancedEnd } from './source-facts';

export type ConsumptionKind = 'returned' | 'thrown' | 'logged' | 'ignored' | 'attribution-only';

export interface VerdictConsumption {
  readonly consumption: ConsumptionKind;
  /**
   * Is the refusal reached on the verdict ALONE?
   *
   * `false` when the refusal condition carries extra operands — the (a) bypass.
   * Meaningless unless `consumption === 'returned'`.
   */
  readonly refusalIsTotal: boolean;
  /** The identifier the verdict was bound to, when it was bound. */
  readonly boundTo: string | null;
  /** The refusal condition text, for evidence. */
  readonly refusalCondition: string | null;
}

/** Wrappers that perform the caller's refusal INSIDE `lib/api/route-toolkit.ts`. */
export const CONSUMING_WRAPPERS: readonly string[] = [
  'withTenantAdmin',
  'withDlzAccess',
  'withCapability',
  'withWorkspaceOwner',
  'withApprovalAuthority',
] as const;

/**
 * The identifier a call at `callIndex` was bound to, if any.
 *
 * Scans backwards over the immediately preceding text for `const X =` /
 * `let X =` / `var X =`, allowing an intervening `await`. Bounded to 200
 * characters so a binding cannot be picked up from an unrelated earlier
 * statement.
 */
export function bindingFor(blanked: string, callIndex: number): string | null {
  const from = Math.max(0, callIndex - 200);
  const before = blanked.slice(from, callIndex);
  const m = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:await\s+)?$/.exec(before);
  return m ? m[1] : null;
}

/**
 * The condition text of an `if` whose body returns, testing `name`.
 *
 * Returns the raw condition so the caller can decide whether it is EXACTLY the
 * verdict or carries extra operands. `null` when no returning `if` tests `name`.
 */
function refusalConditionFor(blanked: string, name: string): string | null {
  const ifRe = /\bif\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = ifRe.exec(blanked)) !== null) {
    const paren = blanked.indexOf('(', m.index);
    const end = balancedEnd(blanked, paren);
    const condition = blanked.slice(paren + 1, Math.max(paren + 1, end - 1));
    if (!new RegExp(`\\b${name}\\b`).test(condition)) continue;

    // Does this `if` return? Look at the consequent — either a braced block or a
    // single statement up to the next `;`.
    let k = end;
    while (k < blanked.length && /\s/.test(blanked[k])) k += 1;
    let consequent: string;
    if (blanked[k] === '{') {
      consequent = blanked.slice(k, balancedEnd(blanked, k));
    } else {
      const semi = blanked.indexOf(';', k);
      consequent = blanked.slice(k, semi < 0 ? blanked.length : semi + 1);
    }
    if (/\breturn\b|\bthrow\b/.test(consequent)) return condition;
  }
  return null;
}

/**
 * Is a condition EXACTLY the verdict, modulo a negation and parentheses?
 *
 * `gate` and `!gate` are total. `gate && req.method !== 'GET'` is not — that is
 * measured bypass (a), where the value is genuinely tested and a decision is
 * genuinely taken, on some paths only.
 */
function conditionIsExactly(condition: string, name: string): boolean {
  const stripped = condition.replace(/[()\s!]/g, '');
  return stripped === name;
}

/**
 * Classify what a handler did with the verdict produced at `callIndex`.
 *
 * `blanked` must be the blanked handler body (see `source-facts.ts` — matching
 * over raw text would find `if (gate) return gate` inside this repo's docblocks).
 */
export function classifyConsumption(blanked: string, callIndex: number): VerdictConsumption {
  const boundTo = bindingFor(blanked, callIndex);

  // Unbound: `if (await enforceCapability(...)) return ...` — the call sits
  // directly inside the condition, so the refusal is the call itself.
  if (!boundTo) {
    const head = blanked.lastIndexOf('if', callIndex);
    if (head >= 0 && callIndex - head < 60) {
      const paren = blanked.indexOf('(', head);
      if (paren >= 0) {
        const end = balancedEnd(blanked, paren);
        if (end > callIndex) {
          const condition = blanked.slice(paren + 1, Math.max(paren + 1, end - 1));
          let k = end;
          while (k < blanked.length && /\s/.test(blanked[k])) k += 1;
          const consequent =
            blanked[k] === '{'
              ? blanked.slice(k, balancedEnd(blanked, k))
              : blanked.slice(k, Math.min(blanked.length, k + 120));
          if (/\breturn\b|\bthrow\b/.test(consequent)) {
            return {
              consumption: 'returned',
              // The call IS the whole condition only when nothing else joins it.
              refusalIsTotal: !/&&|\|\|/.test(condition),
              boundTo: null,
              refusalCondition: condition.trim(),
            };
          }
        }
      }
    }
    return { consumption: 'ignored', refusalIsTotal: false, boundTo: null, refusalCondition: null };
  }

  const after = blanked.slice(callIndex);
  const condition = refusalConditionFor(after, boundTo);
  if (condition !== null) {
    return {
      consumption: 'returned',
      refusalIsTotal: conditionIsExactly(condition, boundTo),
      boundTo,
      refusalCondition: condition.trim(),
    };
  }

  // A bare `return X;` with no test still returns the verdict — but a guard that
  // returns `null` on ALLOW would then return null as a response, so this shape
  // is a refusal only in the trivial sense. Recorded as 'returned' but never
  // total, so it cannot silently clear a handler.
  if (new RegExp(`\\breturn\\s+${boundTo}\\b`).test(after)) {
    return { consumption: 'returned', refusalIsTotal: false, boundTo, refusalCondition: null };
  }

  // A logging sink, reached either bare (`log(gate)`) or as a member
  // (`console.warn(gate)`). The member form is the common one and an earlier
  // revision of this pattern missed it entirely, classifying a dead store as
  // 'ignored' — a different bypass label for the same defect, but the wrong one.
  if (
    new RegExp(
      `\\b(?:console|log|logger|trackEvent|captureException)(?:\\s*\\.\\s*\\w+)?\\s*\\([^;]*\\b${boundTo}\\b`,
    ).test(after)
  ) {
    return { consumption: 'logged', refusalIsTotal: false, boundTo, refusalCondition: null };
  }

  // Appears only as an object-literal property value — the `savedBy` shape.
  if (new RegExp(`[A-Za-z0-9_$]+\\s*:\\s*${boundTo}\\b`).test(after)) {
    return {
      consumption: 'attribution-only',
      refusalIsTotal: false,
      boundTo,
      refusalCondition: null,
    };
  }

  return { consumption: 'ignored', refusalIsTotal: false, boundTo, refusalCondition: null };
}

/**
 * Does this handler body adopt a wrapper that performs the refusal for it?
 *
 * Without this the extractor would report every one of the ~72 `withTenantAdmin`
 * routes as a discarded verdict, because the token `if (gate) return gate`
 * appears in none of them — it is in `route-toolkit.ts:169`. That would be a
 * false-positive flood large enough to get the detector disbelieved, which is its
 * own kind of failure.
 */
export function consumingWrappersIn(blanked: string): string[] {
  return CONSUMING_WRAPPERS.filter((w) => new RegExp(`\\b${w}\\b`).test(blanked));
}

/**
 * RECOMMEND-ONLY, enforced at runtime rather than only in the type system.
 *
 * PRP §1 decision 1 is binding and its rationale is measured: of the 13 Container
 * App environments across these subscriptions, ONLY 1 is Loom's. The other 12 are
 * unrelated production estates. Autonomous action on a wrong ownership inference
 * destroys someone else's production. Taxonomy §3.7 adds the security-specific
 * form: a wrong autonomous "fix" to an authorization path is worse than the gap.
 *
 * `DraftedRemediation` declares no callable member, so TypeScript already forbids
 * one at a call site inside this package. That guarantee is ERASED the moment a
 * finding crosses a boundary the compiler does not own — a Cosmos document, a
 * queue message, an agent prompt, a `JSON.parse` of any of those. This module is
 * the runtime backstop for exactly that crossing.
 *
 * It is deliberately NOT a lint rule. A lint rule over `lib/brain/security/**`
 * would be keyed to the shape it forbids, which is the population failure the
 * taxonomy spends §6.4 on: a detector keyed to the unsafe pattern goes quiet on
 * the files that adopt the fix. `assertInertRemediation` runs over EVERY finding
 * regardless of who authored it, so its population is "findings", not "findings
 * that look dangerous".
 */

import type { Finding } from './substrate';

/** Property names that would make a "remediation" executable rather than drafted. */
const ACTUATOR_KEYS = [
  'apply',
  'execute',
  'exec',
  'run',
  'invoke',
  'call',
  'handler',
  'action',
  'mutate',
  'commit',
  'dispatch',
  'perform',
] as const;

/**
 * Throw if a finding's remediation carries anything executable, AT ANY DEPTH.
 *
 * Checks BOTH the well-known actuator key names AND any function-valued property
 * whatsoever, because the second is the general case and the first only catches
 * the spellings someone thought of. The taxonomy's C1 is the same lesson: key a
 * guard to the SHAPE, never to a spelling list.
 *
 * ── WHY THIS RECURSES, MEASURED ───────────────────────────────────────────
 *
 * A previous revision used a single `Object.entries(r)` pass and made the claim
 * above anyway. Review on 2026-08-23 measured the gap with a positive control
 * proving the guard was live at the top level:
 *
 *   remediation.apply = fn                        -> REJECTED  (control)
 *   remediation.plan = { apply: fn }              -> ACCEPTED  (escaped)
 *   remediation.proposedCommands = [{ apply: fn }]-> ACCEPTED  (escaped)
 *
 * One level deep is not "any function-valued property whatsoever". The claim was
 * stronger than the code, in the module enforcing the constraint that protects
 * the 12 of 13 Container App environments in these subscriptions that are not
 * Loom's. Neither escape was a live exploit — a function does not survive the
 * Cosmos / queue / `JSON.parse` crossing this module exists to backstop — but a
 * guard whose docstring overstates it is the R7 failure, and the next author to
 * add a nested field would have inherited the false guarantee.
 *
 * Four shapes are now refused, at every depth:
 *
 *   1. a function value;
 *   2. an accessor (getter/setter) — the function hides in the descriptor, so
 *      `typeof value === 'function'` never sees it;
 *   3. an actuator-named key, whatever its value type;
 *   4. a non-plain object — anything whose prototype is not `Object.prototype`,
 *      `null`, or `Array.prototype`. A class instance can carry callables on its
 *      prototype, where `Reflect.ownKeys` does not look.
 *
 * A reference cycle is also refused: it cannot survive serialisation, so its
 * presence means the value is not the data document this module requires.
 *
 * KNOWN LIMIT, stated rather than implied: this validates the object it is
 * handed. It is not a parser — a caller that mutates a finding AFTER the assert
 * is outside its remit, which is why `assertAllInert` is called on a detector's
 * output rather than once at construction.
 */
export function assertInertRemediation(finding: Finding): void {
  const r = finding.remediation as unknown;
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    throw new Error(`[recommend-only] ${finding.id}: remediation is not a data object.`);
  }

  walkInert(r, 'remediation', finding.id, new WeakSet<object>());

  if (finding.remediation.requiresHumanApproval !== true) {
    throw new Error(
      `[recommend-only] ${finding.id}: requiresHumanApproval must be literally true.`,
    );
  }
}

/** Depth-first refusal of anything executable. See `assertInertRemediation`. */
function walkInert(
  value: unknown,
  path: string,
  findingId: string,
  seen: WeakSet<object>,
): void {
  if (typeof value === 'function') {
    throw new Error(
      `[recommend-only] ${findingId}: ${path} is a function. Findings and ` +
        'remediations are DATA (PRP §1 decision 1). Nothing in lib/brain/security may ' +
        'patch, write or call an actuator.',
    );
  }
  if (value === null || typeof value !== 'object') return;

  const obj = value as object;
  if (seen.has(obj)) {
    throw new Error(
      `[recommend-only] ${findingId}: ${path} closes a reference cycle. A remediation must ` +
        'survive serialisation to a Cosmos document or a queue message; a cyclic value ' +
        'cannot, so it is not the data document this contract requires.',
    );
  }
  seen.add(obj);

  const proto = Object.getPrototypeOf(obj) as object | null;
  const isArray = Array.isArray(obj);
  const plain = isArray ? proto === Array.prototype : proto === Object.prototype || proto === null;
  if (!plain) {
    throw new Error(
      `[recommend-only] ${findingId}: ${path} is not a plain object or array ` +
        `(prototype: ${proto === null ? 'null' : (proto.constructor?.name ?? 'unknown')}). ` +
        'A class instance can carry callables on its prototype, where an own-key walk does ' +
        'not look, so the shape is refused rather than inspected.',
    );
  }

  for (const key of Reflect.ownKeys(obj)) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor === undefined) continue;

    const keyLabel = typeof key === 'symbol' ? String(key) : key;
    const isIndex = isArray && typeof key === 'string' && /^\d+$/.test(key);
    const childPath = isIndex ? `${path}[${keyLabel}]` : `${path}.${keyLabel}`;

    if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      throw new Error(
        `[recommend-only] ${findingId}: ${childPath} is an accessor property. The callable ` +
          'lives in the property descriptor, so a value-only check never sees it. A drafted ' +
          'remediation carries data, not computed properties.',
      );
    }

    if (typeof key === 'string' && !isIndex && (ACTUATOR_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `[recommend-only] ${findingId}: ${childPath} names an actuator. A drafted ` +
          'remediation proposes; a human approves; an existing actuator executes.',
      );
    }

    walkInert(descriptor.value, childPath, findingId, seen);
  }
}

/** Assert a whole batch. Returns the input so it can wrap a detector's output. */
export function assertAllInert(findings: readonly Finding[]): readonly Finding[] {
  for (const f of findings) assertInertRemediation(f);
  return findings;
}

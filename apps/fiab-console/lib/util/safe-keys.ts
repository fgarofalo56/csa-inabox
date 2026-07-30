/**
 * lib/util/safe-keys.ts — reject prototype-polluting keys at the one place we
 * assign a REQUEST-DERIVED key into an object (#2657, CodeQL
 * js/remote-property-injection).
 *
 * THE MECHANISM. On a normal object literal, `obj[k] = v` is not a plain property
 * write for three magic keys:
 *
 *   obj['__proto__']   = v   // REPLACES obj's prototype — not an own property
 *   obj['constructor'] = v   // shadows the constructor
 *   obj['prototype']   = v   // on a function, rewrites its prototype
 *
 * So a request body containing `{"__proto__": {"isAdmin": true}}` fed through the
 * `for (const [k, v] of Object.entries(body)) out[k] = v` idiom does not add a
 * key called `__proto__` — it mutates the object graph. Downstream code that
 * later reads `something.isAdmin` on an unrelated object can then see `true`.
 *
 * Two consequences, and BOTH matter:
 *
 *   1. Security — a polluted prototype can flip a flag on an object the attacker
 *      never touched.
 *   2. Silent data loss — even where pollution is harmless, the key the user sent
 *      is NOT stored. A metadata attribute literally named `__proto__` vanishes
 *      with no error, which reads as a mysterious persistence bug.
 *
 * WHY A SHARED HELPER RATHER THAN 14 LOCAL CHECKS. This is the same reasoning as
 * `lib/sql/quoting.ts`: the rule is subtle, it was open-coded in many places, and
 * one divergent copy is a latent hole. Centralising it means the rule is audited
 * once — and unlike a per-site `if`, a reviewer can see at a glance whether a new
 * call site is protected.
 */

/**
 * Keys that must never be written from request-derived input.
 *
 * `Object.create(null)` avoids the trap where `DANGEROUS_KEYS.hasOwnProperty`
 * itself gets shadowed, and a Set makes the membership test explicit.
 */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key` would mutate the object graph rather than add a property. */
export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/**
 * Thrown when a caller supplies a prototype-polluting key and the call site has
 * chosen to FAIL rather than skip. Prefer this on write paths: silently dropping
 * a key the user asked to store is its own bug (see the docstring above).
 */
export class UnsafeKeyError extends Error {
  key: string;
  constructor(key: string) {
    // Echoing the key is safe and useful — it is one of three fixed strings.
    super(`Refusing to use the reserved property name "${key}" as an object key.`);
    this.name = 'UnsafeKeyError';
    this.key = key;
  }
}

/**
 * Assign `value` at `key`, refusing a prototype-polluting key.
 *
 * Throws {@link UnsafeKeyError}. Use where the key came from a caller and losing
 * it silently would be wrong — i.e. almost every persistence path.
 */
export function safeAssign<T>(target: Record<string, T>, key: string, value: T): void {
  if (isDangerousKey(key)) throw new UnsafeKeyError(key);
  target[key] = value;
}

/**
 * Copy `entries` into a NULL-PROTOTYPE object, refusing dangerous keys.
 *
 * The result has no prototype at all, so it cannot be polluted afterwards and
 * `result.toString` / `result.constructor` are `undefined` rather than inherited
 * — which is what you want for a bag of user-supplied attributes. Note it is
 * still `JSON.stringify`-able and spreads normally.
 */
export function safeRecordFrom<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [k, v] of entries) {
    if (isDangerousKey(k)) throw new UnsafeKeyError(k);
    out[k] = v;
  }
  return out;
}

/**
 * Validate a key destined for a nested map (e.g. `doc.byModel[modelId]`) and
 * return it unchanged.
 *
 * Exists so a call site reads as an assertion — `doc.byModel[assertSafeKey(id)]`
 * — instead of a detached `if` a later edit can drift away from.
 */
export function assertSafeKey(key: string): string {
  if (isDangerousKey(key)) throw new UnsafeKeyError(key);
  return key;
}

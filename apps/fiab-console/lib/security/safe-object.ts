/**
 * lib/security/safe-object.ts — the single home for "write a user-supplied key
 * into an object" across CSA Loom's server code.
 *
 * WHY THIS FILE EXISTS (security-adjacent — js/remote-property-injection):
 *   `out[userKey] = value` is a dynamic-property-write sink. When `userKey` is
 *   `__proto__` the assignment does NOT create an own property — it invokes the
 *   `Object.prototype.__proto__` setter. Two things follow, both bad:
 *
 *     1. If `value` is an object or array, the RECEIVER'S PROTOTYPE IS REPLACED
 *        with attacker-controlled data. Every subsequent `out[k]` miss then
 *        resolves through that attacker map instead of `Object.prototype`, so a
 *        lookup for a key the attacker never named returns a value the attacker
 *        chose. For maps that steer behaviour (visual-interaction modes, per-
 *        table storage mode, approved crosswalk pairs) that is silent state
 *        corruption of a decision table.
 *     2. Either way the key is absent from `Object.keys()` and from
 *        `JSON.stringify()`, so the write is silently LOST on persist while the
 *        route still reports success — a false receipt.
 *
 *   `constructor` / `prototype` are the sibling keys: they shadow real object
 *   members, so a later `map[k]` read for an un-set key returns a Function
 *   rather than `undefined` and downstream `.map` / `.filter` throws (a 500 any
 *   authenticated caller can trigger).
 *
 *   The rule now lives in ONE audited place. Prefer {@link safeRecord} (which
 *   makes the bug impossible to express — a null-prototype object has no
 *   `__proto__` setter and no inherited members to shadow) over
 *   {@link isUnsafeKey} filtering.
 *
 * Grounded in: https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html
 */

/**
 * The three keys that are never safe as a dynamic write target on a plain
 * object literal, and never safe as a dynamic READ key on a map whose values
 * are expected to be data.
 */
export const UNSAFE_OBJECT_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

const UNSAFE = new Set(UNSAFE_OBJECT_KEYS);

/** True when `key` would hit a prototype slot / shadow an inherited member. */
export function isUnsafeKey(key: unknown): boolean {
  return typeof key !== 'string' || UNSAFE.has(key);
}

/**
 * A prototype-less record — the STRUCTURAL fix. `Object.create(null)` has no
 * `__proto__` accessor and no inherited `constructor` / `prototype`, so
 * `rec['__proto__'] = v` creates a plain own property and `rec[k]` for an
 * unknown `k` is always `undefined`. `JSON.stringify` serialises it exactly like
 * an object literal, so persisted shapes are unchanged.
 *
 * Use this for any map keyed by client-supplied strings.
 */
export function safeRecord<V = unknown>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}

/**
 * Read a map entry by a user-supplied key WITHOUT inheriting through the
 * prototype chain. Returns `undefined` for `__proto__` / `constructor` /
 * `prototype` and for any key the map does not OWN — never `Object.prototype`'s
 * members. Use for maps loaded from storage (which are plain objects rehydrated
 * by `JSON.parse`, so they do carry `Object.prototype`).
 */
export function safeGet<V>(map: Record<string, V> | null | undefined, key: unknown): V | undefined {
  if (!map || isUnsafeKey(key)) return undefined;
  return Object.prototype.hasOwnProperty.call(map, key as string) ? map[key as string] : undefined;
}

/**
 * Write `value` at `key` on `target`, refusing prototype-slot keys. Returns
 * `true` when the write happened, `false` when the key was rejected — callers
 * that must report an honest failure (rather than silently dropping) branch on
 * the result.
 *
 * Prefer {@link safeRecord} when you own the target's construction.
 */
export function safeSet<V>(target: Record<string, V>, key: unknown, value: V): boolean {
  if (isUnsafeKey(key)) return false;
  target[key as string] = value;
  return true;
}

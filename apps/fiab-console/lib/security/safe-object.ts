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
 *   `__proto__` IS NOT THE WHOLE CLASS, AND "THE VALUE IS A STRING" IS NOT A
 *   DISMISSAL (corrected 2026-07-29). It is true that the
 *   `Object.prototype.__proto__` setter ignores a non-object operand, so
 *   `out['__proto__'] = 'x'` swaps no prototype. That argument covers exactly
 *   ONE key. Every OTHER inherited member is shadowed by a string just fine:
 *
 *     out['toString']       = 'x'  →  String(out) / `${out}` throws TypeError
 *     out['valueOf']        = 'x'  →  out + '' / Number(out) throws TypeError
 *     out['hasOwnProperty'] = 'x'  →  out.hasOwnProperty(k) throws TypeError
 *     out['constructor']    = 'x'  →  out.constructor.name / new out.constructor
 *                                     throws; `x.constructor === Object` false
 *     also: isPrototypeOf, propertyIsEnumerable, toLocaleString,
 *           __defineGetter__, __lookupGetter__ …
 *
 *   So a string-valued write at a caller-supplied key is NOT inert: it is an
 *   unauthenticated-shaped 500 for any consumer that calls an inherited method
 *   on the map. Blocklisting that set by name would also reject a legitimate
 *   field literally called `toString`.
 *
 *   The rule therefore lives in ONE audited place, and the primary API is
 *   {@link safeRecord}, which makes the whole class — prototype swap, silent
 *   drop, AND method shadowing — impossible to express: a null-prototype object
 *   has no `__proto__` accessor and no inherited members to shadow, so every
 *   key, including those above, round-trips as plain data.
 *   {@link safeSet} / {@link isUnsafeKey} are the fallback for targets you do
 *   not construct; they close the prototype-slot keys only.
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
 * Coerce a free-form request object into a `{ key: string }` bag on a
 * null-prototype record, dropping blank keys. This is the shared shape behind
 * every "caller-supplied properties / tags / options" payload (Unity-Catalog
 * catalog + schema `properties`/`options`, Purview business-metadata custom
 * tags). Centralised so the null-prototype guarantee is stated once instead of
 * being re-derived per route.
 *
 * Returns `undefined` when there is nothing to send, so callers can omit the
 * field from the outgoing body rather than sending an empty object.
 */
export function toSafeStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out = safeRecord<string>();
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = String(k).trim();
    if (key) out[key] = val == null ? '' : String(val);
  }
  return Object.keys(out).length ? out : undefined;
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
 * LIMITATION, stated so this is not mistaken for a full defence: on a target
 * that still has `Object.prototype`, this blocks the three prototype-slot keys
 * but NOT shadowing of the other inherited members (`toString`, `valueOf`,
 * `hasOwnProperty`, …). Prefer {@link safeRecord} whenever you own the target's
 * construction — that closes the whole class.
 */
export function safeSet<V>(target: Record<string, V>, key: unknown, value: V): boolean {
  if (isUnsafeKey(key)) return false;
  target[key as string] = value;
  return true;
}

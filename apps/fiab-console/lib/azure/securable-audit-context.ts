/**
 * Securable-audit suppression context (Unity Catalog storage credentials +
 * external locations, issue #2622 gap-1 residual).
 *
 * TWO LAYERS AUDIT THE SAME CALL, AND EXACTLY ONE ROW MAY COME OUT.
 *
 *   `lib/azure/uc-securable.ts`      the FACADE. Wraps each UC export, so it sees
 *                                    the POST-RESPONSE outcome — `ucJsonOrThrow`
 *                                    treats a 409 ALREADY_EXISTS as a successful
 *                                    idempotent re-create and a DELETE tolerates
 *                                    404. Its row is the higher-fidelity one.
 *   `lib/azure/shortcut-credentials.ts`
 *                                    the TRANSPORT (`securableFetch`). Its row is
 *                                    the FLOOR: it fires for anything issued from
 *                                    that module, including an export added later
 *                                    that nobody thought to wrap.
 *
 * The facade runs each call inside {@link withSecurableRecordedByCaller}; the
 * transport suppresses its own record inside that context and records outside it.
 * Suppression is therefore opt-IN — a new export is audited by DEFAULT rather
 * than by having been anticipated, which is the whole point of instrumenting the
 * transport at all.
 *
 * ## Why this is its own module
 *
 * It is the only thing BOTH files can import without a cycle: the facade already
 * imports the transport, so the context cannot live in the facade, and putting it
 * in the transport would make it a new export of a module whose public surface is
 * deliberately frozen behind the guard's import choke point (check 8) — and which
 * several specs replace wholesale with `vi.mock`.
 *
 * ## Why an async context and not a boolean
 *
 * A module-level flag set around the call would be WRONG under concurrency, not
 * merely inelegant: two shortcut binds running at once interleave across their
 * awaits, so a flag raised by one would suppress the other's transport row while
 * no facade wrote one for it. That is a dropped securable audit row — the record
 * of who was handed access to a storage account — appearing only under load.
 * `AsyncLocalStorage` propagates along one call's async chain and nothing else.
 *
 * Same primitive, same directory, same reason as `lib/azure/adf-factory-context.ts`.
 *
 * ## Why this module has an import CHOKE POINT (check 9)
 *
 * De-duplicating two audit layers means one of them can be turned off, so
 * {@link withSecurableRecordedByCaller} is by construction a SUPPRESSOR of the
 * transport's row — and the replacement row exists only because `ucSecurable` is
 * the thing running it. Held by anyone else it is an off switch for the
 * securable trail, and the worst place to hold it is inside
 * `shortcut-credentials.ts` itself, where the facade never writes a replacement
 * and where the guard's check 8 (which polices imports OF that module) does not
 * look. That was measured, not imagined: a review defeated the transport's
 * instrumentation with one import line while the guard exited 0.
 *
 * So the exception is guarded like the rule. `scripts/ci/check-unity-audit-chokepoint.mjs`
 * check 9 pins ONE permitted importer per export —
 * `withSecurableRecordedByCaller` to `lib/azure/uc-securable.ts`,
 * `securableRecordedByCaller` to `lib/azure/shortcut-credentials.ts` — counts a
 * namespace / dynamic / star re-export as `*` and permits it to nobody, and
 * fails the build if the transport stops taking its suppression signal from
 * here. A second consumer is a security review: it has to record a row of its
 * own first.
 *
 * Server-only (imports node:async_hooks). Never import from a client component.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<true>();

/**
 * Run `fn` marked as already-audited by an enclosing recorder, suppressing the
 * `shortcut-credentials` transport's own row for every securable call `fn` makes.
 *
 * The ONLY permitted caller is `ucSecurable` — mechanically, not by convention:
 * check 9 of `scripts/ci/check-unity-audit-chokepoint.mjs` fails the build on an
 * import of this symbol from any other module. It exists so that one row is
 * written per call by the layer that describes it best — never to turn auditing
 * off, which is precisely what it would be anywhere else.
 */
export function withSecurableRecordedByCaller<T>(fn: () => T): T {
  return store.run(true, fn);
}

/**
 * True while inside {@link withSecurableRecordedByCaller} — i.e. a caller up the
 * async chain will record this call itself. Defaults to false, so the transport's
 * default is to record.
 */
export function securableRecordedByCaller(): boolean {
  return store.getStore() === true;
}

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
 * Server-only (imports node:async_hooks). Never import from a client component.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<true>();

/**
 * Run `fn` marked as already-audited by an enclosing recorder, suppressing the
 * `shortcut-credentials` transport's own row for every securable call `fn` makes.
 *
 * The ONLY intended caller is `ucSecurable`. It exists so that one row is written
 * per call by the layer that describes it best — never to turn auditing off.
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

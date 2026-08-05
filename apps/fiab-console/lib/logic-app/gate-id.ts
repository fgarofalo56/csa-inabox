/**
 * The gate-registry id for the Logic Apps auto-bind gate.
 *
 * Deliberately its OWN module with ZERO imports. The editor (a `'use client'`
 * component) needs this id to render the shared `<HonestGate>`, but it must not
 * reach `auto-bind.ts` to get it: that module imports the provisioner, which
 * imports `@azure/identity`, which reads `node:crypto` — and webpack fails the
 * client build outright with:
 *
 *   Module build failed: UnhandledSchemeError: Reading from "node:crypto" is
 *   not handled by plugins (Unhandled scheme).
 *
 * `tsc --noEmit` does NOT catch this (types resolve fine either way); only the
 * real `next build` does. Same hazard the gate registry documents about
 * importing self-audit instead of the pure env-checks layer.
 *
 * Server code should keep importing it from `auto-bind`, which re-exports it.
 */
export const LOGIC_APP_GATE_ID = 'svc-logic-apps';

/**
 * Optional gates-registry bridge (graceful absence).
 *
 * A parallel workstream is building `lib/gates/registry.ts` — a central
 * registry of every honest feature gate in the console (the per-client
 * *ConfigGate() helpers, surfaced as one typed list). When that module lands,
 * the self-audit derives ONE health check PER REGISTERED GATE automatically —
 * coverage grows structurally with the registry instead of a hand-list.
 *
 * Until it lands this bridge returns [] so the audit runs unchanged. The CI
 * guard (scripts/ci/check-health-coverage.mjs) FAILS the build when
 * lib/gates/registry.ts exists but this bridge is still the stub, so the
 * wiring cannot be forgotten.
 *
 * Wiring (when lib/gates/registry.ts exists) — replace the stub body with:
 *
 *   import { listGates } from '@/lib/gates/registry';
 *   export const GATES_REGISTRY_WIRED = true;
 *   export async function loadExternalGates(): Promise<ExternalGateCheck[]> {
 *     return (await listGates()).map((g) => ({
 *       id: `gate-${g.id}`,
 *       title: g.title,
 *       // A gate registry entry evaluates to null when satisfied, or a
 *       // { missing, detail } object naming the exact env var / role.
 *       evaluate: async () => {
 *         const miss = await g.evaluate();
 *         return miss ? { missing: miss.missing, detail: miss.detail } : null;
 *       },
 *       remediation: g.remediation,
 *     }));
 *   }
 */

export interface ExternalGateCheck {
  /** Stable check id (prefixed `gate-`). */
  id: string;
  title: string;
  /** null = gate satisfied (pass); otherwise the exact missing config. */
  evaluate: () => Promise<{ missing: string; detail?: string } | null>;
  remediation?: string;
}

/** Flipped to true when lib/gates/registry.ts is wired in (see header). The CI
 * coverage guard keys on this constant — do not rename. */
export const GATES_REGISTRY_WIRED = false;

export async function loadExternalGates(): Promise<ExternalGateCheck[]> {
  return [];
}

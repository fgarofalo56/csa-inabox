/**
 * Gates-registry bridge — WIRED (G2).
 *
 * `lib/gates/registry.ts` (the central registry of every honest feature gate,
 * derived from self-audit ENV_CHECKS and enriched with surfaces / Fix-it
 * metadata / live ARM options-loaders) is now present, so the self-audit
 * derives ONE health check PER REGISTERED GATE automatically — coverage grows
 * structurally with the registry instead of a hand-list.
 *
 * Evaluation is the registry's own live status (`gateStatus`), i.e. the REAL
 * env-presence evaluation the per-client *ConfigGate() helpers gate on — no
 * synthetic status (no-vaporware.md). Auto-resolving gates (bicep-derived /
 * optional-default substrates) evaluate as satisfied, matching the
 * default-ON/opt-out posture.
 *
 * The CI guard (scripts/ci/check-health-coverage.mjs) keys on
 * GATES_REGISTRY_WIRED — do not rename.
 */
import { GATES, gateStatus } from '@/lib/gates/registry';

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
export const GATES_REGISTRY_WIRED = true;

export async function loadExternalGates(): Promise<ExternalGateCheck[]> {
  return GATES.map((g) => ({
    id: `gate-${g.id}`,
    title: g.title,
    evaluate: async () => {
      const st = gateStatus(g.id);
      if (!st || st.status === 'configured') return null;
      return {
        missing: st.missing.join(', ') || g.requiredSettings.map((s) => s.envVar).join(', '),
        detail: st.check.detail,
      };
    },
    remediation: g.remediation,
  }));
}

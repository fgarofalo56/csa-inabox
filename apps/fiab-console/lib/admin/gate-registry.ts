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

/**
 * #3744 — gates whose value the Console PRODUCES (EnvSpec.runtimeProduced).
 * The sync env evaluation can only read a value that was already produced in
 * this process, so the self-audit (which /admin/readiness runs) invokes the
 * producer first. Bounded: a slow producer keeps running in the background
 * (its in-flight promise is shared) and publishes when it lands, so the
 * self-audit never waits on it past the bound.
 *
 * Server-only: this module is reached only from self-audit / health-coverage,
 * and the producer is lazy-imported so no Azure client enters this module's
 * static graph.
 */
const RUNTIME_PRODUCER_BOUND_MS = 15_000;
export const RUNTIME_PRODUCERS: Record<string, () => Promise<unknown>> = {
  'svc-databricks-sql': async () => {
    const { tryResolveWarehouseId } = await import('@/lib/azure/databricks-sql-warehouse');
    return tryResolveWarehouseId();
  },
};

async function runProducer(gateId: string): Promise<void> {
  const produce = RUNTIME_PRODUCERS[gateId];
  if (!produce) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      produce().catch(() => undefined), // the producer publishes its own classified failure
      new Promise((r) => { timer = setTimeout(r, RUNTIME_PRODUCER_BOUND_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * #4776 — run EVERY runtime producer (in parallel, each bounded by
 * RUNTIME_PRODUCER_BOUND_MS) so the replica SERVING this request has a
 * populated runtime store before its gate statuses are read. The store is
 * per-process: without this, /admin/readiness on a replica that never ran the
 * producer reads the gate blocked even when another replica produced the value.
 */
export async function runRuntimeProducers(): Promise<void> {
  await Promise.all(Object.keys(RUNTIME_PRODUCERS).map((id) => runProducer(id)));
}

export async function loadExternalGates(): Promise<ExternalGateCheck[]> {
  return GATES.map((g) => ({
    id: `gate-${g.id}`,
    title: g.title,
    evaluate: async () => {
      await runProducer(g.id);
      const st = gateStatus(g.id);
      if (!st || st.status === 'configured') return null;
      return {
        missing: st.missing.join(', ') || g.requiredSettings.map((s) => s.envVar).join(', '),
        detail: st.check.detail,
      };
    },
    // A getter, not a snapshot: for a runtime-produced gate the registry's
    // remediation is what the producer measured DURING evaluate() above.
    get remediation() {
      return g.remediation;
    },
  }));
}

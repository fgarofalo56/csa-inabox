/**
 * SHIR auto-scale-up on pipeline trigger.
 *
 * When a pipeline's run will execute (in whole or part) on a Self-Hosted
 * Integration Runtime, the scale-to-zero SHIR VMSS must be scaled up FIRST so a
 * node is online to accept the activity. This helper is the run-path hook the
 * ADF-backed run routes call before firing the pipeline:
 *
 *   const receipt = await prewarmShirForPipeline(adfPipelineName);
 *   // ... runPipeline(...) ...
 *   return NextResponse.json({ ok: true, ...runRes, ...(receipt || {}) });
 *
 * Detection (pipelineUsesSelfHostedIr) is the ADF IR-selection rule — a linked
 * service pinned via connectVia → SelfHosted IR. When detected AND a SHIR VMSS
 * is configured (LOOM_SHIR_VMSS_NAME), ensureShirUp scales 0→N and waits for a
 * node. Everything is fail-open: detection or scale-up failure NEVER blocks the
 * run — the worst case is the SHIR isn't pre-warmed and the activity itself
 * surfaces it. The idle-stop workflow scales the VMSS back to 0 when no runs are
 * active, so this is the other half of the scale-to-zero cost model.
 */
import { pipelineUsesSelfHostedIr } from './adf-client';
import { shirVmssConfig, purviewShirVmssConfig, ensureShirUp } from './vmss-client';

export interface ShirPrewarmReceipt {
  /** True when this pipeline uses a SelfHosted IR (detection result). */
  usesSelfHostedIr: boolean;
  /** True when a scale-up was issued by this call (VMSS was at 0). */
  shirScaledUp: boolean;
  /** Target capacity scaled to (0 = no scale issued). */
  shirCapacity: number;
  /** Running node count observed after the wait. */
  shirRunningNodes: number;
  /** Fail-open warning (e.g. UAMI lacks Virtual Machine Contributor). */
  shirWarning?: string;
}

/**
 * Scale the DLZ ADF SHIR VMSS up if `pipelineName` will run on a SelfHosted IR.
 * Returns a receipt for the run response, or null when there is nothing to do
 * (no SHIR configured, or the pipeline doesn't use the SHIR). Always resolves —
 * never throws.
 */
export async function prewarmShirForPipeline(pipelineName: string): Promise<ShirPrewarmReceipt | null> {
  try {
    const cfg = shirVmssConfig();
    if (!cfg) return null; // no SHIR deployed — nothing to scale (honest no-op)
    const uses = await pipelineUsesSelfHostedIr(pipelineName);
    if (!uses) return null; // pipeline runs on a Managed/AutoResolve IR — no scale needed
    const maxNodes = Number(process.env.LOOM_SHIR_MAX_NODES) || 4;
    const r = await ensureShirUp(cfg, maxNodes);
    return {
      usesSelfHostedIr: true,
      shirScaledUp: r.scaledUp,
      shirCapacity: r.capacity,
      shirRunningNodes: r.runningNodes,
      ...(r.warning ? { shirWarning: r.warning } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Scale the SHARED admin-zone Purview SHIR VMSS up if the named Purview scan
 * runs on a SelfHosted IR. Returns a receipt for the scan-trigger response, or
 * null when there is nothing to do (no Purview SHIR configured, or the scan
 * doesn't use the SHIR). Always resolves — never throws.
 *
 * The Purview SHIR is a SEPARATE VMSS from the DLZ ADF SHIR (Microsoft
 * constraint) in the admin RG, resolved via purviewShirVmssConfig().
 */
export async function prewarmPurviewShirForScan(
  sourceName: string,
  scanName: string,
): Promise<ShirPrewarmReceipt | null> {
  try {
    const cfg = purviewShirVmssConfig();
    if (!cfg) return null; // no Purview SHIR deployed — honest no-op
    const { scanUsesSelfHostedIr } = await import('./purview-client');
    const uses = await scanUsesSelfHostedIr(sourceName, scanName);
    if (!uses) return null; // scan runs on a managed/Azure-auto IR — no scale needed
    const maxNodes = Number(process.env.LOOM_PURVIEW_SHIR_MAX_NODES) || 4;
    const r = await ensureShirUp(cfg, maxNodes);
    return {
      usesSelfHostedIr: true,
      shirScaledUp: r.scaledUp,
      shirCapacity: r.capacity,
      shirRunningNodes: r.runningNodes,
      ...(r.warning ? { shirWarning: r.warning } : {}),
    };
  } catch {
    return null;
  }
}

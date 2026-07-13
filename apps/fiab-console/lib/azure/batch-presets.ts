/**
 * Client-safe Azure Batch presets + pure editor helpers.
 *
 * These are extracted OUT of `batch-client.ts` because that module instantiates
 * an `@azure/identity` credential (ManagedIdentityCredential / DefaultAzureCredential)
 * at module scope — importing ANYTHING from it into a `'use client'` component
 * (the batch-pool editor imported VM_SIZE_PRESETS / AUTOSCALE_PRESETS /
 * autoScaleFormulaFor / classifyBatchGate) pulls the credential into the browser
 * bundle and crashes the page at render with:
 *   "ManagedIdentityCredential is not supported in the browser."
 * (This was the real reason the Batch pool item "did not work at all" — the
 * editor never rendered.) This module has NO server-only imports, so the editor
 * can import it safely; `batch-client.ts` re-exports from here for server callers.
 */

/** Common Batch-supported Linux VM sizes for the pool create dropdown. */
export const VM_SIZE_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'standard_a1_v2', label: 'Standard_A1_v2 — 1 vCPU, 2 GiB (entry)' },
  { value: 'standard_d2s_v3', label: 'Standard_D2s_v3 — 2 vCPU, 8 GiB (general)' },
  { value: 'standard_d4s_v3', label: 'Standard_D4s_v3 — 4 vCPU, 16 GiB (general)' },
  { value: 'standard_f4s_v2', label: 'Standard_F4s_v2 — 4 vCPU, 8 GiB (compute)' },
  { value: 'standard_e4s_v3', label: 'Standard_E4s_v3 — 4 vCPU, 32 GiB (memory)' },
  { value: 'standard_nc4as_t4_v3', label: 'Standard_NC4as_T4_v3 — 4 vCPU, T4 GPU (AI fan-out)' },
];

/**
 * Named autoscale formulas (Batch autoscale DSL). Selected by preset key in the
 * pool dialog so the user never hand-types the formula language — the resolved
 * formula is what lands on the wire.
 */
export const AUTOSCALE_PRESETS: Array<{ value: string; label: string; formula: string }> = [
  {
    value: 'queue-driven',
    label: 'Scale to pending tasks (0–10 dedicated)',
    formula:
      '$sampleTime = TimeInterval_Minute * 5;\n' +
      '$pending = max($PendingTasks.GetSample($sampleTime));\n' +
      '$TargetDedicatedNodes = min(10, $pending);\n' +
      '$NodeDeallocationOption = taskcompletion;',
  },
  {
    value: 'spot-first',
    label: 'Prefer low-priority/Spot (0–20 Spot, 1 dedicated)',
    formula:
      '$sampleTime = TimeInterval_Minute * 5;\n' +
      '$pending = max($PendingTasks.GetSample($sampleTime));\n' +
      '$TargetLowPriorityNodes = min(20, $pending);\n' +
      '$TargetDedicatedNodes = 1;\n' +
      '$NodeDeallocationOption = taskcompletion;',
  },
  {
    value: 'business-hours',
    label: 'Business hours (5 dedicated 8–18, else 0)',
    formula:
      '$hour = time().hour;\n' +
      '$isBusiness = $hour >= 8 && $hour < 18;\n' +
      '$TargetDedicatedNodes = $isBusiness ? 5 : 0;\n' +
      '$NodeDeallocationOption = taskcompletion;',
  },
];

/** Resolve an autoscale preset key to its formula (empty string when unknown). */
export function autoScaleFormulaFor(presetKey: string): string {
  return AUTOSCALE_PRESETS.find((p) => p.value === presetKey)?.formula || '';
}

export interface BatchGateInfo {
  /** `forbidden` = 403 DLZ-admin authorization; `not_configured` = 503 missing account. */
  kind: 'forbidden' | 'not_configured';
  /** Human-readable message to render in the MessageBar. */
  error: string;
  hint?: string;
  missing?: string;
  bicep?: string;
}

/**
 * Classify a non-ok /api/items/batch-pool response into a typed gate so the
 * editor renders a 403 (DLZ-admin authorization) DISTINCTLY from a 503 missing
 * account. Pure — no I/O — so it is unit-tested.
 */
export function classifyBatchGate(status: number, body: any): BatchGateInfo {
  const kind: 'forbidden' | 'not_configured' =
    status === 403 || body?.error === 'forbidden' ? 'forbidden' : 'not_configured';
  const error =
    kind === 'forbidden'
      ? String(body?.reason || 'You do not have access to this pane.')
      : String(body?.error || 'not available');
  return { kind, error, hint: body?.hint, missing: body?.missing, bicep: body?.bicep };
}

/**
 * WS-10.5 — Parity Autopilot: the runtime AOAI halves (vision diff + plan-model).
 *
 * These wrap the PURE prompt/parse helpers in {@link module:parity-autopilot}
 * with REAL Azure OpenAI calls via the unified {@link aoaiChatJson} client:
 *
 *   • {@link runParityVisionDiff}   — sends the captured screenshot (as a data
 *     URL, multimodal `image_url` content) + the built-row claims to a
 *     vision-capable AOAI deployment and parses the per-row present/absent
 *     verdicts. This is the "vision-model diff vs the parity doc" step. Requires
 *     a gpt-4o-class (vision) deployment; a missing deployment throws the honest
 *     {@link NoAoaiDeploymentError} 503 gate (surfaced by the route — no mock).
 *
 *   • {@link proposeParityFixPlan}  — the `plan-model` step: routes ONE gap to
 *     the STRONG (reasoning) tier (WS-1.1 `tier:'strong'` / `taskClass:'reasoning'`)
 *     and parses the proposed remediation plan.
 *
 * No-vaporware: both perform the REAL data-plane call; the only non-functional
 * state is the honest NoAoaiDeploymentError gate.
 */

import { aoaiChatJson, NoAoaiDeploymentError } from '@/lib/azure/aoai-chat-client';
import type { TenantCopilotConfig } from '@/lib/types/copilot-config';
import {
  buildVisionDiffMessages,
  parseVisionDiff,
  buildFixPlanMessages,
  parseFixPlan,
  expectedBuiltRows,
  type ParityInventory,
  type ParityRow,
  type ParityGap,
  type ParityVerdict,
  type FixPlan,
} from './parity-autopilot';

export { NoAoaiDeploymentError };

/** Build a data URL from raw image bytes for the AOAI `image_url` content part. */
export function toImageDataUrl(imageBase64: string, contentType = 'image/png'): string {
  const b64 = imageBase64.startsWith('data:') ? imageBase64.split(',', 2)[1] ?? '' : imageBase64;
  return `data:${contentType};base64,${b64}`;
}

export interface VisionDiffResult {
  verdicts: ParityVerdict[];
  gaps: ParityGap[];
  /** How many built rows were checked (post-cap). */
  checked: number;
  /** The AOAI deployment that served the vision turn (for the run ledger). */
  deployment?: string;
}

/**
 * Run the vision diff for a captured surface against its parity doc's built rows.
 * REAL AOAI vision call. Throws {@link NoAoaiDeploymentError} when no AOAI
 * deployment is configured (honest 503 gate) — the caller renders the Fix-it.
 */
export async function runParityVisionDiff(args: {
  inventory: ParityInventory;
  imageBase64: string;
  contentType?: string;
  cfg?: TenantCopilotConfig | null;
}): Promise<VisionDiffResult> {
  const rows: ParityRow[] = expectedBuiltRows(args.inventory);
  if (rows.length === 0) {
    return { verdicts: [], gaps: [], checked: 0 };
  }
  const messages = buildVisionDiffMessages({
    inventory: args.inventory,
    rows,
    imageDataUrl: toImageDataUrl(args.imageBase64, args.contentType),
  });
  const raw = await aoaiChatJson<{ verdicts?: unknown }>({
    messages,
    cfg: args.cfg ?? null,
    // Vision + structured judging is a standard-tier turn; the resolved
    // deployment must be vision-capable (gpt-4o class). A non-vision deployment
    // surfaces its own honest AOAI error — no mock fallback.
    taskClass: 'general',
    maxCompletionTokens: 1500,
  });
  const { verdicts, gaps } = parseVisionDiff(raw, rows);
  return { verdicts, gaps, checked: rows.length };
}

/**
 * The `plan-model` step: propose a remediation plan for ONE gap. Routes to the
 * STRONG reasoning tier. REAL AOAI call; NoAoaiDeploymentError bubbles as the
 * honest gate.
 */
export async function proposeParityFixPlan(args: {
  gap: ParityGap;
  inventory: Pick<ParityInventory, 'title' | 'slug' | 'source'>;
  cfg?: TenantCopilotConfig | null;
}): Promise<FixPlan> {
  const raw = await aoaiChatJson<Record<string, unknown>>({
    messages: buildFixPlanMessages(args.gap, args.inventory),
    cfg: args.cfg ?? null,
    tier: 'strong',
    taskClass: 'reasoning',
    maxCompletionTokens: 1200,
  });
  return parseFixPlan(raw);
}

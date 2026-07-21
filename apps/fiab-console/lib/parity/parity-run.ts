/**
 * WS-10.5 — Parity Autopilot: run orchestration + the Cosmos run ledger.
 *
 * {@link runParityAutopilot} is the end-to-end server-side pipeline for ONE
 * surface, given an already-captured screenshot (the Playwright/Track-0 capture
 * happens script-side and is POSTed in — see scripts/csa-loom/parity-autopilot.mjs):
 *
 *   parse doc → vision diff (real AOAI) → for each gap: plan-model (real AOAI) +
 *   file gh issue (real GitHub) → persist a run doc to the `parity-autopilot-runs`
 *   Cosmos container.
 *
 * The run doc is what the admin surface reads for "last run / gaps found / filed
 * issues". No-vaporware: every step is a real call; the honest gates
 * (NoAoaiDeploymentError, GitHub-not-configured) are captured INTO the run doc so
 * the admin surface shows exactly what was and wasn't reachable.
 */

import { parityAutopilotRunsContainer } from '@/lib/azure/cosmos-client';
import type { TenantCopilotConfig } from '@/lib/types/copilot-config';
import {
  parseParityDoc,
  shapeGapIssue,
  type ParityGap,
  type FixPlan,
} from './parity-autopilot';
import { runParityVisionDiff, proposeParityFixPlan, NoAoaiDeploymentError } from './parity-vision';
import { fileParityGapIssue, type FileIssueResult } from './parity-issue';

/** Partition-key scope for run docs — the deployment's Entra tenant id. */
export function parityRunScope(): string {
  return process.env.AZURE_TENANT_ID || 'unknown';
}

/** Default TTL for a run doc (180 days), in seconds. */
const RUN_TTL_SECONDS = 180 * 24 * 3600;

export interface ParityGapOutcome {
  gap: ParityGap;
  plan?: FixPlan;
  issue?: FileIssueResult;
  /** Set when the plan-model step failed for this gap (e.g. AOAI gate). */
  planError?: string;
}

export interface ParityRunDoc {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  route?: string;
  capturedAt?: string;
  theme?: string;
  url?: string;
  /** How many built rows were checked by the vision pass. */
  checked: number;
  /** Total gaps the vision pass found. */
  gapCount: number;
  /** Per-gap outcomes (plan + issue). */
  gaps: ParityGapOutcome[];
  /** True when a vision/plan honest-gate short-circuited the run. */
  gated?: boolean;
  gateReason?: string;
  ranAt: string;
  ranBy: string;
  ttl: number;
}

export interface RunParityArgs {
  slug: string;
  /** Raw parity-doc markdown (read script-side; the container may not ship docs). */
  docMarkdown: string;
  /** Base64 PNG/JPEG of the captured surface. */
  imageBase64: string;
  contentType?: string;
  routeOverride?: string;
  capturedAt?: string;
  theme?: string;
  url?: string;
  ranBy: string;
  cfg?: TenantCopilotConfig | null;
  /** When true, run the diff + plan but do NOT file issues (dry preview). */
  dryRun?: boolean;
}

/**
 * Run the full autopilot pipeline for one surface and persist the run doc.
 * Returns the persisted {@link ParityRunDoc}. A vision honest-gate
 * (NoAoaiDeploymentError) is recorded as `gated` rather than thrown, so the
 * scheduled caller and the admin surface both see a real, explained result.
 */
export async function runParityAutopilot(args: RunParityArgs): Promise<ParityRunDoc> {
  const inv = parseParityDoc(args.docMarkdown, args.slug);
  if (args.routeOverride && args.routeOverride.startsWith('/')) inv.route = args.routeOverride;

  const base: ParityRunDoc = {
    id: `run-${args.slug}-${Date.now()}`,
    tenantId: parityRunScope(),
    slug: args.slug,
    title: inv.title,
    route: inv.route,
    capturedAt: args.capturedAt,
    theme: args.theme,
    url: args.url,
    checked: 0,
    gapCount: 0,
    gaps: [],
    ranAt: new Date().toISOString(),
    ranBy: args.ranBy,
    ttl: RUN_TTL_SECONDS,
  };

  try {
    const diff = await runParityVisionDiff({
      inventory: inv,
      imageBase64: args.imageBase64,
      contentType: args.contentType,
      cfg: args.cfg ?? null,
    });
    base.checked = diff.checked;
    base.gapCount = diff.gaps.length;

    for (const gap of diff.gaps) {
      const outcome: ParityGapOutcome = { gap };
      // plan-model (reasoning tier). Honest-gate captured per-gap.
      try {
        outcome.plan = await proposeParityFixPlan({ gap, inventory: inv, cfg: args.cfg ?? null });
      } catch (e: any) {
        outcome.planError =
          e instanceof NoAoaiDeploymentError ? `plan-model gated: ${e.message}` : `plan-model failed: ${e?.message || e}`;
      }
      // file gh issue (unless dry-run). Needs a plan to be useful; still files
      // with an empty-plan placeholder if the plan-model gated, so the gap is
      // never silently dropped.
      if (!args.dryRun) {
        const plan: FixPlan = outcome.plan ?? {
          summary: outcome.planError || 'No plan generated (plan-model unavailable).',
          steps: [],
        };
        const shaped = shapeGapIssue({
          inventory: inv,
          gap,
          plan,
          runMeta: { capturedAt: args.capturedAt, theme: args.theme, url: args.url },
        });
        outcome.issue = await fileParityGapIssue(shaped);
      }
      base.gaps.push(outcome);
    }
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      base.gated = true;
      base.gateReason = e.message;
    } else {
      base.gated = true;
      base.gateReason = `vision diff failed: ${e?.message || e}`;
    }
  }

  await persistRun(base);
  return base;
}

/** Upsert a run doc (best-effort — a Cosmos blip never fails the run result). */
export async function persistRun(doc: ParityRunDoc): Promise<void> {
  try {
    const c = await parityAutopilotRunsContainer();
    await c.items.upsert(doc);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[parity-autopilot] run persist failed (non-fatal)', e?.message || e);
  }
}

/** List recent run docs for this tenant, newest first. */
export async function listParityRuns(limit = 25): Promise<ParityRunDoc[]> {
  try {
    const c = await parityAutopilotRunsContainer();
    const { resources } = await c.items
      .query<ParityRunDoc>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.ranAt DESC OFFSET 0 LIMIT @n',
        parameters: [
          { name: '@t', value: parityRunScope() },
          { name: '@n', value: Math.min(Math.max(limit, 1), 100) },
        ],
      })
      .fetchAll();
    return resources || [];
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[parity-autopilot] run list failed', e?.message || e);
    return [];
  }
}

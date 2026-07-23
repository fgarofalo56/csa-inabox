/**
 * prompt-registry — the N13 governed PROMPT REGISTRY (Cosmos-backed, server-only).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE — this EXTENDS WS-E, it does not duplicate it.
 * ─────────────────────────────────────────────────────────────────────────────
 * WS-E (E1–E6, already on main) owns:
 *   • the eval harness            → azure-functions/copilot-evaluator
 *   • the score floors            → content/evals/eval-floors.json
 *   • the CI gate                 → scripts/csa-loom/check-eval-regression.mjs
 *                                   + .github/workflows/copilot-quality-evals.yml
 *   • the read surface            → /admin/copilot-quality (E5 + E6 + SRCH1)
 *
 * N13 adds NONE of those. It adds the missing artifact: prompts as SEMVER'D,
 * EVAL-SCORED, HUMAN-APPROVED versions — and wires a prompt bump into the
 * EXISTING machinery:
 *
 *   publishVersion(…)
 *     └─► triggerEvaluatorRun({ surfaces:[prompt.surface] })      ← E2's Function,
 *         the EXACT HTTP trigger .github/workflows/copilot-quality-evals.yml
 *         POSTs. No second evaluator, no second harness.
 *           └─► the Function writes `eval-run` docs to loom-copilot-evals
 *                 └─► attachLatestEvalScore(…) stamps that REAL run onto the
 *                     version, with its floor verdict computed by the SAME
 *                     floorStatusFor() + eval-floors.json the E3/E5 path uses
 *                       └─► the EXISTING E3 gate (check-eval-regression.mjs,
 *                           artifact OR `--cosmos` mode) fails CI on a
 *                           below-floor run. NO SECOND CI GATE IS ADDED.
 *
 * `approveVersion` is the human control point on top of that: it REFUSES a
 * below-floor version unless an admin passes an explicit override, and every
 * approval / rollback / publish writes an `_auditLog` row
 * ({kind:'llmops.prompt.approve'}, …) via the shared `auditLogContainer()`.
 *
 * No-vaporware: every read/write here is a REAL Cosmos call against
 * `loom-prompt-registry`; the eval hook is a REAL POST to the evaluator Function
 * and degrades to an HONEST recorded gate (never a fabricated "run started")
 * when LOOM_COPILOT_EVALUATOR_URL is unwired.
 *
 * Per-cloud: identical Commercial / GCC-High. IL5 / SOVEREIGN MOAT: the
 * registry, the eval scores it carries, and the approval records never leave the
 * deployment's VNet — Cosmos + the in-VNet evaluator Function only. There is NO
 * external LLMOps SaaS (Braintrust / LangSmith / W&B) anywhere in this path,
 * which is exactly why Loom builds prompt governance natively: an IL5 enclave
 * cannot ship prompts, completions, or scores to a commercial multi-tenant
 * service, so in-boundary is the only compliant option.
 */

import { promptRegistryContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { surfaceRunHistory, loadEvalFloors } from '@/lib/azure/copilot-quality-store';
import { floorStatusFor } from '@/lib/admin/copilot-quality';
import { triggerEvaluatorRun, evaluatorRunGate } from '@/lib/azure/copilot-evaluator-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  INITIAL_PROMPT_VERSION,
  PROMPT_REGISTRY_SCHEMA_VERSION,
  approvalEligibility,
  bumpSemver,
  latestVersion,
  parseSemver,
  resolveActiveVersion,
  sortVersionsDesc,
  type PromptApproval,
  type PromptDoc,
  type PromptEvalScore,
  type PromptVersionDoc,
  type SemverBump,
} from '@/lib/azure/prompt-registry-model';

export type {
  PromptDoc, PromptVersionDoc, PromptEvalScore, PromptApproval,
} from '@/lib/azure/prompt-registry-model';

/** Actor context for the audit trail (from the admin session). */
export interface PromptActor {
  oid: string;
  /** UPN / email / display fallback. */
  who: string;
  tenantId: string;
}

/** Bound a single prompt's version scan (single-partition read). */
const MAX_VERSION_DOCS = 200;
/** Bound the registry listing. */
const MAX_PROMPT_DOCS = 200;

// ── Audit ────────────────────────────────────────────────────────────────────

/**
 * Write the authoritative `_auditLog` row for a privileged registry mutation and
 * fan it out through `emitAuditEvent` (SIEM + webhooks) — the same audit
 * standard as every other admin-plane mutation. Best-effort: an audit hiccup
 * never blocks the mutation (matching runtime-flags / env-apply).
 */
async function auditPrompt(
  kind: 'llmops.prompt.register' | 'llmops.prompt.publish' | 'llmops.prompt.approve' | 'llmops.prompt.rollback',
  actor: PromptActor,
  promptId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const at = new Date().toISOString();
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `llmops-prompt:${promptId}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        at,
        kind,
        target: promptId,
        detail,
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: kind,
    targetType: 'llmops-prompt',
    targetId: promptId,
    tenantId: actor.tenantId,
    detail,
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function readPrompt(promptId: string): Promise<PromptDoc | null> {
  const c = await promptRegistryContainer();
  try {
    const { resource } = await c.item(`prompt:${promptId}`, promptId).read<PromptDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

/** Every version doc for one prompt, newest semver first (single-partition). */
export async function listVersions(promptId: string): Promise<PromptVersionDoc[]> {
  const c = await promptRegistryContainer();
  const { resources } = await c.items
    .query<PromptVersionDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'prompt-version' AND c.promptId = @p OFFSET 0 LIMIT @n",
        parameters: [
          { name: '@p', value: promptId },
          { name: '@n', value: MAX_VERSION_DOCS },
        ],
      },
      { partitionKey: promptId },
    )
    .fetchAll();
  return sortVersionsDesc(resources);
}

/** One registered prompt joined with its versions (null when unknown). */
export async function getPrompt(
  promptId: string,
): Promise<{ prompt: PromptDoc; versions: PromptVersionDoc[] } | null> {
  const prompt = await readPrompt(promptId);
  if (!prompt) return null;
  return { prompt, versions: await listVersions(promptId) };
}

/** A registry row for the admin list. */
export interface PromptSummary {
  promptId: string;
  surface: string;
  label: string;
  description: string;
  owner: string;
  activeVersion: string | null;
  /** The active version's eval score, when it has one. */
  activeScore: PromptEvalScore | null;
  /** The approval record on the active version. */
  activeApproval: PromptApproval | null;
  latestVersion: string | null;
  latestStatus: PromptVersionDoc['status'] | null;
  versionCount: number;
  /** True when the newest version is not the active one (a bump awaits approval). */
  pendingApproval: boolean;
  updatedAt: string;
}

/**
 * Every registered prompt with its version roll-up. Cross-partition (the admin
 * list is a cold read), bounded MAX_PROMPT_DOCS, sorted by promptId so the table
 * is deterministic.
 */
export async function listPrompts(): Promise<PromptSummary[]> {
  const c = await promptRegistryContainer();
  const { resources: prompts } = await c.items
    .query<PromptDoc>(
      {
        query: "SELECT * FROM c WHERE c.docType = 'prompt' OFFSET 0 LIMIT @n",
        parameters: [{ name: '@n', value: MAX_PROMPT_DOCS }],
      },
      { maxItemCount: MAX_PROMPT_DOCS },
    )
    .fetchAll();

  const out: PromptSummary[] = [];
  for (const p of prompts) {
    const versions = await listVersions(p.promptId);
    const active = resolveActiveVersion(p, versions);
    const newest = versions[0] ?? null;
    out.push({
      promptId: p.promptId,
      surface: p.surface,
      label: p.label,
      description: p.description,
      owner: p.owner,
      activeVersion: active?.version ?? null,
      activeScore: active?.evalScore ?? null,
      activeApproval: active?.approval ?? null,
      latestVersion: newest?.version ?? null,
      latestStatus: newest?.status ?? null,
      versionCount: versions.length,
      pendingApproval: !!newest && newest.status !== 'approved',
      updatedAt: p.updatedAt,
    });
  }
  return out.sort((a, b) => a.promptId.localeCompare(b.promptId));
}

/**
 * The RUNTIME read: the approved, active version of a prompt — or null when the
 * prompt is unknown or has no approved active version. Deliberately strict: an
 * unapproved draft is NEVER served, which is what makes this a governance
 * control. Callers fall back to their built-in prompt when this returns null
 * (default-ON / opt-out — the registry never gates a surface that has not
 * adopted it).
 */
export async function getActivePrompt(
  promptId: string,
): Promise<{ prompt: PromptDoc; version: PromptVersionDoc } | null> {
  const loaded = await getPrompt(promptId);
  if (!loaded) return null;
  const version = resolveActiveVersion(loaded.prompt, loaded.versions);
  return version ? { prompt: loaded.prompt, version } : null;
}

// ── Register ─────────────────────────────────────────────────────────────────

export interface RegisterPromptInput {
  promptId: string;
  /** The Copilot surface whose golden eval set scores this prompt. */
  surface: string;
  label: string;
  description?: string;
  owner?: string;
  /** The initial prompt text (registered as version 1.0.0, status 'draft'). */
  template: string;
}

/**
 * Register a new prompt + its initial version (1.0.0, `draft`). Audited.
 * Idempotent-safe: re-registering an existing promptId throws so an accidental
 * overwrite can never silently discard approval history.
 */
export async function registerPrompt(
  input: RegisterPromptInput,
  actor: PromptActor,
): Promise<{ prompt: PromptDoc; version: PromptVersionDoc }> {
  const promptId = String(input.promptId || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(promptId)) {
    throw new Error('promptId must be 2–80 chars of letters, digits, dot, dash or underscore.');
  }
  const surface = String(input.surface || '').trim();
  if (!surface) throw new Error('surface is required — it selects the golden eval set that scores this prompt.');
  const template = String(input.template || '').trim();
  if (!template) throw new Error('template (the prompt text) is required.');
  if (await readPrompt(promptId)) throw new Error(`Prompt "${promptId}" is already registered.`);

  const now = new Date().toISOString();
  const prompt: PromptDoc = {
    id: `prompt:${promptId}`,
    promptId,
    docType: 'prompt',
    schemaVersion: PROMPT_REGISTRY_SCHEMA_VERSION,
    surface,
    label: String(input.label || promptId).trim(),
    description: String(input.description || '').trim(),
    owner: String(input.owner || actor.who).trim(),
    activeVersion: null,
    createdAt: now,
    createdBy: actor.who,
    updatedAt: now,
    updatedBy: actor.who,
  };
  const version: PromptVersionDoc = {
    id: `version:${promptId}:${INITIAL_PROMPT_VERSION}`,
    promptId,
    docType: 'prompt-version',
    schemaVersion: PROMPT_REGISTRY_SCHEMA_VERSION,
    version: INITIAL_PROMPT_VERSION,
    template,
    notes: 'Initial registration.',
    status: 'draft',
    createdAt: now,
    createdBy: actor.who,
  };

  const c = await promptRegistryContainer();
  await c.items.create(prompt);
  await c.items.create(version);
  await auditPrompt('llmops.prompt.register', actor, promptId, {
    surface, version: INITIAL_PROMPT_VERSION, templateChars: template.length,
  });
  return { prompt, version };
}

// ── Publish (→ the EXISTING E2 evaluator, NOT a new gate) ────────────────────

export interface PublishVersionInput {
  /** The new prompt text. */
  template: string;
  /** Which semver component to bump (default 'minor'). Ignored when `version` is given. */
  bump?: SemverBump;
  /** Pin an explicit semver instead of bumping (must exceed the current latest). */
  version?: string;
  notes?: string;
  /**
   * Skip the evaluator trigger (the version is still published, just unscored).
   * Used by tests + by an admin batching several bumps before one eval run.
   */
  skipEval?: boolean;
}

export interface PublishVersionResult {
  version: PromptVersionDoc;
  /** True when the E2 evaluator accepted the run request. */
  evalRequested: boolean;
  /** The honest gate when the evaluator Function is unwired (never a fake run). */
  evalGate: PromptVersionDoc['evalGate'];
  /** The evaluator's own response body, verbatim, when it answered. */
  evaluatorResponse?: unknown;
}

/**
 * Publish a new semver'd version of a prompt and hand it to the EXISTING WS-E
 * evaluator for scoring.
 *
 * The eval hook is deliberately a call to {@link triggerEvaluatorRun} — the very
 * same client the E5 "Run now" button and the E4 workflow use to POST
 * `/api/copilotEvaluatorHttp`. A prompt bump therefore produces an ordinary E2
 * `eval-run` doc for the prompt's surface, which the EXISTING E3 gate
 * (`check-eval-regression.mjs`, artifact or `--cosmos` mode) already grades
 * against `content/evals/eval-floors.json` in the EXISTING
 * `copilot-quality-evals.yml` workflow. N13 adds NO second CI gate, NO second
 * floors file, and NO second harness.
 *
 * When the evaluator Function is not wired, the honest gate is RECORDED on the
 * version (`evalGate`) instead of a fabricated run — the version simply cannot
 * be approved until a real score lands (see {@link approveVersion}).
 */
export async function publishVersion(
  promptId: string,
  input: PublishVersionInput,
  actor: PromptActor,
): Promise<PublishVersionResult> {
  const prompt = await readPrompt(promptId);
  if (!prompt) throw new Error(`Prompt "${promptId}" is not registered.`);
  const template = String(input.template || '').trim();
  if (!template) throw new Error('template (the prompt text) is required.');

  const versions = await listVersions(promptId);
  const current = latestVersion(versions.map((v) => v.version)) ?? '0.0.0';
  let next: string;
  if (input.version) {
    if (!parseSemver(input.version)) throw new Error(`"${input.version}" is not a valid semver (X.Y.Z).`);
    if (versions.some((v) => v.version === input.version)) {
      throw new Error(`Version ${input.version} already exists for "${promptId}".`);
    }
    next = input.version;
  } else {
    next = bumpSemver(current, input.bump ?? 'minor');
  }

  const now = new Date().toISOString();
  const c = await promptRegistryContainer();

  // Fire the EXISTING E2 evaluator for this prompt's surface (unless skipped).
  let evalRequested = false;
  let evalGate: PromptVersionDoc['evalGate'] = null;
  let evaluatorResponse: unknown;
  if (!input.skipEval) {
    const gate = evaluatorRunGate();
    if (gate) {
      evalGate = { gateId: gate.gateId, missing: gate.missing, remediation: gate.remediation };
    } else {
      const result = await triggerEvaluatorRun({ surfaces: [prompt.surface], trigger: 'manual' });
      evalRequested = result.ok;
      evaluatorResponse = result.body;
      if (!result.ok) {
        evalGate = {
          gateId: 'svc-copilot-evaluator',
          missing: [],
          remediation:
            `The copilot-evaluator Function did not accept the run (HTTP ${result.status}${result.error ? `: ${result.error}` : ''}). ` +
            'Re-run it from Admin → Copilot quality → "Run now", then refresh this version\'s score.',
        };
      }
    }
  }

  const version: PromptVersionDoc = {
    id: `version:${promptId}:${next}`,
    promptId,
    docType: 'prompt-version',
    schemaVersion: PROMPT_REGISTRY_SCHEMA_VERSION,
    version: next,
    template,
    notes: String(input.notes || '').trim() || undefined,
    status: 'published',
    evalRunId: null,
    evalRequestedAt: input.skipEval ? undefined : now,
    evalGate,
    createdAt: now,
    createdBy: actor.who,
  };
  await c.items.create(version);
  await c.items.upsert({ ...prompt, updatedAt: now, updatedBy: actor.who });

  await auditPrompt('llmops.prompt.publish', actor, promptId, {
    version: next, from: current, surface: prompt.surface,
    templateChars: template.length, evalRequested, evalGate,
  });

  return { version, evalRequested, evalGate, evaluatorResponse };
}

// ── Attach the REAL eval score from the E2 run ───────────────────────────────

/**
 * Stamp the newest REAL `eval-run` rollup for the prompt's surface onto a
 * version, with its floor verdict computed by the SAME `floorStatusFor()` +
 * `content/evals/eval-floors.json` the E3 gate and the E5 scorecard use — one
 * source of truth for "is this below floor", never a re-derived threshold.
 *
 * Returns null when the surface has no runs yet (the version stays unscored and
 * therefore unapprovable — honest, not fabricated).
 */
export async function attachLatestEvalScore(
  promptId: string,
  version: string,
): Promise<PromptEvalScore | null> {
  const c = await promptRegistryContainer();
  const { resource: doc } = await c.item(`version:${promptId}:${version}`, promptId).read<PromptVersionDoc>();
  if (!doc) throw new Error(`Version ${version} of "${promptId}" not found.`);
  const prompt = await readPrompt(promptId);
  if (!prompt) throw new Error(`Prompt "${promptId}" is not registered.`);

  const history = await surfaceRunHistory(prompt.surface);
  const latest = history[0];
  if (!latest) return null;

  const floors = loadEvalFloors();
  const floor = floors.floors[prompt.surface];
  const statuses = floorStatusFor(latest.totals, floor);
  const belowFloorMetrics = statuses.filter((s) => s.verdict === 'below').map((s) => s.metric);

  const score: PromptEvalScore = {
    surface: prompt.surface,
    runId: latest.runId,
    finishedAt: latest.finishedAt,
    questions: latest.totals.questions,
    retrievalHitRate: latest.totals.retrievalHitRate,
    groundingAvg: latest.totals.groundingAvg,
    passRate: latest.totals.passRate,
    belowFloor: belowFloorMetrics.length > 0,
    belowFloorMetrics,
    provisionalFloor: !!floor?.provisional,
  };

  await c.items.upsert({
    ...doc,
    evalRunId: latest.runId,
    evalScore: score,
    evalGate: null,
    updatedAt: new Date().toISOString(),
  } satisfies PromptVersionDoc);
  return score;
}

// ── Approve (AUDITED) ────────────────────────────────────────────────────────

export interface ApproveVersionInput {
  note?: string;
  /**
   * Approve despite a below-floor eval score. Recorded in the audit row as
   * `overrodeFloor: true` — the deliberate, evidenced escape hatch, never the
   * default.
   */
  overrideBelowFloor?: boolean;
  /**
   * Re-read the surface's newest eval run before deciding (default true) — so an
   * approval always grades the freshest REAL score, not a stale stamp.
   */
  refreshScore?: boolean;
}

/**
 * Approve a version and make it the prompt's ACTIVE version.
 *
 * AUDITED — writes `{kind:'llmops.prompt.approve', ...}` to `_auditLog` via
 * `auditLogContainer()` and fans out through `emitAuditEvent`. The approval is
 * refused (with the exact reason) when the version has no eval score yet, or
 * when its score sat below the surface's E3 floor and no explicit override was
 * supplied — the WS-E floors are the gate, reused, not re-implemented.
 */
export async function approveVersion(
  promptId: string,
  version: string,
  actor: PromptActor,
  input: ApproveVersionInput = {},
): Promise<{ prompt: PromptDoc; version: PromptVersionDoc }> {
  const prompt = await readPrompt(promptId);
  if (!prompt) throw new Error(`Prompt "${promptId}" is not registered.`);
  const c = await promptRegistryContainer();

  if (input.refreshScore !== false) {
    // Best-effort: a Cosmos/eval hiccup must not block a legitimate approval of
    // an already-scored version — the stamped score is then the one graded.
    await attachLatestEvalScore(promptId, version).catch(() => null);
  }

  const { resource: doc } = await c.item(`version:${promptId}:${version}`, promptId).read<PromptVersionDoc>();
  if (!doc) throw new Error(`Version ${version} of "${promptId}" not found.`);

  const eligibility = approvalEligibility(doc, { overrideBelowFloor: input.overrideBelowFloor });
  if (!eligibility.allowed) {
    await auditPrompt('llmops.prompt.approve', actor, promptId, {
      version, outcome: 'refused', reason: eligibility.reason, detail: eligibility.detail,
    });
    const err = new Error(eligibility.detail) as Error & { code?: string };
    err.code = `prompt_approval_${eligibility.reason.replace('-', '_')}`;
    throw err;
  }

  const now = new Date().toISOString();
  const approval: PromptApproval = {
    approvedBy: actor.who,
    approvedByOid: actor.oid,
    approvedAt: now,
    note: String(input.note || '').trim() || undefined,
    overrodeFloor: !!(input.overrideBelowFloor && doc.evalScore?.belowFloor),
  };
  const approved: PromptVersionDoc = { ...doc, status: 'approved', approval, updatedAt: now };
  const updatedPrompt: PromptDoc = { ...prompt, activeVersion: version, updatedAt: now, updatedBy: actor.who };
  await c.items.upsert(approved);
  await c.items.upsert(updatedPrompt);

  await auditPrompt('llmops.prompt.approve', actor, promptId, {
    version,
    outcome: 'approved',
    priorActiveVersion: prompt.activeVersion,
    overrodeFloor: approval.overrodeFloor,
    note: approval.note,
    evalRunId: doc.evalScore?.runId ?? null,
    score: doc.evalScore
      ? {
          retrievalHitRate: doc.evalScore.retrievalHitRate,
          groundingAvg: doc.evalScore.groundingAvg,
          passRate: doc.evalScore.passRate,
          belowFloor: doc.evalScore.belowFloor,
        }
      : null,
  });
  return { prompt: updatedPrompt, version: approved };
}

// ── Rollback (AUDITED) ───────────────────────────────────────────────────────

/**
 * Roll the active version back to an EARLIER previously-approved version.
 * AUDITED. The version being left is marked `rolled-back` so the timeline shows
 * what happened; its approval record is retained (governance history is never
 * rewritten). A version that was never approved cannot be rolled back TO — that
 * would let an unreviewed prompt reach production through the back door.
 */
export async function rollbackTo(
  promptId: string,
  version: string,
  actor: PromptActor,
  opts: { reason?: string } = {},
): Promise<{ prompt: PromptDoc; version: PromptVersionDoc }> {
  const prompt = await readPrompt(promptId);
  if (!prompt) throw new Error(`Prompt "${promptId}" is not registered.`);
  if (prompt.activeVersion === version) {
    throw new Error(`Version ${version} is already the active version of "${promptId}".`);
  }
  const c = await promptRegistryContainer();
  const { resource: target } = await c.item(`version:${promptId}:${version}`, promptId).read<PromptVersionDoc>();
  if (!target) throw new Error(`Version ${version} of "${promptId}" not found.`);
  if (!target.approval) {
    throw new Error(
      `Version ${version} was never approved, so it cannot be rolled back to. Approve it explicitly (audited) instead.`,
    );
  }

  const now = new Date().toISOString();
  // Mark the version being left as rolled-back (history preserved).
  if (prompt.activeVersion) {
    const { resource: leaving } = await c
      .item(`version:${promptId}:${prompt.activeVersion}`, promptId)
      .read<PromptVersionDoc>();
    if (leaving) await c.items.upsert({ ...leaving, status: 'rolled-back', updatedAt: now } satisfies PromptVersionDoc);
  }
  const restored: PromptVersionDoc = { ...target, status: 'approved', updatedAt: now };
  const updatedPrompt: PromptDoc = { ...prompt, activeVersion: version, updatedAt: now, updatedBy: actor.who };
  await c.items.upsert(restored);
  await c.items.upsert(updatedPrompt);

  await auditPrompt('llmops.prompt.rollback', actor, promptId, {
    from: prompt.activeVersion, to: version, reason: String(opts.reason || '').trim() || undefined,
  });
  return { prompt: updatedPrompt, version: restored };
}

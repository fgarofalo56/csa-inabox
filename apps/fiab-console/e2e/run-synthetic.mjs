#!/usr/bin/env node
/**
 * Synthetic-journey monitor entrypoint (V1) — a THIN wrapper over the existing
 * run-uat-unattended.mjs machinery so session-mint, Playwright execution, the
 * gate-aware `UAT_RESULT pass/fail/realFails/infraGated` summary, exit-code
 * semantics AND the Blob artifact upload are reused VERBATIM.
 *
 * What it pins:
 *   UAT_PROJECT=journey       — the `journey` playwright project
 *                               (testMatch synthetic-journeys.uat.ts; the
 *                               project stub lands on PR #2411 — this wrapper
 *                               depends on it and touches no config itself.
 *                               Until #2411 merges, run with UAT_PROJECT=uat —
 *                               the spec also matches the uat project's
 *                               *.uat.ts glob and UAT_GREP still slices it).
 *   UAT_GREP="synthetic"      — the six-journey slice.
 *   UAT_RUN_TAG=synthetic/<ts>— artifacts upload under
 *                               uat-runs/synthetic/<runId>/ in
 *                               LOOM_UAT_RESULTS_CONTAINER, the prefix the
 *                               Journeys tab (/api/admin/synthetic-runs) lists
 *                               and the ~30d Blob lifecycle rule targets.
 *
 * Runs on the scheduled `loom-synthetic-monitor` Container App Job
 * (modules/admin-plane/synthetic-monitor-job.bicep) every 15 minutes, in-VNet,
 * as the console UAMI. Exit non-zero ONLY on real code failures (a broken
 * login path J1 included) — honest infra gates exit 0.
 */

process.env.UAT_PROJECT = process.env.UAT_PROJECT || 'journey';
process.env.UAT_GREP = process.env.UAT_GREP || 'synthetic';
if (!process.env.UAT_RUN_TAG) {
  // Blob-safe timestamp id: 2026-07-22T12-00-00-000Z
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  process.env.UAT_RUN_TAG = `synthetic/${ts}`;
}

// run-uat-unattended.mjs invokes main() at import — importing IS running.
await import('./run-uat-unattended.mjs');

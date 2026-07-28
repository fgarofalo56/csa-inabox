#!/usr/bin/env node
/**
 * copilot-evaluator — Container App Job entrypoint (E2 / SRCH1 / E6).
 *
 * One-shot process: `modules/admin-plane/copilot-evaluator-job.bicep` schedules
 * `loom-copilot-evaluator` (Schedule trigger, default nightly 07:00 UTC —
 * off-peak so LLM-judge spend never competes with production Copilot AOAI TPM)
 * in the console's VNet-integrated Container Apps Environment, running as the
 * console UAMI. Each execution runs the requested eval modes once and exits.
 *
 * WHY AN ACA JOB, NOT A Y1 FUNCTION (estate constraint, operator decision
 * 2026-07-23): Y1 Linux Consumption Functions are structurally broken on this
 * estate — Azure Policy seals the storage data-plane (publicNetworkAccess
 * Disabled, AAD-only, no private endpoint) and the multitenant Y1 runtime is
 * not a trusted service, so host keys and timer leases fail. The in-VNet
 * ACA-job pattern (lineage-extractor-job.bicep / synthetic-monitor-job.bicep)
 * is the estate standard. It also removes the Function host key entirely: the
 * former HTTP trigger's "Run now" path is now an ARM job-start (the console
 * UAMI holds Contributor on the job resource), so there is no key to leak and
 * no public `*.azurewebsites.net` surface at all.
 *
 * Run parameters (all optional — the scheduled execution sets none and runs
 * every mode; an on-demand start overrides them in the execution template):
 *   COPILOT_EVAL_MODE     'all' (default) | 'copilot' | 'search' | 'tier'
 *   COPILOT_EVAL_TRIGGER  'nightly' (default) | 'manual' | 'corpus'
 *   COPILOT_EVAL_SURFACES comma-separated surfaces (mode copilot; empty = all)
 *   COPILOT_EVAL_DOMAINS  comma-separated domains  (mode search;  empty = all)
 *
 * Exit code: 0 on a completed pass INCLUDING an honest config gate (an unset
 * Cosmos endpoint or a missing eval set is a configuration state, not a code
 * failure). Non-zero ONLY on an unexpected throw, so a Failed execution in the
 * ACA job history is always a real regression worth paging on.
 *
 * Machine-readable receipt: the last line of a copilot-mode execution is
 * `::eval-run::{json}` carrying the SAME `{ok, trigger, surfaces:[…]}` shape the
 * retired HTTP trigger returned, so .github/workflows/copilot-quality-evals.yml
 * can lift it out of the execution's console logs and feed
 * scripts/csa-loom/check-eval-regression.mjs unchanged.
 */
import { runEvals, runSearchEvals, runTierEvals } from './run-evals';
import { consoleLogger } from './run-logger';

type Mode = 'all' | 'copilot' | 'search' | 'tier';
type Trigger = 'corpus' | 'nightly' | 'manual';

function parseMode(raw: string | undefined): Mode {
  const v = (raw || '').trim().toLowerCase();
  return v === 'copilot' || v === 'search' || v === 'tier' ? v : 'all';
}

function parseTrigger(raw: string | undefined): Trigger {
  const v = (raw || '').trim().toLowerCase();
  return v === 'manual' || v === 'corpus' ? v : 'nightly';
}

function parseList(raw: string | undefined): string[] | undefined {
  const list = (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

async function main(): Promise<void> {
  const started = Date.now();
  const mode = parseMode(process.env.COPILOT_EVAL_MODE);
  const trigger = parseTrigger(process.env.COPILOT_EVAL_TRIGGER);
  const surfaces = parseList(process.env.COPILOT_EVAL_SURFACES);
  const domains = parseList(process.env.COPILOT_EVAL_DOMAINS);
  const log = consoleLogger;

  log.log(
    `[copilot-evaluator] execution start — mode=${mode} trigger=${trigger}` +
      (surfaces ? ` surfaces=${surfaces.join('|')}` : '') +
      (domains ? ` domains=${domains.join('|')}` : ''),
  );

  if (mode === 'all' || mode === 'copilot') {
    const summary = await runEvals(trigger, surfaces, log);
    log.log(
      `[copilot-evaluator] answer-quality pass complete — ran=${summary.ran}` +
        (summary.reason ? ` reason=${summary.reason}` : '') +
        ` surfaces=${summary.surfaces.length}`,
    );
    // CI receipt — the exact body shape the retired HTTP trigger returned.
    log.log(`::eval-run::${JSON.stringify({ ok: summary.ran, reason: summary.reason, trigger, surfaces: summary.surfaces })}`);
  }

  // SRCH1 — federated-search relevance (deterministic, no judge spend).
  // Honest no-op when unconfigured (missing sets / principal).
  if (mode === 'all' || mode === 'search') {
    const search = await runSearchEvals(trigger, domains, log);
    log.log(
      `[copilot-evaluator/search] pass complete — ran=${search.ran}` +
        (search.reason ? ` reason=${search.reason}` : '') +
        ` domains=${search.domains.length}`,
    );
  }

  // E6 — tier-router decision evals (deterministic, no judge spend). Honest
  // no-op when unconfigured (missing Cosmos / label set).
  if (mode === 'all' || mode === 'tier') {
    const tier = await runTierEvals(trigger, log);
    log.log(
      `[copilot-evaluator/tier] pass complete — ran=${tier.ran}` +
        (tier.reason ? ` reason=${tier.reason}` : '') +
        ` tierAccuracy=${tier.tierAccuracy ?? 'n/a'}`,
    );
  }

  log.log(`[copilot-evaluator] execution complete in ${Date.now() - started}ms.`);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(
      `[copilot-evaluator] execution FAILED: ${e instanceof Error ? e.stack || e.message : String(e)}`,
    );
    process.exit(1);
  },
);

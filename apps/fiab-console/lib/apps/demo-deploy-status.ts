/**
 * Demo-deploy STATE VOCABULARY + rollup — the single place that decides what
 * "installed" is allowed to mean.
 *
 * WHY THIS MODULE EXISTS (#3905). `runDemoDeploy` used to set a sub-install to
 * `'done'` the moment POST /api/apps/{id}/install handed back a `jobId` — i.e.
 * before provisioning had started — and rolled that up to
 * `status:'done', percentComplete:100`. The banner rendered that as
 * "14/14 apps installed · done". Nothing ever re-read `installJobId`, so the
 * product reported a completion it had never measured. That is
 * `deploy-integrity.md` R2 (accepted is not done) rendered directly in the UI.
 *
 * The cure is a vocabulary that cannot express "accepted" and "succeeded" with
 * the same token, plus ONE rollup function used by BOTH the server orchestrator
 * (which persists it) and the client banner (which renders it), so the two can
 * never disagree.
 *
 * THE LOAD-BEARING RULE: `unknown` NEVER counts as success. A poll that gives up
 * and reports success is worse than the original bug because it looks measured.
 * `unknown` is a first-class outcome here and it is rendered as unknown.
 *
 * Pure module — no Cosmos, no fetch, no React. Safe to import from a client
 * component (the server orchestrator lives in ./demo-deploy.ts).
 */

/** Terminal statuses an app-install job doc can reach (AppInstallJob['status']). */
export type InstallJobStatus = 'running' | 'done' | 'partial' | 'failed';

/**
 * State of one demo sub-install. Ordered loosely by progression.
 *
 *  - `pending`    — not dispatched yet.
 *  - `accepted`   — the install API returned a jobId. Provisioning has been
 *                   ACCEPTED, not observed. NOT a success.
 *  - `installing` — its install job doc was read and is advancing.
 *  - `succeeded`  — its install job reached terminal `done`.
 *  - `partial`    — its install job reached terminal `partial` (installed with
 *                   gates / per-item failures). Real, terminal, NOT success.
 *  - `failed`     — dispatch failed, or the install job reached terminal `failed`.
 *  - `unknown`    — polling could not establish a terminal state (budget
 *                   exhausted, the job stopped advancing, or its doc could not
 *                   be read). Never rendered as success, never as failure —
 *                   this is an UNKNOWN and it says so.
 */
export type DemoSubStatus =
  | 'pending'
  | 'accepted'
  | 'installing'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'unknown';

/** One demo sub-install: an app installed into its own `Demo —` workspace. */
export interface DemoSubJob {
  appId: string;
  wsLabel: string;
  workspaceId?: string;
  /** The underlying app-install jobId (poll /api/apps/install-jobs/{id} for detail). */
  installJobId?: string;
  status: DemoSubStatus;
  /** The raw terminal status observed on the install job doc, when one was read. */
  installStatus?: InstallJobStatus;
  /** Why this entry failed — the dispatch error or the install job's own error. */
  error?: string;
  /** Why this entry is `unknown` / what was last observed. Always TRUE of what
   *  was actually established (deploy-integrity.md R7): never asserts a cause
   *  the poller did not measure. */
  detail?: string;
  /** Last percentComplete observed on the install job doc (progress evidence). */
  lastPercent?: number;
  /** ISO stamp of the last CHANGE observed on the install job doc. */
  lastProgressAt?: string;
}

/** Statuses that are settled — no further polling will change them. */
const RESOLVED: ReadonlySet<DemoSubStatus> = new Set<DemoSubStatus>([
  'succeeded', 'partial', 'failed', 'unknown',
]);

export function isResolved(s: DemoSubStatus): boolean {
  return RESOLVED.has(s);
}

/** Human label per state — used by the banner and by any CLI reader. */
export const DEMO_SUB_STATUS_LABEL: Readonly<Record<DemoSubStatus, string>> = {
  pending: 'Queued',
  accepted: 'Accepted — not started',
  installing: 'Installing',
  succeeded: 'Installed',
  partial: 'Installed with gates',
  failed: 'Failed',
  unknown: 'Unknown — not confirmed',
};

/**
 * Map a terminal install-job status onto a demo sub-status.
 * Returns `null` when the job is NOT terminal (`running`, or no status yet) —
 * a non-terminal job is never allowed to resolve an entry.
 */
export function mapTerminalInstallStatus(s: InstallJobStatus | string | undefined): DemoSubStatus | null {
  switch (s) {
    case 'done': return 'succeeded';
    case 'partial': return 'partial';
    case 'failed': return 'failed';
    default: return null; // 'running' | undefined | anything unrecognised
  }
}

/** Aggregate truth about a demo deploy. */
export interface DemoRollup {
  total: number;
  pending: number;
  accepted: number;
  installing: number;
  succeeded: number;
  partial: number;
  failed: number;
  unknown: number;
  /** Entries whose state is settled (succeeded | partial | failed | unknown). */
  resolved: number;
  /** True ONLY when every app's install job reached terminal `done`. */
  allSucceeded: boolean;
  /** 0-100 — share of apps whose state is SETTLED, not a guess at success. */
  percentComplete: number;
  /** Rollup status, constrained to the AppInstallJob union the job doc carries. */
  status: InstallJobStatus;
  /** The caption the banner renders. Never claims N/N unless N actually succeeded. */
  headline: string;
}

const EMPTY_HEADLINE = 'No installs were dispatched';

/**
 * Roll a set of sub-installs up to ONE honest verdict.
 *
 * `status:'done'` is reachable ONLY when every entry is `succeeded`. An
 * `unknown` anywhere forces `partial` (or keeps `running` while work is still
 * in flight) — it can never produce `done`. Zero apps is `failed`, not `done`:
 * a vacuous success is the exact failure class this module exists to prevent.
 */
export function summarizeDemoSubJobs(subJobs: ReadonlyArray<DemoSubJob> | undefined | null): DemoRollup {
  const list = subJobs ?? [];
  const total = list.length;
  const count = (s: DemoSubStatus) => list.filter((j) => j.status === s).length;

  const pending = count('pending');
  const accepted = count('accepted');
  const installing = count('installing');
  const succeeded = count('succeeded');
  const partial = count('partial');
  const failed = count('failed');
  const unknown = count('unknown');
  const resolved = list.filter((j) => isResolved(j.status)).length;
  const inFlight = total - resolved;

  const allSucceeded = total > 0 && succeeded === total;

  let status: InstallJobStatus;
  if (total === 0) status = 'failed';
  else if (inFlight > 0) status = 'running';
  else if (allSucceeded) status = 'done';
  else if (failed === total) status = 'failed';
  else status = 'partial';

  const percentComplete = total === 0 ? 0 : Math.round((resolved / total) * 100);

  return {
    total, pending, accepted, installing, succeeded, partial, failed, unknown,
    resolved, allSucceeded, percentComplete, status,
    headline: buildHeadline({ total, pending, accepted, installing, succeeded, partial, failed, unknown, allSucceeded }),
  };
}

function buildHeadline(c: {
  total: number; pending: number; accepted: number; installing: number;
  succeeded: number; partial: number; failed: number; unknown: number; allSucceeded: boolean;
}): string {
  if (c.total === 0) return EMPTY_HEADLINE;
  // The ONLY shape allowed to read "N/N apps installed".
  if (c.allSucceeded) return `${c.succeeded}/${c.total} apps installed`;
  const parts = [`${c.succeeded}/${c.total} installed`];
  if (c.installing) parts.push(`${c.installing} installing`);
  if (c.accepted) parts.push(`${c.accepted} accepted, not started`);
  if (c.pending) parts.push(`${c.pending} queued`);
  if (c.partial) parts.push(`${c.partial} installed with gates`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.unknown) parts.push(`${c.unknown} unconfirmed`);
  return parts.join(' · ');
}

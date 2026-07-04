'use client';

/**
 * Setup-Wizard deploy persistence (rel-T43).
 *
 * The Setup Wizard's deploy state lived entirely in React `useState`, so a
 * browser refresh mid-deploy lost the deployment handle — the operator returned
 * to a fresh "Deploy" button with no way to see the in-flight run, and could
 * accidentally dispatch a SECOND deploy.
 *
 * This module persists the minimal handle needed to RE-ATTACH to an in-flight
 * deploy across a refresh: the workflow file + dispatch time (GitHub Actions
 * path) or the orchestrator deploymentId, plus the topology for display. On
 * mount the wizard reads this back and, if a non-terminal deploy exists, resumes
 * showing progress against the SAME run instead of offering a fresh dispatch —
 * so a refresh never causes a duplicate deploy.
 *
 * Storage: `localStorage`, keyed to the console origin (so two different Loom
 * consoles in the same browser don't collide). We deliberately do NOT use the
 * Cosmos jobs-store pattern (lib/state/jobs-store.ts) here: that store holds an
 * in-flight `fetch` at module scope whose completion IS the poll — it cannot
 * survive a full page reload (the JS context is torn down). A GitHub Actions /
 * orchestrator deploy, by contrast, runs server-side and is re-attachable from
 * just its handle, so a durable client record (localStorage) is the correct and
 * simpler mechanism. Stale records (older than {@link MAX_AGE_MS}) are dropped on
 * read so an abandoned tab never resurrects an ancient deploy.
 */

/** The persisted deploy handle. Kept intentionally small. */
export interface PersistedDeploy {
  /** Schema version — bump to invalidate old records on read. */
  v: 1;
  /** Orchestrator deploymentId or the workflow file name (whichever dispatched). */
  deploymentId?: string;
  /** GitHub Actions path: the workflow file we poll run-status against. */
  workflowFile?: string;
  /** ISO dispatch time — used as the run-status `since` filter and for staleness. */
  dispatchedAt?: string;
  /** Which dispatch path produced this handle (drives re-attach rendering). */
  deploymentMode?: 'github-workflow-dispatch' | 'orchestrator';
  /** Human progress label captured at dispatch (e.g. "Queued on GitHub Actions (…)"). */
  deployStage?: string;
  /** Direct link to the run, when the dispatch returned one. */
  runUrl?: string;
  /** Topology snapshot for the resumed "done" view. */
  topology?: {
    boundary?: string;
    mode?: string;
    domainName?: string;
    capacitySku?: string;
    location?: string;
  };
}

/** Drop persisted deploys older than 12h — an in-flight deploy never runs longer. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function storageKey(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'server';
  return `loom.setup.deploy.${origin}`;
}

/** Persist the in-flight deploy handle. No-op on the server. */
export function saveDeploy(rec: Omit<PersistedDeploy, 'v'>): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedDeploy = { v: 1, ...rec };
    window.localStorage.setItem(storageKey(), JSON.stringify(payload));
  } catch {
    /* private-mode / quota — persistence is best-effort, never fatal */
  }
}

/**
 * Read the persisted deploy handle, or null when there is none / it is stale /
 * malformed. A stale or unparseable record is cleared as a side-effect so it is
 * never re-evaluated.
 */
export function loadDeploy(): PersistedDeploy | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey());
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as PersistedDeploy;
    if (!rec || rec.v !== 1 || (!rec.workflowFile && !rec.deploymentId)) {
      clearDeploy();
      return null;
    }
    if (rec.dispatchedAt) {
      const age = Date.now() - Date.parse(rec.dispatchedAt);
      if (Number.isFinite(age) && age > MAX_AGE_MS) {
        clearDeploy();
        return null;
      }
    }
    return rec;
  } catch {
    clearDeploy();
    return null;
  }
}

/** Remove the persisted deploy handle (call on terminal state / "Deploy another"). */
export function clearDeploy(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey());
  } catch {
    /* ignore */
  }
}

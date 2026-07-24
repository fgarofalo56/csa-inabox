/**
 * N4 — HTTP client for the loom-transform-runner Container App.
 *
 * Mirrors the auth shape of `lib/dbt/dbt-runner.ts` (the existing loom-dbt-runner
 * client): the runner has INTERNAL ingress on the Container Apps VNet, so calls
 * ride VNet trust by default; when an operator layers Easy Auth over it,
 * `LOOM_TRANSFORM_RUNNER_AUDIENCE` turns on a real Entra bearer minted from the
 * Console's managed identity. NO shared secrets, ever.
 *
 * Server-only (reads process.env + the credential factory) — never import from a client
 * component.
 */

import { workspaceScopedCredential } from '@/lib/azure/workspace-credential-factory';
import type { GeneratedFile } from './transform-codegen';
import type { TransformBackend } from './transform-project-model';

/**
 * Honest gate: the missing env var when the runner isn't deployed. The BFF
 * routes gate declaratively via `withBackendGate('svc-transform-runner')`; this
 * helper is the imperative equivalent for non-route callers (health probes,
 * background jobs) and keeps the var name in ONE place.
 */
export function transformRunnerConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_TRANSFORM_RUNNER_URL) return { missing: 'LOOM_TRANSFORM_RUNNER_URL' };
  return null;
}

// Credentials resolve through the shared workspace-credential factory (I1) —
// the ACA managed-identity chain lives in ONE audited place, and a workspace
// with its own identity gets it automatically.
const runnerCred = workspaceScopedCredential();

async function runnerAuthHeader(): Promise<Record<string, string>> {
  const aud = process.env.LOOM_TRANSFORM_RUNNER_AUDIENCE;
  if (!aud) return {};
  try {
    const t = await runnerCred.getToken(`${aud}/.default`);
    return t?.token ? { authorization: `Bearer ${t.token}` } : {};
  } catch {
    return {};
  }
}

/** The runner's response envelope (`ok` + engine payload). */
export interface RunnerResponse {
  ok: boolean;
  exitCode?: number;
  log?: string;
  error?: string;
  engine?: string;
  /** dbt: the verbatim `target/manifest.json` (L6 lineage input). */
  manifest?: unknown;
  /** dbt: the verbatim `target/catalog.json`. */
  catalog?: unknown;
  results?: Array<{ name: string; status: string; message?: string }>;
  plan?: Record<string, unknown>;
  environments?: unknown;
  diffs?: unknown;
  note?: string;
  applied?: boolean;
  [k: string]: unknown;
}

export interface RunnerCallOpts {
  files: GeneratedFile[];
  backend: TransformBackend;
  environment?: string;
  gateway?: string;
  commands?: string[];
  env?: Record<string, string>;
  previousManifest?: unknown;
  previousCatalog?: unknown;
}

async function post(path: string, body: unknown): Promise<RunnerResponse> {
  const base = process.env.LOOM_TRANSFORM_RUNNER_URL;
  if (!base) throw new Error('LOOM_TRANSFORM_RUNNER_URL not configured');
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await runnerAuthHeader()) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: RunnerResponse;
  try {
    parsed = text ? (JSON.parse(text) as RunnerResponse) : { ok: false };
  } catch {
    parsed = { ok: false, log: text };
  }
  if (!res.ok) {
    return {
      ...parsed,
      ok: false,
      error: parsed.error || parsed.log || `transform runner HTTP ${res.status}`,
      exitCode: parsed.exitCode ?? res.status,
    };
  }
  return parsed;
}

function payload(opts: RunnerCallOpts): Record<string, unknown> {
  return {
    files: opts.files,
    backend: opts.backend,
    environment: opts.environment || 'dev',
    gateway: opts.gateway || null,
    commands: opts.commands || [],
    env: opts.env || {},
    ...(opts.previousManifest ? { previousManifest: opts.previousManifest } : {}),
    ...(opts.previousCatalog ? { previousCatalog: opts.previousCatalog } : {}),
  };
}

/** Build the plan — writes NOTHING to the warehouse. */
export function runnerPlan(opts: RunnerCallOpts): Promise<RunnerResponse> {
  return post('/plan', payload(opts));
}

/** Apply the plan — SQLMesh view swap + backfill, or `dbt build`. */
export function runnerApply(opts: RunnerCallOpts): Promise<RunnerResponse> {
  return post('/apply', payload(opts));
}

/** Materialize on the environment's cadence (SQLMesh run / dbt command list). */
export function runnerRun(opts: RunnerCallOpts): Promise<RunnerResponse> {
  return post('/run', payload(opts));
}

/** List the real virtual environments in the SQLMesh state store. */
export function runnerEnvironments(opts: RunnerCallOpts): Promise<RunnerResponse> {
  return post('/environments', payload(opts));
}

/** Column-level (and row-count) diff of one model across two environments. */
export function runnerDiff(opts: RunnerCallOpts & {
  model: string;
  sourceEnvironment: string;
  targetEnvironment: string;
}): Promise<RunnerResponse> {
  return post('/diff', {
    files: opts.files,
    model: opts.model,
    sourceEnvironment: opts.sourceEnvironment,
    targetEnvironment: opts.targetEnvironment,
    gateway: opts.gateway || null,
    env: opts.env || {},
  });
}

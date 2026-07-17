/**
 * In-product update — build-pipeline dispatch (the "images aren't in your ACR
 * yet" path).
 *
 * WHY THIS EXISTS: this deployment channel builds its images into the tenant's
 * PRIVATE ACR tagged with git SHAs (+ a mutable rolling tag), NOT with release
 * semvers. The updater's pre-flight probes `<acr>/<app>:<X.Y.Z>` — which will
 * essentially never exist on that channel — so without this module the Update
 * button dead-ended on an "images not published" refusal every single time.
 *
 * The real mechanism the estate already has for "get release X running" is the
 * image build+roll GitHub workflow (full-app-deploy-commercial.yml: opens the
 * ACR to ACR Tasks, `az acr build`s every app at the requested tag, re-locks,
 * then rolls every Container App onto the new tag with a fresh revision
 * suffix). This module dispatches THAT workflow at the target release's git tag
 * so the built code is exactly the released code, and exposes a run poller so
 * the UI can show honest progress (queued → building → rolling → live).
 *
 * Token: LOOM_UPDATE_GITHUB_TOKEN (dedicated) → LOOM_GITHUB_ACTIONS_TOKEN (the
 * Setup Wizard's existing deploy-dispatch token) → LOOM_FEEDBACK_GITHUB_TOKEN
 * (feedback forwarding; may lack `actions:write` — a GitHub 403 is surfaced
 * verbatim, never faked). No token → honest gate naming the env var to set
 * (no-vaporware.md): the operator can add it at /admin/env-config.
 *
 * Pure orchestration over an injectable fetch so every path is unit-testable.
 */

export interface PipelineConfig {
  /** True when a GitHub token is available to dispatch the workflow. */
  available: boolean;
  /** The env var the token was read from (for the audit trail / UI). */
  tokenEnv?: string;
  token?: string;
  /** The env var(s) to set when no token is configured. */
  missingEnv: string[];
  /** Workflow file dispatched (LOOM_UPDATE_BUILD_WORKFLOW override). */
  workflow: string;
  owner: string;
  repo: string;
  /** Human link to the workflow's runs page. */
  monitorUrl: string;
}

/** Env accessor shape (injectable for tests). */
export type EnvReader = Record<string, string | undefined>;

export const PIPELINE_TOKEN_ENVS = [
  'LOOM_UPDATE_GITHUB_TOKEN',
  'LOOM_GITHUB_ACTIONS_TOKEN',
  'LOOM_FEEDBACK_GITHUB_TOKEN',
] as const;

export const DEFAULT_BUILD_WORKFLOW = 'full-app-deploy-commercial.yml';

export function readPipelineConfig(env: EnvReader = process.env): PipelineConfig {
  const owner = env.LOOM_GITHUB_REPO_OWNER || env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
  const repo = env.LOOM_GITHUB_REPO_NAME || env.LOOM_FEEDBACK_REPO_NAME || 'csa-inabox';
  const workflow = (env.LOOM_UPDATE_BUILD_WORKFLOW || DEFAULT_BUILD_WORKFLOW).trim();
  let token: string | undefined;
  let tokenEnv: string | undefined;
  for (const name of PIPELINE_TOKEN_ENVS) {
    const v = (env[name] || '').trim();
    if (v) { token = v; tokenEnv = name; break; }
  }
  return {
    available: !!token,
    token,
    tokenEnv,
    missingEnv: token ? [] : ['LOOM_UPDATE_GITHUB_TOKEN (or LOOM_GITHUB_ACTIONS_TOKEN)'],
    workflow,
    owner,
    repo,
    monitorUrl: `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`,
  };
}

/**
 * The Azure region of the target Admin Plane, threaded into the workflow's
 * `region` input so it resolves the RIGHT `rg-csa-loom-admin-<region>` (the
 * workflow's own default is a fixed region that is wrong for any other estate).
 * LOOM_LOCATION is bicep-wired; the RG-name suffix is the fallback.
 */
export function resolveDeployRegion(env: EnvReader = process.env): string | undefined {
  const loc = (env.LOOM_LOCATION || '').trim();
  if (loc) return loc;
  const rg = (env.LOOM_ACA_RG || env.LOOM_ADMIN_RG || '').trim();
  const m = rg.match(/^rg-csa-loom-admin-(.+)$/);
  return m ? m[1] : undefined;
}

export interface DispatchOptions {
  /** Bare image version the pipeline builds + rolls to (e.g. '0.68.0'). */
  imageVersion: string;
  /** The release's git tag (e.g. 'csa-inabox-v0.68.0') — the dispatch ref, so
   *  the built code is exactly the released code. Falls back to 'main' when
   *  GitHub rejects the tag ref (e.g. the workflow file predates the tag). */
  releaseTag: string;
  region?: string;
  subscriptionId?: string;
}

export interface DispatchResult {
  ok: boolean;
  /** HTTP status of the final dispatch attempt (204 on success). */
  status: number;
  /** The git ref the run was actually dispatched at. */
  ref: string;
  workflow: string;
  monitorUrl: string;
  error?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * POST a real GitHub `workflow_dispatch` for the build+roll pipeline at the
 * target release tag. All input values are strings (the GitHub REST API rejects
 * non-string input values). Returns the honest per-attempt result — a 401/403
 * (token lacks `actions:write`) or 404/422 (workflow/ref not found) is reported
 * verbatim, never masked as success.
 */
export async function dispatchBuildRoll(
  cfg: PipelineConfig,
  opts: DispatchOptions,
  fetchFn: FetchLike = fetch,
): Promise<DispatchResult> {
  if (!cfg.available || !cfg.token) {
    return {
      ok: false, status: 0, ref: '', workflow: cfg.workflow, monitorUrl: cfg.monitorUrl,
      error: `No GitHub token configured — set ${cfg.missingEnv.join(', ')}.`,
    };
  }
  const inputs: Record<string, string> = {
    tag: opts.imageVersion,
    skip_build: 'false',
    enable_apps_after: 'true',
  };
  if (opts.region) inputs.region = opts.region;
  if (opts.subscriptionId) inputs.subscription = opts.subscriptionId;

  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${cfg.workflow}/dispatches`;
  const attempt = async (ref: string): Promise<{ status: number; body: string }> => {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs }),
    });
    const body = r.ok ? '' : await r.text().catch(() => '');
    return { status: r.status, body };
  };

  // Prefer the release tag ref (build exactly the released code); fall back to
  // main only when GitHub cannot dispatch at the tag (422 = ref/workflow not
  // resolvable there). Auth/permission failures are terminal — retrying the
  // same token on another ref cannot succeed.
  let ref = opts.releaseTag;
  let res = await attempt(ref);
  if (res.status === 422 || res.status === 404) {
    ref = 'main';
    res = await attempt(ref);
  }
  if (res.status === 204) {
    return { ok: true, status: 204, ref, workflow: cfg.workflow, monitorUrl: cfg.monitorUrl };
  }
  const hint =
    res.status === 401 || res.status === 403
      ? ` — the ${cfg.tokenEnv} token lacks permission to dispatch workflows (needs repo scope with actions:write).`
      : '';
  return {
    ok: false,
    status: res.status,
    ref,
    workflow: cfg.workflow,
    monitorUrl: cfg.monitorUrl,
    error: `GitHub workflow dispatch failed (HTTP ${res.status})${hint} ${res.body.slice(0, 300)}`.trim(),
  };
}

export interface PipelineRunStatus {
  ok: boolean;
  /** 'pending' until the run row materializes, else GitHub's run status. */
  status: 'pending' | 'queued' | 'in_progress' | 'completed' | string;
  conclusion?: string | null;
  runId?: number;
  runUrl?: string;
  createdAt?: string;
  error?: string;
}

/**
 * Poll the newest run of the build workflow created at/after `since` (the
 * dispatch timestamp, with 60s clock-skew grace) so progress reflects THIS
 * update's run, not a stale prior one.
 */
export async function getPipelineRunStatus(
  cfg: PipelineConfig,
  sinceIso: string | undefined,
  fetchFn: FetchLike = fetch,
): Promise<PipelineRunStatus> {
  if (!cfg.available || !cfg.token) {
    return { ok: false, status: 'pending', error: `No GitHub token configured — set ${cfg.missingEnv.join(', ')}.` };
  }
  const url =
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${cfg.workflow}` +
    `/runs?event=workflow_dispatch&per_page=10`;
  const r = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) return { ok: false, status: 'pending', error: `GitHub API error (${r.status})` };
  const j: any = await r.json().catch(() => ({}));
  const runs: any[] = j.workflow_runs || [];
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const candidates = Number.isFinite(sinceMs)
    ? runs.filter((run) => Date.parse(run.created_at) >= sinceMs - 60_000)
    : runs;
  const run = candidates[0];
  if (!run) return { ok: true, status: 'pending' };
  return {
    ok: true,
    status: run.status,
    conclusion: run.conclusion,
    runId: run.id,
    runUrl: run.html_url,
    createdAt: run.created_at,
  };
}

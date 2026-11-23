// ARM managedClusters/runCommand client (LHDS W2-2b B2c): the ONLY way the control plane reaches the PRIVATE
// stamp AKS API server. `POST .../managedClusters/<aks>/runCommand` runs `command` through kubectl AS THE CALLER
// (the control-plane UAMI): its Kubernetes rights are the RoleBinding `loom-health-cp-edit` in namespace
// `loom-health` and nothing else (engines.bicep), so a command that needs more is refused by Kubernetes, not here.
//
// Learn caveat, accepted by the operator (#5422): runCommand is documented as not meant for programmatic use and has
// a 60 s scheduling timeout (the command pod must start within it) and a 512 kB output ceiling. So:
//   - every command this client is given must be IDEMPOTENT (apply, get, delete --ignore-not-found), because the
//     one retry below re-sends a command whose outcome ARM did not report;
//   - the retry fires ONLY when ARM ended the operation without an exit code (the command did not report back), never
//     when kubectl exited non-zero: a non-zero exit is an answer and is returned to the caller;
//   - errors say what was established. "kubectl did not run" is never claimed; only "ARM reported no exit code".
//
// The token callback, ARM endpoint per cloud, bounded non-ARM-403 retry and classifyArm are those of RestTenantArm
// (tenant-arm.ts), reused rather than reinvented.

import { ArmError, armDiagnostics, classifyArm, NON_ARM_403_ATTEMPTS, NON_ARM_403_BACKOFF_MS } from './tenant-arm.js';
import { JobFailure } from './types.js';

export interface RunCommandResult {
  /** kubectl / shell exit code as ARM reported it. */
  exitCode: number;
  /** Combined output, at most 512 kB (Learn). May contain anything the command printed: callers must excerpt, never forward whole. */
  logs: string;
}

export interface AksTarget {
  resourceGroup: string;
  cluster: string;
}

/** The port the production FhirEngineHost talks to; tests inject a fake. */
export interface AksRunCommand {
  run(target: AksTarget, command: string): Promise<RunCommandResult>;
}

/** api-version used for the same operation by apps/fiab-console/lib/azure/aks-arm-client.ts (verified live there). */
export const RUN_COMMAND_API = '2025-04-01';
/** Total sends of one command when ARM ends the operation without an exit code. */
export const RUN_COMMAND_ATTEMPTS = 3;
export const RUN_COMMAND_BACKOFF_MS = [10_000, 20_000] as const;
/** Consecutive transient (429/5xx) poll answers tolerated before giving up. */
const POLL_TRANSIENT_MAX = 3;

type Json = Record<string, unknown>;

export interface RestAksRunCommandOptions {
  armEndpoint: string;
  subscriptionId: string;
  token: (scope: string) => Promise<string>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between polls of commandResults. */
  pollMs?: number;
  /** Polls per send; pollMs * maxPolls bounds one send (default 3 s * 100 = 5 min). */
  maxPolls?: number;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

const CLUSTER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const RG = /^[A-Za-z0-9._()-]{1,90}$/;
const COMMAND_ID = /^[A-Za-z0-9-]{8,80}$/;

function stdoutLog(event: string, fields: Record<string, string | number>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}

/** An identifier-only token from ARM's free-text `reason`: closed character class, bounded. */
function token80(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[^A-Za-z0-9 ._:-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

export class RestAksRunCommand implements AksRunCommand {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly maxPolls: number;
  private readonly log: (event: string, fields: Record<string, string | number>) => void;

  constructor(private readonly o: RestAksRunCommandOptions) {
    this.f = o.fetchFn ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = o.pollMs ?? 3000;
    this.maxPolls = o.maxPolls ?? 100;
    this.log = o.log ?? stdoutLog;
  }

  private clusterPath(t: AksTarget): string {
    if (!RG.test(t.resourceGroup) || !CLUSTER.test(t.cluster)) {
      throw new JobFailure('bad_cluster_target', 'refusing a malformed resource group or cluster name for runCommand; nothing was sent');
    }
    return `/subscriptions/${this.o.subscriptionId}/resourceGroups/${t.resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${t.cluster}`;
  }

  /** One ARM request, with the bounded retry for the non-ARM 403 shape (#5380) and nothing else. */
  private async call(method: 'POST' | 'GET', url: string, op: string, body?: Json): Promise<{ status: number; json?: Json; headers?: Headers }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce(method, url, op, attempt, body);
      } catch (e) {
        if (!(e instanceof ArmError) || !e.nonArm) throw e;
        const last = attempt >= NON_ARM_403_ATTEMPTS;
        this.log('arm.non_arm_403', { op, method, attempt, of: NON_ARM_403_ATTEMPTS, outcome: last ? 'exhausted' : 'retrying', status: e.status, code: e.code });
        if (last) throw e;
        await this.sleep(NON_ARM_403_BACKOFF_MS[attempt - 1] ?? 4000);
      }
    }
  }

  private async callOnce(method: 'POST' | 'GET', url: string, op: string, attempt: number, body?: Json): Promise<{ status: number; json?: Json; headers?: Headers }> {
    const res = await this.f(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.o.token(`${this.o.armEndpoint}/.default`)}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let text: string | undefined;
    try {
      text = await res.text();
    } catch {
      text = undefined;
    }
    let json: Json | undefined;
    let parsed = true;
    try {
      const v = JSON.parse(text ?? '') as unknown;
      json = v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
    } catch {
      parsed = false;
    }
    if (res.status >= 400) {
      const { code, diag } = armDiagnostics(json, parsed, res.headers, text);
      const nonArm = res.status === 403 && code === 'Unknown' && !res.headers?.get('x-ms-request-id');
      throw new ArmError(res.status, code, op, diag, attempt, nonArm);
    }
    return { status: res.status, ...(json ? { json } : {}), headers: res.headers };
  }

  async run(target: AksTarget, command: string): Promise<RunCommandResult> {
    const base = this.clusterPath(target);
    let last = '';
    for (let attempt = 1; attempt <= RUN_COMMAND_ATTEMPTS; attempt++) {
      const outcome = await this.sendOnce(base, command);
      if (outcome.kind === 'result') return outcome.result;
      last = outcome.detail;
      this.log('aks.run_command_no_exit_code', { attempt, of: RUN_COMMAND_ATTEMPTS, cluster: target.cluster, detail: last });
      if (attempt < RUN_COMMAND_ATTEMPTS) await this.sleep(RUN_COMMAND_BACKOFF_MS[attempt - 1] ?? 20_000);
    }
    throw new JobFailure(
      'run_command_no_result',
      `runCommand on ${target.cluster} ended without an exit code on all ${RUN_COMMAND_ATTEMPTS} attempt(s) (${last}). Whether kubectl ran is NOT established; every command sent is idempotent, so retrying the job is safe. Microsoft documents a 60 s scheduling timeout for the command pod.`,
    );
  }

  private async sendOnce(base: string, command: string): Promise<{ kind: 'result'; result: RunCommandResult } | { kind: 'none'; detail: string }> {
    let post;
    try {
      post = await this.call('POST', `${this.o.armEndpoint}${base}/runCommand?api-version=${RUN_COMMAND_API}`, 'start runCommand', { command });
    } catch (e) {
      throw classifyArm(e);
    }
    // 200 = synchronous result; 202 = accepted, the body (or Location) names the command to poll.
    let props = post.json?.properties as Json | undefined;
    if (post.status === 200 && props && isTerminal(props)) return finish(props);
    const id = commandIdOf(post.json?.id) ?? commandIdOf(post.headers?.get('location')) ?? commandIdOf(post.headers?.get('azure-asyncoperation'));
    if (!id) {
      throw new JobFailure('run_command_unreadable', 'runCommand was accepted but ARM returned no command id to poll, so its outcome cannot be read. Whether kubectl ran is NOT established.');
    }
    let transient = 0;
    for (let n = 0; n < this.maxPolls; n++) {
      await this.sleep(this.pollMs);
      let r;
      try {
        r = await this.call('GET', `${this.o.armEndpoint}${base}/commandResults/${id}?api-version=${RUN_COMMAND_API}`, 'read runCommand result');
        transient = 0;
      } catch (e) {
        if (e instanceof ArmError && (e.status === 429 || e.status >= 500) && ++transient < POLL_TRANSIENT_MAX) continue;
        throw classifyArm(e);
      }
      props = r.json?.properties as Json | undefined;
      if (r.status === 200 && props && isTerminal(props)) return finish(props);
    }
    throw new JobFailure(
      'run_command_timeout',
      `runCommand ${id} was still not finished after ${this.maxPolls} poll(s) of ${this.pollMs} ms. Whether it completed is NOT established; every command sent is idempotent, so retrying the job is safe.`,
    );
  }
}

function commandIdOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const seg = v.split('?')[0]?.split('/').filter(Boolean).pop() ?? '';
  return COMMAND_ID.test(seg) ? seg : undefined;
}

function isTerminal(p: Json): boolean {
  return ['succeeded', 'failed', 'canceled'].includes(String(p.provisioningState ?? '').toLowerCase());
}

function finish(p: Json): { kind: 'result'; result: RunCommandResult } | { kind: 'none'; detail: string } {
  const code = p.exitCode;
  if (typeof code === 'number' && Number.isInteger(code)) {
    return { kind: 'result', result: { exitCode: code, logs: typeof p.logs === 'string' ? p.logs : '' } };
  }
  const state = token80(p.provisioningState) || 'unknown';
  const reason = token80(p.reason);
  return { kind: 'none', detail: `provisioningState ${state}${reason ? `, reason "${reason}"` : ''}` };
}

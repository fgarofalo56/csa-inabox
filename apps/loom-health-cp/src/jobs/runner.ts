// Lifecycle-job framework: audited, idempotent jobs with receipts.
//
//   queued -> running -> succeeded | failed        (failed -> queued via retry)
//   queued -> cancelled
//
// Idempotency: the job id is derived from (kind, subjectId, idempotencyKey), so
// a repeated submit returns the SAME record instead of running twice. Claiming
// a job is an etag-guarded replace, so two replicas cannot both run it.

import { createHash } from 'node:crypto';
import { badRequest, conflict, notFound, StoreConflictError } from '../http/errors.js';
import { authoredMessage, publicErrorMessage } from '../safe-error.js';
import type { Collection } from '../store/types.js';
import {
  JobFailure,
  type JobDoc,
  type JobHandler,
  type SubjectType,
} from './types.js';

export const LEASE_MS = 10 * 60 * 1000;
const MAX_RECEIPTS = 200;
const KEY = /^[A-Za-z0-9._:-]{1,80}$/;

export type SubjectExists = (type: SubjectType, id: string) => Promise<boolean>;

export interface SubmitRequest {
  kind: string;
  subjectType: SubjectType;
  subjectId: string;
  idempotencyKey: string;
  input?: Record<string, unknown>;
  requestedBy: string;
}

export function jobIdFor(kind: string, subjectId: string, idempotencyKey: string): string {
  return 'job-' + createHash('sha256').update(`${kind}\n${subjectId}\n${idempotencyKey}`).digest('hex').slice(0, 32);
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly jobs: Collection<JobDoc>,
    private readonly subjectExists: SubjectExists,
    private readonly log: (event: string, fields: Record<string, string | number>) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.kind)) throw new Error(`job kind already registered: ${handler.kind}`);
    this.handlers.set(handler.kind, handler);
  }

  kinds(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async submit(req: SubmitRequest): Promise<{ job: JobDoc; created: boolean }> {
    const handler = this.handlers.get(req.kind);
    if (!handler) throw badRequest('unknown job kind');
    if (handler.subjectType !== req.subjectType) {
      throw badRequest(`job kind ${req.kind} applies to subjectType ${handler.subjectType}`);
    }
    if (!KEY.test(req.idempotencyKey)) throw badRequest('idempotencyKey must be 1-80 chars of A-Za-z0-9._:-');
    let input = req.input ?? {};
    if (handler.inputSchema) {
      const p = handler.inputSchema.safeParse(input);
      if (!p.success) throw badRequest(`input: ${p.error.issues[0]?.message ?? 'invalid'}`);
      input = p.data;
    }
    if (!(await this.subjectExists(req.subjectType, req.subjectId))) throw notFound(req.subjectType);

    const id = jobIdFor(req.kind, req.subjectId, req.idempotencyKey);
    const existing = await this.jobs.get(id);
    if (existing) return { job: existing, created: false };
    const ts = this.now().toISOString();
    try {
      const job = await this.jobs.create({
        id,
        kind: req.kind,
        subjectType: req.subjectType,
        subjectId: req.subjectId,
        idempotencyKey: req.idempotencyKey,
        state: 'queued',
        attempts: 0,
        input,
        receipts: [],
        requestedBy: req.requestedBy,
        createdAt: ts,
        updatedAt: ts,
      });
      this.schedule(id);
      return { job, created: true };
    } catch (e) {
      if (e instanceof StoreConflictError) {
        // Lost a create race: the winner's record is the idempotent answer.
        const winner = await this.jobs.get(id);
        if (winner) return { job: winner, created: false };
      }
      throw e;
    }
  }

  async get(id: string): Promise<JobDoc> {
    const j = await this.jobs.get(id);
    if (!j) throw notFound('job');
    return j;
  }

  list(): Promise<JobDoc[]> {
    return this.jobs.list(500);
  }

  async retry(id: string): Promise<JobDoc> {
    const j = await this.get(id);
    if (j.state !== 'failed') throw conflict(`only a failed job can be retried (state is ${j.state})`);
    const { error: _previous, finishedAt: _finished, ...rest } = j;
    const next = await this.replaceOrConflict({ ...rest, state: 'queued', updatedAt: this.now().toISOString() });
    this.schedule(id);
    return next;
  }

  async cancel(id: string): Promise<JobDoc> {
    const j = await this.get(id);
    if (j.state !== 'queued') throw conflict(`only a queued job can be cancelled (state is ${j.state})`);
    const ts = this.now().toISOString();
    return this.replaceOrConflict({ ...j, state: 'cancelled', updatedAt: ts, finishedAt: ts });
  }

  /** Run every queued job and fail running jobs whose lease expired (crash recovery). Called on a timer. */
  async tick(): Promise<void> {
    const all = await this.jobs.list(500);
    const nowMs = this.now().getTime();
    for (const j of all) {
      if (j.state === 'running' && nowMs - Date.parse(j.updatedAt) > LEASE_MS) {
        const ts = this.now().toISOString();
        try {
          await this.jobs.replace({
            ...j,
            state: 'failed',
            error: { code: 'interrupted', message: 'job was interrupted before it finished; retry is safe' },
            updatedAt: ts,
            finishedAt: ts,
          });
          this.log('job.interrupted', { kind: j.kind, jobId: j.id });
        } catch (e) {
          if (!(e instanceof StoreConflictError)) throw e;
        }
      } else if (j.state === 'queued') {
        this.schedule(j.id);
      }
    }
  }

  /** Resolves when no run is in flight (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private schedule(id: string): void {
    const p: Promise<void> = this.execute(id)
      .catch((e: unknown) => this.log('job.runner_error', { jobId: id, error: e instanceof Error ? e.name : 'unknown' }))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private async replaceOrConflict(doc: JobDoc): Promise<JobDoc> {
    try {
      return await this.jobs.replace(doc);
    } catch (e) {
      if (e instanceof StoreConflictError) throw conflict('job was modified concurrently; retry');
      throw e;
    }
  }

  /**
   * Serialises claims per subject. Within this process the check and the claim of one subject run one at a time, so two jobs of the
   * same exclusive group cannot both pass the check. ACROSS replicas the check-then-claim is not atomic (the store has no per-subject
   * claim), so a second replica could still start a job in the same window; that residual race is disclosed, not closed.
   */
  private readonly claimLocks = new Map<string, Promise<unknown>>();

  private async withClaimLock<T>(subject: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.claimLocks.get(subject) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.claimLocks.set(subject, tail);
    try {
      return await run;
    } finally {
      if (this.claimLocks.get(subject) === tail) this.claimLocks.delete(subject);
    }
  }

  /** True when another job of the same exclusive group is running for the subject with a live lease. */
  private async blockedByRunning(job: JobDoc, group: string): Promise<boolean> {
    const nowMs = this.now().getTime();
    for (const j of await this.jobs.list(500)) {
      if (j.id === job.id || j.state !== 'running' || j.subjectId !== job.subjectId) continue;
      if (this.handlers.get(j.kind)?.exclusiveGroup !== group) continue;
      if (nowMs - Date.parse(j.updatedAt) > LEASE_MS) continue; // a dead lease does not block (tick() fails it)
      return true;
    }
    return false;
  }

  /** After a job ends, give the same subject's waiting jobs their turn without waiting for the next sweep. */
  private async wake(subjectId: string, group: string): Promise<void> {
    for (const j of await this.jobs.list(500)) {
      if (j.state === 'queued' && j.subjectId === subjectId && this.handlers.get(j.kind)?.exclusiveGroup === group) this.schedule(j.id);
    }
  }

  private async claim(queued: JobDoc, handler: JobHandler | undefined): Promise<JobDoc | undefined> {
    const t0 = this.now().toISOString();
    const group = handler?.exclusiveGroup;
    const doClaim = async (): Promise<JobDoc | undefined> => {
      if (group && (await this.blockedByRunning(queued, group))) return undefined; // stays queued; wake() or tick() retries it
      try {
        return await this.jobs.replace({ ...queued, state: 'running', attempts: queued.attempts + 1, startedAt: t0, updatedAt: t0 });
      } catch (e) {
        if (e instanceof StoreConflictError) return undefined; // another replica claimed it
        throw e;
      }
    };
    return group ? this.withClaimLock(queued.subjectId, doClaim) : doClaim();
  }

  private async execute(id: string): Promise<void> {
    const queued = await this.jobs.get(id);
    if (!queued || queued.state !== 'queued') return;
    const handler = this.handlers.get(queued.kind);
    const current = await this.claim(queued, handler);
    if (!current) return;
    const group = handler?.exclusiveGroup;
    try {
      await this.runClaimed(id, current, handler);
    } finally {
      if (group) await this.wake(queued.subjectId, group).catch(() => undefined);
    }
  }

  private async runClaimed(id: string, claimed: JobDoc, handler: JobHandler | undefined): Promise<void> {
    let current: JobDoc = claimed;

    const finish = async (patch: Partial<JobDoc>): Promise<void> => {
      const ts = this.now().toISOString();
      current = await this.jobs.replace({ ...current, ...patch, updatedAt: ts, finishedAt: ts });
    };

    if (!handler) {
      await finish({ state: 'failed', error: { code: 'no_handler', message: 'no handler registered for this job kind' } });
      return;
    }
    try {
      await handler.run({
        job: current,
        input: current.input,
        receipt: async (step, detail) => {
          current = await this.jobs.replace({
            ...current,
            receipts: [
              ...current.receipts.slice(-(MAX_RECEIPTS - 1)),
              { at: this.now().toISOString(), step: step.slice(0, 80), detail: detail.slice(0, 300) },
            ],
            updatedAt: this.now().toISOString(),
          });
        },
      });
      await finish({ state: 'succeeded' });
      this.log('job.succeeded', { kind: current.kind, jobId: id });
    } catch (e) {
      // Only a JobFailure carries operator-safe text; anything else is internal.
      const error =
        e instanceof JobFailure
          ? { code: e.code, message: authoredMessage(e) }
          : { code: 'internal', message: publicErrorMessage(e, 'job failed; see service logs') };
      await finish({ state: 'failed', error });
      this.log('job.failed', { kind: current.kind, jobId: id, code: error.code });
    }
  }
}

import type { ZodType } from 'zod';
import type { Doc } from '../store/types.js';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const SUBJECT_TYPES = ['stamp', 'tenant', 'routing'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export interface JobReceipt {
  at: string;
  step: string;
  /** Resource ids / counts only. Never clinical data, never secrets. */
  detail: string;
}

export interface JobDoc extends Doc {
  kind: string;
  subjectType: SubjectType;
  subjectId: string;
  idempotencyKey: string;
  state: JobState;
  attempts: number;
  input: Record<string, unknown>;
  receipts: JobReceipt[];
  error?: { code: string; message: string };
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A handler failure whose code and message are safe to show the operator. */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface JobContext {
  job: Readonly<JobDoc>;
  input: Record<string, unknown>;
  /** Append a receipt (persisted immediately, so a crashed job shows how far it got). */
  receipt(step: string, detail: string): Promise<void>;
}

/** What W1-2's tenant.create / tenant.destroy etc. plug into. */
export interface JobHandler {
  kind: string;
  subjectType: SubjectType;
  inputSchema?: ZodType<Record<string, unknown>>;
  run(ctx: JobContext): Promise<void>;
}

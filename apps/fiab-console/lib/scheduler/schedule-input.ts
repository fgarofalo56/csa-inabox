/**
 * schedule-input — PURE validation + normalization for scheduler write routes
 * (rel-T81). No I/O, no Azure SDK — unit-testable, imported by the BFF POST/PATCH
 * handlers so they stay thin and every field is validated before Cosmos is
 * touched (fast, precise client errors instead of a backend 500).
 */

import { JOB_KINDS, type JobKind, type ScheduleItemRef, type ScheduleJobConfig, type ScheduleNotify } from '@/lib/azure/scheduler-store';
import { parseCron, SCHEDULER_TIMEZONES } from '@/lib/scheduler/cron';

export interface ScheduleInput {
  displayName: string;
  itemRef: ScheduleItemRef;
  jobKind: JobKind;
  jobConfig: ScheduleJobConfig;
  cron: string;
  timezone: string;
  enabled: boolean;
  notify: ScheduleNotify;
}

const JOB_KIND_SET = new Set(JOB_KINDS.map((j) => j.kind));
const TZ_SET = new Set(SCHEDULER_TIMEZONES.map((t) => t.id));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate a create/update body. Returns `{ value }` when valid, else
 * `{ errors }` — a list of precise, client-safe messages.
 */
export function validateScheduleInput(body: any): { value: ScheduleInput } | { errors: string[] } {
  const errors: string[] = [];

  const displayName = str(body?.displayName);
  if (!displayName) errors.push('displayName is required');
  if (displayName.length > 120) errors.push('displayName must be 120 characters or fewer');

  const jobKind = str(body?.jobKind) as JobKind;
  if (!JOB_KIND_SET.has(jobKind)) {
    errors.push(`jobKind must be one of: ${[...JOB_KIND_SET].join(', ')}`);
  }

  const itemType = str(body?.itemRef?.type);
  const itemId = str(body?.itemRef?.id);
  if (!itemType) errors.push('itemRef.type is required');
  if (!itemId) errors.push('itemRef.id is required');
  const itemRef: ScheduleItemRef = {
    type: itemType,
    id: itemId,
    ...(str(body?.itemRef?.workspaceId) ? { workspaceId: str(body?.itemRef?.workspaceId) } : {}),
  };

  const cron = str(body?.cron);
  if (!cron) errors.push('cron is required');
  else if (!parseCron(cron)) errors.push('cron must be a valid 5-field expression');

  const timezone = str(body?.timezone) || 'UTC';
  if (!TZ_SET.has(timezone)) errors.push(`timezone must be one of: ${[...TZ_SET].join(', ')}`);

  // Per-kind job config validation — each field maps to a real backend arg.
  const jc = body?.jobConfig || {};
  const jobConfig: ScheduleJobConfig = {};
  if (jobKind === 'adf-pipeline') {
    jobConfig.pipelineName = str(jc.pipelineName);
    if (!jobConfig.pipelineName) errors.push('jobConfig.pipelineName is required for an ADF pipeline job');
    if (jc.pipelineParameters && typeof jc.pipelineParameters === 'object' && !Array.isArray(jc.pipelineParameters)) {
      jobConfig.pipelineParameters = jc.pipelineParameters as Record<string, unknown>;
    }
  } else if (jobKind === 'adx-command') {
    jobConfig.database = str(jc.database);
    jobConfig.command = str(jc.command);
    if (!jobConfig.database) errors.push('jobConfig.database is required for an ADX command job');
    if (!jobConfig.command) errors.push('jobConfig.command is required for an ADX command job');
  } else if (jobKind === 'aml-spark' || jobKind === 'synapse-livy') {
    jobConfig.code = str(jc.code);
    if (!jobConfig.code) errors.push('jobConfig.code is required for a Spark job');
    if (str(jc.sparkPoolName)) jobConfig.sparkPoolName = str(jc.sparkPoolName);
  }

  // Notification config.
  const n = body?.notify || {};
  const notify: ScheduleNotify = { onFailure: !!n.onFailure };
  if (notify.onFailure) {
    const email = str(n.email);
    const webhook = str(n.webhook);
    if (email) {
      if (!EMAIL_RE.test(email)) errors.push('notify.email must be a valid email address');
      else notify.email = email;
    }
    if (webhook) {
      if (!/^https?:\/\//i.test(webhook)) errors.push('notify.webhook must be an http(s) URL');
      else notify.webhook = webhook;
    }
  }

  if (errors.length) return { errors };
  return {
    value: {
      displayName,
      itemRef,
      jobKind,
      jobConfig,
      cron,
      timezone,
      enabled: body?.enabled === undefined ? true : !!body.enabled,
      notify,
    },
  };
}

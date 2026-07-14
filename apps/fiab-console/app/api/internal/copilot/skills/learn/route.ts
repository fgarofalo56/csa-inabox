/**
 * POST /api/internal/copilot/skills/learn  (also GET for probe)
 *
 * CTS-11 — the scheduled skill self-evolution learner trigger.
 *
 * An EXTERNAL timer (the csa-loom-skill-learner GitHub Actions `schedule:`, or an
 * ACA cron Job) pings this endpoint. Each hit runs {@link runSkillLearner} for
 * every tenant that has recent Copilot usage (or, when the body carries
 * `{ tenantId }`, only that tenant). The learner drafts SUGGESTED skills from
 * recurring usage patterns — nothing is published or injected; a tenant admin
 * reviews the queue at /api/copilot/skills/suggested.
 *
 * Auth: the shared internal trust token (`LOOM_INTERNAL_TOKEN`), accepted as
 * `Authorization: Bearer <token>` or `x-loom-internal-token` — machine-to-machine,
 * NOT a user session (the SAME pattern as /api/internal/spark/keep-warm). When the
 * token env is unset the gate FAILS CLOSED. When the feature is disabled
 * (LOOM_SKILL_LEARNER_ENABLED=false) it is an HONEST no-op.
 *
 * No mocks: runSkillLearner performs REAL Cosmos reads/writes + a real AOAI draft.
 */

import { NextRequest } from 'next/server';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { listUsageTenantIds } from '@/lib/azure/skill-usage';
import { runSkillLearner, skillLearnerEnabled, type SkillLearnerReport } from '@/lib/azure/skill-learner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

/** The lookback window (30 days) used to enumerate active tenants. */
const WINDOW_DAYS = 30;

function maxTenants(): number {
  const v = Number(process.env.LOOM_SKILL_LEARNER_MAX_TENANTS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 100;
}

async function run(req: NextRequest) {
  if (!skillLearnerEnabled()) {
    return apiOk({ skipped: true, reason: 'skill learner disabled (LOOM_SKILL_LEARNER_ENABLED=false)' });
  }
  // Optional { tenantId } narrows the run to one tenant; otherwise enumerate
  // every tenant with recent usage (bounded).
  let bodyTenant = '';
  try {
    const body = await req.json();
    bodyTenant = String(body?.tenantId ?? '').trim();
  } catch {
    /* no body / not JSON — enumerate all */
  }

  let tenants: string[];
  if (bodyTenant) {
    tenants = [bodyTenant];
  } else {
    const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    try {
      tenants = await listUsageTenantIds(sinceIso, maxTenants());
    } catch (e) {
      return apiServerError(e, 'failed to enumerate tenants with usage', 'learn_enum_failed');
    }
  }

  if (tenants.length === 0) {
    return apiOk({ ran: true, tenants: 0, reports: [], reason: 'no tenants with recent usage' });
  }

  // Per-tenant fail-open: one throwing tenant does not abort the others.
  const reports: SkillLearnerReport[] = [];
  for (const t of tenants) {
    try {
      reports.push(await runSkillLearner(t));
    } catch (e: any) {
      reports.push({ tenantId: t, ran: false, reason: `error: ${e?.message || e}`, scanned: 0, gaps: 0, proposed: 0, proposedNames: [] });
    }
  }
  const proposed = reports.reduce((n, r) => n + (r.proposed || 0), 0);
  return apiOk({ ran: true, tenants: tenants.length, proposed, reports });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('unauthorized — internal token required', 401);
  try {
    return await run(req);
  } catch (e) {
    return apiServerError(e);
  }
}

// GET is convenient for a curl heartbeat / uptime probe with the same auth.
export async function GET(req: NextRequest) {
  if (!authed(req)) return apiError('unauthorized — internal token required', 401);
  try {
    return await run(req);
  } catch (e) {
    return apiServerError(e);
  }
}

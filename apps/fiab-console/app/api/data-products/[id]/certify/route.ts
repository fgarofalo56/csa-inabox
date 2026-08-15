/**
 * POST /api/data-products/[id]/certify   (DP-5)
 *
 * Reviewer sign-off / revoke / promote for a data product's certification. The
 * jump to **certified** is GATED — server-side — on:
 *   1. EVERY automated check passing (re-evaluated live here, never trusting a
 *      stale client score), else 422 with the failing rows; AND
 *   2. the reviewer being DISTINCT from the creator (Power BI reviewer-pool
 *      parity), else 403.
 * A successful sign-off records the certifier identity + timestamp + an audit
 * entry, then re-projects the marketplace search doc so the trust badge shows at
 * the point of discovery.
 *
 * This route is also the MEASUREMENT path for the DQ input. Executing the
 * tenant's data-quality rules is one live ADX query per rule, so it happens here
 * — owner-gated, on an explicit POST — and the result is persisted to
 * `state.dqMeasurement` for the read surfaces to render (#3493). The GET routes
 * never execute a rule.
 *
 * Body: { action: 'certify' | 'revoke' | 'promote' | 'unpromote' | 'measure-dq' }
 *   certify    → state 'certified' (gated as above)
 *   revoke     → drop the sign-off back to 'validated'/'draft'
 *   promote    → set the lightweight `endorsed` (Promoted) signal (any owner)
 *   unpromote  → clear it
 *   measure-dq → run the DQ rules against the product's tables and persist the
 *                measurement (no sign-off, no state change beyond the record) —
 *                the inline "Measure data quality" action behind the honest gate
 *                a never-measured product shows (ux-baseline.md G2).
 *
 * Owner-tenant gated (loadOwnedItem 404s non-owners). Azure-native Cosmos; no
 * Fabric/Power BI dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';
import { upsertDataProductDoc, docForDataProduct } from '@/lib/azure/loom-data-products-search';
import {
  evaluateCertification, deriveCertificationState,
  type CertificationRecord,
} from '@/lib/dataproducts/certification';
import {
  measureCertificationDq, toDqMeasurement, DQ_MEASUREMENT_KEY,
} from '@/lib/dataproducts/certification-dq';
import { gatherCertInputs } from '../certification/route';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const ACTIONS = ['certify', 'revoke', 'promote', 'unpromote', 'measure-dq'] as const;
type Action = (typeof ACTIONS)[number];

/** Best-effort certification audit entry (partition = itemId, matching the
 *  data-product audit convention). Never blocks the write. */
async function writeAudit(itemId: string, action: string, actorOid: string, actorUpn?: string, detail?: string) {
  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: crypto.randomUUID(),
      itemId,
      action,
      actorOid,
      actorUpn,
      detail,
      at: new Date().toISOString(),
    });
  } catch { /* audit is best-effort */ }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '') as Action;
  if (!ACTIONS.includes(action)) return jerr(`action must be one of ${ACTIONS.join(', ')}`, 400);

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('data-product item not found', 404);
    const state = (item.state || {}) as Record<string, unknown>;
    const existing = (state.certification && typeof state.certification === 'object'
      ? state.certification as CertificationRecord
      : undefined);
    const now = new Date().toISOString();

    // ── Promote / unpromote — the lightweight endorsement rung ──────────────
    if (action === 'promote' || action === 'unpromote') {
      const endorsed = action === 'promote';
      const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
        state: { ...state, endorsed },
      });
      if (!updated) return jerr('Cosmos write failed', 500);
      void writeAudit(id, `data-product-${action}d`, session.claims.oid, session.claims.upn);
      try { await upsertDataProductDoc(docForDataProduct(updated, session.claims.oid)); } catch { /* derived */ }
      return NextResponse.json({ ok: true, endorsed });
    }

    // ── Measure DQ — execute the rules and RECORD the result ────────────────
    // The one path that turns "no score yet" into a number. Owner-gated, and
    // explicit: the read surfaces render this record instead of paying for N
    // ADX queries per view (#3493). A gated outcome is persisted too, with its
    // reason, so the UI can tell "ADX unprovisioned" from "never measured".
    if (action === 'measure-dq') {
      const dq = await measureCertificationDq(session.claims.oid, item);
      const measurement = toDqMeasurement(dq, session.claims.oid);
      const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
        state: { ...state, [DQ_MEASUREMENT_KEY]: measurement },
      });
      if (!updated) return jerr('Cosmos write to record the DQ measurement failed', 500);
      void writeAudit(id, 'data-product-dq-measured', session.claims.oid, session.claims.upn,
        `score=${dq.dqScore ?? 'null'} rules=${dq.dqResult?.passingRules ?? 0}/${dq.dqResult?.ruleCount ?? 0}`);
      return NextResponse.json({
        ok: true,
        dq: {
          score: dq.dqScore,
          gate: dq.dqGate,
          gateId: dq.dqGateId,
          missing: dq.dqMissing,
          ruleCount: dq.dqResult?.ruleCount ?? 0,
          passingRules: dq.dqResult?.passingRules ?? 0,
          breakdown: dq.dqResult?.breakdown ?? [],
          measuredAt: measurement.measuredAt,
          stale: false,
        },
      });
    }

    // ── Revoke — drop a prior sign-off back to the automated rung ───────────
    if (action === 'revoke') {
      const dq = await measureCertificationDq(session.claims.oid, item);
      const evaluation = evaluateCertification(gatherCertInputs(item, dq.dqScore));
      const record: CertificationRecord = {
        state: evaluation.validated ? 'validated' : 'draft',
        score: evaluation.score,
        checkedAt: now,
      };
      const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
        state: {
          ...state,
          certification: record,
          certificationState: record.state,
          [DQ_MEASUREMENT_KEY]: toDqMeasurement(dq, session.claims.oid),
        },
      });
      if (!updated) return jerr('Cosmos write failed', 500);
      void writeAudit(id, 'data-product-cert-revoked', session.claims.oid, session.claims.upn);
      try { await upsertDataProductDoc(docForDataProduct(updated, session.claims.oid)); } catch { /* derived */ }
      return NextResponse.json({ ok: true, certification: record });
    }

    // ── Certify — gated sign-off ────────────────────────────────────────────
    // Gate 1: reviewer must differ from the creator.
    if (item.createdBy === session.claims.oid) {
      return NextResponse.json(
        { ok: false, error: 'A data product must be certified by a reviewer other than its creator.', code: 'reviewer_is_creator' },
        { status: 403 },
      );
    }
    // Gate 2: EVERY automated check must pass — re-evaluated live, never trusting
    // the client OR the persisted measurement. The DQ input is MEASURED here
    // (rules executed against ADX, scored on the rules that PASSED), so a product
    // whose rules are all failing cannot clear this gate; an unmeasurable score
    // gates rather than passes (#3493). A failing check returns 422 with the
    // precise blockers — and NO write: a refused sign-off records nothing, so the
    // fresh reading is returned inline for the panel instead of being persisted.
    const dq = await measureCertificationDq(session.claims.oid, item);
    const { dqScore, dqGate, dqGateId, dqMissing } = dq;
    const evaluation = evaluateCertification(gatherCertInputs(item, dqScore));
    if (!evaluation.certifiable) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Cannot certify: automated checks are not all passing.',
          code: 'checks_failed',
          blockers: evaluation.checks.filter((c) => !c.pass).map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
          checks: evaluation.checks,
          ...(dqGate ? { dqGate, dqGateId, dqMissing } : {}),
        },
        { status: 422 },
      );
    }

    const record: CertificationRecord = {
      state: 'certified',
      score: evaluation.score,
      certifiedBy: { oid: session.claims.oid, name: session.claims.upn || session.claims.email || session.claims.oid },
      certifiedAt: now,
      checkedAt: now,
    };
    // Defensive: derive from the same engine so state can only be 'certified'
    // when the sign-off + checks agree.
    record.state = deriveCertificationState(evaluation, record);
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: {
        ...state,
        certification: record,
        certificationState: record.state,
        // The measurement the sign-off was granted on, recorded with it.
        [DQ_MEASUREMENT_KEY]: toDqMeasurement(dq, session.claims.oid),
      },
    });
    if (!updated) return jerr('Cosmos write to record certification failed', 500);
    void writeAudit(id, 'data-product-certified', session.claims.oid, session.claims.upn,
      `score=${evaluation.score}`);
    try { await upsertDataProductDoc(docForDataProduct(updated, session.claims.oid)); } catch { /* derived */ }

    return NextResponse.json({ ok: true, certification: record, checks: evaluation.checks });
  } catch (e: any) {
    return apiServerError(e);
  }
}

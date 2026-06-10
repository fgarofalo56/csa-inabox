/**
 * Report subscriptions — scheduled export + email delivery for a Power BI
 * report (Azure-native parity with Fabric / Power BI "Subscribe to report").
 *
 *   GET  /api/items/report/[id]/subscriptions
 *          → { ok, subscriptions: ReportSubscription[], deliveryGate }
 *          Lists the caller's own subscriptions for this report (subscriptions
 *          are per-user, exactly like Power BI). `deliveryGate` is non-null and
 *          describes the missing infra when the timer Function / delivery Logic
 *          App is not deployed — the editor renders it as an honest MessageBar.
 *
 *   POST /api/items/report/[id]/subscriptions
 *          body { workspaceId, format, cron|presetId, recipients[], subject?, itemId? }
 *          Creates a subscription row in Cosmos. Delivery is performed
 *          asynchronously by the fiab-report-subscriptions timer Function — the
 *          row is stored regardless of whether that Function is deployed yet, so
 *          the operator can configure subscriptions before wiring delivery.
 *
 * [id] is the Power BI report id (groupId-scoped, same as the export/refresh
 * routes). The export itself is performed by the timer Function via the real
 * Power BI ExportTo REST job — no Microsoft Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { reportSubscriptionsContainer, type ReportSubscription } from '@/lib/azure/cosmos-client';
import { validateNcrontab, cronForPreset } from '@/lib/util/ncrontab';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS = new Set(['PDF', 'PPTX', 'PNG']);
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function unauth() {
  return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
}

/**
 * Honest delivery gate (no-vaporware.md). Subscriptions are stored in Cosmos
 * regardless, but actual scheduled delivery needs:
 *   - the fiab-report-subscriptions timer Function deployed
 *     (LOOM_REPORT_SUBSCRIPTIONS_FUNCTION set by bicep), and
 *   - the report-subscription delivery Logic App
 *     (LOOM_SUBSCRIPTION_LOGIC_APP_NAME).
 * Returns null when delivery is fully wired, else a structured gate the editor
 * surfaces as a warning MessageBar with the exact env vars + bicep modules.
 */
function deliveryGate(): {
  ready: false;
  missing: string[];
  remediation: string;
} | null {
  const missing: string[] = [];
  if (!process.env.LOOM_REPORT_SUBSCRIPTIONS_FUNCTION) missing.push('LOOM_REPORT_SUBSCRIPTIONS_FUNCTION');
  if (!process.env.LOOM_SUBSCRIPTION_LOGIC_APP_NAME) missing.push('LOOM_SUBSCRIPTION_LOGIC_APP_NAME');
  if (missing.length === 0) return null;
  return {
    ready: false,
    missing,
    remediation:
      'Scheduled delivery requires the report-subscriptions timer Function and ' +
      'the delivery Logic App. Deploy admin-plane/main.bicep with ' +
      'reportSubscriptionsEnabled=true (modules report-subscriptions-function.bicep ' +
      '+ integration/report-subscription-logicapp.bicep), then authorize the ' +
      "Logic App's Office 365 connection in the portal. Subscriptions you save " +
      'now are stored and will start delivering once the Function is live. No ' +
      'Microsoft Fabric required.',
  };
}

// ---------------------------------------------------------------------------
// GET — the caller's subscriptions for this report.
// ---------------------------------------------------------------------------
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id: reportId } = await ctx.params;

  try {
    const c = await reportSubscriptionsContainer();
    const { resources } = await c.items
      .query<ReportSubscription>({
        query:
          'SELECT * FROM c WHERE c.reportId = @r AND c.createdBy = @o ORDER BY c.createdAt DESC',
        parameters: [
          { name: '@r', value: reportId },
          { name: '@o', value: s.claims.oid },
        ],
      })
      .fetchAll();
    return NextResponse.json({ ok: true, subscriptions: resources, deliveryGate: deliveryGate() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// POST — create a subscription.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id: reportId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const format = (body?.format || 'PDF').toString().toUpperCase();
  if (!FORMATS.has(format)) {
    return NextResponse.json({ ok: false, error: 'format must be PDF, PPTX, or PNG' }, { status: 400 });
  }

  // Schedule: accept either a preset id (preferred — driven by a dropdown) or a
  // raw 6-field NCRONTAB. Both end up validated as NCRONTAB.
  const presetId = (body?.presetId || '').toString().trim();
  const cron = (presetId ? cronForPreset(presetId) : (body?.cron || '').toString().trim()) || '';
  if (presetId && !cron) {
    return NextResponse.json({ ok: false, error: `unknown schedule preset "${presetId}"` }, { status: 400 });
  }
  const cronErr = validateNcrontab(cron);
  if (cronErr) return NextResponse.json({ ok: false, error: cronErr }, { status: 400 });

  const recipientsRaw = Array.isArray(body?.recipients) ? body.recipients : [];
  const recipients = recipientsRaw
    .map((r: unknown) => (r || '').toString().trim())
    .filter((r: string) => r.length > 0);
  if (recipients.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one recipient email is required' }, { status: 400 });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return NextResponse.json({ ok: false, error: `too many recipients (max ${MAX_RECIPIENTS})` }, { status: 400 });
  }
  const badEmail = recipients.find((r: string) => !EMAIL_RE.test(r));
  if (badEmail) return NextResponse.json({ ok: false, error: `invalid recipient email "${badEmail}"` }, { status: 400 });

  const subject = (body?.subject || '').toString().trim() || undefined;
  const itemId = (body?.itemId || '').toString().trim() || undefined;
  const now = new Date().toISOString();

  const sub: ReportSubscription = {
    id: `sub:${crypto.randomUUID()}`,
    reportId,
    workspaceId,
    itemId,
    format: format as 'PDF' | 'PPTX' | 'PNG',
    cron,
    recipients,
    subject,
    enabled: true,
    createdBy: s.claims.oid,
    createdByName: s.claims.name || s.claims.upn || s.claims.email,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const c = await reportSubscriptionsContainer();
    const { resource } = await c.items.create(sub);
    return NextResponse.json({ ok: true, subscription: resource, deliveryGate: deliveryGate() }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

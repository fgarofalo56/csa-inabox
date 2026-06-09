/**
 * Single report subscription — pause/resume/update + cancel.
 *
 *   PATCH  /api/items/report/[id]/subscriptions/[subId]
 *            body { enabled?, format?, cron?|presetId?, recipients?, subject? }
 *            Partial update. Only the subscription's creator may modify it.
 *            Pausing (enabled=false) stops delivery without deleting history.
 *
 *   DELETE /api/items/report/[id]/subscriptions/[subId]
 *            Cancels (deletes) the subscription. Only the creator may delete.
 *
 * [id] is the Power BI report id (the partition key). [subId] is the
 * subscription id. No Microsoft Fabric dependency — the row drives the
 * Azure-native fiab-report-subscriptions timer Function.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { reportSubscriptionsContainer, type ReportSubscription } from '@/lib/azure/cosmos-client';
import { validateNcrontab, cronForPreset } from '@/lib/util/ncrontab';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS = new Set(['PDF', 'PPTX', 'PNG']);
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function unauth() {
  return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
}

/** Read the subscription by (subId, reportId-partition); 404 when absent. */
async function readSub(reportId: string, subId: string): Promise<ReportSubscription | null> {
  const c = await reportSubscriptionsContainer();
  try {
    const { resource } = await c.item(subId, reportId).read<ReportSubscription>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; subId: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id: reportId, subId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  let sub: ReportSubscription | null;
  try {
    sub = await readSub(reportId, subId);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  if (!sub) return NextResponse.json({ ok: false, error: 'subscription not found' }, { status: 404 });
  if (sub.createdBy !== s.claims.oid) {
    return NextResponse.json({ ok: false, error: 'only the subscription owner may modify it' }, { status: 403 });
  }

  if (typeof body?.enabled === 'boolean') sub.enabled = body.enabled;

  if (body?.format !== undefined) {
    const format = body.format.toString().toUpperCase();
    if (!FORMATS.has(format)) return NextResponse.json({ ok: false, error: 'format must be PDF, PPTX, or PNG' }, { status: 400 });
    sub.format = format as 'PDF' | 'PPTX' | 'PNG';
  }

  if (body?.presetId !== undefined || body?.cron !== undefined) {
    const presetId = (body?.presetId || '').toString().trim();
    const cron = (presetId ? cronForPreset(presetId) : (body?.cron || '').toString().trim()) || '';
    if (presetId && !cron) return NextResponse.json({ ok: false, error: `unknown schedule preset "${presetId}"` }, { status: 400 });
    const cronErr = validateNcrontab(cron);
    if (cronErr) return NextResponse.json({ ok: false, error: cronErr }, { status: 400 });
    sub.cron = cron;
  }

  if (body?.recipients !== undefined) {
    const recipients = (Array.isArray(body.recipients) ? body.recipients : [])
      .map((r: unknown) => (r || '').toString().trim())
      .filter((r: string) => r.length > 0);
    if (recipients.length === 0) return NextResponse.json({ ok: false, error: 'at least one recipient email is required' }, { status: 400 });
    if (recipients.length > MAX_RECIPIENTS) return NextResponse.json({ ok: false, error: `too many recipients (max ${MAX_RECIPIENTS})` }, { status: 400 });
    const badEmail = recipients.find((r: string) => !EMAIL_RE.test(r));
    if (badEmail) return NextResponse.json({ ok: false, error: `invalid recipient email "${badEmail}"` }, { status: 400 });
    sub.recipients = recipients;
  }

  if (body?.subject !== undefined) {
    sub.subject = body.subject.toString().trim() || undefined;
  }

  sub.updatedAt = new Date().toISOString();

  try {
    const c = await reportSubscriptionsContainer();
    const { resource } = await c.item(subId, reportId).replace(sub);
    return NextResponse.json({ ok: true, subscription: resource });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; subId: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id: reportId, subId } = await ctx.params;

  let sub: ReportSubscription | null;
  try {
    sub = await readSub(reportId, subId);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  if (!sub) return NextResponse.json({ ok: false, error: 'subscription not found' }, { status: 404 });
  if (sub.createdBy !== s.claims.oid) {
    return NextResponse.json({ ok: false, error: 'only the subscription owner may cancel it' }, { status: 403 });
  }

  try {
    const c = await reportSubscriptionsContainer();
    await c.item(subId, reportId).delete();
    return NextResponse.json({ ok: true, deleted: subId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

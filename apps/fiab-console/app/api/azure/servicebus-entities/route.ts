/**
 * GET /api/azure/servicebus-entities
 *   List the queues and topics of a CALLER-NAMED Service Bus namespace.
 *
 * Query (one of):
 *   ?namespaceId=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ServiceBus/namespaces/<ns>
 *   ?namespace=<name>[&subscriptionId=<sub>]
 *
 * Response:
 *   { ok: true,  namespace, entities: [{ name, kind: 'queue' | 'topic' }] }
 *   { ok: false, error, hint? }                       401 / 400 / 403 / 502
 *
 * WHY THIS ROUTE EXISTS (#3526). The activation-sync destination editor picks a
 * namespace, then used to ask the operator to TYPE the queue or topic name —
 * a free-text infrastructure value the platform can enumerate, which is what
 * `loom_no_freeform_config` and `auto-bind-by-default.md` §5 forbid. Azure
 * Resource Graph cannot serve the answer: queues and topics are ARM CHILD
 * resources of a namespace and are not Resource Graph rows, so `/api/azure/
 * resources` (which every other picker on that surface uses) has nothing to
 * return. This is the control-plane call that does.
 *
 * IT IS SCOPED TO THE NAMESPACE THE CALLER NAMED. `lib/azure/servicebus-client`
 * also exposes `listQueues()` / `listTopics()`, but those are pinned to
 * LOOM_SERVICEBUS_NAMESPACE — using them here would list a DIFFERENT
 * namespace's entities under the one the user picked, which is worse than the
 * text box it replaced. Hence `listQueuesIn` / `listTopicsIn`.
 *
 * AN ERROR IS NEVER FLATTENED TO AN EMPTY LIST (`deploy-integrity.md` R7).
 * "this namespace has no queues" and "I could not read this namespace" are
 * different answers and the caller renders them differently; a 403 that came
 * back as `entities: []` would read to the operator as "you have none".
 *
 * CLOUD PARITY: every ARM call goes through `arm-client`, which resolves the
 * sovereign ARM base — the same code path serves Commercial, GCC, GCC-High and
 * IL5 with no per-cloud branch here (`cloud-parity.md`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listQueuesIn, listTopicsIn, parseNamespaceId, resolveNamespaceByName,
  type NamespaceRef,
} from '@/lib/azure/servicebus-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ServiceBusEntity {
  name: string;
  kind: 'queue' | 'topic';
}

/** HTTP status carried by an ARM failure, when the thrown error names one. */
function statusOf(e: any): number {
  const n = Number(e?.status ?? e?.statusCode);
  if (Number.isFinite(n) && n >= 400 && n <= 599) return n;
  const m = String(e?.message || '').match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : 502;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const namespaceId = (sp.get('namespaceId') || '').trim();
  const namespaceName = (sp.get('namespace') || '').trim();
  const subscriptionId = (sp.get('subscriptionId') || '').trim() || undefined;

  if (!namespaceId && !namespaceName) {
    return NextResponse.json({
      ok: false,
      error: 'No namespace supplied.',
      hint: 'Pass ?namespaceId=<ARM id> (preferred — the picker hands one back) or ?namespace=<name>.',
    }, { status: 400 });
  }

  let ref: NamespaceRef;
  try {
    if (namespaceId) {
      const parsed = parseNamespaceId(namespaceId);
      if (!parsed) {
        return NextResponse.json({
          ok: false,
          error: `'${namespaceId}' is not a Microsoft.ServiceBus/namespaces resource id.`,
          hint: 'Expected /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ServiceBus/namespaces/<name>.',
        }, { status: 400 });
      }
      ref = parsed;
    } else {
      ref = await resolveNamespaceByName(namespaceName, subscriptionId);
    }
  } catch (e: any) {
    // Resolution failed for a reason the client stated precisely — pass it
    // through verbatim rather than replacing it with a generic 400.
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: statusOf(e) });
  }

  try {
    // Both listings are independent ARM GETs; a failure in either is a real
    // failure of the answer, so they are NOT settled independently — a partial
    // list presented as complete is the shape that reads as "you have no
    // topics" when topics were simply unreadable.
    const [queues, topics] = await Promise.all([listQueuesIn(ref), listTopicsIn(ref)]);
    const entities: ServiceBusEntity[] = [
      ...queues.map((q) => ({ name: q.name, kind: 'queue' as const })),
      ...topics.map((t) => ({ name: t.name, kind: 'topic' as const })),
    ].filter((e) => !!e.name);
    return NextResponse.json({ ok: true, namespace: ref.namespace, entities });
  } catch (e: any) {
    const status = statusOf(e);
    const hint = status === 401 || status === 403
      ? `Grant the Console identity "Azure Service Bus Data Receiver" plus Reader (or Contributor) on namespace '${ref.namespace}' in resource group '${ref.resourceGroup}'.`
      : undefined;
    return NextResponse.json({
      ok: false,
      error: `Could not list queues and topics of '${ref.namespace}': ${e?.message || String(e)}`,
      hint,
    }, { status });
  }
}

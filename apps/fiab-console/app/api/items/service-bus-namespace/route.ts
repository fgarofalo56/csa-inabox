/**
 * Service Bus namespace item — navigator over the deployment-pinned Azure
 * Service Bus namespace (Microsoft.ServiceBus/namespaces). Reuses the thin
 * servicebus-client (over the shared ARM fetcher); real ARM REST, no mocks.
 *
 *   GET    /api/items/service-bus-namespace                                   → { ok, namespace, queues, topics }
 *   GET    /api/items/service-bus-namespace?topic=T&subscriptions=1           → { ok, subscriptions }
 *   GET    /api/items/service-bus-namespace?topic=T&subscription=S&rules=1    → { ok, rules }
 *   GET    /api/items/service-bus-namespace?authRules=1                       → { ok, authorizationRules }
 *   GET    /api/items/service-bus-namespace?network=1                         → { ok, network, privateEndpoints }
 *   POST   { action:'create-queue' | 'create-topic' | 'create-subscription'
 *            | 'create-rule' | 'create-auth-rule' | 'list-keys' | 'regenerate-keys', … }
 *   DELETE ?queue=NAME | ?topic=NAME
 *          | ?topic=T&subscription=S            (delete subscription)
 *          | ?topic=T&subscription=S&rule=R     (delete filter rule)
 *          | ?authRule=NAME                     (delete SAS policy)
 *
 * Honest 503 gate when LOOM_SERVICEBUS_NAMESPACE / SUB / RG is unset. The
 * Console UAMI must hold Contributor on the namespace. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  servicebusConfigGate,
  getNamespaceProperties,
  listQueues,
  createQueue,
  deleteQueue,
  listTopics,
  createTopic,
  deleteTopic,
  listSubscriptions,
  createSubscription,
  deleteSubscription,
  listRules,
  createRule,
  deleteRule,
  listNamespaceAuthRules,
  createNamespaceAuthRule,
  deleteNamespaceAuthRule,
  listNamespaceKeys,
  regenerateNamespaceKeys,
  getNetworkRuleSet,
  listPrivateEndpointConnections,
  iso8601Duration,
  type SasRight,
  type RegenerateKeyType,
} from '@/lib/azure/servicebus-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauth() { return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }); }

function gate() {
  const g = servicebusConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false, code: 'not_configured', notDeployed: true,
        error: `Service Bus namespace not configured: set ${g.missing}.`,
        missing: g.missing,
        hint: 'Set LOOM_SERVICEBUS_NAMESPACE (+ LOOM_SERVICEBUS_SUB/RG) and grant the Console UAMI Contributor on the namespace.',
        bicep: 'platform/fiab/bicep/modules/landing-zone/servicebus.bicep',
      },
      { status: 503 },
    );
  }
  return null;
}

/** Coerce a numeric field from the request body, undefined when absent/NaN. */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const sp = req.nextUrl.searchParams;
  const topic = sp.get('topic')?.trim();
  const subscription = sp.get('subscription')?.trim();
  try {
    // Subscription filter rules
    if (topic && subscription && sp.get('rules')) {
      const rules = await listRules(topic, subscription);
      return NextResponse.json({ ok: true, rules });
    }
    // Topic subscriptions
    if (topic && sp.get('subscriptions')) {
      const subscriptions = await listSubscriptions(topic);
      return NextResponse.json({ ok: true, subscriptions });
    }
    // Namespace SAS policies
    if (sp.get('authRules')) {
      const authorizationRules = await listNamespaceAuthRules();
      return NextResponse.json({ ok: true, authorizationRules });
    }
    // Networking (firewall + private endpoints)
    if (sp.get('network')) {
      const [network, privateEndpoints] = await Promise.all([
        getNetworkRuleSet().catch(() => null),
        listPrivateEndpointConnections().catch(() => []),
      ]);
      return NextResponse.json({ ok: true, network, privateEndpoints });
    }
    // Default: namespace + entities
    const [namespace, queues, topics] = await Promise.all([
      getNamespaceProperties().catch(() => null),
      listQueues(),
      listTopics(),
    ]);
    return NextResponse.json({ ok: true, namespace, queues, topics });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  try {
    if (action === 'create-queue') {
      const name = String(body?.name || '').trim();
      if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
      const queue = await createQueue({
        name,
        maxSizeInMegabytes: num(body?.maxSizeInMegabytes),
        requiresSession: !!body?.requiresSession,
        requiresDuplicateDetection: !!body?.requiresDuplicateDetection,
        deadLetteringOnMessageExpiration: !!body?.deadLetteringOnMessageExpiration,
        enablePartitioning: !!body?.enablePartitioning,
        maxDeliveryCount: num(body?.maxDeliveryCount),
        lockDuration: iso8601Duration(num(body?.lockDurationSeconds), 'S'),
        defaultMessageTimeToLive: iso8601Duration(num(body?.messageTtlDays), 'D'),
        duplicateDetectionHistoryTimeWindow: iso8601Duration(num(body?.dupDetectionWindowMinutes), 'M'),
        forwardTo: body?.forwardTo ? String(body.forwardTo) : undefined,
        forwardDeadLetteredMessagesTo: body?.forwardDeadLetteredMessagesTo ? String(body.forwardDeadLetteredMessagesTo) : undefined,
      });
      return NextResponse.json({ ok: true, queue });
    }

    if (action === 'create-topic') {
      const name = String(body?.name || '').trim();
      if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
      const topic = await createTopic({
        name,
        maxSizeInMegabytes: num(body?.maxSizeInMegabytes),
        requiresDuplicateDetection: !!body?.requiresDuplicateDetection,
        enablePartitioning: !!body?.enablePartitioning,
        supportOrdering: body?.supportOrdering == null ? undefined : !!body.supportOrdering,
        defaultMessageTimeToLive: iso8601Duration(num(body?.messageTtlDays), 'D'),
        duplicateDetectionHistoryTimeWindow: iso8601Duration(num(body?.dupDetectionWindowMinutes), 'M'),
      });
      return NextResponse.json({ ok: true, topic });
    }

    if (action === 'create-subscription') {
      const topic = String(body?.topic || '').trim();
      const name = String(body?.name || '').trim();
      if (!topic || !name) return NextResponse.json({ ok: false, error: 'topic and name are required' }, { status: 400 });
      const subscription = await createSubscription({
        topic, name,
        requiresSession: !!body?.requiresSession,
        deadLetteringOnMessageExpiration: !!body?.deadLetteringOnMessageExpiration,
        deadLetteringOnFilterEvaluationExceptions: body?.deadLetteringOnFilterEvaluationExceptions == null ? undefined : !!body.deadLetteringOnFilterEvaluationExceptions,
        maxDeliveryCount: num(body?.maxDeliveryCount),
        lockDuration: iso8601Duration(num(body?.lockDurationSeconds), 'S'),
        defaultMessageTimeToLive: iso8601Duration(num(body?.messageTtlDays), 'D'),
        forwardTo: body?.forwardTo ? String(body.forwardTo) : undefined,
        forwardDeadLetteredMessagesTo: body?.forwardDeadLetteredMessagesTo ? String(body.forwardDeadLetteredMessagesTo) : undefined,
      });
      return NextResponse.json({ ok: true, subscription });
    }

    if (action === 'create-rule') {
      const topic = String(body?.topic || '').trim();
      const sub = String(body?.subscription || '').trim();
      const name = String(body?.name || '').trim();
      const filterType = body?.filterType === 'CorrelationFilter' ? 'CorrelationFilter' : 'SqlFilter';
      if (!topic || !sub || !name) return NextResponse.json({ ok: false, error: 'topic, subscription and name are required' }, { status: 400 });
      const rule = await createRule({
        topic, subscription: sub, name, filterType,
        sqlExpression: body?.sqlExpression ? String(body.sqlExpression) : undefined,
        correlationFilter: (body?.correlationFilter && typeof body.correlationFilter === 'object') ? body.correlationFilter : undefined,
        actionSqlExpression: body?.actionSqlExpression ? String(body.actionSqlExpression) : undefined,
      });
      return NextResponse.json({ ok: true, rule });
    }

    if (action === 'create-auth-rule') {
      const name = String(body?.name || '').trim();
      const rights = Array.isArray(body?.rights) ? (body.rights as SasRight[]) : [];
      if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
      if (!rights.length) return NextResponse.json({ ok: false, error: 'at least one right (Listen/Send/Manage) is required' }, { status: 400 });
      const authorizationRule = await createNamespaceAuthRule(name, rights);
      return NextResponse.json({ ok: true, authorizationRule });
    }

    if (action === 'list-keys') {
      const rule = String(body?.rule || '').trim();
      if (!rule) return NextResponse.json({ ok: false, error: 'rule is required' }, { status: 400 });
      const keys = await listNamespaceKeys(rule);
      return NextResponse.json({ ok: true, keys });
    }

    if (action === 'regenerate-keys') {
      const rule = String(body?.rule || '').trim();
      const keyType = (body?.keyType === 'SecondaryKey' ? 'SecondaryKey' : 'PrimaryKey') as RegenerateKeyType;
      if (!rule) return NextResponse.json({ ok: false, error: 'rule is required' }, { status: 400 });
      const keys = await regenerateNamespaceKeys(rule, keyType);
      return NextResponse.json({ ok: true, keys });
    }

    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const sp = req.nextUrl.searchParams;
  const queue = sp.get('queue')?.trim();
  const topic = sp.get('topic')?.trim();
  const subscription = sp.get('subscription')?.trim();
  const rule = sp.get('rule')?.trim();
  const authRule = sp.get('authRule')?.trim();
  if (!queue && !topic && !authRule) {
    return NextResponse.json({ ok: false, error: 'queue, topic or authRule query param is required' }, { status: 400 });
  }
  try {
    if (authRule) {
      await deleteNamespaceAuthRule(authRule);
    } else if (topic && subscription && rule) {
      await deleteRule(topic, subscription, rule);
    } else if (topic && subscription) {
      await deleteSubscription(topic, subscription);
    } else if (queue) {
      await deleteQueue(queue);
    } else if (topic) {
      await deleteTopic(topic);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

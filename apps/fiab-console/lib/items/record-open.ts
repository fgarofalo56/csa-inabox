/**
 * record-open — shared, throttled "item opened" audit write feeding the Recent
 * rail (`GET /api/items/recent` joins audit `action:'open'` events by userId).
 *
 * Lives in lib/ (not the generic [type]/[id] route) because item types with
 * their OWN base route (eventstream, kql-database, kql-dashboard, notebook, …)
 * bypass the generic GET entirely — Recents stayed empty for exactly the
 * highest-traffic editors. Every type-specific base GET calls this too.
 *
 * Best-effort by contract: an audit hiccup must never block or fail the read.
 * Throttled per (user, item) so an editor that re-fetches its doc doesn't spam
 * the log; the throttle map is capped so a long-lived replica never grows
 * unbounded.
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';

const OPEN_THROTTLE_MS = 5 * 60 * 1000;
const lastOpenWrite = new Map<string, number>();

export interface OpenAuditUser {
  oid: string;
  upn?: string;
}

export interface OpenAuditItem {
  id: string;
  itemType: string;
  workspaceId: string;
}

export async function recordItemOpen(user: OpenAuditUser, item: OpenAuditItem): Promise<void> {
  const throttleKey = `${user.oid}:${item.id}`;
  const now = Date.now();
  const last = lastOpenWrite.get(throttleKey);
  if (last && now - last < OPEN_THROTTLE_MS) return;
  lastOpenWrite.set(throttleKey, now);
  if (lastOpenWrite.size > 5000) {
    for (const [k, t] of lastOpenWrite) if (now - t > OPEN_THROTTLE_MS) lastOpenWrite.delete(k);
  }
  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: crypto.randomUUID(),
      itemId: item.id,
      itemType: item.itemType,
      workspaceId: item.workspaceId,
      userId: user.oid,
      upn: user.upn,
      action: 'open',
      summary: '',
      diff: null,
      at: new Date().toISOString(),
    });
  } catch {
    // best-effort — an audit hiccup must never break the item read
    lastOpenWrite.delete(throttleKey);
  }
}

/**
 * Lock ordering (ADR-008 decision 5): tenant environments scope -> gateway
 * scopes -> endpoint scopes -> publication locks, each tier sorted by id, held
 * as leases with expiry. Every writer takes scopes through lockOrder() so two
 * writers can never deadlock by acquiring in different orders.
 */
import type { LockPort } from './types';

export const ENVIRONMENTS_SCOPE = 'environments:tenant';

const TIER: Record<string, number> = { environments: 0, gateway: 1, endpoint: 2, publication: 3 };

export function lockOrder(scopes: Iterable<string>): string[] {
  return [...new Set(scopes)].sort((a, b) => {
    const [ta, ia] = [a.split(':')[0], a.slice(a.indexOf(':') + 1)];
    const [tb, ib] = [b.split(':')[0], b.slice(b.indexOf(':') + 1)];
    const d = (TIER[ta] ?? 99) - (TIER[tb] ?? 99);
    if (d !== 0) return d;
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/** In-memory lease lock (tests, and a single-replica fallback). Expired leases are taken over. */
export class InMemoryLockPort implements LockPort {
  private readonly held = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async acquire(tenantId: string, scopes: string[], ttlMs: number): Promise<(() => Promise<void>) | undefined> {
    const keys = scopes.map((s) => `${tenantId}|${s}`);
    const t = this.now();
    if (keys.some((k) => (this.held.get(k) ?? 0) > t)) return undefined;
    keys.forEach((k) => this.held.set(k, t + ttlMs));
    return async () => { keys.forEach((k) => this.held.delete(k)); };
  }
}

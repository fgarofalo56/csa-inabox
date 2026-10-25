import { badRequest, conflict, notFound, StoreConflictError } from '../http/errors.js';
import type { Collection } from '../store/types.js';
import {
  SLUG,
  StampCreateSchema,
  StampPatchSchema,
  TenantCreateSchema,
  TenantPatchSchema,
  type StampDoc,
  type StampStatus,
  type TenantDoc,
  type TenantStatus,
} from './types.js';

export const LIST_LIMIT = 500;
const MAX_RETRIES = 3;

// Allowed lifecycle moves. A status change not listed here is a 409, so a
// paused stamp cannot jump to evacuated without going through draining, etc.
const STAMP_MOVES: Record<StampStatus, readonly StampStatus[]> = {
  creating: ['healthy'],
  healthy: ['draining', 'paused'],
  paused: ['healthy', 'draining'],
  draining: ['evacuated', 'healthy'],
  evacuated: [],
};
const TENANT_MOVES: Record<TenantStatus, readonly TenantStatus[]> = {
  creating: ['active', 'destroying'],
  active: ['draining', 'suspended', 'destroying'],
  suspended: ['active', 'destroying'],
  draining: ['active', 'destroying'],
  destroying: [],
};

function parse<T>(r: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }): T {
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw badRequest(`${first?.path.join('.') || 'body'}: ${first?.message ?? 'invalid'}`);
}

export function assertSlug(id: string, what: string): string {
  if (!SLUG.test(id)) throw badRequest(`${what} id is malformed`);
  return id;
}

export class Registry {
  constructor(
    private readonly stamps: Collection<StampDoc>,
    private readonly tenants: Collection<TenantDoc>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listStamps(): Promise<StampDoc[]> {
    return this.stamps.list(LIST_LIMIT);
  }

  async getStamp(id: string): Promise<StampDoc> {
    const s = await this.stamps.get(assertSlug(id, 'stamp'));
    if (!s) throw notFound('stamp');
    return s;
  }

  async createStamp(body: unknown, actor: string): Promise<StampDoc> {
    const v = parse(StampCreateSchema.safeParse(body));
    const ts = this.now().toISOString();
    try {
      return await this.stamps.create({
        ...v,
        status: 'creating',
        engineVersions: {},
        createdAt: ts,
        updatedAt: ts,
        updatedBy: actor,
      });
    } catch (e) {
      if (e instanceof StoreConflictError) throw conflict('stamp already exists');
      throw e;
    }
  }

  async updateStamp(id: string, body: unknown, actor: string): Promise<StampDoc> {
    const patch = parse(StampPatchSchema.safeParse(body));
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const cur = await this.getStamp(id);
      if (patch.status && patch.status !== cur.status && !STAMP_MOVES[cur.status].includes(patch.status)) {
        throw conflict(`stamp cannot move from ${cur.status} to ${patch.status}`);
      }
      const next: StampDoc = { ...cur, ...patch, updatedAt: this.now().toISOString(), updatedBy: actor };
      if (next.status !== 'paused') delete next.pauseReason;
      try {
        return await this.stamps.replace(next);
      } catch (e) {
        if (!(e instanceof StoreConflictError)) throw e;
      }
    }
    throw conflict('stamp was modified concurrently; retry');
  }

  listTenants(): Promise<TenantDoc[]> {
    return this.tenants.list(LIST_LIMIT);
  }

  async getTenant(id: string): Promise<TenantDoc> {
    const t = await this.tenants.get(assertSlug(id, 'tenant'));
    if (!t) throw notFound('tenant');
    return t;
  }

  async createTenant(body: unknown, actor: string): Promise<TenantDoc> {
    const v = parse(TenantCreateSchema.safeParse(body));
    const stamp = await this.stamps.get(v.stampId);
    if (!stamp) throw badRequest('stampId does not reference a registered stamp');
    if (stamp.status === 'draining' || stamp.status === 'evacuated') {
      throw conflict(`stamp is ${stamp.status} and cannot accept new tenants`);
    }
    const ts = this.now().toISOString();
    try {
      return await this.tenants.create({ ...v, status: 'creating', createdAt: ts, updatedAt: ts, updatedBy: actor });
    } catch (e) {
      if (e instanceof StoreConflictError) throw conflict('tenant already exists');
      throw e;
    }
  }

  async updateTenant(id: string, body: unknown, actor: string): Promise<TenantDoc> {
    const patch = parse(TenantPatchSchema.safeParse(body));
    if (patch.drainTargetStampId && !(await this.stamps.get(patch.drainTargetStampId))) {
      throw badRequest('drainTargetStampId does not reference a registered stamp');
    }
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const cur = await this.getTenant(id);
      if (patch.status && patch.status !== cur.status && !TENANT_MOVES[cur.status].includes(patch.status)) {
        throw conflict(`tenant cannot move from ${cur.status} to ${patch.status}`);
      }
      const next: TenantDoc = { ...cur, ...patch, updatedAt: this.now().toISOString(), updatedBy: actor };
      if (next.status !== 'draining') delete next.drainTargetStampId;
      if (next.status === 'draining' && !next.drainTargetStampId) {
        throw badRequest('drainTargetStampId is required while draining');
      }
      try {
        return await this.tenants.replace(next);
      } catch (e) {
        if (!(e instanceof StoreConflictError)) throw e;
      }
    }
    throw conflict('tenant was modified concurrently; retry');
  }
}

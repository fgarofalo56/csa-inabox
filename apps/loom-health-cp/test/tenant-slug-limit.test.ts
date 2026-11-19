/**
 * Tenant id limit. tenant.bicep caps `tenantSlug` at @maxLength(20); the control plane must
 * reject a longer id at CREATE (a 21-char id passed here and then failed ARM with
 * InvalidTemplate, 2026-11-19) while reads of existing longer records keep working.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Registry } from '../src/registry/registry.js';
import { TENANT_ID_MAX, TenantCreateSchema } from '../src/registry/types.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { MemoryCollection, stampBody, tenantBody } from './helpers.js';

// Lifted from the bicep source at runtime (assertion-design.md rule 3), never transcribed.
// BICEP_PATH is overridable so the mutation run can aim at a sandbox copy.
const BICEP_PATH = process.env.TENANT_BICEP_PATH ?? resolve(__dirname, '../../../platform/fiab/bicep/modules/health/tenant.bicep');
const BICEP = readFileSync(BICEP_PATH, 'utf8');
const BICEP_MAX = Number(/@maxLength\((\d+)\)\s*\r?\n\s*param tenantSlug string/.exec(BICEP)?.[1]);

describe('tenant id limit', () => {
  it('lifted the bicep limit (control: the lift worked)', () => {
    expect(Number.isInteger(BICEP_MAX), 'tenantSlug @maxLength not found in tenant.bicep').toBe(true);
  });

  it('equals the tenant.bicep tenantSlug @maxLength (breaks if either side drifts, e.g. bicep 24)', () => {
    expect(TENANT_ID_MAX).toBe(BICEP_MAX);
  });

  it('accepts a 20-char id and rejects a 21-char id with a 400 naming the limit', async () => {
    const stamps = new MemoryCollection<StampDoc>();
    const tenants = new MemoryCollection<TenantDoc>();
    const reg = new Registry(stamps, tenants, () => new Date('2026-11-19T00:00:00Z'));
    await reg.createStamp(stampBody(), 'a');
    const ok = await reg.createTenant(tenantBody('a'.repeat(20)), 'a');
    expect(ok.id).toHaveLength(20);
    await expect(reg.createTenant(tenantBody('a'.repeat(21)), 'a')).rejects.toMatchObject({ status: 400 });
    const r = TenantCreateSchema.safeParse(tenantBody('a'.repeat(21)));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('20');
  });

  it('still reads an existing tenant whose id is longer than the create limit', async () => {
    const stamps = new MemoryCollection<StampDoc>();
    const tenants = new MemoryCollection<TenantDoc>();
    const reg = new Registry(stamps, tenants, () => new Date('2026-11-19T00:00:00Z'));
    await reg.createStamp(stampBody(), 'a');
    const longId = 'g1-synth-202611192201';
    expect(longId.length).toBe(21);
    await tenants.create({ ...tenantBody(longId), status: 'creating', createdAt: 'x', updatedAt: 'x', updatedBy: 'a' } as unknown as TenantDoc);
    expect((await reg.getTenant(longId)).id).toBe(longId);
  });
});

/**
 * Unit tests for the notebook scheduling route /api/notebook/[id]/schedule
 * (GET list / POST create / PATCH enable-disable).
 *
 * The AML ARM client functions are mocked; the pure helpers (notebookSchedulePrefix)
 * and the error classes run for real so the route's honest config gate + payload
 * validation are exercised against the actual shapes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
// Fully stub the AML client so the test never loads @azure/identity. The error
// classes + notebookSchedulePrefix are re-implemented to match the real module
// (the route relies on instanceof + the prefix shape, both preserved here).
vi.mock('@/lib/azure/foundry-client', () => {
  class AmlScheduleNotConfiguredError extends Error {
    hint: string; missing: string[];
    constructor(missing: string[]) {
      super('Azure ML job scheduling is not configured in this deployment');
      this.name = 'AmlScheduleNotConfiguredError';
      this.missing = missing;
      this.hint = `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace. LOOM_AML_WORKSPACE / LOOM_AML_RG fall back to LOOM_FOUNDRY_NAME / LOOM_FOUNDRY_RG.`;
    }
  }
  class FoundryError extends Error {
    status: number; body: unknown;
    constructor(status: number, body: unknown, message?: string) {
      super(message || `AI Foundry call failed (${status})`);
      this.status = status; this.body = body;
    }
  }
  const notebookSchedulePrefix = (id: string) =>
    `loom-nb-${String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'nb'}-`;
  return {
    AmlScheduleNotConfiguredError,
    FoundryError,
    notebookSchedulePrefix,
    amlScheduleConfig: vi.fn(),
    isAmlScheduleConfigured: vi.fn(),
    listNotebookSchedules: vi.fn(),
    createNotebookSchedule: vi.fn(),
    setScheduleEnabled: vi.fn(),
  };
});

// rel-T19 — the schedule route now authorizes `[id]` against the notebook item
// via loadOwnedItem (item-crud). Stub it hermetically.
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: vi.fn() }));

import { GET, POST, PATCH } from '../[id]/schedule/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  amlScheduleConfig, isAmlScheduleConfigured, listNotebookSchedules,
  createNotebookSchedule, setScheduleEnabled, AmlScheduleNotConfiguredError,
} from '@/lib/azure/foundry-client';

const ctx = { params: Promise.resolve({ id: 'nb1' }) };
function jsonReq(body: any) { return { json: async () => body } as any; }
const NB_ITEM = { id: 'nb1', workspaceId: 'w1', itemType: 'notebook', state: {} } as any;

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'u1' }, exp: 9e9 });
  (loadOwnedItem as any).mockResolvedValue(NB_ITEM);
});

describe('GET /api/notebook/[id]/schedule', () => {
  it('returns 401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET({} as any, ctx);
    expect(res.status).toBe(401);
  });

  it('returns configured:false honest gate when the AML workspace is unset', async () => {
    (amlScheduleConfig as any).mockImplementation(() => { throw new AmlScheduleNotConfiguredError(['LOOM_AML_WORKSPACE']); });
    const res = await GET({} as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.configured).toBe(false);
    expect(j.missing).toContain('LOOM_AML_WORKSPACE');
    expect(j.hint).toContain('LOOM_AML_WORKSPACE');
  });

  it('lists schedules for the notebook when configured', async () => {
    (amlScheduleConfig as any).mockReturnValue({ subscriptionId: 's', resourceGroup: 'rg', workspace: 'ws' });
    (listNotebookSchedules as any).mockResolvedValue([{ name: 'loom-nb-nb1-abc', isEnabled: true, frequency: 'Day', interval: 1 }]);
    const res = await GET({} as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.configured).toBe(true);
    expect(j.schedules).toHaveLength(1);
    // filtered by the per-notebook prefix
    expect((listNotebookSchedules as any).mock.calls[0][0]).toBe('loom-nb-nb1-');
  });

  it('404 when the caller cannot access the notebook (rel-T19)', async () => {
    (amlScheduleConfig as any).mockReturnValue({ subscriptionId: 's', resourceGroup: 'rg', workspace: 'ws' });
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await GET({} as any, ctx);
    expect(res.status).toBe(404);
    expect(listNotebookSchedules).not.toHaveBeenCalled();
  });
});

describe('POST /api/notebook/[id]/schedule', () => {
  it('creates a daily schedule with frequency Day interval 1', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    (createNotebookSchedule as any).mockResolvedValue({ name: 'loom-nb-nb1-xyz', displayName: 'daily-run', isEnabled: true, frequency: 'Day', interval: 1 });
    const res = await POST(jsonReq({ displayName: 'daily-run', frequency: 'Day', interval: 1, startTime: '2026-06-08T00:00:00.000Z', timeZone: 'UTC' }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.schedule.frequency).toBe('Day');
    const [name, body] = (createNotebookSchedule as any).mock.calls[0];
    expect(name.startsWith('loom-nb-nb1-')).toBe(true);
    expect(body.frequency).toBe('Day');
    expect(body.interval).toBe(1);
  });

  it('returns the honest gate when not configured', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(false);
    (amlScheduleConfig as any).mockImplementation(() => { throw new AmlScheduleNotConfiguredError(['LOOM_SUBSCRIPTION_ID']); });
    const res = await POST(jsonReq({ displayName: 'x', frequency: 'Day', interval: 1 }), ctx);
    const j = await res.json();
    expect(j.configured).toBe(false);
    expect(createNotebookSchedule).not.toHaveBeenCalled();
  });

  it('404 when the caller cannot write the notebook (rel-T19)', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await POST(jsonReq({ displayName: 'x', frequency: 'Day', interval: 1 }), ctx);
    expect(res.status).toBe(404);
    expect(createNotebookSchedule).not.toHaveBeenCalled();
    expect(loadOwnedItem).toHaveBeenCalledWith('nb1', 'notebook', 'u1', { allowReadRoles: false });
  });

  it('400 when displayName missing', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    const res = await POST(jsonReq({ frequency: 'Day', interval: 1 }), ctx);
    expect(res.status).toBe(400);
  });

  it('400 when frequency is not a recurrence value', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    const res = await POST(jsonReq({ displayName: 'x', frequency: 'Cron', interval: 1 }), ctx);
    expect(res.status).toBe(400);
  });

  it('400 when interval is not a positive integer', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    const res = await POST(jsonReq({ displayName: 'x', frequency: 'Day', interval: 0 }), ctx);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/notebook/[id]/schedule', () => {
  it('disables a schedule (re-PUT with isEnabled false)', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    (setScheduleEnabled as any).mockResolvedValue({ name: 'loom-nb-nb1-xyz', isEnabled: false });
    const res = await PATCH(jsonReq({ scheduleName: 'loom-nb-nb1-xyz', isEnabled: false }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(setScheduleEnabled).toHaveBeenCalledWith('loom-nb-nb1-xyz', false);
    expect(j.schedule.isEnabled).toBe(false);
  });

  it('400 when scheduleName missing', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    const res = await PATCH(jsonReq({ isEnabled: false }), ctx);
    expect(res.status).toBe(400);
  });

  it('400 when isEnabled is not a boolean', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    const res = await PATCH(jsonReq({ scheduleName: 'loom-nb-nb1-xyz' }), ctx);
    expect(res.status).toBe(400);
  });

  it('403 when the scheduleName belongs to another notebook (rel-T19)', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    const res = await PATCH(jsonReq({ scheduleName: 'loom-nb-nb2-xyz', isEnabled: false }), ctx);
    expect(res.status).toBe(403);
    expect(setScheduleEnabled).not.toHaveBeenCalled();
  });

  it('404 when the caller cannot write the notebook (rel-T19)', async () => {
    (isAmlScheduleConfigured as any).mockReturnValue(true);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await PATCH(jsonReq({ scheduleName: 'loom-nb-nb1-xyz', isEnabled: false }), ctx);
    expect(res.status).toBe(404);
    expect(setScheduleEnabled).not.toHaveBeenCalled();
  });
});

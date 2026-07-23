import { describe, it, expect, vi } from 'vitest';
import {
  validateBudgetInput,
  budgetScope,
  buildBudgetBody,
  upsertBudget,
  deleteBudget,
  BudgetWriteError,
  type BudgetInput,
} from '../budgets-client';

const SUB = '11111111-1111-1111-1111-111111111111';
const valid: BudgetInput = {
  name: 'monthly-prod', subscription: SUB, amount: 5000, timeGrain: 'Monthly',
  startDate: '2026-07-01T00:00:00Z', thresholds: [80, 100], contactEmails: ['finops@contoso.com'],
};

describe('validateBudgetInput', () => {
  it('accepts a valid input', () => {
    expect(validateBudgetInput(valid)).toBeNull();
  });
  it('rejects bad name / sub / amount / grain / date / threshold / email', () => {
    expect(validateBudgetInput({ ...valid, name: 'bad name!' })).toMatch(/name/);
    expect(validateBudgetInput({ ...valid, subscription: 'nope' })).toMatch(/subscription/);
    expect(validateBudgetInput({ ...valid, amount: 0 })).toMatch(/amount/);
    expect(validateBudgetInput({ ...valid, timeGrain: 'Weekly' as any })).toMatch(/timeGrain/);
    expect(validateBudgetInput({ ...valid, startDate: 'not-a-date' })).toMatch(/startDate/);
    expect(validateBudgetInput({ ...valid, thresholds: [2000] })).toMatch(/threshold/);
    expect(validateBudgetInput({ ...valid, contactEmails: ['bad'] })).toMatch(/email/);
    expect(validateBudgetInput(null)).toMatch(/required/);
  });
});

describe('budgetScope', () => {
  it('builds subscription and RG scopes', () => {
    expect(budgetScope(SUB)).toBe(`/subscriptions/${SUB}`);
    expect(budgetScope(SUB, 'rg-1')).toBe(`/subscriptions/${SUB}/resourceGroups/rg-1`);
  });
});

describe('buildBudgetBody', () => {
  it('emits Cost category + a notification per threshold + a forecasted alert', () => {
    const body: any = buildBudgetBody(valid);
    expect(body.properties.category).toBe('Cost');
    expect(body.properties.amount).toBe(5000);
    expect(body.properties.timeGrain).toBe('Monthly');
    expect(body.properties.notifications).toHaveProperty('Actual_GreaterThan_80_Percent');
    expect(body.properties.notifications).toHaveProperty('Actual_GreaterThan_100_Percent');
    expect(body.properties.notifications).toHaveProperty('Forecasted_GreaterThan_100_Percent');
    expect(body.properties.notifications.Actual_GreaterThan_80_Percent.contactEmails).toEqual(['finops@contoso.com']);
  });
  it('defaults thresholds to 80/100 when none supplied', () => {
    const body: any = buildBudgetBody({ ...valid, thresholds: [] });
    expect(body.properties.notifications).toHaveProperty('Actual_GreaterThan_80_Percent');
    expect(body.properties.notifications).toHaveProperty('Actual_GreaterThan_100_Percent');
  });
});

describe('upsertBudget', () => {
  it('PUTs to the Consumption budgets provider with a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'x' }) });
    await upsertBudget(valid, { fetchImpl: fetchImpl as any, getToken: async () => 'tok' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain(`/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets/monthly-prod`);
    expect(init.method).toBe('PUT');
    expect(init.headers.authorization).toBe('Bearer tok');
  });
  it('throws BudgetWriteError(400) on invalid input before any fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(upsertBudget({ ...valid, amount: -1 }, { fetchImpl: fetchImpl as any, getToken: async () => 't' }))
      .rejects.toBeInstanceOf(BudgetWriteError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('surfaces a 403 as BudgetWriteError with status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(upsertBudget(valid, { fetchImpl: fetchImpl as any, getToken: async () => 't' }))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe('deleteBudget', () => {
  it('DELETEs and tolerates 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    await expect(deleteBudget(SUB, 'monthly-prod', undefined, { fetchImpl: fetchImpl as any, getToken: async () => 't' }))
      .resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
  });
  it('rejects a bad subscription id', async () => {
    await expect(deleteBudget('nope', 'x', undefined, { fetchImpl: vi.fn() as any, getToken: async () => 't' }))
      .rejects.toBeInstanceOf(BudgetWriteError);
  });
});

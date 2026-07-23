/**
 * budgets-client — C4 (loom-next-level): REAL create/update/delete of Azure
 * budgets via the Consumption Budgets ARM provider
 * (`Microsoft.Consumption/budgets`, api-version 2023-05-01).
 *
 * `cost-client.listBudgets` is read-only; this module adds the write side the
 * C4 FinOps hub's Budgets CRUD needs. Sovereign-cloud aware (ARM host/scope
 * from cloud-endpoints — Commercial / GCC-High `.us` / IL5). Uses the shared
 * UAMI ARM credential (I5 carve-out: pure ARM-plane modules use
 * `uamiArmCredential`, never a per-workspace / directly-constructed credential).
 *
 * Validation is pure + unit-tested; the ARM calls take injectable fetch/token
 * seams so the write paths are exercised against a mock ARM in vitest (the live
 * CRUD round-trip is the C4 G1 receipt).
 */
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { armBase, armScope } from './cloud-endpoints';

export const BUDGETS_API = '2023-05-01';

export type BudgetTimeGrain = 'Monthly' | 'Quarterly' | 'Annually';

/** The admin-supplied budget definition (validated before any ARM call). */
export interface BudgetInput {
  /** Budget name (ARM resource name — letters/digits/_-. up to 63 chars). */
  name: string;
  /** Subscription id the budget lives in (scope = /subscriptions/<sub>[/resourceGroups/<rg>]). */
  subscription: string;
  /** Optional resource-group scope (RG-scoped budget). */
  resourceGroup?: string;
  /** The spend ceiling (billing currency). */
  amount: number;
  timeGrain: BudgetTimeGrain;
  /** ISO start (first of the period); ARM requires it aligned to the grain. */
  startDate: string;
  /** ISO end (far-future default). */
  endDate?: string;
  /** Alert thresholds (percent of amount, 0–1000) that email the contacts. */
  thresholds?: number[];
  /** Emails notified when a threshold trips. */
  contactEmails?: string[];
}

export interface BudgetDeps {
  fetchImpl?: typeof fetch;
  getToken?: (scope: string) => Promise<string>;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,63}$/;
const SUB_RE = /^[0-9a-f-]{36}$/i;

/** PURE — validate a budget input; returns an error string, or null when ok. */
export function validateBudgetInput(input: Partial<BudgetInput> | undefined | null): string | null {
  if (!input) return 'budget input required';
  if (!input.name || !NAME_RE.test(input.name)) return 'name must be 1–63 chars of letters, digits, or _ . -';
  if (!input.subscription || !SUB_RE.test(input.subscription)) return 'a valid subscription id is required';
  if (input.resourceGroup && !/^[A-Za-z0-9._()-]{1,90}$/.test(input.resourceGroup)) return 'resourceGroup is not a valid RG name';
  if (!(Number(input.amount) > 0)) return 'amount must be a positive number';
  if (!['Monthly', 'Quarterly', 'Annually'].includes(String(input.timeGrain))) return 'timeGrain must be Monthly, Quarterly, or Annually';
  if (!input.startDate || Number.isNaN(Date.parse(input.startDate))) return 'startDate must be a valid ISO date';
  if (input.endDate && Number.isNaN(Date.parse(input.endDate))) return 'endDate must be a valid ISO date';
  for (const t of input.thresholds || []) {
    if (!(Number(t) > 0) || Number(t) > 1000) return 'each threshold must be a percent between 0 and 1000';
  }
  for (const e of input.contactEmails || []) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e))) return `invalid contact email: ${e}`;
  }
  return null;
}

/** Build the ARM scope path for a budget (subscription or RG scoped). */
export function budgetScope(subscription: string, resourceGroup?: string): string {
  const base = `/subscriptions/${subscription}`;
  return resourceGroup ? `${base}/resourceGroups/${resourceGroup}` : base;
}

/** PURE — the Consumption budget properties body from a validated input. */
export function buildBudgetBody(input: BudgetInput): Record<string, unknown> {
  const thresholds = (input.thresholds && input.thresholds.length ? input.thresholds : [80, 100]).slice(0, 5);
  const notifications: Record<string, unknown> = {};
  for (const t of thresholds) {
    notifications[`Actual_GreaterThan_${t}_Percent`] = {
      enabled: true,
      operator: 'GreaterThan',
      threshold: t,
      thresholdType: 'Actual',
      contactEmails: input.contactEmails || [],
      contactRoles: ['Owner'],
    };
  }
  // A forecasted-100% alert catches an overrun before it happens.
  notifications['Forecasted_GreaterThan_100_Percent'] = {
    enabled: true,
    operator: 'GreaterThan',
    threshold: 100,
    thresholdType: 'Forecasted',
    contactEmails: input.contactEmails || [],
    contactRoles: ['Owner'],
  };
  return {
    properties: {
      category: 'Cost',
      amount: input.amount,
      timeGrain: input.timeGrain,
      timePeriod: {
        startDate: input.startDate,
        endDate: input.endDate || '2100-12-31T00:00:00Z',
      },
      notifications,
    },
  };
}

let cachedCredential: { getToken(scope: string): Promise<{ token?: string } | null> } | null = null;
function credential() {
  if (!cachedCredential) cachedCredential = uamiArmCredential();
  return cachedCredential;
}
async function defaultGetToken(scope: string): Promise<string> {
  const t = await credential().getToken(scope);
  if (!t?.token) throw new Error(`failed to acquire ARM token for ${scope}`);
  return t.token;
}

export class BudgetWriteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'BudgetWriteError';
  }
}

/** Create or update a budget (ARM PUT is upsert). Returns the ARM resource. */
export async function upsertBudget(input: BudgetInput, deps: BudgetDeps = {}): Promise<any> {
  const err = validateBudgetInput(input);
  if (err) throw new BudgetWriteError(err, 400);
  const fetchImpl = deps.fetchImpl ?? ((u: any, i?: any) => fetchWithTimeout(u, i));
  const getToken = deps.getToken ?? defaultGetToken;
  const token = await getToken(armScope());
  const url = `${armBase()}${budgetScope(input.subscription, input.resourceGroup)}/providers/Microsoft.Consumption/budgets/${encodeURIComponent(input.name)}?api-version=${BUDGETS_API}`;
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildBudgetBody(input)),
    cache: 'no-store',
  } as RequestInit);
  if (!res.ok) {
    throw new BudgetWriteError(`budget PUT ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }
  return res.json().catch(() => ({}));
}

/** Delete a budget. Idempotent (a 204/404 both resolve). */
export async function deleteBudget(
  subscription: string,
  name: string,
  resourceGroup: string | undefined,
  deps: BudgetDeps = {},
): Promise<void> {
  if (!SUB_RE.test(subscription)) throw new BudgetWriteError('a valid subscription id is required', 400);
  if (!NAME_RE.test(name)) throw new BudgetWriteError('invalid budget name', 400);
  const fetchImpl = deps.fetchImpl ?? ((u: any, i?: any) => fetchWithTimeout(u, i));
  const getToken = deps.getToken ?? defaultGetToken;
  const token = await getToken(armScope());
  const url = `${armBase()}${budgetScope(subscription, resourceGroup)}/providers/Microsoft.Consumption/budgets/${encodeURIComponent(name)}?api-version=${BUDGETS_API}`;
  const res = await fetchImpl(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  } as RequestInit);
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    throw new BudgetWriteError(`budget DELETE ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }
}

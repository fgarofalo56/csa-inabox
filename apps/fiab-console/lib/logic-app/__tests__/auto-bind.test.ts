/**
 * Auto-bind tests — the behaviours `.claude/rules/auto-bind-by-default.md`
 * requires: the platform creates and binds the backing Azure object itself,
 * names it identically to the Loom item, and self-heals a broken binding.
 *
 * The ARM layer is mocked at the `callLogicArm` boundary (the single function
 * every ARM call in this path goes through), so these tests assert the REAL
 * request shape — method, URL, api-version, and body — that would hit Azure.
 * Mutation-proved (see PR body).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const callLogicArm = vi.fn();

vi.mock('@/lib/install/provisioners/logic-app', () => ({
  callLogicArm: (...a: unknown[]) => callLogicArm(...a),
  LOGIC_API: '2016-06-01',
  logicAppArmMissing: () => {
    const missing: string[] = [];
    if (!(process.env.LOOM_LOGIC_SUB || process.env.LOOM_SUBSCRIPTION_ID)) missing.push('LOOM_LOGIC_SUB (or LOOM_SUBSCRIPTION_ID)');
    if (!(process.env.LOOM_LOGIC_RG || process.env.LOOM_DLZ_RG || process.env.LOOM_ADMIN_RG)) missing.push('LOOM_LOGIC_RG (or LOOM_DLZ_RG / LOOM_ADMIN_RG)');
    if (!(process.env.LOOM_LOGIC_LOCATION || process.env.LOOM_LOCATION)) missing.push('LOOM_LOGIC_LOCATION (or LOOM_LOCATION)');
    return missing;
  },
  readLogicAppArmConfig: () => {
    const rg = process.env.LOOM_LOGIC_RG || process.env.LOOM_DLZ_RG || process.env.LOOM_ADMIN_RG || '';
    const admin = process.env.LOOM_ADMIN_RG || '';
    return {
      subscriptionId: process.env.LOOM_LOGIC_SUB || process.env.LOOM_SUBSCRIPTION_ID || '',
      resourceGroup: rg,
      location: process.env.LOOM_LOGIC_LOCATION || process.env.LOOM_LOCATION || '',
      fallbackResourceGroup: admin && admin !== rg ? admin : '',
    };
  },
}));

vi.mock('@/lib/azure/cloud-endpoints', () => ({
  armBase: () => 'https://management.azure.com',
  LOGIC_APP_WORKFLOW_SCHEMA:
    'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
}));

import {
  ensureLogicAppBinding,
  workflowNameForItem,
  readStoredBinding,
  bindingPatch,
  bindingIsCurrent,
} from '../auto-bind';

const ENV = { ...process.env };

function res(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ITEM = { id: 'abc123', displayName: 'Order Sync', state: {} };

beforeEach(() => {
  callLogicArm.mockReset();
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-loom';
  process.env.LOOM_LOCATION = 'eastus2';
  delete process.env.LOOM_LOGIC_SUB;
  delete process.env.LOOM_LOGIC_RG;
  delete process.env.LOOM_LOGIC_LOCATION;
  delete process.env.LOOM_ADMIN_RG;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('workflowNameForItem — named identically to the Loom item', () => {
  it('uses the display name verbatim when it is already Azure-legal', () => {
    expect(workflowNameForItem({ id: 'x', displayName: 'order-sync' })).toBe('order-sync');
  });

  it('substitutes only the characters Azure rejects', () => {
    expect(workflowNameForItem({ id: 'x', displayName: 'Order Sync' })).toBe('Order-Sync');
    expect(workflowNameForItem({ id: 'x', displayName: 'a/b:c' })).toBe('a-b-c');
  });

  it('collapses runs and trims edge dashes', () => {
    expect(workflowNameForItem({ id: 'x', displayName: '  Order   Sync  ' })).toBe('Order-Sync');
  });

  it('falls back to the item id when the name sanitizes to nothing', () => {
    expect(workflowNameForItem({ id: 'abc', displayName: '日本語' })).toBe('loom-workflow-abc');
  });

  it('strips the synthetic loom: id prefix in the fallback', () => {
    expect(workflowNameForItem({ id: 'loom:xyz', displayName: '' })).toBe('loom-workflow-xyz');
  });

  it('caps at 80 characters', () => {
    expect(workflowNameForItem({ id: 'x', displayName: 'a'.repeat(200) })).toHaveLength(80);
  });
});

describe('ensureLogicAppBinding — creates the backing object with no user action', () => {
  it('creates and binds a workflow when the item has never been bound', async () => {
    callLogicArm
      .mockResolvedValueOnce(res(404))                                   // GET → not there
      .mockResolvedValueOnce(res(201, { id: '/subs/…', properties: { definition: { triggers: {} } } })); // PUT

    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.binding.workflowName).toBe('Order-Sync');
    expect(r.binding.resourceGroup).toBe('rg-loom');
    expect(r.binding.subscriptionId).toBe('sub-1');

    const [url, init] = callLogicArm.mock.calls[1];
    expect(init.method).toBe('PUT');
    expect(url).toContain('/subscriptions/sub-1/resourceGroups/rg-loom/providers/Microsoft.Logic/workflows/Order-Sync');
    expect(url).toContain('api-version=2016-06-01');
    const body = JSON.parse(init.body);
    expect(body.location).toBe('eastus2');
    expect(body.properties.state).toBe('Enabled');
    expect(body.tags['loom-managed']).toBe('true');
  });

  it('returns a statePatch the caller persists so the binding sticks', async () => {
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(201, {}));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.statePatch).toMatchObject({
      logicAppBinding: { workflowName: 'Order-Sync', resourceGroup: 'rg-loom', subscriptionId: 'sub-1' },
      logicAppName: 'Order-Sync',
    });
  });

  it('does NOT re-create when the workflow already exists (idempotent open)', async () => {
    callLogicArm.mockResolvedValueOnce(res(200, { properties: { definition: { triggers: { T: {} } } } }));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(false);
    expect(r.definition).toEqual({ triggers: { T: {} } });
    expect(callLogicArm).toHaveBeenCalledTimes(1); // GET only — no PUT
  });

  it('seeds the CREATE with the supplied definition', async () => {
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(201, {}));
    const seed = { triggers: { Recurrence: { type: 'Recurrence' } }, actions: {} };
    await ensureLogicAppBinding(ITEM, seed);
    const body = JSON.parse(callLogicArm.mock.calls[1][1].body);
    expect(body.properties.definition).toEqual(seed);
  });

  it('seeds an EMPTY but valid definition when none is supplied', async () => {
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(201, {}));
    await ensureLogicAppBinding(ITEM);
    const body = JSON.parse(callLogicArm.mock.calls[1][1].body);
    expect(body.properties.definition.$schema).toContain('workflowdefinition.json');
    expect(body.properties.definition.triggers).toEqual({});
  });
});

describe('ensureLogicAppBinding — self-healing', () => {
  it('recreates a workflow that was deleted in Azure (stamped binding, ARM 404)', async () => {
    const bound = { ...ITEM, state: { logicAppBinding: { subscriptionId: 'sub-1', resourceGroup: 'rg-loom', workflowName: 'Order-Sync' } } };
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(201, {}));
    const r = await ensureLogicAppBinding(bound);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.binding.workflowName).toBe('Order-Sync');
  });

  it('re-targets a binding stamped against a stale subscription/RG', async () => {
    const stale = {
      ...ITEM,
      state: { logicAppBinding: { subscriptionId: 'OLD-SUB', resourceGroup: 'OLD-RG', workflowName: 'Order-Sync' } },
    };
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(201, {}));
    const r = await ensureLogicAppBinding(stale);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.subscriptionId).toBe('sub-1');
    expect(r.binding.resourceGroup).toBe('rg-loom');
    expect(callLogicArm.mock.calls[0][0]).toContain('/subscriptions/sub-1/resourceGroups/rg-loom/');
    expect(callLogicArm.mock.calls[0][0]).not.toContain('OLD-SUB');
  });

  it('keeps the ALREADY-BOUND workflow name when the item is renamed', async () => {
    const renamed = {
      id: 'abc123',
      displayName: 'Totally New Name',
      state: { logicAppBinding: { subscriptionId: 'sub-1', resourceGroup: 'rg-loom', workflowName: 'Order-Sync' } },
    };
    callLogicArm.mockResolvedValueOnce(res(200, { properties: { definition: {} } }));
    const r = await ensureLogicAppBinding(renamed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Renaming the Loom item must not orphan a live workflow with run history.
    expect(r.binding.workflowName).toBe('Order-Sync');
  });

  it('adopts the legacy state.logicAppName binding shape', async () => {
    const legacy = { ...ITEM, state: { logicAppName: 'legacy-wf' } };
    callLogicArm.mockResolvedValueOnce(res(200, { properties: { definition: {} } }));
    const r = await ensureLogicAppBinding(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.workflowName).toBe('legacy-wf');
  });

  it('adopts the installer secondaryIds binding shape', async () => {
    const installed = {
      ...ITEM,
      state: { provisioning: { secondaryIds: { workflowName: 'bundle-wf', subscriptionId: 'sub-1', resourceGroup: 'rg-loom' } } },
    };
    callLogicArm.mockResolvedValueOnce(res(200, { properties: { definition: {} } }));
    const r = await ensureLogicAppBinding(installed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.workflowName).toBe('bundle-wf');
  });

  it('still creates when the GET throws (ARM transiently unreachable)', async () => {
    callLogicArm.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(res(201, {}));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(true);
  });
});

describe('ensureLogicAppBinding — honest gates (never a fake success)', () => {
  it('gates when the deployment has no Logic Apps coordinates, naming the vars', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_DLZ_RG;
    delete process.env.LOOM_LOCATION;
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.remediation).toContain('LOOM_LOGIC_SUB');
    expect(r.gate.remediation).toContain('LOOM_LOGIC_RG');
    expect(r.gate.remediation).toContain('LOOM_LOGIC_LOCATION');
    expect(callLogicArm).not.toHaveBeenCalled();
  });

  it('names LOOM_LOCATION (the variable the platform actually sets), not LOOM_AZURE_LOCATION', async () => {
    delete process.env.LOOM_LOCATION;
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.remediation).toContain('LOOM_LOCATION');
    expect(r.gate.remediation).not.toContain('LOOM_AZURE_LOCATION');
  });

  it('gates with the role remediation on a 403 GET', async () => {
    callLogicArm.mockResolvedValueOnce(res(403));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.remediation).toContain('Logic App Contributor');
    expect(r.gate.remediation).toContain('rg-loom');
  });

  it('gates with the role remediation on a 403 PUT', async () => {
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(403));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.remediation).toContain('Logic App Contributor');
  });

  it('surfaces the real ARM error text on an unexpected failure', async () => {
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(400, { error: { message: 'InvalidWorkflowName' } }));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.remediation).toContain('InvalidWorkflowName');
  });

  it('respects an explicit LOOM_LOGIC_* override over the shared vars', async () => {
    process.env.LOOM_LOGIC_SUB = 'other-sub';
    process.env.LOOM_LOGIC_RG = 'other-rg';
    process.env.LOOM_LOGIC_LOCATION = 'westus3';
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(201, {}));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.subscriptionId).toBe('other-sub');
    expect(r.binding.resourceGroup).toBe('other-rg');
    expect(JSON.parse(callLogicArm.mock.calls[1][1].body).location).toBe('westus3');
  });
});

describe('gate kind discriminant — decides whether the user gets a Fix-it', () => {
  // The editor renders <HonestGate> (inline Fix-it wizard) ONLY for
  // 'not-configured'. If the config gate lost its code, an env problem the
  // platform CAN fix would degrade to a dead-end MessageBar (G2 violation);
  // if an RBAC gate gained it, the user would get a Fix-it wizard that writes
  // env and cannot possibly grant a role.
  it('a missing-coordinates gate is not-configured and lists the missing vars', async () => {
    delete process.env.LOOM_LOCATION;
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.code).toBe('not-configured');
    expect(r.gate.missing?.some((m) => m.includes('LOOM_LOCATION'))).toBe(true);
  });

  it('a 403 is not-authorized (an env Fix-it cannot grant a role)', async () => {
    callLogicArm.mockResolvedValueOnce(res(403));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.code).toBe('not-authorized');
  });

  it('an unexpected ARM failure is arm-error', async () => {
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(400, { error: { message: 'bad' } }));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.code).toBe('arm-error');
  });
});

describe('self-heal #2 — the configured resource group does not exist', () => {
  // Found on the LIVE commercial estate: LOOM_DLZ_RG named an RG that was never
  // created, so the very first create 404'd ResourceGroupNotFound and the user
  // hit a dead end. auto-bind-by-default.md makes that ours to fix.
  const RG_MISSING = { error: { code: 'ResourceGroupNotFound', message: "Resource group 'rg-ghost' could not be found." } };

  beforeEach(() => {
    process.env.LOOM_DLZ_RG = 'rg-ghost';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
  });

  it('retries against the admin RG and binds there', async () => {
    callLogicArm
      .mockResolvedValueOnce(res(404))                 // GET → not there
      .mockResolvedValueOnce(res(404, RG_MISSING))     // PUT into the ghost RG
      .mockResolvedValueOnce(res(201, {}));            // PUT into the admin RG
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.binding.resourceGroup).toBe('rg-admin');
    expect(callLogicArm.mock.calls[2][0]).toContain('/resourceGroups/rg-admin/');
    // The persisted binding must point at where the workflow ACTUALLY landed,
    // otherwise the next open re-creates it instead of finding it.
    expect(r.statePatch).toMatchObject({ logicAppBinding: { resourceGroup: 'rg-admin' } });
  });

  it('does NOT retry on a 404 that is not ResourceGroupNotFound', async () => {
    callLogicArm
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(404, { error: { code: 'SubscriptionNotFound' } }));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(callLogicArm).toHaveBeenCalledTimes(2);
    expect(r.gate.remediation).toContain('SubscriptionNotFound');
  });

  it('does not retry when there is no DISTINCT fallback RG', async () => {
    process.env.LOOM_ADMIN_RG = 'rg-ghost'; // same as the primary
    callLogicArm.mockResolvedValueOnce(res(404)).mockResolvedValueOnce(res(404, RG_MISSING));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    expect(callLogicArm).toHaveBeenCalledTimes(2);
  });

  it('reports the RG it actually tried last in the failure remediation', async () => {
    callLogicArm
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(404, RG_MISSING))
      .mockResolvedValueOnce(res(409, { error: { message: 'nope' } }));
    const r = await ensureLogicAppBinding(ITEM);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gate.remediation).toContain('rg-admin');
  });
});

describe('binding state helpers', () => {
  it('readStoredBinding prefers the new shape over the legacy field', () => {
    const b = readStoredBinding({
      logicAppBinding: { workflowName: 'new', subscriptionId: 's', resourceGroup: 'r' },
      logicAppName: 'old',
    });
    expect(b.workflowName).toBe('new');
  });

  it('bindingPatch preserves unrelated state', () => {
    const patched = bindingPatch(
      { subscriptionId: 's', resourceGroup: 'r', workflowName: 'w' },
      { definition: { triggers: {} }, somethingElse: 1 },
    );
    expect(patched.definition).toEqual({ triggers: {} });
    expect(patched.somethingElse).toBe(1);
    expect(patched.logicAppName).toBe('w');
  });

  it('bindingIsCurrent detects drift', () => {
    const binding = { subscriptionId: 's', resourceGroup: 'r', workflowName: 'w' };
    expect(bindingIsCurrent({ logicAppBinding: binding }, binding)).toBe(true);
    expect(bindingIsCurrent({ logicAppBinding: { ...binding, resourceGroup: 'other' } }, binding)).toBe(false);
    expect(bindingIsCurrent({}, binding)).toBe(false);
  });
});

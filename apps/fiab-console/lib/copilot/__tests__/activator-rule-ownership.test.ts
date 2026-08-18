/**
 * PR #3693 review, B2 — a Copilot-authored alert rule must be OWNED by a Loom
 * item, or it must not exist.
 *
 * THE DEFECT THIS PINS. `activator_create_rule` built its `MonitorRuleInput`
 * without `loomItemId`, and `createMonitorActivatorRule` stamps the ownership tag
 * conditionally on exactly that field (lib/azure/activator-monitor.ts:
 * `const loomTags = input.loomItemId ? {...} : undefined`). So every rule the
 * Copilot created was UNTAGGED. `ruleBelongsToItem` then falls through to the
 * name join and — per its own docstring — fails CLOSED, leaving the rule
 * unclaimed. The result is a real Microsoft.Insights/scheduledQueryRule that
 * bills, fires, and pages someone, which no activator lists and nobody can pause
 * or delete from Loom: the same lost-record class as #3551, which this PR exists
 * to fix, re-created on the Copilot path.
 *
 * WHY THE ID IS VERIFIED AND NOT TAKEN ON TRUST. The id reaches the model inside
 * `personaContext`, which the BROWSER composes
 * (lib/editors/phase3/activator-editor.tsx → `activatorId`;
 * phase4/operations-agent-editor.tsx → `itemId`). A tag written from an
 * unverified id would plant a rule in someone else's activator, where the #3551
 * reconcile claims it and DELETE/PATCH act on it — the "plausible, not
 * authoritative" join key this PR removed from the reconcile, re-introduced from
 * the write side. `loadOwnedItem` is WRITE-scoped by default, and it is the only
 * thing that can produce the tag.
 *
 * The LAST describe closes the loop with the REAL `ruleBelongsToItem` against the
 * REAL ARM body this tool sends — a tag that the actual consumer does not accept
 * would be decoration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

/** Items the caller can WRITE (what `loadOwnedItem` returns). */
let writable: any[] = [];
/** Items the caller can SEE (what `listOwnedItems` returns — includes read-only). */
let visible: any[] = [];
/** Non-null → the Cosmos layer is down. */
let itemStoreThrows: any = null;

const loadOwnedItem = vi.fn(async (id: string, itemType: string) => {
  if (itemStoreThrows) throw itemStoreThrows;
  return writable.find((i) => i.id === id && i.itemType === itemType) || null;
});
const listOwnedItems = vi.fn(async (itemType: string, _oid: string, opts: any = {}) => {
  if (itemStoreThrows) throw itemStoreThrows;
  return visible.filter((i) => i.itemType === itemType && (!opts.workspaceId || i.workspaceId === opts.workspaceId));
});
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => (loadOwnedItem as any)(...a),
  listOwnedItems: (...a: any[]) => (listOwnedItems as any)(...a),
}));

import { ruleBelongsToItem, expectedAzureRuleName } from '@/lib/azure/activator-monitor';

const ACTIVATOR = { id: 'act-1', workspaceId: 'ws-1', itemType: 'activator', displayName: 'Model Drift Alert' };
const OPS_AGENT = { id: 'ops-1', workspaceId: 'ws-1', itemType: 'operations-agent', displayName: 'Line 4 Ops Agent' };
/** A DIFFERENT tenant's activator — the thing an unverified tag would reach. */
const SOMEONE_ELSES = { id: 'act-OTHER', workspaceId: 'ws-9', itemType: 'activator', displayName: 'Payroll Alerts' };

const ctx = { userOid: 'u-1', session: { claims: { oid: 'u-1' } } } as any;

const BASE = {
  name: 'failed-logins',
  sourceTable: 'SigninLogs',
  summarizeExpr: 'count()',
  metricColumn: 'failedSignIns',
  threshold: 12,
  confirm: true,
};

let armCalls: Array<{ url: string; init?: RequestInit }> = [];
function stubArm() {
  armCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    armCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      id: '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/microsoft.insights/scheduledQueryRules/x',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}
/** The ARM PUT that creates the scheduledQueryRule, or undefined. */
const rulePut = () =>
  armCalls.find((c) => c.init?.method === 'PUT' && c.url.includes('/scheduledQueryRules/'));
const rulePutBody = () => JSON.parse(String(rulePut()!.init!.body));

async function createRule(args: Record<string, unknown>) {
  const { buildActivatorTools } = await import('../activator-tools');
  const tool = buildActivatorTools().find((t) => t.name === 'activator_create_rule')!;
  return tool.handler({ ...BASE, ...args }, ctx) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  writable = [ACTIVATOR, OPS_AGENT];
  visible = [ACTIVATOR, OPS_AGENT];
  itemStoreThrows = null;
  stubArm();
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_ALERT_RG = 'rg-alerts';
  process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID =
    '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.OperationalInsights/workspaces/law';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

// ---------------------------------------------------------------------------
describe('B2 — the created rule carries its owning Loom item id', () => {
  // MUTATION B2-a: drop `loomItemId: owner.item.id` from the MonitorRuleInput
  //   (i.e. revert to the shape the tool shipped with).
  // → observed: 5 RED — 4 here (the ARM PUT goes out with NO `tags` block at
  //   all) plus 1 in the sibling activator-tools.test.ts. Worth naming what did
  //   NOT move: "ruleBelongsToItem claims the rule for its activator" stays
  //   GREEN, because the derived-name join still holds while the display name is
  //   unchanged. That is precisely why the LAST spec pins the RENAME — the name
  //   join is the fragile one, and it is the only thing an untagged rule has.
  it('stamps loom-item-id / loom-item-type on the ARM PUT', async () => {
    const out = await createRule({ activatorItemId: 'act-1' });

    expect(out.ok).toBe(true);
    const body = rulePutBody();
    expect(body.tags['loom-item-id']).toBe('act-1');
    expect(body.tags['loom-item-type']).toBe('activator');
    expect(out.loomItemId).toBe('act-1');
  });

  it('accepts the Operations Agent editor context field name (itemId)', async () => {
    // phase4/operations-agent-editor.tsx sends `itemId`, not `activatorId`, and
    // drives this SAME tool through the operations-agent persona.
    const out = await createRule({ itemId: 'ops-1', activatorName: 'Line 4 Ops Agent' });

    expect(out.ok).toBe(true);
    expect(rulePutBody().tags['loom-item-id']).toBe('ops-1');
  });

  it('derives the ARM rule name from the RESOLVED display name, not the model string', async () => {
    // The derived name is the reconcile's SECOND join key
    // (expectedAzureRuleName(displayName, ruleName)), so a rule named off a
    // paraphrase the model produced would not join back even with the tag gone.
    const out = await createRule({ activatorItemId: 'act-1', activatorName: 'the drift alert reflex' });

    expect(out.azureRuleName).toBe(expectedAzureRuleName(ACTIVATOR.displayName, 'failed-logins'));
    expect(out.activatorName).toBe(ACTIVATOR.displayName);
  });

  it('resolves the owner from an EXACT, UNIQUE display name when no id was passed', async () => {
    const out = await createRule({ activatorName: 'model drift alert', workspaceId: 'ws-1' });

    expect(out.ok).toBe(true);
    expect(rulePutBody().tags['loom-item-id']).toBe('act-1');
  });
});

// ---------------------------------------------------------------------------
describe('B2 — an unownable rule is NOT created', () => {
  // MUTATION B2-b: replace the `if (!owner.item) return { needsItemBinding }`
  //   refusal with `loomItemId: owner.item?.id` and let the create proceed.
  // → observed: 5 RED — every case in this describe provisions a REAL
  //   scheduledQueryRule that no Loom item owns, which is the defect restated as
  //   a feature.
  it('no id and no name → nothing is provisioned', async () => {
    const out = await createRule({});

    expect(out.ok).toBe(false);
    expect(out.needsItemBinding).toBe(true);
    expect(armCalls).toHaveLength(0);
  });

  it('an id that does not resolve is NOT used as the tag — and nothing is provisioned', async () => {
    // The id is caller-composed (personaContext comes from the browser). This is
    // the case that would otherwise plant a rule in another tenant's activator.
    writable = [ACTIVATOR];
    visible = [ACTIVATOR];

    const out = await createRule({ activatorItemId: SOMEONE_ELSES.id });

    expect(out.ok).toBe(false);
    expect(out.needsItemBinding).toBe(true);
    expect(armCalls).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain(`"loomItemId":"${SOMEONE_ELSES.id}"`);
  });

  it('an AMBIGUOUS display name is refused, not guessed', async () => {
    const twin = { ...ACTIVATOR, id: 'act-2' };
    writable = [ACTIVATOR, twin];
    visible = [ACTIVATOR, twin];

    const out = await createRule({ activatorName: 'Model Drift Alert' });

    expect(out.ok).toBe(false);
    expect(out.needsItemBinding).toBe(true);
    expect(out.message).toMatch(/named/i);
    expect(armCalls).toHaveLength(0);
  });

  it('a READ-ONLY caller cannot tag a rule onto an activator they can only see', async () => {
    // `listOwnedItems` admits any workspace role; `loadOwnedItem` is write-scoped.
    // The tag authorizes later writes through the reconcile, so it must come from
    // the write ladder — otherwise a Viewer injects rules into an activator.
    visible = [ACTIVATOR];
    writable = [];

    const out = await createRule({ activatorName: 'Model Drift Alert' });

    expect(out.ok).toBe(false);
    expect(out.needsItemBinding).toBe(true);
    expect(out.message).toMatch(/write access/i);
    expect(armCalls).toHaveLength(0);
  });

  it('the refusal is actionable — it names what to pass, and no rule was created', async () => {
    const out = await createRule({});

    expect(out.message).toContain('activatorItemId');
    expect(out.message).toMatch(/no alert rule was created/i);
  });
});

// ---------------------------------------------------------------------------
describe('B2 — fail-closed, but not fail-stupid', () => {
  // MUTATION B2-c: wrap the resolver's item-store calls in `.catch(() => null)`.
  // → observed: 1 RED — a Cosmos outage silently becomes "this activator does not
  //   exist", so the user is told their activator is unresolvable when the truth
  //   is that the lookup never ran (deploy-integrity.md R7).
  it('an item-store failure PROPAGATES instead of becoming "no such activator"', async () => {
    itemStoreThrows = new Error('Cosmos DB is not configured in this deployment. Missing: LOOM_COSMOS_ENDPOINT');

    const err = await createRule({ activatorItemId: 'act-1' }).then(() => null, (e: Error) => e);

    expect(String(err?.message)).toContain('LOOM_COSMOS_ENDPOINT');
    expect(armCalls).toHaveLength(0);
  });

  it('confirm=false still short-circuits before any lookup or ARM call', async () => {
    const out = await createRule({ activatorItemId: 'act-1', confirm: false });

    expect(out.needsConfirmation).toBe(true);
    expect(loadOwnedItem).not.toHaveBeenCalled();
    expect(armCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('B2 — the tag is one the REAL consumer accepts', () => {
  // The whole point of the tag is that `ruleBelongsToItem` — the join the #3551
  // reconcile uses to decide what an activator owns — returns true for the owner
  // and false for everyone else. Asserted against the REAL function and the REAL
  // ARM body this tool sent, so a tag with the wrong key or the wrong value
  // cannot pass.
  it('ruleBelongsToItem claims the rule for its activator, and refuses it for a sibling', async () => {
    await createRule({ activatorItemId: 'act-1' });

    const body = rulePutBody();
    const liveRule = {
      name: decodeURIComponent(String(rulePut()!.url.split('/scheduledQueryRules/')[1]).split('?')[0]),
      description: body.properties.description,
      tags: body.tags,
    };

    expect(ruleBelongsToItem(liveRule, ACTIVATOR)).toBe(true);
    expect(ruleBelongsToItem(liveRule, SOMEONE_ELSES)).toBe(false);
  });

  it('the tag — and ONLY the tag — survives a rename of the activator', async () => {
    // What the tag buys over the name join, stated as the difference between two
    // otherwise identical rules. `safeRuleName` derives the ARM name from the
    // display name, so a rename breaks the name join permanently — the rule keeps
    // firing and the editor stops listing it, which is #3551 exactly. The tag is
    // an identity, so it does not care.
    await createRule({ activatorItemId: 'act-1' });
    const body = rulePutBody();
    const armName = decodeURIComponent(String(rulePut()!.url.split('/scheduledQueryRules/')[1]).split('?')[0]);
    const tagged = { name: armName, description: body.properties.description, tags: body.tags };
    const untagged = { name: armName, description: body.properties.description, tags: undefined };
    const renamed = { ...ACTIVATOR, displayName: 'Model Drift Alert (renamed)' };

    expect(ruleBelongsToItem(tagged, renamed)).toBe(true);
    expect(ruleBelongsToItem(untagged, renamed)).toBe(false);
    // Both still join under the ORIGINAL name — the name path is not broken,
    // it is merely fragile, which is why the tag is the primary key.
    expect(ruleBelongsToItem(untagged, ACTIVATOR)).toBe(true);
  });
});

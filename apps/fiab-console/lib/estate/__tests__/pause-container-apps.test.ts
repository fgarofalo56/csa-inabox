/**
 * Container Apps join the estate pause set by default (operator decision
 * 2026-10-22). Every `it` names, in its title or a comment, the input that
 * breaks it. Mutation runs for the load-bearing arms are recorded in the PR body.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyContainerApps,
  discoverContainerApps,
  type ArmContainerApp,
} from '../pause-container-apps';
import { NEVER_PAUSE_CONTAINER_APPS } from '../pause-guards';
import { orderForPause } from '../pause-tier';

const ESTATE = 'loom:abcd1234:rg-admin';
const SELF = 'loom-console';
const SUB = 'sub-1';
const RG = 'rg-admin';
const ON = { enabled: true, exempt: [] as string[] };

const app = (name: string, over: Partial<ArmContainerApp> & { min?: number; max?: number; tags?: Record<string, string> } = {}): ArmContainerApp => ({
  id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${name}`,
  name,
  location: 'centralus',
  tags: over.tags ?? { 'loom-estate-id': ESTATE },
  properties: { template: { scale: { minReplicas: over.min ?? 1, maxReplicas: over.max ?? 3 } } },
});

const classify = (apps: ArmContainerApp[], over: Partial<Parameters<typeof classifyContainerApps>[0]> = {}) =>
  classifyContainerApps({
    apps, policy: ON, settingUnreadable: false, estateId: ESTATE,
    subscriptionId: SUB, resourceGroup: RG, selfAppName: SELF, ...over,
  });

const stateOf = (r: ReturnType<typeof classify>, name: string) => r.rows.find((x) => x.name === name)?.state;
const pausedNames = (r: ReturnType<typeof classify>) => r.discovered.map((d) => d.name);

describe('default: every ordinary Container App joins the pause set', () => {
  // Breaks if: the default flips to opt-in (an app with no setting is not discovered) -> []
  it('an owned, min>=1 app is will-pause and is discovered as a containerapps resource with its range recorded', () => {
    const r = classify([app('loom-udf-runtime', { min: 1, max: 3 }), app('loom-dab-preview', { min: 2, max: 2 })]);
    expect(pausedNames(r)).toEqual(['loom-udf-runtime', 'loom-dab-preview']);
    expect(r.discovered[0]).toMatchObject({
      resourceType: 'microsoft.app/containerapps', subscriptionId: SUB, resourceGroup: RG, discoverySource: 'arm-rg-list',
    });
    expect(r.rows[0].reason).toContain('restored to exactly 1/3');
  });

  // Breaks if: the tag key match is case-sensitive and a differently-cased tag drops the app.
  it('the estate tag key is matched case-insensitively', () => {
    const r = classify([app('loom-udf-runtime', { tags: { 'Loom-Estate-Id': ESTATE } })]);
    expect(pausedNames(r)).toEqual(['loom-udf-runtime']);
  });
});

describe('the console is never pausable', () => {
  // Breaks if: containerAppPauseGuard is bypassed for listed apps -> loom-console lands in `discovered`.
  it.each([
    ['loom-console', SELF],
    ['ca-loom-console-eu', SELF],     // named like a console
    ['loom-brain', 'loom-brain'],     // not console-named; it IS this process
  ])('%s (self=%s) is held out and absent from the pause set', (name, self) => {
    const r = classify([app(name), app('loom-udf-runtime')], { selfAppName: self });
    expect(stateOf(r, name)).toBe('held-out');
    expect(pausedNames(r)).not.toContain(name);
    expect(pausedNames(r)).toContain('loom-udf-runtime'); // positive pair: the filter is not just "pause nothing"
  });

  // Breaks if: a loom-role=console tag stops being honoured on a name that does not say console.
  it('a loom-role=resume-surface tag holds an app out', () => {
    const r = classify([app('loom-resumer', { tags: { 'loom-estate-id': ESTATE, 'loom-role': 'resume-surface' } })]);
    expect(stateOf(r, 'loom-resumer')).toBe('held-out');
    expect(r.discovered).toHaveLength(0);
  });

  // Breaks if: an unset CONTAINER_APP_NAME is read as "not the console" -> everything is discovered.
  it('with the process identity unknown NO app is discovered (fail safe)', () => {
    const r = classify([app('loom-udf-runtime'), app('loom-console')], { selfAppName: undefined });
    expect(r.discovered).toHaveLength(0);
    expect(stateOf(r, 'loom-udf-runtime')).toBe('held-out');
  });
});

describe('the never-pause list is skipped', () => {
  // Breaks if: any one entry is dropped from NEVER_PAUSE_CONTAINER_APPS, or the guard stops consulting it.
  it.each(Object.keys(NEVER_PAUSE_CONTAINER_APPS))('%s is held out with its stated reason even with a perfect tag and min=1', (name) => {
    const r = classify([app(name)]);
    expect(stateOf(r, name)).toBe('held-out');
    expect(r.discovered).toHaveLength(0);
    expect(r.rows[0].reason).toMatch(/never-pause list because/);
  });

  // Breaks if: the lookup is case-sensitive and 'Loom-RisingWave' slips through.
  it('matches case-insensitively', () => {
    expect(stateOf(classify([app('Loom-RisingWave')]), 'Loom-RisingWave')).toBe('held-out');
  });

  // Breaks if: the list swallows its neighbours (a prefix match on 'loom-unity' would hold 'loom-unity-postgres' - not an app here - or 'loom-udf-runtime').
  it('an app that merely resembles a listed name is NOT held out', () => {
    const r = classify([app('loom-risingwave-sandbox')]);
    expect(stateOf(r, 'loom-risingwave-sandbox')).toBe('will-pause');
  });

  // The operator's 12 named always-on apps: those with measured data loss, a silent stop with nothing to wake them,
  // or an unproven wake against a 5s/30s user-path timeout are held out (see NEVER_PAUSE_CONTAINER_APPS).
  it('of the 12 apps the operator named apps exactly 8 are held out and the 4 remaining are pausable', () => {
    const named = ['loom-activator', 'loom-airflow', 'iceberg-catalog', 'loom-dab-preview', 'loom-directlake', 'loom-mcp',
      'loom-mcp-bridge', 'loom-mirroring', 'loom-risingwave', 'loom-transform-runner', 'loom-udf-runtime', 'loom-unity'];
    const r = classify(named.map((n) => app(n)));
    expect(r.rows.filter((x) => x.state === 'held-out').map((x) => x.name).sort()).toEqual([
      'iceberg-catalog', 'loom-activator', 'loom-airflow', 'loom-mcp', 'loom-mcp-bridge', 'loom-mirroring', 'loom-risingwave', 'loom-unity',
    ]);
    expect(pausedNames(r).sort()).toEqual(['loom-dab-preview', 'loom-directlake', 'loom-transform-runner', 'loom-udf-runtime']);
  });
});

describe('opt-outs are respected', () => {
  // Breaks if: `exempt` is ignored -> loom-dab-preview is discovered.
  it('a per-app exemption removes exactly that app and no other', () => {
    const apps = [app('loom-dab-preview'), app('loom-udf-runtime')];
    const without = classify(apps, { policy: { enabled: true, exempt: ['loom-dab-preview'] } });
    expect(stateOf(without, 'loom-dab-preview')).toBe('exempt');
    expect(pausedNames(without)).toEqual(['loom-udf-runtime']);
    // The same input minus the exemption pauses it: the exemption is what changed the outcome.
    expect(pausedNames(classify(apps))).toEqual(['loom-dab-preview', 'loom-udf-runtime']);
  });

  // Breaks if: exempt names are compared case-sensitively against ARM's name.
  it('exemption matches case-insensitively', () => {
    expect(stateOf(classify([app('Loom-Udf-Runtime')], { policy: { enabled: true, exempt: ['loom-udf-runtime'] } }), 'Loom-Udf-Runtime')).toBe('exempt');
  });

  // Breaks if: the global switch is ignored -> apps are discovered with enabled:false.
  it('the global opt-out leaves EVERY app running, each listed as opted-out', () => {
    const r = classify([app('loom-udf-runtime'), app('loom-dab-preview')], { policy: { enabled: false, exempt: [] } });
    expect(r.discovered).toHaveLength(0);
    expect(r.rows.map((x) => x.state)).toEqual(['opted-out', 'opted-out']);
  });

  // Breaks if: an unreadable setting falls back to the default (ON) and pauses apps that may have been exempted.
  it('an UNREADABLE setting pauses nothing (we cannot know what was exempted)', () => {
    const r = classify([app('loom-udf-runtime')], { settingUnreadable: true });
    expect(r.discovered).toHaveLength(0);
    expect(stateOf(r, 'loom-udf-runtime')).toBe('setting-unreadable');
  });
});

describe('only what can be established joins the set', () => {
  // Breaks if: ownership falls back to the RG name -> an untagged / foreign app is discovered.
  it('no estate tag, or another estate\'s tag -> not-owned and left running', () => {
    const r = classify([
      app('untagged', { tags: {} }),
      app('foreign', { tags: { 'loom-estate-id': 'loom:other:rg' } }),
      app('mine'),
    ]);
    expect(stateOf(r, 'untagged')).toBe('not-owned');
    expect(stateOf(r, 'foreign')).toBe('not-owned');
    expect(pausedNames(r)).toEqual(['mine']);
  });

  // Breaks if: min 0 apps are listed as "would pause" (a fabricated saving).
  it('an app already at minReplicas 0 is already-zero, not will-pause', () => {
    expect(stateOf(classify([app('loom-trino', { min: 0 })]), 'loom-trino')).toBe('already-zero');
  });

  // Breaks if: a missing range is guessed -> resume could not restore it exactly.
  it('an app that reports no scale range is scale-unknown and left running', () => {
    const a = app('loom-x');
    a.properties = { template: {} };
    const r = classify([a]);
    expect(stateOf(r, 'loom-x')).toBe('scale-unknown');
    expect(r.discovered).toHaveLength(0);
  });

  // Breaks if: an item with no id/name is addressed anyway.
  it('items without a name or id are skipped, not invented', () => {
    expect(classify([{ tags: { 'loom-estate-id': ESTATE } }, { name: 'x' }]).rows).toHaveLength(0);
  });
});

describe('discoverContainerApps', () => {
  const env = { LOOM_SUBSCRIPTION_ID: SUB, LOOM_ACA_RG: RG, CONTAINER_APP_NAME: SELF } as NodeJS.ProcessEnv;
  const run = (list: () => Promise<ArmContainerApp[]>, over: Partial<Parameters<typeof discoverContainerApps>[0]> = {}) =>
    discoverContainerApps({ policy: ON, settingUnreadable: false, estateId: ESTATE, env, list, ...over });

  it('lists the configured group and returns will-pause apps (the list was called with the real sub + rg)', async () => {
    const list = vi.fn(async () => [app('loom-udf-runtime'), app('loom-console')]);
    const out = await run(list);
    expect(list).toHaveBeenCalledWith(SUB, RG);
    expect(out.discovered.map((d) => d.name)).toEqual(['loom-udf-runtime']);
    expect(out.status).toMatchObject({ configured: true, resourceGroup: RG, listed: 2, willPause: 1 });
    expect(out.readFailures).toEqual([]);
  });

  // Breaks if: an AKS-platform deployment tries to list Container Apps (they do not exist there).
  it('a deployment on LOOM_CONTAINER_PLATFORM=aks is not configured and makes no ARM call', async () => {
    const list = vi.fn(async () => [app('loom-udf-runtime')]);
    const out = await run(list, { env: { ...env, LOOM_CONTAINER_PLATFORM: 'aks' } as NodeJS.ProcessEnv });
    expect(list).not.toHaveBeenCalled();
    expect(out.status.configured).toBe(false);
    expect(out.status.note).toMatch(/AKS/);
  });

  // Breaks if: a missing RG is treated as an empty group (silent "nothing to pause").
  it.each([['LOOM_SUBSCRIPTION_ID'], ['LOOM_ACA_RG']])('missing %s -> not configured, with the truth in `note`, no ARM call', async (key) => {
    const list = vi.fn(async () => []);
    const e = { ...env, [key]: '' } as NodeJS.ProcessEnv;
    const out = await run(list, { env: e });
    expect(list).not.toHaveBeenCalled();
    expect(out.status.configured).toBe(false);
    expect(out.status.note).toMatch(/LOOM_SUBSCRIPTION_ID/);
  });

  it('LOOM_ADMIN_RG is the fallback when LOOM_ACA_RG is unset', async () => {
    const list = vi.fn(async () => []);
    await run(list, { env: { LOOM_SUBSCRIPTION_ID: SUB, LOOM_ADMIN_RG: 'rg-fallback' } as NodeJS.ProcessEnv });
    expect(list).toHaveBeenCalledWith(SUB, 'rg-fallback');
  });

  // Breaks if: a throttled list is swallowed -> the pause proceeds on a set that was never established.
  it('a THROTTLED list becomes a read failure (the pause will refuse and say retry)', async () => {
    const out = await run(async () => { throw new Error('ARM GET x was throttled (429) after 3 attempts'); });
    expect(out.readFailures).toHaveLength(1);
    expect(out.readFailures[0]).toMatchObject({ kind: 'throttled', throttled: true });
    expect(out.discovered).toEqual([]);
    expect(out.status.listError).toMatch(/throttled/);
  });

  // Breaks if: any list failure blocks the data-service pause (permission error would freeze the whole cost saving).
  it('a non-throttle list failure leaves the apps out, is REPORTED, and does not block the rest of the pause', async () => {
    const out = await run(async () => { throw new Error('ARM GET x failed 403: forbidden'); });
    expect(out.readFailures).toEqual([]);
    expect(out.discovered).toEqual([]);
    expect(out.status.listError).toMatch(/403/);
    expect(out.status.note).toMatch(/could not be listed/);
  });

  // Breaks if: a throttle with Container Apps opted out still blocks the pause of everything.
  it('a throttled list does not block when Container Apps are opted out (nothing depends on it)', async () => {
    const out = await run(async () => { throw new Error('was throttled (429)'); }, { policy: { enabled: false, exempt: [] } });
    expect(out.readFailures).toEqual([]);
  });

  it('rows are sorted by name so the panel and the audit row are stable', async () => {
    const out = await run(async () => [app('z-app'), app('a-app'), app('m-app')]);
    expect(out.status.apps.map((a) => a.name)).toEqual(['a-app', 'm-app', 'z-app']);
  });
});

describe('orderForPause: consumers first, the exact reverse of resume', () => {
  // Breaks if: pause keeps discovery order and stops the database under a running app.
  it('container apps pause BEFORE data services, data services before the platform; ties keep input order', () => {
    const items = [
      { id: 'adx', resourceType: 'microsoft.kusto/clusters' },
      { id: 'aks', resourceType: 'microsoft.containerservice/managedclusters' },
      { id: 'app-b', resourceType: 'microsoft.app/containerapps' },
      { id: 'syn', resourceType: 'microsoft.synapse/workspaces/sqlpools' },
      { id: 'app-a', resourceType: 'microsoft.app/containerapps' },
    ];
    expect(orderForPause(items).map((i) => i.id)).toEqual(['app-b', 'app-a', 'adx', 'syn', 'aks']);
  });

  it('an unknown type ranks with the consumers (paused first), never ahead of resume-last data', () => {
    const items = [{ id: 'adx', resourceType: 'microsoft.kusto/clusters' }, { id: 'new', resourceType: 'microsoft.foo/bars' }];
    expect(orderForPause(items).map((i) => i.id)).toEqual(['new', 'adx']);
  });
});

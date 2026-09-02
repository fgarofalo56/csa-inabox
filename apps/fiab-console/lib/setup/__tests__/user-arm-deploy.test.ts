/**
 * Tests for the user-delegated (day-one) DLZ deploy path.
 *
 * Covers the PURE param/template mapping (dlz-attach + tenant, hub-coordinate →
 * attach-param translation, feature-toggle passthrough, private-DNS object
 * handling) and the LIVE ARM PUT/GET with a stubbed fetch + token — proving the
 * real subscription-scoped deployment submission (and the 403 honest-gate
 * scenario) without a live subscription.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Fault injection for `readFileSync`, PASS-THROUGH by default.
 *
 * `readFailure` is null for every pre-existing arm in this file, so they keep
 * reading the real committed artifact. Only the #4261 arms set it, and each
 * clears it via `afterEach`. A blanket `vi.mock('node:fs')` would have broken
 * the real-artifact arms above, which are the control that this resolver
 * actually understands the shipped template.
 */
const fault = vi.hoisted(() => ({ readFailure: null as null | (() => string) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: unknown[]) =>
      fault.readFailure
        ? fault.readFailure()
        : (actual.readFileSync as (...a: unknown[]) => unknown)(...args),
  };
});

/** Alias so the specs below read as `fail.readFailure = …`. */
const fail = fault;

import {
  buildDlzDeploymentParameters,
  resolveDlzTemplateSource,
  resolveDlzTemplateInline,
  resolveDlzTemplateInlineOutcome,
  resolveDlzTemplate,
  __resetInlineTemplateCache,
  submitDlzDeployment,
  readDlzDeploymentStatus,
  progressForState,
  DLZ_TEMPLATE_ENV,
} from '../user-arm-deploy';

const SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

afterEach(() => {
  delete process.env[DLZ_TEMPLATE_ENV];
  delete process.env.LOOM_DLZ_TEMPLATE_QUERY_STRING;
  fault.readFailure = null;
  __resetInlineTemplateCache();
  vi.restoreAllMocks();
});

describe('buildDlzDeploymentParameters — dlz-attach', () => {
  it('threads topology, target sub, attachDomainName, and hub coordinates as attach params', () => {
    const p = buildDlzDeploymentParameters({
      topology: 'dlz-attach',
      boundary: 'Commercial',
      location: 'eastus2',
      capacitySku: 'F512',
      domainName: 'va',
      targetSubscriptionId: SUB,
      hubCoords: {
        hubVnetId: '/subscriptions/x/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/hub',
        hubLawId: '/subscriptions/x/.../law',
        hubConsolePrincipalId: '41d32562-1111-2222-3333-444444444444',
        hubPrivateDnsZoneIds: { blob: '/subscriptions/x/.../privatelink.blob' },
      },
    });
    expect(p.topology.value).toBe('dlz-attach');
    expect(p.targetSubscriptionId.value).toBe(SUB);
    expect(p.attachDomainName.value).toBe('va');
    expect(p.dlzDomainNames.value).toEqual(['va']);
    expect(p.capacitySku.value).toBe('F512');
    expect(p.location.value).toBe('eastus2');
    // Hub-coordinate keys map to their bicep attach param names.
    expect(p.hubVnetId.value).toContain('virtualNetworks/hub');
    expect(p.hubLawId).toBeDefined();
    expect(p.hubConsolePrincipalId.value).toBe('41d32562-1111-2222-3333-444444444444');
    // Object-valued private-DNS map lands on hubPrivateDnsZoneIdsAttach.
    expect(p.hubPrivateDnsZoneIdsAttach.value).toEqual({ blob: '/subscriptions/x/.../privatelink.blob' });
  });

  it('omits an empty private-DNS object and unknown hub keys', () => {
    const p = buildDlzDeploymentParameters({
      topology: 'dlz-attach',
      boundary: 'Commercial',
      location: 'eastus2',
      capacitySku: 'F8',
      domainName: 'finance',
      targetSubscriptionId: SUB,
      hubCoords: { hubPrivateDnsZoneIds: {}, hubUnknownThing: 'x', hubVnetId: '' },
    });
    expect(p.hubPrivateDnsZoneIdsAttach).toBeUndefined();
    expect((p as Record<string, unknown>).hubUnknownThing).toBeUndefined();
    expect(p.hubVnetId).toBeUndefined(); // empty string skipped
  });

  it('forwards only explicitly-set feature toggles', () => {
    const p = buildDlzDeploymentParameters({
      topology: 'dlz-attach',
      boundary: 'Commercial',
      location: 'eastus2',
      capacitySku: 'F8',
      domainName: 'ops',
      targetSubscriptionId: SUB,
      featureToggles: { adxEnabled: true, databricksSqlWarehouseEnabled: false },
    });
    expect(p.adxEnabled.value).toBe(true);
    expect(p.databricksSqlWarehouseEnabled.value).toBe(false);
    expect(p.cosmosGraphVectorEnabled).toBeUndefined();
  });
});

describe('buildDlzDeploymentParameters — tenant', () => {
  it('emits deploymentMode + spoke arrays for multi-sub', () => {
    const p = buildDlzDeploymentParameters({
      topology: 'tenant',
      boundary: 'Commercial',
      location: 'eastus2',
      capacitySku: 'F64',
      domainName: 'primary',
      deploymentMode: 'multi-sub',
      dlzSubscriptionIds: [SUB],
      dlzDomainNames: ['primary', 'secondary'],
    });
    expect(p.deploymentMode.value).toBe('multi-sub');
    expect(p.dlzSubscriptionIds.value).toEqual([SUB]);
    expect(p.dlzDomainNames.value).toEqual(['primary', 'secondary']);
    expect(p.attachDomainName).toBeUndefined();
  });
});

describe('buildDlzDeploymentParameters — adopt bag (#3016)', () => {
  const bag = {
    purview: { mode: 'adopt', target: { name: 'pv-existing', rg: 'rg-data', sub: SUB } },
    aisearch: { mode: 'create' },
  };

  it('emits the adopt bag as the `adopt` ARM parameter on the tenant path', () => {
    const p = buildDlzDeploymentParameters({
      topology: 'tenant',
      boundary: 'Commercial',
      location: 'eastus2',
      capacitySku: 'F8',
      domainName: 'finance',
      adopt: bag,
    });
    expect(p.adopt).toEqual({ value: bag });
  });

  it('emits the adopt bag on the dlz-attach path too', () => {
    const p = buildDlzDeploymentParameters({
      topology: 'dlz-attach',
      boundary: 'Commercial',
      location: 'eastus2',
      capacitySku: 'F8',
      domainName: 'va',
      targetSubscriptionId: SUB,
      adopt: bag,
    });
    expect(p.adopt).toEqual({ value: bag });
  });

  it('emits NOTHING for an absent or empty bag (greenfield params unchanged)', () => {
    const base = {
      topology: 'tenant' as const,
      boundary: 'Commercial',
      location: 'eastus2',
      capacitySku: 'F8',
      domainName: 'finance',
    };
    expect(buildDlzDeploymentParameters(base).adopt).toBeUndefined();
    expect(buildDlzDeploymentParameters({ ...base, adopt: {} }).adopt).toBeUndefined();
  });
});

describe('buildDlzDeploymentParameters — internal trust token ownership (#3056)', () => {
  const base = {
    boundary: 'Commercial',
    location: 'eastus2',
    capacitySku: 'F8',
    domainName: 'va',
  };

  // WHY THIS IS A TEST AND NOT A COMMENT. This tier submits the compiled
  // main.json at subscription scope, and `loomInternalToken` was derived from
  // `loomGeneratedSecretSeed`, whose ARM default is `newGuid()` — a fresh random
  // value on EVERY deployment. A wizard-driven attach therefore re-minted the
  // trust token onto the console serving the wizard and stranded the consumer
  // jobs + the LOOM_INTERNAL_TOKEN GitHub secret. Container Apps does not
  // restart replicas on a secret write, so it detonated hours later: 153/153
  // eval probes 401'd on 2026-08-06.
  it('adopts the live token on dlz-attach (the estate this console already belongs to)', () => {
    const p = buildDlzDeploymentParameters({
      ...base,
      topology: 'dlz-attach',
      targetSubscriptionId: SUB,
      internalTokenValue: 'live-estate-token-value',
    });
    expect(p.loomInternalTokenValue).toEqual({ value: 'live-estate-token-value' });
  });

  it('does NOT leak this estate token into a fresh tenant install (a different estate)', () => {
    const p = buildDlzDeploymentParameters({
      ...base,
      topology: 'tenant',
      internalTokenValue: 'live-estate-token-value',
    });
    expect(p.loomInternalTokenValue).toBeUndefined();
  });

  it('emits nothing when the console has no token in env (greenfield params unchanged)', () => {
    expect(
      buildDlzDeploymentParameters({ ...base, topology: 'dlz-attach', targetSubscriptionId: SUB })
        .loomInternalTokenValue,
    ).toBeUndefined();
    expect(
      buildDlzDeploymentParameters({
        ...base,
        topology: 'dlz-attach',
        targetSubscriptionId: SUB,
        internalTokenValue: '   ',
      }).loomInternalTokenValue,
    ).toBeUndefined();
  });
});

describe('resolveDlzTemplateSource', () => {
  it('returns null when the env is unset (→ honest gate)', () => {
    expect(resolveDlzTemplateSource()).toBeNull();
  });
  it('returns a templateLink with the SAS query string when configured', () => {
    process.env[DLZ_TEMPLATE_ENV] = 'https://store.blob.core.windows.net/tpl/main.json';
    process.env.LOOM_DLZ_TEMPLATE_QUERY_STRING = 'sv=2023&sig=abc';
    expect(resolveDlzTemplateSource()).toEqual({
      templateLink: { uri: 'https://store.blob.core.windows.net/tpl/main.json', queryString: 'sv=2023&sig=abc' },
    });
  });
});

describe('resolveDlzTemplateInline / resolveDlzTemplate (bundled compiled template)', () => {
  it('reads the bundled deploy-templates/main.json as an inline template object', () => {
    // The compiled platform/fiab/bicep/main.json is committed under
    // apps/fiab-console/deploy-templates/ and resolved via cwd or the __dirname
    // fallback (lib/setup → ../../deploy-templates), so this passes regardless of
    // the test runner's cwd.
    const inline = resolveDlzTemplateInline();
    expect(inline).not.toBeNull();
    expect(typeof inline!.template).toBe('object');
    const tmpl = inline!.template as any;
    // Compiled subscription-scoped ARM template: standard $schema + resources.
    expect(tmpl.$schema).toContain('schema.management.azure.com');
    expect(tmpl.$schema).toContain('DeploymentTemplate.json');
    expect(Array.isArray(tmpl.resources) || typeof tmpl.resources === 'object').toBe(true);
  });

  it('caches the parse (same object identity on repeat reads)', () => {
    const a = resolveDlzTemplateInline();
    const b = resolveDlzTemplateInline();
    expect(a).toBe(b);
  });

  it('resolveDlzTemplate PREFERS the bundled inline template over the env templateLink', () => {
    // Even with the link env set, inline wins (durable, cloud-agnostic — no SAS).
    process.env[DLZ_TEMPLATE_ENV] = 'https://store.blob.core.windows.net/tpl/main.json';
    const resolved = resolveDlzTemplate();
    expect(resolved).not.toBeNull();
    expect((resolved as any).template).toBeDefined();
    expect((resolved as any).templateLink).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE THREE OUTCOMES — review of #4261, finding 1
// ---------------------------------------------------------------------------

/**
 * `lib/brain-actions/scalability.ts` derives a SAFETY property from this
 * resolver, so "I could not read the template" and "the template is not here"
 * must not arrive as the same value — and neither may be cached if it might be
 * transient. The old shape was `T | null` from a try with an EMPTY catch, which
 * collapsed both into null and then cached that null at module scope FOREVER.
 *
 * The input shape that had no fixture was a READ THAT FAILS. Every existing arm
 * above reads the real committed artifact successfully, so nothing exercised the
 * failure path at all — and the failure path was the data-loss path.
 */
describe('resolveDlzTemplateInlineOutcome — read failure is not absence (#4261 finding 1)', () => {
  it('a healthy image reports ok, and names the file it read', () => {
    const outcome = resolveDlzTemplateInlineOutcome();
    expect(outcome.status).toBe('ok');
    expect((outcome as { file: string }).file).toContain('main.json');
  });

  it('an IO failure is UNREADABLE — not absent — and names the file and the errno', () => {
    __resetInlineTemplateCache();
    fail.readFailure = () => {
      const e: NodeJS.ErrnoException = new Error('too many open files');
      e.code = 'EMFILE';
      throw e;
    };
    const outcome = resolveDlzTemplateInlineOutcome();
    expect(outcome.status, 'an unreadable artifact must NOT report as absent').toBe('unreadable');
    expect((outcome as { detail: string }).detail).toContain('EMFILE');
    expect((outcome as { file: string }).file).toContain('main.json');
  });

  it('THE RECOVERY ARM: a transient failure is NOT cached — the next read succeeds', () => {
    __resetInlineTemplateCache();
    let calls = 0;
    fail.readFailure = () => {
      calls += 1;
      const e: NodeJS.ErrnoException = new Error('i/o error');
      e.code = 'EIO';
      throw e;
    };
    expect(resolveDlzTemplateInlineOutcome().status).toBe('unreadable');
    expect(calls).toBeGreaterThan(0);

    // The pressure lifts. Nothing was reset except the fault injector — if the
    // failure had been cached (the old behaviour: `inlineTemplateCache = null`
    // at module scope, cleared only by a test-only helper), this would still
    // report unreadable for the life of the process.
    fail.readFailure = null;
    const after = resolveDlzTemplateInlineOutcome();
    expect(after.status, 'a transient failure must not disarm the reader forever').toBe('ok');
  });

  it('every candidate ENOENT is ABSENT — a different fact with a different fix', () => {
    __resetInlineTemplateCache();
    fail.readFailure = () => {
      const e: NodeJS.ErrnoException = new Error('no such file or directory');
      e.code = 'ENOENT';
      throw e;
    };
    const outcome = resolveDlzTemplateInlineOutcome();
    expect(outcome.status).toBe('absent');
    expect((outcome as { candidates: readonly string[] }).candidates.length).toBeGreaterThan(0);
  });

  it('a file that EXISTS and is not JSON is UNREADABLE, and does not fall through', () => {
    // Falling through to the next candidate would let a truncated artifact
    // masquerade as an absent one — and absence is cached.
    __resetInlineTemplateCache();
    fail.readFailure = () => '{ "resources": [ truncated';
    const outcome = resolveDlzTemplateInlineOutcome();
    expect(outcome.status).toBe('unreadable');
    expect((outcome as { detail: string }).detail).toMatch(/JSON\.parse failed/);
  });

  it('ABSENT is cached (it cannot change under a running image); UNREADABLE is not', () => {
    __resetInlineTemplateCache();
    let reads = 0;
    fail.readFailure = () => {
      reads += 1;
      const e: NodeJS.ErrnoException = new Error('nope');
      e.code = 'ENOENT';
      throw e;
    };
    resolveDlzTemplateInlineOutcome();
    const afterFirst = reads;
    resolveDlzTemplateInlineOutcome();
    expect(reads, 'absence is established once').toBe(afterFirst);
  });
});

describe('submitDlzDeployment (LIVE, stubbed fetch)', () => {
  it('PUTs a subscription-scoped deployment and returns the accepted state', async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ properties: { provisioningState: 'Accepted', correlationId: 'corr-1' } }),
      } as any;
    });
    const res = await submitDlzDeployment({
      subscriptionId: SUB,
      region: 'eastus2',
      parameters: { topology: { value: 'dlz-attach' } },
      templateSource: { templateLink: { uri: 'https://x/main.json' } },
      getToken: async () => 'user-token',
      deploymentName: 'loom-dlz-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.deploymentId).toBe('loom-dlz-test');
    expect(res.provisioningState).toBe('Accepted');
    // Correct ARM path + method + template-link body.
    expect(calls[0].url).toContain(`/subscriptions/${SUB}/providers/Microsoft.Resources/deployments/loom-dlz-test`);
    expect(calls[0].init.method).toBe('PUT');
    const body = JSON.parse(calls[0].init.body);
    expect(body.location).toBe('eastus2');
    expect(body.properties.mode).toBe('Incremental');
    expect(body.properties.templateLink.uri).toBe('https://x/main.json');
    expect(calls[0].init.headers.authorization).toBe('Bearer user-token');
  });

  it('submits the template INLINE (properties.template, no templateLink) for an inline source', async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ properties: { provisioningState: 'Accepted' } }),
      } as any;
    });
    const inlineTemplate = { $schema: 'https://schema.management.azure.com/x', resources: [] };
    const res = await submitDlzDeployment({
      subscriptionId: SUB,
      region: 'eastus2',
      parameters: { topology: { value: 'tenant' } },
      templateSource: { template: inlineTemplate },
      getToken: async () => 'user-token',
      deploymentName: 'loom-dlz-inline',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(calls[0].init.body);
    expect(body.properties.mode).toBe('Incremental');
    // Inline: the compiled template rides in properties.template, NOT templateLink.
    expect(body.properties.template).toEqual(inlineTemplate);
    expect(body.properties.templateLink).toBeUndefined();
  });

  it('surfaces a 403 with status so the route can render the grant gate', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: 'AuthorizationFailed' } }),
    })) as unknown as typeof fetch;
    const res = await submitDlzDeployment({
      subscriptionId: SUB,
      region: 'eastus2',
      parameters: {},
      templateSource: { templateLink: { uri: 'https://x/main.json' } },
      getToken: async () => 't',
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toContain('AuthorizationFailed');
  });

  it('returns pending 202 (never blocks) when the ARM PUT validation runs past the deadline', async () => {
    // A PUT that never resolves within the deadline models ARM's long
    // template-validation phase for the full main.json — the request that used
    // to hang here (→ Front Door 504) must now early-return with a pollable id.
    let resolveFetch: (v: any) => void = () => {};
    const fetchImpl = vi.fn(
      () => new Promise((r) => { resolveFetch = r; }),
    ) as unknown as typeof fetch;
    const started = Date.now();
    const res = await submitDlzDeployment({
      subscriptionId: SUB,
      region: 'eastus2',
      parameters: {},
      templateSource: { templateLink: { uri: 'https://x/main.json' } },
      getToken: async () => 't',
      deploymentName: 'loom-dlz-slow',
      fetchImpl,
      earlyReturnMs: 25,
    });
    expect(Date.now() - started).toBeLessThan(2000); // did NOT block on the PUT
    expect(res.ok).toBe(true);
    expect(res.pending).toBe(true);
    expect(res.status).toBe(202);
    expect(res.deploymentId).toBe('loom-dlz-slow');
    expect(res.provisioningState).toBe('Submitting');
    // Settle the backgrounded PUT so no promise lingers past the test.
    resolveFetch({ ok: true, status: 201, text: async () => JSON.stringify({ properties: { provisioningState: 'Accepted' } }) });
    await new Promise((r) => setTimeout(r, 0));
  });

  it('still returns synchronously (preserving the 403 gate) when ARM answers fast', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: 'AuthorizationFailed' } }),
    })) as unknown as typeof fetch;
    const res = await submitDlzDeployment({
      subscriptionId: SUB,
      region: 'eastus2',
      parameters: {},
      templateSource: { templateLink: { uri: 'https://x/main.json' } },
      getToken: async () => 't',
      fetchImpl,
      earlyReturnMs: 5000,
    });
    expect(res.pending).toBeUndefined();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  it('rejects an invalid subscription id without calling ARM', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await submitDlzDeployment({
      subscriptionId: 'not-a-guid',
      region: 'eastus2',
      parameters: {},
      templateSource: { templateLink: { uri: 'https://x/main.json' } },
      getToken: async () => 't',
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('readDlzDeploymentStatus + progressForState', () => {
  it('reads the provisioning state under the user token', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ properties: { provisioningState: 'Running' } }),
    })) as unknown as typeof fetch;
    const st = await readDlzDeploymentStatus({
      subscriptionId: SUB,
      deploymentName: 'loom-dlz-test',
      getToken: async () => 't',
      fetchImpl,
    });
    expect(st.ok).toBe(true);
    expect(st.provisioningState).toBe('Running');
    expect(st.progress).toBe(0.6);
  });

  it('maps terminal + transient states to a coarse progress fraction', () => {
    expect(progressForState('Succeeded')).toBe(1);
    expect(progressForState('Failed')).toBe(1);
    expect(progressForState('Running')).toBe(0.6);
    expect(progressForState('Accepted')).toBe(0.2);
    expect(progressForState(undefined)).toBe(0.1);
  });
});

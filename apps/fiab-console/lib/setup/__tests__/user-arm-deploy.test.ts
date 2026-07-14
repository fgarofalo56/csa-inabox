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
import {
  buildDlzDeploymentParameters,
  resolveDlzTemplateSource,
  resolveDlzTemplateInline,
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

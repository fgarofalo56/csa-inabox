/**
 * Scan-and-choose tests for the Setup Wizard:
 *
 *   lib/setup/scan-services         — recommendation engine (pure)
 *   lib/setup/service-choices-to-params — choice → bicep params + EXISTING_* env
 *   GET /api/setup/scan-services    — Resource Graph scan + bucketing
 *   ui-parity                       — the wizard catalog covers byo-wizard.sh's
 *                                     flagged services (no CLI/Wizard drift)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SETUP_SCAN_SERVICES,
  SETUP_SCAN_SERVICE_BY_KEY,
  recommendForService,
  canDisable,
  type ScanCandidate,
} from '@/lib/setup/scan-services';
import {
  serviceChoicesToParams,
  translateChoice,
  bicepParamsToCliTokens,
} from '@/lib/setup/service-choices-to-params';

const DEPLOY_SUB = '11111111-1111-1111-1111-111111111111';
const OTHER_SUB = '22222222-2222-2222-2222-222222222222';

describe('recommendForService', () => {
  const aisearch = SETUP_SCAN_SERVICE_BY_KEY['aisearch'];
  const purview = SETUP_SCAN_SERVICE_BY_KEY['purview'];
  const synapse = SETUP_SCAN_SERVICE_BY_KEY['synapse'];

  it('recommends use-existing + the deploy-sub candidate when one exists there', () => {
    const cands: ScanCandidate[] = [
      { name: 'srch-a', rg: 'rg1', sub: OTHER_SUB },
      { name: 'srch-b', rg: 'rg2', sub: DEPLOY_SUB },
    ];
    const r = recommendForService(aisearch, cands, DEPLOY_SUB);
    expect(r.recommendation).toBe('use-existing');
    expect(r.recommendedCandidate?.name).toBe('srch-b');
  });

  it('falls back to the first candidate when none is in the deploy sub', () => {
    const cands: ScanCandidate[] = [{ name: 'srch-a', rg: 'rg1', sub: OTHER_SUB }];
    const r = recommendForService(aisearch, cands, DEPLOY_SUB);
    expect(r.recommendedCandidate?.name).toBe('srch-a');
  });

  it('recommends new for a default-on flagged service with no candidates', () => {
    expect(recommendForService(aisearch, [], DEPLOY_SUB).recommendation).toBe('new');
  });

  it('recommends new for Purview when none exists (tenant has no Enterprise Purview yet)', () => {
    expect(recommendForService(purview, [], DEPLOY_SUB).recommendation).toBe('new');
  });

  it('recommends use-existing for Purview when a candidate exists (reuse-first)', () => {
    const r = recommendForService(purview, [{ name: 'pv', rg: 'rg', sub: OTHER_SUB }], DEPLOY_SUB);
    expect(r.recommendation).toBe('use-existing');
  });

  it('recommends new for a DLZ service (no flag) with no candidates', () => {
    expect(recommendForService(synapse, [], DEPLOY_SUB).recommendation).toBe('new');
  });
});

describe('canDisable', () => {
  it('is true only for services with a provisioning flag', () => {
    expect(canDisable(SETUP_SCAN_SERVICE_BY_KEY['aisearch'])).toBe(true);
    expect(canDisable(SETUP_SCAN_SERVICE_BY_KEY['maps'])).toBe(true);
    expect(canDisable(SETUP_SCAN_SERVICE_BY_KEY['synapse'])).toBe(false);
  });
});

describe('serviceChoicesToParams', () => {
  it('use-existing sets existing* params + EXISTING_* env + flag=false', () => {
    const out = serviceChoicesToParams({
      aisearch: { mode: 'use-existing', name: 'srch', rg: 'rg-a', sub: OTHER_SUB },
    });
    expect(out.bicepParams.existingAiSearchService).toBe('srch');
    expect(out.bicepParams.existingAiSearchRg).toBe('rg-a');
    expect(out.bicepParams.existingAiSearchSub).toBe(OTHER_SUB);
    expect(out.bicepParams.aiSearchEnabled).toBe(false);
    expect(out.existingEnv.EXISTING_AI_SEARCH_SERVICE).toBe('srch');
    expect(out.existingEnv.EXISTING_AI_SEARCH_RG).toBe('rg-a');
    expect(out.existingEnv.EXISTING_AI_SEARCH_SUB).toBe(OTHER_SUB);
  });

  it('new sets the enable flag true and no existing* params', () => {
    const out = serviceChoicesToParams({ apim: { mode: 'new' } });
    expect(out.bicepParams.apimEnabled).toBe(true);
    expect(out.bicepParams.existingApimName).toBeUndefined();
    expect(Object.keys(out.existingEnv)).toHaveLength(0);
  });

  it('disable sets the enable flag false', () => {
    const out = serviceChoicesToParams({ purview: { mode: 'disable' } });
    expect(out.bicepParams.purviewEnabled).toBe(false);
  });

  it('a DLZ service (no flag) reuse sets existing* + env but no flag', () => {
    const out = serviceChoicesToParams({
      synapse: { mode: 'use-existing', name: 'syn', rg: 'rg-s', sub: DEPLOY_SUB },
    });
    expect(out.bicepParams.existingSynapseWorkspace).toBe('syn');
    expect(out.bicepParams.synapseEnabled).toBeUndefined();
    expect(out.existingEnv.EXISTING_SYNAPSE).toBe('syn');
  });

  it('Maps reuse sets only the EXISTING_* env (no existing* bicep param) + flag false', () => {
    const out = serviceChoicesToParams({
      maps: { mode: 'use-existing', name: 'maps1', rg: 'rg-m', sub: DEPLOY_SUB },
    });
    expect(out.existingEnv.EXISTING_AZURE_MAPS).toBe('maps1');
    expect(out.bicepParams.azureMapsEnabled).toBe(false);
    // Maps has no existing* bicep params declared — must NOT emit one.
    expect(Object.keys(out.bicepParams).filter((k) => k.startsWith('existing'))).toHaveLength(0);
  });

  it('ignores unknown service keys and empty use-existing names', () => {
    const out = serviceChoicesToParams({
      bogus: { mode: 'new' },
      aisearch: { mode: 'use-existing', name: '' },
    });
    expect(out.bicepParams).toEqual({});
  });

  it('renders cli tokens with bare booleans and quoted strings', () => {
    const tokens = bicepParamsToCliTokens({ apimEnabled: true, existingApimName: 'apim-x' });
    expect(tokens).toContain('apimEnabled=true');
    expect(tokens).toContain("existingApimName='apim-x'");
  });
});

describe('ui-parity: SETUP_SCAN_SERVICES vs byo-wizard.sh SERVICES', () => {
  it('covers every flagged service the CLI knows (no drift)', () => {
    const cli = readFileSync(
      join(process.cwd(), '..', '..', 'scripts', 'csa-loom', 'byo-wizard.sh'),
      'utf8',
    );
    // Extract the bash SERVICES rows' first column (the key) for flagged rows.
    // Row shape: "key|label|type|filt|nameP|rgP|subP|env|envRg|envSub|flag"
    const rowRe = /^\s*"([a-z0-9]+)\|[^"]*\|([a-zA-Z]*)"\s*$/gm;
    const cliKeysWithFlag = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(cli))) {
      if (m[2]) cliKeysWithFlag.add(m[1]); // trailing flag column non-empty
    }
    // Every CLI service that has a provisioning flag must be a choosable service
    // in the wizard catalog with the same flag semantics.
    for (const key of cliKeysWithFlag) {
      const def = SETUP_SCAN_SERVICE_BY_KEY[key];
      expect(def, `wizard catalog missing flagged CLI service '${key}'`).toBeDefined();
      expect(def.enabledFlag, `wizard '${key}' should carry an enable flag`).toBeTruthy();
    }
    // Sanity: the parser found the known flagged services.
    expect(cliKeysWithFlag.has('aisearch')).toBe(true);
    expect(cliKeysWithFlag.has('purview')).toBe(true);
  });
});

// ── GET /api/setup/scan-services ────────────────────────────────────────────
const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));
vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

function stubGraph(rows: any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      expect(String(url)).toContain('providers/Microsoft.ResourceGraph/resources');
      return new Response(JSON.stringify({ data: rows }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function req(qs = '') {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}

describe('GET /api/setup/scan-services', () => {
  beforeEach(() => {
    delete process.env.LOOM_UAMI_CLIENT_ID;
    delete process.env.LOOM_SUBSCRIPTION_ID;
    getSessionMock.mockReturnValue({ claims: { oid: 'oid-test' }, exp: Date.now() / 1000 + 3600 } as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/setup/scan-services/route');
    const r = await GET(req());
    expect(r.status).toBe(401);
  });

  it('buckets discovered resources by service and recommends use-existing', async () => {
    stubGraph([
      { svcType: 'microsoft.search/searchservices', name: 'srch1', resourceGroup: 'rg1', subscriptionId: DEPLOY_SUB, location: 'eastus' },
      { svcType: 'microsoft.kusto/clusters', name: 'kusto1', resourceGroup: 'rg2', subscriptionId: OTHER_SUB, location: 'eastus2' },
    ]);
    const { GET } = await import('@/app/api/setup/scan-services/route');
    const r = await GET(req(`deploySub=${DEPLOY_SUB}`));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    const search = j.services.find((s: any) => s.key === 'aisearch');
    expect(search.candidates).toHaveLength(1);
    expect(search.recommendation).toBe('use-existing');
    expect(search.recommendedCandidate.name).toBe('srch1');
    const apim = j.services.find((s: any) => s.key === 'apim');
    expect(apim.candidates).toHaveLength(0);
    expect(apim.recommendation).toBe('new');
  });

  it('only counts AIServices-kind accounts as AI Foundry candidates', async () => {
    stubGraph([
      { svcType: 'microsoft.cognitiveservices/accounts', name: 'aoai1', resourceGroup: 'rg', subscriptionId: DEPLOY_SUB, kind: 'AIServices' },
      { svcType: 'microsoft.cognitiveservices/accounts', name: 'speech1', resourceGroup: 'rg', subscriptionId: DEPLOY_SUB, kind: 'SpeechServices' },
    ]);
    const { GET } = await import('@/app/api/setup/scan-services/route');
    const r = await GET(req());
    const j = await r.json();
    const foundry = j.services.find((s: any) => s.key === 'foundry');
    expect(foundry.candidates).toHaveLength(1);
    expect(foundry.candidates[0].name).toBe('aoai1');
  });

  it('502 when Resource Graph errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 403, headers: { 'content-type': 'text/plain' } })),
    );
    const { GET } = await import('@/app/api/setup/scan-services/route');
    const r = await GET(req());
    expect(r.status).toBe(502);
  });
});

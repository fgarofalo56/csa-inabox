/**
 * Scan-and-choose tests for the Setup Wizard:
 *
 *   lib/setup/scan-services         — recommendation engine (pure)
 *   lib/setup/service-choices-to-params — choice → bicep params + EXISTING_* env
 *   ui-parity                       — the wizard catalog covers byo-wizard.sh's
 *                                     flagged services (no CLI/Wizard drift)
 *
 * GET /api/setup/scan-services is GONE (#3015): it was a weaker parallel
 * scanner (no `$top`, no `$skipToken` loop, no `allowPartialScopes`, no
 * coverage ledger) with ZERO UI callers. The wizard's scan endpoints are
 * /api/setup/estate-scan (scoped) and /api/setup/discover-services (all
 * visible), both on the shared honest scan modules.
 */
import { describe, it, expect } from 'vitest';
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
  it('use-existing sets the adopt bag + EXISTING_* env, and keeps the flag TRUE', () => {
    const out = serviceChoicesToParams({
      aisearch: { mode: 'use-existing', name: 'srch', rg: 'rg-a', sub: OTHER_SUB },
    });
    expect(out.adopt.aisearch).toEqual({
      mode: 'adopt',
      target: { name: 'srch', rg: 'rg-a', sub: OTHER_SUB },
    });
    // main.bicep no longer declares existing* scalars — emitting one is BCP259.
    expect(Object.keys(out.bicepParams).filter((k) => k.startsWith('existing'))).toHaveLength(0);
    // The flag stays TRUE: `provisionAiSearch = aiSearchEnabled && adoptMode==create`
    // already suppresses creation, and the flag also mirrors the Console binding.
    expect(out.bicepParams.aiSearchEnabled).toBe(true);
    expect(out.existingEnv.EXISTING_AI_SEARCH_SERVICE).toBe('srch');
    expect(out.existingEnv.EXISTING_AI_SEARCH_RG).toBe('rg-a');
    expect(out.existingEnv.EXISTING_AI_SEARCH_SUB).toBe(OTHER_SUB);
  });

  it('new sets the enable flag true and contributes NOTHING to the adopt bag', () => {
    const out = serviceChoicesToParams({ apim: { mode: 'new' } });
    expect(out.bicepParams.apimEnabled).toBe(true);
    expect(out.adopt.apim).toBeUndefined();
    expect(Object.keys(out.adopt)).toHaveLength(0);
    expect(Object.keys(out.existingEnv)).toHaveLength(0);
  });

  it('an all-new (greenfield) choice set emits an EMPTY adopt bag', () => {
    const out = serviceChoicesToParams({
      apim: { mode: 'new' },
      aisearch: { mode: 'new' },
      purview: { mode: 'new' },
      databricks: { mode: 'new' },
    });
    expect(Object.keys(out.adopt)).toHaveLength(0);
    expect(Object.keys(out.bicepParams).filter((k) => k.startsWith('existing'))).toHaveLength(0);
  });

  it('disable sets the enable flag false', () => {
    const out = serviceChoicesToParams({ purview: { mode: 'disable' } });
    expect(out.bicepParams.purviewEnabled).toBe(false);
  });

  it('a DLZ service (no flag) reuse sets the adopt bag + env but no flag', () => {
    const out = serviceChoicesToParams({
      synapse: { mode: 'use-existing', name: 'syn', rg: 'rg-s', sub: DEPLOY_SUB },
    });
    expect(out.adopt.synapse).toEqual({
      mode: 'adopt',
      target: { name: 'syn', rg: 'rg-s', sub: DEPLOY_SUB },
    });
    expect(out.bicepParams.synapseEnabled).toBeUndefined();
    expect(out.existingEnv.EXISTING_SYNAPSE).toBe('syn');
  });

  it('Maps reuse goes through the SAME adopt bag as every other service', () => {
    const out = serviceChoicesToParams({
      maps: { mode: 'use-existing', name: 'maps1', rg: 'rg-m', sub: DEPLOY_SUB },
    });
    expect(out.existingEnv.EXISTING_AZURE_MAPS).toBe('maps1');
    expect(out.adopt.maps).toEqual({
      mode: 'adopt',
      target: { name: 'maps1', rg: 'rg-m', sub: DEPLOY_SUB },
    });
    expect(out.bicepParams.azureMapsEnabled).toBe(true);
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
  // Fixed in #1532: byo-wizard.sh flags `eventhubs` (loomEventHubEnabled) and
  // `streamanalytics` (loomStreamAnalyticsEnabled) as disableable, and both are
  // real `param ... bool = true` flags in platform/fiab/bicep/main.bicep. The
  // wizard catalog (lib/setup/scan-services.ts) now carries the `eventhubs`
  // enable flag and a `streamanalytics` def, so the wizard can disable exactly
  // the services the CLI + bicep support. This test pins that there is no
  // remaining wizard↔CLI/bicep drift on any flagged service.
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


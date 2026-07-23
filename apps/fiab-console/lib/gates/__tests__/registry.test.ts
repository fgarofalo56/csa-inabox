/**
 * Gate registry (G2) completeness + integrity tests.
 *
 * The die-hard invariant: lib/gates/registry.ts is DERIVED from self-audit's
 * ENV_CHECKS (the single declarative source) and enriched by GATE_META — the
 * two must never drift, and every legacy bespoke error code from the Phase-1
 * inventory must map to exactly one canonical gate.
 */
import { describe, it, expect } from 'vitest';
import { ENV_CHECKS } from '@/lib/admin/self-audit';
import {
  GATES,
  GATE_META,
  getGate,
  gateForLegacyCode,
  gateStatus,
  allGateStatuses,
} from '../registry';

describe('gate registry completeness', () => {
  it('has exactly one gate per ENV_CHECKS spec (no drift either way)', () => {
    const specIds = new Set(ENV_CHECKS.map((s) => s.id));
    const gateIds = new Set(GATES.map((g) => g.id));
    expect([...specIds].filter((id) => !gateIds.has(id))).toEqual([]);
    expect([...gateIds].filter((id) => !specIds.has(id))).toEqual([]);
    expect(GATES.length).toBe(ENV_CHECKS.length);
  });

  it('every ENV_CHECKS spec has an explicit GATE_META enrichment (surfaces + fixit)', () => {
    const missingMeta = ENV_CHECKS.map((s) => s.id).filter((id) => !GATE_META[id]);
    expect(missingMeta).toEqual([]);
    const orphanMeta = Object.keys(GATE_META).filter((id) => !ENV_CHECKS.some((s) => s.id === id));
    expect(orphanMeta).toEqual([]);
  });

  it('every gate names at least one surface and at least one required setting', () => {
    for (const g of GATES) {
      expect(g.surfaces.length, `gate ${g.id} has no surfaces`).toBeGreaterThan(0);
      expect(g.requiredSettings.length, `gate ${g.id} has no settings`).toBeGreaterThan(0);
      expect(g.remediation.length, `gate ${g.id} has no remediation`).toBeGreaterThan(10);
    }
  });

  it('every options-loader is keyed to one of its gate’s own settings', () => {
    for (const [id, meta] of Object.entries(GATE_META)) {
      const gate = getGate(id)!;
      const keys = new Set(gate.requiredSettings.map((s) => s.envVar));
      for (const loaderKey of Object.keys(meta.loaders || {})) {
        expect(keys.has(loaderKey), `gate ${id}: loader key ${loaderKey} not a setting`).toBe(true);
      }
    }
  });

  it('legacy codes are unique across gates', () => {
    const seen = new Map<string, string>();
    for (const g of GATES) {
      for (const code of g.legacyCodes) {
        expect(seen.has(code), `code ${code} claimed by ${seen.get(code)} and ${g.id}`).toBe(false);
        seen.set(code, g.id);
      }
    }
  });

  it('maps the Phase-1 inventory legacy codes to canonical gates', () => {
    const expectations: Record<string, string> = {
      adls_not_configured: 'svc-adls',
      no_aoai: 'svc-aoai',
      aoai_not_configured: 'svc-aoai',
      embedding_not_configured: 'svc-aoai-embeddings',
      ai_search_not_configured: 'svc-aisearch',
      kusto_not_configured: 'svc-adx',
      eventhubs_not_configured: 'svc-eventhubs',
      databricks_not_configured: 'svc-databricks',
      synapse_not_configured: 'svc-synapse',
      purview_not_configured: 'purview',
      aas_not_configured: 'svc-aas',
      apim_not_configured: 'svc-apim',
      aml_not_configured: 'svc-aml',
      batch_not_configured: 'svc-batch',
      cosmos_not_configured: 'svc-cosmos-control',
      kv_not_configured: 'svc-keyvault',
      cmk_not_configured: 'svc-keyvault',
      dataverse_not_configured: 'svc-dataverse',
      dbt_not_configured: 'svc-dbt',
      shir_not_configured: 'svc-shir',
      lakebase_not_configured: 'svc-lakebase',
      schema_registry_not_configured: 'svc-eh-schema-registry',
      copyjob_control_not_configured: 'svc-copyjob-control',
      adt_not_configured: 'svc-digital-twins',
      pgvector_not_configured: 'svc-pgvector',
      weave_ontology_not_configured: 'svc-weave-ontology',
      mip_not_configured: 'svc-mip',
      dlp_not_configured: 'svc-dlp',
    };
    for (const [code, gateId] of Object.entries(expectations)) {
      expect(gateForLegacyCode(code)?.id, `code ${code}`).toBe(gateId);
    }
  });
});

describe('gate live status (evalEnv-backed)', () => {
  it('reports blocked with the preferred missing var when env is unset', () => {
    delete process.env.LOOM_AIRFLOW_ENDPOINT;
    const st = gateStatus('svc-airflow')!;
    expect(st.status).toBe('blocked');
    expect(st.missing).toContain('LOOM_AIRFLOW_ENDPOINT');
  });

  it('flips to configured when the required env is present', () => {
    process.env.LOOM_AIRFLOW_ENDPOINT = 'https://airflow.example.net';
    try {
      const st = gateStatus('svc-airflow')!;
      expect(st.status).toBe('configured');
      expect(st.missing).toEqual([]);
    } finally {
      delete process.env.LOOM_AIRFLOW_ENDPOINT;
    }
  });

  it('treats optionalDefault substrates as configured (default-on posture)', () => {
    delete process.env.LOOM_ONELAKE_URL;
    const st = gateStatus('svc-loom-onelake')!;
    expect(st.status).toBe('configured');
  });

  it('svc-openlineage (L2) is default-ON absent (additive source) with a wizard Fix-it', () => {
    // Unset credential → the OpenLineage feed is silently absent while the
    // OTHER column-lineage sources keep flowing — optionalDefault posture, so
    // the gate reads 'configured' (never a red day-one state).
    delete process.env.LOOM_OPENLINEAGE_AUTH_MODE;
    const st = gateStatus('svc-openlineage')!;
    expect(st.status).toBe('configured');
    // The enrichment is the pool-setup WIZARD (mint credential + pool config),
    // never a bare env write, and both L5 lineage surfaces are named.
    const meta = GATE_META['svc-openlineage'];
    expect(meta.fixit.kind).toBe('wizard');
    expect(meta.surfaces.map((s) => s.path)).toEqual(['/items/lakehouse', '/catalog']);
    expect(meta.legacyCodes).toContain('openlineage_not_configured');
  });

  it('svc-digital-twins is satisfied by the ADX graph-twin default (no Azure Digital Twins needed)', () => {
    // GCC-High has no Azure Digital Twins; the ADX graph-twin is the default
    // backend, gated on LOOM_KUSTO_CLUSTER_URI (emitted whenever adxEnabled).
    delete process.env.LOOM_ADT_ENDPOINT;
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    const blocked = gateStatus('svc-digital-twins')!;
    expect(blocked.status).toBe('blocked');

    process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-csa-loom.eastus2.kusto.usgovcloudapi.net';
    try {
      const st = gateStatus('svc-digital-twins')!;
      expect(st.status).toBe('configured');
      expect(st.missing).toEqual([]);
    } finally {
      delete process.env.LOOM_KUSTO_CLUSTER_URI;
    }
  });

  it('evaluates the whole registry in one pass', () => {
    const all = allGateStatuses();
    expect(all.length).toBe(GATES.length);
    for (const st of all) expect(['configured', 'blocked']).toContain(st.status);
  });
});

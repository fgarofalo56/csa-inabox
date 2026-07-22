/**
 * X2 — availability-gate convention: the loom-next-level X-MATRIX as DATA.
 *
 * Sibling of cloud-matrix.test.ts: that file locks the per-cloud endpoint
 * suffixes; this one locks the structured per-service availability layer
 * (`EnvSpec.availability` → `availabilityFor()` / `gateStatus()` in
 * lib/gates/registry.ts) against the X-MATRIX table in
 * PRPs/active/loom-next-level/ws-identity-cloudmatrix.md — one row per service
 * per cloud, so a drift back to hand-maintained prose fails here.
 *
 * Round-3 clarification (locked in below): 'limited' NEVER gates — the surface
 * renders normally plus a non-blocking info note from fallbackNote; ONLY
 * 'unavailable' produces the distinct 'cloud-unavailable' state, and a PASSING
 * env check always stays 'configured' (e.g. the ADX graph-twin satisfying
 * svc-digital-twins in Gov).
 *
 * Cloud-key mapping (activeCloudAvailabilityKey): Commercial + GCC → the
 * `commercial` column (GCC runs on Commercial Azure endpoints); GCC-High (and
 * its 'il5' LOOM_CLOUD alias, which detectLoomCloud collapses to GCC-High) →
 * `gccHigh`; DoD (the air-gapped IL5 posture) → `il5`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  availabilityFor,
  availabilityInActiveCloud,
  isAvailableInActiveCloud,
  activeCloudAvailabilityKey,
  gateStatus,
  getGate,
} from '@/lib/gates/registry';
import type { Avail } from '@/lib/admin/env-checks';

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
});
afterEach(() => {
  process.env = { ...SAVED };
});

/** The X-MATRIX, service by service, cloud by cloud (ws-identity-cloudmatrix.md).
 * Column mapping to ENV_CHECKS spec ids:
 *   AAS row                → svc-aas (X-MATRIX row verbatim; PRP ground-truth
 *                            correction #1 says AAS IS GA in Gov — item A4
 *                            flips gccHigh/il5 to 'ga' behind verification)
 *   Grafana + Fabric/PBI   → usage-embed / govern-embed (grafana is the
 *                            day-one embed backend; PBI is Fabric-family opt-in)
 *   ADT row                → svc-digital-twins (ADX graph-twin fallback)
 *   Databricks SQL row     → svc-databricks-sql
 *   Graph DLP policy row   → svc-dlp
 *   Azure Maps row         → svc-azure-maps (MapLibre fallback)
 *   AOAI model-lag row     → svc-aoai + svc-model-reasoning-tier
 *   Cost Management CSP row→ svc-lcu-autopilot (REST Query/Forecast fallback)
 */
const X_MATRIX: Record<string, { commercial: Avail; gccHigh: Avail; il5: Avail }> = {
  'svc-aas': { commercial: 'ga', gccHigh: 'unavailable', il5: 'unavailable' },
  'usage-embed': { commercial: 'ga', gccHigh: 'limited', il5: 'unavailable' },
  'govern-embed': { commercial: 'ga', gccHigh: 'limited', il5: 'unavailable' },
  'svc-digital-twins': { commercial: 'ga', gccHigh: 'unavailable', il5: 'unavailable' },
  'svc-databricks-sql': { commercial: 'ga', gccHigh: 'limited', il5: 'limited' },
  'svc-dlp': { commercial: 'ga', gccHigh: 'unavailable', il5: 'unavailable' },
  'svc-azure-maps': { commercial: 'ga', gccHigh: 'limited', il5: 'limited' },
  'svc-aoai': { commercial: 'ga', gccHigh: 'limited', il5: 'limited' },
  'svc-model-reasoning-tier': { commercial: 'ga', gccHigh: 'limited', il5: 'limited' },
  'svc-lcu-autopilot': { commercial: 'ga', gccHigh: 'limited', il5: 'limited' },
};

describe('X2 — availabilityFor() matches the X-MATRIX per service per cloud', () => {
  for (const [id, expected] of Object.entries(X_MATRIX)) {
    it(`${id}: commercial=${expected.commercial} gccHigh=${expected.gccHigh} il5=${expected.il5}`, () => {
      const a = availabilityFor(id);
      expect(a, `${id} must declare structured availability`).toBeDefined();
      expect(a!.commercial).toBe(expected.commercial);
      expect(a!.gccHigh).toBe(expected.gccHigh);
      expect(a!.il5).toBe(expected.il5);
      // Every non-GA row must name its Azure-native/OSS/Loom-native fallback.
      expect(a!.fallbackNote, `${id} fallbackNote`).toBeTruthy();
      expect(a!.fallbackNote!.length).toBeGreaterThan(20);
    });
  }

  it('the GateDef passes availability through verbatim', () => {
    for (const id of Object.keys(X_MATRIX)) {
      expect(getGate(id)?.availability).toEqual(availabilityFor(id));
    }
  });

  it('undeclared services default to ga everywhere (never gate)', () => {
    expect(availabilityFor('svc-adls')).toBeUndefined();
    process.env.LOOM_CLOUD = 'GCC-High';
    expect(availabilityInActiveCloud('svc-adls')).toBe('ga');
    expect(isAvailableInActiveCloud('svc-adls')).toBe(true);
  });
});

describe('X2 — active-cloud key resolution (detectLoomCloud)', () => {
  it('Commercial + GCC read the commercial column', () => {
    process.env.LOOM_CLOUD = 'Commercial';
    expect(activeCloudAvailabilityKey()).toBe('commercial');
    process.env.LOOM_CLOUD = 'GCC';
    expect(activeCloudAvailabilityKey()).toBe('commercial');
  });

  it('GCC-High (and the il5 alias, which detectLoomCloud collapses to GCC-High) read gccHigh', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    expect(activeCloudAvailabilityKey()).toBe('gccHigh');
    process.env.LOOM_CLOUD = 'il5';
    expect(activeCloudAvailabilityKey()).toBe('gccHigh');
  });

  it('DoD (air-gapped IL5 posture) reads the il5 column', () => {
    process.env.LOOM_CLOUD = 'DoD';
    expect(activeCloudAvailabilityKey()).toBe('il5');
    // Grafana embed: limited in GCC-High but unavailable at IL5/DoD.
    expect(availabilityInActiveCloud('usage-embed')).toBe('unavailable');
    expect(isAvailableInActiveCloud('usage-embed')).toBe(false);
  });

  it('isAvailableInActiveCloud: only unavailable is false — limited counts available', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    expect(isAvailableInActiveCloud('svc-aas')).toBe(false);        // unavailable
    expect(isAvailableInActiveCloud('svc-aoai')).toBe(true);        // limited
    expect(isAvailableInActiveCloud('svc-databricks-sql')).toBe(true); // limited
  });
});

describe('X2 — gateStatus() cloud-unavailable state (distinct from blocked)', () => {
  const AAS_VARS = [
    'LOOM_AAS_SERVER', 'LOOM_AAS_SERVER_NAME', 'LOOM_AAS_XMLA_ENDPOINT',
    'LOOM_POWERBI_XMLA_ENDPOINT', 'LOOM_SEMANTIC_BACKEND',
  ];
  const clear = (keys: string[]) => { for (const k of keys) delete process.env[k]; };

  it('a FAILING check in a cloud where the service is unavailable → cloud-unavailable + fallbackNote', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    clear(AAS_VARS);
    const st = gateStatus('svc-aas')!;
    expect(st.status).toBe('cloud-unavailable');
    expect(st.availability).toBe('unavailable');
    expect(st.fallbackNote).toContain('Loom-native semantic layer');
  });

  it('the SAME failing check in Commercial stays a plain blocked (Fix-it applies)', () => {
    process.env.LOOM_CLOUD = 'Commercial';
    clear(AAS_VARS);
    const st = gateStatus('svc-aas')!;
    expect(st.status).toBe('blocked');
    expect(st.availability).toBe('ga');
    expect(st.fallbackNote).toBeUndefined();
  });

  it('a PASSING check is ALWAYS configured — the availability overlay never gates a working backend', () => {
    // ADX graph-twin satisfies svc-digital-twins in Gov with zero ADT dependency.
    process.env.LOOM_CLOUD = 'GCC-High';
    delete process.env.LOOM_ADT_ENDPOINT;
    process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-loom.usgovvirginia.kusto.usgovcloudapi.net';
    try {
      const st = gateStatus('svc-digital-twins')!;
      expect(st.status).toBe('configured');
      expect(st.availability).toBe('unavailable'); // ADT itself is still not in this cloud
    } finally {
      delete process.env.LOOM_KUSTO_CLUSTER_URI;
    }
  });

  it('svc-digital-twins with NOTHING set in Gov → cloud-unavailable naming the ADX graph-twin', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    clear(['LOOM_ADT_ENDPOINT', 'LOOM_KUSTO_CLUSTER_URI']);
    const st = gateStatus('svc-digital-twins')!;
    expect(st.status).toBe('cloud-unavailable');
    expect(st.fallbackNote).toContain('ADX graph-twin');
  });

  it("'limited' NEVER produces the gate — a failing check stays blocked with the info note attached", () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    clear([
      'LOOM_AOAI_ENDPOINT', 'LOOM_FOUNDRY_PROJECT_ENDPOINT', 'LOOM_FOUNDRY_ENDPOINT',
      'LOOM_AOAI_DEPLOYMENT',
    ]);
    const st = gateStatus('svc-aoai')!;
    expect(st.status).toBe('blocked'); // NOT cloud-unavailable — AOAI exists in Gov
    expect(st.availability).toBe('limited');
    expect(st.fallbackNote).toContain('openai.azure.us');
  });

  it("'limited' with a PASSING check → configured + the non-blocking note for the surface", () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_AOAI_ENDPOINT = 'https://loom-aoai.openai.azure.us/';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-5.2';
    try {
      const st = gateStatus('svc-aoai')!;
      expect(st.status).toBe('configured');
      expect(st.availability).toBe('limited');
      expect(st.fallbackNote).toBeTruthy(); // surfaces render this as an info note
    } finally {
      delete process.env.LOOM_AOAI_ENDPOINT;
      delete process.env.LOOM_AOAI_DEPLOYMENT;
    }
  });

  it('undeclared gates never report cloud-unavailable in any cloud', () => {
    for (const cloud of ['Commercial', 'GCC', 'GCC-High', 'DoD']) {
      process.env.LOOM_CLOUD = cloud;
      delete process.env.LOOM_AIRFLOW_ENDPOINT;
      const st = gateStatus('svc-airflow')!;
      expect(st.status).toBe('blocked');
      expect(st.availability).toBeUndefined();
    }
  });
});

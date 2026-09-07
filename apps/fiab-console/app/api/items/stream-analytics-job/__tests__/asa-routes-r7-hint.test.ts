/**
 * #3573 / `deploy-integrity.md` R7 — the ASA hint must ride the NOT-CONFIGURED
 * branch and NOTHING else, across EVERY route of the item type.
 *
 * WHY THIS FILE EXISTS (review of #4354): the fix originally landed in exactly
 * one of the ASA routes — `[name]/route.ts` — while the PR body claimed the
 * whole item type. Measured on the reviewed head, seven other routes still
 * attached
 *
 *   'Provision an ASA job (…stream-analytics.bicep) and set LOOM_ASA_RG…'
 *
 * to their GENERIC 502 catch. On a deployment where LOOM_ASA_RG is set
 * correctly, a 403 / throttle / DNS failure therefore told the operator to go
 * set an env var that was already set — a cause the code established nothing
 * about, which is the exact R7 failure this PR was opened to remove.
 *
 * Every case below drives the route with a generic ARM error and asserts the
 * response carries no remediation at all. The 501 counterpart is asserted too,
 * so "delete the hint everywhere" cannot pass this file either — the honest
 * gate must survive.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  class AsaNotConfiguredError extends Error {
    missing: string[];
    constructor(m: string[]) {
      super(`Stream Analytics is not configured. Missing env: ${m.join(', ')}`);
      this.missing = m;
    }
  }
  class AsaJobNotFoundError extends Error {
    jobName: string; resourceGroup: string; subscriptionId: string;
    constructor(jobName: string, resourceGroup: string, subscriptionId: string) {
      super(`Stream Analytics job '${jobName}' does not exist in resource group '${resourceGroup}' (subscription ${subscriptionId}).`);
      this.jobName = jobName; this.resourceGroup = resourceGroup; this.subscriptionId = subscriptionId;
    }
  }
  class AsaTestNotAvailableError extends Error {
    hint: string;
    constructor(hint: string) {
      super('ASA sample-output Test Query is not available in this deployment.');
      this.hint = hint;
    }
  }
  return { AsaNotConfiguredError, AsaJobNotFoundError, AsaTestNotAvailableError };
});
const { AsaNotConfiguredError, AsaJobNotFoundError } = H;

const client = vi.hoisted(() => ({
  listJobs: vi.fn(),
  getJob: vi.fn(),
  saveTransformation: vi.fn(),
  createOrUpdateInput: vi.fn(),
  deleteInput: vi.fn(),
  createOrUpdateOutput: vi.fn(),
  deleteOutput: vi.fn(),
  startJob: vi.fn(),
  stopJob: vi.fn(),
  compileQuery: vi.fn(),
  testTransformation: vi.fn(),
}));

vi.mock('@/lib/azure/stream-analytics-client', () => ({
  ...client,
  AsaNotConfiguredError: H.AsaNotConfiguredError,
  AsaJobNotFoundError: H.AsaJobNotFoundError,
  AsaTestNotAvailableError: H.AsaTestNotAvailableError,
}));
vi.mock('@/lib/azure/monitor-client', () => ({ fetchMetrics: vi.fn(async () => []) }));
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

import { GET as listGET } from '../route';
import { PUT as inputsPUT, DELETE as inputsDELETE } from '../[name]/inputs/route';
import { PUT as outputsPUT, DELETE as outputsDELETE } from '../[name]/outputs/route';
import { GET as metricsGET } from '../[name]/metrics/route';
import { PUT as queryPUT } from '../[name]/query/route';
import { POST as statePOST } from '../[name]/state/route';
import { getSession } from '@/lib/auth/session';

const SESSION = { claims: { oid: 'oid-1' } } as any;
const params = { params: { name: 'orders-stream' } };

/** A 403 on a deployment whose ASA env vars are set correctly. */
const ARM_403 = () => new Error('ASA get failed 403: AuthorizationFailed');

function jsonReq(body: unknown, url = 'https://loom.test/x') {
  return { url, json: async () => body, nextUrl: new URL(url) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
});

/**
 * name -> [drive the route so its client call rejects with `err`]
 * Each entry returns the Response, so one table drives both the 502 and the
 * 501 assertions.
 */
const ROUTES: Array<{ name: string; run: (err: Error) => Promise<Response> }> = [
  {
    name: 'GET /stream-analytics-job (list)',
    run: async (err) => { client.listJobs.mockRejectedValue(err); return (await listGET()) as any; },
  },
  {
    name: 'PUT /[name]/inputs',
    run: async (err) => {
      client.createOrUpdateInput.mockRejectedValue(err);
      return (await inputsPUT(
        jsonReq({ name: 'in1', inputType: 'Stream', datasourceType: 'Microsoft.EventHub/EventHub', serialization: 'Json' }),
        params,
      )) as any;
    },
  },
  {
    name: 'DELETE /[name]/inputs',
    run: async (err) => {
      client.deleteInput.mockRejectedValue(err);
      return (await inputsDELETE(jsonReq(null, 'https://loom.test/x?inputName=in1'), params)) as any;
    },
  },
  {
    name: 'PUT /[name]/outputs',
    run: async (err) => {
      client.createOrUpdateOutput.mockRejectedValue(err);
      return (await outputsPUT(
        jsonReq({ name: 'out1', datasourceType: 'Microsoft.Storage/Blob' }),
        params,
      )) as any;
    },
  },
  {
    name: 'DELETE /[name]/outputs',
    run: async (err) => {
      client.deleteOutput.mockRejectedValue(err);
      return (await outputsDELETE(jsonReq(null, 'https://loom.test/x?outputName=out1'), params)) as any;
    },
  },
  {
    name: 'GET /[name]/metrics',
    run: async (err) => { client.getJob.mockRejectedValue(err); return (await metricsGET({} as any, params)) as any; },
  },
  {
    name: 'PUT /[name]/query',
    run: async (err) => {
      client.saveTransformation.mockRejectedValue(err);
      return (await queryPUT(jsonReq({ query: 'SELECT 1' }), params)) as any;
    },
  },
  {
    name: 'POST /[name]/state',
    run: async (err) => {
      client.startJob.mockRejectedValue(err);
      return (await statePOST(jsonReq({ action: 'start' }), params)) as any;
    },
  },
];

describe('every ASA route: a generic 502 asserts NO cause (R7)', () => {
  for (const { name, run } of ROUTES) {
    it(`${name} — 502 carries no LOOM_ASA_RG remediation`, async () => {
      const r = await run(ARM_403());
      const j = await r.json();
      expect(r.status).toBe(502);
      expect(j.ok).toBe(false);
      // The ARM error itself must survive — an honest 502 still says what failed.
      expect(String(j.error)).toContain('403');
      // …but it must not assert a cause the code never established.
      expect(j.hint).toBeUndefined();
      expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
      expect(JSON.stringify(j)).not.toContain('enableStreamAnalytics');
    });
  }
});

describe('every ASA route: the 501 honest gate SURVIVES', () => {
  for (const { name, run } of ROUTES) {
    it(`${name} — 501 still names the env vars`, async () => {
      const r = await run(new AsaNotConfiguredError(['LOOM_ASA_RG (or LOOM_DLZ_RG)']));
      const j = await r.json();
      expect(r.status).toBe(501);
      expect(j.hint).toContain('LOOM_ASA_RG');
    });
  }
});

describe('metrics tells a missing job apart from an unclassified failure', () => {
  it('404 + asa-job-not-provisioned, with no env-var remediation', async () => {
    client.getJob.mockRejectedValue(new AsaJobNotFoundError('orders-stream', 'rgAsa', 'sub1'));
    const r = (await metricsGET({} as any, params)) as any;
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-provisioned');
    expect(j.hint).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });

  it('a job with no ARM resource id is a 502 that asserts nothing', async () => {
    client.getJob.mockResolvedValue({ name: 'orders-stream', id: '', location: 'eastus2' });
    const r = (await metricsGET({} as any, params)) as any;
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.hint).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });
});

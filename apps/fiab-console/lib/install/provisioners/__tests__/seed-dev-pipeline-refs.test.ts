/**
 * THE REFERENCE STUBBER MUST NOT OVERWRITE OBJECTS IT DID NOT CREATE.
 * (#3549 review, BLOCKER 1 — a request-body string reaching unconditional PUTs.)
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS PIN
 * ---------------------------------------------------------------------------
 * `ensurePipelineReferences` auto-creates the linked services and datasets a
 * pipeline's activities reference, so the pipeline document validates on
 * commit. It did so with a bare `upsertLinkedService` / `upsertDataset`, and
 * both are ADF/Synapse **PUTs** — create-OR-UPDATE, no existence check.
 *
 * Until #3549 that was contained: the only callers were the two INSTALL
 * provisioners, whose `content` comes from the in-process curated bundle
 * registry. #3549 added `lib/azure/auto-bind-seed`, whose content is
 * `ctx.state.content` — and `POST /api/cosmos-items/[type]` writes `state`
 * VERBATIM from the request body and then calls `autoBindOnCreate`. The names
 * this function PUTs over are therefore caller-authored:
 *
 *   route.ts:76   state: body.state … : {}
 *   route.ts:89   await autoBindOnCreate(resource)
 *   auto-bind-seed.ts   upsertAndRunDevPipeline(adapter, name, content, …)
 *   _seed-dev-pipeline.ts   ensurePipelineReferences(…) → PUT
 *
 * So a user with write access to ONE workspace could POST an `adf-pipeline`
 * whose activities name `SalesDW_Prod` / `ProdOrders`, point `state.factory*`
 * at a shared production factory, and have Loom replace those objects with its
 * own stubs — breaking every pipeline in that factory that references them and,
 * for the dataset, redirecting where a Copy activity lands its data.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH TEST WOULD FAIL ON THE PR HEAD
 * ---------------------------------------------------------------------------
 * On the head every reference is PUT unconditionally, so the pre-existing
 * object in the fake plane is REPLACED by the Loom stub — which is exactly what
 * the "not overwritten" assertions read.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore) — MEASURED,
 * not asserted:
 *   a) Replace the read+verdict body of `ensureReference` with the pre-fix
 *      "always PUT" (`catch { existing = null }` + skip the adoption branch)
 *      → 8 of 12 RED, including all three "not overwritten" tests, both
 *      disclosure tests, the fail-closed test and the 403 authGate test.
 *   b) Make `ensureReference` treat ANY read failure as absent (only the
 *      `catch` widened, adoption branch intact) → 3 RED: the two fail-closed
 *      tests and the 403 authGate test.
 *   c) Drop the `!adapter.getLinkedService || !adapter.getDataset` clause from
 *      the fail-closed guard in `ensurePipelineReferences` → 1 RED, on the
 *      step-log assertion only. The WRITE count does not move, because
 *      `ensureReference`'s own catch fails closed too (a missing method throws
 *      a TypeError, which is not a 404). That redundancy is deliberate, and
 *      the assertion that distinguishes them is the log line: without the
 *      clause the run reports a missing METHOD as a failed service READ.
 *
 * CONTROLS run the opposite direction so the fix cannot overshoot into "never
 * create anything": an absent reference is still created, a Loom-annotated stub
 * is still refreshed, and the activity graph still lands.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  upsertAndRunDevPipeline,
  nullOn404,
  LOOM_AUTOPROVISIONED,
  type DevPipelineAdapter,
  type DevPipelineExistingRef,
} from '../_seed-dev-pipeline';

/** A fake ADF/Synapse artifact plane that stores each object's DOCUMENT. */
class RefPlane {
  linkedServices = new Map<string, DevPipelineExistingRef>();
  datasets = new Map<string, DevPipelineExistingRef>();
  pipelines = new Map<string, unknown>();
  /** Every write attempt, in order — `<kind>:<name>`. */
  writes: string[] = [];
  /** Names whose READ must throw the given error instead of answering. */
  readFailures = new Map<string, Error>();

  reset() {
    this.linkedServices.clear();
    this.datasets.clear();
    this.pipelines.clear();
    this.writes = [];
    this.readFailures.clear();
  }
}

const plane = new RefPlane();

/** An error shaped like the ones both clients throw (`.status` + message). */
function httpError(status: number, label: string): Error {
  return Object.assign(new Error(`${label} failed ${status}: {"error":"x"}`), { status });
}

/**
 * The adapter shape the installer and auto-bind both build — four writes and
 * the two reads that make them safe.
 */
function refAdapter(over: Partial<DevPipelineAdapter> = {}): DevPipelineAdapter {
  return {
    label: 'ADF',
    async upsert(name, properties) {
      plane.writes.push(`pipeline:${name}`);
      plane.pipelines.set(name, properties);
    },
    async createRun() { throw new Error('createRun must not run on the seed path'); },
    async getRunStatus() { return undefined; },
    async upsertLinkedService(name, properties) {
      plane.writes.push(`linkedService:${name}`);
      plane.linkedServices.set(name, { name, properties: properties as never });
    },
    async upsertDataset(name, properties) {
      plane.writes.push(`dataset:${name}`);
      plane.datasets.set(name, { name, properties: properties as never });
    },
    async getLinkedService(name) {
      const fail = plane.readFailures.get(`linkedService:${name}`);
      if (fail) throw fail;
      return plane.linkedServices.get(name) ?? null;
    },
    async getDataset(name) {
      const fail = plane.readFailures.get(`dataset:${name}`);
      if (fail) throw fail;
      return plane.datasets.get(name) ?? null;
    },
    ...over,
  };
}

/**
 * The attacker-shaped content: an ordinary Copy activity whose references name
 * objects that belong to somebody else. This is a legal `state.content` body —
 * nothing about it is rejected before it reaches the stubber.
 */
const HOSTILE_CONTENT = {
  kind: 'adf-pipeline',
  activities: [
    {
      name: 'CopyOrders',
      type: 'Copy',
      config: {
        linkedServiceName: { referenceName: 'SalesDW_Prod', type: 'LinkedServiceReference' },
        inputs: [{ referenceName: 'ProdOrders', type: 'DatasetReference' }],
      },
    },
  ],
};

/** The customer's real linked service — note: NO Loom annotation. */
const CUSTOMER_LS: DevPipelineExistingRef = {
  name: 'SalesDW_Prod',
  properties: {
    type: 'AzureSqlDW',
    typeProperties: { connectionString: 'Server=tcp:salesdw.database.windows.net' },
    annotations: ['owner:finance'],
  } as never,
};

/** The customer's real dataset — a Parquet table, nothing like our stub. */
const CUSTOMER_DS: DevPipelineExistingRef = {
  name: 'ProdOrders',
  properties: {
    type: 'Parquet',
    linkedServiceName: { referenceName: 'SalesDW_Prod', type: 'LinkedServiceReference' },
    typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: 'gold' } },
  } as never,
};

const DBX_KEYS = [
  'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_WORKSPACE_URL',
  'LOOM_DATABRICKS_LINKED_SERVICE', 'LOOM_DATABRICKS_WORKSPACE_RESOURCE_ID',
];
/** `adlsStubUrl()` reads these; clearing them keeps the stub URL deterministic
 *  whatever the developer's shell happens to export. */
const ADLS_KEYS = ['LOOM_LANDING_URL', 'LOOM_BRONZE_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_ADLS_ACCOUNT'];
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  plane.reset();
  for (const k of [...DBX_KEYS, ...ADLS_KEYS]) { saved.set(k, process.env[k]); delete process.env[k]; }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
});

const seed = (adapter: DevPipelineAdapter, content: unknown = HOSTILE_CONTENT) =>
  upsertAndRunDevPipeline(adapter, 'Attacker-Pipeline', content, { skipRun: true });

describe('#3549 BLOCKER 1 — an EXISTING reference is never overwritten', () => {
  it('LEAVES a linked service the customer owns exactly as it was', async () => {
    plane.linkedServices.set('SalesDW_Prod', CUSTOMER_LS);

    const r = await seed(refAdapter());

    // The pipeline itself still landed — the seed is not sabotaged by the guard.
    expect(r.upserted).toBe(true);
    // …but the customer's linked service was NEITHER written nor changed.
    expect(plane.writes).not.toContain('linkedService:SalesDW_Prod');
    expect(plane.linkedServices.get('SalesDW_Prod')).toBe(CUSTOMER_LS);
    expect((plane.linkedServices.get('SalesDW_Prod') as any).properties.type).toBe('AzureSqlDW');
  });

  it('LEAVES a dataset the customer owns exactly as it was', async () => {
    plane.datasets.set('ProdOrders', CUSTOMER_DS);

    const r = await seed(refAdapter());

    expect(r.upserted).toBe(true);
    expect(plane.writes).not.toContain('dataset:ProdOrders');
    expect(plane.datasets.get('ProdOrders')).toBe(CUSTOMER_DS);
    // The Copy activity would otherwise now read a DelimitedText stub pointed at
    // the `landing` container instead of the customer's gold Parquet table.
    expect((plane.datasets.get('ProdOrders') as any).properties.type).toBe('Parquet');
  });

  it('DISCLOSES every adopted reference rather than adopting silently', async () => {
    plane.linkedServices.set('SalesDW_Prod', CUSTOMER_LS);
    plane.datasets.set('ProdOrders', CUSTOMER_DS);

    const r = await seed(refAdapter());

    expect(r.adoptedReferences?.sort()).toEqual(['ProdOrders', 'SalesDW_Prod']);
    // …and in words, on the step log the installer prints.
    const log = r.steps.join('\n');
    expect(log).toContain("linked service 'SalesDW_Prod' already exists and was not created by Loom");
    expect(log).toContain("dataset 'ProdOrders' already exists and was not created by Loom");
    expect(log).toContain('not overwritten');
  });

  it('does NOT write when it cannot establish absence (unknown is not absent)', async () => {
    // A 500 from the factory read: we do not know whether SalesDW_Prod exists.
    plane.readFailures.set('linkedService:SalesDW_Prod', httpError(500, 'getLinkedService(SalesDW_Prod)'));

    const r = await seed(refAdapter());

    expect(plane.writes).not.toContain('linkedService:SalesDW_Prod');
    expect(plane.linkedServices.has('SalesDW_Prod')).toBe(false);
    // And it SAYS it does not know, rather than asserting the object is absent
    // (deploy-integrity.md R7 — an error must not claim what it did not
    // establish).
    expect(r.steps.join('\n')).toContain('NOT overwriting it');
  });

  it('an adapter with the WRITES but not the READS stubs nothing at all', async () => {
    // Fail closed: a reference surface without its existence checks is not a
    // licence to PUT blind — that fallback IS the defect.
    const blind = refAdapter({ getLinkedService: undefined, getDataset: undefined });

    const r = await seed(blind);

    expect(plane.writes.filter((w) => !w.startsWith('pipeline:'))).toEqual([]);
    expect(r.upserted).toBe(true); // the pipeline PUT itself is unaffected
    // It short-circuits at the ADAPTER check rather than limping into
    // `ensureReference` and reporting a missing METHOD as a failed service
    // READ — an error must not assert a cause it did not establish
    // (deploy-integrity.md R7). Removing the getter clause from the fail-closed
    // guard is what puts that false line in the log, which is why this is
    // asserted and not just the write count: writes stay zero either way,
    // because `ensureReference`'s own catch also fails closed. Two independent
    // mechanisms, and only this assertion can tell them apart.
    expect(r.steps.join('\n')).not.toContain('could not read');
  });
});

describe('CONTROL — the guard did not disable reference stubbing', () => {
  it('CREATES a linked service + dataset that are genuinely absent', async () => {
    const r = await seed(refAdapter());

    expect(r.upserted).toBe(true);
    expect(plane.writes).toContain('linkedService:SalesDW_Prod');
    expect(plane.writes).toContain('dataset:ProdOrders');
    expect(r.adoptedReferences).toBeUndefined();
    // The stub we create carries the marker that lets a LATER run recognise it.
    const created = plane.linkedServices.get('SalesDW_Prod') as any;
    expect(created.properties.annotations).toContain(LOOM_AUTOPROVISIONED);
  });

  it('REFRESHES a stub Loom itself created (self-heal, not adoption)', async () => {
    // A stub from a previous install whose ADLS URL has since moved.
    plane.linkedServices.set('SalesDW_Prod', {
      name: 'SalesDW_Prod',
      properties: {
        type: 'AzureBlobFS',
        typeProperties: { url: 'https://old-account.dfs.core.windows.net' },
        annotations: [LOOM_AUTOPROVISIONED],
      } as never,
    });
    process.env.LOOM_ADLS_ACCOUNT = 'newaccount';

    const r = await seed(refAdapter());
    expect(plane.writes).toContain('linkedService:SalesDW_Prod');
    expect((plane.linkedServices.get('SalesDW_Prod') as any).properties.typeProperties.url)
      .toBe('https://newaccount.dfs.core.windows.net');
    // Ours — so it is NOT reported as an adopted foreign object.
    expect(r.adoptedReferences).toBeUndefined();
  });

  it('still lands the ACTIVITY GRAPH when a reference is adopted', async () => {
    // The whole point of the seed (#3549) is the graph. Adopting a reference
    // must not turn a working seed into an empty pipeline.
    plane.linkedServices.set('SalesDW_Prod', CUSTOMER_LS);
    plane.datasets.set('ProdOrders', CUSTOMER_DS);

    const r = await seed(refAdapter());

    expect(r.upserted).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.needsReference).toBeUndefined();
    const stored = plane.pipelines.get('Attacker-Pipeline') as { activities: Array<{ name: string }> };
    expect(stored.activities.map((a) => a.name)).toEqual(['CopyOrders']);
  });

  it('an ADOPTED reference the service REJECTS still becomes an honest gate', async () => {
    // The one case adoption could hide: the customer's object has a shape the
    // pipeline cannot use. We do not guess at that — ADF/Synapse validate
    // references at commit, and their rejection is surfaced verbatim.
    plane.datasets.set('ProdOrders', CUSTOMER_DS);
    const rejecting = refAdapter({
      async upsert() {
        throw httpError(400, "upsertPipeline: invalid reference 'ProdOrders' - parameter 'window' is not defined");
      },
    });

    const r = await seed(rejecting);

    expect(r.upserted).toBe(false);
    expect(r.needsReference?.message).toContain("invalid reference 'ProdOrders'");
    // The disclosure survives the failure path too.
    expect(r.adoptedReferences).toEqual(['ProdOrders']);
  });
});

// ===========================================================================
// THE SUMMARY LINE MUST NOT CLAIM WORK IT DID NOT DO (#3549 review round 2).
//
// The step log ended with `ensured N linked service(s) + M dataset(s)`, counted
// off the REFERENCES the pipeline names rather than off what was written. So a
// run where every read 500'd printed two "NOT overwriting it" lines and then
// "ensured 1 + 1" — an operator reading the install log is told the opposite of
// what happened, directly under the evidence. `deploy-integrity.md` R7: a
// message must not assert what the code did not establish.
//
// MUTATION PROOF (measured): restore the unconditional
// `ensured ${lsList.length} linked service(s) + ${refs.datasets.size} dataset(s)`
// → 2 RED (the two "does not claim" tests).
// ===========================================================================
describe('the reference summary reports VERDICTS, not reference counts', () => {
  it('claims nothing when every read failed and nothing was written', async () => {
    plane.readFailures.set('linkedService:SalesDW_Prod', httpError(500, 'getLinkedService(SalesDW_Prod)'));
    plane.readFailures.set('dataset:ProdOrders', httpError(500, 'getDataset(ProdOrders)'));

    const r = await seed(refAdapter());

    // Ground truth: only the pipeline itself was written.
    expect(plane.writes).toEqual(['pipeline:Attacker-Pipeline']);
    const log = r.steps.join('\n');
    expect(log).not.toMatch(/ensured \d+ linked service/);
    expect(log).toContain('no reference was written');
  });

  it('does not report an ADOPTED reference as one it ensured', async () => {
    plane.linkedServices.set('SalesDW_Prod', CUSTOMER_LS);
    plane.datasets.set('ProdOrders', CUSTOMER_DS);

    const r = await seed(refAdapter());

    const log = r.steps.join('\n');
    expect(log).not.toMatch(/ensured \d+ linked service/);
    expect(log).toContain('2 already present and left untouched');
    expect(log).not.toContain('created or refreshed');
  });

  it('CONTROL — it DOES report what it genuinely created', async () => {
    const r = await seed(refAdapter());

    expect(plane.writes).toContain('linkedService:SalesDW_Prod');
    expect(plane.writes).toContain('dataset:ProdOrders');
    expect(r.steps.join('\n')).toContain('2 created or refreshed');
  });

  it('reports a MIXED run clause by clause', async () => {
    plane.linkedServices.set('SalesDW_Prod', CUSTOMER_LS);          // adopted
    plane.readFailures.set('dataset:ProdOrders', httpError(500, 'getDataset(ProdOrders)')); // blocked

    const r = await seed(refAdapter());
    const log = r.steps.join('\n');

    expect(log).toContain('1 already present and left untouched');
    expect(log).toContain('1 NOT written');
    expect(log).not.toContain('created or refreshed');
  });
});

describe('#3549 BLOCKER 1 — the Databricks linked service gets the same guard', () => {
  it('does NOT overwrite an existing LS a Databricks activity names', async () => {
    // `normalizePipelineContent` takes the activity's OWN referenceName, so the
    // caller chooses which object the AzureDatabricks stub would land on.
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.2.azuredatabricks.net';
    plane.linkedServices.set('SalesDW_Prod', CUSTOMER_LS);

    const r = await seed(refAdapter(), {
      kind: 'adf-pipeline',
      activities: [{
        name: 'RunNotebook',
        type: 'DatabricksNotebook',
        config: {
          notebookPath: '/Shared/x',
          linkedServiceName: { referenceName: 'SalesDW_Prod', type: 'LinkedServiceReference' },
        },
      }],
    });

    expect(plane.writes).not.toContain('linkedService:SalesDW_Prod');
    expect(plane.linkedServices.get('SalesDW_Prod')).toBe(CUSTOMER_LS);
    // The reference RESOLVES (the object is there), so this is not a gate.
    expect(r.upserted).toBe(true);
    expect(r.adoptedReferences).toEqual(['SalesDW_Prod']);
  });

  it('a Databricks LS whose existence cannot be read becomes an honest gate, not a blind PUT', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.2.azuredatabricks.net';
    plane.readFailures.set(
      'linkedService:AzureDatabricks_LinkedService',
      httpError(500, 'getLinkedService(AzureDatabricks_LinkedService)'),
    );

    const r = await seed(refAdapter(), {
      kind: 'adf-pipeline',
      activities: [{ name: 'RunNotebook', type: 'DatabricksNotebook', config: { notebookPath: '/Shared/x' } }],
    });

    expect(plane.writes).toEqual([]); // nothing written — not even the pipeline
    expect(r.upserted).toBe(false);
    expect(r.needsReference?.message).toContain('AzureDatabricks_LinkedService');
  });

  it('a 403 READING the linked service surfaces as an authGate, not a missing reference', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.2.azuredatabricks.net';
    plane.readFailures.set(
      'linkedService:AzureDatabricks_LinkedService',
      httpError(403, 'getLinkedService(AzureDatabricks_LinkedService)'),
    );

    const r = await seed(refAdapter(), {
      kind: 'adf-pipeline',
      activities: [{ name: 'RunNotebook', type: 'DatabricksNotebook', config: { notebookPath: '/Shared/x' } }],
    });

    expect(r.authGate?.status).toBe(403);
    expect(plane.writes).toEqual([]);
  });
});

// ===========================================================================
// `nullOn404` — the chokepoint, tested DIRECTLY (#3549 review round 2).
//
// Every test above drives `ensureReference` through a FAKE adapter whose reads
// return `null` for absent and throw for anything else. The four PRODUCTION
// adapters do not: they call a real client that throws on 404 as well, and
// `nullOn404` is the single translator that decides which throws mean "the name
// is free". So the security property the suite above pins is, in production,
// only as good as this function — and no test above touches it.
//
// Measured before adding these: widening `nullOn404` to
// `if (status !== undefined) return null;` — which re-authorizes the blind PUT
// for ALL FOUR production adapters by reporting every 403 and 500 as "definitely
// absent" — left the suite above at 58/58 and 40/40 GREEN. Two overlapping
// controls hiding each other, one layer below where that same shape was caught.
//
// MUTATION PROOF (measured):
//   a) `if (status !== undefined) return null;`     → 2 RED (403, 500 rethrow)
//   b) `catch { return null }` (swallow everything) → 3 RED (+ the statusless
//      500 case)
//   c) drop the statusless message fallback          → 1 RED (statusless 404)
// ===========================================================================
describe('nullOn404 — only a definite 404 may be reported as absent', () => {
  /** The shape both clients throw: `.status` plus a formatted message. */
  const clientError = (status: number, label = 'getDataset(x)') =>
    Object.assign(new Error(`${label} failed ${status}: {"error":{}}`), { status });

  it('maps a 404 to null — the name is free, so the caller may create', async () => {
    await expect(nullOn404(async () => { throw clientError(404); })).resolves.toBeNull();
  });

  it('RETHROWS a 403 — denied is not absent', async () => {
    // If this leaked through as `null`, `ensureReference` would treat a factory
    // the identity cannot read as an empty name and PUT over whatever is there.
    await expect(nullOn404(async () => { throw clientError(403); })).rejects.toThrow(/failed 403/);
  });

  it('RETHROWS a 500 — a broken control plane is not absent', async () => {
    await expect(nullOn404(async () => { throw clientError(500); })).rejects.toThrow(/failed 500/);
  });

  it('RETHROWS a transport failure that carries no status at all', async () => {
    await expect(nullOn404(async () => { throw new Error('ECONNRESET'); })).rejects.toThrow('ECONNRESET');
  });

  it('reads the status out of the MESSAGE when the error carries none — 404 → null', async () => {
    // Belt-and-braces for a client that formats the status but forgets to
    // attach it. Only consulted when `.status` is absent.
    await expect(
      nullOn404(async () => { throw new Error('getLinkedService(x) failed 404: {"error":{}}'); }),
    ).resolves.toBeNull();
  });

  it('…but a statusless 500 MESSAGE still rethrows', async () => {
    await expect(
      nullOn404(async () => { throw new Error('getLinkedService(x) failed 500: {"error":{}}'); }),
    ).rejects.toThrow(/failed 500/);
  });

  it('a message merely CONTAINING 404 is not a 404 (no substring guessing)', async () => {
    // e.g. a body echoing a path or a correlation id with 404 in it. The needle
    // is `failed 404`, not `404`, so this must still rethrow.
    await expect(
      nullOn404(async () => { throw new Error('getDataset(ds404x) failed 500: upstream said 404 earlier'); }),
    ).rejects.toThrow(/failed 500/);
  });

  it('passes a successful read straight through', async () => {
    const doc = { name: 'x', properties: { annotations: [LOOM_AUTOPROVISIONED] } };
    await expect(nullOn404(async () => doc)).resolves.toBe(doc);
  });

  it('does NOT convert a legitimately null-returning read into a throw', async () => {
    await expect(nullOn404(async () => null)).resolves.toBeNull();
  });
});

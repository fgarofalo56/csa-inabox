import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory fake for the loom-semantic-contract + audit-log containers ──────
interface Doc { id: string; tenantId?: string; docType?: string; status?: string; [k: string]: unknown }

function makeContractContainer() {
  const docs: Doc[] = [];
  const container = {
    __docs: docs,
    items: {
      upsert: vi.fn(async (doc: Doc) => {
        const i = docs.findIndex((d) => d.id === doc.id && d.tenantId === doc.tenantId);
        if (i >= 0) docs[i] = doc; else docs.push(doc);
        return { resource: doc };
      }),
      create: vi.fn(async (doc: Doc) => { docs.push(doc); return { resource: doc }; }),
      query: (spec: { query: string; parameters?: { name: string; value: unknown }[] }) => ({
        fetchAll: async () => {
          const t = spec.parameters?.find((p) => p.name === '@t')?.value;
          const wantMetric = /docType = 'metric'/.test(spec.query);
          const wantVqr = /docType = 'vqr'/.test(spec.query);
          const approvedOnly = /status = 'approved'/.test(spec.query);
          const resources = docs.filter((d) => {
            if (t != null && d.tenantId !== t) return false;
            if (wantMetric && d.docType !== 'metric') return false;
            if (wantVqr && d.docType !== 'vqr') return false;
            if (approvedOnly && d.status !== 'approved') return false;
            return true;
          });
          return { resources };
        },
      }),
    },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: docs.find((d) => d.id === id && d.tenantId === pk) }),
      delete: async () => {
        const i = docs.findIndex((d) => d.id === id && d.tenantId === pk);
        if (i < 0) { const e: any = new Error('not found'); e.code = 404; throw e; }
        docs.splice(i, 1);
        return {};
      },
    }),
  };
  return container;
}

const contractContainer = makeContractContainer();
const auditCreate = vi.fn(async () => ({}));
const auditContainer = { items: { create: (doc: unknown) => ({ catch: () => Promise.resolve(auditCreate(doc)) }) } };
const emitAuditEvent = vi.fn();

vi.mock('../cosmos-client', () => ({
  semanticContractContainer: vi.fn(async () => contractContainer),
  auditLogContainer: vi.fn(async () => auditContainer),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));

import {
  registerMetric, listMetrics, resolveSynonym, matchMetric,
  addVerifiedQuery, approveVerifiedQuery, listVerifiedQueries, matchVerifiedQuery,
  deleteVerifiedQuery, evaluateContract,
} from '../semantic-contract';

const TID = 'owner-oid-1';
const ACTOR = { oid: 'owner-oid-1', who: 'steward@contoso.com', tenantId: 'tenant-1' };

beforeEach(() => {
  contractContainer.__docs.length = 0;
  auditCreate.mockClear();
  emitAuditEvent.mockClear();
});

describe('semantic-contract store — metric registry', () => {
  it('registers a metric and lists it; resolveSynonym + matchMetric key on synonyms', async () => {
    await registerMetric(TID, {
      metricId: 'net_revenue', label: 'Net Revenue', owner: 'Finance',
      description: 'Gross revenue minus returns', synonyms: ['sales', 'top line'],
      grain: 'per order', sourceKind: 'metric-view', sourceRef: 'mv-1',
    });
    const metrics = await listMetrics(TID);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].metricId).toBe('net_revenue');
    expect(metrics[0].synonyms).toContain('top line');

    // synonym index resolves an alternate phrasing to the metric.
    expect((await resolveSynonym(TID, 'sales'))?.metricId).toBe('net_revenue');
    expect((await resolveSynonym(TID, 'Net Revenue'))?.metricId).toBe('net_revenue');
    expect(await resolveSynonym(TID, 'headcount')).toBeNull();

    // a question naming a synonym matches the metric.
    const mm = await matchMetric(TID, 'show me total sales for the quarter');
    expect(mm?.metric.metricId).toBe('net_revenue');
  });

  it('upsert preserves createdAt on re-register (update path)', async () => {
    const first = await registerMetric(TID, {
      metricId: 'aov', label: 'AOV', owner: 'x', description: 'd', grain: 'g',
      sourceKind: 'measure', sourceRef: 'm::AOV',
    });
    const second = await registerMetric(TID, {
      metricId: 'aov', label: 'Average Order Value', owner: 'x', description: 'd2', grain: 'g',
      sourceKind: 'measure', sourceRef: 'm::AOV',
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.label).toBe('Average Order Value');
    expect(await listMetrics(TID)).toHaveLength(1);
  });
});

describe('semantic-contract store — VQR add / approve / match', () => {
  it('adds a DRAFT (not retrieved), approves it (audited) → then it matches', async () => {
    const draft = await addVerifiedQuery(TID, {
      question: 'What was total revenue by region?', query: 'SELECT region, SUM(rev) FROM sales GROUP BY region',
      queryLang: 'sql', sourceName: 'Sales WH',
    });
    expect(draft.status).toBe('draft');
    expect(draft.version).toBe(1);

    // A draft is NEVER retrieved (refuse-not-guess: only approved rows count).
    expect(await matchVerifiedQuery(TID, 'What was total revenue by region?')).toBeNull();

    const approved = await approveVerifiedQuery(TID, draft.id, ACTOR);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('steward@contoso.com');

    // AUDIT: an _auditLog row + emitAuditEvent, kind 'semantic.vqr.approve'.
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ kind: 'semantic.vqr.approve', oid: 'owner-oid-1' });
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'semantic.vqr.approve' }));

    // Now a paraphrase of the approved question retrieves the verified query.
    const hit = await matchVerifiedQuery(TID, 'total revenue by region');
    expect(hit?.vqr.id).toBe(draft.id);
    expect(hit!.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it('re-approving an already-approved VQR bumps the version', async () => {
    const draft = await addVerifiedQuery(TID, {
      question: 'q', query: 'SELECT 1', queryLang: 'sql', sourceName: 'WH',
    });
    const a1 = await approveVerifiedQuery(TID, draft.id, ACTOR);
    expect(a1.version).toBe(1);
    const a2 = await approveVerifiedQuery(TID, draft.id, ACTOR);
    expect(a2.version).toBe(2);
  });

  it('deleteVerifiedQuery removes the row', async () => {
    const draft = await addVerifiedQuery(TID, { question: 'q', query: 'SELECT 1', queryLang: 'sql', sourceName: 'WH' });
    expect(await deleteVerifiedQuery(TID, draft.id)).toBe(true);
    expect(await listVerifiedQueries(TID)).toHaveLength(0);
    expect(await deleteVerifiedQuery(TID, draft.id)).toBe(false);
  });
});

describe('evaluateContract — verified-first / metric / refuse / none', () => {
  it('returns none when the owner adopted nothing (non-breaking)', async () => {
    expect((await evaluateContract(TID, 'anything at all')).mode).toBe('none');
    expect((await evaluateContract(undefined, 'q')).mode).toBe('none');
  });

  it('retrieves a verified query FIRST (mode verified)', async () => {
    const d = await addVerifiedQuery(TID, {
      question: 'What was total revenue by region?', query: 'SELECT 1', queryLang: 'sql', sourceName: 'WH',
    });
    await approveVerifiedQuery(TID, d.id, ACTOR);
    const dec = await evaluateContract(TID, 'total revenue by region');
    expect(dec.mode).toBe('verified');
    if (dec.mode === 'verified') expect(dec.vqr.id).toBe(d.id);
  });

  it('grounds an unmatched-but-in-contract question on a metric (mode metric)', async () => {
    await registerMetric(TID, {
      metricId: 'churn_rate', label: 'Churn Rate', owner: 'x',
      description: 'Fraction of customers lost', synonyms: ['attrition'], grain: 'monthly',
      sourceKind: 'metric-view', sourceRef: 'mv-2',
    });
    const dec = await evaluateContract(TID, 'break down churn by segment please');
    expect(dec.mode).toBe('metric');
    if (dec.mode === 'metric') expect(dec.metric.metricId).toBe('churn_rate');
  });

  it('REFUSES an out-of-contract question when a contract IS in force (refuse-not-guess)', async () => {
    // Contract active (a metric exists) but the question references nothing in it.
    await registerMetric(TID, {
      metricId: 'net_revenue', label: 'Net Revenue', owner: 'x', description: 'd',
      synonyms: ['sales'], grain: 'per order', sourceKind: 'metric-view', sourceRef: 'mv-1',
    });
    const dec = await evaluateContract(TID, 'how tall is the eiffel tower');
    expect(dec.mode).toBe('refuse');
    if (dec.mode === 'refuse') expect(dec.metricLabels).toContain('Net Revenue');
  });
});

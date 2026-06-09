/**
 * aas-client — connected-metric DAX scalar evaluation.
 *
 * The default path wraps the Power BI executeQueries REST runner; we mock that
 * boundary and assert the scalar-extraction contract + error mapping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const execMock = vi.fn();

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('../powerbi-client', () => {
  class PowerBiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.name = 'PowerBiError'; this.status = status; }
  }
  return {
    PowerBiError,
    executeDatasetQueries: (...args: any[]) => execMock(...args),
  };
});

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; vi.clearAllMocks(); });
beforeEach(() => { delete process.env.LOOM_AAS_SERVER; delete process.env.LOOM_METRIC_BACKEND; });

const metric = { workspaceId: 'ws1', datasetId: 'ds1', daxExpression: '[Total Revenue]' };

describe('evaluateDaxScalar', () => {
  it('extracts the first-row [Value] from an executeQueries response', async () => {
    execMock.mockResolvedValue({ results: [{ tables: [{ rows: [{ '[Value]': 1234.5 }] }] }] });
    const { evaluateDaxScalar } = await import('../aas-client');
    const v = await evaluateDaxScalar(metric);
    expect(v).toBe(1234.5);
    // The query wraps the expression in EVALUATE ROW("Value", <expr>).
    const [, , query] = execMock.mock.calls[0];
    expect(query).toBe('EVALUATE ROW("Value", [Total Revenue])');
  });

  it('returns null when the result set is empty', async () => {
    execMock.mockResolvedValue({ results: [{ tables: [{ rows: [] }] }] });
    const { evaluateDaxScalar } = await import('../aas-client');
    expect(await evaluateDaxScalar(metric)).toBeNull();
  });

  it('falls back to the first column when [Value] is absent', async () => {
    execMock.mockResolvedValue({ results: [{ tables: [{ rows: [{ 'Measure': 42 }] }] }] });
    const { evaluateDaxScalar } = await import('../aas-client');
    expect(await evaluateDaxScalar(metric)).toBe(42);
  });

  it('throws AasError(422) on a non-numeric value', async () => {
    execMock.mockResolvedValue({ results: [{ tables: [{ rows: [{ '[Value]': 'abc' }] }] }] });
    const { evaluateDaxScalar, AasError } = await import('../aas-client');
    await expect(evaluateDaxScalar(metric)).rejects.toBeInstanceOf(AasError);
    await expect(evaluateDaxScalar(metric)).rejects.toMatchObject({ status: 422 });
  });

  it('maps a PowerBiError to an AasError carrying the same status', async () => {
    const { PowerBiError } = await import('../powerbi-client');
    execMock.mockRejectedValue(new (PowerBiError as any)('forbidden', 403));
    const { evaluateDaxScalar, AasError } = await import('../aas-client');
    const err = await evaluateDaxScalar(metric).catch((e) => e);
    expect(err).toBeInstanceOf(AasError);
    expect(err.status).toBe(403);
    expect(err.remediation).toMatch(/service principal|workspace/i);
  });

  it('rejects an incomplete metric binding', async () => {
    const { evaluateDaxScalar, AasError } = await import('../aas-client');
    const err = await evaluateDaxScalar({ workspaceId: '', datasetId: 'ds', daxExpression: 'x' } as any).catch((e) => e);
    expect(err).toBeInstanceOf(AasError);
    expect(err.status).toBe(400);
  });

  it('gates the standalone-AAS XMLA path honestly with 503', async () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus2.asazure.windows.net/loom';
    process.env.LOOM_METRIC_BACKEND = 'aas-xmla';
    const { evaluateDaxScalar, AasError } = await import('../aas-client');
    const err = await evaluateDaxScalar(metric).catch((e) => e);
    expect(err).toBeInstanceOf(AasError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('aas_xmla_not_supported');
    expect(execMock).not.toHaveBeenCalled();
  });
});

/**
 * report.test.ts — `loom report validate` exit-code contract (N16 CI hook).
 *
 * The whole point of the command is a REAL CI gate: it must resolve (exit 0)
 * only when the server reports the report valid, and throw a CliError (→ the CLI
 * maps it to a non-zero exit) on any validation error or a missing file. A fake
 * pass is exactly what this test forbids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFileMock = vi.fn();
vi.mock('node:fs', () => ({ promises: { readFile: (...a: unknown[]) => readFileMock(...a) } }));

const requestMock = vi.fn();
vi.mock('../src/commands/context.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/commands/context.js');
  return {
    ...actual,
    requireAuth: vi.fn(async () => ({ client: { request: requestMock }, apiUrl: 'http://x', output: 'table' })),
  };
});

import { runReport } from '../src/commands/report.js';
import { CliError } from '../src/errors.js';

beforeEach(() => {
  readFileMock.mockReset();
  requestMock.mockReset();
});

const args = (positionals: string[], flags: Record<string, string | boolean> = {}) => ({ positionals, flags });

describe('loom report validate', () => {
  it('resolves (exit 0) when the server reports the report valid', async () => {
    readFileMock.mockResolvedValue('# ok\n\n```sql q\nSELECT 1\n```\n{table query=q}');
    requestMock.mockResolvedValue({ ok: true, valid: true, errors: [], warnings: [], queries: [{ name: 'q', kind: 'raw' }], visualCount: 1 });

    await expect(runReport('validate', args(['report.md']), {})).resolves.toBeUndefined();
    expect(requestMock).toHaveBeenCalledWith('POST', '/api/items/code-report/validate', expect.objectContaining({ source: expect.stringContaining('SELECT 1') }));
  });

  it('throws CliError (non-zero exit) when the server reports errors', async () => {
    readFileMock.mockResolvedValue('```sql loom m\nmetric: ghost\n```');
    requestMock.mockResolvedValue({
      ok: false, valid: false,
      errors: [{ message: 'Metric "ghost" is not defined in the governed spec.', query: 'm' }],
      warnings: [], queries: [{ name: 'm', kind: 'metric' }],
    });

    await expect(runReport('validate', args(['report.md']), {})).rejects.toBeInstanceOf(CliError);
  });

  it('throws CliError when the file cannot be read', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    await expect(runReport('validate', args(['missing.md']), {})).rejects.toThrow(/Cannot read/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('requires a file argument', async () => {
    await expect(runReport('validate', args([]), {})).rejects.toThrow(/Usage: loom report validate/);
  });

  it('forwards the --engine flag to the server', async () => {
    readFileMock.mockResolvedValue('# r');
    requestMock.mockResolvedValue({ ok: true, valid: true, errors: [], warnings: [], queries: [], visualCount: 0 });
    await runReport('validate', args(['r.md'], { engine: 'adx' }), {});
    expect(requestMock).toHaveBeenCalledWith('POST', '/api/items/code-report/validate', expect.objectContaining({ engine: 'adx' }));
  });

  it('rejects an unknown subcommand', async () => {
    await expect(runReport('bogus', args([]), {})).rejects.toThrow(/Unknown report subcommand/);
  });
});

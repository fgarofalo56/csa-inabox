/**
 * In-cell Copilot command helpers — node-env unit tests.
 *
 * Pure logic (no DOM): slash-command parsing + result-cell construction that
 * back the per-cell Copilot popover. The popover render wiring is covered by
 * code-cell-copilot.test.tsx (jsdom).
 */
import { describe, it, expect } from 'vitest';
import { parseCopilotCommand, copilotResultCell } from '../copilot-commands';

describe('parseCopilotCommand', () => {
  it('maps /explain to explain mode', () => {
    expect(parseCopilotCommand('/explain')).toEqual({ mode: 'explain', prompt: '' });
  });

  it('maps /fix to fix mode', () => {
    expect(parseCopilotCommand('  /fix  ')).toEqual({ mode: 'fix', prompt: '' });
  });

  it('maps /generate <text> to generate with the residual prompt', () => {
    expect(parseCopilotCommand('/generate a cell that reads bronze.orders')).toEqual({
      mode: 'generate',
      prompt: 'a cell that reads bronze.orders',
    });
  });

  it('treats free-form text as generate', () => {
    expect(parseCopilotCommand('count rows in silver.sales')).toEqual({
      mode: 'generate',
      prompt: 'count rows in silver.sales',
    });
  });

  it('maps /comments to comments mode', () => {
    expect(parseCopilotCommand('/comments')).toEqual({ mode: 'comments', prompt: '' });
  });

  it('maps /optimize to optimize mode', () => {
    expect(parseCopilotCommand('/optimize')).toEqual({ mode: 'optimize', prompt: '' });
  });
});

describe('copilotResultCell', () => {
  it('builds a markdown explanation cell for explain', () => {
    const cell = copilotResultCell('explain', 'pyspark', 'It reads a Delta table.');
    expect(cell.type).toBe('markdown');
    expect(cell.source).toBe('## Copilot explanation\n\nIt reads a Delta table.');
    expect(cell.lang).toBeUndefined();
  });

  it('builds a code cell in the source language for generate', () => {
    const cell = copilotResultCell('generate', 'sparksql', 'SELECT * FROM gold.kpi');
    expect(cell.type).toBe('code');
    expect(cell.lang).toBe('sparksql');
    expect(cell.source).toBe('SELECT * FROM gold.kpi');
  });

  it('builds a code cell for fix', () => {
    const cell = copilotResultCell('fix', 'pyspark', "df = spark.read.table('bronze.orders')");
    expect(cell.type).toBe('code');
    expect(cell.lang).toBe('pyspark');
    expect(cell.source).toContain('bronze.orders');
  });

  it('builds a code cell in the source language for comments', () => {
    const cell = copilotResultCell('comments', 'pyspark', '# read orders\ndf = spark.read.table("t")');
    expect(cell.type).toBe('code');
    expect(cell.lang).toBe('pyspark');
    expect(cell.source).toContain('# read orders');
  });

  it('builds a code cell in the source language for optimize', () => {
    const cell = copilotResultCell('optimize', 'sparksql', 'SELECT * FROM gold.kpi');
    expect(cell.type).toBe('code');
    expect(cell.lang).toBe('sparksql');
    expect(cell.source).toBe('SELECT * FROM gold.kpi');
  });
});

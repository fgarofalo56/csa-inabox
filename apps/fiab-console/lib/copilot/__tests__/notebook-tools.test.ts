/**
 * In-cell Copilot tooling — node-env unit tests.
 *
 * Pure logic (no DOM, no Azure SDK): slash-command parsing, the insert-below vs
 * approval-diff routing decision, and the canonical AOAI message builder shared
 * by the popover (code-cell.tsx) and the BFF route (assist/route.ts). The
 * popover render wiring is covered by code-cell-copilot.test.tsx (jsdom).
 */
import { describe, it, expect } from 'vitest';
import { parseInCellCommand, inCellResultAction, buildAssistMessages } from '../notebook-tools';

describe('parseInCellCommand', () => {
  it('maps /explain to explain mode', () => {
    expect(parseInCellCommand('/explain')).toEqual({ mode: 'explain', prompt: '' });
  });
  it('maps /fix (with surrounding text) to fix mode + residual prompt', () => {
    expect(parseInCellCommand('/fix with some context')).toEqual({ mode: 'fix', prompt: 'with some context' });
  });
  it('maps /comments to comments mode', () => {
    expect(parseInCellCommand('/comments')).toEqual({ mode: 'comments', prompt: '' });
  });
  it('maps /optimize to optimize mode', () => {
    expect(parseInCellCommand('  /optimize  ')).toEqual({ mode: 'optimize', prompt: '' });
  });
  it('maps /generate <text> to generate with the residual prompt', () => {
    expect(parseInCellCommand('/generate a cell that reads bronze.orders')).toEqual({
      mode: 'generate', prompt: 'a cell that reads bronze.orders',
    });
  });
  it('treats free-form text as generate', () => {
    expect(parseInCellCommand('convert to a function')).toEqual({ mode: 'generate', prompt: 'convert to a function' });
  });
});

describe('inCellResultAction', () => {
  it('explain inserts a new cell below', () => {
    expect(inCellResultAction('explain', '')).toBe('insert-below');
  });
  it('fix proposes an in-place edit', () => {
    expect(inCellResultAction('fix', '')).toBe('propose-edit');
  });
  it('comments proposes an in-place edit', () => {
    expect(inCellResultAction('comments', '')).toBe('propose-edit');
  });
  it('optimize proposes an in-place edit', () => {
    expect(inCellResultAction('optimize', '')).toBe('propose-edit');
  });
  it('a free-form refactor ("convert to a function") proposes an in-place edit', () => {
    expect(inCellResultAction('generate', 'convert to a function')).toBe('propose-edit');
  });
  it('"refactor this cell" proposes an in-place edit', () => {
    expect(inCellResultAction('generate', 'refactor this cell into helpers')).toBe('propose-edit');
  });
  it('a free-form generation of a NEW cell inserts below', () => {
    expect(inCellResultAction('generate', 'write a cell that reads bronze.orders')).toBe('insert-below');
  });
});

describe('buildAssistMessages', () => {
  it('comments: system prompt asks for commented code, returns 2 messages with the source', () => {
    const msgs = buildAssistMessages('comments', 'pyspark', 'df = spark.read.table("t")', '', '', '');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content.toLowerCase()).toContain('comment');
    expect(msgs[0].content).toContain('ONLY');
    expect(msgs[1].content).toContain('df = spark.read.table("t")');
  });
  it('optimize: system prompt mentions broadcast / push-down performance guidance', () => {
    const msgs = buildAssistMessages('optimize', 'pyspark', 'df1.join(df2, "k")', '', '', '');
    expect(msgs[0].content).toContain('broadcast');
    expect(msgs[0].content.toLowerCase()).toContain('push down');
  });
  it('fix: user message embeds the real error text', () => {
    const msgs = buildAssistMessages('fix', 'pyspark', 'print(df)', '', "NameError: name 'df' is not defined", '');
    expect(msgs[1].content).toContain("NameError: name 'df' is not defined");
  });
  it('generate refactor: includes the current cell when source is present', () => {
    const msgs = buildAssistMessages('generate', 'pyspark', 'x = 1', 'convert to a function', '', '');
    expect(msgs[1].content).toContain('convert to a function');
    expect(msgs[1].content).toContain('x = 1');
  });
  it('explain: returns prose-only instruction (no fenced-code demand)', () => {
    const msgs = buildAssistMessages('explain', 'sparksql', 'SELECT 1', '', '', '');
    expect(msgs[0].content.toLowerCase()).toContain('explain');
    expect(msgs[0].content.toLowerCase()).toContain('plain prose');
  });
  it('threads the schema context into the system prompt when supplied', () => {
    const msgs = buildAssistMessages('comments', 'pyspark', 'df = 1', '', '', 'Bronze ADLS container: abfss://bronze@acct');
    expect(msgs[0].content).toContain('abfss://bronze@acct');
  });
});

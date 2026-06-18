/**
 * In-cell Copilot tooling — node-env unit tests.
 *
 * Pure logic (no DOM, no Azure SDK): slash-command parsing, the insert-below vs
 * approval-diff routing decision, and the canonical AOAI message builder shared
 * by the popover (code-cell.tsx) and the BFF route (assist/route.ts). The
 * popover render wiring is covered by code-cell-copilot.test.tsx (jsdom).
 */
import { describe, it, expect } from 'vitest';
import { parseInCellCommand, inCellResultAction, buildAssistMessages, assistRuntimeDirective } from '../notebook-tools';

describe('assistRuntimeDirective + buildAssistMessages runtime threading', () => {
  it('injects the Databricks directive into the generate system prompt', () => {
    const msgs = buildAssistMessages('generate', 'pyspark', '', 'read a table', '', '', 'databricks');
    expect(msgs[0].content).toMatch(/Databricks Spark/);
    expect(msgs[0].content).toMatch(/dbutils/);
    expect(msgs[0].content).not.toMatch(/mssparkutils/);
  });
  it('injects the Azure ML directive (SDK v2, no Spark) into the fix system prompt', () => {
    const msgs = buildAssistMessages('fix', 'python', 'x=1', '', 'NameError', '', 'azure-ml');
    expect(msgs[0].content).toMatch(/azure\.ai\.ml/);
    expect(msgs[0].content).toMatch(/no implicit Spark session|NO implicit Spark/i);
  });
  it('defaults to Synapse Spark directive when runtime is absent (back-compat)', () => {
    const msgs = buildAssistMessages('explain', 'pyspark', 'df.show()', '', '', '');
    expect(msgs[0].content).toMatch(/Synapse Spark/);
    expect(msgs[0].content).toMatch(/mssparkutils/);
  });
  it('assistRuntimeDirective names the correct APIs per runtime', () => {
    expect(assistRuntimeDirective('databricks')).toMatch(/dbutils/);
    expect(assistRuntimeDirective('synapse-spark')).toMatch(/mssparkutils/);
    expect(assistRuntimeDirective('azure-ml')).toMatch(/automl/);
    expect(assistRuntimeDirective(undefined)).toMatch(/Synapse Spark/);
  });
});

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

/**
 * Unit tests for the pure "Fix with Copilot" cell-error helpers
 * (lib/copilot/notebook-tools.ts). No network, no Azure — pure functions.
 *
 * Covers: buildCellFixMessages (JSON-instruction system prompt, verbatim error
 * fields, execution-details block presence/omission, language labels) and
 * parseCellFixResponse (structured JSON, embedded fences, malformed JSON
 * fallback, missing proposedCode, empty input) + stripCodeFences.
 */
import {
  buildCellFixMessages,
  parseCellFixResponse,
  stripCodeFences,
  CELL_FIX_LANG_LABEL,
} from '@/lib/copilot/notebook-tools';

describe('buildCellFixMessages', () => {
  const base = {
    cellSource: 'df.select("nonexistent_col")',
    lang: 'pyspark',
    errorContext: {
      ename: 'AnalysisException',
      evalue: 'Resolved attribute(s) missing from child',
      traceback: ['Traceback (most recent call last):', 'AnalysisException: missing'],
    },
  };

  it('system message instructs the model to answer with JSON keys', () => {
    const [sys] = buildCellFixMessages(base);
    expect(sys.role).toBe('system');
    expect(sys.content).toMatch(/valid JSON object/i);
    expect(sys.content).toContain('"summary"');
    expect(sys.content).toContain('"rootCause"');
    expect(sys.content).toContain('"proposedCode"');
  });

  it('user message contains the cell source and verbatim error fields', () => {
    const [, user] = buildCellFixMessages(base);
    expect(user.role).toBe('user');
    expect(user.content).toContain('df.select("nonexistent_col")');
    expect(user.content).toContain('AnalysisException');
    expect(user.content).toContain('Resolved attribute(s) missing from child');
    expect(user.content).toContain('Traceback (most recent call last):');
  });

  it('includes execution details when present', () => {
    const [, user] = buildCellFixMessages({
      ...base,
      executionDetails: {
        executionCount: 3,
        durationMs: 4210,
        executedAtUtc: '2026-06-09T00:00:00Z',
        sessionPool: 'loompool',
      },
    });
    expect(user.content).toContain('Execution count: 3');
    expect(user.content).toContain('Duration: 4210 ms');
    expect(user.content).toContain('Executed at (UTC): 2026-06-09T00:00:00Z');
    expect(user.content).toContain('Spark pool: loompool');
  });

  it('omits the execution-details block when all details are undefined', () => {
    const [, user] = buildCellFixMessages({ ...base, executionDetails: {} });
    expect(user.content).not.toContain('Execution details:');
  });

  it('omits the execution-details block when no executionDetails at all', () => {
    const [, user] = buildCellFixMessages(base);
    expect(user.content).not.toContain('Execution details:');
  });

  it('maps every supported language label', () => {
    for (const lang of Object.keys(CELL_FIX_LANG_LABEL)) {
      const [sys] = buildCellFixMessages({ ...base, lang });
      expect(sys.content).toContain(CELL_FIX_LANG_LABEL[lang]);
    }
  });

  it('falls back to the raw lang id for an unknown language', () => {
    const [sys] = buildCellFixMessages({ ...base, lang: 'kotlin' });
    expect(sys.content).toContain('kotlin');
  });
});

describe('parseCellFixResponse', () => {
  it('extracts all three fields from a valid JSON object', () => {
    const raw = JSON.stringify({
      summary: 'The column does not exist.',
      rootCause: "Typo in the column name 'nonexistent_col'.",
      proposedCode: 'df.select("existing_col")',
    });
    const r = parseCellFixResponse(raw);
    expect(r.summary).toBe('The column does not exist.');
    expect(r.rootCause).toBe("Typo in the column name 'nonexistent_col'.");
    expect(r.proposedCode).toBe('df.select("existing_col")');
  });

  it('strips a ```json fence the model wraps the JSON in', () => {
    const raw = '```json\n' + JSON.stringify({
      summary: 's', rootCause: 'r', proposedCode: 'print(1)',
    }) + '\n```';
    const r = parseCellFixResponse(raw);
    expect(r.proposedCode).toBe('print(1)');
    expect(r.summary).toBe('s');
  });

  it('strips fences embedded inside the proposedCode field', () => {
    const raw = JSON.stringify({
      summary: 's', rootCause: 'r', proposedCode: '```python\nprint(1)\n```',
    });
    const r = parseCellFixResponse(raw);
    expect(r.proposedCode).toBe('print(1)');
    expect(r.proposedCode).not.toContain('```');
  });

  it('falls back to raw-code when the reply is not JSON', () => {
    const raw = '```python\nundefined_var = 1\nprint(undefined_var)\n```';
    const r = parseCellFixResponse(raw);
    expect(r.proposedCode).toBe('undefined_var = 1\nprint(undefined_var)');
    expect(r.summary).toMatch(/could not be parsed/i);
    expect(r.rootCause).toBe('');
  });

  it('falls back when JSON is missing the proposedCode field', () => {
    const raw = JSON.stringify({ summary: 's', rootCause: 'r' });
    const r = parseCellFixResponse(raw);
    // The whole JSON string becomes the proposed code (honest fallback).
    expect(r.summary).toMatch(/could not be parsed/i);
    expect(r.proposedCode).toContain('summary');
  });

  it('returns empty proposedCode for empty input', () => {
    const r = parseCellFixResponse('');
    expect(r.proposedCode).toBe('');
  });
});

describe('stripCodeFences', () => {
  it('strips a leading ```python fence and trailing ``` and trims', () => {
    expect(stripCodeFences('```python\nprint(1)\n```')).toBe('print(1)');
  });

  it('passes through a string with no fences unchanged (trimmed)', () => {
    expect(stripCodeFences('  print(1)  ')).toBe('print(1)');
  });

  it('handles a bare ``` opening fence', () => {
    expect(stripCodeFences('```\nx = 1\n```')).toBe('x = 1');
  });
});

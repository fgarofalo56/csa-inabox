import { describe, it, expect } from 'vitest';
import {
  buildInlineMessages,
  cleanInlineCompletion,
  INLINE_LANG_LABEL,
} from '../inline-complete-prompt';

describe('buildInlineMessages', () => {
  it('puts the prefix at the end of the user message', () => {
    const msgs = buildInlineMessages('# read csv into df\n', 'pyspark', [], '');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content.endsWith('# read csv into df\n')).toBe(true);
  });

  it('names the language label in the system prompt', () => {
    const msgs = buildInlineMessages('x', 'sparksql', [], '');
    expect(msgs[0].content).toContain(INLINE_LANG_LABEL.sparksql);
    expect(msgs[0].content).toContain('Spark SQL');
  });

  it('falls back to the raw lang when unknown', () => {
    const msgs = buildInlineMessages('x', 'brainfuck', [], '');
    expect(msgs[0].content).toContain('brainfuck');
  });

  it('includes up to 3 prior cells (oldest first), dropping older ones', () => {
    const prior = ['cell1', 'cell2', 'cell3', 'cell4'];
    const msgs = buildInlineMessages('cur', 'pyspark', prior, '');
    const user = msgs[1].content;
    expect(user).not.toContain('cell1'); // sliced to last 3
    expect(user).toContain('cell2');
    expect(user).toContain('cell3');
    expect(user).toContain('cell4');
    expect(user).toContain('--- current cell ---');
    expect(user.endsWith('cur')).toBe(true);
  });

  it('omits empty/whitespace prior cells', () => {
    const msgs = buildInlineMessages('cur', 'pyspark', ['  ', '', 'real'], '');
    const user = msgs[1].content;
    expect(user).toContain('real');
    // No leading "previous cell" separator when only one real cell.
    expect(user.indexOf('--- previous cell ---')).toBe(-1);
  });

  it('embeds schema context only when present', () => {
    const without = buildInlineMessages('x', 'pyspark', [], '');
    expect(without[0].content).not.toContain('schema context');
    const withSchema = buildInlineMessages('x', 'pyspark', [], 'bronze.orders(id, ts)');
    expect(withSchema[0].content).toContain('bronze.orders(id, ts)');
  });
});

describe('cleanInlineCompletion', () => {
  it('strips a leading/trailing markdown fence', () => {
    expect(cleanInlineCompletion('```python\ndf = 1\n```', '')).toBe('df = 1');
  });

  it('trims an overlap where the model echoed the tail of the prefix', () => {
    // prefix ends with "df = spark.read", model repeated "spark.read.csv(...)"
    const prefix = 'df = spark.read';
    const raw = 'spark.read.csv("/data/in.csv", header=True)';
    const out = cleanInlineCompletion(raw, prefix);
    expect(out).toBe('.csv("/data/in.csv", header=True)');
  });

  it('leaves a non-overlapping completion intact', () => {
    const prefix = '# read csv into df\n';
    const raw = 'df = spark.read.csv("/lake/in.csv", header=True)';
    expect(cleanInlineCompletion(raw, prefix)).toBe(raw);
  });

  it('returns an empty string unchanged', () => {
    expect(cleanInlineCompletion('', 'anything')).toBe('');
  });
});

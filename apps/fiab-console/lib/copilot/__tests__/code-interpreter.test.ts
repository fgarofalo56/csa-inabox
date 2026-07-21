/**
 * Unit tests for lib/copilot/code-interpreter.ts — pure logic only.
 * No azure clients, no network, no env-vars.
 */
import { describe, it, expect } from 'vitest';
import {
  extractPythonProposal,
  extractPythonProposals,
  wrapUserCode,
  parseInterpreterOutput,
  formatElapsed,
  SANDBOX_TIMEOUT_S,
  SANDBOX_MAX_STDOUT_BYTES,
  SANDBOX_MAX_CHARTS,
  SANDBOX_MAX_CHART_BYTES,
} from '../code-interpreter';

// ---------------------------------------------------------------------------
// extractPythonProposal / extractPythonProposals
// ---------------------------------------------------------------------------

describe('extractPythonProposals', () => {
  it('extracts a single python block', () => {
    const text = 'Here is the code:\n```python\nprint("hello")\n```\nDone.';
    expect(extractPythonProposals(text)).toEqual(['print("hello")']);
  });

  it('extracts multiple python blocks', () => {
    const text = '```python\na=1\n```\nThen:\n```python\nb=2\n```';
    expect(extractPythonProposals(text)).toEqual(['a=1', 'b=2']);
  });

  it('returns [] when no python block', () => {
    expect(extractPythonProposals('just text')).toEqual([]);
  });

  it('ignores non-python fenced blocks', () => {
    const text = '```sql\nSELECT 1\n```';
    expect(extractPythonProposals(text)).toEqual([]);
  });

  it('is case-insensitive for python keyword', () => {
    const text = '```Python\nprint(1)\n```';
    expect(extractPythonProposals(text)).toEqual(['print(1)']);
  });
});

describe('extractPythonProposal', () => {
  it('returns the first proposal', () => {
    const text = '```python\nfirst\n```\n```python\nsecond\n```';
    expect(extractPythonProposal(text)).toBe('first');
  });

  it('returns null when none', () => {
    expect(extractPythonProposal('no code here')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wrapUserCode
// ---------------------------------------------------------------------------

describe('wrapUserCode', () => {
  it('produces a string containing the base64-encoded user code', () => {
    const code = 'print("hello")';
    const wrapped = wrapUserCode(code);
    const b64 = Buffer.from(code, 'utf8').toString('base64');
    expect(wrapped).toContain(b64);
  });

  it('includes a threading.Timer with the configured timeout', () => {
    const wrapped = wrapUserCode('x=1', { timeoutS: 30 });
    expect(wrapped).toContain('threading.Timer(30,');
  });

  it('uses SANDBOX_TIMEOUT_S by default', () => {
    const wrapped = wrapUserCode('x=1');
    expect(wrapped).toContain(`threading.Timer(${SANDBOX_TIMEOUT_S},`);
  });

  it('includes stdout capture (io.StringIO)', () => {
    const wrapped = wrapUserCode('x=1');
    expect(wrapped).toContain('io.StringIO()');
  });

  it('includes matplotlib Agg backend setup', () => {
    const wrapped = wrapUserCode('x=1');
    expect(wrapped).toContain("matplotlib.use('Agg')");
  });

  it('handles code with triple-quotes safely (base64 encoding)', () => {
    const code = 'x = """triple quotes"""';
    const wrapped = wrapUserCode(code);
    const b64 = Buffer.from(code, 'utf8').toString('base64');
    expect(wrapped).toContain(b64);
    // The literal triple quotes should NOT appear unescaped in the wrapper
    expect(wrapped).not.toContain('triple quotes');
  });

  it('uses custom maxStdoutBytes in the truncation guard', () => {
    const wrapped = wrapUserCode('x=1', { maxStdoutBytes: 1024 });
    expect(wrapped).toContain('1024');
  });
});

// ---------------------------------------------------------------------------
// parseInterpreterOutput
// ---------------------------------------------------------------------------

describe('parseInterpreterOutput', () => {
  it('returns ok output with stdout', () => {
    const out = parseInterpreterOutput({ status: 'ok', textPlain: 'hello\n' });
    expect(out.status).toBe('ok');
    expect(out.stdout).toBe('hello\n');
    expect(out.charts).toEqual([]);
  });

  it('returns error output with fields', () => {
    const out = parseInterpreterOutput({
      status: 'error',
      textPlain: '',
      ename: 'ValueError',
      evalue: 'bad value',
      traceback: ['Traceback…', '  line 1'],
    });
    expect(out.status).toBe('error');
    expect(out.ename).toBe('ValueError');
    expect(out.evalue).toBe('bad value');
    expect(out.traceback).toHaveLength(2);
  });

  it('collects chart image from imageBase64', () => {
    const img = 'abc123'; // not real PNG but fine for the test
    const out = parseInterpreterOutput({ status: 'ok', imageBase64: img });
    expect(out.charts).toEqual([img]);
  });

  it('accumulates charts via chartAccum', () => {
    const accum: string[] = ['img1'];
    const out = parseInterpreterOutput({ status: 'ok', imageBase64: 'img2' }, accum);
    expect(out.charts).toEqual(['img1', 'img2']);
  });

  it('caps charts at SANDBOX_MAX_CHARTS', () => {
    const accum = ['a', 'b', 'c']; // already at max
    const out = parseInterpreterOutput({ status: 'ok', imageBase64: 'should-not-add' }, accum);
    expect(out.charts).toHaveLength(SANDBOX_MAX_CHARTS);
    expect(out.charts).not.toContain('should-not-add');
  });

  it('ignores chart that exceeds SANDBOX_MAX_CHART_BYTES', () => {
    // Base64 of a string longer than 5 MB (the actual bytes after decode would
    // be ~3.75 MB for 5 MB of base64, so we use length check — the guard in
    // parseInterpreterOutput uses Buffer.byteLength for the base64 string).
    const bigImg = 'A'.repeat(SANDBOX_MAX_CHART_BYTES + 1);
    const out = parseInterpreterOutput({ status: 'ok', imageBase64: bigImg });
    expect(out.charts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('formats sub-second as ms', () => {
    expect(formatElapsed(500)).toBe('500ms');
  });

  it('formats seconds with one decimal', () => {
    expect(formatElapsed(4200)).toBe('4.2s');
    expect(formatElapsed(10000)).toBe('10.0s');
  });

  it('formats exactly 1000ms as 1.0s', () => {
    expect(formatElapsed(1000)).toBe('1.0s');
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('SANDBOX_TIMEOUT_S is a reasonable value (30-120)', () => {
    expect(SANDBOX_TIMEOUT_S).toBeGreaterThanOrEqual(30);
    expect(SANDBOX_TIMEOUT_S).toBeLessThanOrEqual(120);
  });

  it('SANDBOX_MAX_STDOUT_BYTES is at least 16 KB', () => {
    expect(SANDBOX_MAX_STDOUT_BYTES).toBeGreaterThanOrEqual(16 * 1024);
  });

  it('SANDBOX_MAX_CHARTS is at least 1', () => {
    expect(SANDBOX_MAX_CHARTS).toBeGreaterThanOrEqual(1);
  });

  it('SANDBOX_MAX_CHART_BYTES is at least 1 MB', () => {
    expect(SANDBOX_MAX_CHART_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});

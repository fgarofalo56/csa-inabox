/**
 * code-interpreter — pure logic helpers for WS-5.3 conversational code
 * interpreter (Spark-sandboxed Python over governed lakehouse data).
 *
 * NO server-side imports: this module is used from both the BFF route AND
 * client-side (for code-block detection). Keep it pure — no azure clients,
 * no next/headers, no process.env reads at module level.
 *
 * Sandbox boundaries:
 *   - Execution timeout: 60 s (enforced by the Livy statement poll loop on
 *     the BFF side; the code wrapper also plants a Python threading.Timer
 *     that prints a truncation notice and calls sys.exit so a runaway cell
 *     terminates within the pool's wall-clock budget even if the BFF crashes)
 *   - stdout cap: 64 KB
 *   - chart count: 3 per run (only the first 3 image/png outputs are kept)
 *   - chart size: 5 MB each (base64-encoded)
 *
 * Azure-native only: the sandbox runs on the existing warm Synapse Spark pool
 * (LOOM_SYNAPSE_SPARK_POOL); Fabric is never involved.
 */

// ---------------------------------------------------------------------------
// Sandbox constants (BFF and client share these for display)
// ---------------------------------------------------------------------------

export const SANDBOX_TIMEOUT_S = 60;
export const SANDBOX_MAX_STDOUT_BYTES = 64 * 1024;
export const SANDBOX_MAX_CHARTS = 3;
export const SANDBOX_MAX_CHART_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Code-block extraction
// ---------------------------------------------------------------------------

const PY_BLOCK_RE = /```python\s*\n([\s\S]*?)```/gi;

/** Extract all Python code blocks from a markdown-ish model response. */
export function extractPythonProposals(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  PY_BLOCK_RE.lastIndex = 0;
  while ((m = PY_BLOCK_RE.exec(text)) !== null) {
    const code = m[1].trim();
    if (code) out.push(code);
  }
  return out;
}

/** Return the first Python code block in text, or null. */
export function extractPythonProposal(text: string): string | null {
  const all = extractPythonProposals(text);
  return all.length > 0 ? all[0] : null;
}

// ---------------------------------------------------------------------------
// Sandbox code wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap user code with:
 *   - stdout capture + truncation at SANDBOX_MAX_STDOUT_BYTES
 *   - threading.Timer that hard-exits after SANDBOX_TIMEOUT_S seconds
 *   - matplotlib inline-backend so display(fig) / plt.show() emit image/png
 *
 * The wrapper is injected once; the user code runs inside it.  If the user
 * code raises, the exception is re-raised so Livy records it as an error
 * statement (evalue / traceback visible in the normalized output).
 */
export function wrapUserCode(
  userCode: string,
  opts: { timeoutS?: number; maxStdoutBytes?: number } = {},
): string {
  const timeoutS = opts.timeoutS ?? SANDBOX_TIMEOUT_S;
  const maxBytes = opts.maxStdoutBytes ?? SANDBOX_MAX_STDOUT_BYTES;

  // Encode user code as base64 to avoid any quoting issue in triple-quoted
  // Python strings (e.g. user code that itself contains triple quotes).
  const b64 = Buffer.from(userCode, 'utf8').toString('base64');

  return `
import sys, io, base64, threading, traceback

_loom_max_bytes = ${maxBytes}
_loom_timeout_s = ${timeoutS}

# --- stdout capture -----------------------------------------------------------
_loom_buf = io.StringIO()
_loom_real_stdout = sys.stdout
sys.stdout = _loom_buf

# --- hard timeout watchdog ---------------------------------------------------
def _loom_timeout_handler():
    sys.stdout = _loom_real_stdout
    out = _loom_buf.getvalue()
    if len(out.encode()) > _loom_max_bytes:
        out = out.encode()[:_loom_max_bytes].decode('utf-8', errors='replace') + '\\n[stdout truncated at ${maxBytes} bytes]'
    print('[loom-sandbox] TIMEOUT: execution exceeded ${timeoutS}s', file=_loom_real_stdout, flush=True)
    if out:
        print(out, end='', file=_loom_real_stdout, flush=True)
    raise SystemExit(1)

_loom_timer = threading.Timer(${timeoutS}, _loom_timeout_handler)
_loom_timer.daemon = True
_loom_timer.start()

# --- matplotlib inline backend -----------------------------------------------
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    _orig_show = plt.show
    def _loom_show(*a, **kw):
        try:
            from IPython.display import display as _display
            _display(plt.gcf())
        except Exception:
            pass
        plt.close('all')
    plt.show = _loom_show
except ImportError:
    pass

# --- user code ---------------------------------------------------------------
_loom_user_code = base64.b64decode(${JSON.stringify(b64)}).decode('utf-8')
try:
    exec(compile(_loom_user_code, '<code-interpreter>', 'exec'), {'__name__': '__main__'})
except SystemExit:
    raise
except Exception as _loom_exc:
    traceback.print_exc(file=_loom_real_stdout)
    raise
finally:
    _loom_timer.cancel()
    sys.stdout = _loom_real_stdout
    out = _loom_buf.getvalue()
    if len(out.encode()) > _loom_max_bytes:
        out = out.encode()[:_loom_max_bytes].decode('utf-8', errors='replace') + '\\n[stdout truncated]'
    if out:
        print(out, end='', flush=True)
`.trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export interface InterpreterOutput {
  stdout: string;
  /** base64-encoded PNG strings, max SANDBOX_MAX_CHARTS entries */
  charts: string[];
  status: 'ok' | 'error';
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** Shape of a NormalizedOutput from synapse-livy-client (subset we need). */
export interface LivyNormalizedOutput {
  status: 'ok' | 'error';
  textPlain?: string;
  imageBase64?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/**
 * Convert a NormalizedOutput from synapse-livy-client into the
 * InterpreterOutput that the BFF returns.  Pass `chartAccum` to accumulate
 * chart images across multiple statements in one run.
 */
export function parseInterpreterOutput(
  output: LivyNormalizedOutput,
  chartAccum: string[] = [],
): InterpreterOutput {
  if (
    output.imageBase64 &&
    chartAccum.length < SANDBOX_MAX_CHARTS &&
    output.imageBase64.length <= SANDBOX_MAX_CHART_BYTES
  ) {
    chartAccum.push(output.imageBase64);
  }

  if (output.status === 'error') {
    return {
      status: 'error',
      stdout: output.textPlain || '',
      charts: chartAccum.slice(0, SANDBOX_MAX_CHARTS),
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback,
    };
  }

  return {
    status: 'ok',
    stdout: output.textPlain || '',
    charts: chartAccum.slice(0, SANDBOX_MAX_CHARTS),
  };
}

// ---------------------------------------------------------------------------
// Timing label (shared by UI)
// ---------------------------------------------------------------------------

/** Format elapsed milliseconds as a human-readable label, e.g. "4.2s". */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

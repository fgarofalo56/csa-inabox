/**
 * Pure builder for the PySpark "runner" submitted as an AML Serverless Spark
 * standalone job. Kept in its own dependency-free module (no @azure/* imports)
 * so it can be unit-tested without loading the Azure SDK, and so the runner
 * logic is reviewable in isolation.
 *
 * The runner wraps a user %%pyspark cell: the cell body is embedded as base64
 * (so arbitrary quoting/newlines survive), exec'd with a live SparkSession in
 * scope, its stdout captured, and a structured result.json written into the
 * job's bound output folder (passed via `--loom-out`). The same JSON is echoed
 * to the driver log as a fallback.
 */
export function buildRunnerPy(cellSourceB64: string): string {
  return [
    'import sys, os, io, json, base64, contextlib, traceback',
    'out_dir = None',
    'for _i, _a in enumerate(sys.argv):',
    "    if _a == '--loom-out' and _i + 1 < len(sys.argv):",
    '        out_dir = sys.argv[_i + 1]',
    'from pyspark.sql import SparkSession',
    "spark = SparkSession.builder.appName('loom-cell').getOrCreate()",
    "_code = base64.b64decode('" + cellSourceB64 + "').decode('utf-8')",
    '_buf = io.StringIO()',
    "_res = {'status': 'ok', 'textPlain': '', 'ename': '', 'evalue': '', 'traceback': ''}",
    'try:',
    '    with contextlib.redirect_stdout(_buf):',
    "        exec(compile(_code, '<loom-cell>', 'exec'), {'spark': spark, '__name__': '__main__'})",
    "    _res['textPlain'] = _buf.getvalue()",
    'except Exception as _e:',
    "    _res['status'] = 'error'",
    "    _res['ename'] = type(_e).__name__",
    "    _res['evalue'] = str(_e)",
    "    _res['traceback'] = traceback.format_exc()",
    "    _res['textPlain'] = _buf.getvalue()",
    '_payload = json.dumps(_res)',
    'if out_dir:',
    '    try:',
    '        os.makedirs(out_dir, exist_ok=True)',
    "        with open(os.path.join(out_dir, 'result.json'), 'w') as _f:",
    '            _f.write(_payload)',
    '    except Exception:',
    '        pass',
    "print('LOOM_RESULT_JSON=' + _payload)",
    'spark.stop()',
  ].join('\n') + '\n';
}

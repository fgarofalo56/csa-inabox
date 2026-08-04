#!/usr/bin/env node
/**
 * Classify the result of the `loom-docs` reindex trigger that
 * copilot-quality-evals.yml (and the post-deploy bootstrap) fire BEFORE the
 * Copilot quality-eval run — issue #2929, the index-FRESHNESS half.
 *
 * WHY A SEPARATE, TESTED SCRIPT
 * -----------------------------
 * The reindex step's whole job is to make the eval self-heal on a stale index:
 * if the index is not refreshed, the gate measures the wrong corpus and can go
 * green having measured nothing (the repo's dominant defect class — see
 * scripts/ci/check-annotation-teeth.mjs). So the pass/warn/FAIL decision must be
 * fail-LOUD and it must be UNIT-TESTABLE, not buried in a bash `case` nobody
 * exercises. This is the pure decision core; the workflow does the curl and
 * feeds the HTTP code + response body in.
 *
 * THE CONTRACT (POST /api/help-copilot/reindex, see apps/fiab-console/app/api/
 * help-copilot/reindex/route.ts + lib/azure/loom-docs-index.ts::reindex):
 *   - 200 { ok:true, backend, totalChunks, uploaded, ... } — refreshed. When
 *     LOOM_AI_SEARCH_SERVICE is UNSET the route STILL succeeds against the
 *     Cosmos fallback (backend:'cosmos') and warns — that is the honest
 *     "not configured" the eval tolerates (it then measures the Cosmos path).
 *   - 401 — no session AND LOOM_INTERNAL_TOKEN missing/mismatched. The reindex
 *     did NOT run: fail loud, the eval would measure a stale index.
 *   - 502 { ok:false, error } — a real reindex failure (upload failed / empty
 *     corpus). Fail loud.
 *   - curl connect failure (code 000) — the console is unreachable over Front
 *     Door. TOLERATED with a loud warning: the eval itself reaches the console
 *     over the CAE-internal network (LOOM_EVAL_PROBE_URL), not Front Door, so a
 *     transient public-edge blip must not red the quality gate.
 *
 * verdict → exit code:  ok | tolerate → 0 ;  fail → 1.
 *
 * Usage (workflow):
 *   HTTP_CODE=$CODE RESP_BODY="$(cat body)" node scripts/ci/classify-reindex-result.mjs
 */
import { pathToFileURL } from 'node:url';

/** Honest infra-gate signals — a "not configured / not provisioned" body. */
const NOT_CONFIGURED_RE =
  /not configured|not provisioned|not set|no ai search|LOOM_AI_SEARCH|no corpus chunks/i;

/**
 * @param {{ code: number|string, body?: string }} input
 * @returns {{ verdict: 'ok'|'tolerate'|'fail', level: 'notice'|'warning'|'error', message: string }}
 */
export function classifyReindexResult({ code, body }) {
  const n = Number.parseInt(String(code), 10);
  const raw = typeof body === 'string' ? body : '';
  let parsed = null;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  // --- 2xx: the reindex endpoint answered. Success means ok:true. ------------
  if (Number.isFinite(n) && n >= 200 && n < 300) {
    if (parsed && parsed.ok === false) {
      return {
        verdict: 'fail',
        level: 'error',
        message: `reindex returned HTTP ${n} but ok:false — ${summarize(parsed)}. A 2xx must carry ok:true; treating as a failed refresh.`,
      };
    }
    const be = parsed?.backend ?? 'unknown';
    const cosmosGate =
      be === 'cosmos' &&
      Array.isArray(parsed?.warnings) &&
      parsed.warnings.some((w) => NOT_CONFIGURED_RE.test(String(w)));
    const note = cosmosGate
      ? ' (AI Search not configured — honest gate; the eval measures the Cosmos fallback path)'
      : '';
    return {
      verdict: 'ok',
      level: 'notice',
      message: `loom-docs reindex OK — ${summarize(parsed)}${note}.`,
    };
  }

  // --- connect failure (curl printed 000): unreachable over Front Door. ------
  if (n === 0 || String(code) === '000') {
    return {
      verdict: 'tolerate',
      level: 'warning',
      message:
        'loom-docs reindex could not reach the console over Front Door (curl 000). ' +
        'TRANSIENT — the eval run reaches the console over the CAE-internal network ' +
        '(LOOM_EVAL_PROBE_URL), not Front Door, so it proceeds against the last-indexed corpus.',
    };
  }

  // --- 401/403: the reindex did NOT run. This is the exact stale-index bug. --
  if (n === 401 || n === 403) {
    return {
      verdict: 'fail',
      level: 'error',
      message:
        `reindex rejected (HTTP ${n}). LOOM_INTERNAL_TOKEN is missing or does not match the console ` +
        'env (the same token the copilot-evaluator + memory-consolidate use). The index was NOT ' +
        'refreshed, so the eval would measure a STALE index — failing loud.',
    };
  }

  // --- 5xx: real failure, UNLESS the body is an honest not-configured gate. --
  if (Number.isFinite(n) && n >= 500) {
    if (NOT_CONFIGURED_RE.test(raw)) {
      return {
        verdict: 'tolerate',
        level: 'warning',
        message: `reindex honest-gated (HTTP ${n}): ${summarize(parsed) || firstLine(raw)}. Not a failure — infra not provisioned; the eval measures whatever backend is available.`,
      };
    }
    return {
      verdict: 'fail',
      level: 'error',
      message: `reindex failed (HTTP ${n}): ${summarize(parsed) || firstLine(raw)}. The index was NOT refreshed — failing loud.`,
    };
  }

  // --- anything else (404, other 4xx, un-parseable code): fail loud. ---------
  return {
    verdict: 'fail',
    level: 'error',
    message: `reindex returned an unexpected HTTP ${code}: ${firstLine(raw) || '(empty body)'}. The index was NOT confirmed refreshed — failing loud.`,
  };
}

/** Compact one-line summary of a ReindexResult-shaped body. */
function summarize(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const bits = [];
  if (parsed.backend) bits.push(`backend=${parsed.backend}`);
  if (parsed.mode) bits.push(`mode=${parsed.mode}`);
  if (Number.isFinite(parsed.totalChunks)) bits.push(`chunks=${parsed.totalChunks}`);
  if (Number.isFinite(parsed.uploaded)) bits.push(`uploaded=${parsed.uploaded}`);
  if (parsed.error) bits.push(`error=${firstLine(String(parsed.error))}`);
  return bits.join(' ');
}

function firstLine(s) {
  return String(s || '').split(/\r?\n/)[0].slice(0, 300);
}

function main() {
  const code = process.env.HTTP_CODE ?? process.argv[2] ?? '';
  const body = process.env.RESP_BODY ?? '';
  const { verdict, level, message } = classifyReindexResult({ code, body });
  if (level === 'notice') console.log(message);
  else console.log(`::${level}::${message}`);
  process.exit(verdict === 'fail' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

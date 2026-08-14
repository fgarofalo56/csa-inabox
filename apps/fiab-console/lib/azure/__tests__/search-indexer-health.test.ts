/**
 * REGRESSION SUITE for indexer HEALTH classification (#3384).
 *
 * ── THE DEFECT THIS SUITE EXISTS TO CATCH ──────────────────────────────────
 *
 * `GET /indexers/research-knowledge-indexer/status` on dlz-aisearch-dev-eastus2,
 * measured 2026-08-13 and independently re-verified 2026-08-14, returned:
 *
 *     status                    : "running"
 *     lastResult.status         : "transientFailure"
 *     lastResult.errorMessage   : "Could not connect to Annotation Cache Index
 *                                  Storage Acount."
 *     lastResult.itemsProcessed : 0
 *     executionHistory          : 50 runs, Counter({'transientFailure': 50})
 *                                 oldest 2026-06-25, newest 2026-08-13
 *     target index $count       : 0        schedule: P1D   disabled: false
 *
 * Every surface that reached for the top-level `status` field read `running` and
 * called it healthy. The FIXTURE BELOW IS THAT PAYLOAD — not an invented shape
 * modelled on the code, but the one the service actually returned (memory:
 * "FIXTURES that model the CODE" — a fixture invented from the implementation
 * proves only that the implementation agrees with itself).
 *
 * ── WHY THIS SUITE CANNOT PASS VACUOUSLY ───────────────────────────────────
 *
 * Two embedded controls sit alongside the failure cases:
 *
 *   1. HEALTHY CONTROL — a genuinely-good payload MUST classify `healthy`.
 *      Without it, "return 'failed' for everything" would satisfy every other
 *      assertion in the file.
 *   2. FIELD-PRESENCE CONTROL — the fixture is asserted to actually CONTAIN
 *      `status: 'running'`. If a future edit softens the fixture (drops the
 *      field, renames it), the suite fails rather than quietly testing a
 *      payload that no longer carries the trap.
 *
 * Mutation receipt is in the PR body: re-introducing the old behaviour
 * (`verdict = payload.status === 'running' ? 'healthy' : …`) moves the verdict
 * on the failure cases and reds this file.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyIndexerHealth,
  indexerErrorRemediation,
  indexerHealthColor,
} from '../search-indexer-shapes';

/** The verbatim error string Azure returns — including Azure's own "Acount" typo. */
const CACHE_ERROR = 'Could not connect to Annotation Cache Index Storage Acount.';

/**
 * The measured payload. `runs` is generated only because all 50 retained runs
 * were byte-identical apart from their timestamps; every field value here is
 * the one the service returned.
 */
function measuredResearchKnowledgeStatus(runCount = 50) {
  const runs = Array.from({ length: runCount }, (_, i) => ({
    status: 'transientFailure',
    errorMessage: CACHE_ERROR,
    errors: [],
    warnings: [{ key: null, message: 'ImageAction is set', details: 'ImageAction is enabled.' }],
    itemsProcessed: 0,
    itemsFailed: 0,
    startTime: `2026-0${i < 20 ? 8 : 7}-${String(28 - (i % 27)).padStart(2, '0')}T11:00:00.979Z`,
    endTime: `2026-0${i < 20 ? 8 : 7}-${String(28 - (i % 27)).padStart(2, '0')}T11:00:05.667Z`,
  }));
  return { status: 'running', lastResult: runs[0], executionHistory: runs };
}

describe('classifyIndexerHealth — the #3384 payload', () => {
  // CONTROL 2: the fixture must still carry the trap it exists to model.
  it('fixture control: the payload really does report top-level status "running"', () => {
    const s = measuredResearchKnowledgeStatus();
    expect(s.status).toBe('running');
    expect(s.lastResult.status).toBe('transientFailure');
    expect(s.executionHistory).toHaveLength(50);
    expect(s.executionHistory.every((r) => r.status === 'transientFailure')).toBe(true);
  });

  it('NEVER reports healthy for an indexer whose every retained run failed', () => {
    const h = classifyIndexerHealth(measuredResearchKnowledgeStatus(), { scheduled: true, documentCount: 0 });
    expect(h.verdict).toBe('failed');
    expect(h.healthy).toBe(false);
    expect(indexerHealthColor(h.verdict)).toBe('danger');
  });

  it('counts the consecutive failures and quotes the real service error', () => {
    const h = classifyIndexerHealth(measuredResearchKnowledgeStatus(), { scheduled: true, documentCount: 0 });
    expect(h.consecutiveFailures).toBe(50);
    expect(h.runsExamined).toBe(50);
    expect(h.errorMessage).toBe(CACHE_ERROR);
    expect(h.observed).toContain('EVERY retained run failed');
    expect(h.observed).toContain(CACHE_ERROR);
  });

  it('REPORTS the top-level service status but never lets it produce health', () => {
    const h = classifyIndexerHealth(measuredResearchKnowledgeStatus(), { scheduled: true, documentCount: 0 });
    // It is surfaced, so it is inspectable …
    expect(h.indexerServiceStatus).toBe('running');
    // … and explicitly explained, so no reader mistakes it for a run outcome.
    expect(h.observed).toContain('ENABLED');
    // … but it can never be the verdict.
    expect(h.verdict).not.toBe('healthy');
  });

  it('hands back a CONCRETE remediation naming the enrichment-cache role split', () => {
    const h = classifyIndexerHealth(measuredResearchKnowledgeStatus(), { scheduled: true, documentCount: 0 });
    expect(h.remediation).toBeTruthy();
    expect(h.remediation).toContain('Storage Table Data Contributor');
    expect(h.remediation).toContain('Storage Blob Data Contributor');
    expect(h.remediation).toContain('ms-az-search-indexercache');
  });
});

describe('classifyIndexerHealth — the healthy control', () => {
  const healthy = {
    status: 'running',
    lastResult: { status: 'success', startTime: '2026-08-13T11:00:00Z', endTime: '2026-08-13T11:00:30Z', itemsProcessed: 412, itemsFailed: 0, errors: [], warnings: [] },
    executionHistory: [
      { status: 'success', startTime: '2026-08-13T11:00:00Z', endTime: '2026-08-13T11:00:30Z', itemsProcessed: 412, itemsFailed: 0 },
      { status: 'success', startTime: '2026-08-12T11:00:00Z', endTime: '2026-08-12T11:00:28Z', itemsProcessed: 9, itemsFailed: 0 },
    ],
  };

  // CONTROL 1: without this, "always fail" passes the whole file.
  it('DOES report healthy when the newest run succeeded and moved items', () => {
    const h = classifyIndexerHealth(healthy, { scheduled: true, documentCount: 412 });
    expect(h.verdict).toBe('healthy');
    expect(h.healthy).toBe(true);
    expect(h.remediation).toBeUndefined();
    expect(indexerHealthColor(h.verdict)).toBe('success');
  });

  it('a SUCCESS over an empty index is still not healthy (#3384 AC: 0 items is not a fix)', () => {
    const h = classifyIndexerHealth(healthy, { scheduled: true, documentCount: 0 });
    expect(h.verdict).toBe('degraded');
    expect(h.healthy).toBe(false);
    expect(h.observed).toContain('0 documents');
  });

  it('a scheduled indexer whose every run processed nothing is degraded', () => {
    const zeroes = {
      status: 'running',
      lastResult: { status: 'success', startTime: '2026-08-13T11:00:00Z', itemsProcessed: 0, itemsFailed: 0 },
      executionHistory: [
        { status: 'success', startTime: '2026-08-13T11:00:00Z', itemsProcessed: 0, itemsFailed: 0 },
        { status: 'success', startTime: '2026-08-12T11:00:00Z', itemsProcessed: 0, itemsFailed: 0 },
      ],
    };
    expect(classifyIndexerHealth(zeroes, { scheduled: true }).verdict).toBe('degraded');
  });
});

describe('classifyIndexerHealth — failing closed', () => {
  it('a payload that could not be read is UNKNOWN, never healthy, and carries the read error', () => {
    const h = classifyIndexerHealth(null, { unreadableReason: 'AI Search data-plane call failed (403)' });
    expect(h.verdict).toBe('unknown');
    expect(h.healthy).toBe(false);
    expect(h.observed).toContain('403');
    expect(h.remediation).toContain('UNVERIFIED');
  });

  it('an empty/absent payload is UNKNOWN and says so without inventing a cause', () => {
    const h = classifyIndexerHealth(undefined);
    expect(h.verdict).toBe('unknown');
    expect(h.observed).toContain('nothing was observed');
    // R7: it must not assert WHY, because it does not know.
    expect(h.observed).not.toMatch(/denied|firewall|deleted/i);
  });

  it('a status with no terminal run is PENDING, not healthy', () => {
    const h = classifyIndexerHealth({ status: 'running', executionHistory: [] });
    expect(h.verdict).toBe('pending');
    expect(h.healthy).toBe(false);
    expect(h.observed).toContain('nothing has been proven');
  });

  it('an in-flight run is reported as in flight, still not healthy', () => {
    const h = classifyIndexerHealth({ status: 'running', executionHistory: [{ status: 'inProgress', startTime: '2026-08-13T11:00:00Z' }] });
    expect(h.verdict).toBe('pending');
    expect(h.observed).toContain('in flight');
  });

  it('the service reporting status "error" cannot yield healthy either', () => {
    const h = classifyIndexerHealth({
      status: 'error',
      executionHistory: [{ status: 'persistentFailure', itemsProcessed: 0, itemsFailed: 0, errorMessage: 'skillset not found' }],
    });
    expect(h.verdict).not.toBe('healthy');
    expect(h.indexerServiceStatus).toBe('error');
  });

  it('a disabled indexer is reported as disabled, never healthy', () => {
    const h = classifyIndexerHealth({ status: 'running', executionHistory: [{ status: 'success', itemsProcessed: 3 }] }, { disabled: true });
    expect(h.verdict).toBe('disabled');
    expect(h.healthy).toBe(false);
  });
});

describe('classifyIndexerHealth — degraded vs failed', () => {
  const run = (status: string, startTime: string) => ({ status, startTime, itemsProcessed: status === 'success' ? 4 : 0, itemsFailed: 0, errorMessage: status === 'success' ? undefined : 'transient blip' });

  it('one failure after a run of successes is DEGRADED, not failed', () => {
    const h = classifyIndexerHealth({
      status: 'running',
      executionHistory: [run('transientFailure', '2026-08-13T11:00:00Z'), run('success', '2026-08-12T11:00:00Z'), run('success', '2026-08-11T11:00:00Z'), run('success', '2026-08-10T11:00:00Z')],
    }, { documentCount: 12 });
    expect(h.verdict).toBe('degraded');
    expect(h.consecutiveFailures).toBe(1);
  });

  it('three consecutive failures cross the threshold to FAILED', () => {
    const h = classifyIndexerHealth({
      status: 'running',
      executionHistory: [run('transientFailure', '2026-08-13T11:00:00Z'), run('transientFailure', '2026-08-12T11:00:00Z'), run('transientFailure', '2026-08-11T11:00:00Z'), run('success', '2026-08-10T11:00:00Z')],
    }, { documentCount: 12 });
    expect(h.verdict).toBe('failed');
    expect(h.consecutiveFailures).toBe(3);
  });

  it('an in-flight run at the head does not mask the failures behind it', () => {
    const h = classifyIndexerHealth({
      status: 'running',
      executionHistory: [{ status: 'inProgress', startTime: '2026-08-14T11:00:00Z' }, run('transientFailure', '2026-08-13T11:00:00Z'), run('transientFailure', '2026-08-12T11:00:00Z'), run('transientFailure', '2026-08-11T11:00:00Z')],
    }, { documentCount: 0 });
    expect(h.verdict).toBe('failed');
    expect(h.consecutiveFailures).toBe(3);
  });

  it('does not double-count lastResult when it duplicates executionHistory[0]', () => {
    const first = run('transientFailure', '2026-08-13T11:00:00Z');
    const h = classifyIndexerHealth({ status: 'running', lastResult: first, executionHistory: [first, run('success', '2026-08-12T11:00:00Z')] });
    expect(h.runsExamined).toBe(2);
    expect(h.consecutiveFailures).toBe(1);
  });
});

describe('indexerErrorRemediation', () => {
  it('classifies the annotation-cache failure ahead of the generic connect failure', () => {
    // The message matches BOTH /could not connect/ and the cache pattern. The
    // cache branch must win: the generic remediation sends the reader at the
    // data source, which on 2026-08-13 was fine, and cost an investigation.
    const r = indexerErrorRemediation(CACHE_ERROR)!;
    expect(r).toContain('enrichment (annotation) cache');
    expect(r).toContain('Storage Table Data Contributor');
  });

  it('matches the corrected spelling too, so a service-side typo fix cannot un-match it', () => {
    expect(indexerErrorRemediation('Could not connect to Annotation Cache Index Storage Account.')).toContain('enrichment (annotation) cache');
  });

  it('classifies an authorization failure with a data-plane role remediation', () => {
    const r = indexerErrorRemediation('The remote server returned an error: (403) Forbidden.')!;
    expect(r).toContain('data-plane role');
  });

  it('falls back to quoting the error rather than inventing a cause', () => {
    const r = indexerErrorRemediation('Something entirely novel happened')!;
    expect(r).toContain('Something entirely novel happened');
  });

  it('returns nothing for an empty error', () => {
    expect(indexerErrorRemediation('')).toBeUndefined();
    expect(indexerErrorRemediation(undefined)).toBeUndefined();
  });
});

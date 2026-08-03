/**
 * humanizeBackendError — the raw-response-body leak (#2895).
 *
 * The ADF / Synapse clients throw with the VERBATIM ARM body so the server log
 * keeps the full receipt. The editors piped that straight into a red
 * MessageBar, so the operator saw a stringified JSON blob — a no-vaporware
 * violation — carrying `target: /subscriptions/<guid>/resourceGroups/<rg>/…`,
 * i.e. estate identifiers, on a screen that gets pasted into public issues.
 *
 * The CONTROL these tests hold in both directions: a genuine error must STILL
 * say what went wrong. Sanitising must not become suppressing.
 */
import { describe, it, expect } from 'vitest';
import { humanizeBackendError, stripArmResourceIds } from '../backend-error-text';

// The exact shape `adf-client.jsonOrThrow` produces for a missing pipeline.
// Placeholder ids only — this repo is public.
const RAW_ADF_404 =
  'getPipeline(ingest_orders) failed 404: {"code":"NotFound","message":"The Pipeline ' +
  "'ingest_orders' does not exist.\",\"target\":\"/subscriptions/00000000-0000-0000-0000-000000000000" +
  '/resourceGroups/rg-example/providers/Microsoft.DataFactory/factories/adf-example/pipelines/ingest_orders"}';

describe('humanizeBackendError (#2895)', () => {
  it('renders the human sentence, not the response body', () => {
    const out = humanizeBackendError(RAW_ADF_404);
    expect(out).toContain('does not exist');
    expect(out).toContain('NotFound');
    // The machine framing and the JSON envelope are gone.
    expect(out).not.toContain('{');
    expect(out).not.toContain('"code"');
    expect(out).not.toContain('failed 404');
  });

  it('never puts an ARM resource path on screen', () => {
    const out = humanizeBackendError(RAW_ADF_404);
    expect(out).not.toContain('/subscriptions/');
    expect(out).not.toContain('resourceGroups');
    expect(out).not.toContain('adf-example');
    expect(out).not.toContain('rg-example');
  });

  it('handles the nested ARM `{error:{code,message}}` envelope too', () => {
    const raw = 'upsertPipeline(x) failed 403: {"error":{"code":"AuthorizationFailed","message":"The client does not have authorization to perform action."}}';
    const out = humanizeBackendError(raw);
    expect(out).toContain('does not have authorization');
    expect(out).toContain('AuthorizationFailed');
    expect(out).not.toContain('{');
  });

  it('CONTROL — a plain human error passes through unchanged', () => {
    const raw = 'AI Search not provisioned in this deployment; set LOOM_AI_SEARCH_SERVICE.';
    expect(humanizeBackendError(raw)).toBe(raw);
  });

  it('CONTROL — never returns empty for a non-empty error (that would be suppression)', () => {
    for (const raw of [
      RAW_ADF_404,
      'listPipelines failed 500: <html><body>Internal Server Error</body></html>',
      'Expected JSON but got text/html (HTTP 502)',
      '{"code":"Throttled"}',
      'boom',
    ]) {
      expect(humanizeBackendError(raw).length).toBeGreaterThan(0);
    }
  });

  it('keeps the human prefix when the body is truncated/unparseable', () => {
    const out = humanizeBackendError('getPipeline(x) failed 500: {"code":"Internal');
    expect(out).toContain('getPipeline(x) failed 500');
    expect(out).not.toContain('{');
  });

  it('empty in, empty out', () => {
    expect(humanizeBackendError('')).toBe('');
    expect(humanizeBackendError(null)).toBe('');
    expect(humanizeBackendError(undefined)).toBe('');
  });
});

describe('stripArmResourceIds', () => {
  it('replaces the id and keeps the surrounding sentence', () => {
    const out = stripArmResourceIds(
      'Not found: /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.DataFactory/factories/adf-example — retry later.',
    );
    expect(out).toBe('Not found: <resource> — retry later.');
  });
});

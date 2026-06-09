import { describe, it, expect, afterEach, vi } from 'vitest';
import { emitCopilotUsage, type OrchestratorUsage } from '../copilot-orchestrator';

/**
 * Unit tests for the Copilot usage emit path (App Insights write).
 *
 * emitCopilotUsage() is the real telemetry sink behind the "Copilot usage"
 * admin panel. These tests pin its honest-gate behaviour and the exact
 * `copilot.usage` event envelope (persona + real prompt/completion tokens)
 * without touching a live App Insights endpoint — global fetch is stubbed.
 */

const USAGE: OrchestratorUsage = {
  promptTokens: 120,
  completionTokens: 45,
  totalTokens: 165,
  aoaiCalls: 2,
  toolCalls: 1,
};

const ORIG = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

afterEach(() => {
  if (ORIG === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = ORIG;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('emitCopilotUsage', () => {
  it('no-ops (no fetch) when App Insights is unconfigured', async () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await emitCopilotUsage(USAGE, 'gpt-4o', 'sess-1', 'oid-1', 'cross-item');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops on a malformed connection string', async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'not-a-valid-conn-string';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await emitCopilotUsage(USAGE, 'gpt-4o', 'sess-1', 'oid-1', 'cross-item');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a copilot.usage envelope with persona + real tokens to the ingestion endpoint', async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      'InstrumentationKey=00000000-0000-0000-0000-000000000abc;IngestionEndpoint=https://eastus-1.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await emitCopilotUsage(USAGE, 'gpt-4o', 'sess-xyz', 'user-oid-123', 'cross-item');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Endpoint derived from the connection string (no trailing slash dup).
    expect(url).toBe('https://eastus-1.in.applicationinsights.azure.com/v2/track');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.iKey).toBe('00000000-0000-0000-0000-000000000abc');
    expect(body.data.baseData.name).toBe('copilot.usage');
    const props = body.data.baseData.properties;
    expect(props.persona).toBe('cross-item');
    expect(props.model).toBe('gpt-4o');
    // Real token counts are serialised as strings (cast with toint() in KQL).
    expect(props.prompt_tokens).toBe('120');
    expect(props.completion_tokens).toBe('45');
    expect(props.total_tokens).toBe('165');
    expect(props.session_id).toBe('sess-xyz');
    // user oid is hashed (never raw PII), 16 hex chars.
    expect(props.user_oid_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(props.user_oid_hash).not.toContain('user-oid-123');
  });

  it('does not emit an empty receipt (no tokens, no calls)', async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      'InstrumentationKey=abc;IngestionEndpoint=https://x.in.applicationinsights.azure.com/';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await emitCopilotUsage(
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, aoaiCalls: 0, toolCalls: 0 },
      'gpt-4o', 'sess-empty', 'oid', 'cross-item',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

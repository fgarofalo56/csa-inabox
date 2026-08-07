/**
 * Unit tests for the report-subscriptions delivery pass (B-FN C3).
 *
 * These cover the host-agnostic runner introduced when the Y1 Function was
 * migrated to a `Microsoft.App/jobs` execution — specifically the EXIT-CODE
 * CONTRACT the ACA job depends on:
 *
 *   • a missing config value is an honest GATE (`ran:false`), not a throw, so
 *     the execution reports Succeeded and a Failed execution in the job history
 *     is always a real regression;
 *   • a per-subscription delivery failure is counted and logged but never
 *     aborts the batch or the process.
 *
 * The Azure IO (`./clients`) is mocked here on purpose: this file tests the
 * pass's control flow, NOT the Cosmos/Logic-App calls. The live receipt for the
 * real backend is the job execution itself (see docs/fiab/deployment/functions-to-aca-jobs.md).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunLogger } from './run-logger';

const readEnabledSubscriptions = vi.fn();
const renderReport = vi.fn();
const deliverViaLogicApp = vi.fn();
const recordDelivery = vi.fn();

vi.mock('./clients', () => ({
  readEnabledSubscriptions: (...a: unknown[]) => readEnabledSubscriptions(...a),
  renderReport: (...a: unknown[]) => renderReport(...a),
  deliverViaLogicApp: (...a: unknown[]) => deliverViaLogicApp(...a),
  recordDelivery: (...a: unknown[]) => recordDelivery(...a),
}));

// Imported after the mock so the module graph picks it up.
const { runDeliveryPass } = await import('./run-delivery');

function collectingLogger(): RunLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (m) => lines.push(`log:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_COSMOS_ENDPOINT = 'https://cosmos.example/';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** A subscription whose own cron matches every minute, so it is always due. */
function alwaysDueSub(id: string) {
  return {
    id,
    reportId: `rpt-${id}`,
    workspaceId: 'ws-1',
    format: 'PDF' as const,
    cron: '* * * * * *',
    recipients: ['a@example.com'],
    enabled: true,
  };
}

describe('runDeliveryPass — ACA job exit-code contract', () => {
  it('honest-gates (ran:false, no throw) when LOOM_COSMOS_ENDPOINT is unset', async () => {
    delete process.env.LOOM_COSMOS_ENDPOINT;
    const logger = collectingLogger();

    const summary = await runDeliveryPass(logger, new Date('2026-08-06T12:00:00Z'));

    expect(summary.ran).toBe(false);
    expect(summary.gate).toBe('LOOM_COSMOS_ENDPOINT');
    // The gate must NAME the missing value (no-vaporware honest gate).
    expect(logger.lines.join('\n')).toContain('LOOM_COSMOS_ENDPOINT');
    // It must not have attempted any Azure IO.
    expect(readEnabledSubscriptions).not.toHaveBeenCalled();
  });

  it('does not throw when the subscription store is unreadable — reports a gate', async () => {
    readEnabledSubscriptions.mockRejectedValueOnce(new Error('cosmos 403'));
    const logger = collectingLogger();

    const summary = await runDeliveryPass(logger, new Date('2026-08-06T12:00:00Z'));

    expect(summary.ran).toBe(false);
    expect(summary.gate).toBe('cosmos-read');
    expect(logger.lines.join('\n')).toContain('cosmos 403');
  });

  it('counts a per-subscription failure and still delivers the rest of the batch', async () => {
    readEnabledSubscriptions.mockResolvedValueOnce([alwaysDueSub('bad'), alwaysDueSub('good')]);
    renderReport
      .mockRejectedValueOnce(new Error('renderer 500: boom'))
      .mockResolvedValueOnce({ base64: 'AAA=', sizeBytes: 3 });
    deliverViaLogicApp.mockResolvedValue(undefined);
    recordDelivery.mockResolvedValue(undefined);
    const logger = collectingLogger();

    const summary = await runDeliveryPass(logger, new Date('2026-08-06T12:00:00Z'));

    expect(summary.ran).toBe(true);
    expect(summary.due).toBe(2);
    expect(summary.failed).toBe(1);
    // The batch continued past the failure.
    expect(summary.delivered).toBe(1);
    // The failure is durable telemetry, not just a log line.
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bad' }),
      expect.objectContaining({ status: 'failed' }),
      expect.any(Date),
    );
  });

  it('reports a clean zero-work pass when nothing is due', async () => {
    readEnabledSubscriptions.mockResolvedValueOnce([
      { ...alwaysDueSub('later'), cron: '0 0 3 1 1 *' },
    ]);
    const logger = collectingLogger();

    const summary = await runDeliveryPass(logger, new Date('2026-08-06T12:00:00Z'));

    expect(summary).toMatchObject({ ran: true, enabled: 1, due: 0, delivered: 0, failed: 0 });
    expect(renderReport).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { computeFreshness, freshnessWindowHours, FRESHNESS_GRACE } from '../sla';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-07-08T12:00:00.000Z');

describe('freshnessWindowHours', () => {
  it('derives the window from the declared update frequency', () => {
    expect(freshnessWindowHours({ updateFrequency: 'daily' }).windowHours).toBe(24);
    expect(freshnessWindowHours({ updateFrequency: 'Hourly' }).windowHours).toBe(1);
    expect(freshnessWindowHours({ updateFrequency: 'weekly' }).windowHours).toBe(24 * 7);
  });
  it('prefers an explicit sla.freshnessHours', () => {
    const r = freshnessWindowHours({ updateFrequency: 'daily', sla: { freshnessHours: 6 } });
    expect(r.windowHours).toBe(6);
    expect(r.frequency).toBe('custom');
  });
  it('returns null window when no SLA is declared', () => {
    expect(freshnessWindowHours({}).windowHours).toBeNull();
    expect(freshnessWindowHours(undefined).windowHours).toBeNull();
  });
});

describe('computeFreshness', () => {
  it('is not breached when the refresh is within the graced window', () => {
    const item = { state: { updateFrequency: 'daily', lastRefreshedAt: new Date(NOW - 20 * HOUR).toISOString() } };
    const r = computeFreshness(item, NOW);
    expect(r.breached).toBe(false);
    expect(r.windowHours).toBe(24);
    expect(Math.round(r.ageHours!)).toBe(20);
  });

  it('is not breached inside the grace multiplier (24h window, 30h age < 36h)', () => {
    const item = { state: { updateFrequency: 'daily', lastRefreshedAt: new Date(NOW - 30 * HOUR).toISOString() } };
    expect(computeFreshness(item, NOW).breached).toBe(false);
    expect(24 * FRESHNESS_GRACE).toBe(36);
  });

  it('is breached when age exceeds the graced window', () => {
    const item = { state: { updateFrequency: 'daily', lastRefreshedAt: new Date(NOW - 40 * HOUR).toISOString() } };
    const r = computeFreshness(item, NOW);
    expect(r.breached).toBe(true);
    expect(Math.round(r.ageHours!)).toBe(40);
  });

  it('falls back to updatedAt when no explicit lastRefreshedAt', () => {
    const item = { state: { updateFrequency: 'hourly' }, updatedAt: new Date(NOW - 5 * HOUR).toISOString() };
    const r = computeFreshness(item, NOW);
    expect(r.breached).toBe(true); // 5h >> 1h*1.5 grace
    expect(r.lastRefreshedAt).toBe(item.updatedAt);
  });

  it('never breaches when no SLA is declared (nothing to breach)', () => {
    const item = { state: {}, updatedAt: new Date(NOW - 1000 * HOUR).toISOString() };
    expect(computeFreshness(item, NOW).breached).toBe(false);
  });
});

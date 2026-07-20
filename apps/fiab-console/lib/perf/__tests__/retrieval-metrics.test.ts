/**
 * Unit tests for the docs-Copilot retrieval telemetry (WS-G / G3).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRetrieval,
  retrievalMetricsSnapshot,
  resetRetrievalMetrics,
} from '../retrieval-metrics';

describe('retrieval-metrics', () => {
  beforeEach(() => resetRetrievalMetrics());

  it('starts empty with zeroed rates', () => {
    const s = retrievalMetricsSnapshot();
    expect(s.queries).toBe(0);
    expect(s.hitRate).toBe(0);
    expect(s.fallbackRate).toBe(0);
    expect(s.latency.p50).toBe(0);
    expect(s.byBackend).toEqual({ 'ai-search': 0, cosmos: 0, none: 0 });
  });

  it('counts hits vs empties and computes hit-rate', () => {
    recordRetrieval({ backend: 'ai-search', latencyMs: 10, resultCount: 3, fallback: false });
    recordRetrieval({ backend: 'cosmos', latencyMs: 20, resultCount: 0, fallback: true });
    recordRetrieval({ backend: 'cosmos', latencyMs: 30, resultCount: 1, fallback: true });
    const s = retrievalMetricsSnapshot();
    expect(s.queries).toBe(3);
    expect(s.hits).toBe(2);
    expect(s.empty).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3, 5);
  });

  it('tracks AI-Search→Cosmos fallbacks + per-backend counts', () => {
    recordRetrieval({ backend: 'ai-search', latencyMs: 5, resultCount: 2, fallback: false });
    recordRetrieval({ backend: 'cosmos', latencyMs: 5, resultCount: 2, fallback: true });
    recordRetrieval({ backend: 'cosmos', latencyMs: 5, resultCount: 2, fallback: true });
    const s = retrievalMetricsSnapshot();
    expect(s.fallbacks).toBe(2);
    expect(s.fallbackRate).toBeCloseTo(2 / 3, 5);
    expect(s.byBackend['ai-search']).toBe(1);
    expect(s.byBackend.cosmos).toBe(2);
  });

  it('computes latency avg / max / percentiles', () => {
    for (const ms of [10, 20, 30, 40, 100]) {
      recordRetrieval({ backend: 'ai-search', latencyMs: ms, resultCount: 1, fallback: false });
    }
    const s = retrievalMetricsSnapshot();
    expect(s.latency.max).toBe(100);
    expect(s.latency.avg).toBe(40); // (10+20+30+40+100)/5
    expect(s.latency.samples).toBe(5);
    // nearest-rank p50 over [10,20,30,40,100] → ceil(0.5*5)=3rd → 30
    expect(s.latency.p50).toBe(30);
    // p95 → ceil(0.95*5)=5th → 100
    expect(s.latency.p95).toBe(100);
  });

  it('reset clears every counter', () => {
    recordRetrieval({ backend: 'cosmos', latencyMs: 15, resultCount: 1, fallback: false });
    resetRetrievalMetrics();
    expect(retrievalMetricsSnapshot().queries).toBe(0);
  });
});

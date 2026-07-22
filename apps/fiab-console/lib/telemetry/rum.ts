'use client';

/**
 * RUM1 — browser-side real-user monitoring capture (loom-next-level
 * ws-verification-dr.md RUM1; PRP ground truth #14: console telemetry was
 * server-side only).
 *
 * FIRST-PARTY code only — no App Insights Web SDK, no CDN script (X-IL5
 * checklist item 4: everything ships bundled in the console image). Beacons
 * never leave the first-party origin: they POST to the session-gated BFF
 * ingest route `/api/telemetry/rum`, which forwards to App Insights
 * server-side. What is captured, per the spec:
 *
 *   - HARD page loads  — real Navigation Timing durations (total / network /
 *                        send / receive / processing) → browserTimings;
 *   - SOFT route changes — App Router pathname transitions (view counts; no
 *                        fabricated durations, per no-vaporware);
 *   - Web Vitals       — LCP / FCP / TTFB / CLS / INP-approx via
 *                        PerformanceObserver, reported once per page view;
 *   - Unhandled errors — window 'error' + 'unhandledrejection', deduped and
 *                        capped per session.
 *
 * PII: every surface string is scrubbed to a route SHAPE and every message
 * scrubbed of emails/GUIDs/tokens BEFORE it enters the queue (rum-shared.ts —
 * the server re-scrubs on ingest). No user identifier is ever captured.
 *
 * Control plane: one config GET on mount returns {enabled, sampleRate} —
 * `enabled` folds together LOOM_RUM_ENABLED, the App Insights connection
 * string AND the FLAG0 runtime kill-switch `rum1-client-telemetry`, so an
 * admin flag-flip stops capture on the next page load with no roll. Sampling
 * is per-session (sessionStorage) so a session is consistently in or out.
 *
 * Transport: raw fetch (NOT clientFetch) — a 401 on a pre-auth surface must
 * stay a silent no-op, never trigger the session-refresh/reauth machinery;
 * flush on interval + pagehide via navigator.sendBeacon (keepalive fallback).
 */
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import {
  RUM_MAX_ERRORS_PER_SESSION,
  RUM_MAX_ITEMS,
  scrubSurfacePath,
  scrubText,
  type RumItem,
} from './rum-shared';

const INGEST_PATH = '/api/telemetry/rum';
const FLUSH_INTERVAL_MS = 15_000;
const SAMPLE_KEY = 'loom-rum-sampled';

// Module-level singletons — the provider may remount (fast refresh, error
// boundary) but capture must install once per page lifetime.
let installed = false;
let queue: RumItem[] = [];
let errorCount = 0;
const seenErrors = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

function currentSurface(): string {
  if (typeof window === 'undefined') return '/';
  return scrubSurfacePath(window.location.pathname);
}

function enqueue(item: RumItem): void {
  if (queue.length >= RUM_MAX_ITEMS * 2) return; // hard local cap — drop, never grow
  queue.push(item);
}

function drain(): RumItem[] {
  const batch = queue.slice(0, RUM_MAX_ITEMS);
  queue = queue.slice(batch.length);
  return batch;
}

function flush(useBeacon: boolean): void {
  if (!queue.length) return;
  const batch = drain();
  const body = JSON.stringify({ items: batch });
  try {
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(INGEST_PATH, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(INGEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'include',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* telemetry must never throw into the app */
  }
}

// ── Capture: navigation timing ──────────────────────────────────────────────

function capturePageLoad(): void {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return;
    const total = nav.loadEventEnd > 0 ? nav.loadEventEnd : nav.duration;
    if (!Number.isFinite(total) || total <= 0) return;
    enqueue({
      kind: 'pageLoad',
      surface: currentSurface(),
      at: nowIso(),
      totalMs: Math.round(total),
      networkMs: Math.max(0, Math.round(nav.connectEnd - nav.fetchStart)),
      sendMs: Math.max(0, Math.round(nav.responseStart - nav.requestStart)),
      receiveMs: Math.max(0, Math.round(nav.responseEnd - nav.responseStart)),
      processingMs: Math.max(0, Math.round((nav.domComplete || nav.responseEnd) - nav.responseEnd)),
    });
  } catch {
    /* older browsers — skip silently */
  }
}

// ── Capture: web vitals via PerformanceObserver ────────────────────────────

interface VitalsState {
  lcpMs?: number;
  fcpMs?: number;
  cls?: number;
  inpMs?: number;
  reported: boolean;
}

function installVitals(state: VitalsState): void {
  const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, extra?: Record<string, unknown>) => {
    try {
      const obs = new PerformanceObserver((list) => cb(list.getEntries()));
      obs.observe({ type, buffered: true, ...(extra || {}) } as PerformanceObserverInit);
    } catch {
      /* entry type unsupported — fine */
    }
  };
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) state.lcpMs = Math.round(last.startTime);
  });
  observe('paint', (entries) => {
    for (const e of entries) {
      if (e.name === 'first-contentful-paint') state.fcpMs = Math.round(e.startTime);
    }
  });
  observe('layout-shift', (entries) => {
    for (const e of entries) {
      const ls = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!ls.hadRecentInput && typeof ls.value === 'number') {
        state.cls = (state.cls ?? 0) + ls.value;
      }
    }
  });
  // INP approximation: the worst event-interaction duration seen (the real INP
  // is a high percentile over interactions; max-duration is an honest,
  // clearly-labeled upper bound — the admin view labels it "INP (approx)").
  observe(
    'event',
    (entries) => {
      for (const e of entries) {
        const d = Math.round(e.duration);
        if (d > (state.inpMs ?? 0)) state.inpMs = d;
      }
    },
    { durationThreshold: 40 },
  );
}

function reportVitals(state: VitalsState): void {
  if (state.reported) return;
  state.reported = true;
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const ttfbMs = nav && nav.responseStart > 0 ? Math.round(nav.responseStart) : undefined;
    if (
      state.lcpMs === undefined && state.fcpMs === undefined && ttfbMs === undefined &&
      state.cls === undefined && state.inpMs === undefined
    ) return;
    enqueue({
      kind: 'vitals',
      surface: currentSurface(),
      at: nowIso(),
      lcpMs: state.lcpMs,
      fcpMs: state.fcpMs,
      ttfbMs,
      cls: state.cls !== undefined ? Math.round(state.cls * 1000) / 1000 : undefined,
      inpMs: state.inpMs,
    });
  } catch {
    /* never throw */
  }
}

// ── Capture: errors ─────────────────────────────────────────────────────────

function captureError(name: unknown, message: unknown, source: 'window' | 'unhandledrejection'): void {
  if (errorCount >= RUM_MAX_ERRORS_PER_SESSION) return;
  const n = scrubText(name, 80) || 'Error';
  const m = scrubText(message, 300) || '(no message)';
  const surface = currentSurface();
  const fp = `${n}::${m.slice(0, 80)}::${surface}`;
  if (seenErrors.has(fp)) return;
  seenErrors.add(fp);
  errorCount += 1;
  enqueue({ kind: 'error', surface, at: nowIso(), name: n, message: m, source });
}

// ── Install (once per page lifetime, only when enabled + sampled) ──────────

function isSessionSampled(sampleRate: number): boolean {
  try {
    const prior = sessionStorage.getItem(SAMPLE_KEY);
    if (prior === 'in') return true;
    if (prior === 'out') return false;
    const sampled = Math.random() * 100 < sampleRate;
    sessionStorage.setItem(SAMPLE_KEY, sampled ? 'in' : 'out');
    return sampled;
  } catch {
    return sampleRate >= 100;
  }
}

function install(): () => void {
  const vitals: VitalsState = { reported: false };
  installVitals(vitals);

  if (document.readyState === 'complete') {
    capturePageLoad();
  } else {
    window.addEventListener('load', () => capturePageLoad(), { once: true });
  }

  const onError = (e: ErrorEvent) => {
    const err = e.error as Error | undefined;
    captureError(err?.name ?? 'Error', err?.message ?? e.message, 'window');
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason as Error | string | undefined;
    const name = r instanceof Error ? r.name : 'UnhandledRejection';
    const message = r instanceof Error ? r.message : typeof r === 'string' ? r : '(non-error rejection)';
    captureError(name, message, 'unhandledrejection');
  };
  const onHide = () => {
    if (document.visibilityState === 'hidden') {
      reportVitals(vitals);
      flush(true);
    }
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  const timer = window.setInterval(() => flush(false), FLUSH_INTERVAL_MS);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onHide);
    window.clearInterval(timer);
  };
}

/**
 * Mounts RUM capture (no UI). Rendered once inside the client Providers tree
 * (app/providers.tsx). Fetches the config once, honors sampling + the runtime
 * kill-switch, then installs the passive observers.
 */
export function RumTelemetry(): null {
  const pathname = usePathname();
  const activeRef = useRef(false);
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (installed) return;
    installed = true;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    (async () => {
      try {
        const res = await fetch(INGEST_PATH, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) return; // 401 pre-auth / disabled — silent no-op
        const cfg = (await res.json()) as { ok?: boolean; enabled?: boolean; sampleRate?: number };
        if (!cfg?.ok || !cfg.enabled) return;
        if (!isSessionSampled(typeof cfg.sampleRate === 'number' ? cfg.sampleRate : 100)) return;
        if (cancelled) return;
        activeRef.current = true;
        lastPathRef.current = window.location.pathname;
        cleanup = install();
      } catch {
        /* config unreachable — capture stays off */
      }
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Soft route changes (App Router pathname transitions).
  useEffect(() => {
    if (!activeRef.current || !pathname) return;
    if (lastPathRef.current === null) {
      lastPathRef.current = pathname;
      return;
    }
    if (lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;
    enqueue({ kind: 'routeChange', surface: scrubSurfacePath(pathname), at: nowIso() });
  }, [pathname]);

  return null;
}

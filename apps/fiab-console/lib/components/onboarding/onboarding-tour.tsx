'use client';

/**
 * OnboardingTour — first-run guided tour overlay.
 *
 * Mounted once as a singleton in {@link AppShell} (next to CommandPalette,
 * CopilotPane, FeedbackWidget …). It walks the operator through the core shell
 * surfaces using Fluent's purpose-built TeachingPopover coachmark — no new
 * dependency, no blocking modal.
 *
 * Trigger / resume:
 *   - First run: auto-opens once the operator is authenticated and has not
 *     already completed/dismissed this tour version.
 *   - Replay: any surface can call {@link openTour} (the topbar Help menu wires
 *     a "Take the tour" item to it). Replay resumes from the last viewed step.
 *
 * Persistence (two layers, no new infra):
 *   - localStorage `loom.tourSeen.v<N>` — first-paint anti-flash guard so the
 *     bubble never flashes before the /api/me + Cosmos round-trip resolves.
 *   - Cosmos `user-prefs` via GET/POST /api/user-prefs — cross-device durable
 *     `tour:v<N>:completed` (gates auto-open) + `tour:v<N>:lastStep` (resume).
 *
 * Pure client-side Fluent v9 — zero Fabric/Power BI dependency, renders
 * identically in Commercial, GCC, GCC-High, and IL5.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TeachingPopover,
  TeachingPopoverSurface,
  Button,
  Text,
  Link as FluentLink,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowRight16Regular,
  ArrowLeft16Regular,
  Dismiss20Regular,
  Open16Regular,
} from '@fluentui/react-icons';
import { usePathname, useRouter } from 'next/navigation';
import { TOUR_STEPS, TOUR_VERSION } from '@/lib/onboarding/tour-steps';

const EVT_OPEN = 'csaloom:open-tour';
const SEEN_KEY = `loom.tourSeen.v${TOUR_VERSION}`;
const PREF_DONE = `tour:v${TOUR_VERSION}:completed`;
const PREF_STEP = `tour:v${TOUR_VERSION}:lastStep`;

/** Open (or resume) the guided tour from anywhere in the app. */
export function openTour() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT_OPEN));
}

interface MeResponse {
  authenticated: boolean;
  user: null | { oid: string };
}

/** Resolve an anchor element, polling briefly while a route's DOM mounts. */
function waitForAnchor(selector: string, timeoutMs = 3000): Promise<HTMLElement | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  const immediate = document.querySelector<HTMLElement>(selector);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      obs.disconnect();
      clearTimeout(timer);
      resolve(el);
    };
    const obs = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) finish(el);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(document.querySelector<HTMLElement>(selector)), timeoutMs);
  });
}

const useStyles = makeStyles({
  surface: {
    maxWidth: '360px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  title: { fontWeight: tokens.fontWeightSemibold },
  body: { color: tokens.colorNeutralForeground2, lineHeight: tokens.lineHeightBase300 },
  learn: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '2px' },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
  },
  count: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
  footerBtns: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

export function OnboardingTour() {
  const styles = useStyles();
  const router = useRouter();
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  // Resume pointer kept in a ref so the (stable) event listener always reads
  // the latest persisted step without re-subscribing.
  const lastStepRef = useRef(0);
  // Element we applied the highlight outline to, so we can restore it.
  const highlightRef = useRef<{ el: HTMLElement; outline: string; offset: string } | null>(null);

  const persistStep = useCallback((i: number) => {
    lastStepRef.current = i;
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: PREF_STEP, value: i }),
    }).catch(() => {});
  }, []);

  const markDone = useCallback(() => {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* no storage */ }
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: PREF_DONE, value: true }),
    }).catch(() => {});
  }, []);

  // First-run auto-open: authenticated + not previously completed/dismissed.
  useEffect(() => {
    let cancelled = false;
    try { if (localStorage.getItem(SEEN_KEY) === '1') return; } catch { /* continue */ }
    (async () => {
      try {
        const me: MeResponse = await fetch('/api/me').then((r) => r.json());
        if (cancelled || !me?.authenticated) return;
        const done = await fetch(`/api/user-prefs?key=${encodeURIComponent(PREF_DONE)}`).then((r) => r.json());
        if (cancelled) return;
        if (done?.value) {
          try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
          return;
        }
        const last = await fetch(`/api/user-prefs?key=${encodeURIComponent(PREF_STEP)}`).then((r) => r.json());
        if (cancelled) return;
        const resumeAt = typeof last?.value === 'number'
          ? Math.min(Math.max(last.value, 0), TOUR_STEPS.length - 1)
          : 0;
        lastStepRef.current = resumeAt;
        setStepIndex(resumeAt);
        setOpen(true);
      } catch { /* unauthenticated / offline — stay closed */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Manual open / resume.
  useEffect(() => {
    const onOpen = () => {
      // Resume from the last viewed step; if the tour was finished, restart.
      const resumeAt = lastStepRef.current >= TOUR_STEPS.length - 1 ? 0 : lastStepRef.current;
      setStepIndex(resumeAt);
      setOpen(true);
    };
    window.addEventListener(EVT_OPEN, onOpen);
    return () => window.removeEventListener(EVT_OPEN, onOpen);
  }, []);

  // Resolve the current step's anchor (navigating cross-surface if needed).
  useEffect(() => {
    if (!open) return;
    const step = TOUR_STEPS[stepIndex];
    if (!step) return;
    let cancelled = false;
    setTarget(null);
    (async () => {
      if (step.route && pathname !== step.route) {
        router.push(step.route);
      }
      const el =
        (await waitForAnchor(step.anchorSelector)) ??
        document.querySelector<HTMLElement>('[data-tour="brand"]');
      if (!cancelled) setTarget(el);
    })();
    return () => { cancelled = true; };
  }, [open, stepIndex, pathname, router]);

  // Spotlight: outline the current anchor; restore the previous one on change.
  useEffect(() => {
    const prev = highlightRef.current;
    if (prev) {
      prev.el.style.outline = prev.outline;
      prev.el.style.outlineOffset = prev.offset;
      highlightRef.current = null;
    }
    if (open && target) {
      highlightRef.current = { el: target, outline: target.style.outline, offset: target.style.outlineOffset };
      target.style.outline = `2px solid ${tokens.colorBrandStroke1}`;
      target.style.outlineOffset = '2px';
    }
    return () => {
      const cur = highlightRef.current;
      if (cur) {
        cur.el.style.outline = cur.outline;
        cur.el.style.outlineOffset = cur.offset;
        highlightRef.current = null;
      }
    };
  }, [open, target]);

  const close = useCallback(() => {
    setOpen(false);
    setTarget(null);
  }, []);

  const dismiss = useCallback(() => {
    persistStep(stepIndex);
    markDone();
    close();
  }, [stepIndex, persistStep, markDone, close]);

  const next = useCallback(() => {
    const isLast = stepIndex >= TOUR_STEPS.length - 1;
    if (isLast) {
      persistStep(TOUR_STEPS.length - 1);
      markDone();
      close();
      return;
    }
    const ni = stepIndex + 1;
    persistStep(ni);
    setStepIndex(ni);
  }, [stepIndex, persistStep, markDone, close]);

  const prev = useCallback(() => {
    const pi = Math.max(0, stepIndex - 1);
    persistStep(pi);
    setStepIndex(pi);
  }, [stepIndex, persistStep]);

  if (!open || !target) return null;
  const step = TOUR_STEPS[stepIndex];
  if (!step) return null;
  const isLast = stepIndex >= TOUR_STEPS.length - 1;

  return (
    <TeachingPopover
      open={open}
      onOpenChange={(_, d) => { if (!d.open) dismiss(); }}
      withArrow
      trapFocus
      positioning={{ target, position: step.position ?? 'below', align: 'center' }}
    >
      <TeachingPopoverSurface className={styles.surface} aria-label={`Guided tour: ${step.title}`}>
        <div className={styles.header}>
          <Text className={styles.title} size={400}>{step.title}</Text>
          <Button
            appearance="transparent"
            size="small"
            icon={<Dismiss20Regular />}
            onClick={dismiss}
            aria-label="Close tour"
          />
        </div>
        <Text className={styles.body} size={300}>{step.body}</Text>
        {step.docHref && (
          <FluentLink className={styles.learn} href={step.docHref} onClick={dismiss}>
            Learn more <Open16Regular />
          </FluentLink>
        )}
        <div className={styles.footer}>
          <Text className={styles.count} size={200}>{stepIndex + 1} of {TOUR_STEPS.length}</Text>
          <div className={styles.footerBtns}>
            <Button appearance="subtle" size="small" onClick={dismiss}>Skip</Button>
            {stepIndex > 0 && (
              <Button appearance="secondary" size="small" icon={<ArrowLeft16Regular />} onClick={prev}>
                Back
              </Button>
            )}
            <Button
              appearance="primary"
              size="small"
              icon={isLast ? undefined : <ArrowRight16Regular />}
              iconPosition="after"
              onClick={next}
            >
              {isLast ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </TeachingPopoverSurface>
    </TeachingPopover>
  );
}

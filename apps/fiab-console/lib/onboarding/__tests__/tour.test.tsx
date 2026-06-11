/**
 * Tests for the first-run guided tour.
 *
 * Scope is the deterministic, no-backend surface: the step registry invariants
 * and the window-event contract that lets any surface open/resume the tour.
 * (Per no-vaporware: we do not assert backend behavior this test cannot run.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TOUR_STEPS, TOUR_VERSION } from '@/lib/onboarding/tour-steps';
import { openTour } from '@/lib/components/onboarding/onboarding-tour';

describe('tour-steps registry', () => {
  it('has at least the core shell surfaces', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(4);
  });

  it('every step targets a stable data-tour anchor and has copy', () => {
    for (const step of TOUR_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.anchorSelector).toMatch(/^\[data-tour="[a-z-]+"\]$/);
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('step ids are unique', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('any route / docHref is an in-app absolute path', () => {
    for (const step of TOUR_STEPS) {
      if (step.route) expect(step.route.startsWith('/')).toBe(true);
      if (step.docHref) expect(step.docHref.startsWith('/')).toBe(true);
    }
  });

  it('starts the cross-surface step on the Setup wizard route', () => {
    const setup = TOUR_STEPS.find((s) => s.id === 'setup');
    expect(setup?.route).toBe('/setup');
    expect(setup?.anchorSelector).toBe('[data-tour="setup-intro"]');
  });

  it('TOUR_VERSION is a positive integer used for namespaced persistence', () => {
    expect(Number.isInteger(TOUR_VERSION)).toBe(true);
    expect(TOUR_VERSION).toBeGreaterThan(0);
  });
});

describe('openTour event contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dispatches the resume event that the mounted tour listens for', () => {
    const events: string[] = [];
    const handler = (e: Event) => events.push(e.type);
    window.addEventListener('csaloom:open-tour', handler);
    openTour();
    window.removeEventListener('csaloom:open-tour', handler);
    expect(events).toContain('csaloom:open-tour');
  });
});

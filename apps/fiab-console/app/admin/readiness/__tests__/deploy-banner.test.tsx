/**
 * /admin/readiness — the DEPLOY BANNER's headline and body must be the same
 * verdict's (#3676).
 *
 * WHY THIS FILE EXISTS. `deployBannerBody` was extracted and unit-tested, and
 * the page was wired to call it — but there was no test under
 * `app/admin/readiness/` at all, so nothing observed the JSX. Mutating
 * `{body.detail}` back to `{status.estate.detail}` — restoring the exact
 * reassuring-text defect the extraction was written to remove — passed 116/116,
 * and because the two expressions are both `string`, `tsc --noEmit` cannot tell
 * them apart either. A helper that is correct and a caller that does not use it
 * is indistinguishable from the bug, in every gate the repo had.
 *
 * So these assert the RENDERED DOM: under a regression headline the regression's
 * own sentence and its run link are on screen, and under a behind-estate
 * headline the drift sentence is — the two mutations named in the extraction's
 * own doc comment, checked where they actually land.
 *
 * Per ux-baseline.md G1 a DOM assertion is NOT a completion receipt for a
 * surface; it is a REGRESSION PIN for one wire. The browser walk is still owed
 * and is not claimed here.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '@/lib/editors/__tests__/test-helpers';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/readiness',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import AdminReadinessPage from '../page';

/** The readiness payload itself is not under test — keep the page mounting. */
const READINESS = {
  ok: true,
  generatedAt: '2026-08-19T08:00:00Z',
  cloud: 'Commercial',
  capabilities: [],
  workloads: [],
  summary: {
    capabilities: { ready: 0, partial: 0, blocked: 0, unknown: 0, total: 0 },
    workloads: { ready: 0, partial: 0, blocked: 0, total: 0 },
    score: 0,
    configOnly: 0,
  },
};

const ESTATE_DETAIL = 'Running build 83e7cab6 (built 2026-08-19T05:32:11Z) — no commits behind main.';
const REGRESSION_DETAIL =
  'A successful loom-roll-and-validate.yml roll put 150d2937 on this estate at 2026-08-19T07:05:14Z, and it is '
  + 'now serving 83e7cab6 — an image built BEFORE that roll. This is the #3676 race.';
const RUN_URL = 'https://github.com/fgarofalo56/csa-inabox/actions/runs/32225337320';

/** A deploy-status response whose HEADLINE is owned by the roll regression. */
const REGRESSED = {
  ok: true,
  generatedAt: '2026-08-19T08:00:00Z',
  repo: 'fgarofalo56/csa-inabox',
  severity: 'error',
  headline: 'This estate was rolled BACKWARDS off 150d2937',
  headlineOwner: 'roll-regression',
  estate: {
    buildSha: '83e7cab6', buildStamp: '2026-08-19T05:32:11Z', branch: 'main',
    compareUrl: null, behindSince: null, behindForMinutes: null,
    state: 'current', commitsBehind: 0, severity: 'ok',
    headline: 'This estate is running main',
    detail: ESTATE_DETAIL,
  },
  paths: [],
  estates: [],
  rollRegression: {
    estateSha: '83e7cab6', rolledSha: '150d2937', rolledAt: '2026-08-19T07:05:14Z',
    rollWorkflow: 'loom-roll-and-validate.yml', rollRunUrl: RUN_URL,
    state: 'regressed', severity: 'error',
    headline: 'This estate was rolled BACKWARDS off 150d2937',
    detail: REGRESSION_DETAIL,
  },
};

/** CONTROL — the estate owns the headline, the roll is fine. */
const BEHIND_WITH_CURRENT_ROLL = {
  ...REGRESSED,
  severity: 'error',
  headline: 'This estate is 5 commits behind main',
  headlineOwner: 'estate',
  estate: {
    ...REGRESSED.estate,
    state: 'behind', commitsBehind: 5, severity: 'error',
    headline: 'This estate is 5 commits behind main',
    compareUrl: 'https://github.com/fgarofalo56/csa-inabox/compare/83e7cab6...main',
    detail: ESTATE_DETAIL,
  },
  rollRegression: {
    ...REGRESSED.rollRegression,
    state: 'current', severity: 'ok',
    headline: 'This estate is running what the last roll shipped',
    detail: REGRESSION_DETAIL,
  },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/**
 * The MessageBarBody that CONTAINS a given headline.
 *
 * Scoped deliberately, not `document.body`: the property under test is "the
 * sentence UNDER this headline", so the assertion has to be made on the element
 * that holds both. A page-wide text search would pass if the right sentence
 * appeared anywhere at all — including in the fleet table below the banner.
 *
 * `getByText` on the detail alone cannot work here: it is a bare text node
 * rendered as a SIBLING of the run-link fragment inside MessageBarBody, so no
 * single element's textContent equals it.
 */
const bannerBodyFor = (headline: string): HTMLElement => {
  const title = screen.getByText(headline);
  const body = title.parentElement;
  if (!body) throw new Error(`the headline "${headline}" has no parent — the banner did not render`);
  return body;
};

describe('/admin/readiness deploy banner — whoever owns the headline owns the body', () => {
  it('THE DEFECT: under a REGRESSION headline the rendered body is the regression, not the drift line', async () => {
    installFetchMock({
      '/api/admin/deploy-status': () => REGRESSED,
      '/api/admin/readiness': () => READINESS,
    });
    renderWithProviders(<AdminReadinessPage />);

    await waitFor(() =>
      expect(screen.getByText('This estate was rolled BACKWARDS off 150d2937')).toBeInTheDocument());
    const body = bannerBodyFor('This estate was rolled BACKWARDS off 150d2937');

    // The regression's own sentence is UNDER THAT HEADLINE…
    expect(body.textContent).toContain(REGRESSION_DETAIL);
    // …and the sentence that used to sit there is NOT. This is the whole defect:
    // "no commits behind main" read as reassurance directly beneath the loudest
    // thing this banner can print.
    expect(body.textContent).not.toContain(ESTATE_DETAIL);

    // The run link finally reaches the DOM, so the claim above it is checkable.
    const link = screen.getByRole('link', { name: 'Open the roll that shipped it' });
    expect(link).toHaveAttribute('href', RUN_URL);
  });

  it('CONTROL: under a BEHIND-ESTATE headline the body is the estate detail and there is no roll link', async () => {
    // Without this, the assertion above is satisfied by "always render the
    // regression", which would hide the drift sentence on every ordinary
    // behind-estate load — the mutation the extracted helper's doc names.
    installFetchMock({
      '/api/admin/deploy-status': () => BEHIND_WITH_CURRENT_ROLL,
      '/api/admin/readiness': () => READINESS,
    });
    renderWithProviders(<AdminReadinessPage />);

    await waitFor(() =>
      expect(screen.getByText('This estate is 5 commits behind main')).toBeInTheDocument());
    const body = bannerBodyFor('This estate is 5 commits behind main');

    expect(body.textContent).toContain(ESTATE_DETAIL);
    expect(body.textContent).not.toContain(REGRESSION_DETAIL);
    // No roll link under someone else's verdict — it would read as the subject
    // of the sentence above it.
    expect(screen.queryByRole('link', { name: 'Open the roll that shipped it' })).toBeNull();
    // …and the compare link, which is suppressed while the regression owns the
    // body, IS present here.
    expect(screen.getByRole('link', { name: 'See the 5 commits' })).toBeInTheDocument();
  });
});

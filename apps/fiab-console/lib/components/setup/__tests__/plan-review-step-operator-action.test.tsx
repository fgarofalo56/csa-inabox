/**
 * #3342 — the plan review renders an `operator-action` remediation, mounts the
 * registry gate it names, and keeps a Re-check for an `unknown` verdict.
 *
 * Before this the wizard printed only `platform-will-fix` remediations: an
 * operator blocked by an `unknown` Databricks metastore check saw the defect
 * but not the action, and the Validate button disappeared after the first run,
 * so the live re-read that clears the blocker had no button. jsdom, real
 * component tree (HonestGate included); only the client fetch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn(async () => ({ status: 200, json: async () => ({ ok: true }) })) }));

import { PlanReviewStep } from '../plan-review-step';
import type { DeploymentPlan, ServiceDecision } from '@/lib/deploy/plan-model';
import type { FitnessResult } from '@/lib/deploy/fitness';

afterEach(cleanup);

const CLIENT_ID = 'c1d2e3f4-0000-1111-2222-333344445555';

function plan(fitness?: FitnessResult): DeploymentPlan {
  const d: ServiceDecision = {
    mode: 'adopt', source: 'discovered', decidedBy: 'op', decidedAt: '2026-10-03T00:00:00Z',
    target: { name: 'dbw-existing', rg: 'rg', sub: '11111111-2222-3333-4444-555555555555' },
    ...(fitness ? { fitness } : {}),
  };
  return {
    planId: 'p', schemaVersion: 1, createdAt: '', createdBy: '', boundary: 'Commercial' as any, topology: 'single' as any,
    installSubscriptionId: 's', region: 'eastus2', tenantId: 't', scanScope: { subscriptions: [], managementGroups: [] },
    scanResults: [], services: { databricks: d }, network: {} as any, featureFlags: {}, planHash: 'abcdef0123456789',
  };
}

const UNKNOWN_METASTORE: FitnessResult = {
  verdict: 'unknown',
  checks: [{
    id: 'databricks.metastoreAssignment', verdict: 'unknown',
    what: 'Loom could not read the Unity Catalog metastore assignment of Azure Databricks "dbw-existing"',
    why: 'Metastore assignment is one per account per region.',
    established: 'the Databricks account API refused the Console identity (HTTP 403: not an account admin)',
    remediation: {
      kind: 'operator-action', gateId: 'svc-databricks-account-admin',
      description: `A Databricks account admin must give the Console identity the Account admin role: application (client) id ${CLIENT_ID}.`,
      portalUrl: 'https://accounts.azuredatabricks.net',
      role: { name: 'Databricks account admin', scope: 'Databricks account acct-0f0f' },
    },
  }],
};

const wrap = (ui: React.ReactElement) => render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);

describe('PlanReviewStep — operator actions', () => {
  it('shows the action, the account-console link and the registry gate for an unknown metastore check', () => {
    wrap(<PlanReviewStep plan={plan(UNKNOWN_METASTORE)} rows={[]} onValidate={vi.fn()} />);
    // Breaks if operator-action remediations go back to being dropped.
    expect(screen.getAllByText(new RegExp(CLIENT_ID)).length).toBeGreaterThan(0);
    const link = screen.getByRole('link', { name: /Open accounts\.azuredatabricks\.net/ });
    expect(link.getAttribute('href')).toBe('https://accounts.azuredatabricks.net');
    // HonestGate mounted for the registered gate, with its Fix-it.
    expect(screen.getAllByRole('button', { name: /Fix it/ }).length).toBeGreaterThan(0);
  });

  // Breaks if `needsValidation` goes back to "no verdict only": after the first
  // validation every adopt HAS a verdict, so the re-read had no button.
  it('keeps a Re-check for an unknown verdict, and it re-runs validation', () => {
    const onValidate = vi.fn();
    wrap(<PlanReviewStep plan={plan(UNKNOWN_METASTORE)} rows={[]} onValidate={onValidate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-check these resources' }));
    expect(onValidate).toHaveBeenCalledTimes(1);
  });

  it('offers no re-check for a measured UNUSABLE verdict — measuring again does not fix it', () => {
    const unusable: FitnessResult = {
      verdict: 'unusable',
      checks: [{ ...UNKNOWN_METASTORE.checks[0], verdict: 'fail', remediation: { kind: 'not-remediable', description: 'x', alternative: 'y' } }],
    };
    wrap(<PlanReviewStep plan={plan(unusable)} rows={[]} onValidate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Re-check these resources|Validate these resources/ })).toBeNull();
  });

  it('labels the first run "Validate" while an adopt has no verdict yet', () => {
    wrap(<PlanReviewStep plan={plan()} rows={[]} onValidate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Validate these resources' })).toBeTruthy();
  });
});

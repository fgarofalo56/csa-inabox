/**
 * N4 — plan/apply wizard render tests.
 *
 * Covers the three things the UX rules make blocking for this surface:
 *   • FIRST OPEN IS CLEAN — an unplanned project shows a guided empty state,
 *     never a red error banner (ux-baseline "no red on first open").
 *   • The wizard's copy is honest per engine — dbt is told it has targets, not
 *     virtual environments, and that apply is `dbt build`.
 *   • Applying to production is gated behind an explicit confirmation.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { PlanApplyWizard } from '../plan-apply-wizard';
import {
  emptyTransformProject, type TransformProject,
} from '@/lib/transform/transform-project-model';

// The wizard only calls the BFF on a button press; stub it so nothing escapes.
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, environments: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })),
}));

afterEach(cleanup);

function project(overrides: Partial<TransformProject> = {}): TransformProject {
  return {
    ...emptyTransformProject('loom_sales'),
    models: [{ name: 'fct_orders', layer: 'silver', materialized: 'table', sql: 'SELECT 1' }],
    ...overrides,
  };
}

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

describe('PlanApplyWizard', () => {
  it('renders the three guided steps', () => {
    wrap(<PlanApplyWizard itemId="i1" project={project()} backend="dbt" />);
    expect(screen.getByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('Impact')).toBeInTheDocument();
    expect(screen.getByText('Apply')).toBeInTheDocument();
  });

  it('opens CLEAN — a guided empty state, no error banner', () => {
    wrap(<PlanApplyWizard itemId="i1" project={project()} backend="sqlmesh" />);
    expect(screen.getByText('No plan yet')).toBeInTheDocument();
    expect(screen.queryByText('Could not complete that step')).not.toBeInTheDocument();
    // No impact is CLAIMED before a plan exists — the grid is simply absent.
    expect(screen.queryByRole('table', { name: /Plan impact/i })).not.toBeInTheDocument();
  });

  it('tells a dbt project the truth about environments and apply', () => {
    wrap(<PlanApplyWizard itemId="i1" project={project({ backend: 'dbt' })} backend="dbt" />);
    expect(screen.getByText(/dbt has targets rather than virtual environments/i)).toBeInTheDocument();
    expect(screen.getByText(/dbt has no view swap/i)).toBeInTheDocument();
  });

  it('describes the virtual-environment view swap for a SQLMesh project', () => {
    wrap(<PlanApplyWizard itemId="i1" project={project({ backend: 'sqlmesh' })} backend="sqlmesh" />);
    expect(screen.getByText(/views over shared physical tables/i)).toBeInTheDocument();
    expect(screen.getByText(/backfills only the intervals the plan listed/i)).toBeInTheDocument();
  });

  it('defaults to the project default environment and disables Apply until a plan exists', () => {
    wrap(<PlanApplyWizard itemId="i1" project={project()} backend="sqlmesh" />);
    const apply = screen.getByRole('button', { name: /Apply to dev/i });
    expect(apply).toBeDisabled();
    expect(screen.getByText('Run a plan first.')).toBeInTheDocument();
  });

  it('requires an explicit production confirmation when the target is prod', () => {
    wrap(
      <PlanApplyWizard
        itemId="i1"
        project={project({ defaultEnvironment: 'prod' })}
        backend="sqlmesh"
      />,
    );
    const confirm = screen.getByLabelText(/I understand this changes production/i);
    expect(confirm).not.toBeChecked();
    fireEvent.click(confirm);
    expect(confirm).toBeChecked();
    // Still disabled — a confirmation is necessary but not sufficient; a plan
    // with changes is required too.
    expect(screen.getByRole('button', { name: /Apply to prod/i })).toBeDisabled();
  });

  it('does not offer a production confirmation for a non-prod environment', () => {
    wrap(<PlanApplyWizard itemId="i1" project={project()} backend="sqlmesh" />);
    expect(screen.queryByLabelText(/I understand this changes production/i)).not.toBeInTheDocument();
  });
});

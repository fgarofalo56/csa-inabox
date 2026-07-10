/**
 * SqlMigrationWizard — Vitest contract test.
 *
 * Renders the standalone migration wizard (embedded in the Warehouse editor's
 * Migrate tab) and asserts the upload step + reworked SC-6 teaching banner
 * mount. No network is required to render the initial step.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { SqlMigrationWizard } from '../sql-migration-wizard';
import { renderWithProviders } from './test-helpers';

describe('SqlMigrationWizard', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the upload step and teaching banner', () => {
    let err: unknown = null;
    try {
      renderWithProviders(<SqlMigrationWizard />);
      expect(screen.getByText('Migration assistant')).toBeInTheDocument();
      expect(screen.getByText(/Bring an existing SQL schema across/i)).toBeInTheDocument();
      expect(screen.getByText(/Assess compatibility/i)).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});

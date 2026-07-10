/**
 * PermissionMatrix (UX-702) — render + teaching-UX contract.
 *
 * Asserts the grant form mounts with its dismissible TeachingBanner (SC-6 —
 * "One role, mapped to the right privileges") and the Grant/Revoke toolbar,
 * per the ux-standards §7 baseline for a policy/ACL surface.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { PermissionMatrix } from '../permission-matrix';

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe('PermissionMatrix', () => {
  it('renders the grant form with the teaching banner and grant action', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <PermissionMatrix />
      </FluentProvider>,
    );
    expect(screen.getByText(/one role, mapped to the right privileges/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^grant$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^revoke$/i })).toBeInTheDocument();
  });
});

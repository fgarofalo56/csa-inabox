/**
 * teaching-toast (SC-6) — render + persistence tests.
 *
 * <TeachingBanner> is a dismissible per-surface teaching banner whose dismissal
 * persists in localStorage under `loom.teaching.<key>`. These jsdom tests
 * exercise the REAL component and assert:
 *   1. the title, message, and Learn-more link render;
 *   2. clicking dismiss hides the banner and writes the persisted flag;
 *   3. a freshly-mounted banner with a already-dismissed key renders nothing;
 *   4. `nonDismissible` renders the banner with no dismiss control.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TeachingBanner } from '../teaching-toast';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('TeachingBanner', () => {
  it('renders the title, message, and Learn-more link', () => {
    wrap(
      <TeachingBanner
        surfaceKey="test-analyze"
        title="Analyze your data"
        message="Explore in a notebook or SQL endpoint."
        learnMoreHref="https://learn.microsoft.com/azure/"
      />,
    );
    expect(screen.getByText('Analyze your data')).toBeInTheDocument();
    expect(screen.getByText(/Explore in a notebook/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /learn more/i })).toHaveAttribute('href', 'https://learn.microsoft.com/azure/');
  });

  it('dismisses and persists the dismissal to localStorage', async () => {
    wrap(<TeachingBanner surfaceKey="test-dismiss" message="A helpful tip." />);
    expect(screen.getByText('A helpful tip.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss this tip/i }));

    await waitFor(() => expect(screen.queryByText('A helpful tip.')).toBeNull());
    expect(window.localStorage.getItem('loom.teaching.test-dismiss')).toBe('1');
  });

  it('renders nothing when the surface key was previously dismissed', async () => {
    window.localStorage.setItem('loom.teaching.test-prior', '1');
    wrap(<TeachingBanner surfaceKey="test-prior" message="Should not show." />);
    // The banner starts visible then reconciles from storage in an effect.
    await waitFor(() => expect(screen.queryByText('Should not show.')).toBeNull());
  });

  it('renders no dismiss control when nonDismissible', () => {
    wrap(<TeachingBanner surfaceKey="test-fixed" message="Always here." nonDismissible />);
    expect(screen.getByText('Always here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss this tip/i })).toBeNull();
  });
});

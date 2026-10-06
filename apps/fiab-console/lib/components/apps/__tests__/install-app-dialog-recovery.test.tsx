import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { InstallDialogBoundary } from '../install-app-dialog';

afterEach(() => {
  cleanup();
});

function renderBoundary(child: JSX.Element, onOpenChange = () => {}) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <InstallDialogBoundary appName="RAG Builder" onOpenChange={onOpenChange}>
        {child}
      </InstallDialogBoundary>
    </FluentProvider>,
    {
      onCaughtError: () => {},
      onRecoverableError: () => {},
    },
  );
}

describe('InstallDialogBoundary', () => {
  it('reloads the dialog after a hydration-like render failure (#3528)', () => {
    // Breaking input: the same minified hydration message the live bug logged.
    let shouldThrow = true;
    function ThrowWhileFlag() {
      if (shouldThrow) {
        throw new Error('Minified React error #418; visit https://react.dev/errors/418');
      }
      return <div data-testid="recovered">workspace picker remounted</div>;
    }

    renderBoundary(<ThrowWhileFlag />);

    expect(screen.getByText('Reload the install dialog')).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reload dialog' }));
    expect(screen.getByTestId('recovered')).toHaveTextContent('workspace picker remounted');
  });

  it('offers a generic retry for non-hydration render failures', () => {
    // Breaking input: any ordinary render error that is NOT a hydration mismatch.
    let shouldThrow = true;
    function ThrowWhileFlag() {
      if (shouldThrow) {
        throw new Error('boom');
      }
      return <div data-testid="recovered">dialog remounted</div>;
    }

    renderBoundary(<ThrowWhileFlag />);

    expect(screen.getByText('The install dialog hit an unexpected error')).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('recovered')).toHaveTextContent('dialog remounted');
  });
});

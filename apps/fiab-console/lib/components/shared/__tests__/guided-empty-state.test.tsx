/**
 * GuidedEmptyState (SC-4) — render + contract tests.
 *
 * The shared N-path launcher renders icon cards, an optional Ask-Copilot card,
 * and a Learn-more link. These jsdom tests exercise the REAL component and
 * assert:
 *   1. the title, intro, and every path card render;
 *   2. clicking a path card fires that path's onClick (real action — no dead tile);
 *   3. the Ask-Copilot card fires askCopilot.onClick;
 *   4. a Learn-more link points at the given href;
 *   5. an href-bearing path renders as a real anchor.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Flow24Regular, Table24Regular } from '@fluentui/react-icons';
import { GuidedEmptyState, type GuidedPath } from '../guided-empty-state';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

afterEach(cleanup);

describe('GuidedEmptyState', () => {
  it('renders the title, intro, and each path card', () => {
    const paths: GuidedPath[] = [
      { key: 'blank', title: 'Blank query', body: 'Start empty.', icon: Flow24Regular, onClick: () => {} },
      { key: 'sample', title: 'Sample table', body: 'Start from a sample.', icon: Table24Regular, onClick: () => {} },
    ];
    wrap(<GuidedEmptyState title="Get data" intro="Pick a source." paths={paths} />);
    expect(screen.getByText('Get data')).toBeInTheDocument();
    expect(screen.getByText('Pick a source.')).toBeInTheDocument();
    expect(screen.getByText('Blank query')).toBeInTheDocument();
    expect(screen.getByText('Sample table')).toBeInTheDocument();
  });

  it('fires a path onClick when its card is clicked', () => {
    const onClick = vi.fn();
    const paths: GuidedPath[] = [
      { key: 'blank', title: 'Blank query', body: 'Start empty.', icon: Flow24Regular, onClick },
    ];
    wrap(<GuidedEmptyState title="Get data" paths={paths} />);
    fireEvent.click(screen.getByText('Blank query'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders and fires the Ask-Copilot card', () => {
    const onAsk = vi.fn();
    wrap(
      <GuidedEmptyState
        title="Get data"
        paths={[{ key: 'blank', title: 'Blank', body: 'x', icon: Flow24Regular, onClick: () => {} }]}
        askCopilot={{ onClick: onAsk }}
      />,
    );
    fireEvent.click(screen.getByText('Ask Copilot'));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('renders a Learn-more link with the given href', () => {
    wrap(
      <GuidedEmptyState
        title="Get data"
        paths={[{ key: 'blank', title: 'Blank', body: 'x', icon: Flow24Regular, onClick: () => {} }]}
        learnMoreHref="https://learn.microsoft.com/power-query/"
      />,
    );
    const link = screen.getByRole('link', { name: /learn more/i });
    expect(link).toHaveAttribute('href', 'https://learn.microsoft.com/power-query/');
  });

  it('renders an href path as a real anchor', () => {
    const paths: GuidedPath[] = [
      { key: 'docs', title: 'Docs', body: 'Open docs', icon: Flow24Regular, href: 'https://example.com/docs' },
    ];
    wrap(<GuidedEmptyState title="Get data" paths={paths} />);
    const anchor = screen.getByText('Docs').closest('a');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('href', 'https://example.com/docs');
  });
});

/**
 * LearnPopover + SectionExplainer — vitest jsdom render tests.
 *
 * Covers the two exported primitives:
 *  - LearnPopover: trigger button renders, has correct aria-label, opens the
 *    popover surface on click (title + content + tips + Learn-more link).
 *  - SectionExplainer: info icon + body text render; className forwarding works.
 *
 * Does NOT test Popover animation or portal attachment (jsdom limitation) —
 * only the trigger and synchronous surface presence after click.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { LearnPopover, SectionExplainer } from '../learn-popover';

afterEach(cleanup);

function wrap(ui: React.ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

// ---------------------------------------------------------------------------
// LearnPopover
// ---------------------------------------------------------------------------

describe('LearnPopover', () => {
  it('renders the trigger button with the correct aria-label', () => {
    wrap(<LearnPopover title="Embed codes" content="A signed URL for external embedding." />);
    const btn = screen.getByRole('button', { name: 'Learn about Embed codes' });
    expect(btn).toBeTruthy();
  });

  it('shows title and content in the popover surface after click', () => {
    wrap(
      <LearnPopover
        title="Sensitivity labels"
        content="Labels classify assets by sensitivity level."
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Learn about Sensitivity labels' }));
    expect(screen.getByText('Sensitivity labels')).toBeTruthy();
    expect(screen.getByText('Labels classify assets by sensitivity level.')).toBeTruthy();
  });

  it('renders bullet tips when provided', () => {
    wrap(
      <LearnPopover
        title="Tips"
        tips={['Restricted', 'Confidential', 'Internal']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Learn about Tips' }));
    expect(screen.getByText('Restricted')).toBeTruthy();
    expect(screen.getByText('Confidential')).toBeTruthy();
    expect(screen.getByText('Internal')).toBeTruthy();
  });

  it('renders a "Learn more" link with the provided href', () => {
    wrap(
      <LearnPopover
        title="Domains"
        learnMoreHref="https://learn.microsoft.com/fabric/governance/domains"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Learn about Domains' }));
    const link = screen.getByRole('link', { name: /learn more/i });
    expect(link.getAttribute('href')).toBe(
      'https://learn.microsoft.com/fabric/governance/domains',
    );
  });

  it('does NOT render a "Learn more" link when learnMoreHref is omitted', () => {
    wrap(<LearnPopover title="Custom attributes" content="Some text." />);
    fireEvent.click(screen.getByRole('button', { name: 'Learn about Custom attributes' }));
    expect(screen.queryByRole('link', { name: /learn more/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SectionExplainer
// ---------------------------------------------------------------------------

describe('SectionExplainer', () => {
  it('renders children as body text', () => {
    wrap(<SectionExplainer>Labels classify assets by sensitivity level.</SectionExplainer>);
    expect(screen.getByText('Labels classify assets by sensitivity level.')).toBeTruthy();
  });

  it('renders an aria-hidden info icon (decorative)', () => {
    const { container } = wrap(
      <SectionExplainer>Some explanation.</SectionExplainer>,
    );
    // The SVG icon should carry aria-hidden="true" so screen-readers skip it.
    const icons = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(icons.length).toBeGreaterThanOrEqual(1);
  });

  it('applies an extra className to the outer div', () => {
    const { container } = wrap(
      <SectionExplainer className="my-custom-class">Text</SectionExplainer>,
    );
    const outer = container.querySelector('.my-custom-class');
    expect(outer).toBeTruthy();
  });

  it('renders rich JSX children (strong, code) correctly', () => {
    wrap(
      <SectionExplainer>
        Use <strong>labels</strong> to tag with <code>sensitivity</code>.
      </SectionExplainer>,
    );
    expect(screen.getByText('labels')).toBeTruthy();
    expect(screen.getByText('sensitivity')).toBeTruthy();
  });
});

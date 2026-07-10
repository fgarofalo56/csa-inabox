/**
 * /experience — landing-hub render (Vitest, jsdom).
 *
 * UX-1004/UX-1012: the bare /experience segment used to blind-redirect; it now
 * renders a real guided-launcher hub. Asserts the hub heading and one guided
 * card per built experience are present (no network; next/navigation stubbed by
 * vitest.setup.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import ExperienceLanding from '../page';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ExperienceLanding />
    </FluentProvider>,
  );
}

describe('ExperienceLanding hub', () => {
  afterEach(() => { cleanup(); });

  it('renders the guided experience hub with a card per experience', () => {
    mount();
    expect(screen.getByText('Choose an experience')).toBeInTheDocument();
    expect(screen.getByText('Data Science')).toBeInTheDocument();
    expect(screen.getByText('Orchestration (Warp)')).toBeInTheDocument();
    expect(screen.getByText('All workloads')).toBeInTheDocument();
  });

  it('links each experience card to its real home route', () => {
    mount();
    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/experience/data-science/home');
    expect(hrefs).toContain('/experience/warp/home');
    expect(hrefs).toContain('/workload-hub');
  });
});

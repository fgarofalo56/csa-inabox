/**
 * DockedInspector (SC-3) — render + contract tests.
 *
 * The shared bottom-docked inspector owns the Fabric validation-dot tab
 * contract. These jsdom tests exercise the REAL component and assert:
 *   1. header title + the active tab's content render;
 *   2. a tab with `hasValidationIssue` carries the red superscript dot (exposed
 *      to AT via its aria-label) — pre-run validation visibility;
 *   3. selecting another tab fires `onSelectTab` with that tab's id;
 *   4. an empty `tabs` array renders the provided emptyState (no crash).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DockedInspector, type DockedInspectorTab } from '../docked-inspector';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const TABS: DockedInspectorTab[] = [
  { id: 'general', label: 'General', content: <div>general-body</div> },
  { id: 'source', label: 'Source', hasValidationIssue: true, issueCount: 2, content: <div>source-body</div> },
];

afterEach(cleanup);

describe('DockedInspector', () => {
  it('renders the header title and the active tab content', () => {
    wrap(
      <DockedInspector title="Copy data" tabs={TABS} selectedTab="general" onSelectTab={() => {}} />,
    );
    expect(screen.getByText('Copy data')).toBeInTheDocument();
    expect(screen.getByText('general-body')).toBeInTheDocument();
    // Inactive tab content is not rendered.
    expect(screen.queryByText('source-body')).toBeNull();
  });

  it('shows a red validation dot with an accessible label on a tab that has unmet required config', () => {
    wrap(
      <DockedInspector title="Copy data" tabs={TABS} selectedTab="general" onSelectTab={() => {}} />,
    );
    expect(screen.getAllByLabelText(/2 required fields to complete/i).length).toBeGreaterThan(0);
  });

  it('calls onSelectTab with the clicked tab id', () => {
    const onSelectTab = vi.fn();
    wrap(
      <DockedInspector title="Copy data" tabs={TABS} selectedTab="general" onSelectTab={onSelectTab} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Source/ }));
    expect(onSelectTab).toHaveBeenCalledWith('source');
  });

  it('renders the emptyState when there are no tabs', () => {
    wrap(
      <DockedInspector
        title="Nothing"
        tabs={[]}
        selectedTab=""
        onSelectTab={() => {}}
        emptyState={<div>nothing-selected</div>}
      />,
    );
    expect(screen.getByText('nothing-selected')).toBeInTheDocument();
  });
});

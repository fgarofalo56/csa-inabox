/**
 * Vitest setup — runs once before any spec.
 *
 * - Adds @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * - Stubs `next/navigation` so editors that call useRouter() don't crash
 *   when mounted outside the App Router.
 * - Stubs `@monaco-editor/react` and the project's MonacoTextarea wrapper
 *   so editors render a plain <textarea> in jsdom.
 * - Stubs ItemEditorChrome so per-editor unit tests don't drag in the
 *   full app shell (ribbon, tab strip, workspace tree, etc.). The stub
 *   surfaces ribbon actions as <button> elements so primary-action tests
 *   work the same way they would against the real chrome.
 * - Adds ResizeObserver + matchMedia stubs FluentUI needs.
 */
import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import React from 'react';

// Rate limiting is DEFAULT-ON in production (rel-T16 / B16), and the limiter
// reads LOOM_RATE_LIMIT at call time. Under the test hammer many route specs
// fire the same (oid, class) far faster than a real client would and trip the
// token bucket (429), which is not the behavior those specs are asserting.
// Default it OFF for the whole suite; the rate-limiter's OWN tests
// (lib/azure/__tests__/rate-limiter*.test.ts) set LOOM_RATE_LIMIT='on'/'off'
// explicitly in their own beforeEach, so they are unaffected.
process.env.LOOM_RATE_LIMIT = process.env.LOOM_RATE_LIMIT ?? 'off';

// With `globals: false`, @testing-library/react does NOT auto-register its
// afterEach cleanup, so rendered trees accumulate across tests in the same file
// (a second render() then makes getByTestId('chrome') throw "Found multiple
// elements"). Register cleanup once, globally, so every render test starts from
// a clean DOM.
afterEach(() => {
  cleanup();
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/test',
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({}),
}));

vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, onChange, ['aria-label']: ariaLabel }: any) =>
    React.createElement('textarea', {
      'aria-label': ariaLabel,
      value: value ?? '',
      onChange: (e: any) => onChange?.(e.target.value),
    }),
  Editor: ({ value, onChange, ['aria-label']: ariaLabel }: any) =>
    React.createElement('textarea', {
      'aria-label': ariaLabel,
      value: value ?? '',
      onChange: (e: any) => onChange?.(e.target.value),
    }),
}));

vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: ({ value, onChange, ariaLabel }: any) =>
    React.createElement('textarea', {
      'aria-label': ariaLabel || 'editor',
      value: value ?? '',
      onChange: (e: any) => onChange?.(e.target.value),
    }),
}));

vi.mock('@/lib/editors/item-editor-chrome', () => ({
  ItemEditorChrome: ({ ribbon, leftPanel, main }: any) =>
    React.createElement(
      'div',
      { 'data-testid': 'chrome' },
      React.createElement(
        'div',
        { 'data-testid': 'ribbon' },
        ...(ribbon || []).flatMap((tab: any) =>
          (tab.groups || []).flatMap((g: any) =>
            (g.actions || []).map((a: any, i: number) =>
              React.createElement(
                'button',
                {
                  key: `${tab.id}-${g.label}-${i}`,
                  onClick: a.onClick,
                  disabled: a.disabled,
                  'aria-label': a.label,
                },
                a.label,
              ),
            ),
          ),
        ),
      ),
      React.createElement('div', { 'data-testid': 'left-panel' }, leftPanel),
      React.createElement('main', { 'data-testid': 'main-panel' }, main),
    ),
}));

class RO { observe() {} unobserve() {} disconnect() {} }
// FluentUI internals call new ResizeObserver(); jsdom doesn't ship one.
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || RO;

// jsdom doesn't implement Element.scrollIntoView, which several editors
// (CrossItemCopilot, chat surfaces, etc.) call from effects to keep the
// latest message in view. Stub it to a no-op so those editors mount.
if (typeof Element !== 'undefined' && !(Element.prototype as any).scrollIntoView) {
  (Element.prototype as any).scrollIntoView = function () {};
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

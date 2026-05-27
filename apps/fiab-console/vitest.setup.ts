/**
 * Vitest setup file — runs once before any spec.
 *
 * - Loads @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * - Stubs `next/navigation` so editors that call useRouter() don't crash
 *   when mounted outside the App Router.
 * - Stubs `@monaco-editor/react` so editors that embed Monaco render a
 *   plain <textarea> in jsdom (Monaco itself needs real DOM APIs jsdom
 *   doesn't provide).
 * - Stubs `next/dynamic` to load components eagerly so the registry
 *   lazy-imports resolve synchronously in tests.
 */
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import React from 'react';

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

// Stub our own MonacoTextarea wrapper too — it dynamic-imports Monaco
// which fails in jsdom. The component contract is value/onChange/aria.
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: ({ value, onChange, ariaLabel }: any) =>
    React.createElement('textarea', {
      'aria-label': ariaLabel || 'editor',
      value: value ?? '',
      onChange: (e: any) => onChange?.(e.target.value),
    }),
}));

// Stub ItemEditorChrome — it pulls in app-shell components (ribbon,
// tab strip, workspace tree, etc.) that drag in dozens of indirect
// modules and aren't relevant to per-editor unit tests. The shape we
// preserve: render the ribbon labels (so ribbon-button tests work),
// the left panel, and the main pane.
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

// jsdom doesn't implement ResizeObserver; FluentUI uses it for popovers.
class RO { observe() {} unobserve() {} disconnect() {} }
// @ts-expect-error – assign to global for FluentUI internals
globalThis.ResizeObserver = globalThis.ResizeObserver || RO;

// matchMedia stub for FluentUI dark-mode detection in jsdom.
if (typeof window !== 'undefined' && !window.matchMedia) {
  // @ts-expect-error – jsdom stub
  window.matchMedia = (query: string) => ({
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

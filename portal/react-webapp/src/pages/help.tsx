/**
 * Keyboard shortcuts reference — CSA-0124(5).
 *
 * This page is the canonical documentation surface for the application's
 * keyboard shortcuts. The shortcut list is imported from
 * `hooks/useKeyboardShortcuts` so there is a single source of truth —
 * adding a shortcut there automatically surfaces it here.
 *
 * The page itself is accessible via:
 *   - Sidebar (not yet wired — follow-up).
 *   - Pressing `?` anywhere in the app (the global hook navigates here).
 *
 * Accessibility:
 *   - Each shortcut is rendered with a `<kbd>` element so screen readers
 *     and styled presentations both behave correctly.
 *   - The table has a proper `<caption>` and scoped headers.
 */

import React from 'react';
import { SHORTCUTS, type ShortcutDefinition } from '@/hooks/useKeyboardShortcuts';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

function renderKeys(keys: string): React.ReactElement {
  // Split on whitespace so "g s" renders as two <kbd> chips with a
  // separator; single-key shortcuts render as a single <kbd>.
  const parts = keys.split(/\s+/);
  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          {i > 0 && <span aria-hidden="true" className="text-gray-400">then</span>}
          <kbd className="inline-flex items-center rounded border border-gray-300 bg-gray-50 px-2 py-0.5 font-mono text-xs text-gray-700 shadow-sm">
            {k}
          </kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

function HelpPageContent(): React.ReactElement {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Keyboard shortcuts</h1>
        <p className="mt-1 text-sm text-gray-500">
          Move around the portal faster. Shortcuts are ignored while typing
          into a form field.
        </p>
      </header>

      <section
        aria-labelledby="shortcut-table-heading"
        className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden"
      >
        <h2 id="shortcut-table-heading" className="sr-only">
          Available shortcuts
        </h2>
        <table className="min-w-full divide-y divide-gray-200">
          <caption className="sr-only">
            Keyboard shortcuts available across the portal
          </caption>
          <thead className="bg-gray-50">
            <tr>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500"
              >
                Shortcut
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500"
              >
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {SHORTCUTS.map((s: ShortcutDefinition) => (
              <tr key={s.keys}>
                <td className="px-6 py-3 whitespace-nowrap">
                  {renderKeys(s.keys)}
                </td>
                <td className="px-6 py-3 text-sm text-gray-700">
                  {s.description}
                  {s.target && (
                    <span className="ml-2 text-xs text-gray-400">
                      <code>{s.target}</code>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="text-xs text-gray-400">
        Shortcuts are defined in <code>src/hooks/useKeyboardShortcuts.ts</code>.
        To add a new one, append to the <code>SHORTCUTS</code> array and map
        it in the keydown handler.
      </footer>
    </div>
  );
}

export default function HelpPage(): React.ReactElement {
  return (
    <RouteErrorBoundary routeLabel="Help">
      <HelpPageContent />
    </RouteErrorBoundary>
  );
}

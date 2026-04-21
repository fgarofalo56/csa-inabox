/**
 * EmptyState — CSA-0124(2).
 *
 * Friendly zero-data placeholder with an optional call-to-action.
 * Used by sources list, pipelines list, access requests, and anywhere
 * the page would otherwise render a bare "no results" string.
 *
 * Accessibility:
 *   - `role="status"` so assistive tech announces the empty state when
 *     it replaces a loaded list.
 *   - The CTA (when provided) renders as a real `<button>` or anchor —
 *     see `action.href` / `action.onClick`.
 *
 * Styling uses Tailwind utilities only; no inline styles.
 */

import React from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';

export interface EmptyStateAction {
  /** Label shown on the CTA. */
  label: string;
  /** If set, renders a Next.js `<Link>`. Mutually exclusive with `onClick`. */
  href?: string;
  /** If set, renders a `<button>`. Mutually exclusive with `href`. */
  onClick?: () => void;
}

export interface EmptyStateProps {
  /** Short, human-readable headline. Required. */
  title: string;
  /** Optional one-line description under the title. */
  description?: string;
  /** Optional CTA — either a Link (`href`) or a button (`onClick`). */
  action?: EmptyStateAction;
  /** Optional decorative icon path (24x24 SVG `d` attribute). */
  iconPath?: string;
  /** Additional Tailwind classes for the outer container. */
  className?: string;
}

const DEFAULT_ICON =
  'M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z';

export function EmptyState({
  title,
  description,
  action,
  iconPath = DEFAULT_ICON,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      role="status"
      className={clsx(
        'flex flex-col items-center justify-center text-center',
        'py-12 px-6 bg-gray-50 border border-dashed border-gray-200 rounded-lg',
        className
      )}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        className="h-10 w-10 text-gray-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
      </svg>
      <h3 className="mt-3 text-sm font-semibold text-gray-900">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-gray-500 max-w-md">{description}</p>
      )}
      {action && action.href ? (
        <Link
          href={action.href}
          className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-md hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          {action.label}
        </Link>
      ) : action && action.onClick ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-md hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export default EmptyState;

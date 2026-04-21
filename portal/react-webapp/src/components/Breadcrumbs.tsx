/**
 * Breadcrumbs — CSA-0124(9).
 *
 * A small, accessible breadcrumb trail driven by a static route hierarchy.
 * Used on the source detail page and other deep routes to give users a
 * clear "you are here" signal plus single-click up-navigation.
 *
 * The component exposes two usage modes:
 *   1. Derived: pass `path` (defaults to the current router path) and
 *      the breadcrumb renders a chain built from `ROUTE_HIERARCHY`.
 *   2. Explicit: pass `items` to render an arbitrary chain — useful when
 *      a leaf segment needs a dynamic label like the source name.
 *
 * Accessibility:
 *   - Rendered inside `<nav aria-label="Breadcrumb">`.
 *   - The current page is marked with `aria-current="page"` and styled
 *     muted instead of as a link.
 *   - Separators are purely decorative and flagged with `aria-hidden`.
 *
 * Tailwind only; no inline styles.
 */

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

export interface BreadcrumbItem {
  /** Human-readable label shown in the trail. */
  label: string;
  /** Optional href. When omitted, the item renders as the current page. */
  href?: string;
}

/**
 * Static map of known route segments to display labels. Deep links fall
 * back to a title-cased segment when a key isn't present so we don't have
 * to enumerate every possible id in advance.
 */
export const ROUTE_HIERARCHY: Record<string, string> = {
  '': 'Home',
  dashboard: 'Dashboard',
  sources: 'Sources',
  register: 'Register',
  pipelines: 'Pipelines',
  marketplace: 'Marketplace',
  access: 'Access requests',
  help: 'Help',
};

function titleCase(segment: string): string {
  if (!segment) return '';
  return segment
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build a breadcrumb chain from a path like `/sources/register`.
 * Dynamic id segments (longer-than-8 lowercase tokens with hyphens, or
 * uuid-ish strings) keep their literal value so callers can override via
 * the explicit `items` prop when they know the friendly label.
 */
export function buildTrailFromPath(path: string): BreadcrumbItem[] {
  const clean = path.split('?')[0].split('#')[0];
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) {
    // Root path — Home IS the current page, so no href.
    return [{ label: 'Home' }];
  }
  const items: BreadcrumbItem[] = [{ label: 'Home', href: '/' }];
  let acc = '';
  segments.forEach((seg, i) => {
    acc += `/${seg}`;
    const label = ROUTE_HIERARCHY[seg] ?? titleCase(seg);
    if (i === segments.length - 1) {
      // Leaf segment — no href (current page).
      items.push({ label });
    } else {
      items.push({ label, href: acc });
    }
  });
  return items;
}

export interface BreadcrumbsProps {
  /** Explicit item list — takes precedence over `path`/router. */
  items?: BreadcrumbItem[];
  /** Path to derive from. Defaults to the current router `asPath`. */
  path?: string;
  /** Extra Tailwind classes for the outer `<nav>`. */
  className?: string;
}

export function Breadcrumbs({ items, path, className }: BreadcrumbsProps): React.ReactElement {
  const router = useRouter();
  const trail = items ?? buildTrailFromPath(path ?? router.asPath ?? '/');
  return (
    <nav
      aria-label="Breadcrumb"
      className={`text-sm text-gray-500 ${className ?? ''}`.trim()}
    >
      <ol className="flex flex-wrap items-center gap-1">
        {trail.map((item, idx) => {
          const isLast = idx === trail.length - 1;
          return (
            <li key={`${item.label}-${idx}`} className="flex items-center gap-1">
              {idx > 0 && (
                <span aria-hidden="true" className="text-gray-300">
                  /
                </span>
              )}
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className="text-brand-600 hover:text-brand-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 rounded"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={isLast ? 'text-gray-700 font-medium' : 'text-gray-500'}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumbs;

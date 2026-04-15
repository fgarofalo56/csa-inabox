/**
 * Navigation Sidebar with route links and active state indicators.
 * Extracted from _app.tsx for reusability and component isolation.
 */

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { clsx } from 'clsx';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

const DEFAULT_NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { href: '/sources', label: 'Sources', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4' },
  { href: '/pipelines', label: 'Pipelines', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { href: '/marketplace', label: 'Marketplace', icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z' },
  { href: '/access', label: 'Access Requests', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
];

export interface SidebarProps {
  /** Override the default navigation items. */
  items?: NavItem[];
  /** Application title displayed at the top. */
  title?: string;
}

function NavLink({ href, label, icon }: NavItem) {
  const router = useRouter();
  const isActive =
    href === '/' ? router.pathname === '/' : router.pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={clsx(
        'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
        isActive
          ? 'bg-brand-100 text-brand-700'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
      )}
    >
      <svg
        className="w-5 h-5 flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>
      {label}
    </Link>
  );
}

export function Sidebar({ items = DEFAULT_NAV_ITEMS, title = 'CSA-in-a-Box' }: SidebarProps) {
  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
      <div className="h-16 flex items-center px-6 border-b border-gray-200">
        <h1 className="text-lg font-bold text-brand-700">{title}</h1>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map((item) => (
          <NavLink key={item.href} {...item} />
        ))}
      </nav>

      <div className="px-6 py-4 border-t border-gray-200">
        <p className="text-xs text-gray-400">Fabric-in-a-Box Data Platform</p>
        <p className="text-xs text-gray-400">v1.0.0</p>
      </div>
    </aside>
  );
}

export default Sidebar;

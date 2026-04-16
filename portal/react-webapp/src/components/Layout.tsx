/**
 * Main application Layout component.
 * Wraps responsive Sidebar navigation with the main content area.
 * Includes a mobile hamburger toggle for the sidebar.
 */

import React, { useState } from 'react';
import { Sidebar, type NavItem } from './Sidebar';

export interface LayoutProps {
  /** Page content to render in the main area. */
  children: React.ReactNode;
  /** Override sidebar navigation items. */
  navItems?: NavItem[];
  /** Override sidebar title. */
  title?: string;
}

export function Layout({ children, navItems, title }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <><a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-white focus:px-4 focus:py-2 focus:rounded focus:shadow-lg focus:text-brand-600"
      >
        Skip to main content
      </a>
    <div className="flex h-screen bg-gray-50">
      <Sidebar
        items={navItems}
        title={title}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile top bar with hamburger */}
        <div className="lg:hidden flex items-center h-16 px-4 border-b border-gray-200 bg-white">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100"
            aria-label="Open sidebar"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <span className="ml-3 text-lg font-bold text-brand-700">
            {title ?? 'CSA-in-a-Box'}
          </span>
        </div>

        <main id="main-content" className="flex-1 overflow-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            {children}
          </div>
        </main>
      </div>
    </div></>
  );
}

export default Layout;

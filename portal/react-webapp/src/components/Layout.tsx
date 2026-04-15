/**
 * Main application Layout component.
 * Wraps Sidebar navigation with the main content area.
 */

import React from 'react';
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
  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar items={navItems} title={title} />

      <main className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}

export default Layout;

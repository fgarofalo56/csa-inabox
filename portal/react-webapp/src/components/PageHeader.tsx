/**
 * Page header component with title, description, and action buttons.
 * Provides consistent page-level headings across the portal.
 */

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface PageHeaderProps {
  /** Page title. */
  title: string;
  /** Optional description text below the title. */
  description?: string;
  /** Action buttons rendered on the right side. */
  actions?: React.ReactNode;
  /** Breadcrumb or secondary navigation above the title. */
  breadcrumb?: React.ReactNode;
  /** Additional CSS classes. */
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: PageHeaderProps) {
  return (
    <div className={twMerge(clsx('mb-8', className))}>
      {breadcrumb && (
        <nav className="mb-2 text-sm text-gray-500">{breadcrumb}</nav>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-gray-500">{description}</p>
          )}
        </div>

        {actions && (
          <div className="flex flex-shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

export default PageHeader;

/**
 * Color-coded status indicator badge.
 * Maps status strings to consistent color schemes.
 */

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export type StatusVariant =
  | 'active'
  | 'pending'
  | 'error'
  | 'warning'
  | 'success'
  | 'info'
  | 'neutral'
  | 'draft';

const variantStyles: Record<StatusVariant, string> = {
  active: 'bg-green-100 text-green-800',
  success: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  warning: 'bg-yellow-100 text-yellow-800',
  draft: 'bg-gray-100 text-gray-800',
  neutral: 'bg-gray-100 text-gray-800',
  error: 'bg-red-100 text-red-800',
  info: 'bg-blue-100 text-blue-800',
};

/** Map common status strings to visual variants. */
const statusToVariant: Record<string, StatusVariant> = {
  active: 'active',
  running: 'active',
  succeeded: 'success',
  approved: 'success',
  healthy: 'success',
  pending: 'pending',
  pending_approval: 'pending',
  waiting: 'pending',
  created: 'info',
  provisioning: 'info',
  draft: 'draft',
  paused: 'neutral',
  decommissioned: 'neutral',
  cancelled: 'neutral',
  denied: 'error',
  error: 'error',
  failed: 'error',
  critical: 'error',
  revoked: 'warning',
  expired: 'warning',
  warning: 'warning',
};

export interface StatusBadgeProps {
  /** The status string to display. */
  status: string;
  /** Override the automatic variant detection. */
  variant?: StatusVariant;
  /** Additional CSS classes. */
  className?: string;
  /** Show a pulsing dot indicator. */
  dot?: boolean;
}

export function StatusBadge({ status, variant, className, dot }: StatusBadgeProps) {
  const resolvedVariant = variant || statusToVariant[status.toLowerCase()] || 'neutral';
  const dotColor = resolvedVariant === 'active' || resolvedVariant === 'success'
    ? 'bg-green-500'
    : resolvedVariant === 'error'
      ? 'bg-red-500'
      : resolvedVariant === 'pending' || resolvedVariant === 'warning'
        ? 'bg-yellow-500'
        : 'bg-gray-400';

  return (
    <span
      className={twMerge(
        clsx(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
          variantStyles[resolvedVariant],
          className
        )
      )}
    >
      {dot && (
        <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', dotColor)} />
      )}
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export default StatusBadge;

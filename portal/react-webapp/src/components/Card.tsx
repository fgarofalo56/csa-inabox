/**
 * Content Card component with header, body, and footer slots.
 * Provides a consistent container for content sections.
 */

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Remove default padding from the card body. */
  noPadding?: boolean;
}

export function Card({ className, noPadding, children, ...props }: CardProps) {
  return (
    <div
      className={twMerge(
        clsx(
          'rounded-lg border border-gray-200 bg-white shadow-sm',
          !noPadding && 'p-6',
          className
        )
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

export function CardHeader({ className, children, ...props }: CardHeaderProps) {
  return (
    <div
      className={twMerge(
        clsx('flex items-center justify-between border-b border-gray-200 pb-4 mb-4', className)
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

export function CardTitle({ className, children, ...props }: CardTitleProps) {
  return (
    <h3
      className={twMerge(clsx('text-lg font-semibold text-gray-900', className))}
      {...props}
    >
      {children}
    </h3>
  );
}

export interface CardBodyProps extends React.HTMLAttributes<HTMLDivElement> {}

export function CardBody({ className, children, ...props }: CardBodyProps) {
  return (
    <div className={twMerge(clsx('text-sm text-gray-600', className))} {...props}>
      {children}
    </div>
  );
}

export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export function CardFooter({ className, children, ...props }: CardFooterProps) {
  return (
    <div
      className={twMerge(
        clsx('flex items-center justify-end gap-2 border-t border-gray-200 pt-4 mt-4', className)
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export default Card;

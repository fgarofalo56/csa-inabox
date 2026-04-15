/**
 * Dialog Modal component using Radix UI Dialog.
 * Provides accessible overlay modal with title and description.
 */

import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface ModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Callback fired when the open state changes. */
  onOpenChange: (open: boolean) => void;
  /** Modal title displayed in the header. */
  title: string;
  /** Optional description below the title. */
  description?: string;
  /** Modal content. */
  children: React.ReactNode;
  /** Additional CSS classes for the content panel. */
  className?: string;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={twMerge(
            clsx(
              'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
              'rounded-lg bg-white p-6 shadow-xl',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
              className
            )
          )}
        >
          <Dialog.Title className="text-lg font-semibold text-gray-900">
            {title}
          </Dialog.Title>

          {description && (
            <Dialog.Description className="mt-2 text-sm text-gray-500">
              {description}
            </Dialog.Description>
          )}

          <div className="mt-4">{children}</div>

          <Dialog.Close asChild>
            <button
              className="absolute right-4 top-4 rounded-sm p-1 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-500"
              aria-label="Close"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default Modal;

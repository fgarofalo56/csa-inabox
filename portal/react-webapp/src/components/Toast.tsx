/**
 * Toast notification component built on Radix UI Toast.
 * Supports success and error variants with auto-dismiss.
 */

import React from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import type { ToastVariant } from '@/hooks/useToast';

export interface ToastProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss duration in ms. Defaults to 5000. */
  duration?: number;
}

const variantStyles: Record<ToastVariant, { container: string; icon: string }> = {
  success: {
    container: 'border-green-200 bg-green-50',
    icon: 'text-green-600',
  },
  error: {
    container: 'border-red-200 bg-red-50',
    icon: 'text-red-600',
  },
};

function SuccessIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  );
}

export function Toast({ open, onOpenChange, message, variant, duration = 5000 }: ToastProps) {
  const styles = variantStyles[variant];

  return (
    <RadixToast.Provider swipeDirection="right" duration={duration}>
      <RadixToast.Root
        open={open}
        onOpenChange={onOpenChange}
        className={`rounded-lg border p-4 shadow-md ${styles.container} data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=open]:fade-in-0`}
      >
        <div className="flex items-start gap-3">
          <span className={styles.icon}>
            {variant === 'success' ? <SuccessIcon /> : <ErrorIcon />}
          </span>
          <RadixToast.Description className="text-sm text-gray-800 flex-1">
            {message}
          </RadixToast.Description>
          <RadixToast.Close aria-label="Close" className="text-gray-400 hover:text-gray-600">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </RadixToast.Close>
        </div>
      </RadixToast.Root>
      <RadixToast.Viewport className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" />
    </RadixToast.Provider>
  );
}

export default Toast;

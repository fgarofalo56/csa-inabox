/**
 * Toast notification state management hook.
 * Manages show/hide, message, and variant for the Toast component.
 */

import { useState, useCallback, useRef } from 'react';

export type ToastVariant = 'success' | 'error';

export interface ToastState {
  open: boolean;
  message: string;
  variant: ToastVariant;
}

export interface UseToastReturn {
  toast: ToastState;
  showToast: (message: string, variant: ToastVariant) => void;
  hideToast: () => void;
  setOpen: (open: boolean) => void;
}

const INITIAL_STATE: ToastState = {
  open: false,
  message: '',
  variant: 'success',
};

export function useToast(duration = 5000): UseToastReturn {
  const [toast, setToast] = useState<ToastState>(INITIAL_STATE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideToast = useCallback(() => {
    setToast((prev) => ({ ...prev, open: false }));
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      setToast({ open: true, message, variant });
      timerRef.current = setTimeout(() => {
        setToast((prev) => ({ ...prev, open: false }));
        timerRef.current = null;
      }, duration);
    },
    [duration]
  );

  const setOpen = useCallback((open: boolean) => {
    setToast((prev) => ({ ...prev, open }));
  }, []);

  return { toast, showToast, hideToast, setOpen };
}

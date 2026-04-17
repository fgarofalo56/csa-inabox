/**
 * Reusable error banner component with retry support.
 */

import React from 'react';

interface ErrorBannerProps {
  /** Heading displayed above the error message. */
  title?: string;
  /** Error description. */
  message: string;
  /** Optional retry callback. When provided a Retry button is rendered. */
  onRetry?: () => void;
}

export default function ErrorBanner({ title = 'Something went wrong', message, onRetry }: ErrorBannerProps) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
      <svg
        className="mx-auto h-10 w-10 text-red-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
        />
      </svg>
      <h3 className="mt-2 text-sm font-medium text-red-800">{title}</h3>
      <p className="mt-1 text-sm text-red-600">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-red-700 bg-red-100 border border-red-300 rounded-md hover:bg-red-200"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * RouteErrorBoundary — CSA-0124(4).
 *
 * A lightweight error boundary scoped to a single route's content. The
 * top-level `_app.tsx` already wraps the whole tree with the global
 * `ErrorBoundary`; this per-route boundary lets a single broken page
 * render a contained fallback without tearing down the entire shell
 * (sidebar, navigation, auth context).
 *
 * Differences vs. `components/ErrorBoundary.tsx`:
 *   - Fallback is an inline card, not a full-screen takeover.
 *   - Supports a `routeLabel` prop so the fallback tells the user which
 *     page crashed.
 *   - The `Try again` button resets internal state instead of reloading
 *     the browser — the surrounding shell stays mounted, React Query
 *     cache is preserved, and the next render attempt is cheap.
 */

import React, {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';

export interface RouteErrorBoundaryProps {
  children: ReactNode;
  /** Human-readable route name, surfaced in the fallback copy. */
  routeLabel?: string;
  /** Optional full fallback override (takes precedence over the default card). */
  fallback?: ReactNode;
}

interface RouteErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  constructor(props: RouteErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Production builds should forward this to a telemetry pipeline; for
    // now we log so the error is visible in the browser console and in
    // any SSR log capture.
    // eslint-disable-next-line no-console
    console.error(
      `[RouteErrorBoundary:${this.props.routeLabel ?? 'unknown'}]`,
      error,
      errorInfo
    );
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    if (this.props.fallback) {
      return this.props.fallback;
    }

    const label = this.props.routeLabel ?? 'this page';
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="max-w-lg mx-auto my-12 rounded-lg border border-red-200 bg-red-50 p-6 text-center"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
          <svg
            aria-hidden="true"
            focusable="false"
            className="h-6 w-6 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>
        <h2 className="mt-3 text-base font-semibold text-red-800">
          {label} could not be displayed
        </h2>
        <p className="mt-1 text-sm text-red-700">
          An unexpected error interrupted rendering. You can try again — the
          rest of the app is still working.
        </p>
        {this.state.error && process.env.NODE_ENV !== 'production' && (
          <pre className="mt-4 max-h-32 overflow-auto rounded bg-white/70 p-3 text-left text-xs text-red-800">
            {this.state.error.message}
          </pre>
        )}
        <button
          type="button"
          onClick={this.handleReset}
          className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
        >
          Try again
        </button>
      </div>
    );
  }
}

export default RouteErrorBoundary;

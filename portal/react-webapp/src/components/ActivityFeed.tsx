/**
 * ActivityFeed — CSA-0124(14).
 *
 * Chronological feed of the platform's most recent pipeline runs and
 * pending access requests. Renders on `/dashboard` so operators can see
 * "what happened lately" at a glance without drilling into each list page.
 *
 * Data sources (re-using existing hooks, no new endpoints):
 *   - `usePipelines` — each pipeline is shown once with its `last_run_at`.
 *     Only pipelines that have a `last_run_at` contribute to the feed.
 *   - `useAccessRequests({ status: 'pending' })` — each pending request
 *     contributes a "requested" item keyed on `requested_at`.
 *
 * Both slices are merged, sorted desc by timestamp, and capped at `limit`
 * (default 10).
 *
 * Accessibility:
 *   - `role="region"` + `aria-labelledby` on the outer container.
 *   - Each feed entry is a semantic `<li>` under a real `<ul>`; icons are
 *     `aria-hidden`.
 *   - Relative-time strings ("2h ago") are paired with an absolute ISO
 *     timestamp via `<time dateTime={iso}>` so screen readers can read
 *     either form.
 */

import React from 'react';
import Link from 'next/link';
import { usePipelines, useAccessRequests } from '@/hooks/useApi';
import type { PipelineRecord, AccessRequest } from '@/types';

export interface ActivityFeedProps {
  /** Max number of entries to render across all kinds. Default 10. */
  limit?: number;
  /**
   * Injection seam used exclusively by tests. Lets us stabilize the
   * "now" reference so relative-time snapshots are deterministic.
   */
  now?: Date;
}

type FeedKind = 'pipeline' | 'access';

interface FeedItem {
  id: string;
  kind: FeedKind;
  timestamp: Date;
  title: string;
  description: string;
  href: string;
}

/** "2h ago" / "3d ago" / "just now" — all in English, no i18n layer yet. */
export function formatRelativeTime(from: Date, now: Date): string {
  const deltaMs = now.getTime() - from.getTime();
  if (deltaMs < 0) return 'just now';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function pipelineToItem(p: PipelineRecord): FeedItem | null {
  if (!p.last_run_at) return null;
  const ts = new Date(p.last_run_at);
  if (Number.isNaN(ts.getTime())) return null;
  return {
    id: `pipeline:${p.id}`,
    kind: 'pipeline',
    timestamp: ts,
    title: p.name,
    description: `Pipeline ${p.status}`,
    href: `/pipelines?search=${encodeURIComponent(p.name)}`,
  };
}

function accessToItem(a: AccessRequest): FeedItem | null {
  const ts = new Date(a.requested_at);
  if (Number.isNaN(ts.getTime())) return null;
  return {
    id: `access:${a.id}`,
    kind: 'access',
    timestamp: ts,
    title: `Access request — ${a.requester_email}`,
    description: `Pending approval for ${a.data_product_id}`,
    href: `/access?status=pending`,
  };
}

/** SVG icon for each feed kind. Decorative — aria-hidden. */
function KindIcon({ kind }: { kind: FeedKind }): React.ReactElement {
  if (kind === 'pipeline') {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        className="h-4 w-4 text-brand-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h10M4 18h16" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-4 w-4 text-amber-600"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

export function ActivityFeed({ limit = 10, now }: ActivityFeedProps): React.ReactElement {
  const { data: pipelines, isLoading: pipelinesLoading, error: pipelinesError } = usePipelines();
  const { data: accessRequests, isLoading: accessLoading, error: accessError } = useAccessRequests({
    status: 'pending',
  });

  const effectiveNow = React.useMemo(() => now ?? new Date(), [now]);

  const items = React.useMemo<FeedItem[]>(() => {
    const pipelineItems = (pipelines ?? [])
      .map(pipelineToItem)
      .filter((v): v is FeedItem => v !== null);
    const accessItems = (accessRequests ?? [])
      .map(accessToItem)
      .filter((v): v is FeedItem => v !== null);
    const merged = [...pipelineItems, ...accessItems];
    merged.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return merged.slice(0, limit);
  }, [pipelines, accessRequests, limit]);

  const headingId = 'activity-feed-heading';
  const loading = pipelinesLoading || accessLoading;
  const hasError = pipelinesError || accessError;

  return (
    <section
      aria-labelledby={headingId}
      className="bg-white rounded-lg shadow-sm border border-gray-200 p-6"
    >
      <h2 id={headingId} className="text-lg font-semibold text-gray-900 mb-4">
        Recent activity
      </h2>

      {loading ? (
        <div role="status" aria-label="Loading activity feed" className="space-y-2">
          <span className="sr-only">Loading activity feed…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse flex items-center gap-3">
              <div className="h-4 w-4 bg-gray-200 rounded-full" />
              <div className="h-4 w-40 bg-gray-200 rounded" />
              <div className="ml-auto h-3 w-12 bg-gray-100 rounded" />
            </div>
          ))}
        </div>
      ) : hasError ? (
        <p role="alert" className="text-sm text-red-600">
          Failed to load recent activity.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">
          No recent pipeline runs or pending access requests.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((item) => {
            const iso = item.timestamp.toISOString();
            const relative = formatRelativeTime(item.timestamp, effectiveNow);
            return (
              <li key={item.id} className="flex items-start gap-3 py-3">
                <span className="mt-1 flex-shrink-0">
                  <KindIcon kind={item.kind} />
                </span>
                <div className="flex-1 min-w-0">
                  <Link
                    href={item.href}
                    className="text-sm font-medium text-brand-600 hover:text-brand-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 rounded"
                  >
                    {item.title}
                  </Link>
                  <p className="text-xs text-gray-500">{item.description}</p>
                </div>
                <time
                  dateTime={iso}
                  title={iso}
                  className="flex-shrink-0 text-xs text-gray-400"
                >
                  {relative}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default ActivityFeed;

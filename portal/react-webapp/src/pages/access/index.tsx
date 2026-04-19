/**
 * Access Requests page — two modes driven by URL query params.
 *
 * 1. ?product_id=... : render a form to submit a new access request.
 *    On success, flip to list mode and show a success toast.
 * 2. Otherwise      : render a table of access requests the caller has
 *    submitted or has review rights over (backend scopes this by role /
 *    domain). Pending rows expose approve / deny actions; the backend
 *    enforces whether the current caller may execute them.
 */

import React, { useState } from 'react';
import { useRouter } from 'next/router';
import {
  useAccessRequests,
  useCreateAccessRequest,
  useApproveAccessRequest,
  useDenyAccessRequest,
} from '@/hooks/useApi';
import { useToast } from '@/hooks/useToast';
import ErrorBanner from '@/components/ErrorBanner';
import PageHeader from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import Button from '@/components/Button';
import { Modal } from '@/components/Modal';
import { Toast } from '@/components/Toast';
import type { AccessRequest, AccessLevel } from '@/types';

type ReviewAction = { kind: 'approve' | 'deny'; request: AccessRequest } | null;

function AccessRequestForm({
  productId,
  onSuccess,
  onError,
}: {
  productId: string;
  onSuccess: (req: AccessRequest) => void;
  onError: (message: string) => void;
}) {
  const [justification, setJustification] = useState('');
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('read');
  const [durationDays, setDurationDays] = useState<number>(90);
  const create = useCreateAccessRequest();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!justification.trim()) {
      onError('Justification is required.');
      return;
    }
    if (durationDays < 1 || durationDays > 365) {
      onError('Duration must be between 1 and 365 days.');
      return;
    }
    try {
      const created = await create.mutateAsync({
        data_product_id: productId,
        justification: justification.trim(),
        access_level: accessLevel,
        duration_days: durationDays,
      });
      onSuccess(created);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to submit access request.');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 space-y-4 max-w-2xl">
      <div>
        <p className="text-sm text-gray-700">
          Requesting access for product:{' '}
          <code className="bg-gray-100 px-2 py-0.5 rounded text-sm">{productId}</code>
        </p>
      </div>

      <div>
        <label htmlFor="justification" className="block text-sm font-medium text-gray-700">
          Justification <span className="text-red-500">*</span>
        </label>
        <textarea
          id="justification"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          required
          minLength={10}
          rows={4}
          placeholder="Explain why you need access to this data product…"
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-brand-500 focus:border-brand-500"
        />
        <p className="mt-1 text-xs text-gray-500">
          Minimum 10 characters. Be specific — data owners use this to make approval decisions.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="access-level" className="block text-sm font-medium text-gray-700">
            Access level
          </label>
          <select
            id="access-level"
            value={accessLevel}
            onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            <option value="read">Read</option>
            <option value="read_write">Read &amp; write</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <div>
          <label htmlFor="duration-days" className="block text-sm font-medium text-gray-700">
            Duration (days)
          </label>
          <input
            id="duration-days"
            type="number"
            min={1}
            max={365}
            value={durationDays}
            onChange={(e) => setDurationDays(Number(e.target.value))}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">Between 1 and 365 days.</p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={create.isPending}>
          Submit request
        </Button>
      </div>
    </form>
  );
}

function AccessRequestsTable({
  requests,
  onReview,
  reviewPendingId,
}: {
  requests: AccessRequest[];
  onReview: (action: ReviewAction) => void;
  reviewPendingId: string | null;
}) {
  if (requests.length === 0) {
    return (
      <div className="text-center py-16 bg-gray-50 rounded-lg">
        <p className="text-gray-500">No access requests.</p>
      </div>
    );
  }
  return (
    <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Requester</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Level</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Duration</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Requested</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Notes</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Review</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {requests.map((r) => (
            <tr key={r.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                <code className="text-xs">{r.data_product_id}</code>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{r.requester_email}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700 capitalize">
                {r.access_level.replace(/_/g, ' ')}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{r.duration_days}d</td>
              <td className="px-6 py-4 whitespace-nowrap"><StatusBadge status={r.status} /></td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(r.requested_at).toLocaleDateString()}
              </td>
              <td className="px-6 py-4 text-xs text-gray-500 max-w-[18rem] truncate" title={r.review_notes ?? ''}>
                {r.review_notes ?? ''}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                {r.status === 'pending' ? (
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={reviewPendingId === r.id}
                      onClick={() => onReview({ kind: 'approve', request: r })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={reviewPendingId === r.id}
                      onClick={() => onReview({ kind: 'deny', request: r })}
                    >
                      Deny
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AccessPage() {
  const router = useRouter();
  const rawProductId = router.query.product_id;
  const productId = typeof rawProductId === 'string' ? rawProductId : '';

  // Local flag lets us flip out of create-mode after a successful submit
  // without forcing the user back through the browser URL.
  const [submittedInSession, setSubmittedInSession] = useState(false);
  const showForm = !!productId && !submittedInSession;

  const [statusFilter, setStatusFilter] = useState<string>('');
  const {
    data: requests,
    isLoading,
    error,
    refetch,
  } = useAccessRequests(statusFilter ? { status: statusFilter } : undefined);

  const approve = useApproveAccessRequest();
  const deny = useDenyAccessRequest();
  const { toast, showToast, setOpen: setToastOpen } = useToast();

  const [reviewAction, setReviewAction] = useState<ReviewAction>(null);
  const [reviewNotes, setReviewNotes] = useState('');

  const handleReviewSubmit = async () => {
    if (!reviewAction) return;
    try {
      if (reviewAction.kind === 'approve') {
        await approve.mutateAsync({
          id: reviewAction.request.id,
          notes: reviewNotes.trim() || undefined,
        });
        showToast('Access request approved.', 'success');
      } else {
        if (!reviewNotes.trim()) {
          showToast('Please provide a reason when denying a request.', 'error');
          return;
        }
        await deny.mutateAsync({
          id: reviewAction.request.id,
          notes: reviewNotes.trim(),
        });
        showToast('Access request denied.', 'success');
      }
      setReviewAction(null);
      setReviewNotes('');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Review action failed.',
        'error'
      );
    }
  };

  const reviewPending = approve.isPending || deny.isPending;
  const reviewPendingId = reviewPending && reviewAction ? reviewAction.request.id : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access Requests"
        description={showForm ? 'Submit a new access request' : 'Manage data access requests'}
      />

      {showForm ? (
        <AccessRequestForm
          productId={productId}
          onSuccess={() => {
            showToast('Access request submitted.', 'success');
            setSubmittedInSession(true);
            // Strip product_id from URL so back-nav shows the list naturally.
            router.replace('/access', undefined, { shallow: true });
          }}
          onError={(msg) => showToast(msg, 'error')}
        />
      ) : (
        <>
          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
              <option value="revoked">Revoked</option>
              <option value="expired">Expired</option>
            </select>
          </div>

          {error ? (
            <ErrorBanner
              title="Failed to load access requests"
              message={error instanceof Error ? error.message : 'An unexpected error occurred.'}
              onRetry={() => refetch()}
            />
          ) : isLoading ? (
            <div className="flex items-center justify-center h-64">
              <div role="status" aria-label="Loading">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
              </div>
            </div>
          ) : (
            <AccessRequestsTable
              requests={requests ?? []}
              onReview={setReviewAction}
              reviewPendingId={reviewPendingId}
            />
          )}
        </>
      )}

      {/* Review modal */}
      <Modal
        open={reviewAction !== null}
        onOpenChange={(o) => {
          if (!o) {
            setReviewAction(null);
            setReviewNotes('');
          }
        }}
        title={
          reviewAction?.kind === 'approve'
            ? 'Approve access request?'
            : 'Deny access request?'
        }
        description={
          reviewAction
            ? `From ${reviewAction.request.requester_email} for product ${reviewAction.request.data_product_id}.`
            : ''
        }
      >
        <div className="space-y-3">
          <label htmlFor="review-notes" className="block text-sm font-medium text-gray-700">
            Notes {reviewAction?.kind === 'deny' && <span className="text-red-500">*</span>}
          </label>
          <textarea
            id="review-notes"
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            rows={3}
            placeholder={
              reviewAction?.kind === 'approve'
                ? 'Optional notes to include with the approval'
                : 'Explain why this request is being denied'
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setReviewAction(null); setReviewNotes(''); }}
              disabled={reviewPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={reviewAction?.kind === 'approve' ? 'primary' : 'danger'}
              onClick={handleReviewSubmit}
              loading={reviewPending}
            >
              {reviewAction?.kind === 'approve' ? 'Approve' : 'Deny'}
            </Button>
          </div>
        </div>
      </Modal>

      <Toast
        open={toast.open}
        onOpenChange={setToastOpen}
        message={toast.message}
        variant={toast.variant}
      />
    </div>
  );
}

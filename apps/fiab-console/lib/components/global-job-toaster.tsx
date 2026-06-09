'use client';

/**
 * GlobalJobToaster — always-mounted (in AppShell) listener that turns
 * `loom:job-complete` CustomEvents from the module-scope jobs-store into Fluent
 * v9 toasts. Because it lives at the shell level (not inside any editor), it
 * survives route transitions and tab switches: a file upload started in one
 * lakehouse tab still raises its completion toast after the user has navigated
 * to a different item.
 *
 * Every toast NAMES the originating lakehouse (job.lakehouseName) so multitasking
 * users can tell which lakehouse a background job belonged to.
 *
 * A11y: each <Toast> carries role/politeness from Fluent's toaster; success and
 * info use polite, errors use assertive (default for intent="error"). The toast
 * title leads with the lakehouse name so screen-reader users hear the source
 * first.
 */

import { useEffect } from 'react';
import {
  Toaster, Toast, ToastTitle, ToastBody,
  useToastController, useId,
} from '@fluentui/react-components';
import { JOB_EVENT, type JobToastDetail } from '@/lib/state/jobs-store';

export function GlobalJobToaster() {
  const toasterId = useId('loom-jobs');
  const { dispatchToast } = useToastController(toasterId);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<JobToastDetail>).detail;
      const job = detail?.job;
      if (!job) return;

      if (job.kind === 'upload' && job.status === 'success') {
        dispatchToast(
          <Toast>
            <ToastTitle>Uploaded to {job.lakehouseName}</ToastTitle>
            <ToastBody>
              {job.fileName}
              {job.sparkFormatLabel ? ` — ${job.sparkFormatLabel}` : ''}
              {' '}is ready in the lakehouse.
            </ToastBody>
          </Toast>,
          { intent: 'success', timeout: 8000 },
        );
      } else if (job.kind === 'upload' && job.status === 'error') {
        dispatchToast(
          <Toast>
            <ToastTitle>Upload failed — {job.lakehouseName}</ToastTitle>
            <ToastBody>{job.error || 'Unknown error'}</ToastBody>
          </Toast>,
          { intent: 'error', timeout: 12000 },
        );
      } else if (job.kind === 'load-to-table') {
        dispatchToast(
          <Toast>
            <ToastTitle>Loading into {job.lakehouseName}</ToastTitle>
            <ToastBody>
              Table “{job.tableName || job.fileName}” is materializing as a Delta
              table — track progress in Monitor.
            </ToastBody>
          </Toast>,
          { intent: 'info', timeout: 8000 },
        );
      } else if (job.kind === 'sql-query' && job.status === 'success') {
        dispatchToast(
          <Toast>
            <ToastTitle>Query complete — {job.lakehouseName}</ToastTitle>
            <ToastBody>
              {(job.queryResult?.rowCount ?? 0).toLocaleString()} rows ·{' '}
              {job.queryResult?.executionMs ?? 0} ms
              {job.queryResult?.truncated ? ' (truncated at 5,000)' : ''}
            </ToastBody>
          </Toast>,
          { intent: 'success', timeout: 8000 },
        );
      } else if (job.kind === 'sql-query' && job.status === 'error') {
        dispatchToast(
          <Toast>
            <ToastTitle>Query failed — {job.lakehouseName}</ToastTitle>
            <ToastBody>{job.error || 'Unknown error'}</ToastBody>
          </Toast>,
          { intent: 'error', timeout: 12000 },
        );
      }
    };

    window.addEventListener(JOB_EVENT, handler);
    return () => window.removeEventListener(JOB_EVENT, handler);
  }, [dispatchToast]);

  return <Toaster toasterId={toasterId} position="bottom-end" limit={5} />;
}

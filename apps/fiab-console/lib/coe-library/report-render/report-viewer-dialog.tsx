'use client';

/**
 * ReportViewerDialog — a full-width Fluent Dialog that fetches a report's render
 * model from a BFF endpoint and shows it with <ReportCanvas>. Reused by the
 * cloned-template "Open" action and the org-reports consumer gallery.
 *
 * Pass the exact session-gated `fetchUrl` (e.g.
 * `/api/admin/coe-library/render?cloneId=…` or `/api/org-reports/render?id=…`).
 */

import * as React from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Spinner, Badge, MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { ReportCanvas } from './report-canvas';
import { useReportModel } from './use-report';

const useStyles = makeStyles({
  surface: { maxWidth: '95vw', width: '1180px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  center: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL },
});

export interface ReportViewerDialogProps {
  open: boolean;
  onClose: () => void;
  fetchUrl: string | null;
  /** Fallback title until the payload's template title loads. */
  title?: string;
  publishedBadge?: boolean;
}

export function ReportViewerDialog({ open, onClose, fetchUrl, title, publishedBadge }: ReportViewerDialogProps): React.ReactElement {
  const s = useStyles();
  const { data, loading, error } = useReportModel(open ? fetchUrl : null);
  const heading = data?.template?.title || title || 'Report';

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={onClose} />}>
            <span className={s.titleRow}>
              {heading}
              {data?.template?.category && <Badge appearance="tint" color="brand" size="small">{data.template.category}</Badge>}
              {(publishedBadge ?? data?.published) && <Badge appearance="tint" color="success" size="small">Published to org</Badge>}
            </span>
          </DialogTitle>
          <DialogContent>
            {loading && <div className={s.center}><Spinner label="Rendering report…" /></div>}
            {error && (
              <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
            )}
            {!loading && !error && data && <ReportCanvas model={data.model} sample={data.sample} />}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default ReportViewerDialog;

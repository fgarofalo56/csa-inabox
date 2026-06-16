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
  Button, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { ReportView } from './report-view';
import type { ReportPayload } from './use-report';

const useStyles = makeStyles({
  surface: { maxWidth: '95vw', width: '1180px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

export interface ReportViewerDialogProps {
  open: boolean;
  onClose: () => void;
  fetchUrl: string | null;
  /** Fallback title until the payload's template title loads. */
  title?: string;
  publishedBadge?: boolean;
  /** Default to live data. Admin surfaces = true; consumer gallery = false. */
  defaultLive?: boolean;
}

export function ReportViewerDialog({ open, onClose, fetchUrl, title, publishedBadge, defaultLive }: ReportViewerDialogProps): React.ReactElement {
  const s = useStyles();
  const [payload, setPayload] = React.useState<ReportPayload | null>(null);
  React.useEffect(() => { if (!open) setPayload(null); }, [open]);
  const heading = payload?.template?.title || title || 'Report';

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={onClose} />}>
            <span className={s.titleRow}>
              {heading}
              {payload?.template?.category && <Badge appearance="tint" color="brand" size="small">{payload.template.category}</Badge>}
              {(publishedBadge ?? payload?.published) && <Badge appearance="tint" color="success" size="small">Published to org</Badge>}
            </span>
          </DialogTitle>
          <DialogContent>
            <ReportView fetchUrl={open ? fetchUrl : null} onLoaded={setPayload} defaultLive={defaultLive} />
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

'use client';

/**
 * CopilotPane — the "Fix with Copilot" approve-diff dialog.
 *
 * Rendered below any failed notebook cell. On open it POSTs the failing cell
 * source + captured error context (ename / evalue / traceback) to
 * /api/copilot/sessions (mode:'cell-fix'), which calls the real AOAI chat
 * deployment and returns a single corrected-code proposal. The dialog shows the
 * current (failing) source and the proposed fix side-by-side in two read-only
 * Monaco editors; accepting replaces the cell source and clears the error so it
 * can be re-run.
 *
 * Real backend (per no-vaporware.md): no mocks — the proposal comes from AOAI.
 * When AOAI is unconfigured the POST returns a 503 gate which renders here as a
 * Fluent MessageBar naming the env var to set.
 */

import { useEffect, useState } from 'react';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Sparkle20Regular } from '@fluentui/react-icons';
import type { NotebookCell, NotebookCellOutput } from '@/lib/types/notebook-cell';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  surface: { maxWidth: '760px', width: '90vw' },
  content: { display: 'flex', flexDirection: 'column', gap: '12px' },
  sectionLabel: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  proposedLabel: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  proposedBox: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  currentBox: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '24px 0',
  },
  audit: { color: tokens.colorNeutralForeground3 },
});

export interface CopilotPaneProps {
  open: boolean;
  cell: NotebookCell;
  output: NotebookCellOutput;
  onAccept: (proposedCode: string) => void;
  onClose: () => void;
}

export function CopilotPane({ open, cell, output, onAccept, onClose }: CopilotPaneProps) {
  const s = useStyles();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [proposedCode, setProposedCode] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const lang = (cell.lang || 'pyspark') as MonacoLanguage;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHint(null);
    setProposedCode(null);
    setSessionId(null);

    const traceback = Array.isArray(output.traceback)
      ? output.traceback
      : output.traceback
      ? [output.traceback]
      : [];

    (async () => {
      try {
        const res = await fetch('/api/copilot/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'cell-fix',
            cellSource: cell.source,
            lang: cell.lang || 'pyspark',
            errorContext: { ename: output.ename, evalue: output.evalue, traceback },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.ok) {
          setError(j?.error || `HTTP ${res.status}`);
          setHint(j?.hint || null);
        } else {
          setProposedCode(j.proposedCode);
          setSessionId(j.sessionId);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, cell.id, cell.source, cell.lang, output.ename, output.evalue, output.traceback]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <Sparkle20Regular style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
            Fix with Copilot
          </DialogTitle>
          <DialogContent className={s.content}>
            {loading && (
              <div className={s.loading}>
                <Spinner size="small" />
                <Text>Asking AOAI for a fix…</Text>
              </div>
            )}

            {!loading && error && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Could not generate a fix</MessageBarTitle>
                  {error}
                  {hint ? ` — ${hint}` : ''}
                </MessageBarBody>
              </MessageBar>
            )}

            {!loading && proposedCode != null && (
              <>
                <Caption1 className={s.sectionLabel}>Current (failing)</Caption1>
                <div className={s.currentBox}>
                  <MonacoTextarea
                    value={cell.source}
                    onChange={() => {}}
                    language={lang}
                    readOnly
                    height={160}
                    minHeight={80}
                    ariaLabel="Current failing cell source"
                  />
                </div>
                <Caption1 className={s.proposedLabel}>Proposed fix</Caption1>
                <div className={s.proposedBox}>
                  <MonacoTextarea
                    value={proposedCode}
                    onChange={() => {}}
                    language={lang}
                    readOnly
                    height={160}
                    minHeight={80}
                    ariaLabel="Proposed Copilot fix"
                  />
                </div>
                {sessionId && (
                  <Caption1 className={s.audit}>Session {sessionId}</Caption1>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              disabled={loading || proposedCode == null}
              onClick={() => proposedCode != null && onAccept(proposedCode)}
            >
              Accept fix
            </Button>
            <Button appearance="secondary" onClick={onClose}>
              Dismiss
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

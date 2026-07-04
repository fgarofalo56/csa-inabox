'use client';
/**
 * ConfirmDialog — the ONE themed confirmation primitive for CSA Loom (rel-T69).
 *
 * Native `window.confirm()` / `alert()` are unthemed, break the Web-3.0 look,
 * and are SUPPRESSIBLE by the browser ("prevent this page from creating more
 * dialogs") — so a destructive action guarded only by native confirm can be
 * bypassed with a single un-noticed click. Every destructive/confirm flow uses
 * this Fluent v9 dialog instead, with a red `danger` variant for irreversible
 * Azure actions (drop schema, delete cluster, revoke keys).
 *
 * Two ways to use it:
 *   1. `<ConfirmDialog .../>` — the controlled component, if you already manage
 *      the open state.
 *   2. `useConfirm()` — the ergonomic replacement for `window.confirm`:
 *        const { confirm, dialog } = useConfirm();
 *        // render {dialog} once in your JSX, then in a handler:
 *        if (!(await confirm({ title: 'Delete cluster?', body: '…',
 *                              danger: true, confirmLabel: 'Delete' }))) return;
 *      Optionally pass `onConfirm` to run the async action INSIDE the dialog so
 *      it shows a busy spinner and surfaces a failure inline instead of closing.
 */
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface,
  DialogTitle, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens,
} from '@fluentui/react-components';
import { useCallback, useRef, useState, type ReactNode } from 'react';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  error: { marginTop: tokens.spacingVerticalS },
  // Fluent v9 has no built-in red primary button; compose one from the danger
  // status tokens so it reads as destructive in light and dark themes.
  danger: {
    backgroundColor: tokens.colorStatusDangerBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
    ':hover': {
      backgroundColor: tokens.colorStatusDangerBackground3Hover,
      color: tokens.colorNeutralForegroundOnBrand,
    },
    ':hover:active': {
      backgroundColor: tokens.colorStatusDangerBackground3Pressed,
      color: tokens.colorNeutralForegroundOnBrand,
    },
  },
});

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for irreversible/destructive actions. */
  danger?: boolean;
  /** While true the action is running: spinner on confirm, both buttons locked. */
  busy?: boolean;
  /** Shown as an inline error MessageBar without closing the dialog. */
  inlineError?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, busy = false, inlineError, onConfirm, onCancel,
}: ConfirmDialogProps) {
  const styles = useStyles();
  return (
    <Dialog
      open={open}
      // "alert" disables light-dismiss so a destructive choice is explicit.
      modalType="alert"
      onOpenChange={(_e, data) => { if (!data.open && !busy) onCancel(); }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {typeof body === 'string' ? <Text>{body}</Text> : body}
              {inlineError ? (
                <MessageBar intent="error" className={styles.error}>
                  <MessageBarBody>{inlineError}</MessageBarBody>
                </MessageBar>
              ) : null}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy} onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              appearance="primary"
              className={danger ? styles.danger : undefined}
              disabled={busy}
              icon={busy ? <Spinner size="tiny" /> : undefined}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * Optional async action to run WHILE the dialog stays open with a busy
   * spinner. If it throws, the thrown message is shown inline and the dialog
   * stays open (so the user can retry/cancel); on success the dialog closes and
   * `confirm()` resolves `true`. Omit it for the simple boolean-gate pattern
   * (`if (!(await confirm({...}))) return;`) where the caller runs the action.
   */
  onConfirm?: () => Promise<void> | void;
}

/**
 * Imperative, promise-based replacement for `window.confirm`. Returns a
 * `confirm(opts) => Promise<boolean>` plus a `dialog` element to render once in
 * the component's JSX. Self-contained (no root provider needed).
 */
export function useConfirm() {
  const [state, setState] = useState<{
    open: boolean; opts: ConfirmOptions | null; busy: boolean; error: string | null;
  }>({ open: false, opts: null, busy: false, error: null });
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setState({ open: true, opts, busy: false, error: null });
      }),
    [],
  );

  const settle = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setState((s) => ({ ...s, open: false, busy: false, error: null }));
  }, []);

  const handleConfirm = useCallback(async () => {
    const action = state.opts?.onConfirm;
    if (!action) { settle(true); return; }
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      await action();
      settle(true);
    } catch (e) {
      setState((s) => ({ ...s, busy: false, error: (e as Error)?.message || String(e) }));
    }
  }, [state.opts, settle]);

  const dialog = (
    <ConfirmDialog
      open={state.open}
      title={state.opts?.title ?? ''}
      body={state.opts?.body}
      confirmLabel={state.opts?.confirmLabel}
      cancelLabel={state.opts?.cancelLabel}
      danger={state.opts?.danger}
      busy={state.busy}
      inlineError={state.error}
      onConfirm={handleConfirm}
      onCancel={() => { if (!state.busy) settle(false); }}
    />
  );

  return { confirm, dialog };
}

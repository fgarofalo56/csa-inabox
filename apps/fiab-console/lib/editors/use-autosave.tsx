'use client';

/**
 * useAutosave + AutosaveIndicator — debounced autosave for editors that hold
 * an in-memory draft (rel-T70). Copies the task-flows.tsx debounced-save
 * pattern: when the editor goes dirty, wait `delayMs` of quiet, then invoke the
 * editor's EXISTING save call (no new backend). The indicator surfaces a subtle
 * Saving… / Saved status so the operator knows their work is being persisted.
 *
 * Scoped to cheap, non-destructive editors (notebook, dashboard). Do NOT wire
 * this into editors whose save triggers an expensive/destructive backend action
 * (provisioning, a pipeline run, a TMSL model rebuild) — those must stay
 * explicit-save.
 *
 * Guard: pass `enabled={false}` (e.g. for an empty/unmodified doc, or before the
 * item id is known) to suppress autosave — an empty draft is never autosaved.
 */

import { useEffect, useRef, useState } from 'react';
import { Spinner, Text, tokens } from '@fluentui/react-components';
import { CheckmarkCircle16Regular, CloudArrowUp16Regular, ErrorCircle16Regular } from '@fluentui/react-icons';

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export function useAutosave(opts: {
  dirty: boolean;
  /** Suppress autosave (empty/unmodified doc, id not ready, feature off). */
  enabled?: boolean;
  /** Quiet period before persisting. Default 2500ms. */
  delayMs?: number;
  /**
   * The editor's existing save call, MEMOIZED with useCallback over its
   * content (like notebook `save` / dashboard `saveOverlay`). Its changing
   * identity is what re-arms the debounce on each edit — pass a stable
   * (content-keyed) callback so the timer resets while the user keeps typing
   * and only fires after `delayMs` of quiet. Should throw on failure.
   */
  onSave: () => Promise<void> | void;
}): AutosaveStatus {
  const { dirty, enabled = true, delayMs = 2500, onSave } = opts;
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !dirty) return;
    setStatus('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStatus('saving');
      try {
        await onSave();
        setStatus('saved');
      } catch {
        // The editor's own save path surfaces the detailed error; the indicator
        // just flags that autosave didn't stick so the user saves manually.
        setStatus('error');
      }
    }, delayMs);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // `onSave` is content-memoized by the caller — its identity changing on each
    // edit is exactly what debounces the save (re-arms the timer).
  }, [dirty, enabled, delayMs, onSave]);

  return status;
}

export function AutosaveIndicator({ status }: { status: AutosaveStatus }) {
  if (status === 'idle') return null;

  const map: Record<Exclude<AutosaveStatus, 'idle'>, { icon: React.ReactNode; label: string; color: string }> = {
    pending: { icon: <CloudArrowUp16Regular />, label: 'Unsaved changes', color: tokens.colorNeutralForeground3 },
    saving: { icon: <Spinner size="extra-tiny" />, label: 'Saving…', color: tokens.colorNeutralForeground3 },
    saved: { icon: <CheckmarkCircle16Regular />, label: 'Saved', color: tokens.colorStatusSuccessForeground1 },
    error: { icon: <ErrorCircle16Regular />, label: 'Autosave failed — save manually', color: tokens.colorStatusDangerForeground1 },
  };
  const s = map[status];

  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        color: s.color,
      }}
    >
      {s.icon}
      <Text size={200} style={{ color: s.color }}>{s.label}</Text>
    </span>
  );
}

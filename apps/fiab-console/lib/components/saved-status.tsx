'use client';

/**
 * SavedStatus — small "Saved · 2s ago" indicator like Fabric. Listens for
 * `loom:item-saved` and `loom:item-saving` CustomEvents that editors fire
 * after a successful PATCH or before they start.
 *
 * No timer if there's no signal. Persists across navigations within a
 * session but resets on full reload.
 */

import { useEffect, useState } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle16Filled, ArrowSyncCircle16Regular } from '@fluentui/react-icons';

type State = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: number; label?: string };

const useStyles = makeStyles({
  root: {
    display: 'inline-flex', alignItems: 'center',
    gap: tokens.spacingHorizontalSNudge, color: 'rgba(255,255,255,0.78)',
    fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap',
    paddingLeft: 'var(--loom-space-2)',
    paddingRight: 'var(--loom-space-2)',
  },
  saving: { color: '#FFE69C' },
  saved: { color: '#A7F3D0' },
});

function relative(ms: number): string {
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export function SavedStatus() {
  const styles = useStyles();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [, force] = useState(0);

  useEffect(() => {
    const onSaving = () => setState({ kind: 'saving' });
    const onSaved = (e: Event) => {
      const detail = (e as CustomEvent).detail as { label?: string } | undefined;
      setState({ kind: 'saved', at: Date.now(), label: detail?.label });
    };
    window.addEventListener('loom:item-saving', onSaving);
    window.addEventListener('loom:item-saved', onSaved);
    return () => {
      window.removeEventListener('loom:item-saving', onSaving);
      window.removeEventListener('loom:item-saved', onSaved);
    };
  }, []);

  useEffect(() => {
    if (state.kind !== 'saved') return;
    const id = setInterval(() => force(n => n + 1), 15_000);
    return () => clearInterval(id);
  }, [state.kind]);

  if (state.kind === 'idle') return null;
  if (state.kind === 'saving') {
    return (
      <span className={`${styles.root} ${styles.saving}`}>
        <ArrowSyncCircle16Regular /> Saving…
      </span>
    );
  }
  return (
    <span className={`${styles.root} ${styles.saved}`}>
      <CheckmarkCircle16Filled />
      Saved {state.label ? `· ${state.label} ` : ''}· {relative(Date.now() - state.at)}
    </span>
  );
}

'use client';

/**
 * WS-10.3 Time-Machine — the GLOBAL time-bar.
 *
 * A compact topbar control that sets the SESSION `asOf` (persisted in the UI
 * store). Every time-aware surface reads `useUi(s => s.asOf)` and appends it to
 * its data reads via `withAsOfParam`, so flipping this bar re-queries the
 * ontology, reports, and pipeline outputs AS OF the chosen point in time — the
 * shared temporal coordinator resolves it to each backend's native time-travel.
 *
 * The trigger shows "Live" (default) or the active as-of, styled to sit in the
 * topbar with NO layout shift. The popover offers: Live / a specific instant /
 * a Delta version, and the workspace's named time-branches (shadow workspaces) —
 * apply, save-current-as-branch, delete. Fluent v9 + Loom tokens (web3-ui.md).
 */

import { useEffect, useState, useCallback } from 'react';
import {
  makeStyles, tokens, shorthands,
  Button, Tooltip, Badge, Divider, Spinner,
  Popover, PopoverTrigger, PopoverSurface,
  Field, Input, Radio, RadioGroup,
  Text, Caption1, MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import {
  History20Regular, History24Regular, Save20Regular, Delete20Regular,
  Clock20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { useUi } from '@/lib/stores/ui';
import {
  LIVE, isLive, asOfLabel, serializeAsOf, parseAsOfLenient, type AsOfSpec,
} from '@/lib/time-machine/time-machine';

const useStyles = makeStyles({
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: 'var(--loom-space-1)',
    maxWidth: '210px',
    minWidth: 0,
  },
  triggerLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '150px',
  },
  surface: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: 'var(--loom-space-3)',
    width: '320px',
    maxWidth: '90vw',
  },
  head: { display: 'flex', alignItems: 'center', columnGap: 'var(--loom-space-2)' },
  row: { display: 'flex', alignItems: 'flex-end', columnGap: 'var(--loom-space-2)' },
  grow: { flex: 1, minWidth: 0 },
  branchList: { display: 'flex', flexDirection: 'column', rowGap: 'var(--loom-space-1)', maxHeight: '180px', overflowY: 'auto' },
  branchRow: {
    display: 'flex', alignItems: 'center', columnGap: 'var(--loom-space-2)',
    ...shorthands.padding('var(--loom-space-1)', 'var(--loom-space-2)'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  branchMeta: { flex: 1, minWidth: 0, overflow: 'hidden' },
  branchName: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
});

interface TimeBranchView {
  id: string;
  name: string;
  description?: string;
  asOfValue: string;
  asOfLabel: string;
  createdByName?: string;
}

/** Convert the persisted asOf to a `datetime-local` input value (local tz). */
function toLocalInput(spec: AsOfSpec): string {
  if (spec.kind !== 'timestamp') return '';
  const d = new Date(spec.iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function GlobalTimeBar() {
  const s = useStyles();
  const asOf = useUi((st) => st.asOf) ?? LIVE;
  const setAsOf = useUi((st) => st.setAsOf);
  const activeWorkspace = useUi((st) => st.activeWorkspace);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'live' | 'timestamp' | 'version'>(asOf.kind);
  const [tsInput, setTsInput] = useState(toLocalInput(asOf));
  const [verInput, setVerInput] = useState(asOf.kind === 'version' ? String(asOf.version) : '');
  const [branches, setBranches] = useState<TimeBranchView[] | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsId = activeWorkspace?.id;

  // Re-sync the local form when the popover opens or the applied asOf changes.
  useEffect(() => {
    if (!open) return;
    setMode(asOf.kind);
    setTsInput(toLocalInput(asOf));
    setVerInput(asOf.kind === 'version' ? String(asOf.version) : '');
    setError(null);
  }, [open, asOf]);

  const loadBranches = useCallback(async () => {
    if (!wsId) { setBranches([]); return; }
    setLoadingBranches(true);
    try {
      const res = await clientFetch(`/api/workspaces/${encodeURIComponent(wsId)}/time-branches`);
      const body = await res.json().catch(() => ({}));
      setBranches(res.ok && body?.ok ? (body.branches ?? []) : []);
    } catch {
      setBranches([]);
    } finally {
      setLoadingBranches(false);
    }
  }, [wsId]);

  useEffect(() => {
    if (open) void loadBranches();
  }, [open, loadBranches]);

  function applyMode() {
    setError(null);
    if (mode === 'live') { setAsOf(LIVE); setOpen(false); return; }
    if (mode === 'version') {
      const n = Number(verInput);
      if (!Number.isInteger(n) || n < 0) { setError('Enter a whole Delta version (0 or greater).'); return; }
      setAsOf({ kind: 'version', version: n });
      setOpen(false);
      return;
    }
    // timestamp — the datetime-local value is local; convert to a UTC ISO.
    if (!tsInput) { setError('Pick a date and time.'); return; }
    const d = new Date(tsInput);
    if (Number.isNaN(d.getTime())) { setError('That date/time is not valid.'); return; }
    setAsOf({ kind: 'timestamp', iso: d.toISOString() });
    setOpen(false);
  }

  function applyBranch(b: TimeBranchView) {
    setAsOf(parseAsOfLenient(b.asOfValue));
    setOpen(false);
  }

  async function saveBranch() {
    if (!wsId) { setError('Open a workspace to save a time-branch.'); return; }
    if (isLive(asOf)) { setError('Set a specific time first — a branch pins a point in time, not "Live".'); return; }
    const name = branchName.trim();
    if (!name) { setError('Name the branch.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await clientFetch(`/api/workspaces/${encodeURIComponent(wsId)}/time-branches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, asOf: serializeAsOf(asOf) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) { setError(body?.error || 'Could not save the branch.'); return; }
      setBranchName('');
      await loadBranches();
    } finally {
      setBusy(false);
    }
  }

  async function deleteBranch(id: string) {
    if (!wsId) return;
    setBusy(true);
    try {
      await clientFetch(`/api/workspaces/${encodeURIComponent(wsId)}/time-branches/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadBranches();
    } finally {
      setBusy(false);
    }
  }

  const live = isLive(asOf);
  const label = live ? 'Live' : asOfLabel(asOf);

  return (
    <Popover open={open} onOpenChange={(_, d) => setOpen(d.open)} positioning="below-end" withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <Tooltip content={live ? 'Time-Machine — viewing live data' : `Time-Machine — ${label}`} relationship="label">
          <Button
            appearance={live ? 'transparent' : 'primary'}
            size="small"
            className={s.trigger}
            icon={live ? <History20Regular /> : <Clock20Regular />}
            aria-label={`Time-Machine: ${label}. Choose a point in time`}
            data-tour="time-machine"
          >
            <span className={s.triggerLabel}>{live ? 'Live' : label}</span>
          </Button>
        </Tooltip>
      </PopoverTrigger>
      <PopoverSurface className={s.surface}>
        <div className={s.head}>
          <History24Regular />
          <Text weight="semibold">Time-Machine</Text>
          {!live && <Badge appearance="tint" color="brand">{label}</Badge>}
        </div>
        <Caption1 className={s.muted}>
          View the ontology, reports and pipeline output as of a point in time. Backends resolve it natively
          (Delta AS OF, ADX ingestion-time, Synapse temporal); sources without time-travel say so.
        </Caption1>

        <RadioGroup value={mode} onChange={(_, d) => setMode(d.value as typeof mode)}>
          <Radio value="live" label="Live (current data)" />
          <Radio value="timestamp" label="As of a specific time" />
          <Radio value="version" label="As of a Delta version" />
        </RadioGroup>

        {mode === 'timestamp' && (
          <Field label="Point in time">
            <Input type="datetime-local" value={tsInput} onChange={(_, d) => setTsInput(d.value)} />
          </Field>
        )}
        {mode === 'version' && (
          <Field label="Delta version">
            <Input type="number" min={0} value={verInput} onChange={(_, d) => setVerInput(d.value)} placeholder="e.g. 42" />
          </Field>
        )}

        {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

        <div className={s.row}>
          <Button appearance="primary" onClick={applyMode}>Apply</Button>
          {!live && <Button appearance="subtle" onClick={() => { setAsOf(LIVE); setOpen(false); }}>Back to live</Button>}
        </div>

        <Divider />

        <div className={s.head}>
          <Text weight="semibold">Branches</Text>
          <Caption1 className={s.muted}>shadow workspaces pinned to a time</Caption1>
        </div>

        {loadingBranches ? (
          <Spinner size="tiny" label="Loading branches…" />
        ) : !wsId ? (
          <Caption1 className={s.muted}>Open a workspace to save and switch between time-branches.</Caption1>
        ) : (branches && branches.length > 0) ? (
          <div className={s.branchList}>
            {branches.map((b) => (
              <div key={b.id} className={s.branchRow}>
                <div className={s.branchMeta}>
                  <Text className={s.branchName} weight="semibold">{b.name}</Text>
                  <Caption1 className={s.muted}>{b.asOfLabel}</Caption1>
                </div>
                <Button size="small" appearance="secondary" onClick={() => applyBranch(b)}>Open</Button>
                <Tooltip content="Delete branch" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete branch ${b.name}`}
                    disabled={busy} onClick={() => deleteBranch(b.id)} />
                </Tooltip>
              </div>
            ))}
          </div>
        ) : (
          <Caption1 className={s.muted}>No time-branches yet. Set a time above, then save one.</Caption1>
        )}

        {wsId && (
          <div className={s.row}>
            <Field className={s.grow} label="Save current time as a branch">
              <Input value={branchName} placeholder="e.g. Q2 close" onChange={(_, d) => setBranchName(d.value)} />
            </Field>
            <Button appearance="secondary" icon={<Save20Regular />} disabled={busy || live} onClick={saveBranch}>Save</Button>
          </div>
        )}
      </PopoverSurface>
    </Popover>
  );
}

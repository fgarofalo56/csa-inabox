'use client';

/**
 * DP-9 — Versions & lifecycle panel for the data-product editor.
 *
 * Version history (immutable, append-only) with a per-version schema diff, a
 * "snapshot current contract as a new version" action that classifies the semver
 * level (patch/minor/major) and flags breaking changes, and a humane deprecation
 * form (sunset date + replacement pointer + migration note + notice window) that
 * rides DP-1's canonical lifecycle (published → deprecated → retired). Backed by
 * GET/POST /versions + POST /deprecate. Azure-native Cosmos; no Fabric dependency.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1Strong, Button, Caption1, Dropdown, Field, Input, Option, Spinner, Text, Textarea, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { History20Regular, BranchFork20Regular, Warning20Regular } from '@fluentui/react-icons';
import type { DataContract } from '@/lib/dataproducts/contract';
import type { VersionEntry, DeprecationRecord } from '@/lib/dataproducts/versioning';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingHorizontalL, maxWidth: '860px' },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  ver: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  verHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  change: { color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
});

const LEVEL_COLOR: Record<string, 'informative' | 'brand' | 'danger'> = { patch: 'informative', minor: 'brand', major: 'danger' };

interface ProductLite { id: string; displayName: string }

export function VersionsPanel({ id, isNew }: { id: string; isNew?: boolean }) {
  const s = useStyles();
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [current, setCurrent] = useState<DataContract | null>(null);
  const [deprecation, setDeprecation] = useState<DeprecationRecord | null>(null);
  const [lifecycleState, setLifecycleState] = useState<string>('draft');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'warn'; msg: string } | null>(null);

  // Deprecation form
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [sunsetAt, setSunsetAt] = useState('');
  const [noticeDays, setNoticeDays] = useState('60');
  const [replacementProductId, setReplacementProductId] = useState('');
  const [migrationNote, setMigrationNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vr, dr] = await Promise.all([
        clientFetch(`/api/data-products/${encodeURIComponent(id)}/versions`),
        clientFetch(`/api/data-products/${encodeURIComponent(id)}`),
      ]);
      const vj = await vr.json();
      if (vj.ok) { setVersions(vj.versions || []); setCurrent(vj.current || null); }
      const dj = await dr.json();
      if (dj.ok) {
        setDeprecation((dj.item?.state?.deprecation as DeprecationRecord) ?? null);
        setLifecycleState(dj.item?.state?.lifecycleState || 'draft');
      }
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    load();
    (async () => {
      try { const r = await clientFetch('/api/data-products'); const j = await r.json();
        if (j.ok) setProducts((j.products || j.dataProducts || []).map((p: any) => ({ id: p.id, displayName: p.displayName }))); }
      catch { /* picker best-effort */ }
    })();
  }, [isNew, load]);

  const snapshot = useCallback(async () => {
    if (!current) { setNote({ kind: 'warn', msg: 'No contract to snapshot — define one on the Contract tab first.' }); return; }
    setBusy('snapshot'); setNote(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/versions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: current }),
      });
      const j = await r.json();
      if (!j.ok) { setNote({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setNote({ kind: j.breaking ? 'warn' : 'ok', msg: `Snapshotted v${j.entry.version} (${j.entry.level})${j.breaking ? ' — contains BREAKING changes; a major bump is required before publish.' : '.'}` });
      await load();
    } finally { setBusy(null); }
  }, [id, current, load]);

  const deprecate = useCallback(async () => {
    if (!sunsetAt) { setNote({ kind: 'warn', msg: 'Pick a sunset date.' }); return; }
    setBusy('deprecate'); setNote(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/deprecate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'deprecate', sunsetAt, noticeDays: Number(noticeDays), replacementProductId: replacementProductId || undefined, migrationNote: migrationNote || undefined }),
      });
      const j = await r.json();
      setNote(j.ok ? { kind: 'ok', msg: 'Deprecated — subscribers notified; the product stays queryable until sunset.' } : { kind: 'err', msg: j.error || `HTTP ${r.status}` });
      if (j.ok) await load();
    } finally { setBusy(null); }
  }, [id, sunsetAt, noticeDays, replacementProductId, migrationNote, load]);

  const lifecycleAction = useCallback(async (action: 'reactivate' | 'retire') => {
    setBusy(action); setNote(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/deprecate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const j = await r.json();
      setNote(j.ok ? { kind: 'ok', msg: action === 'retire' ? 'Retired.' : 'Reactivated.' } : { kind: 'err', msg: j.error || `HTTP ${r.status}` });
      if (j.ok) await load();
    } finally { setBusy(null); }
  }, [id, load]);

  if (isNew) return <div className={s.wrap}><MessageBar intent="info"><MessageBarBody>Save the data product first to manage versions and deprecation.</MessageBarBody></MessageBar></div>;
  if (loading) return <div className={s.wrap}><Spinner size="tiny" label="Loading versions…" /></div>;

  const isDeprecated = lifecycleState === 'deprecated' || lifecycleState === 'retired';

  return (
    <div className={s.wrap}>
      {note && (
        <MessageBar intent={note.kind === 'ok' ? 'success' : note.kind === 'warn' ? 'warning' : 'error'}>
          <MessageBarBody>{note.msg}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.section}>
        <div className={s.head}><History20Regular /><Body1Strong>Version history</Body1Strong><Badge appearance="tint">{versions.length}</Badge></div>
        <Caption1>Each snapshot is immutable. The current contract is {current ? `v${current.version || '—'}` : 'not defined yet'}.</Caption1>
        <Button icon={<BranchFork20Regular />} appearance="primary" onClick={snapshot} disabled={busy !== null || !current}>
          {busy === 'snapshot' ? 'Snapshotting…' : 'Snapshot current contract as a new version'}
        </Button>
        {[...versions].reverse().map((v) => (
          <div key={`${v.version}-${v.createdAt}`} className={s.ver}>
            <div className={s.verHead}>
              <Body1Strong>v{v.version}</Body1Strong>
              <Badge appearance="filled" color={LEVEL_COLOR[v.level] || 'informative'}>{v.level}</Badge>
              <Caption1>{new Date(v.createdAt).toLocaleString()} · {v.createdBy || '—'}</Caption1>
            </div>
            {v.note && <Caption1>{v.note}</Caption1>}
            {(v.changes || []).map((c, ci) => (
              <Caption1 key={ci} className={s.change}>{c.breaking ? '⚠ ' : '• '}{c.detail}</Caption1>
            ))}
          </div>
        ))}
      </div>

      <Divider />

      <div className={s.section}>
        <div className={s.head}><Warning20Regular /><Body1Strong>Deprecation</Body1Strong>
          <Badge appearance="tint" color={isDeprecated ? 'warning' : 'informative'}>{lifecycleState}</Badge></div>
        {deprecation ? (
          <div className={s.form}>
            <Text>Sunset {new Date(deprecation.sunsetAt).toLocaleDateString()} · {deprecation.noticeDays}-day notice
              {deprecation.replacementProductId ? ` · replaced by ${products.find((p) => p.id === deprecation.replacementProductId)?.displayName || deprecation.replacementProductId}` : ''}</Text>
            {deprecation.migrationNote && <Caption1>{deprecation.migrationNote}</Caption1>}
            <div className={s.row}>
              {lifecycleState !== 'retired' && <Button onClick={() => lifecycleAction('retire')} disabled={busy !== null}>Retire now</Button>}
              <Button onClick={() => lifecycleAction('reactivate')} disabled={busy !== null}>Reactivate</Button>
            </div>
          </div>
        ) : (
          <div className={s.form}>
            <Caption1>Deprecate with a parallel-run window — consumers keep querying until the sunset date, then it retires.</Caption1>
            <div className={s.row}>
              <Field label="Sunset date"><Input type="date" value={sunsetAt} onChange={(_, d) => setSunsetAt(d.value)} /></Field>
              <Field label="Notice window">
                <Dropdown selectedOptions={[noticeDays]} value={`${noticeDays} days`} onOptionSelect={(_, d) => setNoticeDays(d.optionValue || '60')}>
                  {['30', '60', '90'].map((n) => (<Option key={n} value={n} text={`${n} days`}>{n} days</Option>))}
                </Dropdown>
              </Field>
              <Field label="Replacement product">
                <Dropdown placeholder="(optional)" selectedOptions={replacementProductId ? [replacementProductId] : []}
                  value={products.find((p) => p.id === replacementProductId)?.displayName || ''}
                  onOptionSelect={(_, d) => setReplacementProductId(d.optionValue || '')}>
                  {products.filter((p) => p.id !== id).map((p) => (<Option key={p.id} value={p.id}>{p.displayName}</Option>))}
                </Dropdown>
              </Field>
            </div>
            <Field label="Migration note"><Textarea value={migrationNote} onChange={(_, d) => setMigrationNote(d.value)} placeholder="How consumers should migrate." /></Field>
            <div><Button appearance="primary" onClick={deprecate} disabled={busy !== null}>{busy === 'deprecate' ? 'Deprecating…' : 'Deprecate'}</Button></div>
          </div>
        )}
      </div>
    </div>
  );
}

export default VersionsPanel;

'use client';

/**
 * UpstreamSensitivityField (F17) — read-only "Sensitivity label (source)" field.
 *
 * Shows the item's effective sensitivity label, where it was INHERITED from
 * (its upstream lineage source), and the live propagation status. The field is
 * deliberately read-only: an item's label is driven by its upstream source, and
 * raising it (override) is done from Governance → Sensitivity, which this field
 * links to. Used by the semantic-model editor (built on an upstream warehouse /
 * lakehouse) and reusable by any derived item.
 *
 * Backend: GET /api/governance/label-propagation/<itemId> (real Cosmos lineage).
 */
import { useEffect, useState } from 'react';
import {
  Badge, Caption1, Field, Input, Spinner, Link,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ShieldKeyhole20Regular } from '@fluentui/react-icons';
import { STATUS_LABEL, STATUS_COLOR, type PropagationStatus } from '@/lib/governance/label-propagation';

interface PropResp {
  ok: boolean;
  found?: boolean;
  status?: PropagationStatus;
  currentLabel?: string;
  expectedLabel?: string;
  upstream?: Array<{ id: string; label: string; displayName: string }>;
  lastRunAt?: string | null;
  error?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: '6px',
    padding: '12px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    maxWidth: '520px',
  },
  header: { display: 'flex', alignItems: 'center', gap: '8px' },
  sources: { display: 'flex', flexDirection: 'column', gap: '2px' },
});

export function UpstreamSensitivityField({ itemId }: { itemId: string }) {
  const s = useStyles();
  const [data, setData] = useState<PropResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await fetch(`/api/governance/label-propagation/${encodeURIComponent(itemId)}`);
        const j: PropResp = await r.json();
        if (cancelled) return;
        if (!j.ok) { setErr(j.error || 'failed'); return; }
        setData(j);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [itemId]);

  if (loading) return <Spinner size="tiny" label="Resolving inherited sensitivity…" />;
  if (err) return <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Could not resolve sensitivity: {err}</Caption1>;
  if (!data || data.found === false) {
    return (
      <div className={s.root}>
        <div className={s.header}>
          <ShieldKeyhole20Regular />
          <Caption1>No upstream source found in lineage — this model has no inherited sensitivity label yet.</Caption1>
        </div>
      </div>
    );
  }

  const effective = data.currentLabel || data.expectedLabel || '';
  const status = data.status as PropagationStatus;
  return (
    <div className={s.root}>
      <div className={s.header}>
        <ShieldKeyhole20Regular />
        <Field label="Sensitivity label (inherited from upstream)" style={{ flex: 1 }}>
          {/* Read-only — the label flows from the upstream source. */}
          <Input readOnly value={effective || 'Unlabeled'} contentAfter={
            status ? <Badge appearance="tint" color={STATUS_COLOR[status]} size="small">{STATUS_LABEL[status]}</Badge> : undefined
          } />
        </Field>
      </div>

      {data.upstream && data.upstream.length > 0 && (
        <div className={s.sources}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Source of the label:</Caption1>
          {data.upstream.map((u) => (
            <Caption1 key={u.id}>
              ← <strong>{u.displayName}</strong> · {u.label}
            </Caption1>
          ))}
        </div>
      )}

      {data.expectedLabel && data.currentLabel && data.expectedLabel !== data.currentLabel && status === 'pending' && (
        <Caption1 style={{ color: tokens.colorPaletteDarkOrangeForeground1 }}>
          Upstream now carries <strong>{data.expectedLabel}</strong>. Downstream propagation runs on the next
          label-propagation cycle{data.lastRunAt ? ` (last ran ${new Date(data.lastRunAt).toLocaleString()})` : ''}.
        </Caption1>
      )}

      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Labels are inherited from the upstream lineage source and propagated downstream automatically. To raise
        this item&apos;s label above its source, use <Link href="/governance/sensitivity">Governance → Sensitivity</Link>.
      </Caption1>
    </div>
  );
}

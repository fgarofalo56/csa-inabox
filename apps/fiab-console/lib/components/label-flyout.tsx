'use client';

/**
 * SensitivityLabelPane — manual sensitivity-label flyout (F12), backed by the
 * live Microsoft Graph Information Protection taxonomy and applied through
 *   GET/PUT /api/items/[type]/[id]/sensitivity-label
 *
 * One-for-one with the Office / Purview "Sensitivity" picker:
 *   - radio list of tenant labels, ordered by sensitivity (low → high),
 *   - per-label color swatch + sensitivity number,
 *   - policy-blocked labels (isAppliable === false) are greyed + disabled with
 *     a tooltip naming the restriction reason,
 *   - the currently-applied label is badged,
 *   - Apply persists to Cosmos (reflected in the catalog) + best-effort writes
 *     the label onto the item's Purview asset,
 *   - Clear removes the label.
 *
 * When the deployment hasn't wired Microsoft Graph Information Protection
 * (LOOM_MIP_ENABLED unset, or running in a Gov boundary where the API isn't
 * available), the BFF returns 503 + a structured hint and this pane renders the
 * shared NotConfiguredBar — never a fabricated label list.
 */

import { useEffect, useState } from 'react';
import {
  Button, Tooltip, Spinner, Badge, Radio, RadioGroup,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Checkmark16Filled, LockClosed16Regular } from '@fluentui/react-icons';
import { NotConfiguredBar, type NotConfiguredHint } from './admin-security/not-configured-bar';

interface Props { type: string; id: string; }

interface Label {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  tooltip?: string;
  color?: string;
  sensitivity?: number;
  isActive?: boolean;
  isAppliable?: boolean;
}

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  labelRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: 'var(--loom-space-2)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 'var(--loom-radius-md)',
  },
  labelRowCurrent: { borderColor: tokens.colorBrandStroke1, backgroundColor: tokens.colorBrandBackground2 },
  labelRowBlocked: { opacity: 0.55 },
  swatch: {
    display: 'inline-block', width: 12, height: 12, borderRadius: 3, flexShrink: 0, marginTop: 4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  labelMeta: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  labelName: { fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 },
  desc: { fontSize: 12, color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
});

export function SensitivityLabelPane({ type, id }: Props) {
  const styles = useStyles();
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ surface: string; hint?: NotConfiguredHint; rawError?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setGate(null);
    setError(null);
    try {
      const res = await fetch(`/api/items/${type}/${id}/sensitivity-label`);
      const data = await res.json().catch(() => ({}));
      if (res.status === 503 || data?.code === 'mip_not_configured') {
        setGate({
          surface: 'Microsoft Graph Information Protection (sensitivity labels)',
          hint: data?.hint,
          rawError: data?.error,
        });
        return;
      }
      if (!res.ok || !data?.ok) {
        setError(data?.error || `Failed to load labels (${res.status})`);
        return;
      }
      setLabels(data.labels || []);
      setCurrentId(data.currentLabelId ?? null);
      setCurrentName(data.currentLabelName ?? null);
      setSelected(data.currentLabelId ?? '');
    } catch (e: any) {
      setError(e?.message || 'Failed to load labels');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [type, id]);

  const apply = async () => {
    setBusy(true); setError(null); setWarn(null); setOk(null);
    try {
      const res = await fetch(`/api/items/${type}/${id}/sensitivity-label`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labelId: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 && data?.code === 'label_policy_blocked') {
        setWarn(`This label can't be applied manually: ${data.reason}`);
        return;
      }
      if (!res.ok || !data?.ok) {
        setError(data?.error || `Failed to apply label (${res.status})`);
        return;
      }
      setCurrentId(data.labelId ?? null);
      setCurrentName(data.labelName ?? null);
      const pv =
        data.purviewStatus === 'written'
          ? ' Label also written to the catalog asset in Microsoft Purview.'
          : '';
      setOk(`Label applied and persisted — it now shows in the governance catalog.${pv}`);
    } catch (e: any) {
      setError(e?.message || 'Failed to apply label');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true); setError(null); setWarn(null); setOk(null);
    try {
      const res = await fetch(`/api/items/${type}/${id}/sensitivity-label`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labelId: '' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) { setError(data?.error || `Failed to clear label (${res.status})`); return; }
      setCurrentId(null); setCurrentName(null); setSelected('');
      setOk('Sensitivity label cleared.');
    } catch (e: any) {
      setError(e?.message || 'Failed to clear label');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner size="tiny" label="Loading sensitivity labels…" />;
  if (gate) return <NotConfiguredBar surface={gate.surface} hint={gate.hint} rawError={gate.rawError}
    portalLink="https://compliance.microsoft.com/informationprotection" portalLabel="Microsoft Purview compliance portal" />;

  return (
    <div className={styles.list}>
      {currentName && (
        <Caption1 block>
          Current label: <strong>{currentName}</strong>
        </Caption1>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {warn && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Blocked by label policy</MessageBarTitle>{warn}</MessageBarBody>
        </MessageBar>
      )}
      {ok && <MessageBar intent="success"><MessageBarBody>{ok}</MessageBarBody></MessageBar>}

      {labels && labels.length === 0 && (
        <MessageBar intent="info">
          <MessageBarBody>
            No sensitivity labels are published to your tenant. Define them in the
            Microsoft Purview compliance portal under Information Protection.
          </MessageBarBody>
        </MessageBar>
      )}

      {labels && labels.length > 0 && (
        <RadioGroup value={selected} onChange={(_, d) => setSelected(d.value)}>
          {labels.map((l) => {
            const blocked = l.isAppliable === false;
            const isCurrent = l.id === currentId;
            const reason = l.tooltip || l.description || 'A label policy prevents manual application.';
            const row = (
              <div
                key={l.id}
                className={`${styles.labelRow} ${isCurrent ? styles.labelRowCurrent : ''} ${blocked ? styles.labelRowBlocked : ''}`}
              >
                <span className={styles.swatch} style={{ backgroundColor: l.color || '#8a8a8a' }} aria-hidden />
                <div className={styles.labelMeta}>
                  <span className={styles.labelName}>
                    {l.displayName || l.name || l.id}
                    {typeof l.sensitivity === 'number' && (
                      <Badge size="small" appearance="outline" color="informative">P{l.sensitivity}</Badge>
                    )}
                    {isCurrent && (
                      <Badge size="small" color="brand" icon={<Checkmark16Filled />}>Applied</Badge>
                    )}
                    {blocked && (
                      <Badge size="small" color="subtle" icon={<LockClosed16Regular />}>Policy-blocked</Badge>
                    )}
                  </span>
                  <Radio
                    value={l.id}
                    disabled={blocked}
                    label={l.description || l.tooltip || 'Select this label'}
                  />
                </div>
              </div>
            );
            return blocked
              ? <Tooltip key={l.id} content={reason} relationship="description">{row}</Tooltip>
              : row;
          })}
        </RadioGroup>
      )}

      <div className={styles.actions}>
        <Button appearance="primary" onClick={apply}
          disabled={busy || !selected || selected === currentId}>
          {busy ? 'Applying…' : 'Apply label'}
        </Button>
        {currentId && (
          <Button appearance="subtle" onClick={clear} disabled={busy}>
            Clear label
          </Button>
        )}
      </div>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
        Taxonomy is read live from Microsoft Graph Information Protection. Applying
        a label updates this item in the governance catalog and, when the item is
        cataloged in Microsoft Purview, stamps the label onto its asset.
      </Caption1>
    </div>
  );
}

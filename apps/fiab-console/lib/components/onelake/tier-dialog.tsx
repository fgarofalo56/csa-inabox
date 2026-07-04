'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * TierDialog — change the OneLake / ADLS Gen2 access tier of a single blob.
 *
 * Three tiers: Hot / Cool / Cold (Archive is read-only here — rehydration takes
 * hours and is handled outside the browser). The dialog:
 *   - fetches the current tier live from GET /api/onelake/tier on open;
 *   - offers a RadioGroup of Hot / Cool / Cold;
 *   - shows an early-deletion-penalty MessageBar when downgrading
 *     (Cool min 30 d, Cold min 90 d);
 *   - shows a Copy-Blob notice when upgrading from a cooler tier;
 *   - PUTs the change and reports the real method used (set | copy).
 *
 * No mock data, no Fabric dependency — backed by the Azure blob data-plane in
 * adls-client.ts. The OneLake-native tier surface in Fabric is preview, so the
 * dialog title carries a "preview" badge per the honesty rules.
 */

import { useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Spinner, Badge,
  RadioGroup, Radio, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';

const TIER_COLORS = {
  Hot: 'brand',
  Cool: 'informative',
  Cold: 'subtle',
  Archive: 'warning',
} as const;

const DOWNGRADE_WARNING: Record<string, string> = {
  Cool: 'Moving to Cool tier — a minimum 30-day retention period applies. Deleting or re-tiering this file before 30 days incurs an early-deletion charge prorated at the Cool storage rate.',
  Cold: 'Moving to Cold tier — a minimum 90-day retention period applies. Deleting or re-tiering this file before 90 days incurs an early-deletion charge prorated at the Cold storage rate.',
};

const UPGRADE_WARNING =
  'Moving to a warmer tier uses Copy Blob (not Set Blob Tier). A temporary second copy is created in Hot tier while the source blob is deleted and renamed. If the source is still below its minimum retention (Cool < 30 d, Cold < 90 d), an early-deletion charge applies to the source.';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '440px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
});

export type BlobAccessTier = 'Hot' | 'Cool' | 'Cold';

interface TierDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  container: string;
  /** Full blob path within the container (e.g. "Files/data/x.parquet"). */
  path: string;
  /** Called with the new tier after a successful change. */
  onTierChanged?: (newTier: BlobAccessTier) => void;
}

function tierOrder(t: string): number {
  return t === 'Hot' ? 2 : t === 'Cool' ? 1 : t === 'Cold' ? 0 : -1;
}

export function TierDialog({ open, onOpenChange, container, path, onTierChanged }: TierDialogProps) {
  const s = useStyles();
  const [currentTier, setCurrentTier] = useState<BlobAccessTier | 'Archive' | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<BlobAccessTier>('Hot');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Fetch the current tier whenever the dialog opens for a file.
  useEffect(() => {
    if (!open || !container || !path) return;
    setCurrentTier(null);
    setLoadError(null);
    setResult(null);
    setLoading(true);
    clientFetch(`/api/onelake/tier?container=${encodeURIComponent(container)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.tier) {
          setCurrentTier(j.tier);
          if (['Hot', 'Cool', 'Cold'].includes(j.tier)) setSelectedTier(j.tier as BlobAccessTier);
        } else {
          setLoadError(j.error || 'Could not read the current tier.');
        }
      })
      .catch((e) => setLoadError(String(e)))
      .finally(() => setLoading(false));
  }, [open, container, path]);

  const isArchive = currentTier === 'Archive';
  const isDowngrade = !!currentTier && tierOrder(selectedTier) < tierOrder(currentTier);
  const isUpgrade = !!currentTier && tierOrder(selectedTier) > tierOrder(currentTier);
  const isSame = currentTier === selectedTier;

  const submit = async () => {
    if (!container || !path || isSame || isArchive) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await clientFetch('/api/onelake/tier', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ container, path, tier: selectedTier }),
      });
      const j = await r.json();
      if (!j.ok) {
        setResult({ ok: false, message: j.error || `HTTP ${r.status}` });
      } else {
        setResult({
          ok: true,
          message: `Tier changed to ${selectedTier} at ${new Date().toLocaleTimeString()} (method: ${j.method}).`,
        });
        setCurrentTier(selectedTier);
        onTierChanged?.(selectedTier);
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!busy) onOpenChange(d.open); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            Change storage tier{' '}
            <Badge appearance="outline" size="small" color="warning">preview</Badge>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.row}>
                <span>Current tier:</span>
                {loading && <Spinner size="tiny" />}
                {!loading && currentTier && (
                  <Badge appearance="tint" color={TIER_COLORS[currentTier as keyof typeof TIER_COLORS] ?? 'subtle'}>
                    {currentTier}
                  </Badge>
                )}
                {!loading && loadError && (
                  <span style={{ color: tokens.colorPaletteRedForeground1 }}>{loadError}</span>
                )}
              </div>

              {isArchive && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Archive tier</MessageBarTitle>
                    This file is in the Archive tier. Rehydrating it to Hot, Cool, or Cold can take
                    several hours and is not supported from this dialog.
                  </MessageBarBody>
                </MessageBar>
              )}

              <Field label="Select new tier" required>
                <RadioGroup
                  value={selectedTier}
                  onChange={(_, d) => { setSelectedTier(d.value as BlobAccessTier); setResult(null); }}
                  disabled={loading || busy || isArchive}
                >
                  <Radio value="Hot" label="Hot — highest storage cost, lowest access cost; no minimum retention" />
                  <Radio value="Cool" label="Cool — lower storage cost; 30-day minimum retention" />
                  <Radio value="Cold" label="Cold — lowest online storage cost; 90-day minimum retention" />
                </RadioGroup>
              </Field>

              {!isArchive && isDowngrade && DOWNGRADE_WARNING[selectedTier] && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Early-deletion penalty applies</MessageBarTitle>
                    {DOWNGRADE_WARNING[selectedTier]}
                  </MessageBarBody>
                </MessageBar>
              )}

              {!isArchive && isUpgrade && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Copy Blob used for upgrade</MessageBarTitle>
                    {UPGRADE_WARNING}
                  </MessageBarBody>
                </MessageBar>
              )}

              {result && (
                <MessageBar intent={result.ok ? 'success' : 'error'}>
                  <MessageBarBody>{result.message}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="subtle" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              appearance="primary"
              disabled={busy || loading || !!loadError || isSame || isArchive}
              onClick={submit}
            >
              {busy ? <Spinner size="tiny" /> : `Set to ${selectedTier}`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

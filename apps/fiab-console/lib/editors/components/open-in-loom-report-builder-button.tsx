'use client';

/**
 * OpenInLoomReportBuilderButton — operator review 5.3: the sibling of
 * "Open in Power BI Desktop" (.pbids). One click creates a DRAFT Loom `report`
 * item PRE-BOUND to this data source (POST /api/thread/open-in-report-builder,
 * which resolves the Azure-native backend via the same coordinate resolver the
 * Weave → Power BI edge uses) and navigates straight into the Loom-native
 * report designer — real data, NO Power BI / Fabric workspace required
 * (no-fabric-dependency.md).
 *
 * When the backend isn't resolvable the route returns an honest gate naming
 * the exact env var / remediation, surfaced here as a Fluent MessageBar
 * (no-vaporware.md). Fluent v9 + Loom tokens only (web3-ui.md); it is a
 * button — no config typing (loom_no_freeform_config).
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Tooltip, Spinner,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  type ButtonProps,
} from '@fluentui/react-components';
import { DataBarVerticalAdd20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

/** Loom item types the report-builder deep-link supports (route SOURCE_TYPES). */
export type ReportBuilderSourceType =
  | 'lakehouse' | 'warehouse' | 'semantic-model' | 'kql-database'
  | 'mirrored-database' | 'eventhouse' | 'synapse-dedicated-sql-pool'
  | 'synapse-serverless-sql-pool' | 'dataset';

interface Props {
  type: ReportBuilderSourceType;
  id: string;
  /** Item display name — seeds the draft report's name. */
  name?: string;
  size?: ButtonProps['size'];
  appearance?: ButtonProps['appearance'];
}

const TOOLTIP =
  'Creates a draft Loom report pre-bound to this data source and opens the report builder — Azure-native, no Power BI workspace needed';

export function OpenInLoomReportBuilderButton({ type, id, name, size = 'small', appearance = 'outline' }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ error: string } | null>(null);
  const disabled = !id || id === 'new';

  const onClick = useCallback(async () => {
    if (disabled) return;
    setBusy(true);
    setGate(null);
    try {
      const res = await clientFetch('/api/thread/open-in-report-builder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: { id, type, name } }),
      });
      const j: any = await res.json().catch(() => null);
      if (!res.ok || !j?.ok || !j?.link) {
        setGate({ error: j?.error || `Could not create the draft report (HTTP ${res.status}).` });
        return;
      }
      router.push(String(j.link));
    } catch (e: any) {
      setGate({ error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [disabled, id, type, name, router]);

  return (
    <>
      <Tooltip content={TOOLTIP} relationship="label">
        <Button
          appearance={appearance}
          size={size}
          icon={busy ? <Spinner size="tiny" /> : <DataBarVerticalAdd20Regular />}
          onClick={onClick}
          disabled={disabled || busy}
          title={disabled ? 'Save the item first' : undefined}
        >
          {busy ? 'Opening report builder…' : 'Open in Loom report builder'}
        </Button>
      </Tooltip>
      <Dialog open={!!gate} onOpenChange={(_, d) => { if (!d.open) setGate(null); }}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>Open in Loom report builder</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Could not pre-bind a report to this source</MessageBarTitle>
                  {gate?.error}
                </MessageBarBody>
              </MessageBar>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setGate(null)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

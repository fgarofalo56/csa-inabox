'use client';

/**
 * OpenInPbiDesktopButton — one-click "Open in Power BI Desktop" for a Loom
 * Azure-native data source. GETs the item's `/pbids` route, which returns a
 * valid Power BI Desktop connection file (.pbids) targeting the item's surfaced
 * Azure endpoint (Synapse SQL / Azure SQL via TDS, Azure Analysis Services, or
 * Azure Data Explorer), and triggers a browser download. Opening the file
 * launches Power BI Desktop already connected — NO Microsoft Fabric / Power BI
 * workspace required (per no-fabric-dependency.md).
 *
 * This is deliberately DISTINCT from the opt-in Power-BI-service "Open in Power
 * BI" (webUrl) buttons — the label + tooltip make the difference obvious. When
 * the endpoint isn't resolvable the route returns an honest 412 gate, surfaced
 * here as a Fluent MessageBar naming the missing endpoint/env (no-vaporware.md).
 *
 * Fluent v9 + Loom tokens only (web3-ui.md); it is a button — no config typing
 * (loom_no_freeform_config).
 */

import { useCallback, useState } from 'react';
import {
  Button, Tooltip, Spinner,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  type ButtonProps,
} from '@fluentui/react-components';
import { ArrowDownload20Regular } from '@fluentui/react-icons';

/** Loom item types that expose a .pbids bridge. */
export type PbidsButtonType =
  | 'lakehouse' | 'warehouse' | 'semantic-model' | 'kql-database'
  | 'sql-database' | 'mirrored-database' | 'eventhouse';

interface Props {
  type: PbidsButtonType;
  id: string;
  /** Item display name — used for the download filename fallback only. */
  name?: string;
  /** Optional default connectivity mode (tds + adx honor it; AS ignores it). */
  mode?: 'import' | 'directQuery';
  size?: ButtonProps['size'];
  appearance?: ButtonProps['appearance'];
}

const TOOLTIP =
  'Downloads a .pbids that opens this data source in Power BI Desktop — Azure-native, no Power BI workspace needed';

export function OpenInPbiDesktopButton({ type, id, name, mode, size = 'small', appearance = 'outline' }: Props) {
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ missing?: string; error: string } | null>(null);
  const disabled = !id || id === 'new';

  const onClick = useCallback(async () => {
    if (disabled) return;
    setBusy(true);
    setGate(null);
    try {
      const url = `/api/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/pbids${mode ? `?mode=${mode}` : ''}`;
      const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!res.ok) {
        let j: any = null;
        try { j = await res.json(); } catch { /* non-JSON error */ }
        setGate({ missing: j?.missing, error: j?.error || `Could not generate the .pbids (HTTP ${res.status}).` });
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const filename = m?.[1] || `${(name || type).replace(/[^A-Za-z0-9._-]+/g, '-')}.pbids`;
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e: any) {
      setGate({ error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [disabled, type, id, name, mode]);

  return (
    <>
      <Tooltip content={TOOLTIP} relationship="label">
        <Button
          appearance={appearance}
          size={size}
          icon={busy ? <Spinner size="tiny" /> : <ArrowDownload20Regular />}
          onClick={onClick}
          disabled={disabled || busy}
          title={disabled ? 'Save the item first' : undefined}
        >
          Open in Power BI Desktop
        </Button>
      </Tooltip>
      <Dialog open={!!gate} onOpenChange={(_, d) => { if (!d.open) setGate(null); }}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>Open in Power BI Desktop</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>
                    {gate?.missing ? `Endpoint not resolvable — ${gate.missing}` : 'Could not generate the connection file'}
                  </MessageBarTitle>
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

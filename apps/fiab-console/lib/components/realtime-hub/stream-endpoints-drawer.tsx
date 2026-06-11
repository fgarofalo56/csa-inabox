'use client';

/**
 * StreamEndpointsDrawer — Fabric Real-Time hub eventstream "Endpoints" / source
 * & destination connection details. Pulls the live connection endpoints from
 * the eventstream definition (sources, destinations, streams) via the real BFF
 * route GET /api/realtime-hub/endpoints.
 *
 * Shared by both real-time surfaces (/realtime-hub and /rti-hub) so the
 * Endpoints affordance has ONE implementation. Read-only — projects the item's
 * state.definition, no mutation.
 */

import { useEffect, useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Badge, Spinner, Body1, Subtitle2, Caption1, MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  card: { marginTop: tokens.spacingVerticalM, padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  head: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  kv: { fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: tokens.spacingVerticalS },
});

interface EndpointRow { name: string; role: string; type?: string; properties?: Record<string, unknown>; }

export interface StreamEndpointsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Eventstream display name (drawer title). */
  name: string;
  workspaceId: string;
  eventstreamId: string;
}

export function StreamEndpointsDrawer({ open, onClose, name, workspaceId, eventstreamId }: StreamEndpointsDrawerProps) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRow[] | null>(null);

  useEffect(() => {
    if (!open || !eventstreamId) return;
    let cancelled = false;
    setBusy(true); setErr(null); setEndpoints(null);
    fetch(`/api/realtime-hub/endpoints?workspaceId=${encodeURIComponent(workspaceId)}&eventstreamId=${encodeURIComponent(eventstreamId)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !j.ok) { setErr(j.error || `Failed (HTTP ${r.status}).`); return; }
        setEndpoints(j.endpoints || []);
      })
      .catch((e) => { if (!cancelled) setErr(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, workspaceId, eventstreamId]);

  return (
    <Drawer open={open} position="end" size="medium" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={onClose} aria-label="Close endpoints" />}>
          Endpoints — {name}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <Caption1>Live connection endpoints pulled from the eventstream definition (sources, destinations, streams).</Caption1>
        {busy && <Spinner label="Pulling definition…" style={{ marginTop: 12 }} />}
        {err && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {endpoints && endpoints.length === 0 && <Body1 style={{ marginTop: 12 }}>No endpoints in this eventstream yet — open the editor to add sources and destinations.</Body1>}
        {endpoints && endpoints.map((ep, i) => (
          <div key={i} className={styles.card}>
            <div className={styles.head}>
              <Subtitle2>{ep.name}</Subtitle2>
              <Badge appearance="outline" size="small">{ep.role}</Badge>
              {ep.type && <Badge appearance="tint" size="small">{ep.type}</Badge>}
            </div>
            {ep.properties && Object.keys(ep.properties).length > 0 && (
              <pre className={styles.kv}>{JSON.stringify(ep.properties, null, 2)}</pre>
            )}
          </div>
        ))}
      </DrawerBody>
    </Drawer>
  );
}

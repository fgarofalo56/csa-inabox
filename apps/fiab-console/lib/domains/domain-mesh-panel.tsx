'use client';

/**
 * DomainMeshPanel — the /admin/domains "Federated data-mesh" panel (issue #1483
 * Wave 4). Reads GET /api/admin/domains/mesh and renders every Loom domain's
 * ROLLED-UP footprint across the governance mesh: catalog (workspaces + items in
 * the domain's subtree), the Purview Data Map collection, the Unity Catalog
 * catalog/schema, and the DLZ landing-zone binding.
 *
 * This is the READ face of the mesh; the "Governance sync" panel above it is the
 * WRITE face (reconcile domains → Purview/UC). Every surface is honest-gated: an
 * unconfigured back-end shows a MessageBar naming the exact remediation, never a
 * fabricated number (no-vaporware.md). Web-3.0 look: Fluent v9 + Loom tokens,
 * elevation cards, TileGrid-style surface tiles, no raw px (web3-ui.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Card, Badge, Button, Caption1, Subtitle2, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, CheckmarkCircle16Filled, Warning16Filled,
  DatabaseLink20Regular, CloudDatabase20Regular, Apps20Regular, Flowchart20Regular,
} from '@fluentui/react-icons';

interface MeshSurface { configured: boolean; present: boolean; target?: string; hint?: string; }
interface MeshRow {
  id: string; name: string; parentId?: string; depth: number;
  directWorkspaces: number; rolledWorkspaces: number; rolledItems: number;
  purview: MeshSurface; unity: MeshSurface; lineage: MeshSurface;
  landingZone: { status: string; subscriptions: number };
}
interface MeshResult {
  ranAt: string; domainCount: number;
  surfaces: {
    catalog: { configured: boolean; workspaces: number; items: number; hint?: string };
    purview: { configured: boolean; hint?: string };
    unity: { configured: boolean; hint?: string };
    lineage: { configured: boolean; sources: string[]; hint?: string };
  };
  rows: MeshRow[];
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tileGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: tokens.spacingHorizontalM,
  },
  tile: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalL },
  tileHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  tileIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  metrics: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  ran: { color: tokens.colorNeutralForeground3 },
  matrix: {
    display: 'flex', flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden',
  },
  head: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 1.3fr) minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1.1fr)',
    gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    fontWeight: tokens.fontWeightSemibold, backgroundColor: tokens.colorNeutralBackground2, fontSize: tokens.fontSizeBase200,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 1.3fr) minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1.1fr)',
    gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`, fontSize: tokens.fontSizeBase200,
  },
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, overflowWrap: 'anywhere' },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
});

function SurfaceBadge({ surface, presentLabel }: { surface: MeshSurface; presentLabel: string }) {
  if (!surface.configured) return <Badge color="subtle" appearance="tint">Not configured</Badge>;
  if (!surface.present) return <Badge color="warning" appearance="tint" icon={<Warning16Filled />}>To sync</Badge>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <Badge color="success" appearance="tint" icon={<CheckmarkCircle16Filled />}>{presentLabel}</Badge>
    </span>
  );
}

export function DomainMeshPanel() {
  const s = useStyles();
  const [mesh, setMesh] = useState<MeshResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/domains/mesh', undefined, 30000);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setMesh(j.mesh);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading && !mesh) return <Spinner label="Reading the federated mesh…" />;

  return (
    <div className={s.root}>
      <div className={s.actions}>
        <Caption1 className={s.ran}>
          {mesh ? `${mesh.domainCount} domains across the mesh · read ${new Date(mesh.ranAt).toLocaleTimeString()}` : ''}
        </Caption1>
        <Button size="small" icon={<ArrowSync20Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not read the mesh</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {mesh && (
        <>
          {/* Surface tiles — the mesh fabric at a glance. */}
          <div className={s.tileGrid}>
            <Card className={s.tile}>
              <div className={s.tileHead}>
                <Apps20Regular className={s.tileIcon} />
                <Subtitle2>Unified catalog</Subtitle2>
                <Badge color={mesh.surfaces.catalog.configured ? 'success' : 'subtle'} appearance="tint">
                  {mesh.surfaces.catalog.configured ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <div className={s.metrics}>
                <Badge appearance="outline">{mesh.surfaces.catalog.workspaces} workspaces</Badge>
                <Badge appearance="outline">{mesh.surfaces.catalog.items} items</Badge>
              </div>
              <Caption1 className={s.ran}>Workspaces + data items federated by domain (subtree rollup).</Caption1>
            </Card>

            <Card className={s.tile}>
              <div className={s.tileHead}>
                <CloudDatabase20Regular className={s.tileIcon} />
                <Subtitle2>Microsoft Purview</Subtitle2>
                <Badge color={mesh.surfaces.purview.configured ? 'success' : 'subtle'} appearance="tint">
                  {mesh.surfaces.purview.configured ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              {mesh.surfaces.purview.configured
                ? <Caption1 className={s.ran}>Domains mirror to Data Map collections.</Caption1>
                : <Caption1 className={s.ran}>{mesh.surfaces.purview.hint}</Caption1>}
            </Card>

            <Card className={s.tile}>
              <div className={s.tileHead}>
                <DatabaseLink20Regular className={s.tileIcon} />
                <Subtitle2>Unity Catalog</Subtitle2>
                <Badge color={mesh.surfaces.unity.configured ? 'success' : 'subtle'} appearance="tint">
                  {mesh.surfaces.unity.configured ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              {mesh.surfaces.unity.configured
                ? <Caption1 className={s.ran}>Root domains → catalogs, descendants → schemas.</Caption1>
                : <Caption1 className={s.ran}>{mesh.surfaces.unity.hint}</Caption1>}
            </Card>

            <Card className={s.tile}>
              <div className={s.tileHead}>
                <Flowchart20Regular className={s.tileIcon} />
                <Subtitle2>Lineage</Subtitle2>
                <Badge color={mesh.surfaces.lineage.configured ? 'success' : 'subtle'} appearance="tint">
                  {mesh.surfaces.lineage.configured ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              {mesh.surfaces.lineage.configured
                ? <Caption1 className={s.ran}>Assets traced via {mesh.surfaces.lineage.sources.join(' + ')}.</Caption1>
                : <Caption1 className={s.ran}>{mesh.surfaces.lineage.hint}</Caption1>}
            </Card>
          </div>

          {/* Honest gates for any unconfigured mesh surface. */}
          {!mesh.surfaces.purview.configured && mesh.surfaces.purview.hint && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody><MessageBarTitle>Purview mirror inactive</MessageBarTitle>{mesh.surfaces.purview.hint}</MessageBarBody>
            </MessageBar>
          )}
          {!mesh.surfaces.unity.configured && mesh.surfaces.unity.hint && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody><MessageBarTitle>Unity Catalog mirror inactive</MessageBarTitle>{mesh.surfaces.unity.hint}</MessageBarBody>
            </MessageBar>
          )}

          {/* Per-domain federated footprint. */}
          <div className={s.matrix} role="table" aria-label="Federated mesh footprint by domain">
            <div className={s.head} role="row">
              <span role="columnheader">Domain</span>
              <span role="columnheader">Catalog</span>
              <span role="columnheader">Purview</span>
              <span role="columnheader">Unity Catalog</span>
              <span role="columnheader">Lineage</span>
              <span role="columnheader">Landing zone</span>
            </div>
            {mesh.rows.map((r) => (
              <div key={r.id} className={s.row} role="row">
                <span className={s.nameCell} role="cell">
                  <Badge appearance="tint" size="small">L{r.depth}</Badge>
                  <strong>{r.name}</strong>
                  {r.parentId && <Badge appearance="outline" size="small">sub</Badge>}
                </span>
                <span role="cell">
                  <Badge appearance="outline" color={r.rolledWorkspaces ? 'brand' : 'subtle'}>
                    {r.rolledWorkspaces} ws
                  </Badge>{' '}
                  <Badge appearance="outline" color={r.rolledItems ? 'brand' : 'subtle'}>
                    {r.rolledItems} items
                  </Badge>
                </span>
                <span role="cell"><SurfaceBadge surface={r.purview} presentLabel="Collection" /></span>
                <span role="cell">
                  <SurfaceBadge surface={r.unity} presentLabel="Linked" />
                  {r.unity.configured && r.unity.target && (
                    <div className={s.mono}>{r.unity.target}</div>
                  )}
                </span>
                <span role="cell"><SurfaceBadge surface={r.lineage} presentLabel="Traceable" /></span>
                <span role="cell">
                  <Badge
                    appearance="tint"
                    color={r.landingZone.status === 'active' ? 'success' : r.landingZone.status === 'error' ? 'danger' : 'subtle'}
                  >
                    {r.landingZone.status}
                  </Badge>
                  {r.landingZone.subscriptions > 0 && (
                    <Caption1 className={s.ran}> {r.landingZone.subscriptions} sub{r.landingZone.subscriptions === 1 ? '' : 's'}</Caption1>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default DomainMeshPanel;

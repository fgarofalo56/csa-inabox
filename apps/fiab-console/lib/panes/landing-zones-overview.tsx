'use client';

/**
 * Data Landing Zone overview & management (item-3).
 *
 * The surface an operator lands on for "see + manage all my DLZs". It is the
 * Overview half of the landing-zones experience; the "Add a landing zone" form
 * (AddLandingZoneWizardPane) is the Attach half. Both live under
 * /admin/landing-zones as tabs.
 *
 * Everything is real (no-vaporware): GET /api/setup/landing-zones returns the
 * deployed hub + every DLZ resource group Azure Resource Graph can see, with a
 * live attach state derived from the Console's write permission on each sub.
 *
 *   - Visualize : hub-and-spoke React-Flow map (LandingZonesCanvas).
 *   - List      : a table of every DLZ (domain, region, subscription, RG, state).
 *   - Per-DLZ   : View details (drawer), Scale (→ /admin/scaling), Deploy more
 *                 (→ Attach tab), Re-attach/repair (→ Attach tab, for detached).
 *
 * Detached DLZs (cross-sub, Console has Reader-only) get an honest banner with
 * the exact `az role assignment create` to grant Contributor so the Console can
 * manage them — the same gate the deploy route returns (item-4).
 */

import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, mergeClasses,
  Title3, Subtitle2, Body1, Body1Strong, Caption1,
  Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Button, Badge, Divider, Link,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular, Dismiss24Regular, Open16Regular,
  GaugeRegular, Add16Regular, Wrench16Regular, Building24Regular,
} from '@fluentui/react-icons';
import { LandingZonesCanvas } from './landing-zones-canvas';
import type { LandingZone, HubCoords, DlzAttachState } from '@/lib/setup/landing-zones-model';

interface Overview {
  ok: boolean;
  hub: HubCoords | null;
  hubExists: boolean;
  landingZones: LandingZone[];
  error?: string;
  hint?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalXL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  hubRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  mono: { fontFamily: 'Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
  actionsCell: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  detailRow: { marginBottom: '10px' },
  preWrap: { whiteSpace: 'pre-wrap' },
  summary: { color: tokens.colorNeutralForeground3 },
});

function stateBadge(s: DlzAttachState): React.ReactElement {
  switch (s) {
    case 'attached':
      return <Badge appearance="tint" color="success">Attached</Badge>;
    case 'detached':
      return <Badge appearance="tint" color="warning">Needs repair</Badge>;
    default:
      return <Badge appearance="tint" color="informative">Unknown</Badge>;
  }
}

/** Result of POST /api/setup/landing-zones/grant. */
interface GrantResult {
  ok: boolean;
  error?: string;
  reason?: string;
  remediation?: string;
  commands?: string[];
  outcomes?: Array<{ role: string; status: string; error?: string }>;
}

export function LandingZonesOverviewPane({ onAttach }: { onAttach?: () => void }): React.ReactElement {
  const styles = useStyles();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<LandingZone | null>(null);
  const [granting, setGranting] = useState(false);
  const [grant, setGrant] = useState<GrantResult | null>(null);

  // Auto-set the Console UAMI's least-privilege RBAC on the selected DLZ's
  // resource group (real ARM via the grant route). On success the DLZ flips to
  // 'attached' on the next load; on an honest gate the route returns the exact
  // RG-scoped `az` command, which we render in the drawer (no raw error).
  const repair = useCallback(async (zone: LandingZone) => {
    setGranting(true);
    setGrant(null);
    try {
      const res = await fetch('/api/setup/landing-zones/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: zone.subscriptionId, resourceGroup: zone.rg }),
      });
      const j = (await res.json().catch(() => ({}))) as GrantResult;
      setGrant({ ...j, ok: res.ok && !!j.ok });
    } catch (e) {
      setGrant({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setGranting(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/setup/landing-zones');
      const j = (await res.json().catch(() => ({}))) as Overview;
      setData(res.ok ? j : { ...j, ok: false });
    } catch (e) {
      setData({ ok: false, hub: null, hubExists: false, landingZones: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner label="Reading the hub and its Data Landing Zones from Azure…" />;

  if (!data || !data.ok) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Could not load landing zones</MessageBarTitle>
          <div className={styles.preWrap}>{data?.error || 'Unknown error.'}{data?.hint ? `\n\n${data.hint}` : ''}</div>
        </MessageBarBody>
      </MessageBar>
    );
  }

  if (!data.hubExists) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>No hub is deployed yet</MessageBarTitle>
          Data Landing Zones attach to a deployed CSA Loom hub. Install the Admin Plane with the
          first-run <Link href="/setup">Setup Wizard</Link>, then attach landing zones here.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const zones = data.landingZones;
  const detached = zones.filter((z) => z.attachState === 'detached');

  return (
    <div className={styles.root}>
      {/* Hub summary */}
      <div className={styles.card}>
        <div className={styles.hubRow}>
          <Building24Regular />
          <div style={{ minWidth: 0 }}>
            <Body1Strong>CSA Loom hub</Body1Strong>
            <div>
              <Caption1 className={styles.summary}>
                {data.hub?.boundary || '—'} · {data.hub?.location || '—'} · hub sub{' '}
                <span className={styles.mono}>{data.hub?.hubSubscriptionId || '—'}</span>
              </Caption1>
            </div>
          </div>
        </div>
        <Caption1 className={styles.summary}>
          {zones.length} Data Landing Zone{zones.length === 1 ? '' : 's'} attached
          {zones.some((z) => z.crossSubscription) ? ` · ${zones.filter((z) => z.crossSubscription).length} cross-subscription` : ''}
        </Caption1>
      </div>

      {detached.length > 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{detached.length} landing zone{detached.length === 1 ? '' : 's'} need re-attach / RBAC repair</MessageBarTitle>
            The Console identity has only Reader on these DLZs&apos; resource group(s), so it cannot
            manage them. Grant it Contributor scoped to the DLZ resource group (least-privilege —
            no subscription-wide grant needed) to re-attach, then Refresh. Select a zone below for
            the exact command.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Visual map */}
      <div className={styles.card}>
        <div className={styles.head}>
          <Subtitle2>Landing zone map</Subtitle2>
          <div className={styles.actionsCell}>
            <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={() => void load()}>Refresh</Button>
            {onAttach && <Button appearance="primary" icon={<Add16Regular />} onClick={onAttach}>Add a landing zone</Button>}
          </div>
        </div>
        <LandingZonesCanvas hub={data.hub} zones={zones} onSelect={setSelected} />
      </div>

      {/* Table */}
      <div className={styles.card}>
        <Subtitle2>All Data Landing Zones</Subtitle2>
        {zones.length === 0 ? (
          <Body1 className={styles.summary}>None attached yet. Use “Add a landing zone” to attach the first one.</Body1>
        ) : (
          <Table aria-label="Data Landing Zones" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Region</TableHeaderCell>
                <TableHeaderCell>Subscription</TableHeaderCell>
                <TableHeaderCell>Resource group</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zones.map((z) => (
                <TableRow key={z.id}>
                  <TableCell><Body1Strong>{z.domainName}</Body1Strong>{z.crossSubscription && <> <Badge appearance="outline" size="small">cross-sub</Badge></>}</TableCell>
                  <TableCell>{z.region}</TableCell>
                  <TableCell><span className={styles.mono}>{z.subscriptionId}</span></TableCell>
                  <TableCell><span className={styles.mono}>{z.rg}</span></TableCell>
                  <TableCell>{stateBadge(z.attachState)}</TableCell>
                  <TableCell>
                    <div className={styles.actionsCell}>
                      <Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => setSelected(z)}>Details</Button>
                      <Button as="a" href="/admin/scaling" size="small" appearance="subtle" icon={<GaugeRegular />}>Scale</Button>
                      {z.attachState === 'detached' ? (
                        <Button size="small" appearance="subtle" icon={<Wrench16Regular />} onClick={() => setSelected(z)}>Repair</Button>
                      ) : (
                        onAttach && <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={onAttach}>Deploy more</Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Detail / repair drawer */}
      <OverlayDrawer position="end" open={selected != null} onOpenChange={(_, d) => { if (!d.open) { setSelected(null); setGrant(null); } }} size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={() => setSelected(null)} />}>
            {selected?.domainName || ''}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {selected && (
            <div>
              <div className={styles.detailRow}><Body1Strong>State</Body1Strong><br />{stateBadge(selected.attachState)}</div>
              <div className={styles.detailRow}><Body1Strong>Region</Body1Strong><br />{selected.region}</div>
              <div className={styles.detailRow}><Body1Strong>Subscription</Body1Strong><br /><span className={styles.mono}>{selected.subscriptionId}</span>{selected.crossSubscription && <> <Badge appearance="outline" size="small">cross-subscription</Badge></>}</div>
              <div className={styles.detailRow}><Body1Strong>Resource group</Body1Strong><br /><span className={styles.mono}>{selected.rg}</span></div>
              <Divider style={{ margin: '12px 0' }} />
              <div className={styles.actionsCell} style={{ marginBottom: tokens.spacingVerticalM }}>
                <Button as="a" href="/admin/scaling" size="small" icon={<GaugeRegular />}>Scale this DLZ’s compute</Button>
                {onAttach && <Button size="small" icon={<Add16Regular />} onClick={() => { setSelected(null); onAttach(); }}>Deploy more resources</Button>}
              </div>
              {selected.attachState === 'detached' && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Re-attach / RBAC repair</MessageBarTitle>
                    The Console identity has only Reader on this landing zone&apos;s resource group.
                    Click <b>Grant RBAC</b> to set the least-privilege roles automatically — the
                    Console assigns itself Contributor (+ the minimal data-plane roles) scoped to the
                    DLZ resource group, in its own subscription (no subscription-wide grant). Then
                    Refresh.
                    <div style={{ marginTop: tokens.spacingVerticalMNudge }}>
                      <Button
                        appearance="primary"
                        size="small"
                        icon={granting ? <Spinner size="tiny" /> : <Wrench16Regular />}
                        disabled={granting}
                        onClick={() => void repair(selected)}
                      >
                        {granting ? 'Granting…' : 'Grant RBAC'}
                      </Button>
                    </div>
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Grant outcome — success, or the honest copy-paste gate when the
                  Console UAMI itself cannot write role assignments on the RG. */}
              {grant && grant.ok && (
                <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                  <MessageBarBody>
                    <MessageBarTitle>RBAC granted</MessageBarTitle>
                    The Console now holds the least-privilege role set on this landing zone&apos;s
                    resource group. Refresh to see it as <b>Attached</b>.
                    <div style={{ marginTop: tokens.spacingVerticalMNudge }}>
                      <Button appearance="primary" size="small" icon={<ArrowClockwise20Regular />} onClick={() => { setGrant(null); setSelected(null); void load(); }}>
                        Refresh
                      </Button>
                    </div>
                  </MessageBarBody>
                </MessageBar>
              )}
              {grant && !grant.ok && (
                <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM }}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {grant.commands?.length ? 'Run this grant as an operator with RBAC rights' : 'Could not grant RBAC'}
                    </MessageBarTitle>
                    <div className={styles.preWrap}>{grant.remediation || grant.error || 'Unknown error.'}</div>
                    {grant.commands?.length ? (
                      <pre className={mergeClasses(styles.mono, styles.preWrap)} style={{ marginTop: tokens.spacingVerticalS, maxHeight: 240, maxWidth: '100%', overflow: 'auto', overflowWrap: 'anywhere' }}>{grant.commands.join('\n')}</pre>
                    ) : null}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          )}
        </DrawerBody>
      </OverlayDrawer>
    </div>
  );
}

export default LandingZonesOverviewPane;

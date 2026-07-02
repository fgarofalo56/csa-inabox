'use client';

/**
 * GovernOwnerPane — data-owner ("My items") view of the Govern tab (F3).
 *
 * Parity: Fabric OneLake Catalog → Govern → data-owner scope.
 * Source: https://learn.microsoft.com/fabric/governance/onelake-catalog-govern
 *
 * Behaviour modelled 1:1 on Fabric's data-owner Govern experience:
 *   - Scoped to the signed-in user's items ("My items"), never tenant-wide.
 *   - Refresh fires on tab-open (POST /api/governance/govern/refresh) AND via a
 *     manual Refresh button — matching Fabric's on-open refresh cadence.
 *   - Smaller insight cards: inventory, label coverage, curation state.
 *   - Owner-scoped recommended-action cards (items missing label / description /
 *     endorsement) with deep links into the item editor.
 *   - Copilot CTA → opens the shared Loom Copilot rail (AOAI-backed).
 *
 * Owner scope is derived server-side from the session cookie; this component
 * never sends an owner id. See app/api/governance/govern/owner/route.ts for the
 * structural cross-owner-isolation guarantee.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Badge, Button, Caption1, Body1, Subtitle2, Text,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, Sparkle24Regular, Box24Regular, Shield24Regular,
  CheckmarkCircle24Regular, Tag20Regular, TextDescription20Regular,
  Ribbon20Regular, Open16Regular,
} from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { openCopilot } from '@/lib/components/copilot-pane';

interface ActionItem { id: string; displayName: string; itemType: string; issue: string }
interface OwnerPosture {
  source: 'cache' | 'live';
  kpis: {
    totalItems: number;
    labelCoveragePct: number;
    descriptionCoveragePct: number;
    endorsementCoveragePct: number;
    computedAt: string;
  };
  unlabeled: ActionItem[];
  undescribed: ActionItem[];
  unendorsed: ActionItem[];
  owner: { upn: string; name: string };
}
interface RefreshGate { missingEnvVar: string; bicepModule: string; message: string }

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap',
  },
  toolbarRight: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  // Smaller insight cards than the tenant admin view (Fabric data-owner parity).
  kpiRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalXL,
  },
  kpiCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
    minWidth: 0,
  },
  kpiHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  kpiIcon: {
    width: '36px', height: '36px', borderRadius: tokens.borderRadiusLarge,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  kpiVal: { fontSize: '30px', fontWeight: 700, lineHeight: '34px' },
  kpiLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, fontWeight: 600 },
  kpiSub: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground4 },
  bar: {
    height: tokens.spacingVerticalSNudge, borderRadius: '3px', backgroundColor: tokens.colorNeutralBackground4,
    overflow: 'hidden', marginTop: tokens.spacingVerticalSNudge,
  },
  actionsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  actionCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
    minWidth: 0,
  },
  actionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  actionList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  actionLink: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS,
    padding: '6px 10px', borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1, textDecoration: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 0' },
});

function curationScore(p: OwnerPosture['kpis']): number {
  return Math.round((p.descriptionCoveragePct + p.endorsementCoveragePct) / 2);
}

export function GovernOwnerPane() {
  const s = useStyles();
  const [data, setData] = useState<OwnerPosture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [gate, setGate] = useState<RefreshGate | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/governance/govern/owner');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Failed to load posture'); return; }
      setData(j as OwnerPosture);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // On tab-open: dispatch the owner-scoped Function refresh (fire-and-forget),
  // then read the posture. After the dispatch resolves, re-read once to pick up
  // freshly written aggregates. Mirrors Fabric's on-open refresh.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/governance/govern/refresh', { method: 'POST' });
      const j = await r.json();
      if (j.ok === false && j.gate === 'not_configured') {
        setGate({ missingEnvVar: j.missingEnvVar, bicepModule: j.bicepModule, message: j.message });
      } else {
        setGate(null);
      }
    } catch {
      /* dispatch failure is non-fatal — live compute still serves data */
    } finally {
      // The Function writes to Cosmos asynchronously; re-read shortly after to
      // surface fresh aggregates without blocking the initial render.
      setTimeout(() => { void load(); setRefreshing(false); }, 1500);
    }
  }, [load]);

  useEffect(() => {
    // Initial render reads cached/live posture immediately (not blocked on the
    // Function), then the on-open refresh runs in the background.
    void load();
    void refresh();
  }, [load, refresh]);

  const k = data?.kpis;

  return (
    <GovernanceShell sectionTitle="Govern" sectionBadge="My items">
      <Body1 className={s.intro}>
        Governance posture for the items <strong>you own</strong>, derived live from your Loom catalog.
        Insights refresh automatically each time you open this tab.
      </Body1>

      <div className={s.toolbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data?.owner?.name && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Scope: {data.owner.name} ({data.owner.upn})
            </Caption1>
          )}
          {refreshing && <Badge appearance="tint" color="informative">Refreshing…</Badge>}
          {data?.source && !refreshing && (
            <Badge appearance="outline" color={data.source === 'cache' ? 'success' : 'brand'}>
              {data.source === 'cache' ? 'Cached' : 'Live'}
            </Badge>
          )}
        </div>
        <div className={s.toolbarRight}>
          <Button appearance="secondary" icon={<Sparkle24Regular />} onClick={() => openCopilot()}>
            Ask Copilot about my governance
          </Button>
          <Button appearance="primary" icon={<ArrowSync24Regular />} onClick={() => void refresh()} disabled={refreshing}>
            Refresh
          </Button>
        </div>
      </div>

      {gate && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>On-open refresh not provisioned</MessageBarTitle>
            {gate.message} Set <code>{gate.missingEnvVar}</code> and deploy <code>{gate.bicepModule}</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load your governance posture</MessageBarTitle>
            {error}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => { setLoading(true); void load(); }}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Loading your governance posture…" />}

      {k && !error && (
        <>
          {/* ── Smaller insight cards (Fabric data-owner parity) ── */}
          <div className={s.kpiRow}>
            <div className={s.kpiCard}>
              <div className={s.kpiHead}>
                <span className={s.kpiIcon} style={{ background: 'rgba(0,120,130,0.12)', color: '#007882' }}>
                  <Box24Regular />
                </span>
                <span className={s.kpiLabel}>My inventory</span>
              </div>
              <div className={s.kpiVal}>{k.totalItems}</div>
              <Caption1 className={s.kpiSub}>items you own</Caption1>
            </div>

            <div className={s.kpiCard}>
              <div className={s.kpiHead}>
                <span className={s.kpiIcon} style={{ background: 'rgba(135,100,184,0.14)', color: '#8764b8' }}>
                  <Shield24Regular />
                </span>
                <span className={s.kpiLabel}>Label coverage</span>
              </div>
              <div className={s.kpiVal}>{k.labelCoveragePct}%</div>
              <div className={s.bar}>
                <div style={{ width: `${k.labelCoveragePct}%`, height: '100%', background: '#8764b8', borderRadius: 3 }} />
              </div>
              <Caption1 className={s.kpiSub}>items with a sensitivity label</Caption1>
            </div>

            <div className={s.kpiCard}>
              <div className={s.kpiHead}>
                <span className={s.kpiIcon} style={{ background: 'rgba(16,124,16,0.14)', color: '#107c10' }}>
                  <CheckmarkCircle24Regular />
                </span>
                <span className={s.kpiLabel}>Curation state</span>
              </div>
              <div className={s.kpiVal}>{curationScore(k)}%</div>
              <div className={s.bar}>
                <div style={{ width: `${curationScore(k)}%`, height: '100%', background: '#107c10', borderRadius: 3 }} />
              </div>
              <Caption1 className={s.kpiSub}>
                {k.descriptionCoveragePct}% described · {k.endorsementCoveragePct}% endorsed
              </Caption1>
            </div>
          </div>

          {k.computedAt && (
            <Caption1 style={{ color: tokens.colorNeutralForeground4, display: 'block', marginBottom: tokens.spacingVerticalL }}>
              Last computed {new Date(k.computedAt).toLocaleString()}
            </Caption1>
          )}

          {/* ── Owner-scoped recommended actions ── */}
          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalM }}>Recommended actions</Subtitle2>
          {k.totalItems === 0 ? (
            <Body1 className={s.empty}>
              You don&apos;t own any catalog items yet. Items you create or are assigned as owner/steward will appear here.
            </Body1>
          ) : (
            <div className={s.actionsGrid}>
              <ActionCard
                icon={<Tag20Regular />}
                tint="rgba(188,75,9,0.12)"
                color="#bc4b09"
                title="Add sensitivity labels"
                empty="Every item you own is labeled. Nice."
                items={data!.unlabeled}
              />
              <ActionCard
                icon={<TextDescription20Regular />}
                tint="rgba(15,108,189,0.12)"
                color="#0f6cbd"
                title="Add descriptions"
                empty="Every item you own has a description."
                items={data!.undescribed}
              />
              <ActionCard
                icon={<Ribbon20Regular />}
                tint="rgba(16,124,16,0.12)"
                color="#107c10"
                title="Request endorsement"
                empty="Every item you own is endorsed."
                items={data!.unendorsed}
              />
            </div>
          )}
        </>
      )}
    </GovernanceShell>
  );
}

function ActionCard({
  icon, tint, color, title, items, empty,
}: {
  icon: React.ReactNode; tint: string; color: string; title: string; items: ActionItem[]; empty: string;
}) {
  const s = useStyles();
  return (
    <div className={s.actionCard}>
      <div className={s.actionHead}>
        <span style={{
          width: 30, height: 30, borderRadius: 8, background: tint, color,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {icon}
        </span>
        <Subtitle2>{title}</Subtitle2>
        <Badge appearance="tint" color={items.length ? 'warning' : 'success'} style={{ marginLeft: 'auto' }}>
          {items.length}
        </Badge>
      </div>
      {items.length === 0 ? (
        <Caption1 className={s.empty}>{empty}</Caption1>
      ) : (
        <div className={s.actionList}>
          {items.map((it) => (
            <a key={`${it.itemType}:${it.id}`} className={s.actionLink} href={`/items/${it.itemType}/${it.id}`}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <Text weight="semibold">{it.displayName}</Text>{' '}
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{it.itemType}</Caption1>
              </span>
              <Open16Regular />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default GovernOwnerPane;

'use client';

/**
 * AdminOverview — live-count tile grid for the admin landing page.
 *
 * Replaces the static "Pick an area" EmptyState on /admin. Fetches
 * GET /api/admin/overview and renders 12 section tiles (Fluent Card grid).
 * Each tile shows: a section icon, the section name, a live count Badge
 * (real number from its backend, or a locked "—" badge with a remediation
 * tooltip when the source is honest-gated), a one-line description, and is
 * itself a Next.js <Link> to the section route.
 *
 * Per .claude/rules/no-vaporware.md every number comes from a real backend
 * (Cosmos / Microsoft Graph / ARM) via the BFF — no hard-coded counts. A
 * gated source renders a Lock badge + tooltip naming the exact env var / role
 * to set, never a fabricated integer.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  makeStyles, mergeClasses, tokens, Badge, Tooltip, Spinner,
  MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import {
  Building24Regular, Organization24Regular, ChartMultiple24Regular,
  ClipboardTask24Regular, Key24Regular, TagMultiple24Regular, Tag24Regular,
  Settings24Regular, People24Regular, Server24Regular, Heart24Regular,
  ShieldCheckmark24Regular, LockClosed16Regular, type FluentIcon,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import type { OverviewTileKey, OverviewTiles, TileCount } from '@/app/api/admin/overview/route';

interface TileSpec {
  key: OverviewTileKey;
  href: string;
  label: string;
  icon: FluentIcon;
  description: string;
}

// The 12 section tiles. href + icon mirror lib/components/admin-shell.tsx
// SECTIONS so the landing grid and the left nav stay one-for-one.
const TILE_SPECS: TileSpec[] = [
  { key: 'workspaces', href: '/admin/workspaces', label: 'Workspaces', icon: Building24Regular,
    description: 'Tenant-wide workspace inventory' },
  { key: 'domains', href: '/admin/domains', label: 'Domains', icon: Organization24Regular,
    description: 'Business domains and subdomains' },
  { key: 'items', href: '/admin/usage', label: 'Usage & items', icon: ChartMultiple24Regular,
    description: 'Items across every workspace' },
  { key: 'auditEvents', href: '/admin/audit-logs', label: 'Audit logs', icon: ClipboardTask24Regular,
    description: 'Audit events in the last 30 days' },
  { key: 'permissions', href: '/admin/permissions', label: 'Feature permissions', icon: Key24Regular,
    description: 'Fabric-style RBAC grants' },
  { key: 'attributeGroups', href: '/admin/attribute-groups', label: 'Custom attributes', icon: TagMultiple24Regular,
    description: 'Per-domain attribute schemas' },
  { key: 'labeledItems', href: '/admin/batch-labeling', label: 'Batch labeling', icon: Tag24Regular,
    description: 'Sensitivity-label assignments' },
  { key: 'tenantSettings', href: '/admin/tenant-settings', label: 'Tenant settings', icon: Settings24Regular,
    description: 'Enabled tenant-wide switches' },
  { key: 'users', href: '/admin/users', label: 'Users & licenses', icon: People24Regular,
    description: 'Directory users (Graph $count)' },
  { key: 'capacity', href: '/admin/capacity', label: 'Capacity & compute', icon: Server24Regular,
    description: 'Azure resources Loom orchestrates' },
  { key: 'openAuditItems', href: '/admin/health', label: 'Health & self-audit', icon: Heart24Regular,
    description: 'Fired alerts from Loom Activator' },
  { key: 'sensitivityLabels', href: '/admin/security', label: 'Security & governance', icon: ShieldCheckmark24Regular,
    description: 'Sensitivity labels in the tenant' },
];

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    paddingTop: tokens.spacingVerticalL, paddingRight: tokens.spacingHorizontalL, paddingBottom: tokens.spacingVerticalL, paddingLeft: tokens.spacingHorizontalL,
    minHeight: '140px',
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  tileHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  tileIcon: { display: 'flex', fontSize: '24px', color: tokens.colorNeutralForeground2 },
  tileName: { fontSize: '15px', fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  tileDesc: { fontSize: '12px', color: tokens.colorNeutralForeground3, lineHeight: 1.4, marginTop: 'auto', overflowWrap: 'anywhere', wordBreak: 'break-word' },
  skeleton: {
    minHeight: '140px', borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

async function fetchOverview(): Promise<{ ok: boolean; tiles?: OverviewTiles; error?: string; status: number }> {
  const res = await fetch('/api/admin/overview', { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  return { ...json, status: res.status };
}

function CountBadge({ tile }: { tile: TileCount }) {
  if (tile.gated) {
    return (
      <Tooltip content={tile.hint ?? 'Backend not configured'} relationship="description" withArrow>
        <Badge appearance="tint" color="informative" icon={<LockClosed16Regular />} aria-label={`Not configured: ${tile.hint ?? ''}`}>
          —
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Badge appearance="filled" color="brand" aria-label={`${tile.count ?? 0} items`}>
      {(tile.count ?? 0).toLocaleString()}
    </Badge>
  );
}

export function AdminOverview() {
  const styles = useStyles();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: fetchOverview,
  });

  if (isLoading) {
    return (
      <div className={styles.grid}>
        {TILE_SPECS.map((s) => <div key={s.key} className={styles.skeleton} />)}
      </div>
    );
  }

  if (data && data.status === 401) {
    return <SignInRequired subject="the admin overview" />;
  }

  if (!data || !data.ok || !data.tiles) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>Failed to load the admin overview: {data?.error ?? 'unknown error'}</MessageBarBody>
      </MessageBar>
    );
  }

  const tiles = data.tiles;
  return (
    <div className={styles.grid}>
      {TILE_SPECS.map((spec) => {
        const Icon = spec.icon;
        return (
          <Link key={spec.key} href={spec.href} className={styles.tile} aria-label={spec.label}>
            <div className={styles.tileHead}>
              <span className={styles.tileIcon}><Icon /></span>
              <CountBadge tile={tiles[spec.key]} />
            </div>
            <div className={styles.tileName}>{spec.label}</div>
            <div className={styles.tileDesc}>{spec.description}</div>
          </Link>
        );
      })}
    </div>
  );
}

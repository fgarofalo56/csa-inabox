'use client';

import Link from 'next/link';
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Caption1,
  Badge,
} from '@fluentui/react-components';
import {
  Code24Regular,
  Key24Regular,
  Window24Regular,
  Cloud24Regular,
  PeopleTeam24Regular,
  Box24Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { loomDocUrl } from '@/lib/learn/content';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    textDecoration: 'none',
    color: 'inherit',
    transition: 'box-shadow 120ms ease, transform 120ms ease',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  icon: { color: tokens.colorBrandForeground1 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

interface Tile {
  href: string;
  external?: boolean;
  icon: React.ReactElement;
  title: string;
  badge?: { label: string; color: 'brand' | 'success' | 'informative' | 'warning' };
  body: string;
}

const TILES: Tile[] = [
  {
    href: '/developer/api',
    icon: <Code24Regular />,
    title: 'API reference',
    badge: { label: 'OpenAPI 3.1', color: 'brand' },
    body: 'Browse the full REST contract for workspaces, items, catalog, and lineage. Copy-ready cURL for every route, backed by the live /api/openapi.json.',
  },
  {
    href: '/settings/developer/tokens',
    icon: <Key24Regular />,
    title: 'API tokens',
    badge: { label: 'Bearer auth', color: 'success' },
    body: 'Create scoped, revocable tokens (read-only / read-write / admin) for CI, scripts, and Terraform — no browser session required.',
  },
  {
    href: loomDocUrl('fiab/developer/cli'),
    external: true,
    icon: <Window24Regular />,
    title: 'loom CLI',
    body: 'The file-system-inspired command line: loom auth login, loom workspace, loom item — every call rides the same REST surface.',
  },
  {
    href: loomDocUrl('fiab/developer/terraform'),
    external: true,
    icon: <Cloud24Regular />,
    title: 'Terraform module',
    badge: { label: 'restapi provider', color: 'informative' },
    body: 'Provision Loom workspaces + items as code. A documented module + a working example that creates a workspace and a lakehouse via the API.',
  },
  {
    href: loomDocUrl('fiab/developer/scim'),
    external: true,
    icon: <PeopleTeam24Regular />,
    title: 'SCIM provisioning',
    badge: { label: 'SCIM 2.0', color: 'informative' },
    body: 'Provision users + groups from your identity provider (Entra) at /api/scim/v2. Bearer-token auth, real persistence, RFC 7643/7644 shapes.',
  },
  {
    href: loomDocUrl('fiab/developer/sdk'),
    external: true,
    icon: <Box24Regular />,
    title: 'SDKs',
    badge: { label: 'Roadmap', color: 'warning' },
    body: 'Thin TypeScript + Python clients over the BFF surface. Generate one today from the OpenAPI spec; first-party packages are on the roadmap.',
  },
];

export default function DeveloperHubPage() {
  const s = useStyles();
  return (
    <PageShell
      title="Developer"
      subtitle="Everything you need to automate Loom — REST API, tokens, CLI, Terraform, and SCIM provisioning."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Developer' }]}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          The Loom API is the console&apos;s own backend — every button in the product maps to a REST
          call you can make yourself. Start with the API reference, mint a scoped token, then drive
          Loom from CI, the CLI, Terraform, or your own SDK.
        </SectionExplainer>
      </div>
      <TileGrid minTileWidth={300}>
        {TILES.map((t) => {
          const inner = (
            <>
              <div className={s.head}>
                <span className={s.icon}>{t.icon}</span>
                <Title3 as="h2" style={{ fontSize: tokens.fontSizeBase500 }}>{t.title}</Title3>
                {t.badge && <Badge appearance="tint" color={t.badge.color}>{t.badge.label}</Badge>}
              </div>
              <Body1>{t.body}</Body1>
              <Caption1 style={{ color: tokens.colorBrandForeground1 }}>Open →</Caption1>
            </>
          );
          return t.external ? (
            <a key={t.href} className={s.card} href={t.href}>{inner}</a>
          ) : (
            <Link key={t.href} className={s.card} href={t.href}>{inner}</Link>
          );
        })}
      </TileGrid>
    </PageShell>
  );
}

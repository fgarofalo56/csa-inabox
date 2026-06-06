'use client';

/**
 * CatalogShell — left rail for /catalog/* tabs. Same UX language as
 * GovernanceShell so users moving across the console feel at home.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { makeStyles, tokens, Subtitle2, Title3, Badge } from '@fluentui/react-components';

const SECTIONS = [
  { href: '/catalog',             label: 'Search',      desc: 'Federated search across Purview, Unity Catalog, and OneLake.' },
  { href: '/catalog/browse',      label: 'Browse',      desc: 'Tree view: source → workspace → schema/domain → asset.' },
  { href: '/catalog/domains',     label: 'Domains',     desc: 'Business-domain CRUD; assign UC catalogs and OneLake workspaces.' },
  { href: '/catalog/permissions', label: 'Permissions', desc: 'Loom roles that fan out to Purview RBAC, UC GRANTs, and Fabric roles.' },
  { href: '/catalog/metastores',  label: 'Metastores',  desc: 'Registered Databricks metastores, Purview accounts, OneLake regions.' },
  { href: '/catalog/lineage',     label: 'Lineage',     desc: 'Federated lineage graph rolling up Purview + UC + Fabric edges.' },
];

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: '280px 1fr',
    gap: tokens.spacingHorizontalXXL,
    minHeight: '60vh',
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalM,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    textDecoration: 'none',
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  desc: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightRegular,
  },
  body: { minWidth: 0 },
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
});

export function CatalogShell({ sectionTitle, sectionBadge, children }: { sectionTitle?: string; sectionBadge?: string; children: ReactNode }) {
  const s = useStyles();
  const pathname = usePathname();
  return (
    <PageShell
      title="Unified catalog"
      subtitle="One catalog across your Loom workspaces, Microsoft Purview, and Databricks Unity Catalog — search, govern, and grant access without leaving Loom. (Fabric OneLake is opt-in.)"
    >
      <div className={s.layout}>
        <nav className={s.sidebar} aria-label="Catalog sections">
          {SECTIONS.map((sec) => {
            const active = pathname === sec.href || (sec.href !== '/catalog' && pathname?.startsWith(sec.href));
            return (
              <Link key={sec.href} href={sec.href} className={`${s.item} ${active ? s.itemActive : ''}`}>
                <Subtitle2>{sec.label}</Subtitle2>
                <span className={s.desc}>{sec.desc}</span>
              </Link>
            );
          })}
        </nav>
        <div className={s.body}>
          {sectionTitle && (
            <div className={s.sectionHead}>
              <Title3 as="h2">{sectionTitle}</Title3>
              {sectionBadge && <Badge appearance="outline" color="brand">{sectionBadge}</Badge>}
            </div>
          )}
          {children}
        </div>
      </div>
    </PageShell>
  );
}

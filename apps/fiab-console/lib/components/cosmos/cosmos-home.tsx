'use client';

/**
 * CosmosHome — the Data Explorer studio's **Home / Welcome** tab, one-for-one
 * with temp/ref-cosmos-data-explorer-studio.png:
 *   "Welcome to Azure Cosmos DB" hero, four action cards
 *   (Launch quick start / New Container / Samples Gallery / Connect), and the
 *   Recents · Top 3 things you need to know · Learning Resources columns.
 *
 * Real vs honest:
 *   - **New Container** card → triggers the real create flow (onNewContainer).
 *   - **Connect** card → opens the real account-info surface (onConnect), which
 *     surfaces the live document endpoint from /api/cosmos/account.
 *   - Launch quick start / Samples Gallery / the learning links are honest
 *     outbound links to Microsoft Learn (no fake in-app tutorial).
 */

import {
  Card, CardHeader, Title1, Body1, Caption1, Link, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Rocket20Regular, Table20Regular, Sparkle20Regular, PlugConnected20Regular,
  Open16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXL, padding: '8px 4px', overflow: 'auto', height: '100%' },
  hero: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS, alignItems: 'center', textAlign: 'center', paddingTop: tokens.spacingVerticalM },
  heroSub: { color: tokens.colorNeutralForeground2 },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacingHorizontalL, maxWidth: '920px', margin: '0 auto', width: '100%' },
  card: { cursor: 'pointer' },
  cardLink: { textDecoration: 'none' },
  cardDesc: { color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS },
  columns: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalXXL, maxWidth: '920px', margin: '0 auto', width: '100%' },
  col: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS },
  colTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400 },
  linkRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS },
  linkSub: { color: tokens.colorNeutralForeground3 },
});

export interface CosmosHomeProps {
  /** Trigger the real "New container" create flow in the tree. */
  onNewContainer?: () => void;
  /** Open the live account-info / connect surface. */
  onConnect?: () => void;
}

const LEARN = {
  quickstart: 'https://learn.microsoft.com/azure/cosmos-db/nosql/quickstart-portal',
  samples: 'https://learn.microsoft.com/azure/cosmos-db/nosql/samples-dotnet',
  modeling: 'https://learn.microsoft.com/azure/cosmos-db/nosql/modeling-data',
  partitioning: 'https://learn.microsoft.com/azure/cosmos-db/partitioning-overview',
  requirements: 'https://learn.microsoft.com/azure/cosmos-db/plan-manage-costs',
  shortcuts: 'https://learn.microsoft.com/azure/cosmos-db/data-explorer-shortcuts',
  sdk: 'https://learn.microsoft.com/azure/cosmos-db/nosql/sdk-dotnet-v3',
  fundamentals: 'https://learn.microsoft.com/azure/cosmos-db/introduction',
  migrate: 'https://learn.microsoft.com/azure/cosmos-db/migration-choices',
};

export function CosmosHome({ onNewContainer, onConnect }: CosmosHomeProps) {
  const s = useStyles();

  return (
    <div className={s.root}>
      <div className={s.hero}>
        <Title1>Welcome to Azure Cosmos DB</Title1>
        <Body1 className={s.heroSub}>Globally distributed, multi-model database service for any scale</Body1>
      </div>

      <div className={s.cards}>
        {/* Launch quick start — honest outbound link (no fake in-app tutorial). */}
        <a className={s.cardLink} href={LEARN.quickstart} target="_blank" rel="noreferrer">
          <Card className={s.card}>
            <CardHeader
              image={<Rocket20Regular />}
              header={<Body1><b>Launch quick start</b></Body1>}
              description={<Caption1 className={s.cardDesc}>Launch a quick start tutorial to get started with sample data. <Open16Regular style={{ verticalAlign: 'middle' }} /></Caption1>}
            />
          </Card>
        </a>

        {/* New Container — REAL create flow. */}
        <Card className={s.card} onClick={onNewContainer} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNewContainer?.(); } }}>
          <CardHeader
            image={<Table20Regular />}
            header={<Body1><b>New Container</b></Body1>}
            description={<Caption1 className={s.cardDesc}>Create a new container for storage and throughput.</Caption1>}
          />
        </Card>

        {/* Samples Gallery — honest outbound link. */}
        <a className={s.cardLink} href={LEARN.samples} target="_blank" rel="noreferrer">
          <Card className={s.card}>
            <CardHeader
              image={<Sparkle20Regular />}
              header={<Body1><b>Azure Cosmos DB Samples Gallery</b></Body1>}
              description={<Caption1 className={s.cardDesc}>Discover samples that showcase scalable, intelligent app patterns. <Open16Regular style={{ verticalAlign: 'middle' }} /></Caption1>}
            />
          </Card>
        </a>

        {/* Connect — REAL account-info surface (live document endpoint). */}
        <Card className={s.card} onClick={onConnect} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onConnect?.(); } }}>
          <CardHeader
            image={<PlugConnected20Regular />}
            header={<Body1><b>Connect</b></Body1>}
            description={<Caption1 className={s.cardDesc}>Prefer using your own choice of tooling? Find the connection string you need to connect.</Caption1>}
          />
        </Card>
      </div>

      <Divider />

      <div className={s.columns}>
        <div className={s.col}>
          <span className={s.colTitle}>Recents</span>
          <Caption1 className={s.linkSub}>Containers you open will appear here.</Caption1>
        </div>

        <div className={s.col}>
          <span className={s.colTitle}>Top 3 things you need to know</span>
          {[
            ['Advanced Modeling Patterns', 'Learn advanced strategies to optimize your database.', LEARN.modeling],
            ['Partitioning Best Practices', 'Learn to apply data model and partitioning strategies.', LEARN.partitioning],
            ['Plan Your Resource Requirements', 'Get to know the different configuration choices.', LEARN.requirements],
          ].map(([t, d, href]) => (
            <div className={s.linkRow} key={t}>
              <Link href={href} target="_blank" rel="noreferrer">{t} <Open16Regular style={{ verticalAlign: 'middle' }} /></Link>
              <Caption1 className={s.linkSub}>{d}</Caption1>
            </div>
          ))}
        </div>

        <div className={s.col}>
          <span className={s.colTitle}>Learning Resources</span>
          {[
            ['Data Explorer keyboard shortcuts', 'Learn keyboard shortcuts to navigate Data Explorer.', LEARN.shortcuts],
            ['Get Started using an SDK', 'Learn about the Azure Cosmos DB SDK.', LEARN.sdk],
            ['Learn the Fundamentals', 'Watch the Azure Cosmos DB introductory videos.', LEARN.fundamentals],
            ['Migrate Your Data', 'Migrate data using Azure services and open-source solutions.', LEARN.migrate],
          ].map(([t, d, href]) => (
            <div className={s.linkRow} key={t}>
              <Link href={href} target="_blank" rel="noreferrer">{t} <Open16Regular style={{ verticalAlign: 'middle' }} /></Link>
              <Caption1 className={s.linkSub}>{d}</Caption1>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default CosmosHome;

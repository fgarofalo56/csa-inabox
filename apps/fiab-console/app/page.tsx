import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import {
  Card,
  CardHeader,
  Subtitle1,
  Body1,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import Link from 'next/link';

const QUICK_LINKS: { href: string; title: string; body: string }[] = [
  { href: '/workspaces', title: 'Workspaces', body: 'Open or create a workspace — items live inside workspaces.' },
  { href: '/onelake', title: 'OneLake catalog', body: 'Find data across every workspace, with lineage and sensitivity labels.' },
  { href: '/monitor', title: 'Monitor', body: 'Check the health of pipelines, notebooks, and dataflows.' },
  { href: '/realtime-hub', title: 'Real-Time hub', body: 'Discover and subscribe to streaming event sources.' },
  { href: '/deployment-pipelines', title: 'Deployment pipelines', body: 'Promote items across dev / test / prod.' },
  { href: '/admin', title: 'Admin portal', body: 'Tenant settings, capacity, governance, and audit.' },
];

const useStyles = makeStyles({
  hero: {
    background: 'linear-gradient(135deg, var(--loom-indigo), var(--loom-navy))',
    color: 'white',
    padding: '32px',
    borderRadius: '8px',
    marginBottom: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  heroTitle: { color: 'white' },
  heroBody: { color: 'rgba(255,255,255,0.85)', maxWidth: '720px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  card: {
    padding: '16px',
    cursor: 'pointer',
    height: '100%',
    transition: 'transform 0.15s, box-shadow 0.15s',
    ':hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 },
  },
});

export default function HomePage() {
  const styles = useStyles();
  return (
    <PageShell title="Home" subtitle="Welcome to CSA Loom — the Fabric workspace experience for Azure tenants where Fabric is not yet available." actions={<NewItemDialog />}>
      <section className={styles.hero}>
        <Title3 className={styles.heroTitle}>Build, run, govern — all in one place.</Title3>
        <Body1 className={styles.heroBody}>
          Loom mirrors the Microsoft Fabric IA: workspaces are your root primitive,
          every workload (Data Engineering, Data Factory, Real-Time Intelligence,
          Power BI, Data Science, Fabric IQ, APIs) ships its full item catalog,
          and admin controls live under one tenant-wide portal.
        </Body1>
      </section>
      <div className={styles.grid}>
        {QUICK_LINKS.map((q) => (
          <Link key={q.href} href={q.href} style={{ display: 'block' }}>
            <Card className={styles.card}>
              <CardHeader header={<Subtitle1>{q.title}</Subtitle1>} description={<Body1>{q.body}</Body1>} />
            </Card>
          </Link>
        ))}
      </div>
    </PageShell>
  );
}

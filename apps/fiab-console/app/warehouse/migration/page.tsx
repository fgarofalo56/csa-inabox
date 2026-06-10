import { PageShell } from '@/lib/components/page-shell';
import { SqlMigrationPane } from '@/lib/panes/sql-migration';

export const metadata = {
  title: 'SQL DB Migration Assistant',
};

export default function SqlMigrationPage() {
  return (
    <PageShell
      title="SQL DB Migration Assistant"
      subtitle="Upload a SQL Server / Azure SQL .dacpac, assess its compatibility, and import the schema into the Synapse Dedicated SQL pool — no Microsoft Fabric required."
    >
      <SqlMigrationPane />
    </PageShell>
  );
}

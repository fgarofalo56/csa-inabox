'use client';

/**
 * /learn — central Learn library. Renders every entry in
 * lib/learn/content.ts as a card with quick links into the steps. Real
 * static content (no auto-generated text); contributors add entries to
 * the registry.
 */

import { Body1, Subtitle1, makeStyles, tokens } from '@fluentui/react-components';
import { PageShell } from '@/lib/components/page-shell';
import { getLearn } from '@/lib/learn/content';

// Mirror the registry keys here — Learn page lists known entries.
const KNOWN_TYPES = [
  // Real-time
  'eventstream', 'eventhouse', 'kql-database', 'kql-queryset', 'kql-dashboard', 'activator',
  // Lakehouse / storage
  'lakehouse', 'mirrored-database', 'mirrored-databricks',
  // Warehouse / SQL
  'warehouse', 'synapse-serverless-sql-pool', 'synapse-dedicated-sql-pool',
  'azure-sql-database', 'azure-sql-server', 'azure-sql-managed-instance',
  'sql-server-2025-vector-index',
  // Data engineering
  'notebook', 'data-pipeline', 'dataflow', 'copy-job',
  'spark-job-definition', 'environment',
  // Databricks
  'databricks-cluster', 'databricks-job', 'databricks-notebook', 'databricks-sql-warehouse',
  // ADF
  'adf-pipeline', 'adf-dataset', 'adf-trigger',
  // AI / ML
  'ai-foundry-hub', 'ai-search-index', 'prompt-flow', 'evaluation',
  'ml-model', 'ml-experiment', 'compute', 'dataset', 'content-safety', 'vector-store',
  // Power BI
  'semantic-model', 'report', 'dashboard', 'paginated-report', 'scorecard',
  // APIs
  'apim-api', 'apim-product', 'apim-policy', 'graphql-api', 'user-data-function',
  // Power Platform
  'power-app', 'power-automate-flow', 'dataverse-table', 'ai-builder-model',
  // Copilot Studio
  'copilot-studio-agent', 'copilot-studio-knowledge',
  'copilot-studio-topic', 'copilot-studio-action',
  // Data products
  'data-product', 'data-product-template', 'data-product-instance',
  // Graph
  'cosmos-gremlin-graph', 'cypher-graph', 'gql-graph',
];

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 18,
  },
  card: {
    padding: 20, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: 8,
    transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
    },
  },
  title: { fontSize: 15, fontWeight: 600, lineHeight: 1.3 },
  body: { fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.55 },
  linkRow: { display: 'flex', gap: 12, marginTop: 'auto', paddingTop: 10, flexWrap: 'wrap' },
  link: { fontSize: 13, color: tokens.colorBrandForeground1, textDecoration: 'none',
    ':hover': { textDecoration: 'underline' } },
});

export default function LearnPage() {
  const s = useStyles();
  const entries = KNOWN_TYPES.map(t => ({ type: t, learn: getLearn(t) })).filter(e => e.learn);
  return (
    <PageShell title="Learn"
      subtitle="Hand-authored quick-starts for each item type. The same content surfaces in the editor's Learn drawer.">
      <div className={s.grid}>
        {entries.map(({ type, learn }) => (
          <div key={type} className={s.card}>
            <div className={s.title}>{learn!.title}</div>
            {learn!.summary && <Body1 className={s.body}>{learn!.summary}</Body1>}
            <div className={s.linkRow}>
              <a className={s.link} href={`/items/${type}/new`}>Create →</a>
              {learn!.docsUrl && (
                <a className={s.link} href={learn!.docsUrl} target="_blank" rel="noreferrer">
                  MS docs ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

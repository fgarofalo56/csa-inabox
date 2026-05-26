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
  'eventstream', 'eventhouse', 'kql-database', 'kql-queryset', 'kql-dashboard',
  'activator', 'event-schema-set',
  // Lakehouse / storage
  'lakehouse', 'mirrored-database', 'mirrored-databricks',
  // Warehouse / SQL
  'warehouse', 'synapse-serverless-sql-pool', 'synapse-dedicated-sql-pool',
  'sql-database', 'azure-sql-database', 'azure-sql-server',
  'azure-sql-managed-instance', 'sql-server-2025-vector-index',
  // Data engineering
  'notebook', 'data-pipeline', 'dataflow', 'copy-job',
  'spark-job-definition', 'environment', 'variable-library',
  // Synapse
  'synapse-pipeline', 'synapse-spark-pool',
  // Databricks
  'databricks-cluster', 'databricks-job', 'databricks-notebook', 'databricks-sql-warehouse',
  // ADF / orchestration
  'adf-pipeline', 'adf-dataset', 'adf-trigger', 'mounted-adf',
  'airflow-job', 'dbt-job', 'usql-job',
  // AI / ML
  'ai-foundry-hub', 'ai-foundry-project', 'ai-search-index',
  'prompt-flow', 'evaluation', 'ml-model', 'ml-experiment',
  'compute', 'dataset', 'content-safety', 'vector-store', 'data-agent',
  // Power BI
  'semantic-model', 'report', 'dashboard', 'paginated-report', 'scorecard',
  // APIs
  'apim-api', 'apim-product', 'apim-policy', 'graphql-api', 'user-data-function',
  // Power Platform
  'power-app', 'power-automate-flow', 'power-page', 'dataverse-table',
  'ai-builder-model', 'powerplatform-environment',
  // Copilot Studio
  'copilot-studio-agent', 'copilot-studio-knowledge', 'copilot-studio-topic',
  'copilot-studio-action', 'copilot-studio-channel', 'copilot-studio-analytics',
  'copilot-template-library', 'cross-item-copilot',
  // Data products
  'data-product', 'data-product-template', 'data-product-instance',
  // Graph / geo
  'cosmos-gremlin-graph', 'cypher-graph', 'gql-graph', 'graph-model', 'ontology',
  'geo-dataset', 'geo-map', 'geo-pipeline', 'geo-query', 'map',
  // Ops
  'operations-agent', 'plan', 'tracing',
];

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '18px',
  },
  card: {
    paddingTop: '20px', paddingRight: '20px', paddingBottom: '20px', paddingLeft: '20px',
    borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: '8px',
    transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
    },
  },
  title: { fontSize: '15px', fontWeight: 600, lineHeight: 1.3 },
  body: { fontSize: '13px', color: tokens.colorNeutralForeground2, lineHeight: 1.55 },
  linkRow: { display: 'flex', gap: '12px', marginTop: 'auto', paddingTop: '10px', flexWrap: 'wrap' },
  link: { fontSize: '13px', color: tokens.colorBrandForeground1, textDecoration: 'none',
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

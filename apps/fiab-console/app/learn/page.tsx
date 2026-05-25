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
  'synapse-serverless-sql-pool',
  'synapse-dedicated-sql-pool',
  'kql-database',
  'eventstream',
  'activator',
  'lakehouse',
  'semantic-model',
  'mirrored-database',
  'ai-foundry-hub',
  'ai-search-index',
  'copilot-studio-agent',
];

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 14,
  },
  card: {
    padding: 16, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  title: { fontSize: 15, fontWeight: 600 },
  body: { fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.5 },
  link: { fontSize: 13, marginTop: 8, color: tokens.colorBrandForeground1 },
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
            <a className={s.link} href={`/items/${type}/new`}>Create a {learn!.title} →</a>
            {learn!.docsUrl && (
              <a className={s.link} href={learn!.docsUrl} target="_blank" rel="noreferrer">
                Open MS docs ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </PageShell>
  );
}

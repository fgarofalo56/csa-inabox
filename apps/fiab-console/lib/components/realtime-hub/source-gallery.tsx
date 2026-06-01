'use client';

/**
 * SourceGallery — the colour-coded "Get events" connector gallery for the
 * Real-Time hub, surfaced directly on the page (not buried in a dialog).
 *
 * One-for-one with Fabric's "Connect data source" gallery: every supported
 * streaming source is a rich, recognisable tile — coloured icon chip (per
 * category brand colour), name, Fabric source-type enum, and a Preview badge
 * where applicable. Category filter + search narrow the grid. Clicking a tile
 * opens the real ConnectSourceDialog pre-selected on that connector, which
 * POSTs to /api/realtime-hub/connect-source and creates a real Fabric
 * Eventstream item.
 */

import { useMemo, useState } from 'react';
import {
  Badge, Input, makeStyles, tokens, mergeClasses, Text, Caption1,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import {
  SOURCE_CONNECTORS, SOURCE_CATEGORIES, sourceVisual,
  type SourceConnector, type SourceCategory,
} from './source-catalog';

const useStyles = makeStyles({
  controls: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center',
    flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM,
  },
  search: { width: '100%', maxWidth: '320px', minWidth: '200px' },
  cats: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  catChip: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusCircular,
    padding: `4px 12px`, fontSize: '12px', cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  catChipActive: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    color: tokens.colorBrandForeground1, fontWeight: 600,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2, cursor: 'pointer', textAlign: 'left',
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'box-shadow, transform, border-color',
    ':hover': {
      boxShadow: tokens.shadow8, transform: 'translateY(-2px)',
      border: `1px solid ${tokens.colorNeutralStroke1}`,
    },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  chip: {
    flexShrink: 0, width: '36px', height: '36px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge,
  },
  name: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  desc: {
    color: tokens.colorNeutralForeground3, fontSize: '12px',
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden', minHeight: '32px',
  },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: '2px' },
  empty: {
    padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3,
    textAlign: 'center', gridColumn: '1 / -1',
  },
});

export function SourceGallery({ onPick }: { onPick: (c: SourceConnector) => void }) {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SourceCategory | 'all'>('all');

  const connectors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SOURCE_CONNECTORS.filter((c) =>
      (category === 'all' || c.category === category) &&
      (!q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) ||
        c.sourceType.toLowerCase().includes(q)));
  }, [query, category]);

  return (
    <>
      <div className={styles.controls}>
        <Input
          className={styles.search}
          contentBefore={<Search20Regular />}
          placeholder="Search sources…"
          value={query}
          onChange={(_, d) => setQuery(d.value)}
        />
        <div className={styles.cats} role="tablist" aria-label="Source category">
          <button
            type="button" role="tab" aria-selected={category === 'all'}
            className={mergeClasses(styles.catChip, category === 'all' ? styles.catChipActive : undefined)}
            onClick={() => setCategory('all')}
          >
            All ({SOURCE_CONNECTORS.length})
          </button>
          {SOURCE_CATEGORIES.map((c) => (
            <button
              key={c} type="button" role="tab" aria-selected={category === c}
              className={mergeClasses(styles.catChip, category === c ? styles.catChipActive : undefined)}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.grid}>
        {connectors.map((c) => {
          const v = sourceVisual(c);
          const Icon = v.icon;
          return (
            <button
              key={c.id} type="button" className={styles.tile}
              onClick={() => onPick(c)}
              title={`Connect ${c.name}`}
            >
              <div className={styles.head}>
                <span
                  className={styles.chip}
                  style={{ backgroundColor: `${v.color}1f`, color: v.color }}
                  aria-hidden
                >
                  <Icon style={{ width: 22, height: 22, color: v.color }} />
                </span>
                <Text className={styles.name} title={c.name}>{c.name}</Text>
              </div>
              <Caption1 className={styles.desc}>{c.description}</Caption1>
              <div className={styles.badges}>
                <Badge appearance="outline" size="small">{c.sourceType}</Badge>
                {c.preview && <Badge appearance="tint" color="warning" size="small">Preview</Badge>}
              </div>
            </button>
          );
        })}
        {connectors.length === 0 && (
          <div className={styles.empty}>No sources match “{query}”.</div>
        )}
      </div>
    </>
  );
}

export default SourceGallery;

'use client';

/**
 * NotebookGalleryCard — a Knowledge-Center card for one prebuilt notebook
 * sample (from the app content bundles, surfaced via GET
 * /api/learn/notebook-import).
 *
 * "Open in a workspace" opens the shared NotebookImportWizard prefilled to
 * THIS notebook — driving the real import → provision flow (Synapse Spark /
 * Databricks notebook provisioner, optional ADLS Delta sample seeding). The
 * card shows the notebook's cell count + whether seedable sample data exists,
 * so the user sees the depth before importing. No external links, no mocks —
 * the notebook is created Loom-native and opens in the Loom notebook editor.
 */

import * as React from 'react';
import {
  Text, Badge, Button, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { Notebook24Regular, Database16Regular, Code16Regular } from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { NotebookImportWizard, type PrefillNotebook } from '@/lib/learn/notebook-import-wizard';

export interface NotebookSample {
  bundleId: string;
  bundleLabel: string;
  notebookDisplayName: string;
  itemType: string;
  description: string;
  cellCount: number;
  hasSampleData: boolean;
}

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalL,
    minWidth: 0,
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, transform, border-color',
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-3px)',
      border: `1px solid ${tokens.colorNeutralStroke1}`,
    },
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, minWidth: 0 },
  chip: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '40px', height: '40px', borderRadius: tokens.borderRadiusLarge, flexShrink: 0,
  },
  titles: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  title: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  bundle: { color: tokens.colorNeutralForeground3 },
  desc: {
    color: tokens.colorNeutralForeground2, lineHeight: 1.45,
    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  meta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', color: tokens.colorNeutralForeground3 },
  metaItem: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
  foot: { marginTop: 'auto', paddingTop: tokens.spacingVerticalS },
});

export function NotebookGalleryCard({ nb }: { nb: NotebookSample }): React.ReactElement {
  const s = useStyles();
  const visual = itemVisual(nb.itemType);
  const prefill: PrefillNotebook = {
    bundleId: nb.bundleId,
    notebookDisplayName: nb.notebookDisplayName,
    hasSampleData: nb.hasSampleData,
  };

  return (
    <div className={s.card}>
      <div className={s.head}>
        <span className={s.chip} style={{ backgroundColor: `${visual.color}1f`, color: visual.color }} aria-hidden>
          <Notebook24Regular />
        </span>
        <div className={s.titles}>
          <Text className={s.title} title={nb.notebookDisplayName}>{nb.notebookDisplayName}</Text>
          <Caption1 className={s.bundle}>{nb.bundleLabel}</Caption1>
        </div>
      </div>

      <Text size={200} className={s.desc} title={nb.description}>{nb.description}</Text>

      <div className={s.meta}>
        <Badge appearance="outline" size="small">{nb.itemType}</Badge>
        <span className={s.metaItem}><Code16Regular /> <Caption1>{nb.cellCount} cells</Caption1></span>
        {nb.hasSampleData && (
          <span className={s.metaItem}><Database16Regular /> <Caption1>sample data</Caption1></span>
        )}
      </div>

      <div className={s.foot}>
        <NotebookImportWizard
          prefill={prefill}
          trigger={<Button appearance="primary" size="small">Open in a workspace</Button>}
        />
      </div>
    </div>
  );
}

export default NotebookGalleryCard;

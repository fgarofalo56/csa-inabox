'use client';

/**
 * TemplateGalleryFlyout — Fabric/ADF Studio parity: a right-side OverlayDrawer
 * showing curated pipeline templates. Selecting a card instantiates the
 * template spec onto the canvas immediately.
 *
 * No empty gallery: PIPELINE_TEMPLATES always contains 4 entries.
 * No simulated success: onSelect hands the full PipelineSpec to the parent,
 * which calls patchSpec() + setDirty(true) — the same mutation path used by
 * drag-and-drop from the activity palette.
 */

import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Badge, Caption1, Subtitle2,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular, DocumentBulletList20Regular } from '@fluentui/react-icons';
import { PIPELINE_TEMPLATES, type PipelineTemplate } from './catalog';
import type { PipelineSpec } from '../types';

const useStyles = makeStyles({
  intro: { display: 'block', marginBottom: '16px' },
  sectionTitle: { display: 'block', marginBottom: '8px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    padding: '4px 0',
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: '6px',
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '120ms',
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      boxShadow: tokens.shadow4,
    },
  },
  cardHeader: { display: 'flex', gap: '8px', alignItems: 'center' },
  title: { fontWeight: 600, fontSize: '13px', color: tokens.colorNeutralForeground1 },
  desc: { fontSize: '12px', color: tokens.colorNeutralForeground3, flex: 1 },
  actions: { display: 'flex', justifyContent: 'flex-end', marginTop: '4px' },
  footer: { display: 'block', marginTop: '24px', color: tokens.colorNeutralForeground3 },
});

export interface TemplateGalleryFlyoutProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called when the user selects a template. The parent sets this spec onto
   * the canvas and marks the editor dirty.
   */
  onSelect: (spec: PipelineSpec, template: PipelineTemplate) => void;
}

export function TemplateGalleryFlyout({ open, onOpenChange, onSelect }: TemplateGalleryFlyoutProps) {
  const s = useStyles();
  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      position="end"
      size="medium"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button appearance="subtle" aria-label="Close template gallery" icon={<Dismiss24Regular />}
              onClick={() => onOpenChange(false)} />
          }
        >
          Pipeline template gallery
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <Caption1 className={s.intro}>
          Select a template to pre-fill the canvas. All templates use ADF-native activities
          (Copy, ForEach, Lookup, Stored procedure) that run on the ADF backing without
          additional Fabric prerequisites. Wire in linked services and datasets after instantiation.
        </Caption1>

        <Subtitle2 className={s.sectionTitle}>Copy patterns</Subtitle2>
        <div className={s.grid}>
          {PIPELINE_TEMPLATES.map((t) => (
            <div key={t.id} className={s.card}
              role="button" tabIndex={0}
              aria-label={`Use template: ${t.title}`}
              onClick={() => { onSelect(t.spec, t); onOpenChange(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t.spec, t); onOpenChange(false); }
              }}
            >
              <div className={s.cardHeader}>
                <DocumentBulletList20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
                <span className={s.title}>{t.title}</span>
              </div>
              <span className={s.desc}>{t.description}</span>
              <div className={s.actions}>
                <Badge appearance="outline" size="small">{t.category}</Badge>
              </div>
            </div>
          ))}
        </div>

        <Caption1 className={s.footer}>
          {PIPELINE_TEMPLATES.length} templates · Loom built-in · ADF 2018-06-01 API
        </Caption1>
      </DrawerBody>
    </OverlayDrawer>
  );
}

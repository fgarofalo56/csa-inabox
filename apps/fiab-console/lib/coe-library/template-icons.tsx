'use client';

/**
 * Per-template / per-category icons + themed chips for the Organizational
 * Visuals gallery.
 *
 * Each CoE template (and each Loom-native dashboard category) gets a distinct
 * Fluent v9 icon rendered in a themed circular chip — so the gallery reads as a
 * set of recognizable tiles rather than eight identical colored gradients. The
 * accent colors are the same per-category brand hues used by the tile gradients,
 * applied via Loom tokens-friendly inline styles.
 */

import * as React from 'react';
import {
  ChartMultiple24Regular, Money24Regular, ShieldCheckmark24Regular,
  BoxMultiple24Regular, PeopleTeam24Regular, DatabaseSearch24Regular,
  PulseSquare24Regular, BuildingMultiple24Regular, DataArea24Regular,
} from '@fluentui/react-icons';
import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components';

/** Category → distinct Fluent icon (24px). */
const CATEGORY_ICON: Record<string, React.ReactElement> = {
  'Adoption & Maturity': <ChartMultiple24Regular />,
  'FinOps': <Money24Regular />,
  'Security & Compliance': <ShieldCheckmark24Regular />,
  'Inventory & Optimization': <BoxMultiple24Regular />,
  'Identity & Access': <PeopleTeam24Regular />,
  'Data Governance': <DatabaseSearch24Regular />,
  'Operations': <PulseSquare24Regular />,
  'Platform & Governance': <BuildingMultiple24Regular />,
};

/** Per-template id override (so two templates in one category can still differ). */
const TEMPLATE_ICON: Record<string, React.ReactElement> = {
  'coe-adoption-maturity': <ChartMultiple24Regular />,
  'cloud-cost-finops': <Money24Regular />,
  'security-compliance-posture': <ShieldCheckmark24Regular />,
  'resource-inventory-sprawl': <BoxMultiple24Regular />,
  'identity-access-governance': <PeopleTeam24Regular />,
  'data-estate-governance': <DatabaseSearch24Regular />,
  'operational-health-sla': <PulseSquare24Regular />,
  'landing-zone-conformance': <BuildingMultiple24Regular />,
};

/** Category → accent hue (matches the gradient set). */
const CATEGORY_ACCENT: Record<string, string> = {
  'Adoption & Maturity': '#6E56CF',
  'FinOps': '#0F6CBD',
  'Security & Compliance': '#C50F1F',
  'Inventory & Optimization': '#107C10',
  'Identity & Access': '#8764B8',
  'Data Governance': '#038387',
  'Operations': '#CA5010',
  'Platform & Governance': '#5C2E91',
};

const DEFAULT_ICON = <DataArea24Regular />;
const DEFAULT_ACCENT = '#6E56CF';

export function templateIcon(templateId: string, category: string): React.ReactElement {
  return TEMPLATE_ICON[templateId] || CATEGORY_ICON[category] || DEFAULT_ICON;
}

export function categoryAccent(category: string): string {
  return CATEGORY_ACCENT[category] || DEFAULT_ACCENT;
}

const useChipStyles = makeStyles({
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    color: '#fff',
    boxShadow: tokens.shadow4,
  },
  sm: { width: '28px', height: '28px' },
  md: { width: '40px', height: '40px' },
  lg: { width: '56px', height: '56px' },
  // On a gradient thumb, render the icon glyph in white over a translucent disc.
  onThumb: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    backdropFilter: 'blur(2px)',
  },
});

export interface TemplateIconChipProps {
  templateId?: string;
  category: string;
  size?: 'sm' | 'md' | 'lg';
  /** When true, render as a translucent disc (for placing over a colored thumb). */
  onThumb?: boolean;
}

/** A themed circular chip showing the template's distinct icon. */
export function TemplateIconChip({ templateId, category, size = 'md', onThumb }: TemplateIconChipProps): React.ReactElement {
  const s = useChipStyles();
  const accent = categoryAccent(category);
  const icon = templateIcon(templateId || '', category);
  return (
    <span
      className={mergeClasses(s.chip, s[size], onThumb && s.onThumb)}
      style={onThumb ? undefined : { backgroundColor: accent }}
      aria-hidden
    >
      {icon}
    </span>
  );
}

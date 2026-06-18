/**
 * Domain image presets — color swatches + department icon tiles used by the
 * domain Image-tab gallery (domain-image-gallery.tsx) AND by the domain list
 * page / governance tiles to resolve a stored `imageKey` into a visual.
 *
 * Icons are inline SVG path constants (no external fetch, no icon-font
 * dependency) so they render identically in every sovereign cloud and in
 * screenshot harnesses. Colors come from the Fluent palette.
 */
import * as React from 'react';
import { DomainGlyph } from '@/lib/domains/domain-icons';

/** 16 Fluent-palette colors for the "Color" section of the gallery. */
export const DOMAIN_COLOR_SWATCHES = [
  '#0078d4', '#106ebe', '#005a9e', '#3aaaaa',
  '#107c10', '#498205', '#dca900', '#bd7800',
  '#d13438', '#a4262c', '#7719aa', '#5c2d91',
  '#881798', '#e3008c', '#605e5c', '#1b1a19',
] as const;

export interface DomainPresetIcon {
  key: string;
  label: string;
  color: string;
}

/** 12 department symbols. `color` tints the branded tile behind the glyph. */
export const DOMAIN_PRESET_ICONS: DomainPresetIcon[] = [
  { key: 'finance', label: 'Finance', color: '#107c10' },
  { key: 'operations', label: 'Operations', color: '#0078d4' },
  { key: 'hr', label: 'HR', color: '#7719aa' },
  { key: 'it', label: 'IT', color: '#005a9e' },
  { key: 'marketing', label: 'Marketing', color: '#e3008c' },
  { key: 'legal', label: 'Legal', color: '#605e5c' },
  { key: 'research', label: 'Research', color: '#3aaaaa' },
  { key: 'sales', label: 'Sales', color: '#bd7800' },
  { key: 'healthcare', label: 'Healthcare', color: '#d13438' },
  { key: 'government', label: 'Government', color: '#1b1a19' },
  { key: 'manufacturing', label: 'Manufacturing', color: '#498205' },
  { key: 'education', label: 'Education', color: '#881798' },
];

const ICON_BY_KEY: Record<string, DomainPresetIcon> = Object.fromEntries(
  DOMAIN_PRESET_ICONS.map((i) => [i.key, i]),
);

export function getDomainPresetIcon(key: string): DomainPresetIcon | undefined {
  return ICON_BY_KEY[key];
}

// Simple monochrome glyph paths (24x24 viewBox), filled white on the tile.
const ICON_PATHS: Record<string, string> = {
  finance: 'M4 4h2v14h14v2H4V4zm5 9 3-4 3 3 4-6 1.6 1.2L15 14l-3-3-3 4-2-2z',
  operations: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9.4 4-1.9-1.1.2-2.2-2.1-.7-.9-2-2.2.3L12 2.6 10.5 4.3l-2.2-.3-.9 2-2.1.7.2 2.2L3.6 12l1.9 1.1-.2 2.2 2.1.7.9 2 2.2-.3L12 21.4l1.5-1.7 2.2.3.9-2 2.1-.7-.2-2.2L21.4 12z',
  hr: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13c-2.7 0-6 1.3-6 4v2h12v-2c0-2.7-3.3-4-6-4zm8 0c-.5 0-1 .1-1.5.2 1.5 1 2.5 2.3 2.5 3.8v2h5v-2c0-2.7-3.3-4-6-4z',
  it: 'M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-6v2h2v2H8v-2h2v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v8h14V7H5z',
  marketing: 'M3 10v4h3l5 4V6L6 10H3zm12.5 2a3 3 0 0 0-1.5-2.6v5.2A3 3 0 0 0 15.5 12zM18 6.5l-1.3 1.6A5.5 5.5 0 0 1 19 12a5.5 5.5 0 0 1-2.3 3.9L18 17.5A7.5 7.5 0 0 0 21 12a7.5 7.5 0 0 0-3-5.5z',
  legal: 'M12 3 4 6v2h16V6l-8-3zM6 10l-3 6c0 1.7 1.3 2.5 3 2.5s3-.8 3-2.5L9 10H6zm9 0-3 6c0 1.7 1.3 2.5 3 2.5s3-.8 3-2.5l-3-6h-3zM11 9h2v9h4v2H7v-2h4V9z',
  research: 'M9 2v2h1v5.6l-4.8 8A2 2 0 0 0 7 21h10a2 2 0 0 0 1.8-3.4l-4.8-8V4h1V2H9zm3 2v6l1.5 2.5h-3L12 10V4z',
  sales: 'M3 3h2v16h16v2H3V3zm15 2 1.4 1.4-5.4 5.4-3-3-5 5L7.4 12l3.6-3.6 3 3L16.6 7H14V5h4z',
  healthcare: 'M12 21s-7-4.5-9.3-9C1.2 9 2.6 5.5 6 5.5c1.9 0 3.2 1 3.9 2H10V5h4v2.5h.1c.7-1 2-2 3.9-2 3.4 0 4.8 3.5 3.3 6.5C19 16.5 12 21 12 21zM10 9v2H8v2h2v2h4v-2h2v-2h-2V9h-4z',
  government: 'M12 2 2 7v2h20V7L12 2zM4 10v8H3v2h18v-2h-1v-8h-2v8h-3v-8h-2v8H9v-8H7v8H6v-8H4z',
  manufacturing: 'M2 20V9l5 3V9l5 3V4h2v8l5-3v11H2zm4-2h2v-3H6v3zm5 0h2v-3h-2v3zm5 0h2v-3h-2v3z',
  education: 'M12 3 1 9l11 6 9-4.9V17h2V9L12 3zM5 13.2V17c0 1.7 3.1 3 7 3s7-1.3 7-3v-3.8l-7 3.8-7-3.8z',
};

/** Render a preset domain icon glyph at `size`px, white on transparent. */
export function renderDomainIcon(key: string, size = 24): React.ReactElement | null {
  const d = ICON_PATHS[key];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/**
 * Resolve a stored `imageKey` (+ optional fallback color) into a small visual
 * chip for the domain list / governance tiles. Blob images need their https
 * URL passed in via `blobUrl` (the caller looks it up from the images list);
 * without it we fall back to a neutral image glyph so the row still renders.
 */
export function DomainImageChip({
  imageKey, fallbackColor, size = 32, blobUrl, icon, themeColor,
}: {
  imageKey?: string;
  fallbackColor?: string;
  size?: number;
  blobUrl?: string;
  /** Fluent icon NAME — takes precedence over imageKey/color when set. */
  icon?: string;
  /** Theme color (hex) paired with `icon`. */
  themeColor?: string;
}): React.ReactElement {
  // Preferred path: a Fluent icon name + theme color on the domain model. This
  // is what seeded domains and library-created domains carry, so they render as
  // an icon-in-colored-chip rather than a plain colored square. An explicit
  // imageKey (chosen in the Image tab) still wins so existing selections stick.
  if (icon && !imageKey) {
    return <DomainGlyph icon={icon} color={themeColor || fallbackColor} size={size} />;
  }
  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', color: '#fff',
  };
  if (imageKey?.startsWith('color::')) {
    return <span style={{ ...base, backgroundColor: imageKey.slice(7) }} aria-hidden="true" />;
  }
  if (imageKey?.startsWith('icon::')) {
    const icon = getDomainPresetIcon(imageKey.slice(6));
    return (
      <span style={{ ...base, backgroundColor: icon?.color || '#605e5c' }} aria-hidden="true">
        {renderDomainIcon(imageKey.slice(6), Math.round(size * 0.62))}
      </span>
    );
  }
  if (imageKey?.startsWith('blob::')) {
    if (blobUrl) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={blobUrl} alt="" style={{ ...base, objectFit: 'cover' }} />;
    }
    return (
      <span style={{ ...base, backgroundColor: '#3aaaaa' }} aria-hidden="true">
        {renderDomainIcon('research', Math.round(size * 0.62))}
      </span>
    );
  }
  // No imageKey: fall back to the domain's color swatch (legacy field).
  return <span style={{ ...base, backgroundColor: fallbackColor || '#0078d4' }} aria-hidden="true" />;
}


'use client';

/**
 * DomainImageGallery — the domain Image-tab picker, one-for-one with Fabric's
 * "photo gallery" that pops up when you choose Image > Select an image for a
 * domain. Fabric lets you pick a COLOR or an IMAGE to represent the domain in
 * the OneLake catalog; Loom offers the same, fully Azure-native:
 *
 *   1. Color swatches  — 16 Fluent-palette colors (always available).
 *   2. Preset icons    — 12 department symbols rendered as branded tiles
 *                        (inline SVG, always available — no external fetch).
 *   3. Custom images   — real Blob/ADLS gallery from GET /api/admin/domains/images
 *                        when LOOM_DOMAIN_IMAGE_STORAGE is set; otherwise an
 *                        honest MessageBar names the env var + role to grant.
 *
 * The selection is encoded into a single `imageKey` string the domain doc
 * stores and the list page resolves to a visual:
 *   color swatch -> "color::#0078d4"
 *   preset icon  -> "icon::finance"
 *   custom blob  -> "blob::<blobName>"   (+ the resolved https url is shown)
 */

import { useEffect, useState } from 'react';
import {
  Button, Spinner, Caption1, Subtitle2,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Checkmark16Filled } from '@fluentui/react-icons';
import {
  DOMAIN_COLOR_SWATCHES, DOMAIN_PRESET_ICONS, renderDomainIcon, type DomainPresetIcon,
} from './domain-image-presets';

export interface DomainImageGalleryProps {
  value?: string;
  onChange: (key: string) => void;
}

interface BlobImage { name: string; url: string; size: number; lastModified?: string; }
type BlobState =
  | { status: 'loading' }
  | { status: 'configured'; images: BlobImage[] }
  | { status: 'unconfigured'; hint: string }
  | { status: 'error'; error: string };

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  sectionTitle: { marginTop: tokens.spacingVerticalS },
  swatchGrid: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  swatch: {
    position: 'relative', width: '44px', height: '44px', borderRadius: '50%',
    cursor: 'pointer', border: `2px solid transparent`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0,
  },
  swatchSel: { border: `2px solid ${tokens.colorBrandStroke1}`, outline: `2px solid ${tokens.colorBrandBackground}` },
  iconGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(86px, 1fr))',
    gap: tokens.spacingHorizontalS,
  },
  iconTile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
    padding: tokens.spacingVerticalS, cursor: 'pointer', background: 'transparent',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  iconTileSel: { border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  iconArt: {
    width: '56px', height: '56px', borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
  },
  iconLabel: { fontSize: '11px', textAlign: 'center', color: tokens.colorNeutralForeground2 },
  blobGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(86px, 1fr))',
    gap: tokens.spacingHorizontalS,
  },
  blobTile: {
    position: 'relative', width: '100%', aspectRatio: '1 / 1', cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden', padding: 0, background: tokens.colorNeutralBackground2,
  },
  blobTileSel: { border: `2px solid ${tokens.colorBrandStroke1}` },
  blobImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  selBadge: {
    position: 'absolute', top: '4px', right: '4px', width: '18px', height: '18px',
    borderRadius: '50%', backgroundColor: tokens.colorBrandBackground,
    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
  },
});

export function DomainImageGallery({ value, onChange }: DomainImageGalleryProps) {
  const styles = useStyles();
  const [blobs, setBlobs] = useState<BlobState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/domains/images')
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok && j.configured) setBlobs({ status: 'configured', images: j.images || [] });
        else if (j.ok && !j.configured) setBlobs({ status: 'unconfigured', hint: j.hint });
        else setBlobs({ status: 'error', error: j.error || 'Could not load images' });
      })
      .catch((e) => alive && setBlobs({ status: 'error', error: String(e) }));
    return () => { alive = false; };
  }, []);

  const selColor = value?.startsWith('color::') ? value.slice('color::'.length) : null;
  const selIcon = value?.startsWith('icon::') ? value.slice('icon::'.length) : null;
  const selBlob = value?.startsWith('blob::') ? value.slice('blob::'.length) : null;

  return (
    <div className={styles.root}>
      <div>
        <Subtitle2 className={styles.sectionTitle}>Color</Subtitle2>
        <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalS }}>
          A solid color to represent this domain in the catalog domain selector.
        </Caption1>
        <div className={styles.swatchGrid} role="radiogroup" aria-label="Domain color">
          {DOMAIN_COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={selColor === c}
              aria-label={`Color ${c}`}
              className={`${styles.swatch} ${selColor === c ? styles.swatchSel : ''}`}
              style={{ backgroundColor: c }}
              onClick={() => onChange(`color::${c}`)}
            >
              {selColor === c && <Checkmark16Filled style={{ color: '#fff' }} />}
            </button>
          ))}
        </div>
      </div>

      <div>
        <Subtitle2 className={styles.sectionTitle}>Icon</Subtitle2>
        <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalS }}>
          A department symbol on a branded tile.
        </Caption1>
        <div className={styles.iconGrid} role="radiogroup" aria-label="Domain icon">
          {DOMAIN_PRESET_ICONS.map((icon: DomainPresetIcon) => (
            <button
              key={icon.key}
              type="button"
              role="radio"
              aria-checked={selIcon === icon.key}
              aria-label={`Icon ${icon.label}`}
              className={`${styles.iconTile} ${selIcon === icon.key ? styles.iconTileSel : ''}`}
              onClick={() => onChange(`icon::${icon.key}`)}
            >
              <span className={styles.iconArt} style={{ backgroundColor: icon.color }}>
                {renderDomainIcon(icon.key, 30)}
              </span>
              <span className={styles.iconLabel}>{icon.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <Subtitle2 className={styles.sectionTitle}>Custom images</Subtitle2>
        {blobs.status === 'loading' && <Spinner size="tiny" label="Loading images…" />}
        {blobs.status === 'unconfigured' && (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Custom image gallery not configured</MessageBarTitle>
              {blobs.hint}
            </MessageBarBody>
          </MessageBar>
        )}
        {blobs.status === 'error' && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Couldn&apos;t list custom images</MessageBarTitle>
              {blobs.error}
            </MessageBarBody>
          </MessageBar>
        )}
        {blobs.status === 'configured' && blobs.images.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            No images in the configured container yet. Upload PNG/JPEG/SVG files to it and they&apos;ll appear here.
          </Caption1>
        )}
        {blobs.status === 'configured' && blobs.images.length > 0 && (
          <div className={styles.blobGrid} role="radiogroup" aria-label="Custom domain images">
            {blobs.images.map((img) => {
              const sel = selBlob === img.name;
              return (
                <button
                  key={img.name}
                  type="button"
                  role="radio"
                  aria-checked={sel}
                  aria-label={`Image ${img.name}`}
                  className={`${styles.blobTile} ${sel ? styles.blobTileSel : ''}`}
                  onClick={() => onChange(`blob::${img.name}`)}
                  title={img.name}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt={img.name} className={styles.blobImg} />
                  {sel && <span className={styles.selBadge}><Checkmark16Filled style={{ fontSize: tokens.fontSizeBase200 }} /></span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {value && (
        <Button appearance="subtle" size="small" onClick={() => onChange('')} style={{ alignSelf: 'flex-start' }}>
          Clear selection
        </Button>
      )}
    </div>
  );
}

export default DomainImageGallery;

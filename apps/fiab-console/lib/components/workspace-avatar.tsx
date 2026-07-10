'use client';

/**
 * WorkspaceAvatar — the canonical workspace visual, shared by the workspace
 * header, the workspace cards, the switcher, and the settings preview. Renders
 * the custom uploaded image (Power BI-style) when one is set, otherwise a themed
 * initials chip (Fabric's default workspace avatar). One component so every
 * surface renders the same glyph and the same fallback.
 *
 * The image is served by GET /api/workspaces/[id]/image; we append the image's
 * `updatedAt` as a cache-buster so a replacement shows immediately. `hasImage`
 * comes from the workspace doc's small `image` metadata pointer, so no extra
 * request is made when a workspace has no image.
 */
import * as React from 'react';
import { Building20Regular } from '@fluentui/react-icons';

/** Deterministic brand-ish chip color derived from the workspace id/name. */
const CHIP_COLORS = [
  '#0078d4', '#107c10', '#5c2d91', '#bd7800',
  '#d13438', '#0e7490', '#881798', '#498205',
];

function chipColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CHIP_COLORS[h % CHIP_COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export interface WorkspaceAvatarProps {
  workspaceId: string;
  name: string;
  /** The workspace doc's `image` metadata pointer (updatedAt drives cache-bust). */
  image?: { updatedAt?: string } | null;
  size?: number;
}

export function WorkspaceAvatar({ workspaceId, name, image, size = 32 }: WorkspaceAvatarProps): React.ReactElement {
  const [failed, setFailed] = React.useState(false);
  const chip: React.CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', color: '#fff', backgroundColor: chipColor(workspaceId || name),
    fontSize: Math.round(size * 0.4), fontWeight: 600, lineHeight: 1,
  };

  if (image && !failed) {
    const bust = image.updatedAt ? `?ts=${encodeURIComponent(image.updatedAt)}` : '';
    return (
      <span style={chip} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/workspaces/${encodeURIComponent(workspaceId)}/image${bust}`}
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: 'cover' }}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  const abbr = initials(name);
  return (
    <span style={chip} aria-hidden="true">
      {abbr || <Building20Regular fontSize={Math.round(size * 0.55)} />}
    </span>
  );
}

export default WorkspaceAvatar;

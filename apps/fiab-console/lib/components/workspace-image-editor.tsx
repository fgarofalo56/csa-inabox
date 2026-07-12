'use client';

/**
 * WorkspaceImageEditor — the shared "set a workspace image" control (Power BI /
 * Fabric workspace-image parity). Rendered inside BOTH workspace-settings
 * surfaces (the header Drawer and the admin Pane) so a workspace image can be
 * set from wherever settings are opened, and both look/behave identically.
 *
 * Two ways to set an image, exactly like Power BI's picker:
 *   1. UPLOAD your own file (PNG / JPEG / GIF / WebP, ≤ 1 MiB).
 *   2. PICK a built-in preset tile (lib/components/workspace-image-presets) —
 *      the preset is rendered to a raster PNG on a canvas and uploaded through
 *      the identical route, so presets and uploads share one real backend.
 *
 * Everything posts to POST /api/workspaces/[id]/image (real Cosmos-backed
 * store, no Fabric dependency); removal hits DELETE. The current image renders
 * via the canonical WorkspaceAvatar so the preview matches every other surface.
 * No new infra — Cosmos is always present — so there is no infra-gate here.
 */

import * as React from 'react';
import {
  Button, Spinner, Subtitle2, Caption1, Body1Strong,
  MessageBar, MessageBarBody, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ImageAdd24Regular, Delete16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { WorkspaceAvatar } from '@/lib/components/workspace-avatar';
import {
  WORKSPACE_IMAGE_PRESETS,
  ALLOWED_IMAGE_TYPES,
  validateWorkspaceImageFile,
  presetGradientCss,
  drawPresetToCanvas,
  type WorkspaceImagePreset,
} from '@/lib/components/workspace-image-presets';

// Re-exported so existing importers keep a single entry point.
export { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, validateWorkspaceImageFile } from '@/lib/components/workspace-image-presets';

/** Pixel size of the PNG a preset is rasterised to before upload. */
const PRESET_RENDER_PX = 256;

/** Minimal workspace shape this editor needs (works with both Workspace types). */
export interface WorkspaceImageEditorWorkspace {
  id: string;
  name: string;
  image?: { updatedAt?: string } | null;
}

export interface WorkspaceImageEditorProps {
  workspace: WorkspaceImageEditorWorkspace;
  /**
   * Called after a successful save/remove with the API's returned workspace
   * (or, when the route echoes only metadata, a best-effort merged object). The
   * parent should refresh its cached workspace from this.
   */
  onSaved: (workspace: unknown) => void;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalXS },
  note: { color: tokens.colorNeutralForeground3, lineHeight: tokens.lineHeightBase200 },
  currentRow: { display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'center' },
  actions: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  sectionLabel: { marginTop: tokens.spacingVerticalS },
  gallery: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))',
    gap: tokens.spacingHorizontalS,
  },
  tile: {
    position: 'relative',
    aspectRatio: '1 / 1',
    borderRadius: tokens.borderRadiusMedium,
    border: `2px solid transparent`,
    cursor: 'pointer',
    padding: 0,
    overflow: 'hidden',
    boxShadow: tokens.shadow4,
    transitionProperty: 'transform, box-shadow, border-color',
    transitionDuration: tokens.durationNormal,
    ':hover': { transform: 'scale(1.04)', boxShadow: tokens.shadow8 },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  tileBusy: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    display: 'grid', placeItems: 'center', backgroundColor: 'rgba(0,0,0,0.25)',
  },
  hiddenInput: { display: 'none' },
});

/** Rasterise a preset to a PNG data URI (browser-only). Returns null if canvas
 * is unavailable (e.g. SSR / jsdom without a 2D context). */
function presetToPngDataUri(preset: WorkspaceImagePreset): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = PRESET_RENDER_PX;
  canvas.height = PRESET_RENDER_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawPresetToCanvas(ctx, preset, PRESET_RENDER_PX);
  return canvas.toDataURL('image/png');
}

export function WorkspaceImageEditor({ workspace, onSaved }: WorkspaceImageEditorProps): React.ReactElement {
  const styles = useStyles();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState<null | 'upload' | 'preset' | 'remove'>(null);
  const [pendingPreset, setPendingPreset] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const hasImage = !!workspace.image;

  const readAsDataUri = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error('Could not read file'));
      fr.readAsDataURL(file);
    });

  const post = async (dataUri: string): Promise<boolean> => {
    const r = await clientFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUri }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) {
      setErr(j?.error || `HTTP ${r.status}`);
      return false;
    }
    onSaved(j.workspace ?? { ...workspace, image: j.image });
    return true;
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    const invalid = validateWorkspaceImageFile(file.type, file.size);
    if (invalid) { setErr(invalid); return; }
    setBusy('upload');
    try {
      await post(await readAsDataUri(file));
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onPickPreset = async (preset: WorkspaceImagePreset) => {
    setErr(null);
    const dataUri = presetToPngDataUri(preset);
    if (!dataUri) { setErr('Could not render the preset image in this browser.'); return; }
    setBusy('preset');
    setPendingPreset(preset.id);
    try {
      await post(dataUri);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(null);
      setPendingPreset(null);
    }
  };

  const remove = async () => {
    setErr(null);
    setBusy('remove');
    try {
      const r = await clientFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/image`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setErr(j?.error || `HTTP ${r.status}`); return; }
      onSaved(j.workspace ?? { ...workspace, image: undefined });
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.root}>
      <Subtitle2>Workspace image</Subtitle2>
      <Caption1 className={styles.note}>
        Give this workspace a custom image — the same as a Power BI or Fabric workspace image. It appears
        in the workspace header, the workspace list and cards, and the workspace switcher. Upload your own
        (PNG, JPEG, GIF, or WebP, up to 1 MiB) or pick a preset below.
      </Caption1>

      <div className={styles.currentRow}>
        <WorkspaceAvatar workspaceId={workspace.id} name={workspace.name} image={workspace.image} size={96} />
        <div className={styles.actions}>
          <Button
            appearance="primary"
            icon={busy === 'upload' ? <Spinner size="tiny" /> : <ImageAdd24Regular />}
            disabled={!!busy}
            onClick={() => inputRef.current?.click()}
          >
            {hasImage ? 'Replace with a file' : 'Upload a file'}
          </Button>
          {hasImage && (
            <Button
              appearance="subtle"
              icon={busy === 'remove' ? <Spinner size="tiny" /> : <Delete16Regular />}
              disabled={!!busy}
              onClick={remove}
            >
              Remove image
            </Button>
          )}
        </div>
      </div>

      <Body1Strong className={styles.sectionLabel}>Or pick a preset</Body1Strong>
      <div className={styles.gallery} role="listbox" aria-label="Workspace image presets">
        {WORKSPACE_IMAGE_PRESETS.map((preset) => {
          const isPending = busy === 'preset' && pendingPreset === preset.id;
          return (
            <Tooltip key={preset.id} content={preset.name} relationship="label">
              <button
                type="button"
                role="option"
                aria-selected={false}
                aria-label={`Use the ${preset.name} preset image`}
                className={styles.tile}
                style={{ background: presetGradientCss(preset) }}
                disabled={!!busy}
                onClick={() => onPickPreset(preset)}
              >
                {isPending && (
                  <span className={styles.tileBusy}>
                    <Spinner size="tiny" />
                  </span>
                )}
              </button>
            </Tooltip>
          );
        })}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_IMAGE_TYPES.join(',')}
        className={styles.hiddenInput}
        onChange={(e) => onPickFile(e.target.files?.[0] || undefined)}
      />

      {err && (
        <MessageBar intent="error">
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

export default WorkspaceImageEditor;

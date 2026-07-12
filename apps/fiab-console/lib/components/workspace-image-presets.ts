/**
 * workspace-image-presets — the curated preset gallery for the workspace image
 * editor (Power BI / Fabric "pick an image" parity). Power BI's workspace image
 * picker offers upload OR a small set of built-in themed tiles; this is the
 * Azure-native equivalent.
 *
 * Each preset is a pure gradient + geometric motif spec. The SAME spec drives
 * BOTH the CSS preview tile (`presetGradientCss`) and the canvas render that
 * produces the raster PNG we upload (`drawPresetToCanvas`), so what the user
 * sees in the gallery is exactly what gets stored. We render to a PNG data URI
 * (not SVG) because the store rejects SVG as a stored-XSS vector
 * (lib/azure/workspace-image-store) — presets go through the identical
 * raster-only, real-backend upload path as a user's own file.
 *
 * Pure module (no React, no DOM types beyond the optional canvas arg) so the
 * geometry + palette are unit-testable without a browser.
 */

export interface WorkspaceImagePreset {
  /** Stable id (used as the React key + the deterministic seed). */
  id: string;
  /** Human label shown as the tile's tooltip / aria-label. */
  name: string;
  /** Gradient start color (hex). */
  from: string;
  /** Gradient end color (hex). */
  to: string;
  /** Gradient angle in degrees (CSS + canvas share this). */
  angle: number;
  /** Decorative motif drawn over the gradient. */
  motif: 'orbits' | 'grid' | 'wave' | 'diagonal' | 'bloom' | 'none';
}

/**
 * The built-in gallery. Twelve tiles spanning the Loom/Fabric-family accent
 * hues so every workspace can pick a distinct, on-brand image without leaving
 * the app. Ordered light→deep, cool→warm.
 */
export const WORKSPACE_IMAGE_PRESETS: readonly WorkspaceImagePreset[] = [
  { id: 'azure-sky',   name: 'Azure Sky',    from: '#2899f5', to: '#0a5cc2', angle: 135, motif: 'orbits' },
  { id: 'ocean',       name: 'Ocean',        from: '#0ea5b7', to: '#0e5a8a', angle: 135, motif: 'wave' },
  { id: 'teal-mint',   name: 'Teal Mint',    from: '#14b8a6', to: '#0f766e', angle: 120, motif: 'grid' },
  { id: 'evergreen',   name: 'Evergreen',    from: '#3aa655', to: '#136c2e', angle: 135, motif: 'bloom' },
  { id: 'lime',        name: 'Lime',         from: '#7cc61f', to: '#3f8f18', angle: 120, motif: 'diagonal' },
  { id: 'amber',       name: 'Amber',        from: '#f5a623', to: '#c2740a', angle: 135, motif: 'orbits' },
  { id: 'sunset',      name: 'Sunset',       from: '#f97316', to: '#c2410c', angle: 135, motif: 'wave' },
  { id: 'coral',       name: 'Coral',        from: '#f75c5c', to: '#c22d2d', angle: 120, motif: 'bloom' },
  { id: 'magenta',     name: 'Magenta',      from: '#e0499a', to: '#a11170', angle: 135, motif: 'grid' },
  { id: 'violet',      name: 'Violet',       from: '#8b5cf6', to: '#5c2d91', angle: 135, motif: 'orbits' },
  { id: 'indigo',      name: 'Indigo',       from: '#5566e0', to: '#2f39a1', angle: 120, motif: 'diagonal' },
  { id: 'slate',       name: 'Slate',        from: '#64748b', to: '#334155', angle: 135, motif: 'grid' },
] as const;

/** Look a preset up by id (undefined when unknown). */
export function getWorkspaceImagePreset(id: string): WorkspaceImagePreset | undefined {
  return WORKSPACE_IMAGE_PRESETS.find((p) => p.id === id);
}

/** Raster MIME types the store accepts (SVG excluded — stored-XSS safety). */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Max raw image size accepted, in bytes (mirrors the server store cap). */
export const MAX_IMAGE_BYTES = 1024 * 1024; // 1 MiB

/**
 * Pure client-side pre-flight for a user-selected image file. Returns an error
 * string to show in a MessageBar, or null when acceptable. Mirrors the server
 * store's raster-only + 1 MiB guard so the UI fails fast before uploading.
 */
export function validateWorkspaceImageFile(type: string, size: number): string | null {
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)) {
    return `Unsupported type "${type || 'unknown'}". Use PNG, JPEG, GIF, or WebP (SVG is not accepted).`;
  }
  if (size > MAX_IMAGE_BYTES) {
    return `Image is ${(size / 1024).toFixed(0)} KiB; the maximum is ${MAX_IMAGE_BYTES / 1024} KiB.`;
  }
  if (size <= 0) return 'That file is empty.';
  return null;
}

/** CSS `linear-gradient(...)` string for the preview tile — matches the canvas. */
export function presetGradientCss(preset: WorkspaceImagePreset): string {
  return `linear-gradient(${preset.angle}deg, ${preset.from} 0%, ${preset.to} 100%)`;
}

/** Validate a hex color of the form #rrggbb. Exported for tests. */
export function isHexColor(c: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(c);
}

/**
 * Convert a CSS gradient angle (degrees, 0 = up, clockwise) into the two
 * canvas gradient endpoints on a `size`×`size` square. Pure + testable.
 */
export function gradientEndpoints(angleDeg: number, size: number): { x0: number; y0: number; x1: number; y1: number } {
  // CSS angle: 0deg points up; 90deg points right. Convert to standard math.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cx = size / 2;
  const cy = size / 2;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Half-diagonal projection so the gradient spans corner-to-corner.
  const half = size / 2;
  return {
    x0: cx - dx * half,
    y0: cy - dy * half,
    x1: cx + dx * half,
    y1: cy + dy * half,
  };
}

/**
 * Draw a preset onto a 2D canvas context at `size`×`size`. Renders the gradient
 * base then a low-opacity geometric motif. Browser-only (needs a real
 * CanvasRenderingContext2D); the geometry it relies on is covered by the pure
 * `gradientEndpoints` test.
 */
export function drawPresetToCanvas(
  ctx: CanvasRenderingContext2D,
  preset: WorkspaceImagePreset,
  size: number,
): void {
  const { x0, y0, x1, y1 } = gradientEndpoints(preset.angle, size);
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, preset.from);
  g.addColorStop(1, preset.to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  ctx.save();
  ctx.lineWidth = Math.max(1, size / 128);
  const light = 'rgba(255,255,255,0.16)';
  const lighter = 'rgba(255,255,255,0.10)';

  switch (preset.motif) {
    case 'orbits': {
      ctx.strokeStyle = light;
      for (const r of [0.32, 0.5, 0.68]) {
        ctx.beginPath();
        ctx.arc(size * 0.72, size * 0.28, size * r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = lighter;
      ctx.beginPath();
      ctx.arc(size * 0.72, size * 0.28, size * 0.12, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'grid': {
      ctx.strokeStyle = lighter;
      const step = size / 6;
      for (let i = 1; i < 6; i++) {
        ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke();
      }
      break;
    }
    case 'wave': {
      ctx.strokeStyle = light;
      for (const off of [0.55, 0.72, 0.89]) {
        ctx.beginPath();
        for (let x = 0; x <= size; x += size / 32) {
          const y = size * off + Math.sin((x / size) * Math.PI * 2) * size * 0.06;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'diagonal': {
      ctx.strokeStyle = lighter;
      const step = size / 8;
      for (let i = -8; i < 16; i++) {
        ctx.beginPath();
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step + size, size);
        ctx.stroke();
      }
      break;
    }
    case 'bloom': {
      ctx.fillStyle = lighter;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        ctx.beginPath();
        ctx.ellipse(size / 2, size / 2, size * 0.42, size * 0.14, a, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'none':
    default:
      break;
  }
  ctx.restore();
}

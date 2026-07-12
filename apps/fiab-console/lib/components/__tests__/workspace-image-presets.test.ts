/**
 * Vitest specs for the workspace-image preset gallery + the shared editor's
 * pure file-validation guard. Pins: every preset is well-formed (unique id,
 * valid hex colors, sane angle/motif), the gradient CSS matches the spec, the
 * canvas gradient endpoints are geometrically correct, and the upload guard
 * enforces raster-only + the 1 MiB cap (mirroring the server store).
 */
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_IMAGE_PRESETS,
  getWorkspaceImagePreset,
  presetGradientCss,
  isHexColor,
  gradientEndpoints,
  validateWorkspaceImageFile,
  MAX_IMAGE_BYTES,
} from '../workspace-image-presets';

describe('workspace-image-presets', () => {
  it('ships a non-empty gallery', () => {
    expect(WORKSPACE_IMAGE_PRESETS.length).toBeGreaterThanOrEqual(8);
  });

  it('has unique ids', () => {
    const ids = WORKSPACE_IMAGE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every preset has valid hex colors, angle, and a known motif', () => {
    const motifs = new Set(['orbits', 'grid', 'wave', 'diagonal', 'bloom', 'none']);
    for (const p of WORKSPACE_IMAGE_PRESETS) {
      expect(isHexColor(p.from), `${p.id} from`).toBe(true);
      expect(isHexColor(p.to), `${p.id} to`).toBe(true);
      expect(p.angle).toBeGreaterThanOrEqual(0);
      expect(p.angle).toBeLessThanOrEqual(360);
      expect(motifs.has(p.motif), `${p.id} motif`).toBe(true);
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it('getWorkspaceImagePreset looks up by id and returns undefined for unknown', () => {
    const first = WORKSPACE_IMAGE_PRESETS[0];
    expect(getWorkspaceImagePreset(first.id)).toEqual(first);
    expect(getWorkspaceImagePreset('nope-not-a-preset')).toBeUndefined();
  });

  it('presetGradientCss embeds the spec colors + angle', () => {
    const p = WORKSPACE_IMAGE_PRESETS[0];
    const css = presetGradientCss(p);
    expect(css).toContain(`${p.angle}deg`);
    expect(css).toContain(p.from);
    expect(css).toContain(p.to);
    expect(css.startsWith('linear-gradient(')).toBe(true);
  });

  it('isHexColor rejects malformed / SVG-ish inputs', () => {
    expect(isHexColor('#fff')).toBe(false);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('#12345g')).toBe(false);
    expect(isHexColor('#123456')).toBe(true);
  });

  it('gradientEndpoints spans the square and is symmetric about the centre', () => {
    const size = 256;
    const { x0, y0, x1, y1 } = gradientEndpoints(135, size);
    // Endpoints are mirror images about the centre (size/2, size/2).
    expect(x0 + x1).toBeCloseTo(size, 5);
    expect(y0 + y1).toBeCloseTo(size, 5);
    // 90deg (points right) → horizontal gradient across the full width.
    const h = gradientEndpoints(90, size);
    expect(h.x0).toBeCloseTo(0, 5);
    expect(h.x1).toBeCloseTo(size, 5);
    expect(h.y0).toBeCloseTo(size / 2, 5);
    expect(h.y1).toBeCloseTo(size / 2, 5);
  });
});

describe('validateWorkspaceImageFile', () => {
  it('accepts a small PNG', () => {
    expect(validateWorkspaceImageFile('image/png', 1024)).toBeNull();
  });

  it('accepts jpeg/gif/webp', () => {
    expect(validateWorkspaceImageFile('image/jpeg', 100)).toBeNull();
    expect(validateWorkspaceImageFile('image/gif', 100)).toBeNull();
    expect(validateWorkspaceImageFile('image/webp', 100)).toBeNull();
  });

  it('rejects SVG (stored-XSS vector)', () => {
    expect(validateWorkspaceImageFile('image/svg+xml', 100)).toMatch(/SVG is not accepted/);
  });

  it('rejects an unknown type', () => {
    expect(validateWorkspaceImageFile('application/pdf', 100)).toMatch(/Unsupported type/);
  });

  it('rejects an over-cap payload', () => {
    expect(validateWorkspaceImageFile('image/png', MAX_IMAGE_BYTES + 1)).toMatch(/maximum is/);
  });

  it('rejects an empty file', () => {
    expect(validateWorkspaceImageFile('image/png', 0)).toMatch(/empty/);
  });
});

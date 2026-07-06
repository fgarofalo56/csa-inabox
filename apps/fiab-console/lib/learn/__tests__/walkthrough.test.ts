/**
 * Visual-walkthrough content model — honest step + screenshot gating.
 *
 * The Learn Hub renders each editor guide as a numbered visual walkthrough via
 * `getWalkthrough(slug)` + `loomStepImageUrl(slug, n)`. Per no-scaffold /
 * no-vaporware, a step may only advertise a screenshot that has ACTUALLY been
 * captured — everything else renders an honest "coming" placeholder. This suite
 * pins that contract so a future change can't silently emit URLs for
 * screenshots that don't exist (a broken-image regression) or fabricate steps.
 */
import { describe, it, expect } from 'vitest';
import {
  getWalkthrough,
  loomStepImageUrl,
  getLearn,
  EDITOR_THUMB_SLUGS,
  EDITOR_STEP_IMAGE_COUNTS,
  LOOM_DOCS_BASE,
} from '@/lib/learn/content';

describe('getWalkthrough', () => {
  it('builds steps from the item\'s authored Learn content (no invented text)', () => {
    const learn = getLearn('lakehouse');
    const wt = getWalkthrough('lakehouse');
    expect(wt).not.toBeNull();
    expect(wt!.length).toBe(learn!.steps!.length);
    // Every caption comes verbatim from an authored step title/string.
    wt!.forEach((step, i) => {
      const raw = learn!.steps![i];
      const caption = typeof raw === 'string' ? raw : raw.title;
      expect(step.caption).toBe(caption);
      expect(step.n).toBe(i + 1);
    });
  });

  it('returns null for an item with no authored Learn content (no empty walkthrough)', () => {
    // A slug with no registry AND no catalog Learn entry → getLearn null → no walkthrough.
    expect(getLearn('___no-such-item-type___')).toBeNull();
    expect(getWalkthrough('___no-such-item-type___')).toBeNull();
  });

  it('attaches a screenshot to step 1 for a captured slug, placeholder beyond', () => {
    const wt = getWalkthrough('lakehouse');
    expect(wt).not.toBeNull();
    // lakehouse is in EDITOR_THUMB_SLUGS → step 1 has the landing screenshot…
    expect(wt![0].hasImage).toBe(true);
    expect(wt![0].imgUrl).toContain(`${LOOM_DOCS_BASE}/fiab/tutorials/img/editor-lakehouse-1.png`);
    // …and any step beyond the captured count is an honest placeholder.
    const captured = EDITOR_STEP_IMAGE_COUNTS['lakehouse'] ?? 1;
    wt!.filter((s) => s.n > captured).forEach((s) => {
      expect(s.hasImage).toBe(false);
      expect(s.imgUrl).toBeUndefined();
    });
  });
});

describe('loomStepImageUrl honesty gate', () => {
  it('emits a URL only within a slug\'s captured step count', () => {
    const captured = EDITOR_STEP_IMAGE_COUNTS['lakehouse'] ?? 1;
    expect(loomStepImageUrl('lakehouse', 1)).toBeDefined();
    expect(loomStepImageUrl('lakehouse', captured + 1)).toBeUndefined();
    expect(loomStepImageUrl('lakehouse', 0)).toBeUndefined();
  });

  it('returns undefined for a slug with no captured screenshot at all', () => {
    // A slug NOT in EDITOR_THUMB_SLUGS has no landing shot → never a URL.
    const notThumbed = 'workshop-app';
    expect(EDITOR_THUMB_SLUGS.has(notThumbed)).toBe(false);
    expect(loomStepImageUrl(notThumbed, 1)).toBeUndefined();
  });
});

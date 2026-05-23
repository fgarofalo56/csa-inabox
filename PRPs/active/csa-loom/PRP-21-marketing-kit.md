# PRP-21 — Marketing Kit

## Context

Internal Microsoft field activation materials. Pitch deck, seller
playbook, demo script, video plan, battlecard, one-pager, federal
account-team variant.

PRD ref: `temp/fiab-prd/10-marketing-workshop.md` §10.1-10.10.

## Goal

Field-ready marketing kit under `docs/fiab/marketing/`. Microsoft
sellers can pitch CSA Loom to federal CIOs / CDOs with confidence.

## Acceptance criteria

- [ ] `docs/fiab/marketing/pitch-deck.md` — 20-slide outline + speaker
  notes; `.pptx` generated from markdown via existing
  `learn/multimedia/presentations/` infra
- [ ] `docs/fiab/marketing/seller-playbook.md` — 15-page playbook
  (qualifying questions, objection handling, pricing guidance per
  AMENDMENTS A4 deferred-pricing note, account-team motion)
- [ ] `docs/fiab/marketing/demo-script.md` — 3 variants (5-min lightning,
  30-min technical, 60-min deep-dive)
- [ ] `docs/fiab/marketing/video-plan.md` — production plan for 11
  videos (~56 minutes total content)
- [ ] `docs/fiab/marketing/battlecard-fabric.md` — one-page side-by-
  side CSA Loom vs Microsoft Fabric Commercial
- [ ] `docs/fiab/marketing/one-pager.md` — single-page front+back
  (PDF generated)
- [ ] `docs/fiab/marketing/federal-pitch.md` — federal account-team
  variant deck
- [ ] All marketing materials use CSA Loom brand throughout
- [ ] All marketing materials comply with [[writing-voice-no-customer-
  framing]] (no customer attribution; generic federal-mission framing)
- [ ] All materials honestly represent the Direct Lake gap, F-SKU
  prohibition in GCC, IL5 v1.1-timing
- [ ] Marketing materials reflect AMENDMENTS A4 — no Marketplace
  pricing slide; instead: "Pay only for Azure consumption; FiaB IP
  is free in v1; pricing model to be defined when Marketplace
  listing lands in a future release"

## Validation gates

- `mkdocs build --strict` clean
- `.pptx` exports render correctly in PowerPoint (test on 3 templates)
- Demo scripts are time-boxed accurately (manual rehearsal)
- Battlecard fits on one page

## Implementation outline

1. Pitch deck markdown (20 slides) + per-slide speaker notes
2. Seller playbook covering the 5 qualifying questions, 10 objection
   handlers, pricing guidance (deferred-model talk track)
3. Demo scripts time-boxed per variant
4. Video production plan: per-video script + storyboard + capture
   environment
5. Battlecard table (PRD §10.5 dimensions)
6. One-pager front + back
7. Federal-specific variant emphasizing FedRAMP / IL4 / IL5 / ITAR /
   CMMC angles

## File changes

7 marketing pages + supporting PPTX templates + storyboards + script
files.

## References

- `temp/fiab-prd/10-marketing-workshop.md` §10.1-10.10
- `temp/fiab-prd/AMENDMENTS.md` §A1, §A4
- Existing `learn/multimedia/presentations/` infrastructure
- Memory: [[writing-voice-no-customer-framing]]

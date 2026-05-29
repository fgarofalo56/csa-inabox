# Compliance — Section 508 / WCAG Accessibility

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


--8<-- "_includes/compliance-disclaimer.md"

> **Scope:** Section 508 of the Rehabilitation Act and **WCAG 2.1 Level AA** compliance for data portals, dashboards, and reporting surfaces built on CSA-in-a-Box. All federal agencies and their contractors must meet these requirements.

---

## Overview

**Section 508** (29 U.S.C. 794d) requires federal agencies to make their electronic and information technology accessible to people with disabilities. Since the 2017 refresh, Section 508 incorporates **WCAG 2.0 Level AA** by reference, and most agencies now target **WCAG 2.1 Level AA** as the practical standard.

This applies to:

- **Federal agencies** — all ICT developed, procured, maintained, or used
- **Federal contractors** — any deliverable intended for agency use
- **Recipients of federal funding** — systems funded by federal grants

For a data platform like CSA-in-a-Box, Section 508 means that every user-facing surface — portals, dashboards, reports, data catalogs, admin consoles — must be perceivable, operable, understandable, and robust for users with visual, auditory, motor, or cognitive disabilities.

---

## Why it matters for data platforms

Data platforms present unique accessibility challenges beyond standard web apps:

- **Charts and visualizations** convey meaning through color and spatial relationships that screen readers cannot parse
- **Complex data tables** with hierarchical headers and dynamic sorting break assistive technology navigation
- **Interactive filters** rely on drag, hover, and multi-select patterns that require keyboard alternatives
- **Real-time dashboards** update without notifying assistive technology users
- **Exported reports** (PDF, Excel) carry their own accessibility obligations

---

## WCAG 2.1 principles

| Principle          | Requirement                                            | CSA-in-a-Box impact                                                                                                    |
| ------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Perceivable**    | Content must be presentable in ways users can perceive | Alt text for all charts, data table alternatives for visualizations, color contrast ratios, captions for video content |
| **Operable**       | UI components must be operable by all users            | Full keyboard navigation, no time-dependent interactions, skip-navigation links, visible focus indicators              |
| **Understandable** | Information and UI operation must be understandable    | Clear form labels, meaningful error messages, consistent navigation patterns, plain-language data descriptions         |
| **Robust**         | Content must be compatible with assistive technologies | Valid HTML semantics, ARIA roles and properties, tested with screen readers (NVDA, JAWS, VoiceOver)                    |

!!! danger "Color alone must never convey meaning"
Data visualizations that rely solely on color to distinguish series, status, or severity violate WCAG 1.4.1 (Use of Color). Always pair color with pattern, shape, label, or texture. This is the single most common accessibility violation in government dashboards.

---

## Power BI accessibility

Power BI is a primary reporting surface for CSA-in-a-Box. Microsoft provides accessibility features, but report authors must use them deliberately.

### Built-in features

- **Alt text** on every visual (static or dynamic via DAX); **tab order** via Selection pane
- **High contrast themes**; **data table view** (Show as a table); **keyboard navigation** (Tab/Enter/Escape)
- **Screen reader support** reads visual titles, alt text, and data points

### Accessible report design best practices

- Set **alt text on every visual** — describe the insight, not the chart type ("Revenue grew 12% YoY" not "Bar chart")
- Define a **logical tab order** following reading order (top-left to bottom-right, grouped by section)
- Use **high-contrast color palettes** — avoid light-gray-on-white or low-saturation combinations
- Provide a **data table page** as an alternative to every dashboard page
- Avoid **custom visuals** unless they declare WCAG compliance; prefer certified visuals
- Test with **Accessibility Checker** in Power BI Desktop before publishing

!!! tip "Dynamic alt text with DAX"
Use DAX expressions in the alt text field to generate meaningful descriptions that update with filter context:
`dax
    "Total revenue is " & FORMAT([Total Revenue], "$#,##0") &
    " for " & SELECTEDVALUE(Date[Year], "all years") &
    ". This represents a " & FORMAT([YoY Growth], "0.0%") & " change."
    `

---

## CSA-in-a-Box portal accessibility

The React-based portal must implement accessibility from the component level up.

### ARIA labels and roles

```tsx
// Accessible data card component
<div role="region" aria-label="Key performance indicators">
  <span aria-label={`Total revenue: ${formatCurrency(revenue)}`}>
    {formatCurrency(revenue)}
  </span>
</div>

// Accessible data table with sortable headers
<table role="grid" aria-label="Monthly enrollment data">
  <thead>
    <tr>
      <th scope="col" aria-sort={sortDir} tabIndex={0}
          onKeyDown={handleSortKeyboard}>Month</th>
    </tr>
  </thead>
</table>
```

### Keyboard navigation and focus

- All interactive elements reachable via **Tab**; **Enter/Space** activates; **Arrow keys** navigate composites; **Escape** closes overlays
- Visible **focus indicator** (minimum 2px solid outline, 3:1 contrast)
- SPA route changes announced via **ARIA live region**; focus moves to **h1** after navigation
- Focus **trapped inside modals** until dismissed; returns to trigger element on close

### Color contrast requirements

| Element                    | Minimum ratio | WCAG criterion |
| -------------------------- | ------------- | -------------- |
| Normal text (< 18pt)       | 4.5:1         | 1.4.3 AA       |
| Large text (>= 18pt bold)  | 3:1           | 1.4.3 AA       |
| UI components and graphics | 3:1           | 1.4.11 AA      |
| Focus indicators           | 3:1           | 2.4.7 AA       |

### Accessible forms

- Every input has a visible `<label>` with `htmlFor` binding
- Required fields use `aria-required="true"` plus a visible indicator (not color alone)
- Validation errors use `aria-describedby` to link error text to the input
- Error summary at form top with links to each invalid field

---

## Testing tools and methodology

### Automated testing

| Tool                       | Where        | What it catches                                |
| -------------------------- | ------------ | ---------------------------------------------- |
| **axe-core**               | Jest / RTL   | ARIA violations, missing labels, contrast (CI) |
| **Lighthouse**             | CI or manual | Accessibility score, common violations         |
| **WAVE**                   | Browser ext  | Visual overlay of errors, structure            |
| **eslint-plugin-jsx-a11y** | ESLint       | JSX accessibility issues at author time        |
| **pa11y**                  | CI pipeline  | Page-level scans with configurable thresholds  |

```bash
# Run axe-core in CI (example with jest-axe)
npm test -- --testPathPattern=accessibility

# Lighthouse accessibility audit from CLI
npx lighthouse https://portal.example.gov \
  --only-categories=accessibility \
  --output=json --output-path=./a11y-report.json
```

### Manual testing

Automated tools catch roughly **30-40%** of accessibility issues. Manual testing is required:

- **Keyboard-only** — navigate every workflow with Tab, Enter, Arrow, Escape
- **Screen readers** — test with NVDA (Windows), JAWS (enterprise), VoiceOver (macOS/iOS)
- **Zoom** — verify layouts at 200% and 400% (WCAG 1.4.10 Reflow)
- **High contrast** — test with Windows High Contrast and forced-colors media query

### VPAT documentation

A **Voluntary Product Accessibility Template (VPAT)** documents conformance against Section 508 / WCAG criteria. Produce a VPAT (ITI 2.4 template, WCAG 2.1 edition) for the portal, Power BI reports, admin console, and public data catalog. Update on each major release.

---

## Dashboard accessibility checklist

Apply this checklist to every dashboard and report before release:

- [ ] Color-blind safe palette used (avoid red/green pairs; use colorbrewer2.org)
- [ ] Data table alternative available for every chart and visualization
- [ ] Alt text set on every visual (descriptive of the insight, not the chart type)
- [ ] All filters and slicers are keyboard-navigable
- [ ] Meaningful tab order defined (logical reading order)
- [ ] Screen reader announcements fire for dynamic content updates (ARIA live regions)
- [ ] Focus indicator visible on every interactive element (minimum 3:1 contrast)
- [ ] No information conveyed by color alone (use patterns, labels, or shapes)
- [ ] Text contrast meets 4.5:1 for normal text and 3:1 for large text
- [ ] Interactive elements have minimum 44x44px touch target
- [ ] Error messages programmatically associated with inputs
- [ ] No auto-playing media (or pause/stop controls provided)
- [ ] Content readable and functional at 200% browser zoom

---

## Common violations

| Issue                                   | Impact                                             | Fix                                                                  |
| --------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| Chart without alt text                  | Screen reader users get no insight from the visual | Add descriptive alt text via Power BI alt text field or `aria-label` |
| Low-contrast text on dashboard          | Users with low vision cannot read values           | Use contrast checker; enforce 4.5:1 minimum in design system tokens  |
| Filter controls not keyboard-accessible | Motor-impaired users cannot change parameters      | Implement `onKeyDown`; use native `<select>` or listbox pattern      |
| Dynamic updates without announcements   | Screen reader users unaware of changes             | Add `aria-live="polite"` region for updates                          |
| Missing form labels                     | Screen reader users cannot identify inputs         | Add `<label>` with `htmlFor` or `aria-label` on every input          |
| Focus trapped or lost after interaction | Keyboard users stranded                            | Manage focus return on modal close; test full keyboard flow          |
| PDF reports not tagged                  | Document inaccessible to screen readers            | Use tagged PDF export; verify with PAC 2024 or Acrobat checker       |
| Data table without header associations  | Cannot associate cells to headers                  | Use `<th scope="col/row">`; avoid `<div>` tables                     |
| Color-only status indicators            | Color-blind users cannot distinguish status        | Add icon, text label, or pattern alongside color                     |

---

## Related

- [FedRAMP Moderate](fedramp-moderate.md) — FedRAMP requires Section 508 for federal deployments
- [Security & Compliance](../best-practices/security-compliance.md)
- Section 508: https://www.section508.gov/
- WCAG 2.1: https://www.w3.org/TR/WCAG21/
- ITI VPAT: https://www.itic.org/policy/accessibility/vpat
- Microsoft ACRs: https://learn.microsoft.com/compliance/regulatory/offering-section-508-vpats
- Power BI accessibility: https://learn.microsoft.com/power-bi/create-reports/desktop-accessibility-overview

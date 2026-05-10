---
title: "Accessibility Guidelines for Interactive Demos"
tags:
  - multimedia
  - demos
---
# ♿ Accessibility Guidelines for Interactive Demos

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![WCAG: 2.1 AA](https://img.shields.io/badge/WCAG-2.1%20AA-blue)
![Priority: High](https://img.shields.io/badge/Priority-High-red)

## 📋 Overview

This guide defines accessibility standards and best practices for all interactive demonstrations and code playgrounds in the CSA-in-a-Box documentation. All interactive components must be accessible to users with disabilities, following WCAG 2.1 Level AA compliance standards.

## 🎯 Accessibility Principles

### POUR Principles

All interactive demos must adhere to the four POUR principles:

1. **Perceivable** - Information must be presentable to users in ways they can perceive
2. **Operable** - User interface components must be operable by all users
3. **Understandable** - Information and operation must be understandable
4. **Robust** - Content must be robust enough to work with current and future technologies

## 🔑 Core Requirements

### Keyboard Navigation

All interactive elements must be fully accessible via keyboard:

#### Required Keyboard Support

```javascript
// Keyboard navigation implementation
class AccessibleComponent {
  setupKeyboardNavigation() {
    this.element.addEventListener('keydown', (e) => {
      switch(e.key) {
        case 'Tab':
          this.handleTabNavigation(e);
          break;
        case 'Enter':
        case ' ': // Space
          this.handleActivation(e);
          break;
        case 'Escape':
          this.handleEscape(e);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight':
          this.handleArrowNavigation(e);
          break;
      }
    });
  }

  handleTabNavigation(event) {
    // Ensure proper tab order
    const focusableElements = this.getFocusableElements();
    // Implement custom tab order if needed
  }

  getFocusableElements() {
    return this.element.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
  }
}
```

#### Focus Management

```javascript
// Focus indicator management
class FocusManager {
  constructor() {
    this.setupFocusIndicators();
    this.setupFocusTrap();
  }

  setupFocusIndicators() {
    // Ensure visible focus indicators
    const style = document.createElement('style');
    style.textContent = `
      :focus {
        outline: 3px solid #0078D4;
        outline-offset: 2px;
      }

      :focus:not(:focus-visible) {
        outline: none;
      }

      :focus-visible {
        outline: 3px solid #0078D4;
        outline-offset: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  setupFocusTrap(containerElement) {
    // Trap focus within modal/dialog
    const focusableElements = containerElement.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    containerElement.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    });
  }
}
```

### Screen Reader Support

#### ARIA Labels and Roles

```html
<!-- Interactive demo container -->
<div role="region" aria-label="Azure Synapse Cost Calculator" id="cost-calculator">
  <!-- Input controls -->
  <div class="input-group">
    <label for="data-volume">
      Data Volume (TB/month)
      <span class="sr-only">Use slider to select data volume between 0 and 100 terabytes</span>
    </label>
    <input
      type="range"
      id="data-volume"
      min="0"
      max="100"
      value="10"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="10"
      aria-valuetext="10 terabytes per month"
      aria-describedby="data-volume-help"
    />
    <output id="data-volume-output" aria-live="polite">10 TB</output>
    <p id="data-volume-help" class="help-text">
      Select the amount of data processed monthly
    </p>
  </div>

  <!-- Results section -->
  <div class="results" role="status" aria-live="polite" aria-atomic="true">
    <h3 id="results-heading">Estimated Monthly Cost</h3>
    <div aria-labelledby="results-heading">
      <p>Total: <span aria-label="$2,350 per month">$2,350</span></p>
    </div>
  </div>

  <!-- Action buttons -->
  <div class="actions">
    <button
      type="button"
      aria-label="Reset calculator to default values"
      aria-describedby="reset-help"
    >
      Reset
    </button>
    <span id="reset-help" class="sr-only">
      This will clear all inputs and restore default values
    </span>
  </div>
</div>
```

#### Live Regions

```javascript
// Announce changes to screen readers
class LiveRegionAnnouncer {
  constructor() {
    this.createLiveRegion();
  }

  createLiveRegion() {
    const liveRegion = document.createElement('div');
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('aria-atomic', 'true');
    liveRegion.className = 'sr-only';
    document.body.appendChild(liveRegion);
    this.liveRegion = liveRegion;
  }

  announce(message, priority = 'polite') {
    this.liveRegion.setAttribute('aria-live', priority);
    this.liveRegion.textContent = message;

    // Clear after announcement
    setTimeout(() => {
      this.liveRegion.textContent = '';
    }, 1000);
  }

  announceError(errorMessage) {
    this.announce(`Error: ${errorMessage}`, 'assertive');
  }

  announceSuccess(successMessage) {
    this.announce(successMessage, 'polite');
  }
}

// Usage example
const announcer = new LiveRegionAnnouncer();
announcer.announce('Cost calculation updated: $2,350 per month');
announcer.announceSuccess('Configuration saved successfully');
announcer.announceError('Invalid data volume. Please enter a value between 0 and 100');
```

### Color and Contrast

#### Minimum Contrast Ratios

- **Normal text**: 4.5:1 minimum
- **Large text** (18pt+): 3:1 minimum
- **UI components**: 3:1 minimum
- **Focus indicators**: 3:1 minimum

#### Color-Blind Friendly Palettes

```css
/* Accessible color palette */
:root {
  /* Primary colors with sufficient contrast */
  --color-primary: #0078D4;        /* Azure Blue */
  --color-primary-dark: #004578;   /* Dark Blue */
  --color-success: #107C10;        /* Green (7.4:1) */
  --color-warning: #CA5010;        /* Orange (4.5:1) */
  --color-error: #D13438;          /* Red (5.9:1) */
  --color-info: #0078D4;           /* Blue (4.5:1) */

  /* Text colors */
  --color-text-primary: #323130;   /* Dark Gray (12.6:1) */
  --color-text-secondary: #605E5C; /* Medium Gray (7.2:1) */
  --color-text-disabled: #A19F9D;  /* Light Gray (3.0:1) */

  /* Background colors */
  --color-bg-light: #FFFFFF;
  --color-bg-gray: #F3F2F1;
  --color-bg-dark: #201F1E;
}

/* Never rely on color alone */
.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.status-indicator::before {
  content: '';
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.status-success {
  color: var(--color-success);
}

.status-success::before {
  background: var(--color-success);
  /* Add pattern for color-blind users */
  background-image:
    repeating-linear-gradient(45deg,
      transparent,
      transparent 2px,
      rgba(255,255,255,0.3) 2px,
      rgba(255,255,255,0.3) 4px);
}

.status-error {
  color: var(--color-error);
}

.status-error::before {
  background: var(--color-error);
  /* Different pattern for errors */
  background-image:
    repeating-linear-gradient(-45deg,
      transparent,
      transparent 2px,
      rgba(255,255,255,0.3) 2px,
      rgba(255,255,255,0.3) 4px);
}
```

### Text and Typography

#### Font Size and Scaling

```css
/* Scalable typography */
html {
  /* Base font size - users can scale */
  font-size: 16px;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto',
               'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans',
               'Helvetica Neue', sans-serif;
  line-height: 1.5;
}

/* Use relative units */
.demo-title {
  font-size: 2rem;    /* 32px at default */
  line-height: 1.2;
}

.demo-content {
  font-size: 1rem;    /* 16px at default */
  line-height: 1.6;
}

.demo-caption {
  font-size: 0.875rem; /* 14px at default */
  line-height: 1.4;
}

/* Support text zoom up to 200% */
@media (min-width: 1920px) {
  html {
    font-size: 18px;
  }
}

/* Ensure content reflows at 320px viewport */
@media (max-width: 320px) {
  .demo-container {
    max-width: 100%;
    overflow-x: auto;
  }
}
```

#### Readable Content

```css
/* Maximum line length for readability */
.demo-description,
.demo-instructions {
  max-width: 75ch; /* Optimal reading width */
  margin-left: auto;
  margin-right: auto;
}

/* Adequate spacing */
p {
  margin-bottom: 1em;
}

h2, h3, h4 {
  margin-top: 1.5em;
  margin-bottom: 0.75em;
}

/* Clear visual hierarchy */
h2 {
  font-size: 1.75rem;
  font-weight: 600;
}

h3 {
  font-size: 1.5rem;
  font-weight: 600;
}

h4 {
  font-size: 1.25rem;
  font-weight: 600;
}
```

## 🖱️ Interactive Elements

### Buttons and Controls

```html
<!-- Accessible button examples -->
<button
  type="button"
  class="btn-primary"
  aria-label="Run Spark query demonstration"
  aria-describedby="run-query-help"
>
  <span aria-hidden="true">▶</span>
  Run Query
</button>
<p id="run-query-help" class="sr-only">
  Execute the PySpark query against sample dataset
</p>

<!-- Toggle button with state -->
<button
  type="button"
  role="switch"
  aria-checked="false"
  aria-label="Enable auto-refresh"
  id="auto-refresh-toggle"
  class="toggle-button"
>
  <span class="toggle-label">Auto-refresh</span>
  <span class="toggle-state" aria-hidden="true">Off</span>
</button>

<script>
// Toggle button behavior
const toggleBtn = document.getElementById('auto-refresh-toggle');
toggleBtn.addEventListener('click', function() {
  const isChecked = this.getAttribute('aria-checked') === 'true';
  this.setAttribute('aria-checked', !isChecked);
  this.querySelector('.toggle-state').textContent = isChecked ? 'Off' : 'On';
  announcer.announce(`Auto-refresh ${isChecked ? 'disabled' : 'enabled'}`);
});
</script>
```

### Form Controls

```html
<!-- Accessible form example -->
<form class="demo-config-form" aria-labelledby="config-form-title">
  <h3 id="config-form-title">Configure Spark Pool</h3>

  <!-- Text input -->
  <div class="form-group">
    <label for="pool-name">
      Pool Name
      <span class="required" aria-label="required">*</span>
    </label>
    <input
      type="text"
      id="pool-name"
      name="poolName"
      required
      aria-required="true"
      aria-describedby="pool-name-help pool-name-error"
      aria-invalid="false"
    />
    <p id="pool-name-help" class="help-text">
      Enter a unique name for the Spark pool (3-15 characters)
    </p>
    <p id="pool-name-error" class="error-text" role="alert" aria-live="assertive">
      <!-- Error message appears here -->
    </p>
  </div>

  <!-- Select dropdown -->
  <div class="form-group">
    <label for="node-size">Node Size</label>
    <select
      id="node-size"
      name="nodeSize"
      aria-describedby="node-size-help"
    >
      <option value="">Select node size</option>
      <option value="small">Small (4 vCores, 32 GB RAM)</option>
      <option value="medium">Medium (8 vCores, 64 GB RAM)</option>
      <option value="large">Large (16 vCores, 128 GB RAM)</option>
    </select>
    <p id="node-size-help" class="help-text">
      Choose node size based on workload requirements
    </p>
  </div>

  <!-- Radio group -->
  <fieldset>
    <legend>Auto-scaling</legend>
    <div class="radio-group">
      <input
        type="radio"
        id="autoscale-enabled"
        name="autoscale"
        value="enabled"
        checked
      />
      <label for="autoscale-enabled">Enabled</label>
    </div>
    <div class="radio-group">
      <input
        type="radio"
        id="autoscale-disabled"
        name="autoscale"
        value="disabled"
      />
      <label for="autoscale-disabled">Disabled</label>
    </div>
  </fieldset>

  <!-- Checkbox -->
  <div class="form-group">
    <input
      type="checkbox"
      id="enable-cache"
      name="enableCache"
    />
    <label for="enable-cache">
      Enable result caching for improved performance
    </label>
  </div>

  <!-- Submit button -->
  <button type="submit" class="btn-primary">
    Create Spark Pool
  </button>
</form>
```

### Modal Dialogs

```javascript
// Accessible modal implementation
class AccessibleModal {
  constructor(modalId) {
    this.modal = document.getElementById(modalId);
    this.openButton = document.querySelector(`[data-modal="${modalId}"]`);
    this.closeButton = this.modal.querySelector('.modal-close');
    this.previousFocus = null;

    this.setup();
  }

  setup() {
    this.openButton.addEventListener('click', () => this.open());
    this.closeButton.addEventListener('click', () => this.close());

    // Close on escape
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      }
    });

    // Close on backdrop click
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });
  }

  open() {
    // Store current focus
    this.previousFocus = document.activeElement;

    // Show modal
    this.modal.style.display = 'block';
    this.modal.setAttribute('aria-hidden', 'false');

    // Trap focus
    const focusableElements = this.modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    }

    // Prevent body scroll
    document.body.style.overflow = 'hidden';

    // Announce to screen readers
    announcer.announce('Dialog opened');
  }

  close() {
    // Hide modal
    this.modal.style.display = 'none';
    this.modal.setAttribute('aria-hidden', 'true');

    // Restore focus
    if (this.previousFocus) {
      this.previousFocus.focus();
    }

    // Restore body scroll
    document.body.style.overflow = '';

    // Announce to screen readers
    announcer.announce('Dialog closed');
  }
}
```

## 📱 Responsive Design

### Touch Targets

```css
/* Minimum touch target size: 44x44 pixels */
.interactive-button,
.demo-control {
  min-width: 44px;
  min-height: 44px;
  padding: 0.75rem 1.5rem;
}

/* Adequate spacing between touch targets */
.button-group .interactive-button {
  margin: 0.5rem;
}

/* Larger targets for critical actions */
.primary-action {
  min-width: 48px;
  min-height: 48px;
  padding: 1rem 2rem;
}
```

### Responsive Breakpoints

```css
/* Mobile-first responsive design */
.demo-container {
  padding: 1rem;
}

/* Tablet */
@media (min-width: 768px) {
  .demo-container {
    padding: 2rem;
  }

  .demo-layout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }
}

/* Desktop */
@media (min-width: 1024px) {
  .demo-container {
    padding: 3rem;
    max-width: 1400px;
    margin: 0 auto;
  }

  .demo-layout {
    grid-template-columns: 1fr 2fr;
  }
}

/* Support orientation changes */
@media (orientation: portrait) {
  .demo-visualization {
    max-height: 60vh;
  }
}

@media (orientation: landscape) {
  .demo-visualization {
    max-height: 80vh;
  }
}
```

## 🧪 Testing Requirements

### Manual Testing Checklist

- [ ] **Keyboard Navigation**
  - [ ] All interactive elements accessible via Tab
  - [ ] Logical tab order
  - [ ] Visible focus indicators
  - [ ] Skip links available
  - [ ] No keyboard traps

- [ ] **Screen Reader Testing**
  - [ ] Test with NVDA (Windows)
  - [ ] Test with JAWS (Windows)
  - [ ] Test with VoiceOver (macOS/iOS)
  - [ ] Test with TalkBack (Android)
  - [ ] All images have alt text
  - [ ] Form labels properly associated
  - [ ] Live regions announce changes

- [ ] **Visual Testing**
  - [ ] Minimum contrast ratios met
  - [ ] Text scalable to 200%
  - [ ] Content reflows at 320px
  - [ ] Color not sole indicator
  - [ ] High contrast mode support

- [ ] **Motor Impairment Testing**
  - [ ] Touch targets ≥44x44px
  - [ ] No time-sensitive interactions
  - [ ] Ample time for interactions
  - [ ] Can cancel accidental actions

### Automated Testing

```javascript
// Automated accessibility testing with axe-core
const { AxePuppeteer } = require('@axe-core/puppeteer');
const puppeteer = require('puppeteer');

async function testAccessibility(url) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.goto(url);
  await page.setBypassCSP(true);

  const results = await new AxePuppeteer(page).analyze();

  console.log(`Accessibility Violations: ${results.violations.length}`);

  results.violations.forEach(violation => {
    console.log(`\n[${violation.impact}] ${violation.id}`);
    console.log(violation.description);
    console.log(`Help: ${violation.helpUrl}`);

    violation.nodes.forEach(node => {
      console.log(`  - ${node.html}`);
    });
  });

  await browser.close();

  return results.violations.length === 0;
}

// Test all interactive demos
const demoUrls = [
  'http://localhost:8000/demos/cost-calculator',
  'http://localhost:8000/demos/query-playground',
  'http://localhost:8000/demos/pipeline-builder'
];

(async () => {
  for (const url of demoUrls) {
    console.log(`\nTesting: ${url}`);
    const passed = await testAccessibility(url);
    console.log(`Result: ${passed ? 'PASSED' : 'FAILED'}`);
  }
})();
```

## 📚 Resources

### WCAG 2.1 Guidelines

- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [Understanding WCAG 2.1](https://www.w3.org/WAI/WCAG21/Understanding/)
- [Techniques for WCAG 2.1](https://www.w3.org/WAI/WCAG21/Techniques/)

### Testing Tools

- **Automated Testing**
  - [axe DevTools](https://www.deque.com/axe/devtools/)
  - [WAVE](https://wave.webaim.org/)
  - [Lighthouse](https://developers.google.com/web/tools/lighthouse)
  - [Pa11y](https://pa11y.org/)

- **Screen Readers**
  - [NVDA](https://www.nvaccess.org/) (Windows)
  - [JAWS](https://www.freedomscientific.com/products/software/jaws/) (Windows)
  - VoiceOver (macOS/iOS - built-in)
  - TalkBack (Android - built-in)

- **Color Contrast**
  - [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
  - [Colour Contrast Analyser](https://www.tpgi.com/color-contrast-checker/)
  - [Accessible Colors](https://accessible-colors.com/)

### Microsoft Resources

- [Microsoft Accessibility Guidelines](https://www.microsoft.com/en-us/accessibility)
- [Inclusive Design Toolkit](https://www.microsoft.com/design/inclusive/)
- [Azure Documentation Accessibility](https://docs.microsoft.com/en-us/azure/accessibility/)

---

## 💬 Feedback

Your feedback helps improve accessibility. Please report issues:

- **Accessibility Barriers**: [Report Barrier](https://github.com/fgarofalo56/csa-inabox-docs/issues/new?labels=accessibility&title=[A11y])
- **Screen Reader Issues**: [Report Issue](https://github.com/fgarofalo56/csa-inabox-docs/issues/new?labels=accessibility,screen-reader)
- **Suggestions**: [Share Ideas](https://github.com/fgarofalo56/csa-inabox-docs/issues/new?labels=enhancement,accessibility)

---

*Last Updated: January 2025 | WCAG Version: 2.1 Level AA*

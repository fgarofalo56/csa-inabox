---
title: "Presentation Accessibility Guide - CSA-in-a-Box"
tags:
  - multimedia
  - presentations
---
# ♿ Presentation Accessibility Guide - CSA-in-a-Box

![Type: Guide](https://img.shields.io/badge/Type-Guide-blue)
![Audience: All](https://img.shields.io/badge/Audience-All-green)
![Importance: Critical](https://img.shields.io/badge/Importance-Critical-red)

## 📋 Overview

Comprehensive guide to creating accessible presentations that comply with WCAG 2.1 Level AA standards and ensure inclusive experiences for all audiences.

## 🎯 Accessibility Principles

### WCAG 2.1 Guidelines

**Perceivable**:
- Content must be presentable to users in ways they can perceive
- Provide text alternatives for non-text content
- Ensure sufficient color contrast
- Make content adaptable to different formats

**Operable**:
- All functionality available via keyboard
- Provide enough time to read and use content
- Design content that doesn't cause seizures
- Help users navigate and find content

**Understandable**:
- Make text readable and understandable
- Make content appear and operate in predictable ways
- Help users avoid and correct mistakes

**Robust**:
- Maximize compatibility with assistive technologies
- Ensure content can be interpreted reliably

## 🎨 Visual Accessibility

### Color Contrast Requirements

**Text Contrast Ratios** (WCAG AA):
- Normal text (< 18pt): 4.5:1 minimum
- Large text (≥ 18pt): 3:1 minimum
- UI components: 3:1 minimum

**Color Contrast Examples**:

```markdown
✅ Good Contrast:
- Black text on white background (21:1)
- Dark blue (#003366) on white (12.6:1)
- White text on dark gray (#333333) (12.6:1)

❌ Poor Contrast:
- Light gray (#CCCCCC) on white (1.6:1)
- Yellow (#FFFF00) on white (1.1:1)
- Light blue (#6699CC) on white (2.9:1)
```

**Tools for Testing**:
- WebAIM Contrast Checker
- Color Oracle (color blindness simulator)
- Chrome DevTools Accessibility panel

### Color Blindness Considerations

**Types of Color Blindness**:
- **Protanopia**: Red-blind (1% of males)
- **Deuteranopia**: Green-blind (1% of males)
- **Tritanopia**: Blue-blind (rare)
- **Achromatopsia**: Complete color blindness (very rare)

**Design Guidelines**:
- Never rely on color alone to convey information
- Use patterns, textures, or icons in addition to color
- Test designs with color blindness simulators
- Avoid problematic color combinations (red/green, blue/yellow)

**Color Palette Recommendations**:

```text
Accessible Color Pairs:
✅ Blue and Orange
✅ Purple and Yellow-Green
✅ Dark Blue and Light Blue
✅ Black and White
✅ Brown and Cyan

Avoid:
❌ Red and Green
❌ Blue and Purple
❌ Light colors on light backgrounds
❌ Dark colors on dark backgrounds
```

### Typography Accessibility

**Font Selection**:
- Use sans-serif fonts for on-screen readability
- Recommended: Arial, Calibri, Verdana, Tahoma
- Minimum font size: 18pt for body text, 24pt for headings
- Avoid decorative or script fonts for body text

**Text Formatting**:
- Line spacing: 1.5x font size minimum
- Paragraph spacing: 2x font size minimum
- Line length: 50-75 characters maximum
- Avoid ALL CAPS for extended text
- Use bold for emphasis, not underline or italics alone

**Dyslexia-Friendly Design**:
- Use OpenDyslexic or similar fonts if available
- Increase letter spacing slightly
- Avoid justified text alignment
- Use short paragraphs and bullet points

## 🔊 Audio and Multimedia Accessibility

### Slide Content

**Text Alternatives**:
- Provide alt text for all images (100-150 characters)
- Describe charts and graphs in speaker notes
- Include data tables as backup for visualizations
- Provide transcripts for embedded videos

**Alt Text Best Practices**:

```markdown
❌ Poor Alt Text:
"Image 1"
"Chart"
"Screenshot"

✅ Good Alt Text:
"Bar chart showing 40% revenue growth in Q3 2024 compared to Q2"
"Architecture diagram depicting data flow from on-premises to Azure Synapse"
"Screenshot of Power BI dashboard displaying real-time sales metrics"
```

### Audio Descriptions

**Presentation Audio**:
- Speak clearly at moderate pace (120-150 words/minute)
- Pause between slides for comprehension
- Describe visual content verbally
- Avoid relying on phrases like "as you can see here"

**Video Content**:
- Provide captions/subtitles for all videos
- Include audio descriptions for visual-only content
- Ensure audio is clear with minimal background noise
- Provide video transcripts

## ⌨️ Keyboard and Navigation Accessibility

### Keyboard Navigation

**Essential Shortcuts**:
- Tab: Move forward through elements
- Shift+Tab: Move backward
- Enter/Space: Activate buttons/links
- Arrow keys: Navigate within groups
- Escape: Close dialogs/menus

**PowerPoint Keyboard Accessibility**:
- F5: Start presentation from beginning
- Shift+F5: Start from current slide
- Ctrl+P: Access pen tools
- W/B: White/black screen
- Number+Enter: Jump to slide number

**Design Considerations**:
- Logical tab order matches visual flow
- All interactive elements keyboard accessible
- Visible focus indicators (outlines, highlights)
- Skip navigation links for long content

### Screen Reader Compatibility

**PowerPoint Accessibility Checker**:
- Use built-in accessibility checker (Alt+R, A, C)
- Fix all errors and warnings
- Verify reading order of slide objects
- Test with actual screen readers

**Screen Reader Best Practices**:
- Use built-in slide layouts (not blank slides)
- Add titles to all slides
- Use heading styles for structure
- Provide meaningful link text
- Group related objects

**Reading Order**:

```text
Correct Reading Order:
1. Slide title
2. Main content headings
3. Body text and bullets
4. Images (via alt text)
5. Charts/graphs (via description)
6. Footer/notes

Common Issues:
❌ Text boxes read in creation order, not visual order
❌ Grouped objects may not be accessible
❌ Floating text boxes without proper order
```

## 📝 Content Accessibility

### Language and Readability

**Plain Language Guidelines**:
- Use short, simple sentences (15-20 words max)
- Define technical terms on first use
- Use active voice when possible
- Break up long paragraphs
- Use bullet points for lists

**Readability Targets**:
- Flesch Reading Ease: 60-70 (Plain English)
- Flesch-Kincaid Grade: 8-10
- Gunning Fog Index: < 12

**Tools**:
- Microsoft Editor (readability statistics)
- Hemingway Editor
- Grammarly

### Slide Structure

**Slide Layout Best Practices**:

```markdown
✅ Accessible Slide Structure:

# Clear Slide Title
- Maximum 6 bullet points per slide
- 6-8 words per bullet
- Consistent formatting
- Adequate white space

Visual hierarchy:
H1 → Slide title (36-44pt)
H2 → Section headings (28-32pt)
Body → Content text (24-28pt)
```

**Avoid**:
- More than one idea per slide
- Walls of text (use speaker notes instead)
- Cluttered layouts with multiple columns
- Inconsistent formatting

### Links and Navigation

**Accessible Link Text**:

```markdown
❌ Poor Link Text:
"Click here"
"Learn more"
"Read this"
"Link"

✅ Good Link Text:
"View Azure Synapse documentation"
"Download implementation guide (PDF, 2.5MB)"
"Contact support team via email"
"Explore interactive demo"
```

**Link Formatting**:
- Underline links or use consistent styling
- Ensure links have sufficient color contrast
- Provide context for external links
- Indicate file types and sizes for downloads

## 🎬 Live Presentation Accessibility

### Presenter Techniques

**Visual Descriptions**:
- Describe all visual content verbally
- Read slide titles and key points aloud
- Explain charts, graphs, and diagrams
- Describe any demonstrations or videos

**Effective Communication**:
- Face the audience when speaking
- Speak clearly and at moderate pace
- Repeat questions from audience
- Provide context for verbal references
- Avoid directional language ("over here", "that one")

**Example Script**:

```text
❌ Inaccessible: "As you can see in this chart here..."

✅ Accessible: "This bar chart on slide 12 shows revenue growth
across four quarters. Q1 shows 2.5 million, Q2 shows 3.1 million,
Q3 shows 4.2 million, and Q4 shows 5.8 million."
```

### Accommodation Requests

**Pre-Event Preparation**:
- Send slides in advance (24-48 hours)
- Provide presentation materials in accessible formats
- Offer alternative formats (large print, Braille, audio)
- Share any videos with captions enabled

**During Event Support**:
- Provide sign language interpreters if requested
- Ensure assistive listening devices available
- Allow service animals
- Provide accessible seating
- Have slides available on participants' devices

### Remote/Hybrid Presentations

**Virtual Meeting Accessibility**:
- Enable live captions/transcription
- Share slides in accessible format via chat
- Use screen sharing with clear visuals
- Provide audio descriptions for visual content
- Record session for later access

**Platform Features**:
- Microsoft Teams: Live captions, immersive reader
- Zoom: Live transcription, keyboard shortcuts
- Webex: Closed captions, high contrast mode

## 🔧 PowerPoint Accessibility Features

### Built-in Accessibility Tools

**Accessibility Checker** (Alt+R, A, C):
- Missing alt text
- Hard-to-read text contrast
- Missing slide titles
- Reading order issues
- Hyperlink text issues

**Accessibility Pane**:
- Errors (must fix): Block access for some users
- Warnings (should fix): Difficult for some users
- Tips (consider fixing): Better organization

### Applying Accessibility Fixes

**Adding Alt Text**:

```text
1. Right-click image → Edit Alt Text
2. Describe the image purpose and content
3. For decorative images, mark as decorative
4. Keep descriptions concise (< 150 characters)
5. Include relevant data from charts/graphs
```

**Setting Reading Order**:

```text
1. View → Selection Pane
2. Drag objects to correct order
3. Top item reads first
4. Test with screen reader
```

**Using Built-in Layouts**:
- Title Slide
- Title and Content
- Section Header
- Two Content
- Comparison
- Blank (use sparingly)

### Accessible Tables

**Table Best Practices**:
- Use simple table structures (avoid merged cells)
- Define header rows
- Provide table descriptions
- Keep tables small and focused
- Consider alternatives for complex tables

**Table Accessibility Checklist**:
- [ ] Header row defined
- [ ] No merged cells
- [ ] Adequate cell padding
- [ ] High contrast borders
- [ ] Alt text describing table content

## 📋 Accessibility Checklist

### Before Creating Presentation

- [ ] Understand audience accessibility needs
- [ ] Choose accessible color palette
- [ ] Select readable fonts
- [ ] Plan for multiple formats (slides, handouts, digital)
- [ ] Prepare speaker notes with descriptions

### During Creation

- [ ] Use built-in slide layouts
- [ ] Add alt text to all images
- [ ] Ensure sufficient color contrast (4.5:1 minimum)
- [ ] Use meaningful slide titles
- [ ] Set proper reading order
- [ ] Make links descriptive
- [ ] Use simple table structures
- [ ] Add captions to videos
- [ ] Avoid relying on color alone

### Before Delivery

- [ ] Run PowerPoint Accessibility Checker
- [ ] Fix all errors and warnings
- [ ] Test with screen reader
- [ ] Verify keyboard navigation
- [ ] Check readability scores
- [ ] Send slides in advance
- [ ] Prepare alternative formats
- [ ] Test with color blindness simulator

### During Presentation

- [ ] Describe visual content verbally
- [ ] Read slide titles and key points
- [ ] Speak clearly at moderate pace
- [ ] Face audience when speaking
- [ ] Repeat audience questions
- [ ] Enable live captions if available
- [ ] Provide breaks for long sessions

### After Presentation

- [ ] Share accessible slide deck
- [ ] Provide session recording with captions
- [ ] Share transcript if available
- [ ] Respond to accommodation requests
- [ ] Gather accessibility feedback

## 🛠️ Testing and Validation

### Automated Testing

**PowerPoint Accessibility Checker**:
- Built-in validation tool
- Identifies common issues
- Provides fix suggestions
- Available in File → Info → Check for Issues

**Third-Party Tools**:
- WAVE Web Accessibility Evaluation Tool
- AChecker
- Pa11y

### Manual Testing

**Screen Reader Testing**:
- NVDA (Windows, free)
- JAWS (Windows, commercial)
- Narrator (Windows, built-in)
- VoiceOver (macOS, built-in)

**Testing Procedure**:

```text
1. Enable screen reader
2. Navigate presentation using Tab key
3. Listen to content read aloud
4. Verify reading order is logical
5. Check all interactive elements accessible
6. Test with eyes closed
7. Document any issues
```

**Color Contrast Testing**:
- WebAIM Contrast Checker
- Color Oracle (simulation)
- Chrome DevTools Accessibility panel
- Stark (Figma/Sketch plugin)

### User Testing

**Include Users with Disabilities**:
- Recruit diverse testers
- Test with real assistive technologies
- Gather qualitative feedback
- Iterate based on findings
- Document accessibility decisions

## 📚 Resources and Standards

### Official Guidelines

- **WCAG 2.1**: Web Content Accessibility Guidelines
- **Section 508**: U.S. federal accessibility requirements
- **EN 301 549**: European accessibility standard
- **ADA**: Americans with Disabilities Act

### Microsoft Resources

- [Microsoft Accessibility](https://www.microsoft.com/en-us/accessibility)
- [PowerPoint Accessibility Best Practices](https://support.microsoft.com/en-us/office/make-your-powerpoint-presentations-accessible)
- [Accessibility Checker Rules](https://support.microsoft.com/en-us/office/rules-for-the-accessibility-checker)

### Tools and Software

**Free Tools**:
- NVDA Screen Reader
- Color Oracle
- WebAIM Contrast Checker
- Microsoft Accessibility Insights

**Commercial Tools**:
- JAWS Screen Reader
- Dragon NaturallySpeaking
- ZoomText

### Training and Certification

- Microsoft Certified: Accessibility Specialist
- IAAP Certified Professional in Accessibility Core Competencies (CPACC)
- Web Accessibility Specialist (WAS)

## 💬 Feedback

Help us improve accessibility in presentations:

- Is this guide comprehensive and helpful?
- What additional accessibility topics should be covered?
- Do you have accessibility success stories to share?
- What tools or techniques work best for your needs?

[Provide Feedback](https://github.com/fgarofalo56/csa-inabox-docs/issues/new?title=[Feedback]+Accessibility-Guide)

## 📖 Related Documentation

- [Brand Guidelines](brand-guidelines.md)
- [Best Practices Guide](best-practices.md)
- [Customization Guide](customization.md)
- [Export Settings Guide](export-settings.md)

---

*Last Updated: January 2025 | Version: 1.0.0*

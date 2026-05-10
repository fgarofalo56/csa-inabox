# 📤 Export Settings Guide - CSA-in-a-Box Presentations

![Type: Guide](https://img.shields.io/badge/Type-Guide-blue)
![Audience: Technical](https://img.shields.io/badge/Audience-Technical-orange)

## 📋 Overview

Comprehensive guide to exporting PowerPoint presentations in various formats with optimal settings for different use cases.

## 📄 PDF Export

### Standard PDF Export

**For Distribution and Printing**:

```text
File → Export → Create PDF/XPS Document

Settings:
- Optimize for: Standard (publishing online and printing)
- Options:
  ✅ All slides (or specify range)
  ✅ Publish what: Slides
  ✅ Include hidden slides (if needed)
  ✅ Create handouts (optional)
  ✅ Frame slides (for clean borders)
```

**Quality Settings**:

| Use Case | DPI | File Size | Quality |
|----------|-----|-----------|---------|
| **Web Viewing** | 96-150 | Small | Good |
| **Standard Print** | 220-300 | Medium | Excellent |
| **Professional Print** | 300-600 | Large | Best |
| **Archive** | 300 | Medium | Best |

### Accessible PDF Export

**Accessibility Options**:

```text
File → Save As → PDF

PDF Options button:
✅ ISO 19005-1 compliant (PDF/A)
✅ Document structure tags for accessibility
✅ Bitmap text when fonts may not be embedded

Document Properties:
- Title: [Presentation Title]
- Author: [Your Name]
- Subject: [Brief Description]
- Keywords: Azure, Synapse, Analytics, CSA
```

**Accessibility Checklist**:
- [ ] All images have alt text in source PPT
- [ ] Proper reading order set
- [ ] Bookmarks from headings enabled
- [ ] Fonts embedded
- [ ] Document properties completed
- [ ] PDF/A compliance for archival

### PDF Handout Options

**Handout Layouts**:

```markdown
Notes Pages:
- 1 slide per page with notes
- Best for: Speaker notes, detailed review
- Page orientation: Portrait
- Include: Slide + notes area

Outline View:
- Text-only export
- Best for: Content review, screen readers
- Preserves heading hierarchy

Handouts (Multiple Slides):
- 2 slides: Large images, detailed content
- 3 slides: Lines for notes on right
- 4 slides: Balanced view
- 6 slides: Compact reference
- 9 slides: Maximum slides per page
```

**Custom Handout Settings**:

```text
Design → Slide Size → Custom Slide Size
Width: 8.5" | Height: 11" (Letter)

Insert → Header & Footer → Notes and Handouts:
- Date
- Header: [Company Name - Confidential]
- Page number
- Footer: [Presentation Title]
```

## 🎥 Video Export

### Standard Video Export

**Create Video Settings**:

```text
File → Export → Create a Video

Quality Options:
1. Ultra HD (4K): 3840×2160
   - Use: Professional production, archives
   - File size: Very large (500MB-2GB)

2. Full HD (1080p): 1920×1080 ✅ RECOMMENDED
   - Use: Standard presentations, web
   - File size: Moderate (100-500MB)

3. HD (720p): 1280×720
   - Use: Limited bandwidth, older devices
   - File size: Small (50-200MB)

Timing Options:
- Don't Use Recorded Timings (manual advance)
- Use Recorded Timings and Narrations
- Seconds spent on each slide: 5.00 (customize)
```

**Video Export Best Practices**:

```markdown
Before Exporting:
✅ Record narration (Slide Show → Record)
✅ Set slide timings
✅ Test animations and transitions
✅ Verify audio quality
✅ Check total duration

Export Settings:
- Quality: Full HD (1080p)
- Timing: Use recorded
- Duration: Review and adjust
- Audio: Include narration
```

### Recording Settings

**Record Slide Show**:

```text
Slide Show → Record Slide Show

Options:
✅ Slide and animation timings
✅ Narrations, ink, and laser pointer
⬜ Camera (unless face-to-screen required)

Recording Tips:
- Use quality microphone
- Quiet environment
- Natural speaking pace (120-150 WPM)
- Pause between slides
- Re-record individual slides if needed
```

**Audio Quality**:

```markdown
Recommended Settings:
- Sample rate: 44.1 kHz
- Bit rate: 192 kbps
- Channels: Mono (smaller file) or Stereo
- Format: AAC or MP3
- Noise reduction: Applied in post-production
```

## 🖼️ Image Export

### Export Slides as Images

**Individual Slide Export**:

```text
File → Save As

Save as type: PNG Portable Network Graphics (*.png)
Or: JPEG File Interchange Format (*.jpg)

Dialog: "Every Slide or Just This One?"
- Every Slide: Creates folder with all slides
- Just This One: Saves current slide only

Resolution: Determined by slide size
Standard: 960×540 for 16:9 at 96 DPI
```

**Bulk Export Settings**:

```text
File → Export → Change File Type

Image File Types:
- PNG: Best quality, transparency, larger files
- JPEG: Smaller files, no transparency, slight quality loss
- TIFF: Lossless, very large files
- GIF: Limited colors, animations, legacy

After selecting type: Save → Every Slide
```

### High-Resolution Image Export

**Increase Export Resolution**:

**Windows Registry Method**:

```text
HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\PowerPoint\Options

Create DWORD value:
Name: ExportBitmapResolution
Value data: [DPI value]

DPI Values:
50: 500×281 (low quality)
96: 960×540 (screen quality - default)
150: 1500×844 (standard print)
220: 2200×1238 (high quality print)
300: 3000×1688 (professional print)
```

**PowerPoint XML Method**:

```xml
<!-- Add to .pptx/ppt/presentation.xml -->
<p:presentationPr>
  <p:extLst>
    <p:ext uri="{05A4C25C-085E-4340-85A3-A5531E510DB2}">
      <p14:discardImageEditData val="0"/>
    </p:ext>
  </p:extLst>
</p:presentationPr>
```

**macOS/Settings Method**:

```text
Preferences → Advanced → Image Size and Quality

Set maximum resolution:
- High fidelity: Maintain original
- Default: 220 PPI
- Email: 96 PPI
```

## 📦 Package Presentation

### Package for CD/USB

**Create Package**:

```text
File → Package Presentation for CD

Options:
- Name CD: [Project Name]
- Files to include:
  ✅ Linked files (fonts, images, videos)
  ✅ Embedded TrueType fonts
  ✅ Create autorun for CD
  ⬜ Inspect for private information

Output:
- Folder: [Presentation Name]
  - PowerPoint file
  - PresentationPackage folder
    - All linked files
    - Fonts
    - ppview.exe (optional viewer)
```

**Package Contents Checklist**:
- [ ] Main presentation file
- [ ] All embedded media
- [ ] Linked files and documents
- [ ] Required fonts (if licensed)
- [ ] README or instructions
- [ ] PowerPoint Viewer (optional)

### Embed vs. Link Decision

**Embed When**:
- File size < 50MB
- Need reliability (no missing links)
- Distributing to others
- Offline presentation

**Link When**:
- File size > 50MB
- Files update frequently
- Sharing via network/SharePoint
- Professional video production

## 🌐 Web and Online Export

### Office 365 / SharePoint

**Publish to SharePoint**:

```text
File → Share → Post to SharePoint

Benefits:
- Version history
- Simultaneous editing
- Browser viewing (Office Online)
- No local installation required
- Automatic updates

Limitations:
- Some animations may not work
- Custom fonts require fallback
- Complex macros unsupported
```

### SlideShare / LinkedIn

**Optimized for SlideShare**:

```markdown
Recommendations:
- Format: PDF (better rendering than PPT)
- File size: < 100MB
- Aspect ratio: 16:9
- Slides: < 100 for best performance
- Text: Readable at small sizes (28pt minimum)
- No animations (not supported)
```

**Export Steps**:

```text
1. Remove animations and transitions
2. Increase font sizes (28pt minimum body text)
3. Simplify complex slides
4. Export as PDF (Standard quality)
5. Verify file size < 100MB
6. Test upload and preview
```

### ODP (OpenDocument) Format

**Export to ODP**:

```text
File → Save As

Save as type: ODP Presentation (*.odp)

Compatibility Notes:
- Supported by LibreOffice, OpenOffice
- Some PowerPoint features may not translate
- Test thoroughly after export
- Fonts may require substitution
- Animations simplified or removed
```

**ODP Compatibility Checklist**:
- [ ] Fonts are standard (Arial, Times, etc.)
- [ ] No complex animations
- [ ] No embedded ActiveX controls
- [ ] No custom themes (use standard)
- [ ] Test in target application

## 🔐 Security and Protection

### Password Protection

**Protect Presentation**:

```text
File → Info → Protect Presentation

Options:
1. Mark as Final
   - Read-only recommendation
   - Can be disabled by recipient
   - Use: Discourage casual editing

2. Encrypt with Password
   - Requires password to open
   - Secure encryption (AES-256)
   - Use: Confidential content

3. Restrict Editing
   - Allow only comments
   - Prevent changes to structure
   - Use: Review process

4. Add Digital Signature
   - Verify author identity
   - Detect modifications
   - Use: Official documents
```

**Password Best Practices**:

```markdown
✅ Strong Password:
- 12+ characters
- Mix of upper, lower, numbers, symbols
- Not dictionary words
- Unique to this file

⚠️ Remember:
- Store password securely (password manager)
- Forgotten passwords are unrecoverable
- Encrypted files cannot be repaired if corrupted
```

### Remove Personal Information

**Inspect Document**:

```text
File → Info → Check for Issues → Inspect Document

Remove:
✅ Comments and annotations
✅ Document properties and personal information
✅ Custom XML data
✅ Headers and footers (review carefully)
✅ Hidden slides
✅ Invisible on-slide content
✅ Off-slide content
✅ Presentation notes

Keep:
⬜ Embedded documents
⬜ Macros (if needed)
```

## ⚙️ Advanced Export Settings

### Compression and Optimization

**Compress Pictures**:

```text
Select image → Picture Format → Compress Pictures

Options:
✅ Apply only to this picture (or all)
✅ Delete cropped areas of pictures

Target output:
- Email (96 PPI): Web sharing
- Print (220 PPI): Standard documents
- Use document resolution (default)
- Do not compress: Maintain original

Compression saves 20-80% file size
```

**Optimize Media**:

```text
File → Info → Media Size and Performance

Options:
1. Full HD (1080p): Highest quality
2. HD (720p): Good quality, smaller
3. Standard (480p): Compatibility

Result:
- Reduces file size significantly
- Maintains acceptable quality
- Embeds optimized version
- Original quality recoverable
```

### File Format Compatibility

**Save As Older Versions**:

```text
File → Save As

PowerPoint Presentation (*.pptx): Office 2007+
PowerPoint 97-2003 Presentation (*.ppt): Legacy

Compatibility Mode:
- Some features disabled
- Reduced file size
- Better compatibility
- Test on target system
```

**Compatibility Checker**:

```text
File → Info → Check for Issues → Check Compatibility

Reviews:
- Unsupported features for older versions
- Elements that will be modified
- Functionality that will be lost
- Recommendations for fixes
```

## 📋 Export Checklists

### Pre-Export Checklist

**General**:
- [ ] All content finalized
- [ ] Spell check completed
- [ ] Links tested and working
- [ ] Animations reviewed
- [ ] Fonts embedded (if distributing)
- [ ] Images optimized
- [ ] File name appropriate
- [ ] Metadata updated

**Accessibility**:
- [ ] Alt text added to images
- [ ] Color contrast verified
- [ ] Accessibility checker passed
- [ ] Reading order set
- [ ] Slide titles present

### Post-Export Verification

**Quality Check**:
- [ ] File opens correctly
- [ ] All content visible
- [ ] Fonts display properly
- [ ] Images render correctly
- [ ] Links functional (PDFs)
- [ ] Animations work (videos)
- [ ] Audio plays (if included)
- [ ] File size reasonable

**Distribution**:
- [ ] Tested on target platform
- [ ] Shared via appropriate method
- [ ] Permissions set correctly
- [ ] Recipients can access
- [ ] Feedback mechanism in place

## 💬 Feedback

Questions about export settings?

[Get Help](https://github.com/fgarofalo56/csa-inabox-docs/issues/new?title=[Help]+Export-Settings)

## 📖 Related Documentation

- [Best Practices](best-practices.md)
- [Accessibility Guide](accessibility.md)
- [Customization Guide](customization.md)
- [Brand Guidelines](brand-guidelines.md)

---

*Last Updated: January 2025 | Version: 1.0.0*

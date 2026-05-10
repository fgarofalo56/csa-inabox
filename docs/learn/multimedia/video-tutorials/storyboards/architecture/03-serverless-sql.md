# Serverless SQL Architecture Storyboard

![Status: Planning](https://img.shields.io/badge/Status-Planning-blue)
![Type: Storyboard](https://img.shields.io/badge/Type-Storyboard-purple)

## Overview

Storyboard for Serverless SQL architecture video showing query execution flow, cost optimization, and performance patterns.

## Visual Sequences

### Sequence 1: Serverless vs Dedicated (0:00 - 1:00)

**Split Screen Comparison**:

```
┌─────────────────────┬─────────────────────┐
│   Serverless SQL    │   Dedicated SQL     │
├─────────────────────┼─────────────────────┤
│ Pay per query       │ Provisioned DWUs    │
│ Auto-scaling        │ Manual scaling      │
│ Data in Data Lake   │ Data in SQL Pool    │
│ Exploration         │ Production          │
└─────────────────────┴─────────────────────┘
```

**Animation**:
- Comparison table builds row by row
- Icons represent each feature
- Checkmarks and X marks for availability

### Sequence 2: Query Execution Flow (1:00 - 2:30)

**Visual Flow**:

```
User Query
    ↓
Query Optimizer
    ↓
Execution Plan
    ↓
Data Lake Files
    ↓
Result Set
```

**Animation**:
- SQL query types in
- Optimizer analyzes (gear spinning)
- Execution plan branches out
- Data flows from lake
- Results table populates

### Sequence 3: Cost Calculation Animation (2:30 - 3:30)

**Visual**: Interactive calculator

```
Data Scanned: [100 GB slider]
Price per TB: $5.00
───────────────────
Total Cost: $0.50
```

**Animation**:
- Slider adjusts data scanned
- Cost updates in real-time
- Comparison with different queries
- Optimization tips appear

### Sequence 4: Partition Pruning Demo (3:30 - 4:30)

**Before/After Visualization**:

**Before** (Scans all data):
```
[■■■■■■■■■■] 1000 files scanned
Cost: $5.00
```

**After** (Partition pruning):
```
[■■________] 200 files scanned
Cost: $1.00
```

**Animation**:
- Files highlight as scanned
- Cost meter decreases
- Performance improvement badge

### Sequence 5: File Format Impact (4:30 - 5:30)

**Visual**: Bar chart race

```
CSV:     [████████████████] 1000 MB
JSON:    [████████████____] 800 MB
Parquet: [████____________] 100 MB
Delta:   [███_____________] 95 MB
```

**Animation**:
- Bars race to show compression
- File sizes update dynamically
- Performance metrics appear

## Visual Style

### Color Palette
- Query text: #1E90FF (blue)
- Data Lake: #20B2AA (teal)
- Cost savings: #32CD32 (green)
- Warnings: #FFA500 (orange)

### Typography
- Code: Cascadia Code, 18px
- Labels: Segoe UI, 20px
- Headers: Segoe UI Bold, 36px

## Production Assets

- [ ] Query execution flowchart
- [ ] Cost calculator UI
- [ ] File scanning animation
- [ ] Partition diagram
- [ ] Format comparison chart
- [ ] Performance badges

## Timing

- Total duration: 5:30
- Opening: 0:30
- Main content: 4:00
- Summary: 1:00

## Related Content

- [Foundation Storyboard](01-foundation.md)
- [Serverless SQL Script](../scripts/architecture/03-serverless-sql.md)

---

*Last Updated: January 2025*

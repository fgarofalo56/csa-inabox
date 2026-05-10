# Data Lake Architecture Storyboard

![Status: Planning](https://img.shields.io/badge/Status-Planning-blue)
![Type: Storyboard](https://img.shields.io/badge/Type-Storyboard-purple)

## Overview

Visual storyboard for the Data Lake Architecture video, focusing on medallion architecture visualization and data flow animations.

## Key Visual Sequences

### Sequence 1: Medallion Architecture (0:00 - 2:00)

**Visual Concept**: Three-tier pyramid

```
        ┌─────────┐
        │  Gold   │ ← Business ready
        ├─────────┤
        │ Silver  │ ← Cleansed
        ├─────────┤
        │ Bronze  │ ← Raw
        └─────────┘
```

**Animation Flow**:
1. Data flows into Bronze (raw files appear)
2. Transformation to Silver (data cleaning animation)
3. Aggregation to Gold (business metrics appear)
4. Power BI connects to Gold layer

**Color Scheme**:
- Bronze: #CD7F32 (copper)
- Silver: #C0C0C0 (silver)
- Gold: #FFD700 (gold)

### Sequence 2: Partitioning Strategy (2:00 - 3:30)

**Visual**: Folder tree animation

```
sales/
  year=2024/
    month=01/
      day=01/
        ← Files appear here
```

**Animation**:
- Folders expand from root
- Files populate dynamically
- Highlight partition pruning benefit

### Sequence 3: File Format Comparison (3:30 - 4:30)

**Visual**: Side-by-side comparison

| CSV | Parquet | Delta |
|-----|---------|-------|
| 1GB | 100MB | 95MB |
| Slow | Fast | Fastest |
| No schema | Schema | Schema + ACID |

**Animation**:
- Bar chart showing size difference
- Performance metrics appear
- Feature checkboxes animate in

### Sequence 4: Security Layers (4:30 - 5:30)

**Visual**: Hierarchical security diagram

```
Storage Account
  └─ RBAC (Role assignments)
      └─ Container
          └─ ACLs (File/folder permissions)
              └─ SAS tokens (Temporary access)
```

**Animation**:
- Security shields appear at each layer
- Lock icons indicate protection level
- User personas show different access levels

## Production Notes

### Required Assets
- [ ] Medallion pyramid 3D model
- [ ] Folder tree animation
- [ ] File format icons
- [ ] Performance charts
- [ ] Security shield graphics
- [ ] Data flow particles

### Animation Timing
- Medallion build: 5 seconds
- Data flow loop: 3 seconds continuous
- Folder expansion: 2 seconds
- Chart builds: 1.5 seconds each

## Related Content

- [Foundation Storyboard](01-foundation.md)
- [Data Lake Script](../scripts/architecture/02-data-lake.md)

---

*Last Updated: January 2025*

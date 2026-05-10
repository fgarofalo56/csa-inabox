---
title: "Row-Level Security Implementation"
description: "Implement fine-grained access control with Unity Catalog row filters."
tags:
  - implementation
  - databricks
---
# 🔒 Row-Level Security Implementation

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)

Implement fine-grained access control with Unity Catalog row filters.

---

## 🎯 Overview

Row-level security (RLS) restricts data access at the row level based on user identity or group membership.

---

## 🔧 Implementation

### Step 1: Create Row Filter Function

```sql
-- Create function to filter by user's region
CREATE OR REPLACE FUNCTION sales.region_filter(region STRING)
RETURNS BOOLEAN
RETURN (
    CASE
        -- Admins see all regions
        WHEN is_account_group_member('admin_group') THEN true
        -- Regional users see only their region
        WHEN is_account_group_member('na_sales') AND region = 'North America' THEN true
        WHEN is_account_group_member('eu_sales') AND region = 'Europe' THEN true
        WHEN is_account_group_member('apac_sales') AND region = 'Asia Pacific' THEN true
        ELSE false
    END
);
```

### Step 2: Apply Row Filter to Table

```sql
-- Apply row filter
ALTER TABLE sales.orders
SET ROW FILTER sales.region_filter ON (region);

-- Verify filter is applied
DESCRIBE TABLE EXTENDED sales.orders;
```

### Step 3: Create Column Mask

```sql
-- Mask PII columns
CREATE OR REPLACE FUNCTION sales.mask_email(email STRING)
RETURNS STRING
RETURN (
    CASE
        WHEN is_account_group_member('pii_access') THEN email
        ELSE CONCAT(LEFT(email, 2), '***@', SPLIT(email, '@')[1])
    END
);

-- Apply column mask
ALTER TABLE sales.customers
ALTER COLUMN email SET MASK sales.mask_email;
```

---

## 🧪 Testing

```sql
-- Test as different users
SELECT current_user();
SELECT * FROM sales.orders LIMIT 10;

-- Verify row filter is working
SELECT region, COUNT(*) FROM sales.orders GROUP BY region;
```

---

## 📚 Related Documentation

- [Unity Catalog External Locations](unity-catalog-external-locations.md)
- [Delta Sharing Setup](delta-sharing-setup.md)
- Security Best Practices

---

*Last Updated: January 2025*

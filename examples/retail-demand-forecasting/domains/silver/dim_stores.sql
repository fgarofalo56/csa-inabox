-- ==========================================================================
-- Dimension Model: Stores
-- Provides store attributes including region, format, and size tier.
-- Note: This model uses a static seed; replace with a source reference
--       when connected to a live store-master system.
-- ==========================================================================

{{ config(
    materialized='view',
    schema='silver'
) }}

SELECT * FROM (VALUES
    ('STR-001', 'Downtown Metro',     'Northeast', 'NY', 'Urban',    'Large',  45000),
    ('STR-002', 'Suburban Plaza',     'Northeast', 'NJ', 'Suburban', 'Medium', 28000),
    ('STR-003', 'Mall Anchor',        'Southeast', 'FL', 'Mall',     'Large',  52000),
    ('STR-004', 'Highway Outlet',     'Southeast', 'GA', 'Outlet',   'Small',  15000),
    ('STR-005', 'Neighborhood Market','Midwest',   'IL', 'Urban',    'Small',  12000),
    ('STR-006', 'Big-Box West',       'West',      'CA', 'Suburban', 'Large',  60000),
    ('STR-007', 'Coastal Express',    'West',      'WA', 'Urban',    'Medium', 22000),
    ('STR-008', 'Central Warehouse',  'Midwest',   'TX', 'Suburban', 'Large',  48000)
) AS t(store_id, store_name, region, state, format, size_tier, sqft)

-- ==========================================================================
-- Dimension Model: Merchants
-- Derives merchant risk categories from MCC codes and transaction patterns.
-- ==========================================================================

{{ config(
    materialized='view',
    schema='silver'
) }}

WITH mcc_reference AS (
    -- Static MCC-to-risk mapping
    -- In production this would be a maintained reference table
    SELECT * FROM (VALUES
        ('5411', 'Grocery Stores',                 'low'),
        ('5541', 'Service Stations / Gas',         'low'),
        ('5812', 'Restaurants',                    'low'),
        ('5912', 'Drug Stores / Pharmacies',       'low'),
        ('5311', 'Department Stores',              'low'),
        ('5999', 'Miscellaneous Retail',           'medium'),
        ('5944', 'Jewelry Stores',                 'medium'),
        ('5732', 'Electronics Stores',             'medium'),
        ('6012', 'Financial Institutions',         'medium'),
        ('4829', 'Wire Transfers / Money Orders',  'high'),
        ('6051', 'Quasi-Cash / Crypto Exchanges',  'high'),
        ('7995', 'Gambling / Casinos',             'high'),
        ('5933', 'Pawn Shops',                     'high'),
        ('7801', 'Online Gambling',                'high')
    ) AS t(merchant_category_code, mcc_description, risk_category)
),

merchant_stats AS (
    SELECT
        merchant_category_code,
        COUNT(*)                                        AS total_transactions,
        SUM(CASE WHEN amount > 5000 THEN 1 ELSE 0 END) AS high_value_count,
        ROUND(AVG(amount), 2)                           AS avg_transaction_amount
    FROM {{ ref('stg_transactions') }}
    GROUP BY merchant_category_code
)

SELECT
    r.merchant_category_code,
    r.mcc_description,
    r.risk_category,
    COALESCE(ms.total_transactions, 0)                  AS total_transactions,
    COALESCE(ms.high_value_count, 0)                    AS high_value_count,
    COALESCE(ms.avg_transaction_amount, 0)              AS avg_transaction_amount,
    CURRENT_TIMESTAMP()                                 AS updated_at

FROM mcc_reference r
LEFT JOIN merchant_stats ms
    ON r.merchant_category_code = ms.merchant_category_code

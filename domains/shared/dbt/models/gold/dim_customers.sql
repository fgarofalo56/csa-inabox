-- materialized='table': Dimension table — small dataset, SCD Type 1
-- full rebuild ensures all attribute changes are captured.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'customers', 'dimension']
  )
}}

/*
  Gold: Customer dimension (SCD Type 1).

  Flattened customer attributes for star-schema joins.  Gold filters to
  valid Silver rows only.  Invalid records remain in Silver with
  ``is_valid = false`` for monitoring.
*/

WITH customers AS (
    SELECT * FROM {{ ref('slv_customers') }}
    WHERE is_valid = TRUE
),

final AS (
    SELECT
        customer_sk,
        customer_id,
        first_name,
        last_name,
        CONCAT(first_name, ' ', last_name) AS full_name,
        email,
        phone,
        address_line1,
        address_line2,
        city,
        state_code,
        postal_code,
        country_code,

        -- Derived attributes
        CASE
            WHEN country_code = 'US' THEN
                CASE
                    WHEN state_code IN ('CA', 'WA', 'OR', 'CO', 'AZ', 'NV', 'UT', 'ID', 'MT', 'WY', 'NM', 'HI', 'AK') THEN 'WEST'
                    WHEN state_code IN ('TX', 'FL', 'GA', 'NC', 'SC', 'VA', 'TN', 'AL', 'MS', 'LA', 'AR', 'KY', 'WV', 'OK', 'MD', 'DE', 'DC') THEN 'SOUTH'
                    WHEN state_code IN ('IL', 'OH', 'MI', 'IN', 'WI', 'MN', 'IA', 'MO', 'ND', 'SD', 'NE', 'KS') THEN 'CENTRAL'
                    ELSE 'EAST'
                END
            ELSE 'INTERNATIONAL'
        END AS region,

        created_at AS customer_since,
        updated_at AS last_updated,
        current_timestamp() AS _dbt_refreshed_at
    FROM customers
)

SELECT * FROM final

{{ config(
    materialized='incremental',
    unique_key='crop_yield_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'crop_yields', 'cleaned']
) }}

WITH base AS (
    SELECT * FROM {{ ref('brz_crop_yields') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            state_fips_code,
            county_code,
            commodity_desc,
            CAST(year as STRING),
            data_item
        )) as crop_yield_sk,

        -- Geographic standardization
        state_fips_code,
        state_code,
        UPPER(TRIM(state_name)) as state_name,
        county_code,
        COALESCE(UPPER(TRIM(county_name)), 'UNKNOWN') as county_name,

        -- Time dimension
        year,
        reference_period_desc,

        -- Commodity standardization
        CASE
            WHEN UPPER(commodity_desc) LIKE '%CORN%' AND UPPER(commodity_desc) NOT LIKE '%POPCORN%' THEN 'CORN'
            WHEN UPPER(commodity_desc) LIKE '%SOYBEAN%' THEN 'SOYBEANS'
            WHEN UPPER(commodity_desc) LIKE '%WHEAT%' THEN 'WHEAT'
            WHEN UPPER(commodity_desc) LIKE '%COTTON%' THEN 'COTTON'
            WHEN UPPER(commodity_desc) LIKE '%RICE%' THEN 'RICE'
            WHEN UPPER(commodity_desc) LIKE '%BARLEY%' THEN 'BARLEY'
            WHEN UPPER(commodity_desc) LIKE '%OATS%' THEN 'OATS'
            WHEN UPPER(commodity_desc) LIKE '%HAY%' THEN 'HAY'
            ELSE UPPER(TRIM(commodity_desc))
        END as commodity,

        commodity_desc as commodity_original,
        class_desc,
        prodn_practice_desc,
        util_practice_desc,
        statisticcat_desc,
        data_item,
        domain_desc,

        -- Measurement standardization
        CASE
            WHEN value ~ '^[0-9]+\.?[0-9]*$'
            THEN CAST(value as DECIMAL(18,2))
            ELSE NULL
        END as value_numeric,

        value as value_original,
        unit_desc,

        -- Derived metrics based on data_item
        CASE
            WHEN UPPER(data_item) LIKE '%YIELD%'
            THEN CAST(value as DECIMAL(10,2))
            ELSE NULL
        END as yield_per_acre,

        CASE
            WHEN UPPER(data_item) LIKE '%PRODUCTION%'
            THEN CAST(value as BIGINT)
            ELSE NULL
        END as production_amount,

        CASE
            WHEN UPPER(data_item) LIKE '%ACRES PLANTED%'
            THEN CAST(value as BIGINT)
            ELSE NULL
        END as planted_acres,

        CASE
            WHEN UPPER(data_item) LIKE '%ACRES HARVESTED%'
            THEN CAST(value as BIGINT)
            ELSE NULL
        END as harvested_acres,

        -- Quality measures
        cv_pct,

        -- Data quality assessment
        CASE
            WHEN value_numeric IS NULL THEN FALSE
            WHEN yield_per_acre IS NOT NULL AND yield_per_acre < 0 THEN FALSE
            WHEN production_amount IS NOT NULL AND production_amount < 0 THEN FALSE
            WHEN planted_acres IS NOT NULL AND planted_acres < 0 THEN FALSE
            WHEN harvested_acres IS NOT NULL AND harvested_acres < 0 THEN FALSE
            -- Logical validation: harvested <= planted
            WHEN planted_acres IS NOT NULL AND harvested_acres IS NOT NULL
                 AND harvested_acres > planted_acres * 1.1 THEN FALSE  -- Allow 10% tolerance for data errors
            ELSE TRUE
        END as is_valid,

        COALESCE(validation_errors,
            CASE
                WHEN value_numeric IS NULL THEN 'Non-numeric value'
                WHEN yield_per_acre IS NOT NULL AND yield_per_acre < 0 THEN 'Negative yield'
                WHEN production_amount IS NOT NULL AND production_amount < 0 THEN 'Negative production'
                WHEN planted_acres IS NOT NULL AND planted_acres < 0 THEN 'Negative planted acres'
                WHEN harvested_acres IS NOT NULL AND harvested_acres < 0 THEN 'Negative harvested acres'
                WHEN planted_acres IS NOT NULL AND harvested_acres IS NOT NULL
                     AND harvested_acres > planted_acres * 1.1 THEN 'Harvested > Planted acres'
                ELSE NULL
            END
        ) as validation_errors,

        -- Metadata
        source_system,
        ingestion_timestamp,
        load_time,
        freq_desc,
        begin_code,
        end_code,
        group_desc,
        short_desc,
        sector_desc,
        record_hash,
        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM base
),

-- Calculate additional analytical fields
enriched AS (
    SELECT
        *,

        -- Calculate efficiency metrics where applicable
        CASE
            WHEN planted_acres IS NOT NULL AND harvested_acres IS NOT NULL AND planted_acres > 0
            THEN ROUND(harvested_acres::DECIMAL / planted_acres::DECIMAL * 100, 2)
            ELSE NULL
        END as harvest_efficiency_pct,

        -- Calculate production per planted acre
        CASE
            WHEN production_amount IS NOT NULL AND planted_acres IS NOT NULL AND planted_acres > 0
            THEN ROUND(production_amount::DECIMAL / planted_acres::DECIMAL, 2)
            ELSE NULL
        END as production_per_planted_acre,

        -- Outlier detection for yield (using historical average)
        CASE
            WHEN yield_per_acre IS NOT NULL
            THEN CASE
                WHEN ABS(yield_per_acre - AVG(yield_per_acre) OVER (
                    PARTITION BY commodity, state_code
                    ORDER BY year ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING
                )) / NULLIF(STDDEV(yield_per_acre) OVER (
                    PARTITION BY commodity, state_code
                    ORDER BY year ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING
                ), 0) > {{ var('yield_outlier_threshold') }}
                THEN TRUE
                ELSE FALSE
            END
            ELSE FALSE
        END as is_yield_outlier

    FROM standardized
)

SELECT * FROM enriched
WHERE is_valid = TRUE
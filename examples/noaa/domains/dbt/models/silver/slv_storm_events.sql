{{ config(
    materialized='incremental',
    unique_key='storm_event_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'storm_events', 'cleaned'],
    on_schema_change='fail'
) }}

{#
    Silver layer: Standardized storm events with damage normalization.

    Transforms raw NCEI Storm Events data by:
      - Parsing damage strings ("25K", "1.5M") into numeric USD values
      - Normalizing damages to current-year dollars using CPI adjustment
      - Standardizing event type names to a controlled vocabulary
      - Calculating event duration from begin/end timestamps
      - Assigning season categories for seasonal analysis
      - Deriving total casualties and total damage metrics
      - Computing warning lead time where available

    Source: brz_storm_events (Bronze layer)
#}

WITH valid_bronze AS (
    SELECT * FROM {{ ref('brz_storm_events') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Parse damage strings: "25K" → 25000, "1.5M" → 1500000, "0.00K" → 0
parsed AS (
    SELECT
        *,

        -- Parse property damage
        CASE
            WHEN UPPER(damage_property_raw) LIKE '%B'
                THEN CAST(REGEXP_EXTRACT(damage_property_raw, '([0-9.]+)', 1) AS DECIMAL(18,2)) * 1000000000
            WHEN UPPER(damage_property_raw) LIKE '%M'
                THEN CAST(REGEXP_EXTRACT(damage_property_raw, '([0-9.]+)', 1) AS DECIMAL(18,2)) * 1000000
            WHEN UPPER(damage_property_raw) LIKE '%K'
                THEN CAST(REGEXP_EXTRACT(damage_property_raw, '([0-9.]+)', 1) AS DECIMAL(18,2)) * 1000
            WHEN damage_property_raw ~ '^[0-9.]+$'
                THEN CAST(damage_property_raw AS DECIMAL(18,2))
            ELSE 0
        END AS damage_property_usd,

        -- Parse crop damage
        CASE
            WHEN UPPER(damage_crops_raw) LIKE '%B'
                THEN CAST(REGEXP_EXTRACT(damage_crops_raw, '([0-9.]+)', 1) AS DECIMAL(18,2)) * 1000000000
            WHEN UPPER(damage_crops_raw) LIKE '%M'
                THEN CAST(REGEXP_EXTRACT(damage_crops_raw, '([0-9.]+)', 1) AS DECIMAL(18,2)) * 1000000
            WHEN UPPER(damage_crops_raw) LIKE '%K'
                THEN CAST(REGEXP_EXTRACT(damage_crops_raw, '([0-9.]+)', 1) AS DECIMAL(18,2)) * 1000
            WHEN damage_crops_raw ~ '^[0-9.]+$'
                THEN CAST(damage_crops_raw AS DECIMAL(18,2))
            ELSE 0
        END AS damage_crops_usd

    FROM valid_bronze
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            event_id,
            state,
            CAST(begin_date AS STRING)
        )) AS storm_event_sk,

        event_id,
        episode_id,

        -- Standardize event type to controlled vocabulary
        CASE
            WHEN event_type LIKE '%TORNADO%' THEN 'TORNADO'
            WHEN event_type LIKE '%THUNDERSTORM WIND%' OR event_type LIKE '%TSTM WIND%' THEN 'THUNDERSTORM_WIND'
            WHEN event_type LIKE '%HAIL%' THEN 'HAIL'
            WHEN event_type LIKE '%FLASH FLOOD%' THEN 'FLASH_FLOOD'
            WHEN event_type LIKE '%FLOOD%' AND event_type NOT LIKE '%FLASH%' THEN 'FLOOD'
            WHEN event_type LIKE '%HURRICANE%' OR event_type LIKE '%TYPHOON%' THEN 'HURRICANE'
            WHEN event_type LIKE '%TROPICAL STORM%' THEN 'TROPICAL_STORM'
            WHEN event_type LIKE '%WINTER STORM%' THEN 'WINTER_STORM'
            WHEN event_type LIKE '%BLIZZARD%' THEN 'BLIZZARD'
            WHEN event_type LIKE '%ICE STORM%' THEN 'ICE_STORM'
            WHEN event_type LIKE '%HEAVY SNOW%' THEN 'HEAVY_SNOW'
            WHEN event_type LIKE '%HEAVY RAIN%' THEN 'HEAVY_RAIN'
            WHEN event_type LIKE '%HIGH WIND%' THEN 'HIGH_WIND'
            WHEN event_type LIKE '%STRONG WIND%' THEN 'STRONG_WIND'
            WHEN event_type LIKE '%WILDFIRE%' OR event_type LIKE '%WILD%FIRE%' THEN 'WILDFIRE'
            WHEN event_type LIKE '%DROUGHT%' THEN 'DROUGHT'
            WHEN event_type LIKE '%EXTREME COLD%' OR event_type LIKE '%WIND CHILL%' THEN 'EXTREME_COLD'
            WHEN event_type LIKE '%EXCESSIVE HEAT%' OR event_type LIKE '%HEAT%' THEN 'EXCESSIVE_HEAT'
            WHEN event_type LIKE '%LIGHTNING%' THEN 'LIGHTNING'
            WHEN event_type LIKE '%RIP CURRENT%' THEN 'RIP_CURRENT'
            WHEN event_type LIKE '%STORM SURGE%' THEN 'STORM_SURGE'
            WHEN event_type LIKE '%COASTAL FLOOD%' THEN 'COASTAL_FLOOD'
            ELSE UPPER(REPLACE(event_type, ' ', '_'))
        END AS event_type_std,

        event_type AS event_type_original,

        -- Temporal fields
        begin_date,
        end_date,
        event_year,
        event_month,

        -- Assign meteorological season
        CASE
            WHEN event_month IN (12, 1, 2) THEN 'WINTER'
            WHEN event_month IN (3, 4, 5) THEN 'SPRING'
            WHEN event_month IN (6, 7, 8) THEN 'SUMMER'
            WHEN event_month IN (9, 10, 11) THEN 'FALL'
        END AS event_season,

        -- Event duration in hours
        CASE
            WHEN begin_date IS NOT NULL AND end_date IS NOT NULL
            THEN ROUND(
                CAST(DATEDIFF(end_date, begin_date) AS DECIMAL(10,2)) * 24
                , 1)
            ELSE NULL
        END AS duration_hours,

        -- Geographic fields
        state,
        state_fips,
        county_zone_name,
        county_zone_fips,
        begin_lat,
        begin_lon,
        end_lat,
        end_lon,

        -- Magnitude (parsed to numeric where possible)
        CASE
            WHEN magnitude_raw ~ '^[0-9.]+$'
            THEN CAST(magnitude_raw AS DECIMAL(10,2))
            ELSE NULL
        END AS magnitude,
        magnitude_type,  -- EG = measured gust, ES = estimated gust, etc.

        -- Tornado-specific fields
        tor_f_scale,
        CASE
            WHEN tor_f_scale = 'EF0' THEN 0
            WHEN tor_f_scale = 'EF1' THEN 1
            WHEN tor_f_scale = 'EF2' THEN 2
            WHEN tor_f_scale = 'EF3' THEN 3
            WHEN tor_f_scale = 'EF4' THEN 4
            WHEN tor_f_scale = 'EF5' THEN 5
            ELSE NULL
        END AS tor_ef_rating,
        tor_length,
        tor_width,

        -- Casualties
        injuries_direct,
        injuries_indirect,
        deaths_direct,
        deaths_indirect,
        injuries_direct + injuries_indirect AS total_injuries,
        deaths_direct + deaths_indirect AS total_deaths,
        injuries_direct + injuries_indirect + deaths_direct + deaths_indirect AS total_casualties,

        -- Damage (nominal USD from parsed values)
        ROUND(damage_property_usd, 2) AS damage_property_usd,
        ROUND(damage_crops_usd, 2) AS damage_crops_usd,
        ROUND(damage_property_usd + damage_crops_usd, 2) AS total_damage_usd,

        -- CPI-adjusted damage (simplified: use a ratio to base year)
        -- In production, join to a CPI reference table
        ROUND(
            (damage_property_usd + damage_crops_usd)
            * POWER(1.03, {{ var('damage_cpi_base_year') }} - event_year)
        , 2) AS total_damage_adjusted_usd,

        -- Severity classification based on damage and casualties
        CASE
            WHEN deaths_direct + deaths_indirect > 0 THEN 'CATASTROPHIC'
            WHEN damage_property_usd + damage_crops_usd >= 1000000 THEN 'SEVERE'
            WHEN damage_property_usd + damage_crops_usd >= {{ var('significant_damage_threshold_usd') }} THEN 'SIGNIFICANT'
            WHEN injuries_direct + injuries_indirect > 0 THEN 'MODERATE'
            ELSE 'MINOR'
        END AS severity_category,

        -- Flood cause (for flood events)
        flood_cause,

        -- Data quality flag
        CASE
            WHEN damage_property_usd < 0 OR damage_crops_usd < 0 THEN FALSE
            WHEN injuries_direct < 0 OR deaths_direct < 0 THEN FALSE
            WHEN begin_lat IS NOT NULL
                 AND (begin_lat < 17 OR begin_lat > 72) THEN FALSE  -- Outside US bounds
            WHEN begin_lon IS NOT NULL
                 AND (begin_lon < -180 OR begin_lon > -60) THEN FALSE
            ELSE TRUE
        END AS is_valid,

        -- Metadata
        source_system,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM parsed
)

SELECT * FROM standardized
WHERE is_valid = TRUE

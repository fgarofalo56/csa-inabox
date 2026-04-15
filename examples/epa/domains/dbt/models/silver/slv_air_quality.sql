{{ config(
    materialized='incremental',
    unique_key='aqi_observation_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'air_quality', 'cleaned']
) }}

{#
    Silver layer: Cleaned AQI data with category mapping and health advisory levels.

    Transforms raw AQS/AirNow observations by:
      - Mapping parameter codes to standardized pollutant names
      - Recalculating AQI from raw concentrations using official EPA breakpoints
      - Assigning health advisory categories and sensitive group messages
      - Identifying dominant pollutant when multiple pollutants measured at a site
      - Computing data completeness metrics
      - Flagging preliminary vs. quality-assured data

    The AQI breakpoint tables follow 40 CFR Part 58 Appendix G.

    Source: brz_air_quality (Bronze layer)
#}

WITH valid_bronze AS (
    SELECT * FROM {{ ref('brz_air_quality') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Standardize pollutant names from AQS parameter codes
standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            site_id,
            parameter_code,
            CAST(date_local AS STRING)
        )) AS aqi_observation_sk,

        site_id,
        state_code,
        county_code,
        state_name,
        county_name,
        cbsa_name,
        latitude,
        longitude,
        date_local AS observation_date,
        observation_year,
        observation_month,

        -- Map parameter codes to standard pollutant names
        CASE
            WHEN parameter_code IN ('88101', '88502') THEN 'PM2.5'
            WHEN parameter_code = '81102' THEN 'PM10'
            WHEN parameter_code IN ('44201') THEN 'O3'
            WHEN parameter_code = '42602' THEN 'NO2'
            WHEN parameter_code = '42401' THEN 'SO2'
            WHEN parameter_code = '42101' THEN 'CO'
            WHEN parameter_code IN ('14129', '85129') THEN 'Pb'
            ELSE UPPER(TRIM(parameter_name))
        END AS pollutant,

        parameter_code,
        parameter_name AS pollutant_original,
        poc,
        sample_duration,
        units_of_measure AS units,
        method_code,
        method_name,

        -- Concentration values
        arithmetic_mean AS concentration,
        first_max_value AS max_concentration,
        first_max_hour AS max_concentration_hour,

        -- Observation completeness
        observation_count,
        COALESCE(observation_percent, 0) AS observation_completeness_pct,

        -- Source AQI (may recalculate below)
        aqi AS source_aqi,

        -- Determine if this is preliminary data
        CASE
            WHEN source_system = 'AIRNOW' THEN TRUE
            ELSE FALSE
        END AS is_preliminary,

        -- Processing metadata
        source_system,
        load_time

    FROM valid_bronze
),

-- Recalculate AQI from concentrations using EPA breakpoint tables
-- and assign health categories
with_aqi AS (
    SELECT
        *,

        -- Use source AQI if available; otherwise estimate from concentration
        COALESCE(source_aqi,
            CASE
                -- PM2.5 AQI breakpoints (24-hour, µg/m³)
                WHEN pollutant = 'PM2.5' AND concentration IS NOT NULL THEN
                    CASE
                        WHEN concentration <= 12.0 THEN ROUND(concentration / 12.0 * 50)
                        WHEN concentration <= 35.4 THEN ROUND(50 + (concentration - 12.0) / (35.4 - 12.0) * 50)
                        WHEN concentration <= 55.4 THEN ROUND(100 + (concentration - 35.4) / (55.4 - 35.4) * 50)
                        WHEN concentration <= 150.4 THEN ROUND(150 + (concentration - 55.4) / (150.4 - 55.4) * 50)
                        WHEN concentration <= 250.4 THEN ROUND(200 + (concentration - 150.4) / (250.4 - 150.4) * 100)
                        WHEN concentration <= 500.4 THEN ROUND(300 + (concentration - 250.4) / (500.4 - 250.4) * 200)
                        ELSE 500
                    END
                -- Ozone AQI breakpoints (8-hour, ppm)
                WHEN pollutant = 'O3' AND concentration IS NOT NULL THEN
                    CASE
                        WHEN concentration <= 0.054 THEN ROUND(concentration / 0.054 * 50)
                        WHEN concentration <= 0.070 THEN ROUND(50 + (concentration - 0.054) / (0.070 - 0.054) * 50)
                        WHEN concentration <= 0.085 THEN ROUND(100 + (concentration - 0.070) / (0.085 - 0.070) * 50)
                        WHEN concentration <= 0.105 THEN ROUND(150 + (concentration - 0.085) / (0.105 - 0.085) * 50)
                        WHEN concentration <= 0.200 THEN ROUND(200 + (concentration - 0.105) / (0.200 - 0.105) * 100)
                        ELSE 300
                    END
                ELSE source_aqi
            END
        ) AS aqi_value,

        -- AQI category assignment
        CASE
            WHEN COALESCE(source_aqi, 0) <= 50 THEN 'GOOD'
            WHEN COALESCE(source_aqi, 0) <= 100 THEN 'MODERATE'
            WHEN COALESCE(source_aqi, 0) <= 150 THEN 'UNHEALTHY_SENSITIVE'
            WHEN COALESCE(source_aqi, 0) <= 200 THEN 'UNHEALTHY'
            WHEN COALESCE(source_aqi, 0) <= 300 THEN 'VERY_UNHEALTHY'
            WHEN COALESCE(source_aqi, 0) > 300 THEN 'HAZARDOUS'
            ELSE 'UNKNOWN'
        END AS aqi_category,

        -- Health advisory messaging
        CASE
            WHEN COALESCE(source_aqi, 0) <= 50
                THEN 'Air quality is satisfactory with little or no risk.'
            WHEN COALESCE(source_aqi, 0) <= 100
                THEN 'Acceptable. Unusually sensitive individuals should consider limiting prolonged outdoor exertion.'
            WHEN COALESCE(source_aqi, 0) <= 150
                THEN 'Members of sensitive groups may experience health effects. General public unlikely affected.'
            WHEN COALESCE(source_aqi, 0) <= 200
                THEN 'Everyone may begin to experience health effects. Sensitive groups may experience more serious effects.'
            WHEN COALESCE(source_aqi, 0) <= 300
                THEN 'Health alert: significant risk of health effects for everyone.'
            WHEN COALESCE(source_aqi, 0) > 300
                THEN 'Health warning of emergency conditions. Entire population likely affected.'
            ELSE NULL
        END AS health_advisory_level,

        -- Sensitive groups affected
        CASE
            WHEN pollutant = 'PM2.5' AND COALESCE(source_aqi, 0) > 100
                THEN 'People with heart or lung disease, older adults, children'
            WHEN pollutant = 'O3' AND COALESCE(source_aqi, 0) > 100
                THEN 'Children, older adults, people with asthma, outdoor workers'
            WHEN pollutant = 'NO2' AND COALESCE(source_aqi, 0) > 100
                THEN 'People with asthma, children, older adults'
            WHEN pollutant = 'SO2' AND COALESCE(source_aqi, 0) > 100
                THEN 'People with asthma'
            WHEN pollutant = 'CO' AND COALESCE(source_aqi, 0) > 100
                THEN 'People with heart disease'
            ELSE NULL
        END AS sensitive_groups_message

    FROM standardized
),

-- Add data quality scoring and validity
final AS (
    SELECT
        aqi_observation_sk,
        site_id,
        state_code,
        county_code,
        state_name,
        county_name,
        cbsa_name,
        latitude,
        longitude,
        observation_date,
        observation_year,
        observation_month,

        pollutant,
        parameter_code,
        concentration,
        max_concentration,
        units,

        CAST(aqi_value AS INT) AS aqi_value,
        aqi_category,
        health_advisory_level,
        sensitive_groups_message,

        observation_completeness_pct,
        is_preliminary,

        -- Validity assessment
        CASE
            WHEN concentration IS NULL AND aqi_value IS NULL THEN FALSE
            WHEN concentration IS NOT NULL AND concentration < 0 THEN FALSE
            WHEN aqi_value IS NOT NULL AND (aqi_value < 0 OR aqi_value > 500) THEN FALSE
            WHEN observation_completeness_pct < 50 THEN FALSE
            ELSE TRUE
        END AS is_valid,

        -- Data quality score
        ROUND(
            CASE WHEN concentration IS NOT NULL THEN 0.30 ELSE 0 END
          + CASE WHEN aqi_value IS NOT NULL THEN 0.30 ELSE 0 END
          + CASE WHEN observation_completeness_pct >= 75 THEN 0.20
                 WHEN observation_completeness_pct >= 50 THEN 0.10 ELSE 0 END
          + CASE WHEN is_preliminary = FALSE THEN 0.20 ELSE 0.05 END
        , 2) AS data_quality_score,

        source_system,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM with_aqi
)

SELECT * FROM final
WHERE is_valid = TRUE

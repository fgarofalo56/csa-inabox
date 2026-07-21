# loom-maps-tileserver — sovereign OSS basemap for the Geo canvases (svc-azure-maps)
#
# GCC-High / IL5 has no Azure Maps data plane, so the MapLibre map path
# (LOOM_MAPS_BACKEND=maplibre) needs a self-hosted tile server. This image is a
# hardened tileserver-gl that bakes in a PUBLIC-DOMAIN Natural Earth basemap
# (no MapTiler key, no external map host) + an OpenMapTiles-free MapLibre style +
# the OSS Open Sans glyph set, fronted by Caddy so it ALSO serves the
# maplibre-gl.js / maplibre-gl.css assets + a root /style.json that the Console
# proxy (/api/maps/tiles/*) forwards to. Everything is served in-VNet on :8080.
#
# ── stage 1: build the basemap MBTiles from Natural Earth (public domain) ──────
FROM debian:bookworm-slim AS basemap
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip gdal-bin build-essential git libsqlite3-dev zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# tippecanoe (vector-tile builder) from source — small, fast.
RUN git clone --depth 1 https://github.com/felt/tippecanoe /tmp/tippecanoe \
    && make -C /tmp/tippecanoe -j"$(nproc)" && make -C /tmp/tippecanoe install
WORKDIR /build
# Natural Earth 1:50m cultural + physical (a few MB each; low/mid-zoom world basemap).
RUN for f in \
      "https://naciscdn.org/naturalearth/50m/physical/ne_50m_ocean.zip" \
      "https://naciscdn.org/naturalearth/50m/physical/ne_50m_land.zip" \
      "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_0_countries.zip" \
      "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_1_states_provinces_lines.zip" \
      "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_0_boundary_lines_land.zip" \
      "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_populated_places_simple.zip" ; do \
        n=$(basename "$f" .zip); curl -fsSL "$f" -o "$n.zip" && unzip -o "$n.zip" -d "$n" ; done
# shp → GeoJSONSeq (one file per layer), then tippecanoe → a single MBTiles with named layers.
# POSIX sh (Docker RUN uses /bin/sh) — no bash associative arrays.
RUN set -e; \
    ogr2ogr -f GeoJSONSeq /build/ocean.geojsonl      /build/ne_50m_ocean/ne_50m_ocean.shp -t_srs EPSG:4326; \
    ogr2ogr -f GeoJSONSeq /build/land.geojsonl       /build/ne_50m_land/ne_50m_land.shp -t_srs EPSG:4326; \
    ogr2ogr -f GeoJSONSeq /build/countries.geojsonl  /build/ne_50m_admin_0_countries/ne_50m_admin_0_countries.shp -t_srs EPSG:4326; \
    ogr2ogr -f GeoJSONSeq /build/states.geojsonl     /build/ne_50m_admin_1_states_provinces_lines/ne_50m_admin_1_states_provinces_lines.shp -t_srs EPSG:4326; \
    ogr2ogr -f GeoJSONSeq /build/boundaries.geojsonl /build/ne_50m_admin_0_boundary_lines_land/ne_50m_admin_0_boundary_lines_land.shp -t_srs EPSG:4326; \
    ogr2ogr -f GeoJSONSeq /build/places.geojsonl     /build/ne_50m_populated_places_simple/ne_50m_populated_places_simple.shp -t_srs EPSG:4326; \
    tippecanoe -o /build/basemap.mbtiles -Z0 -z7 --drop-densest-as-needed --force \
      -L ocean:/build/ocean.geojsonl -L land:/build/land.geojsonl \
      -L countries:/build/countries.geojsonl -L states:/build/states.geojsonl \
      -L boundaries:/build/boundaries.geojsonl -L places:/build/places.geojsonl
#
# ── stage 2: the runtime — tileserver-gl + caddy front + baked assets ──────────
FROM maptiler/tileserver-gl:v4.13.1
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /data
# basemap + style + config from the build context / basemap stage.
COPY --from=basemap /build/basemap.mbtiles /data/basemap.mbtiles
COPY data/config.json /data/config.json
COPY data/styles/loom/style.json /data/styles/loom/style.json
# (label-free basemap — no glyph fonts needed, keeps the image self-contained)
# maplibre-gl assets (served at /maplibre-gl.js|css by caddy; console loads them from same origin).
RUN mkdir -p /assets && \
    curl -fsSL https://unpkg.com/maplibre-gl@4.5.0/dist/maplibre-gl.js  -o /assets/maplibre-gl.js && \
    curl -fsSL https://unpkg.com/maplibre-gl@4.5.0/dist/maplibre-gl.css -o /assets/maplibre-gl.css
COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]

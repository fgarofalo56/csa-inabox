'use client';

/**
 * GeoOperatorConfig — the SHARED typed inspector for the four eventstream
 * geospatial operators (geo-point / geo-fence / geo-proximity / geo-aggregate,
 * PRP geo-graph-ml GEO-1). Rendered by BOTH authoring surfaces — the guided
 * Operators tab (EsOperatorCard) and the Visual designer inspector
 * (AsaTransformInspector) — so the two canvases can never drift (the
 * pipeline-two-canvas lesson).
 *
 * Every control is typed config (dropdowns of REAL stream columns discovered
 * via useStreamColumns, numeric fields, structured vertex rows) — no freeform
 * JSON (loom_no_freeform_config). The only free-text surfaces are the GeoJSON
 * / WKT fence-import payloads, explicitly allowed data-payload surfaces.
 *
 * The fence + proximity panels render a REAL Azure Maps basemap through the
 * existing server-side proxy `GET /api/maps/static` (session-gated, credential
 * never reaches the client — the established Loom Azure Maps integration
 * pattern) with the fence polygons / proximity radius projected on top
 * (Web-Mercator math, local SVG overlay). When Azure Maps isn't configured the
 * proxy 412s and the honest gate names LOOM_MAPS_BACKEND + the bicep module
 * (no-vaporware.md) — the full config surface still renders.
 *
 * The SQL these nodes emit comes from lib/editors/eventstream/geo-sql.ts (pure,
 * unit-tested); this component only edits the typed node config.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Dropdown, Option, Field, Input, Select, Spinner,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync16Regular, Map20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { clientFetch } from '@/lib/client-fetch';
import {
  thresholdMeters, parseGeoJsonFences, parseWktFences,
  type GeoFenceDef, type GeoFenceVertex, type GeoDistanceUnit,
} from '@/lib/editors/eventstream/geo-sql';
import { useStreamColumns } from './use-stream-columns';

// ============================================================
// Column dropdown (typed picker over the REAL stream columns)
// ============================================================

function ColumnDropdown({
  label, hint, value, columns, loading, required, onSelect, allowNone, ariaLabel,
}: {
  label: string;
  hint?: string;
  value: string;
  columns: string[];
  loading?: boolean;
  required?: boolean;
  allowNone?: boolean;
  ariaLabel?: string;
  onSelect: (v: string) => void;
}) {
  // Keep a previously-saved value selectable even if discovery can't see it.
  const options = useMemo(() => {
    const v = (value || '').trim();
    return v && !columns.includes(v) ? [v, ...columns] : columns;
  }, [value, columns]);
  return (
    <Field label={label} hint={hint} required={required} style={{ flex: 1, minWidth: 150 }}>
      <Dropdown
        value={value || ''}
        selectedOptions={value ? [value] : []}
        placeholder={loading ? 'Discovering columns…' : (options.length ? 'Select a column…' : 'No columns discovered')}
        onOptionSelect={(_: unknown, d: any) => onSelect((d.optionValue as string) || '')}
        aria-label={ariaLabel || label}
      >
        {allowNone && <Option value="">(none)</Option>}
        {options.map((c) => <Option key={c} value={c}>{c}</Option>)}
      </Dropdown>
    </Field>
  );
}

// ============================================================
// Web-Mercator helpers for the local SVG overlay on the static basemap
// ============================================================

function mercX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 256 * Math.pow(2, zoom);
}
function mercY(lat: number, zoom: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2) * 256 * Math.pow(2, zoom);
}
/** Meters per pixel at a latitude/zoom (spherical mercator ground resolution). */
function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

interface MapView { lat: number; lon: number; zoom: number }

/** Fit a bounding box into width×height (padding included). */
function fitView(points: GeoFenceVertex[], width: number, height: number): MapView {
  if (!points.length) return { lat: 38.9, lon: -77.0, zoom: 3 };
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  for (let zoom = 18; zoom >= 1; zoom--) {
    const w = Math.abs(mercX(Math.max(...lons), zoom) - mercX(Math.min(...lons), zoom));
    const h = Math.abs(mercY(Math.min(...lats), zoom) - mercY(Math.max(...lats), zoom));
    if (w <= width - 48 && h <= height - 48) return { lat, lon, zoom };
  }
  return { lat, lon, zoom: 1 };
}

const MAP_W = 400;
const MAP_H = 200;

/**
 * A real Azure Maps basemap (server-side proxy — no client credential) with a
 * local SVG overlay: fence polygons and/or a proximity radius circle.
 */
function GeoMapPreview({
  fences, marker, radiusMeters,
}: {
  fences?: GeoFenceDef[];
  marker?: { lat: number; lon: number } | null;
  radiusMeters?: number;
}) {
  const overlayPoints = useMemo(() => {
    const pts: GeoFenceVertex[] = [];
    (fences || []).forEach((f) => (f.vertices || []).forEach((v) => {
      if (Number.isFinite(v.lat) && Number.isFinite(v.lon)) pts.push(v);
    }));
    if (marker && Number.isFinite(marker.lat) && Number.isFinite(marker.lon)) pts.push(marker);
    return pts;
  }, [fences, marker]);

  const view = useMemo(() => fitView(overlayPoints, MAP_W, MAP_H), [overlayPoints]);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [gate, setGate] = useState<{ error: string; envVar?: string; bicep?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setBusy(true); setErr(null); setGate(null);
    (async () => {
      try {
        const r = await clientFetch(
          `/api/maps/static?zoom=${view.zoom}&lon=${view.lon}&lat=${view.lat}&width=${MAP_W}&height=${MAP_H}`,
        );
        if (!alive) return;
        if (r.status === 412) {
          const j = await r.json().catch(() => null);
          setGate({ error: j?.error || 'Azure Maps not configured', envVar: j?.envVar, bicep: j?.bicep });
          setImgUrl(null);
          return;
        }
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          setErr(j?.error || `Basemap request failed (HTTP ${r.status})`);
          setImgUrl(null);
          return;
        }
        const blob = await r.blob();
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setImgUrl(objectUrl);
      } catch (e: any) {
        if (alive) { setErr(e?.message || String(e)); setImgUrl(null); }
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [view.zoom, view.lat, view.lon]);

  const toPx = (v: GeoFenceVertex): { x: number; y: number } => ({
    x: mercX(v.lon, view.zoom) - mercX(view.lon, view.zoom) + MAP_W / 2,
    y: mercY(v.lat, view.zoom) - mercY(view.lat, view.zoom) + MAP_H / 2,
  });

  if (gate) {
    return (
      <MessageBar intent="warning" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Azure Maps basemap not configured</MessageBarTitle>
          {gate.error}{gate.envVar ? <> — set <code>{gate.envVar}</code></> : null}
          {gate.bicep ? <> (deployed by <code>{gate.bicep}</code>)</> : null}. The fence coordinates
          below stay fully editable and compile into the query regardless.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div
      style={{
        position: 'relative', width: MAP_W, maxWidth: '100%', height: MAP_H,
        borderRadius: tokens.borderRadiusMedium, overflow: 'hidden',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        background: tokens.colorNeutralBackground3,
      }}
    >
      {imgUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imgUrl} alt="Azure Maps basemap preview" width={MAP_W} height={MAP_H}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
      {busy && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size="tiny" label="Loading basemap…" labelPosition="after" />
        </div>
      )}
      {err && !busy && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: tokens.spacingHorizontalM }}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{err}</Caption1>
        </div>
      )}
      <svg
        width={MAP_W} height={MAP_H} viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        aria-hidden
      >
        {(fences || []).map((f, i) => {
          const vs = (f.vertices || []).filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon));
          if (vs.length < 3) return null;
          const pts = vs.map((v) => { const p = toPx(v); return `${p.x},${p.y}`; }).join(' ');
          return (
            <polygon key={i} points={pts}
              fill={tokens.colorBrandBackground2} fillOpacity={0.35}
              stroke={tokens.colorBrandStroke1} strokeWidth={2} />
          );
        })}
        {marker && Number.isFinite(marker.lat) && Number.isFinite(marker.lon) && (() => {
          const p = toPx(marker);
          const rPx = radiusMeters ? radiusMeters / metersPerPixel(marker.lat, view.zoom) : 0;
          return (
            <g>
              {rPx > 0 && (
                <circle cx={p.x} cy={p.y} r={rPx}
                  fill={tokens.colorPaletteGreenBackground2} fillOpacity={0.25}
                  stroke={tokens.colorPaletteGreenBorderActive} strokeWidth={1.5} />
              )}
              <circle cx={p.x} cy={p.y} r={5} fill={tokens.colorPaletteRedForeground1} />
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

// ============================================================
// Fence import dialog (GeoJSON / WKT data payloads — allowed free-text)
// ============================================================

function FenceImportDialog({
  open, onClose, onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (fences: GeoFenceDef[]) => void;
}) {
  const [format, setFormat] = useState<'geojson' | 'wkt'>('geojson');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const doImport = () => {
    try {
      const fences = format === 'geojson' ? parseGeoJsonFences(text) : parseWktFences(text);
      onImport(fences);
      setText(''); setErr(null);
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(_: unknown, d: any) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Import fences (GeoJSON / WKT)</DialogTitle>
          <DialogContent>
            <Caption1>
              Paste a GeoJSON Polygon / MultiPolygon / FeatureCollection, or a WKT
              POLYGON / MULTIPOLYGON. Outer rings become named fences (feature
              <code> name</code> properties are honored).
            </Caption1>
            <Field label="Format" style={{ marginTop: tokens.spacingVerticalM, maxWidth: 200 }}>
              <Select value={format} onChange={(_: unknown, d: any) => setFormat(d.value === 'wkt' ? 'wkt' : 'geojson')} aria-label="Fence import format">
                <option value="geojson">GeoJSON</option>
                <option value="wkt">WKT</option>
              </Select>
            </Field>
            <Field label={format === 'geojson' ? 'GeoJSON document' : 'WKT geometry'} style={{ marginTop: tokens.spacingVerticalM }}>
              <MonacoTextarea
                value={text}
                onChange={setText}
                language={format === 'geojson' ? 'json' : 'plaintext'}
                height={180}
                minHeight={120}
                ariaLabel={format === 'geojson' ? 'GeoJSON fence payload' : 'WKT fence payload'}
              />
            </Field>
            {err && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody><MessageBarTitle>Import failed</MessageBarTitle>{err}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={doImport} disabled={!text.trim()}>Import</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Shared sub-panels
// ============================================================

/** Point derivation picker: build from lat/lon columns, or use a point column. */
function PointSourcePanel({
  op, columns, loading, onChange, prefixLabel,
}: {
  op: any;
  columns: string[];
  loading: boolean;
  onChange: (patch: Record<string, any>) => void;
  prefixLabel?: string;
}) {
  const mode = op.pointMode === 'column' ? 'column' : 'latlon';
  return (
    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <Field label={`${prefixLabel || 'Point'} source`} style={{ minWidth: 190 }}>
        <Select value={mode} onChange={(_: unknown, d: any) => onChange({ pointMode: d.value === 'column' ? 'column' : 'latlon' })} aria-label={`${prefixLabel || 'Point'} source mode`}>
          <option value="latlon">Build from lat / lon columns</option>
          <option value="column">Existing point column</option>
        </Select>
      </Field>
      {mode === 'latlon' ? (
        <>
          <ColumnDropdown label="Latitude column" required value={op.latColumn || ''} columns={columns} loading={loading}
            onSelect={(v) => onChange({ latColumn: v })} />
          <ColumnDropdown label="Longitude column" required value={op.lonColumn || ''} columns={columns} loading={loading}
            onSelect={(v) => onChange({ lonColumn: v })} />
        </>
      ) : (
        <ColumnDropdown label="Point column" required hint="A GeoJSON point (e.g. from a Geo point node)"
          value={op.pointColumn || ''} columns={columns} loading={loading}
          onSelect={(v) => onChange({ pointColumn: v })} />
      )}
    </div>
  );
}

// ============================================================
// The main shared config surface
// ============================================================

export interface GeoOperatorConfigProps {
  /** The transform node's typed config (wire shape). */
  op: any;
  /** All source nodes (for the proximity stream-join picker). */
  sources: any[];
  /** The whole topology (column-hint fallback for the dropdowns). */
  topology: { sources?: any[]; transforms?: any[]; sinks?: any[] };
  /** Cosmos item id — enables LIVE column discovery (absent pre-save). */
  itemId?: string;
  onChange: (patch: Record<string, any>) => void;
}

export function GeoOperatorConfig({ op, sources, topology, itemId, onChange }: GeoOperatorConfigProps) {
  const { columns, liveColumns, loading, gate, refresh } = useStreamColumns(itemId, topology);
  const [importOpen, setImportOpen] = useState(false);

  const kind = String(op.kind || '');
  const fences: GeoFenceDef[] = Array.isArray(op.fences) ? op.fences : [];
  const setFences = (next: GeoFenceDef[]) => onChange({ fences: next });

  const columnBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
      <Badge appearance="tint" color={liveColumns.length ? 'success' : 'informative'}>
        {liveColumns.length ? `${liveColumns.length} live column${liveColumns.length === 1 ? '' : 's'}` : 'no live columns yet'}
      </Badge>
      <Tooltip content="Re-peek the stream's recent events to refresh the column list" relationship="description">
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={refresh} disabled={loading} aria-label="Refresh stream columns">
          {loading ? 'Discovering…' : 'Refresh columns'}
        </Button>
      </Tooltip>
      {gate && !loading && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>{gate}</Caption1>
      )}
    </div>
  );

  // ── GEO POINT ─────────────────────────────────────────────────────────────
  if (kind === 'geo-point') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Builds a GeoJSON point with <code>CreatePoint(lat, lon)</code> from two stream columns and
          appends it to every event — downstream Geofence / Proximity nodes consume it.
        </Caption1>
        {columnBar}
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <ColumnDropdown label="Latitude column" required value={op.latColumn || ''} columns={columns} loading={loading}
            onSelect={(v) => onChange({ latColumn: v })} />
          <ColumnDropdown label="Longitude column" required value={op.lonColumn || ''} columns={columns} loading={loading}
            onSelect={(v) => onChange({ lonColumn: v })} />
          <Field label="Output point column" style={{ minWidth: 150 }}>
            <Input value={op.pointAlias ?? 'point'} placeholder="point"
              onChange={(_: unknown, d: any) => onChange({ pointAlias: d.value })} aria-label="Output point column name" />
          </Field>
        </div>
      </div>
    );
  }

  // ── GEO FENCE ─────────────────────────────────────────────────────────────
  if (kind === 'geo-fence') {
    const fenceSource = op.fenceSource === 'reference' ? 'reference' : 'inline';
    const fenceMode = op.fenceMode === 'outside' ? 'outside' : 'inside';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Keeps events {fenceMode === 'inside' ? 'INSIDE any fence' : 'in NO fence'} via
          {' '}<code>ST_WITHIN(point, fence)</code>. Inline fences compile into the query; reference
          fences follow the documented blob-backed ASA reference-data join.
        </Caption1>
        {columnBar}
        <PointSourcePanel op={op} columns={columns} loading={loading} onChange={onChange} />
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Fence definition" style={{ minWidth: 210 }}>
            <Select value={fenceSource} onChange={(_: unknown, d: any) => onChange({ fenceSource: d.value === 'reference' ? 'reference' : 'inline' })} aria-label="Fence definition source">
              <option value="inline">Inline (drawn / imported here)</option>
              <option value="reference">ASA reference-data input</option>
            </Select>
          </Field>
          <Field label="Mode" style={{ minWidth: 150 }}>
            <Select value={fenceMode} onChange={(_: unknown, d: any) => onChange({ fenceMode: d.value === 'outside' ? 'outside' : 'inside' })} aria-label="Fence mode">
              <option value="inside">Inside (violation = enter)</option>
              <option value="outside">Outside (violation = exit)</option>
            </Select>
          </Field>
          {fenceMode === 'inside' && (
            <Field label="Matched-fence column" style={{ minWidth: 160 }}>
              <Input value={op.fenceOutputColumn ?? 'matchedFence'} placeholder="matchedFence"
                onChange={(_: unknown, d: any) => onChange({ fenceOutputColumn: d.value })} aria-label="Matched fence output column" />
            </Field>
          )}
        </div>

        {fenceSource === 'reference' ? (
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Reference input alias" required hint="The ASA reference-data input (blob-backed fence table)" style={{ minWidth: 180 }}>
              <Input value={op.fenceRefInput ?? 'geofences'} placeholder="geofences"
                onChange={(_: unknown, d: any) => onChange({ fenceRefInput: d.value })} aria-label="Reference input alias" />
            </Field>
            <Field label="Fence-name column" style={{ minWidth: 150 }}>
              <Input value={op.fenceRefNameColumn ?? 'fenceName'} placeholder="fenceName"
                onChange={(_: unknown, d: any) => onChange({ fenceRefNameColumn: d.value })} aria-label="Reference fence-name column" />
            </Field>
            <Field label="Polygon column" style={{ minWidth: 150 }}>
              <Input value={op.fenceRefPolygonColumn ?? 'polygon'} placeholder="polygon"
                onChange={(_: unknown, d: any) => onChange({ fenceRefPolygonColumn: d.value })} aria-label="Reference polygon column" />
            </Field>
          </div>
        ) : (
          <>
            <GeoMapPreview fences={fences} />
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
              <Map20Regular style={{ color: tokens.colorBrandForeground1 }} />
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Fences ({fences.length}) — each needs at least 3 vertices (rings auto-close).
              </Caption1>
              <Button size="small" appearance="secondary" icon={<Add20Regular />}
                onClick={() => setFences([...fences, { name: `fence-${fences.length + 1}`, vertices: [] }])}>
                Add fence
              </Button>
              <Button size="small" appearance="secondary" onClick={() => setImportOpen(true)}>
                Import GeoJSON / WKT
              </Button>
            </div>
            {fences.map((f, fi) => (
              <div key={fi} style={{
                border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
                padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
              }}>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Fence name" style={{ flex: 1, minWidth: 140 }}>
                    <Input value={f.name || ''} placeholder={`fence-${fi + 1}`}
                      onChange={(_: unknown, d: any) => setFences(fences.map((x, j) => j === fi ? { ...x, name: d.value } : x))}
                      aria-label={`Fence ${fi + 1} name`} />
                  </Field>
                  <Badge appearance="tint" color={(f.vertices?.length || 0) >= 3 ? 'success' : 'warning'}>
                    {(f.vertices?.length || 0)} vertices
                  </Badge>
                  <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove fence ${f.name || fi + 1}`}
                    onClick={() => setFences(fences.filter((_, j) => j !== fi))} />
                </div>
                {(f.vertices || []).map((v, vi) => (
                  <div key={vi} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' }}>
                    <Field label={vi === 0 ? 'Latitude' : undefined} style={{ flex: 1 }}>
                      <Input type="number" value={String(v.lat ?? '')} placeholder="47.6062"
                        onChange={(_: unknown, d: any) => setFences(fences.map((x, j) => j === fi
                          ? { ...x, vertices: x.vertices.map((vv, k) => k === vi ? { ...vv, lat: Number(d.value) } : vv) }
                          : x))}
                        aria-label={`Fence ${fi + 1} vertex ${vi + 1} latitude`} />
                    </Field>
                    <Field label={vi === 0 ? 'Longitude' : undefined} style={{ flex: 1 }}>
                      <Input type="number" value={String(v.lon ?? '')} placeholder="-122.3321"
                        onChange={(_: unknown, d: any) => setFences(fences.map((x, j) => j === fi
                          ? { ...x, vertices: x.vertices.map((vv, k) => k === vi ? { ...vv, lon: Number(d.value) } : vv) }
                          : x))}
                        aria-label={`Fence ${fi + 1} vertex ${vi + 1} longitude`} />
                    </Field>
                    <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove vertex ${vi + 1} of fence ${fi + 1}`}
                      onClick={() => setFences(fences.map((x, j) => j === fi
                        ? { ...x, vertices: x.vertices.filter((_, k) => k !== vi) }
                        : x))} />
                  </div>
                ))}
                <Button size="small" appearance="secondary" icon={<Add20Regular />}
                  onClick={() => setFences(fences.map((x, j) => j === fi
                    ? { ...x, vertices: [...(x.vertices || []), { lat: 0, lon: 0 }] }
                    : x))}>
                  Add vertex
                </Button>
              </div>
            ))}
            <FenceImportDialog open={importOpen} onClose={() => setImportOpen(false)}
              onImport={(imported) => setFences([...fences.filter((f) => (f.vertices?.length || 0) >= 3), ...imported])} />
          </>
        )}
      </div>
    );
  }

  // ── GEO PROXIMITY ─────────────────────────────────────────────────────────
  if (kind === 'geo-proximity') {
    const target = op.proximityTarget === 'stream' ? 'stream' : 'static';
    const unit: GeoDistanceUnit = (op.thresholdUnit as GeoDistanceUnit) || 'm';
    const meters = thresholdMeters(op.thresholdValue ?? 0, unit);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Keeps events within a distance threshold via <code>ST_DISTANCE(a, b) &lt; {meters || '…'}</code> meters
          — against a fixed reference point (vehicle ↔ depot) or a second stream (temporal join).
        </Caption1>
        {columnBar}
        <PointSourcePanel op={op} columns={columns} loading={loading} onChange={onChange} prefixLabel="This stream's point" />
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Compare against" style={{ minWidth: 200 }}>
            <Select value={target} onChange={(_: unknown, d: any) => onChange({ proximityTarget: d.value === 'stream' ? 'stream' : 'static' })} aria-label="Proximity target mode">
              <option value="static">Fixed reference point</option>
              <option value="stream">Another stream (temporal join)</option>
            </Select>
          </Field>
          <Field label="Threshold" style={{ minWidth: 110 }}>
            <Input type="number" value={String(op.thresholdValue ?? 500)}
              onChange={(_: unknown, d: any) => onChange({ thresholdValue: Number(d.value) || 0 })} aria-label="Proximity threshold" />
          </Field>
          <Field label="Unit" style={{ minWidth: 110 }}>
            <Select value={unit} onChange={(_: unknown, d: any) => onChange({ thresholdUnit: d.value })} aria-label="Threshold unit">
              <option value="m">meters</option>
              <option value="km">kilometers</option>
              <option value="mi">miles</option>
            </Select>
          </Field>
          <Field label="Distance column" style={{ minWidth: 150 }}>
            <Input value={op.distanceAlias ?? 'distanceMeters'} placeholder="distanceMeters"
              onChange={(_: unknown, d: any) => onChange({ distanceAlias: d.value })} aria-label="Distance output column" />
          </Field>
        </div>
        {target === 'static' ? (
          <>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="Reference latitude" required style={{ minWidth: 140 }}>
                <Input type="number" value={String(op.staticLat ?? '')} placeholder="47.6062"
                  onChange={(_: unknown, d: any) => onChange({ staticLat: Number(d.value) })} aria-label="Reference latitude" />
              </Field>
              <Field label="Reference longitude" required style={{ minWidth: 140 }}>
                <Input type="number" value={String(op.staticLon ?? '')} placeholder="-122.3321"
                  onChange={(_: unknown, d: any) => onChange({ staticLon: Number(d.value) })} aria-label="Reference longitude" />
              </Field>
            </div>
            <GeoMapPreview marker={{ lat: Number(op.staticLat ?? 0), lon: Number(op.staticLon ?? 0) }} radiusMeters={meters} />
          </>
        ) : (
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Join with source" required style={{ minWidth: 170 }}>
              <Select value={op.joinSource || ''} onChange={(_: unknown, d: any) => onChange({ joinSource: d.value })} aria-label="Proximity join source">
                <option value="">{sources.length > 1 ? 'Select a source…' : 'Add a second source first'}</option>
                {sources.map((sn: any) => <option key={sn.name} value={sn.name}>{sn.name}</option>)}
              </Select>
            </Field>
            <Field label="Within (seconds)" hint="DATEDIFF temporal bound" style={{ minWidth: 130 }}>
              <Input type="number" value={String(op.joinDurationSeconds ?? 60)}
                onChange={(_: unknown, d: any) => onChange({ joinDurationSeconds: Number(d.value) || 0 })} aria-label="Join temporal bound seconds" />
            </Field>
            <Field label="Right point source" style={{ minWidth: 190 }}>
              <Select value={op.rightPointMode === 'column' ? 'column' : 'latlon'}
                onChange={(_: unknown, d: any) => onChange({ rightPointMode: d.value === 'column' ? 'column' : 'latlon' })}
                aria-label="Right stream point source mode">
                <option value="latlon">Build from lat / lon columns</option>
                <option value="column">Existing point column</option>
              </Select>
            </Field>
            {op.rightPointMode === 'column' ? (
              <ColumnDropdown label="Right point column" required value={op.rightPointColumn || ''} columns={columns} loading={loading}
                onSelect={(v) => onChange({ rightPointColumn: v })} />
            ) : (
              <>
                <ColumnDropdown label="Right latitude column" required value={op.rightLatColumn || ''} columns={columns} loading={loading}
                  onSelect={(v) => onChange({ rightLatColumn: v })} />
                <ColumnDropdown label="Right longitude column" required value={op.rightLonColumn || ''} columns={columns} loading={loading}
                  onSelect={(v) => onChange({ rightLonColumn: v })} />
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── GEO AGGREGATE ─────────────────────────────────────────────────────────
  if (kind === 'geo-aggregate') {
    const aggs: any[] = Array.isArray(op.aggregates) ? op.aggregates : [];
    const setAggs = (rows: any[]) => onChange({ aggregates: rows });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Aggregates events per region over a hopping window — the documented ride-share
          requests-per-region pattern (<code>GROUP BY region, HoppingWindow(…)</code>). Feed it the
          matched-fence column a Geofence node emits, or any region column.
        </Caption1>
        {columnBar}
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <ColumnDropdown label="Region column" hint="e.g. matchedFence from a Geofence node" allowNone
            value={op.regionColumn || ''} columns={columns} loading={loading}
            onSelect={(v) => onChange({ regionColumn: v })} />
          <ColumnDropdown label="Timestamp column (TIMESTAMP BY)" allowNone hint="Event-time column used for windowing"
            value={op.timestampBy || ''} columns={columns} loading={loading}
            onSelect={(v) => onChange({ timestampBy: v })} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
          <Caption1>Aggregations</Caption1>
          {aggs.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' }}>
              <Field style={{ minWidth: 100 }}>
                <Select value={a.func || 'COUNT'} onChange={(_: unknown, d: any) => setAggs(aggs.map((r, j) => j === i ? { ...r, func: d.value } : r))}
                  aria-label={`Geo aggregation ${i + 1} function`}>
                  {['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].map((f) => <option key={f} value={f}>{f}</option>)}
                </Select>
              </Field>
              <ColumnDropdown label={i === 0 ? 'Field' : ''} allowNone value={a.field === '*' ? '' : (a.field || '')}
                columns={columns} loading={loading}
                onSelect={(v) => setAggs(aggs.map((r, j) => j === i ? { ...r, field: v || '*' } : r))} />
              <Field style={{ flex: 1, minWidth: 120 }} label={i === 0 ? 'Alias' : undefined}>
                <Input value={a.alias || ''} placeholder="alias"
                  onChange={(_: unknown, d: any) => setAggs(aggs.map((r, j) => j === i ? { ...r, alias: d.value } : r))}
                  aria-label={`Geo aggregation ${i + 1} alias`} />
              </Field>
              <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => setAggs(aggs.filter((_, j) => j !== i))}
                aria-label={`Remove geo aggregation ${i + 1}`} />
            </div>
          ))}
          <Button appearance="secondary" size="small" icon={<Add20Regular />}
            onClick={() => setAggs([...aggs, { func: 'COUNT', field: '*', alias: '' }])}>
            Add aggregation
          </Button>
        </div>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Window size" style={{ minWidth: 110 }}>
            <Input type="number" value={String(op.windowSize ?? 5)}
              onChange={(_: unknown, d: any) => onChange({ windowSize: Number(d.value) || 0 })} aria-label="Hopping window size" />
          </Field>
          <Field label="Unit" style={{ minWidth: 110 }}>
            <Select value={op.windowUnit || 'minute'} onChange={(_: unknown, d: any) => onChange({ windowUnit: d.value })} aria-label="Hopping window unit">
              {['second', 'minute', 'hour', 'day'].map((u) => <option key={u} value={u}>{u}</option>)}
            </Select>
          </Field>
          <Field label="Hop" hint="How far each window advances" style={{ minWidth: 110 }}>
            <Input type="number" value={String(op.hopSize ?? op.windowSize ?? 1)}
              onChange={(_: unknown, d: any) => onChange({ hopSize: Number(d.value) || 0 })} aria-label="Hopping window hop size" />
          </Field>
        </div>
      </div>
    );
  }

  return null;
}

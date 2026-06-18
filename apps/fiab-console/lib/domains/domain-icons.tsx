'use client';

/**
 * domain-icons — the SHARED Fluent-icon registry for domains.
 *
 * A domain (and every Federal-agency library node) is represented by a Fluent
 * icon NAME (a serializable string stored on the domain doc as `icon`) plus a
 * `themeColor` hex. This module is the single place that resolves a stored icon
 * name into an actual `@fluentui/react-icons` component, so the seed, the
 * fedciv library, the create-domain picker, the domains table, the settings
 * drawer, and the governance tiles all render the same glyph.
 *
 * Why names (not components) on the model: the domain doc lives in Cosmos and
 * round-trips through the REST API as JSON — a React component can't be stored,
 * but a stable string key can. `DomainGlyph` (below) renders the chip the whole
 * app uses; `DOMAIN_ICON_PICKER` is the curated set the custom-domain icon
 * picker offers.
 *
 * NO copyrighted material: agencies are represented by a generic Fluent icon +
 * a brand-ish color — a creative representation, never the official seal.
 */
import * as React from 'react';
import {
  Building24Regular, BuildingGovernment24Regular, BuildingBank24Regular,
  BuildingMultiple24Regular, BuildingSkyscraper24Regular, BuildingFactory24Regular,
  BuildingLighthouse24Regular, Home24Regular,
  Money24Regular, MoneyHand24Regular, Wallet24Regular, Vault24Regular,
  DataHistogram24Regular, DataTrending24Regular, ChartMultiple24Regular,
  MegaphoneLoud24Regular, Settings24Regular, Pulse24Regular, HeartPulse24Regular,
  People24Regular, PeopleTeam24Regular, PersonHeart24Regular, PersonStar24Regular,
  Organization24Regular,
  Shield24Regular, ShieldKeyhole24Regular, ShieldLock24Regular, ShieldTask24Regular,
  LockClosed24Regular, Eye24Regular, Fingerprint24Regular,
  Airplane24Regular, VehicleCar24Regular, VehicleTruck24Regular, VehicleShip24Regular,
  VehicleSubway24Regular, Navigation24Regular, Map24Regular,
  Heart24Regular, Stethoscope24Regular, Syringe24Regular, Pill24Regular,
  ClipboardPulse24Regular,
  Beaker24Regular, Flash24Regular, Lightbulb24Regular, LightbulbFilament24Regular,
  Fire24Regular, BatteryCharge24Regular,
  LeafOne24Regular, LeafThree24Regular, TreeDeciduous24Regular, PlantGrass24Regular,
  Water24Regular, Drop24Regular, WeatherRain24Regular, WeatherSunny24Regular,
  Globe24Regular, GlobeShield24Regular, GlobeLocation24Regular, Earth24Regular, BookGlobe24Regular,
  Gavel24Regular, Scales24Regular, Vote24Regular,
  Wrench24Regular, Toolbox24Regular,
  HatGraduation24Regular, Book24Regular, BookInformation24Regular,
  Rocket24Regular, Star24Regular, Ribbon24Regular, Trophy24Regular,
  Cube24Regular, Box24Regular, Database24Regular, Server24Regular, Document24Regular,
  Wifi124Regular, CellularData124Regular, Album24Regular,
  type FluentIcon,
} from '@fluentui/react-icons';

/**
 * The canonical name → Fluent-icon-component map. Names are stable strings used
 * on the domain doc (`domain.icon`) and in the fedciv library. Add new icons
 * here only; everything else resolves through this table.
 */
export const DOMAIN_ICONS: Record<string, FluentIcon> = {
  // Generic / org
  building: Building24Regular,
  'building-government': BuildingGovernment24Regular,
  'building-bank': BuildingBank24Regular,
  'building-multiple': BuildingMultiple24Regular,
  'building-skyscraper': BuildingSkyscraper24Regular,
  'building-factory': BuildingFactory24Regular,
  'building-lighthouse': BuildingLighthouse24Regular,
  home: Home24Regular,
  organization: Organization24Regular,
  // Finance
  money: Money24Regular,
  'money-hand': MoneyHand24Regular,
  wallet: Wallet24Regular,
  vault: Vault24Regular,
  'data-histogram': DataHistogram24Regular,
  'data-trending': DataTrending24Regular,
  'chart-multiple': ChartMultiple24Regular,
  // Sales / marketing / ops
  megaphone: MegaphoneLoud24Regular,
  gear: Settings24Regular,
  pulse: Pulse24Regular,
  // People
  people: People24Regular,
  'people-team': PeopleTeam24Regular,
  'person-heart': PersonHeart24Regular,
  'person-star': PersonStar24Regular,
  // Security / law enforcement
  shield: Shield24Regular,
  'shield-keyhole': ShieldKeyhole24Regular,
  'shield-lock': ShieldLock24Regular,
  'shield-task': ShieldTask24Regular,
  'lock-closed': LockClosed24Regular,
  eye: Eye24Regular,
  fingerprint: Fingerprint24Regular,
  // Transport
  airplane: Airplane24Regular,
  car: VehicleCar24Regular,
  truck: VehicleTruck24Regular,
  ship: VehicleShip24Regular,
  train: VehicleSubway24Regular,
  navigation: Navigation24Regular,
  map: Map24Regular,
  // Health
  heart: Heart24Regular,
  'heart-pulse': HeartPulse24Regular,
  stethoscope: Stethoscope24Regular,
  syringe: Syringe24Regular,
  pill: Pill24Regular,
  'clipboard-pulse': ClipboardPulse24Regular,
  // Science / energy
  beaker: Beaker24Regular,
  flash: Flash24Regular,
  lightbulb: Lightbulb24Regular,
  'lightbulb-filament': LightbulbFilament24Regular,
  fire: Fire24Regular,
  battery: BatteryCharge24Regular,
  // Environment / agriculture
  leaf: LeafOne24Regular,
  'leaf-three': LeafThree24Regular,
  tree: TreeDeciduous24Regular,
  plant: PlantGrass24Regular,
  water: Water24Regular,
  drop: Drop24Regular,
  rain: WeatherRain24Regular,
  sun: WeatherSunny24Regular,
  // Global / diplomacy
  globe: Globe24Regular,
  'globe-shield': GlobeShield24Regular,
  'globe-location': GlobeLocation24Regular,
  earth: Earth24Regular,
  'book-globe': BookGlobe24Regular,
  // Justice
  gavel: Gavel24Regular,
  scales: Scales24Regular,
  vote: Vote24Regular,
  // Labor / industry
  wrench: Wrench24Regular,
  toolbox: Toolbox24Regular,
  factory: BuildingFactory24Regular,
  // Education
  graduation: HatGraduation24Regular,
  book: Book24Regular,
  'book-information': BookInformation24Regular,
  // Space / awards
  rocket: Rocket24Regular,
  star: Star24Regular,
  ribbon: Ribbon24Regular,
  trophy: Trophy24Regular,
  // Data / tech / comms
  cube: Cube24Regular,
  box: Box24Regular,
  database: Database24Regular,
  server: Server24Regular,
  document: Document24Regular,
  wifi: Wifi124Regular,
  cellular: CellularData124Regular,
  archive: Album24Regular,
};

/** The default icon name used when a domain has none set (back-compat). */
export const DEFAULT_DOMAIN_ICON = 'building';
/** The default theme color used when a domain has none set (Loom brand blue). */
export const DEFAULT_DOMAIN_COLOR = '#0078d4';

/** Resolve a stored icon name to its Fluent component, falling back safely. */
export function resolveDomainIcon(name?: string): FluentIcon {
  if (name && DOMAIN_ICONS[name]) return DOMAIN_ICONS[name];
  return DOMAIN_ICONS[DEFAULT_DOMAIN_ICON];
}

export interface DomainIconOption {
  name: string;
  label: string;
}

/**
 * Curated icon set offered in the custom-domain icon picker. A pragmatic subset
 * of DOMAIN_ICONS with friendly labels (the full table is larger so the fedciv
 * library can be expressive, but the picker stays scannable).
 */
export const DOMAIN_ICON_PICKER: DomainIconOption[] = [
  { name: 'building', label: 'Building' },
  { name: 'building-government', label: 'Government' },
  { name: 'building-bank', label: 'Bank' },
  { name: 'home', label: 'Home' },
  { name: 'organization', label: 'Organization' },
  { name: 'money', label: 'Finance' },
  { name: 'wallet', label: 'Wallet' },
  { name: 'data-histogram', label: 'Analytics' },
  { name: 'chart-multiple', label: 'Reporting' },
  { name: 'megaphone', label: 'Marketing' },
  { name: 'gear', label: 'Operations' },
  { name: 'pulse', label: 'Telemetry' },
  { name: 'people', label: 'People' },
  { name: 'people-team', label: 'Team' },
  { name: 'person-heart', label: 'HR' },
  { name: 'shield', label: 'Security' },
  { name: 'shield-keyhole', label: 'Cyber' },
  { name: 'lock-closed', label: 'Compliance' },
  { name: 'airplane', label: 'Aviation' },
  { name: 'truck', label: 'Logistics' },
  { name: 'ship', label: 'Maritime' },
  { name: 'map', label: 'Geospatial' },
  { name: 'heart', label: 'Health' },
  { name: 'stethoscope', label: 'Medical' },
  { name: 'beaker', label: 'Research' },
  { name: 'flash', label: 'Energy' },
  { name: 'leaf', label: 'Environment' },
  { name: 'plant', label: 'Agriculture' },
  { name: 'water', label: 'Water' },
  { name: 'globe', label: 'Global' },
  { name: 'gavel', label: 'Justice' },
  { name: 'scales', label: 'Legal' },
  { name: 'wrench', label: 'Labor' },
  { name: 'factory', label: 'Industry' },
  { name: 'graduation', label: 'Education' },
  { name: 'book', label: 'Library' },
  { name: 'rocket', label: 'Space' },
  { name: 'star', label: 'Featured' },
  { name: 'database', label: 'Data' },
  { name: 'document', label: 'Records' },
];

/**
 * A curated theme-color palette for the custom-domain color picker. Saturated
 * brand-ish hues that read well as a white glyph on a colored chip.
 */
export const DOMAIN_THEME_COLORS = [
  '#0078d4', '#005a9e', '#003f7d', '#106ebe',
  '#107c10', '#0b6a0b', '#498205', '#7a7574',
  '#bd7800', '#dca900', '#c19c00', '#8e562e',
  '#d13438', '#a4262c', '#a80000', '#7719aa',
  '#5c2d91', '#881798', '#0e7490', '#1b6b8c',
  '#3aaaaa', '#005e5e', '#605e5c', '#1b1a19',
] as const;

/**
 * Render a domain glyph chip: a Fluent icon (resolved by name) reversed white
 * on a rounded, themed-color tile. This is the canonical domain visual; size
 * scales the chip and the glyph proportionally.
 */
export function DomainGlyph({
  icon, color, size = 32,
}: {
  icon?: string;
  color?: string;
  size?: number;
}): React.ReactElement {
  const Icon = resolveDomainIcon(icon);
  const chip: React.CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: color || DEFAULT_DOMAIN_COLOR, color: '#fff', overflow: 'hidden',
  };
  return (
    <span style={chip} aria-hidden="true">
      <Icon fontSize={Math.round(size * 0.6)} />
    </span>
  );
}

export default DomainGlyph;

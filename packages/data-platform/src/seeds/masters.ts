/**
 * platform master seed data (doc 10 §4 + §11 P0).
 *
 * master_types + key master_items, including the Indian measurement units with
 * conversion metadata. Conversion shape per §4: `{dimension, base, factor}` where
 * `factor` = number of BASE units in ONE of this unit. Area base = `sqft`. So sqm →
 * factor 10.7639 (1 sqm = 10.7639 sqft); bigha varies regionally, so we record the
 * common Central-India / MP value and flag `regional:true` so the app can override.
 *
 * Idempotent: types keyed by `key`; items keyed by (type_key, key).
 */

/** The registry of master lists (extend via INSERT, never a migration). */
export const MASTER_TYPES: ReadonlyArray<{
  key: string;
  name: string;
  isHierarchical: boolean;
}> = [
  { key: "property_type", name: "Property Type", isHierarchical: false },
  { key: "unit_type", name: "Unit Type", isHierarchical: false },
  { key: "amenity", name: "Amenity", isHierarchical: false },
  { key: "document_type", name: "Document Type", isHierarchical: false },
  { key: "material_category", name: "Material Category", isHierarchical: true },
  { key: "brand", name: "Brand", isHierarchical: false },
  { key: "measurement_unit", name: "Measurement Unit", isHierarchical: false },
  { key: "defect_taxonomy", name: "Defect Taxonomy", isHierarchical: true },
  { key: "inspection_type", name: "Inspection Type", isHierarchical: false },
  { key: "verification_type", name: "Verification Type", isHierarchical: false },
  { key: "room_type", name: "Room Type", isHierarchical: false },
];

export interface SeedMasterItem {
  typeKey: string;
  key: string;
  label: string;
  /** synthetic parent key within the same type (hierarchical); null otherwise. */
  parentKey?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

/**
 * measurement_unit items. Area base = sqft. `factor` = sqft per 1 unit.
 *  - sqft   : 1            (the base)
 *  - sqm    : 10.7639
 *  - sqyd   : 9            (1 sq yard = 9 sqft)
 *  - acre   : 43560
 *  - hectare: 107639.104
 *  - cent    : 435.6       (1 cent = 1/100 acre)
 *  - guntha : 1089         (1 guntha = 1/40 acre)
 *  - bigha  : regional — MP/central ≈ 12000 sqft (marked regional)
 *  - kanal  : 5445         (1 kanal = 1/8 acre, North India)
 *  - marla  : 272.25       (1 marla = 1/20 kanal)
 * Length/height units (m, ft) included for room dimensions; base = ft.
 */
export const MEASUREMENT_UNITS: ReadonlyArray<SeedMasterItem> = [
  { typeKey: "measurement_unit", key: "sqft", label: "Square Feet", sortOrder: 1, metadata: { dimension: "area", base: "sqft", factor: 1, symbol: "sq.ft" } },
  { typeKey: "measurement_unit", key: "sqm", label: "Square Metre", sortOrder: 2, metadata: { dimension: "area", base: "sqft", factor: 10.7639, symbol: "sq.m" } },
  { typeKey: "measurement_unit", key: "sqyd", label: "Square Yard (Gaj)", sortOrder: 3, metadata: { dimension: "area", base: "sqft", factor: 9, symbol: "sq.yd" } },
  { typeKey: "measurement_unit", key: "acre", label: "Acre", sortOrder: 4, metadata: { dimension: "area", base: "sqft", factor: 43560, symbol: "ac" } },
  { typeKey: "measurement_unit", key: "hectare", label: "Hectare", sortOrder: 5, metadata: { dimension: "area", base: "sqft", factor: 107639.104, symbol: "ha" } },
  { typeKey: "measurement_unit", key: "cent", label: "Cent", sortOrder: 6, metadata: { dimension: "area", base: "sqft", factor: 435.6, symbol: "cent" } },
  { typeKey: "measurement_unit", key: "guntha", label: "Guntha", sortOrder: 7, metadata: { dimension: "area", base: "sqft", factor: 1089, symbol: "guntha", regional: true } },
  { typeKey: "measurement_unit", key: "bigha", label: "Bigha (Central India)", sortOrder: 8, metadata: { dimension: "area", base: "sqft", factor: 12000, symbol: "bigha", regional: true, note: "Bigha varies by region; MP/central value used. Override per state." } },
  { typeKey: "measurement_unit", key: "kanal", label: "Kanal", sortOrder: 9, metadata: { dimension: "area", base: "sqft", factor: 5445, symbol: "kanal", regional: true } },
  { typeKey: "measurement_unit", key: "marla", label: "Marla", sortOrder: 10, metadata: { dimension: "area", base: "sqft", factor: 272.25, symbol: "marla", regional: true } },
  // length (room dimensions) — base = ft
  { typeKey: "measurement_unit", key: "ft", label: "Feet", sortOrder: 20, metadata: { dimension: "length", base: "ft", factor: 1, symbol: "ft" } },
  { typeKey: "measurement_unit", key: "m", label: "Metre", sortOrder: 21, metadata: { dimension: "length", base: "ft", factor: 3.28084, symbol: "m" } },
];

/** A small, useful starter set of the other key masters (extend via INSERT). */
export const STARTER_MASTER_ITEMS: ReadonlyArray<SeedMasterItem> = [
  // property_type
  { typeKey: "property_type", key: "apartment", label: "Apartment / Flat", sortOrder: 1 },
  { typeKey: "property_type", key: "villa", label: "Villa", sortOrder: 2 },
  { typeKey: "property_type", key: "independent_house", label: "Independent House", sortOrder: 3 },
  { typeKey: "property_type", key: "plot", label: "Plot / Land", sortOrder: 4 },
  { typeKey: "property_type", key: "commercial", label: "Commercial", sortOrder: 5 },
  // unit_type
  { typeKey: "unit_type", key: "1bhk", label: "1 BHK", sortOrder: 1 },
  { typeKey: "unit_type", key: "2bhk", label: "2 BHK", sortOrder: 2 },
  { typeKey: "unit_type", key: "3bhk", label: "3 BHK", sortOrder: 3 },
  { typeKey: "unit_type", key: "4bhk", label: "4 BHK", sortOrder: 4 },
  // room_type
  { typeKey: "room_type", key: "bedroom", label: "Bedroom", sortOrder: 1 },
  { typeKey: "room_type", key: "kitchen", label: "Kitchen", sortOrder: 2 },
  { typeKey: "room_type", key: "living_room", label: "Living Room", sortOrder: 3 },
  { typeKey: "room_type", key: "bathroom", label: "Bathroom", sortOrder: 4 },
  { typeKey: "room_type", key: "balcony", label: "Balcony", sortOrder: 5 },
  // document_type
  { typeKey: "document_type", key: "sale_deed", label: "Sale Deed", sortOrder: 1 },
  { typeKey: "document_type", key: "registry", label: "Registry", sortOrder: 2 },
  { typeKey: "document_type", key: "ec", label: "Encumbrance Certificate", sortOrder: 3 },
  { typeKey: "document_type", key: "rera", label: "RERA Certificate", sortOrder: 4 },
  { typeKey: "document_type", key: "oc", label: "Occupancy Certificate", sortOrder: 5 },
  // material_category (hierarchical) — a couple of parents + children
  { typeKey: "material_category", key: "flooring", label: "Flooring", sortOrder: 1 },
  { typeKey: "material_category", key: "flooring_tile", label: "Tile", parentKey: "flooring", sortOrder: 1 },
  { typeKey: "material_category", key: "flooring_marble", label: "Marble", parentKey: "flooring", sortOrder: 2 },
  { typeKey: "material_category", key: "paint", label: "Paint", sortOrder: 2 },
  { typeKey: "material_category", key: "door", label: "Door", sortOrder: 3 },
  { typeKey: "material_category", key: "window", label: "Window", sortOrder: 4 },
  // amenity
  { typeKey: "amenity", key: "lift", label: "Lift", sortOrder: 1 },
  { typeKey: "amenity", key: "parking", label: "Parking", sortOrder: 2 },
  { typeKey: "amenity", key: "power_backup", label: "Power Backup", sortOrder: 3 },
  { typeKey: "amenity", key: "security", label: "24x7 Security", sortOrder: 4 },
  { typeKey: "amenity", key: "gym", label: "Gymnasium", sortOrder: 5 },
  { typeKey: "amenity", key: "clubhouse", label: "Clubhouse", sortOrder: 6 },
  // inspection_type
  { typeKey: "inspection_type", key: "structural", label: "Structural Inspection", sortOrder: 1 },
  { typeKey: "inspection_type", key: "snagging", label: "Snagging Inspection", sortOrder: 2 },
  // verification_type
  { typeKey: "verification_type", key: "document", label: "Document Verification", sortOrder: 1 },
  { typeKey: "verification_type", key: "ownership", label: "Ownership Verification", sortOrder: 2 },
  { typeKey: "verification_type", key: "government", label: "Government Records", sortOrder: 3 },
];

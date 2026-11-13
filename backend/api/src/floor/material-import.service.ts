/**
 * STOCK-FIX-RP (STK-17, STK-18, STK-19): raw materials in bulk, from a CSV, with a dry run first, as
 * the recipe import has (cluster-formula setup/recipe-csv.ts).
 *
 * The rehearsal made 196 materials with 392 calls (create, then floor code), and its first pass turned
 * the sheet's total row into a material. POST /v1/materials/import reads one file:
 *
 *   material_name (or name, material)   required
 *   material_code (or code)              optional: minted in order (RM-00001, RM-00002, ...) at commit
 *   family (or floor_family)             optional: the floor family; the floor code is filed in order
 *   cas (or cas_number)                  optional: checked by its check digit
 *   hazard_class, hazard_source          optional: a UN class needs the source it was read from
 *
 * Every line is checked before anything is written: a total row, a name already on file or twice in
 * the file (case and spaces aside), a code taken, a family not on file, a bad CAS number, a class with
 * no source are ERRORS and block the whole file; a name that only looks like another (one letter, or
 * the same letters and digits) is a WARNING for a person to decide, never merged. `commit: true` with
 * no errors writes every material, its outbox event (as MaterialService does) and its floor code in ONE
 * transaction. Nothing from the file is logged.
 *
 * IMPORT-RP: the same judgement (`check`) and the same writer (`writeRow`) now serve two doors: this
 * route, answering as it always has, and the `ingredients` kind of the bulk import
 * (api/src/imports), which adds the unit, the default supplier and a measured density. Each material
 * is written by MaterialService.createMaterial (the function POST /v1/materials calls), its floor code
 * by FloorCodeService.assignCodeTx and its supplier link by VendorService.createVendorRmMapping, all
 * bound to the caller's transaction, so a sheet and a form cannot be judged or written differently.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asPool, casValid, parseDecimal, decimalText, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { detectDelimiter, parseCsv } from '@ra/cluster-formula';
import { HAZARD_CLASSES, isTotalRow, MATERIAL_NAME_KEY_TEXT, MaterialService, masterdataSchema, materialNameKey, type CreateMaterial } from '@ra/cluster-masterdata';
import { VendorService, procurementSchema } from '@ra/cluster-procurement';
import { FloorCodeService } from './floor-code.service.js';

export interface MaterialImportRow {
  line: number;
  materialName: string;
  materialCode: string | null;
  family: string | null;
  casNumber: string | null;
  hazardClass: string | null;
  errors: string[];
  warnings: string[];
}
export interface MaterialImportResult {
  committed: boolean;
  rows: MaterialImportRow[];
  errorCount: number;
  warningCount: number;
  created: Array<{ line: number; materialId: string; materialCode: string; floorCode: string | null }>;
}

const MAX_ROWS = 5000;
const pick = (cells: Record<string, string>, ...names: string[]) => {
  for (const n of names) { const v = cells[n]; if (v !== undefined && v.trim() !== '') return v.trim(); }
  return null;
};
/** Letters and digits only: "Hedione HC" and "HEDIONE-HC" are the same here. */
const looseKey = (s: string) => materialNameKey(s).replace(/[^a-z0-9]/g, '');
/** One edit apart (a letter added, dropped or changed), for names long enough to mean it. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 6) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
export { casValid };

/** One line as either door hands it over: the route's CSV, or a row of the ingredients sheet. */
export interface MaterialImportInput {
  line: number;
  materialName: string;
  materialCode: string | null;
  family: string | null;
  casNumber: string | null;
  hazardClass: string | null;
  hazardSource: string | null;
  /** IMPORT-RP (the ingredients sheet only): a unit code, a supplier's code or name, a density in g/ml and its source. */
  unit?: string | null;
  supplier?: string | null;
  density?: string | null;
  densitySource?: string | null;
}
/** A judged line: what the route returns, plus what the writer needs and never returns. */
export interface MaterialChecked extends MaterialImportRow {
  hazardSource: string | null;
  /** The material of this exact name already on file, when there is one. */
  existing: { materialCode: string | null } | null;
  /** True when the only thing wrong is that this very material is already on file under this code (or no code was given). */
  alreadyOnFile: boolean;
  uomId: string | null;
  vendorId: string | null;
  density: string | null;
  densitySource: string | null;
}

/** Density in g/ml: a perfumery liquid or solid sits between these. Outside them it is a typo or another unit. */
const DENSITY_MIN = 0.3, DENSITY_MAX = 2.5;

@Injectable()
export class MaterialImportService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly codes: FloorCodeService) {}

  /** The route: a CSV as text, a dry run unless `commit` is true. Its answer is unchanged. */
  async import(body: { csv?: unknown; commit?: unknown }, principal: AuthPrincipal): Promise<MaterialImportResult> {
    if (typeof body?.csv !== 'string' || !body.csv.trim()) throw new BadRequestException('Send the file as text in "csv".');
    const table = parseCsv(body.csv, detectDelimiter(body.csv));
    if (!table.header.some((h) => ['material_name', 'name', 'material'].includes(h))) {
      throw new BadRequestException('The file needs a material_name column (or name, or material).');
    }
    if (table.rows.length > MAX_ROWS) throw new BadRequestException(`At most ${MAX_ROWS} rows in one file.`);

    const rows = await this.check(table.rows.map((r) => ({
      line: r.line,
      materialName: pick(r.cells, 'material_name', 'name', 'material') ?? '',
      materialCode: pick(r.cells, 'material_code', 'code'),
      family: pick(r.cells, 'family', 'floor_family'),
      casNumber: pick(r.cells, 'cas', 'cas_number'),
      hazardClass: pick(r.cells, 'hazard_class'),
      hazardSource: pick(r.cells, 'hazard_source'),
    })));

    const errorCount = rows.reduce((n, r) => n + r.errors.length, 0);
    const warningCount = rows.reduce((n, r) => n + r.warnings.length, 0);
    const out = (committed: boolean, created: MaterialImportResult['created'] = []) => ({
      committed, errorCount, warningCount, created,
      rows: rows.map((r) => ({ line: r.line, materialName: r.materialName, materialCode: r.materialCode, family: r.family, casNumber: r.casNumber, hazardClass: r.hazardClass, errors: r.errors, warnings: r.warnings })),
    });
    if (body.commit !== true || errorCount > 0) return out(false);

    const created = await this.sql.begin(async (tx) => {
      const made: MaterialImportResult['created'] = [];
      for (const r of rows) made.push({ line: r.line, ...(await this.writeRow(tx, r, principal)) });
      return made;
    });
    return out(true, created);
  }

  /** Every line judged, and nothing written. A line with no entry in `errors` may be written. */
  async check(inputs: readonly MaterialImportInput[]): Promise<MaterialChecked[]> {
    const rows: MaterialChecked[] = inputs.map((r) => ({
      line: r.line,
      materialName: r.materialName,
      materialCode: r.materialCode,
      family: r.family?.toLowerCase() ?? null,
      casNumber: r.casNumber,
      hazardClass: r.hazardClass?.toUpperCase() ?? null,
      errors: [],
      warnings: [],
      hazardSource: r.hazardSource,
      existing: null, alreadyOnFile: false, uomId: null, vendorId: null, density: null, densitySource: r.densitySource ?? null,
    }));

    const names = rows.map((r) => materialNameKey(r.materialName)).filter(Boolean);
    const onFile = names.length
      ? await this.sql.unsafe<{ key: string; material_name: string; material_code: string | null }[]>(
        `select ${MATERIAL_NAME_KEY_TEXT} as key, material_name, material_code from masterdata.material`)
      : [];
    const byKey = new Map(onFile.map((m) => [m.key, m]));
    const byLoose = new Map(onFile.map((m) => [looseKey(m.material_name), m]));
    const codesGiven = rows.map((r) => r.materialCode).filter((c): c is string => !!c);
    const codesTaken = new Set(codesGiven.length
      ? (await this.sql<{ c: string }[]>`select material_code as c from masterdata.material where upper(material_code) = any(${codesGiven.map((c) => c.toUpperCase())})`).map((x) => x.c.toUpperCase())
      : []);
    const families = new Set((await this.sql<{ f: string }[]>`select family_code as f from masterdata.floor_family_colour`).map((x) => x.f));
    const wantsUnit = inputs.some((r) => r.unit), wantsSupplier = inputs.some((r) => r.supplier);
    const uoms = new Map(wantsUnit ? (await this.sql<{ id: string; code: string }[]>`select uom_id::text as id, lower(uom_code) as code from platform.uom_master where uom_code is not null`).map((u) => [u.code, u.id]) : []);
    const vendors = wantsSupplier ? await this.sql<{ id: string; code: string | null; name: string | null }[]>`select vendor_id::text as id, lower(vendor_code) as code, lower(btrim(vendor_name)) as name from procurement.vendor_details` : [];

    const seenKey = new Map<string, number>(), seenLoose = new Map<string, number>(), seenCode = new Map<string, number>();
    rows.forEach((r, i) => {
      const input = inputs[i]!;
      const key = materialNameKey(r.materialName);
      if (!key) { r.errors.push('the name is missing'); return; }
      if (isTotalRow(r.materialName)) { r.errors.push(`"${r.materialName}" is a sheet's total row, not a material`); return; }
      if (/^total\b/i.test(r.materialName)) r.warnings.push('the name begins with "Total": check this is a material and not a total');
      const dupe = seenKey.get(key);
      if (dupe !== undefined) r.errors.push(`the same material as line ${dupe} (only case or spaces differ): one material, one name`);
      else seenKey.set(key, r.line);
      const existing = byKey.get(key);
      // `same` counts the errors that say only "this very record is already on file" (see alreadyOnFile).
      let same = 0;
      const sameRecord = !!existing && (!r.materialCode || r.materialCode.toUpperCase() === (existing.material_code ?? '').toUpperCase());
      if (existing) { r.existing = { materialCode: existing.material_code }; r.errors.push(`already on file as ${existing.material_code ?? 'a material with no code'}`); if (sameRecord) same++; }
      const loose = looseKey(r.materialName);
      const nearLine = seenLoose.get(loose);
      if (dupe === undefined && nearLine !== undefined) r.warnings.push(`looks like line ${nearLine}: check it is a different material`);
      else if (!existing && byLoose.get(loose)) r.warnings.push(`looks like ${byLoose.get(loose)!.material_code ?? 'a material on file'}: check it is a different material`);
      else if (dupe === undefined) {
        const close = [...seenLoose.entries()].find(([k]) => oneEditApart(k, loose));
        if (close) r.warnings.push(`one letter from line ${close[1]}: check it is a different material, not a spelling`);
      }
      if (!seenLoose.has(loose)) seenLoose.set(loose, r.line);
      if (r.materialCode) {
        const c = r.materialCode.toUpperCase();
        if (codesTaken.has(c)) { r.errors.push(`the code ${r.materialCode} is already on file`); if (sameRecord) same++; }
        const other = seenCode.get(c);
        if (other !== undefined) r.errors.push(`the code ${r.materialCode} is also on line ${other}`);
        else seenCode.set(c, r.line);
        if (r.materialCode.length > 50) r.errors.push('the code is longer than 50 characters');
      }
      if (r.materialName.length > 200) r.errors.push('the name is longer than 200 characters');
      if (r.family && !families.has(r.family)) r.errors.push(`no floor family "${r.family}" (add it to the colour table first)`);
      if (r.casNumber && !casValid(r.casNumber)) r.errors.push(`${r.casNumber} is not a CAS number (its check digit does not match)`);
      if (r.hazardClass && !(HAZARD_CLASSES as readonly string[]).includes(r.hazardClass)) r.errors.push(`${r.hazardClass} is not a UN hazard class`);
      if (r.hazardClass && !r.hazardSource) r.errors.push('a hazard class needs its source (the SDS or the supplier\'s declaration)');
      if (input.unit) {
        r.uomId = uoms.get(input.unit.trim().toLowerCase()) ?? null;
        if (!r.uomId) r.errors.push(`the unit "${input.unit}" is not in the unit list (Setup, Units)`);
      }
      if (input.supplier) {
        const want = input.supplier.trim().toLowerCase();
        const hits = vendors.filter((v) => v.code === want || v.name === want);
        if (hits.length === 1) r.vendorId = hits[0]!.id;
        else r.errors.push(hits.length === 0 ? `no supplier "${input.supplier}" on file (add the supplier first)` : `"${input.supplier}" matches ${hits.length} suppliers: use the supplier code`);
      }
      if (input.density) {
        const d = parseDecimal(input.density, 4);
        const n = d ? Number(decimalText(d)) : NaN;
        if (!d || d.negative) r.errors.push(`the density "${input.density}" must be a number of grams per millilitre with at most four decimals, like 0.985`);
        else if (n < DENSITY_MIN || n > DENSITY_MAX) r.errors.push(`a density of ${input.density} g/ml is outside ${DENSITY_MIN} to ${DENSITY_MAX}: check the figure and its unit (grams per millilitre)`);
        else r.density = decimalText(d);
        if (!input.densitySource) r.errors.push('a density needs its source (the CoA or the SDS it was read from, or who measured it)');
      } else if (input.densitySource) r.errors.push('a density source is given with no density: give the measured figure, or clear the source');
      // This very material, under this very code (or none given), and nothing else wrong: the row is
      // already in, not wrong. The route still reports it as an error, as it always has; the bulk
      // import reads this flag and calls the row a skip.
      r.alreadyOnFile = sameRecord && r.errors.length === same;
    });
    return rows;
  }

  /**
   * Write one judged line inside the caller's transaction, through the single-record functions:
   * MaterialService.createMaterial (its own name check and its outbox event), the floor code, and the
   * supplier link. Minted codes are taken in order under one lock for the whole transaction.
   */
  async writeRow(tx: TransactionSql, r: MaterialChecked, principal: AuthPrincipal): Promise<{ materialId: string; materialCode: string; floorCode: string | null }> {
    // One import at a time takes minted codes and floor numbers in order.
    await tx`select pg_advisory_xact_lock(hashtext('masterdata.material.import'))`;
    const code = r.materialCode ?? `RM-${String(await this.nextMintedCode(tx)).padStart(5, '0')}`;
    const body: CreateMaterial = {
      materialCode: code, materialName: r.materialName,
      ...(r.casNumber ? { casNumber: r.casNumber } : {}),
      ...(r.hazardClass ? { hazardClass: r.hazardClass as CreateMaterial['hazardClass'], hazardSource: r.hazardSource ?? undefined } : {}),
      ...(r.uomId ? { uomId: r.uomId } : {}),
      ...(r.density ? { density: Number(r.density), densitySource: r.densitySource ?? undefined } : {}),
    };
    const materials = new MaterialService(drizzle(asPool(tx, this.sql), { schema: masterdataSchema }) as never);
    let materialId: string;
    try { materialId = (await materials.createMaterial(body, principal)).materialId; }
    catch (err) {
      if ((err as { getStatus?: () => number }).getStatus?.() === 409) throw new BadRequestException(`Line ${r.line}: a material of that name was added while this file was checked. Run the dry run again.`);
      throw err;
    }
    let floorCode: string | null = null;
    if (r.family) {
      await this.codes.assignCodeTx(tx, materialId, r.family, principal.userId);
      const [fc] = await tx<{ colour_name: string; number: number }[]>`
        select f.colour_name, c.number from masterdata.floor_code c join masterdata.floor_family_colour f on f.family_code = c.family_code where c.material_id = ${materialId}`;
      floorCode = fc ? `${fc.colour_name.toUpperCase().replace(/[^A-Z]/g, '')}-${String(fc.number).padStart(4, '0')}` : null;
    }
    if (r.vendorId) {
      await new VendorService(drizzle(asPool(tx, this.sql), { schema: procurementSchema }) as never).createVendorRmMapping({ vendorId: r.vendorId, materialId, isPreferred: true }, principal);
    }
    return { materialId, materialCode: code, floorCode };
  }

  /** The next RM-nnnnn number, in order after every code of that shape on file. */
  private async nextMintedCode(tx: TransactionSql): Promise<number> {
    const [r] = await tx<{ n: number }[]>`
      select coalesce(max(substring(material_code from '^RM-([0-9]{5})$')::int), 0) + 1 as n from masterdata.material where material_code ~ '^RM-[0-9]{5}$'`;
    return r?.n ?? 1;
  }
}

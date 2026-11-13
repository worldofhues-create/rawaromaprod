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
 * Every line is checked before anything is written: a total row, a name twice in the file (case and
 * spaces aside), a code taken, a family not on file, a bad CAS number, a class with no source are ERRORS
 * and block the whole file; a name that only looks like another (one letter, or the same letters and
 * digits) is a WARNING for a person to decide, never merged. `commit: true` with no errors writes every
 * material, its outbox event (as MaterialService does) and its floor code in ONE transaction. Nothing
 * from the file is logged.
 *
 * STK-30 (STOCK-E2E-2): A NAME ALREADY ON FILE IS THAT MATERIAL, not an error. The row is reported with
 * the code it is on file under (`onFile`), nothing is made for it, and the rest of the file is imported;
 * so the same file a second time changes nothing and says so. It used to refuse the WHOLE file, and the
 * factory already holds every material Alembic's catalogue sent it: a sheet of 196 raw materials that
 * named two of them could not load the other 194. One thing still refuses: a row that gives the material
 * on file a DIFFERENT code. A material on file with no floor code gets one when the row names its family
 * (a material with no floor code cannot be put on a floor job); a floor code on file is never changed.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { detectDelimiter, parseCsv } from '@ra/cluster-formula';
import { HAZARD_CLASSES, isTotalRow, MATERIAL_NAME_KEY_TEXT, materialNameKey } from '@ra/cluster-masterdata';
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
  /** The material this name is already on file as (nothing is made for the row), or null: a new material. */
  onFile: { materialCode: string | null } | null;
}
export interface MaterialImportResult {
  committed: boolean;
  rows: MaterialImportRow[];
  errorCount: number;
  warningCount: number;
  created: Array<{ line: number; materialId: string; materialCode: string; floorCode: string | null }>;
  /** Rows whose material was on file already: its id and codes, so a caller can use it as it uses a new one. */
  existing: Array<{ line: number; materialId: string; materialCode: string | null; floorCode: string | null }>;
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
/** CAS Registry Number: digits-digits-check, the check digit verified. */
export function casValid(cas: string): boolean {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas);
  if (!m) return false;
  const digits = (m[1]! + m[2]!).split('').reverse();
  const sum = digits.reduce((a, d, i) => a + Number(d) * (i + 1), 0);
  return sum % 10 === Number(m[3]);
}

@Injectable()
export class MaterialImportService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly codes: FloorCodeService) {}

  async import(body: { csv?: unknown; commit?: unknown }, principal: AuthPrincipal): Promise<MaterialImportResult> {
    if (typeof body?.csv !== 'string' || !body.csv.trim()) throw new BadRequestException('Send the file as text in "csv".');
    const table = parseCsv(body.csv, detectDelimiter(body.csv));
    if (!table.header.some((h) => ['material_name', 'name', 'material'].includes(h))) {
      throw new BadRequestException('The file needs a material_name column (or name, or material).');
    }
    if (table.rows.length > MAX_ROWS) throw new BadRequestException(`At most ${MAX_ROWS} rows in one file.`);

    const rows: MaterialImportRow[] = table.rows.map((r) => ({
      line: r.line,
      materialName: pick(r.cells, 'material_name', 'name', 'material') ?? '',
      materialCode: pick(r.cells, 'material_code', 'code'),
      family: pick(r.cells, 'family', 'floor_family')?.toLowerCase() ?? null,
      casNumber: pick(r.cells, 'cas', 'cas_number'),
      hazardClass: pick(r.cells, 'hazard_class')?.toUpperCase() ?? null,
      errors: [],
      warnings: [],
      onFile: null,
      hazardSource: pick(r.cells, 'hazard_source'),
    })) as Array<MaterialImportRow & { hazardSource: string | null }>;

    const names = rows.map((r) => materialNameKey(r.materialName)).filter(Boolean);
    const onFile = names.length
      ? await this.sql.unsafe<{ key: string; material_id: string; material_name: string; material_code: string | null }[]>(
        `select ${MATERIAL_NAME_KEY_TEXT} as key, material_id::text, material_name, material_code from masterdata.material`)
      : [];
    const byKey = new Map(onFile.map((m) => [m.key, m]));
    const byLoose = new Map(onFile.map((m) => [looseKey(m.material_name), m]));
    const codesGiven = rows.map((r) => r.materialCode).filter((c): c is string => !!c);
    const codesTaken = new Set(codesGiven.length
      ? (await this.sql<{ c: string }[]>`select material_code as c from masterdata.material where upper(material_code) = any(${codesGiven.map((c) => c.toUpperCase())})`).map((x) => x.c.toUpperCase())
      : []);
    const families = new Set((await this.sql<{ f: string }[]>`select family_code as f from masterdata.floor_family_colour`).map((x) => x.f));

    const seenKey = new Map<string, number>(), seenLoose = new Map<string, number>(), seenCode = new Map<string, number>();
    for (const r of rows as Array<MaterialImportRow & { hazardSource: string | null }>) {
      const key = materialNameKey(r.materialName);
      if (!key) { r.errors.push('the name is missing'); continue; }
      if (isTotalRow(r.materialName)) { r.errors.push(`"${r.materialName}" is a sheet's total row, not a material`); continue; }
      if (/^total\b/i.test(r.materialName)) r.warnings.push('the name begins with "Total": check this is a material and not a total');
      const dupe = seenKey.get(key);
      if (dupe !== undefined) r.errors.push(`the same material as line ${dupe} (only case or spaces differ): one material, one name`);
      else seenKey.set(key, r.line);
      const existing = byKey.get(key);
      if (existing && dupe === undefined) {
        // STK-30: the material itself, unless the row contradicts it with another code.
        if (r.materialCode && r.materialCode.toUpperCase() !== (existing.material_code ?? '').toUpperCase()) {
          r.errors.push(`already on file as ${existing.material_code ?? 'a material with no code'}: it cannot be given the code ${r.materialCode}`);
        } else r.onFile = { materialCode: existing.material_code };
      }
      const loose = looseKey(r.materialName);
      const nearLine = seenLoose.get(loose);
      if (dupe === undefined && nearLine !== undefined) r.warnings.push(`looks like line ${nearLine}: check it is a different material`);
      else if (!existing && byLoose.get(loose)) r.warnings.push(`looks like ${byLoose.get(loose)!.material_code ?? 'a material on file'}: check it is a different material`);
      else if (dupe === undefined) {
        const close = [...seenLoose.entries()].find(([k]) => oneEditApart(k, loose));
        if (close) r.warnings.push(`one letter from line ${close[1]}: check it is a different material, not a spelling`);
      }
      if (!seenLoose.has(loose)) seenLoose.set(loose, r.line);
      if (r.materialCode && !r.onFile) {
        const c = r.materialCode.toUpperCase();
        if (codesTaken.has(c)) r.errors.push(`the code ${r.materialCode} is already on file`);
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
    }

    const errorCount = rows.reduce((n, r) => n + r.errors.length, 0);
    const warningCount = rows.reduce((n, r) => n + r.warnings.length, 0);
    const out = (committed: boolean, created: MaterialImportResult['created'] = [], existing: MaterialImportResult['existing'] = []) => ({
      committed, errorCount, warningCount, created, existing,
      rows: rows.map(({ ...r }) => { delete (r as { hazardSource?: unknown }).hazardSource; return r; }),
    });
    if (body.commit !== true || errorCount > 0) return out(false);

    const floorCodeOf = async (tx: TransactionSql, materialId: string): Promise<string | null> => {
      const [fc] = await tx<{ colour_name: string; number: number }[]>`
        select f.colour_name, c.number from masterdata.floor_code c join masterdata.floor_family_colour f on f.family_code = c.family_code where c.material_id = ${materialId}`;
      return fc ? `${fc.colour_name.toUpperCase().replace(/[^A-Z]/g, '')}-${String(fc.number).padStart(4, '0')}` : null;
    };
    const existing: MaterialImportResult['existing'] = [];
    const created = await this.sql.begin(async (tx) => {
      // One import at a time takes minted codes and floor numbers in order.
      await tx`select pg_advisory_xact_lock(hashtext('masterdata.material.import'))`;
      const made: MaterialImportResult['created'] = [];
      let nextCode = await this.nextMintedCode(tx);
      for (const r of rows as Array<MaterialImportRow & { hazardSource: string | null }>) {
        await tx`select pg_advisory_xact_lock(hashtext(${'masterdata.material.name:' + materialNameKey(r.materialName)}))`;
        const [clash] = await tx.unsafe<{ material_id: string; material_code: string | null }[]>(
          `select material_id::text, material_code from masterdata.material where ${MATERIAL_NAME_KEY_TEXT} = $1 limit 1`, [materialNameKey(r.materialName)]);
        if (r.onFile) {
          // STK-30: on file at the dry run, so nothing is made. Gone since then is as much a change as added since then.
          if (!clash) throw new BadRequestException(`Line ${r.line}: the material this name was on file as is no longer there. Run the dry run again.`);
          let floorCode = await floorCodeOf(tx, clash.material_id);
          if (!floorCode && r.family) { await this.codes.assignCodeTx(tx, clash.material_id, r.family, principal.userId); floorCode = await floorCodeOf(tx, clash.material_id); }
          existing.push({ line: r.line, materialId: clash.material_id, materialCode: clash.material_code, floorCode });
          continue;
        }
        if (clash) throw new BadRequestException(`Line ${r.line}: a material of that name was added while this file was checked. Run the dry run again.`);
        const materialId = uuidv7();
        const code = r.materialCode ?? `RM-${String(nextCode++).padStart(5, '0')}`;
        await tx`insert into masterdata.material (material_id, material_code, material_name, cas_number, hazard_class, hazard_source, status, created_by, updated_by)
                 values (${materialId}, ${code}, ${r.materialName}, ${r.casNumber}, ${r.hazardClass}, ${r.hazardClass ? r.hazardSource : null}, 'ACTIVE', ${principal.userId}, ${principal.userId})`;
        await tx`insert into masterdata.outbox (type, aggregate_id, payload) values ('masterdata.material.created', ${materialId}::uuid, ${JSON.stringify({ materialId })}::text::jsonb)`;
        let floorCode: string | null = null;
        if (r.family) {
          await this.codes.assignCodeTx(tx, materialId, r.family, principal.userId);
          floorCode = await floorCodeOf(tx, materialId);
        }
        made.push({ line: r.line, materialId, materialCode: code, floorCode });
      }
      return made;
    });
    return out(true, created, existing);
  }

  /** The next RM-nnnnn number, in order after every code of that shape on file. */
  private async nextMintedCode(tx: TransactionSql): Promise<number> {
    const [r] = await tx<{ n: number }[]>`
      select coalesce(max(substring(material_code from '^RM-([0-9]{5})$')::int), 0) + 1 as n from masterdata.material where material_code ~ '^RM-[0-9]{5}$'`;
    return r?.n ?? 1;
  }
}

/**
 * IMPORT-RP — the `formulas` import kind, on the Vault box only.
 *
 * THE FORMULA RULE. A formula is the house's trade secret, and this file holds the rule in code:
 *
 *   who      `vault:formula_import:write`, held by exactly the roles that hold the seal permission
 *            (formula:formula_ingredients:write: the formulator). The owner's blanket grant excludes
 *            every vault:* permission, so "god-mode stops at the vault door" holds here too.
 *   where    this kind exists only on the Vault box (formula.module.ts mounts it under VAULT_MODE);
 *            the factory box has no formulas kind and no route to this one's database.
 *   seal     every accepted version is handed to FormulaSetupService.importRecipes, the function
 *            POST /v1/formula-recipes/import calls: the same matching, the same 100 percent rule,
 *            the same seal as the uploading person, the same submit for review. Nothing here writes a
 *            formula table. Approval stays a second person's act (ApprovalsService refuses the author
 *            and whoever sealed).
 *   words    NOTHING THIS FILE WRITES ABOUT A ROW NAMES AN INGREDIENT OR A QUANTITY. A row's key is
 *            its formula code and version number (which the formula directory already shows); a
 *            problem is a sentence built here from a row number and a fixed phrase. A cell's text is
 *            never echoed, and a message from the recipe service is never passed on: it is read for
 *            what kind of refusal it is (KIND_OF) and re-said in this file's own words.
 *   kept     the kind is `secret`: the engine keeps no cell of any row, and the job table's own CHECK
 *            (`cells is null`) refuses one if a later edit tried.
 *
 * PARTS BY WEIGHT. The sheet carries parts (grams of a trial batch, or percent). The Vault holds
 * percent. Parts become percent exactly or not at all: the parts of one version must add up to 100,
 * 1,000 or another power of ten (otherwise a missing or mistyped line cannot be ruled out, which is
 * what the 100 percent rule is for), and every share must be exact at the six decimals the Vault
 * holds. Nothing is rounded and nothing is normalised.
 */
import type { Sql } from 'postgres';
import { cellWhole, parseDecimal, type ImportContext, type ImportKindHandler, type ImportKindSpec, type ImportRowPlan, type ImportTableRow } from '@core/backend-kernel';
import type { FormulaSetupService, ImportResult } from '../setup/formula-setup.service.js';

export const FORMULAS: ImportKindSpec = {
  kind: 'formulas', title: 'Formulas',
  permission: 'vault:formula_import:write', mirrors: ['formula:formula_ingredients:write'],
  secret: true,
  exampleKey: 'formula',
  columns: [
    { key: 'formula', header: 'Formula code', aliases: ['Formula'], required: true, help: 'The formula\'s code in the Vault. The formula must already exist (New formula, or a shell drafted from the factory).', example: 'EXAMPLE-FORMULA' },
    { key: 'version', header: 'Version', aliases: ['Version number'], required: true, help: 'The version this recipe is. A version on file is never changed: a change is the next version number.', example: '1' },
    { key: 'line', header: 'Line number', aliases: ['Line', 'Line no', 'Sequence'], required: true, help: 'The order of the line in the recipe: 1, 2, 3 ...', example: '1' },
    { key: 'ingredient', header: 'Ingredient code', aliases: ['Material code', 'Ingredient'], required: true, help: 'The ingredient\'s code, exactly as in the factory\'s material list.', example: 'RM-00001' },
    { key: 'parts', header: 'Parts by weight', aliases: ['Parts', 'Grams', 'Percent', 'Percentage'], required: true, help: 'This line\'s share by weight: grams of a trial batch, or percent. The lines of one version must add up to 100 or 1,000 (or another power of ten).', example: '100' },
  ],
  instructions: [
    'One row for each line of a recipe. All the rows of one formula version are accepted or refused together.',
    'This file is a recipe. It is read on the Vault only, its lines are not kept with the import, and nothing in it is written to a log. Keep the file itself as carefully as the recipe.',
    'An accepted version is sealed under your name and sent for review. A second person approves it; you cannot approve your own upload.',
    'Upload one version of a formula at a time.',
  ],
  naturalKey: 'The formula code and the version number.',
  rule: 'Create only. A version already on file is skipped whole and never changed; a change is a new version.',
  refuses: ['a formula not in the Vault', 'an ingredient not in the material list', 'an ingredient or a line number twice in one version', 'parts of zero or less', 'parts that do not add up to 100, 1,000 or another power of ten, or that do not come to exact percentages', 'a version number that is not the one the Vault would seal next', 'a formula whose latest version is waiting for a decision'],
};

/** What a formula row's writer needs. Lives in memory for one request and is never stored. */
export interface FormulaLineInput { formula: string; version: number; line: number; ingredient: string; percent: string }

/* What kind of refusal a message from the recipe service is. The message itself is never passed on:
   it may name a material or a total. */
const KIND_OF: Array<[RegExp, string]> = [
  [/^no formula with code|^no formula shell/i, 'There is no formula with this code in the Vault. Create the formula first.'],
  [/^more than one formula/i, 'More than one formula in the Vault has this code.'],
  [/^no material with/i, 'The ingredient code on this row is not in the material list the Vault holds.'],
  [/matches \d+ materials/i, 'The ingredient code on this row matches more than one material.'],
  [/repeats the material/i, 'An ingredient is repeated in this formula version.'],
  [/add up to/i, 'The parts of this formula version do not come to exactly 100 percent.'],
  [/already has sealed ingredients/i, 'The draft version of this formula already has sealed lines. Sealed lines are never replaced: start a new version.'],
  [/waiting for a decision/i, 'The latest version of this formula is waiting for a decision. Reject it, or wait for it to be approved, before uploading another.'],
];
const GENERIC = 'The Vault\'s recipe check refused this formula version.';
export const sayKind = (message: string | null | undefined): string => KIND_OF.find(([re]) => re.test(String(message ?? '')))?.[1] ?? GENERIC;

const TEN = 10n;
/** True for 100, 1,000, 10,000 ... at the given scale (digits x 10^-scale). */
function powerOfTenFrom100(total: bigint, scale: number): boolean {
  let t = total;
  for (let i = 0; i < scale; i++) { if (t % TEN !== 0n) return false; t /= TEN; }
  if (t < 100n) return false;
  while (t % TEN === 0n) t /= TEN;
  return t === 1n;
}
/** Millionths of a percent as the exact decimal text the recipe reader takes ("12.5", "0.000125"). */
const microText = (micro: bigint): string => `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`.replace(/\.?0+$/, '');
const csvField = (s: string) => (/[",\r\n\t;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The accepted lines as the text FormulaSetupService.importRecipes reads. */
export function recipeCsv(lines: readonly FormulaLineInput[]): string {
  return ['formula_code,material_code,percentage,sequence', ...lines.map((l) => [csvField(l.formula), csvField(l.ingredient), l.percent, String(l.line)].join(','))].join('\n') + '\n';
}

interface Parsed { row: ImportTableRow; plan: ImportRowPlan<FormulaLineInput>; formula: string; version: number | null; line: number | null; ingredient: string; parts: { digits: bigint; scale: number } | null }

export function formulasKind(sql: Sql, setup: FormulaSetupService): ImportKindHandler<FormulaLineInput> {
  return {
    spec: FORMULAS,

    async plan(rows, ctx: ImportContext) {
      const parsed: Parsed[] = rows.map((r) => {
        const formula = (r.values.formula ?? '').trim(), ingredient = (r.values.ingredient ?? '').trim();
        const v = cellWhole(r.values.version ?? '', 'Version'), l = cellWhole(r.values.line ?? '', 'Line number');
        const version = v.ok ? v.value : null, line = l.ok ? l.value : null;
        const key = `${formula.toUpperCase()} v${version ?? '?'}`;
        const plan: ImportRowPlan<FormulaLineInput> = { row: r.row, outcome: 'create', naturalKey: key, label: `${formula} version ${version ?? '?'}`, problems: [], notes: [], input: null, cells: {} };
        // Fixed phrases only: no cell is echoed (see the header).
        if (!formula) plan.problems.push('"Formula code" is empty.');
        if (formula.length > 50) plan.problems.push('The formula code is longer than 50 characters.');
        if (version === null) plan.problems.push('"Version" must be a whole number, 1 or more.');
        if (line === null) plan.problems.push('"Line number" must be a whole number, 1 or more.');
        if (!ingredient) plan.problems.push('"Ingredient code" is empty.');
        const d = parseDecimal(r.values.parts ?? '', 9);
        if ((r.values.parts ?? '').trim() === '') plan.problems.push('"Parts by weight" is empty.');
        else if (!d) plan.problems.push('"Parts by weight" is not a plain number.');
        else if (d.negative || d.digits === 0n) plan.problems.push('"Parts by weight" must be more than zero.');
        const parts = d && !d.negative && d.digits > 0n ? { digits: d.digits, scale: d.scale } : null;
        return { row: r, plan, formula, version, line, ingredient, parts };
      });

      const groups = new Map<string, Parsed[]>();
      for (const p of parsed) { const k = `${p.formula.toUpperCase()}|${p.version ?? '?'}`; groups.set(k, [...(groups.get(k) ?? []), p]); }
      const versionsOfFormula = new Map<string, Set<number | null>>();
      // A version cell that could not be read is its own row's problem, not a second version of the formula.
      for (const p of parsed) if (p.version !== null) versionsOfFormula.set(p.formula.toUpperCase(), (versionsOfFormula.get(p.formula.toUpperCase()) ?? new Set<number | null>()).add(p.version));

      // What is on file: each formula's versions and whether anything is sealed in them. Codes and
      // version numbers only, which the formula directory already shows.
      const codes = [...new Set(parsed.map((p) => p.formula.toUpperCase()).filter(Boolean))];
      const onFile = codes.length ? await sql<{ code: string; n: number | null; sealed: number }[]>`
        select upper(m.formula_code) as code, v.version_number as n,
               (select count(*)::int from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id) as sealed
          from formula.formula_master m join formula.formula_version v on v.formula_id = m.formula_id
         where upper(m.formula_code) = any(${codes})` : [];
      const sealedVersions = new Set(onFile.filter((x) => x.sealed > 0).map((x) => `${x.code}|${x.n}`));

      const candidates: Parsed[][] = [];
      for (const [key, group] of groups) {
        const whole = (text: string) => { for (const p of group) if (!p.plan.problems.length) p.plan.problems.push(text); };
        if (sealedVersions.has(key)) {
          for (const p of group) { p.plan.problems.length = 0; p.plan.outcome = 'skip'; p.plan.problems.push('This version of the formula is already on file. A version on file is never changed: a change is a new version.'); }
          continue;
        }
        const seenIng = new Map<string, number>(), seenLine = new Map<number, number>();
        for (const p of group) {
          if (p.ingredient) { const first = seenIng.get(p.ingredient.toUpperCase()); if (first) p.plan.problems.push(`This row repeats the ingredient on row ${first} of the same formula version. One ingredient, one line: add the two together.`); else seenIng.set(p.ingredient.toUpperCase(), p.row.row); }
          if (p.line !== null) { const first = seenLine.get(p.line); if (first) p.plan.problems.push(`This line number is also on row ${first} of the same formula version.`); else seenLine.set(p.line, p.row.row); }
        }
        if (group[0]!.formula && (versionsOfFormula.get(group[0]!.formula.toUpperCase())?.size ?? 0) > 1) whole('This file holds more than one version of this formula. Upload one version at a time.');
        const bad = group.find((p) => p.plan.problems.length);
        if (bad) { whole(`Row ${bad.row.row} of this formula version has a problem, and a version is accepted or refused whole.`); continue; }

        // Parts to percent, exactly. A common scale, then each share in millionths of a percent.
        const scale = Math.max(...group.map((p) => p.parts!.scale));
        const n = group.map((p) => p.parts!.digits * TEN ** BigInt(scale - p.parts!.scale));
        const total = n.reduce((a, b) => a + b, 0n);
        if (!powerOfTenFrom100(total, scale)) { whole('The parts of this formula version do not add up to 100, 1,000 or another power of ten, so a missing or mistyped line cannot be ruled out (the 100 percent rule).'); continue; }
        if (n.some((x) => (x * 100_000_000n) % total !== 0n)) { whole('The parts of this formula version do not come to exact percentages at six decimals. Give each part to fewer decimals.'); continue; }
        group.forEach((p, i) => { p.plan = { ...p.plan, input: { formula: p.formula, version: p.version!, line: p.line!, ingredient: p.ingredient, percent: microText((n[i]! * 100_000_000n) / total) } }; });
        candidates.push(group);
      }

      // The Vault's own check, by the function the recipe route calls, as a dry run: it matches the
      // formula and every ingredient, applies the 100 percent rule and says which version it would seal.
      if (candidates.length) {
        const lines = candidates.flat();
        const dry: ImportResult = await setup.importRecipes({ csv: recipeCsv(lines.map((p) => p.plan.input!)), commit: false, submit: true }, ctx.principal);
        // importRecipes numbers its lines from the header (line 1), so line i + 2 is lines[i].
        const byLine = new Map(lines.map((p, i) => [i + 2, p]));
        if (dry.fileErrors.length) for (const p of lines) p.plan.problems.push(GENERIC);
        for (const r of dry.rows) { const p = byLine.get(r.line); if (p && r.error) p.plan.problems.push(sayKind(r.error)); }
        for (const group of candidates) {
          const whole = (text: string) => { for (const p of group) if (!p.plan.problems.length) p.plan.problems.push(text); };
          const recipe = dry.recipes.find((x) => (x.formulaCode ?? '').toUpperCase() === group[0]!.formula.toUpperCase());
          const bad = group.find((p) => p.plan.problems.length);
          if (bad) { whole(`Row ${bad.row.row} of this formula version has a problem, and a version is accepted or refused whole.`); continue; }
          if (!recipe) { whole(GENERIC); continue; }
          if (recipe.errors.length) { for (const e of new Set(recipe.errors.map(sayKind))) whole(e); continue; }
          if (recipe.version.versionNumber !== group[0]!.version) {
            whole(`The Vault would seal this as version ${recipe.version.versionNumber}, not version ${group[0]!.version}. Use that version number.`);
            continue;
          }
          for (const p of group) p.plan.notes.push('Sealed under your name and sent for review. A second person approves it.');
        }
      }
      return parsed.map((p) => (p.plan.problems.length && p.plan.outcome !== 'skip' ? { ...p.plan, input: null } : p.plan));
    },

    units(rows) {
      const groups = new Map<string, ImportRowPlan<FormulaLineInput>[]>();
      for (const r of rows) groups.set(r.naturalKey, [...(groups.get(r.naturalKey) ?? []), r]);
      return [...groups.values()];
    },

    /** Through the Vault's own seal path, in its own transaction: every version here, or none. */
    async writeAll(rows, ctx) {
      const out = await setup.importRecipes({ csv: recipeCsv(rows.map((r) => r.input!)), commit: true, submit: true }, ctx.principal);
      if (!out.committed) throw new Error('the recipe service refused the commit');
    },
  };
}

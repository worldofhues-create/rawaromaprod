/**
 * DilutionService (IMPORT-RP) — what a dilution is made of. The owner's formula sheet lists 38
 * dilutions ("10% DPG") as ingredients with nothing on file saying which base and which solvent; this
 * is where that is recorded: POST /v1/material-dilutions for one, the `dilutions` import for many,
 * and both call createDilution, so a row in a sheet and a form are judged by the same function.
 *
 * A dilution is a material of its own (its own code, its own lots). Its composition is recorded once:
 * the same composition again is answered as already on file, and a DIFFERENT ratio for the same
 * dilution is refused, because a different ratio is a different material and lots of the old one may
 * be on the shelf. Shares are percent by weight, exact at six decimals, and must total exactly 100:
 * a ratio that does not total is refused, never normalised.
 */
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { MASTERDATA_DB, masterdataSchema, type MasterdataDb } from '../cluster-masterdata.tokens.js';
import type { CreateMaterialDilution, ListQuery, Page } from '../cluster-masterdata.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const { materialDilution } = masterdataSchema;

/** A share as millionths of a percent (exact at six decimals), or the sentence that says why not. */
export function shareMicro(text: string, what: string): { micro: number } | { problem: string } {
  const t = String(text ?? '').trim().replace(/%$/, '').trim();
  if (t === '') return { problem: `the ${what} share is missing` };
  const m = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) return { problem: `the ${what} share "${text}" must be a percentage with at most six decimals, like 10 or 0.1` };
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
  if (micro <= 0 || micro >= 100_000_000) return { problem: `the ${what} share must be more than 0 and less than 100 (got ${t})` };
  return { micro };
}
export const microText = (micro: number) => `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, '0')}`.replace(/\.?0+$/, '');

export interface DilutionShares { baseMicro: number; solventMicro: number }
/** Every problem with the two shares, in words; the shares when there is none. Pure. */
export function judgeShares(basePercent: string, solventPercent: string): { shares: DilutionShares } | { problems: string[] } {
  const b = shareMicro(basePercent, 'base'), s = shareMicro(solventPercent, 'solvent');
  const problems = [b, s].flatMap((x) => ('problem' in x ? [x.problem] : []));
  if (problems.length || 'problem' in b || 'problem' in s) return { problems };
  if (b.micro + s.micro !== 100_000_000) {
    return { problems: [`the shares add up to ${microText(b.micro + s.micro)}%, not 100%: a dilution is its base and its solvent and nothing else`] };
  }
  return { shares: { baseMicro: b.micro, solventMicro: s.micro } };
}

export interface DilutionView {
  materialDilutionId: string;
  dilutionMaterialId: string; dilutionCode: string | null; dilutionName: string | null;
  baseMaterialId: string; baseCode: string | null;
  solventMaterialId: string; solventCode: string | null;
  basePercent: string; solventPercent: string;
  status: string;
}

@Injectable()
export class DilutionService {
  constructor(@Inject(MASTERDATA_DB) private readonly db: MasterdataDb) {}

  async createDilution(body: CreateMaterialDilution, principal: AuthPrincipal) {
    const judged = judgeShares(body.basePercent, body.solventPercent);
    if ('problems' in judged) throw new BadRequestException(`A dilution cannot be recorded: ${judged.problems.join('; ')}.`);
    if (body.baseMaterialId === body.solventMaterialId) throw new BadRequestException('The base and the solvent are the same material.');
    if (body.dilutionMaterialId === body.baseMaterialId || body.dilutionMaterialId === body.solventMaterialId) {
      throw new BadRequestException('A dilution cannot be its own base or its own solvent.');
    }
    const base = microText(judged.shares.baseMicro), solvent = microText(judged.shares.solventMicro);
    return this.db.transaction(async (tx) => {
      const found = (await tx.execute(sql`
        select material_id::text as id, material_code as code from masterdata.material
         where material_id in (${body.dilutionMaterialId}, ${body.baseMaterialId}, ${body.solventMaterialId})`)) as unknown as Array<{ id: string; code: string | null }>;
      const have = new Set(found.map((f) => f.id));
      for (const [id, what] of [[body.dilutionMaterialId, 'dilution'], [body.baseMaterialId, 'base'], [body.solventMaterialId, 'solvent']] as const) {
        if (!have.has(id)) throw new BadRequestException(`The ${what} is not a material on file.`);
      }
      // One composition per dilution, and two requests for the same dilution do not both win.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'masterdata.material_dilution:' + body.dilutionMaterialId}))`);
      const [on] = (await tx.execute(sql`
        select d.base_material_id::text as base, d.solvent_material_id::text as solvent, d.base_percent::text as bp, b.material_code as base_code, s.material_code as solvent_code
          from masterdata.material_dilution d
          join masterdata.material b on b.material_id = d.base_material_id
          join masterdata.material s on s.material_id = d.solvent_material_id
         where d.dilution_material_id = ${body.dilutionMaterialId}`)) as unknown as Array<{ base: string; solvent: string; bp: string; base_code: string | null; solvent_code: string | null }>;
      if (on) {
        throw new ConflictException(
          `This dilution is already on file as ${Number(on.bp)}% ${on.base_code ?? 'its base'} in ${on.solvent_code ?? 'its solvent'}. A different ratio is a different material: give it its own code.`);
      }
      return ensure((await tx.insert(materialDilution).values({
        materialDilutionId: uuidv7(),
        dilutionMaterialId: body.dilutionMaterialId,
        baseMaterialId: body.baseMaterialId,
        solventMaterialId: body.solventMaterialId,
        basePercent: base,
        solventPercent: solvent,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      }).returning())[0]);
    });
  }

  async listDilutions(query: ListQuery): Promise<Page<DilutionView>> {
    const rows = (await this.db.execute(sql`
      select d.material_dilution_id::text as "materialDilutionId",
             d.dilution_material_id::text as "dilutionMaterialId", m.material_code as "dilutionCode", m.material_name as "dilutionName",
             d.base_material_id::text as "baseMaterialId", b.material_code as "baseCode",
             d.solvent_material_id::text as "solventMaterialId", s.material_code as "solventCode",
             d.base_percent::text as "basePercent", d.solvent_percent::text as "solventPercent", d.status
        from masterdata.material_dilution d
        join masterdata.material m on m.material_id = d.dilution_material_id
        join masterdata.material b on b.material_id = d.base_material_id
        join masterdata.material s on s.material_id = d.solvent_material_id
       ${query.cursor ? sql`where d.material_dilution_id < ${query.cursor}` : sql``}
       order by d.material_dilution_id desc
       limit ${query.limit + 1}`)) as unknown as DilutionView[];
    return paginate(Array.from(rows), query.limit, (r) => r.materialDilutionId);
  }
}

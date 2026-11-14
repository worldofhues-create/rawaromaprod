/**
 * FACTORY-DOCS — where ALEMBIC fetches a GC-MS PDF from: `GET /v1/bridge/files/gcms/:id?sha=&exp=&sig=`.
 *
 * Public by necessity (ALEMBIC's fetcher holds no RawProd session), so the link itself is the
 * credential: it names one report and its exact bytes, expires (GCMS_FILE_URL_TTL_SECONDS, minted by
 * the relay at each delivery attempt) and is signed with a key derived from the bridge connector
 * secret (file-url.ts). A link that is malformed, expired, mis-signed, or names bytes that are not the
 * report's own answers 404 with no detail -- one refusal for all, so the route tells a prober nothing.
 * With the connector unconfigured nothing is served (fail closed, as the relay).
 */
import { Controller, Get, Inject, Injectable, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { Public } from '@core/backend-kernel';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from './bridge.tokens.js';
import { openSecret } from './secret-box.js';
import { GCMS_FILE_PATH, verifyGcmsFileLink } from './file-url.js';

export type GcmsFileResult =
  | { ok: true; bytes: Buffer; fileName: string; sha256: string }
  | { ok: false; reason: 'not_configured' | 'malformed' | 'expired' | 'bad_signature' | 'not_found' };

@Injectable()
export class GcmsFileService {
  constructor(@Inject(BRIDGE_DB) private readonly db: BridgeDb) {}

  async open(reportId: string, q: { sha?: unknown; exp?: unknown; sig?: unknown }, nowMs: number): Promise<GcmsFileResult> {
    const config = (await this.db.select().from(bridgeSchema.connectorConfig)
      .where(eq(bridgeSchema.connectorConfig.id, 'default')).limit(1))[0];
    const secret = config?.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;
    if (!secret) return { ok: false, reason: 'not_configured' };
    const check = verifyGcmsFileLink({ reportId, sha256: q.sha, exp: q.exp, sig: q.sig, nowMs, connectorSecret: secret });
    if (!check.ok) return { ok: false, reason: check.reason };
    const row = ((await this.db.execute(sql`
      select pdf, sha256, file_name from production.batch_gcms_report
       where batch_gcms_report_id = ${reportId}::uuid and sha256 = ${String(q.sha)}
    `)) as unknown as { pdf: Buffer; sha256: string; file_name: string | null }[])[0];
    if (!row) return { ok: false, reason: 'not_found' };
    return { ok: true, bytes: Buffer.from(row.pdf), fileName: row.file_name ?? `gcms-${reportId}.pdf`, sha256: row.sha256 };
  }
}

@Controller()
export class GcmsFileController {
  constructor(private readonly files: GcmsFileService) {}

  @Public()
  @Get(`${GCMS_FILE_PATH.slice(1)}/:id`)
  async file(
    @Param('id') id: string,
    @Query() q: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const r = await this.files.open(id, q, Date.now());
    if (!r.ok) {
      await reply.code(404).header('cache-control', 'no-store').send({ data: null, error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return;
    }
    await reply
      .code(200)
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${r.fileName.replace(/[^\w.\- ]/g, '_')}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-sha256', r.sha256)
      .send(r.bytes);
  }
}

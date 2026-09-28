/**
 * ComplianceCertificateSyncService — the MAIN box's half of the Vault's IFRA/allergen certificates
 * (owner ruling 2026-09-28, item 2). The Vault never calls this box and this box never opens the
 * Vault database, so the certificates are PULLED: every VAULT_COMPLIANCE_SYNC_MS the worker
 *
 *   1. pull   POST /internal/vault/compliance-certificates { afterSeq, limit } (signed, the same
 *             INTERNAL_BRIDGE_KEY HMAC + nonce channel every Vault read uses) until caught up, and
 *             keeps each certificate in bridge.compliance_certificate, advancing
 *             bridge.vault_sync_cursor in the same transaction;
 *   2. emit   for the LATEST certificate of each formula × kind, once per product whose
 *             packaging.product_master.formula_id is that formula, writes
 *             `compliance.certificate.calculated` to the bridge outbox (the signed RawProd →
 *             ALEMBIC relay delivers it) and records the (certificate, product) emission. A product
 *             linked to a formula later still receives the current certificate on the next round.
 *
 * The emitted payload is the DOCS-001 wire shape (lane produce; docs/bridge/COMPLIANCE_FACTS.md):
 * `product_ref: { factory_sku }`, the formula version NUMBER and the Vault's opaque
 * formula_version_ref, IFRA limits for all 18 categories / allergen rows for all 26 EU allergens as
 * strings — never the formula id this box used to find the products (assertNoFormulaContent
 * refuses the emission otherwise). A certificate ALEMBIC would refuse (no amendment, a category or
 * allergen the Vault did not calculate, no version number) is logged and not emitted.
 *
 * Runs in the worker (WorkerModule). Does nothing when this box has no VAULT_API_INTERNAL_URL /
 * INTERNAL_BRIDGE_KEY (single-box dev).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import { ConfigService, emitBridgeManualEvent } from '@core/backend-kernel';
import { VaultApiClient, type InternalCertificate } from '@ra/cluster-formula';
import { BRIDGE_DB, type BridgeDb } from '../bridge/bridge.tokens.js';

export const CERTIFICATE_CURSOR_ID = 'compliance_certificates';
export const CERTIFICATE_PULL_PAGE = 100;
const RETRY_MS = 5_000;

export type CertificateSyncResult = { pulled: number; emitted: number } | 'disabled';

interface PendingEmission {
  certificate_id: string;
  product_id: string;
  product_code: string;
  kind: string;
  amendment: string | null;
  cert_values: unknown;
  calculated_at: Date | string;
  formula_version_ref: string;
  formula_version_number: number | null;
}

/** Pure: the `compliance.certificate.calculated` payload for one product. Throws if the result
 *  would be malformed or would carry formula content. */
export function buildCertificatePayload(input: {
  productRef: string;
  skuCodes: string[];
  kind: string;
  amendment: string | null;
  values: unknown;
  calculatedAt: Date | string;
  formulaVersionRef: string;
}): bridgeContracts.ComplianceCertificatePayload {
  const payload = {
    productRef: input.productRef,
    skuCodes: input.skuCodes,
    kind: input.kind as bridgeContracts.CertificateKind,
    amendment: input.amendment,
    values: input.values as bridgeContracts.ComplianceCertificatePayload['values'],
    calculatedAt: new Date(input.calculatedAt).toISOString(),
    formulaVersionRef: input.formulaVersionRef,
  };
  const problems = bridgeContracts.validateComplianceCertificate(payload);
  if (problems.length > 0) throw new Error(`certificate payload invalid: ${problems.join(', ')}`);
  bridgeContracts.assertNoFormulaContent(payload);
  return payload;
}

/** Pure: the DOCS-001 wire payload for one product (the product's first SKU code is the
 *  `factory_sku` ALEMBIC maps). Throws `CertificateWireError` when ALEMBIC would refuse it. */
export function buildCertificateWire(
  internal: bridgeContracts.ComplianceCertificatePayload,
  skuCodes: string[],
  formulaVersionNumber: number | null,
): bridgeContracts.CertificateCalculatedWire {
  const wire = bridgeContracts.toCertificateCalculatedWire(internal, {
    factorySku: skuCodes[0] ?? '', formulaVersion: formulaVersionNumber,
  });
  bridgeContracts.assertNoFormulaContent(wire);
  return wire;
}

@Injectable()
export class ComplianceCertificateSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ComplianceCertificateSyncService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private lastError: string | null = null;

  constructor(
    @Inject(BRIDGE_DB) private readonly db: BridgeDb,
    @Inject(VaultApiClient) private readonly vault: Pick<VaultApiClient, 'complianceCertificates'>,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private enabled(): boolean {
    return !!(this.config.get('VAULT_API_INTERNAL_URL') && this.config.get('INTERNAL_BRIDGE_KEY'));
  }

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('Vault compliance certificate sync is off: VAULT_API_INTERNAL_URL / INTERNAL_BRIDGE_KEY not set on this box.');
      return;
    }
    this.schedule(5_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const interval = this.config.get('VAULT_COMPLIANCE_SYNC_MS');
    let next = interval;
    try {
      await this.sync();
      if (this.lastError) this.logger.log('Vault compliance certificate sync recovered.');
      this.lastError = null;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== this.lastError) this.logger.warn(`Vault compliance certificate sync failed: ${msg}`);
      this.lastError = msg;
      next = Math.min(RETRY_MS, interval);
    } finally {
      this.schedule(next);
    }
  }

  /** One round: pull until caught up, then emit what is due. Rounds never overlap. */
  async sync(): Promise<CertificateSyncResult> {
    if (!this.enabled()) return 'disabled';
    const pulled = await this.pull();
    const emitted = await this.emitDue();
    if (pulled || emitted) this.logger.log(`compliance certificates: pulled ${pulled}, emitted ${emitted}`);
    return { pulled, emitted };
  }

  /** Pull every certificate after the cursor, page by page. */
  async pull(): Promise<number> {
    let total = 0;
    for (;;) {
      const cursor = await this.cursor();
      const page: InternalCertificate[] = await this.vault.complianceCertificates(cursor, CERTIFICATE_PULL_PAGE);
      if (page.length === 0) return total;
      await this.db.transaction(async (tx) => {
        for (const c of page) {
          await tx.execute(sql`
            insert into bridge.compliance_certificate
              (certificate_id, vault_seq, formula_id, formula_version_ref, formula_version_number, kind, amendment, cert_values, calculated_at)
            values (${c.certificateId}::uuid, ${c.seq}, ${c.formulaId}::uuid, ${c.formulaVersionRef},
                    ${c.formulaVersionNumber ?? null}::int, ${c.kind},
                    ${c.amendment}, ${JSON.stringify(c.values)}::jsonb, ${c.calculatedAt}::timestamptz)
            on conflict (certificate_id) do update
              set formula_version_number = coalesce(bridge.compliance_certificate.formula_version_number, excluded.formula_version_number)
          `);
        }
        const maxSeq = Math.max(...page.map((c) => c.seq));
        await tx.execute(sql`
          insert into bridge.vault_sync_cursor (id, last_seq, updated_at) values (${CERTIFICATE_CURSOR_ID}, ${maxSeq}, now())
          on conflict (id) do update set last_seq = greatest(bridge.vault_sync_cursor.last_seq, excluded.last_seq), updated_at = now()
        `);
      });
      total += page.length;
      if (page.length < CERTIFICATE_PULL_PAGE) return total;
    }
  }

  /** Emit the latest certificate of each formula × kind to every product of that formula that
   *  has not had it yet. One transaction per (certificate, product): outbox row + emission row. */
  async emitDue(): Promise<number> {
    const due = (await this.db.execute(sql`
      with latest as (
        select distinct on (formula_id, kind) certificate_id, formula_id, kind, amendment, cert_values,
               calculated_at, formula_version_ref, formula_version_number
          from bridge.compliance_certificate
         order by formula_id, kind, vault_seq desc
      )
      select l.certificate_id::text as certificate_id, p.product_id::text as product_id, p.product_code,
             l.kind, l.amendment, l.cert_values, l.calculated_at, l.formula_version_ref, l.formula_version_number
        from latest l
        join packaging.product_master p on p.formula_id = l.formula_id and p.product_code is not null
       where not exists (
         select 1 from bridge.compliance_certificate_emission e
          where e.certificate_id = l.certificate_id and e.product_id = p.product_id)
       order by l.calculated_at, p.product_code
       limit 500
    `)) as unknown as PendingEmission[];

    let emitted = 0;
    for (const d of due) {
      const skuCodes = ((await this.db.execute(sql`
        select sku_code from packaging.product_sku where product_id = ${d.product_id} and sku_code is not null order by sku_code
      `)) as unknown as { sku_code: string }[]).map((r) => r.sku_code);
      let payload: bridgeContracts.CertificateCalculatedWire;
      try {
        const internal = buildCertificatePayload({
          productRef: d.product_code, skuCodes, kind: d.kind, amendment: d.amendment, values: d.cert_values,
          calculatedAt: d.calculated_at, formulaVersionRef: d.formula_version_ref,
        });
        // Lane produce: DOCS-001 is what ALEMBIC parses (docs/bridge/COMPLIANCE_FACTS.md).
        payload = buildCertificateWire(internal, skuCodes, d.formula_version_number);
      } catch (err) {
        // Never emitted, never marked emitted: it stays visible here until the Vault supersedes it.
        this.logger.error(`certificate ${d.certificate_id} for product ${d.product_code} not emitted: ${(err as Error).message}`);
        continue;
      }
      await this.db.transaction(async (tx) => {
        const claimed = (await tx.execute(sql`
          insert into bridge.compliance_certificate_emission (certificate_id, product_id)
          values (${d.certificate_id}::uuid, ${d.product_id}::uuid)
          on conflict (certificate_id, product_id) do nothing
          returning emission_id::text as emission_id
        `)) as unknown as { emission_id: string }[];
        if (!claimed[0]) return; // another worker emitted it first
        // DOCS-001: aggregate `product` + RawProd's product uuid (the relay maps the type).
        await emitBridgeManualEvent(tx, bridgeContracts.COMPLIANCE_CERTIFICATE_CALCULATED, d.product_id, payload as unknown as Record<string, unknown>);
        emitted++;
      });
    }
    return emitted;
  }

  private async cursor(): Promise<number> {
    const row = ((await this.db.execute(sql`
      select last_seq from bridge.vault_sync_cursor where id = ${CERTIFICATE_CURSOR_ID}
    `)) as unknown as { last_seq: string | number }[])[0];
    return row ? Number(row.last_seq) : 0;
  }
}

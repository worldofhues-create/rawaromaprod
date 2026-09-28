/**
 * The main box's pull of the Vault's calculated certificates and their emission toward ALEMBIC
 * (owner ruling 2026-09-28, item 2) — real Postgres (main schemas), the real
 * ComplianceCertificateSyncService, a fake VaultApiClient standing in for the signed
 * /internal/vault/compliance-certificates call (vault-port-http-client.test.ts covers the wire).
 *
 *   pull       advances a cursor; a re-pull is a no-op.
 *   emit       one compliance.certificate.calculated per (latest certificate, product of that
 *              formula); nothing twice; a newer certificate supersedes; a product linked to the
 *              formula later still gets the current certificate.
 *   leak       the payload never carries the formula id this box used to find the products.
 *   wire       (lane produce) the DOCS-001 shape ALEMBIC parses: product_ref.factory_sku, the formula
 *              version number, all 18 IFRA categories / all 26 EU allergens as strings; aggregate =
 *              the product. A certificate ALEMBIC would refuse is not emitted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bridge as contracts } from '@core/contracts';
import type { InternalCertificate } from '@ra/cluster-formula';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { ComplianceCertificateSyncService, CERTIFICATE_CURSOR_ID } from '../vault-bridge/compliance-certificate-sync.service.js';
import { ensureSchema, bridgeDb, testClient, closeTestClient } from '../../../test-support/db.js';

const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/unused',
  JWT_SECRET: 'x'.repeat(32),
  VAULT_API_INTERNAL_URL: 'http://vault.internal.invalid:3001',
  INTERNAL_BRIDGE_KEY: 'k'.repeat(40),
});

/** An in-memory Vault: certificates with seqs after whatever cursor the shared DB already holds. */
class FakeVault {
  certs: InternalCertificate[] = [];
  calls = 0;
  async complianceCertificates(afterSeq: number, limit: number): Promise<InternalCertificate[]> {
    this.calls++;
    return this.certs.filter((c) => c.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit);
  }
}

const FVR = (n: number) => `fvr_${String(n).padStart(32, '0')}`;
let base = 0;
let vault: FakeVault;
let sync: ComplianceCertificateSyncService;

before(async () => {
  await ensureSchema();
  const row = await testClient()`select last_seq from bridge.vault_sync_cursor where id = ${CERTIFICATE_CURSOR_ID}`;
  base = row[0] ? Number(row[0].last_seq) : 0;
  vault = new FakeVault();
  sync = new ComplianceCertificateSyncService(bridgeDb(), vault as never, config);
});
after(async () => { await closeTestClient(); });

function cert(seq: number, formulaId: string, kind: 'ifra' | 'allergen', values: unknown, ref = FVR(seq), version: number | null = 3): InternalCertificate {
  return {
    seq: base + seq, certificateId: randomUUID(), formulaId, formulaVersionRef: ref, formulaVersionNumber: version, kind,
    amendment: kind === 'ifra' ? '51' : null, values, calculatedAt: new Date(Date.now() + seq).toISOString(),
  };
}

async function product(formulaId: string): Promise<string> {
  const productId = randomUUID();
  const code = `CERT-${productId.slice(0, 8)}`;
  await testClient()`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
                     values (${productId}, ${formulaId}, ${code}, 'Cert product', 'ACTIVE')`;
  await testClient()`insert into packaging.product_sku (product_id, sku_code, status) values (${productId}, ${`${code}-1KG`}, 'ACTIVE')`;
  return code;
}

async function emitted(productRef: string) {
  return testClient()`select type, aggregate_id::text, payload from bridge.outbox
                       where type = 'compliance.certificate.calculated'
                         and payload->'product_ref'->>'factory_sku' = ${`${productRef}-1KG`}
                       order by seq`;
}

/** The Vault's internal shape: one entry per IFRA category (all 18) / per regulated allergen (the 26). */
const IFRA = contracts.IFRA_CATEGORY_CODES.map((category) => ({ category, limitPct: category === '1' ? 0 : category === '4' ? 10 : 100 }));
const ALLERGEN = contracts.EU_ALLERGEN_CAS_26.map((cas) => (cas === '138-86-3'
  ? { name: 'Limonene', cas, natural: 1, synthetic: 3, total: 4 }
  : { name: `Allergen ${cas}`, cas, natural: 'A' as const, synthetic: 'A' as const, total: 'A' as const }));
type Wire = contracts.CertificateCalculatedWire;

test('pull + emit: one event per certificate per product, the contract payload, no formula id', async () => {
  const formulaId = randomUUID();
  const code = await product(formulaId);
  vault.certs.push(cert(1, formulaId, 'ifra', IFRA), cert(2, formulaId, 'allergen', ALLERGEN));

  const r = await sync.sync();
  assert.ok(r !== 'disabled' && r.pulled >= 2);
  const rows = await emitted(code);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const p = row.payload as Wire;
    assert.doesNotThrow(() => contracts.assertNoFormulaContent(p));
    assert.ok(!JSON.stringify(p).includes(formulaId), 'the formula id must never cross the bridge');
    assert.deepEqual(p.product_ref, { factory_sku: `${code}-1KG` });
    assert.equal(p.formula_version, 3);
    // DOCS-001: aggregate = the product (the relay reports it as `product`).
    const pid = await testClient()`select product_id::text from packaging.product_master where product_code = ${code}`;
    assert.equal(row.aggregate_id, pid[0]!.product_id);
  }
  const ifra = rows.map((x) => x.payload as Wire).find((p) => p.kind === 'ifra')!;
  const limits = (ifra.values as { limits: Record<string, string> }).limits;
  assert.equal(Object.keys(limits).length, 18);
  assert.equal(limits['1'], '0.00');
  assert.equal(limits['4'], '10.00');
  assert.equal(limits['12'], '100');
  assert.equal(ifra.amendment, '51');
  assert.equal(ifra.formula_version_ref, FVR(1));
  const allergen = rows.map((x) => x.payload as Wire).find((p) => p.kind === 'allergen')!;
  const arows = (allergen.values as { rows: Array<{ cas: string; natural: string; synthetic: string; total: string }> }).rows;
  assert.deepEqual(arows.map((r) => r.cas), contracts.EU_ALLERGEN_CAS_26);
  assert.deepEqual(arows.find((r) => r.cas === '138-86-3'), { cas: '138-86-3', natural: '1', synthetic: '3', total: '4' });
  assert.equal('amendment' in allergen, false);

  const cursor = await testClient()`select last_seq from bridge.vault_sync_cursor where id = ${CERTIFICATE_CURSOR_ID}`;
  assert.equal(Number(cursor[0]!.last_seq), base + 2);

  // A second round pulls nothing new and emits nothing twice.
  const again = await sync.sync();
  assert.ok(again !== 'disabled');
  assert.equal((await emitted(code)).length, 2);
});

test('a newer certificate supersedes; a product linked to the formula later gets the current one', async () => {
  const formulaId = randomUUID();
  const code = await product(formulaId);
  vault.certs.push(cert(3, formulaId, 'ifra', IFRA, FVR(3)));
  await sync.sync();
  assert.equal((await emitted(code)).length, 1);

  vault.certs.push(cert(4, formulaId, 'ifra', IFRA.map((v) => (v.category === '4' ? { ...v, limitPct: 8.5 } : v)), FVR(4)));
  await sync.sync();
  const rows = await emitted(code);
  assert.equal(rows.length, 2);
  assert.equal((rows[1]!.payload as Wire).formula_version_ref, FVR(4));

  const late = await product(formulaId);
  await sync.sync();
  const lateRows = await emitted(late);
  assert.equal(lateRows.length, 1, 'only the latest certificate, not the superseded one');
  assert.equal((lateRows[0]!.payload as Wire).formula_version_ref, FVR(4));
});

test('a certificate ALEMBIC would refuse is never emitted: missing IFRA categories, an allergen not calculated, no version number', async () => {
  const formulaId = randomUUID();
  const code = await product(formulaId);
  vault.certs.push(cert(5, formulaId, 'ifra', IFRA.slice(0, 17)));
  await sync.sync();
  assert.equal((await emitted(code)).length, 0, 'an IFRA certificate without all 18 categories is not sent');

  const f2 = randomUUID();
  const code2 = await product(f2);
  vault.certs.push(cert(6, f2, 'allergen', ALLERGEN.filter((a) => a.cas !== '111-12-6')));
  await sync.sync();
  assert.equal((await emitted(code2)).length, 0, 'an allergen the Vault did not calculate is never reported as absent');

  const f3 = randomUUID();
  const code3 = await product(f3);
  vault.certs.push(cert(7, f3, 'ifra', IFRA, FVR(7), null));
  await sync.sync();
  assert.equal((await emitted(code3)).length, 0, 'no version number → ALEMBIC cannot print "formula vN"');
});

test('disabled without the Vault channel configured', async () => {
  const off = new ComplianceCertificateSyncService(bridgeDb(), vault as never,
    new ConfigService({ DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32) }));
  const calls = vault.calls;
  assert.equal(await off.sync(), 'disabled');
  assert.equal(vault.calls, calls);
});

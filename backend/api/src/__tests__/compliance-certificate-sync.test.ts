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

function cert(seq: number, formulaId: string, kind: 'ifra' | 'allergen', values: unknown, ref = FVR(seq)): InternalCertificate {
  return {
    seq: base + seq, certificateId: randomUUID(), formulaId, formulaVersionRef: ref, kind,
    amendment: kind === 'ifra' ? '51' : null, values, calculatedAt: new Date(Date.now() + seq).toISOString(),
  };
}

async function product(formulaId: string) {
  const productId = randomUUID();
  const code = `CERT-${productId.slice(0, 8)}`;
  await testClient()`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
                     values (${productId}, ${formulaId}, ${code}, 'Cert product', 'ACTIVE')`;
  await testClient()`insert into packaging.product_sku (product_id, sku_code, status) values (${productId}, ${`${code}-1KG`}, 'ACTIVE')`;
  return code;
}

async function emitted(productRef: string) {
  return testClient()`select type, payload from bridge.outbox
                       where type = 'compliance.certificate.calculated' and payload->>'productRef' = ${productRef}
                       order by seq`;
}

const IFRA = [{ category: '1', limitPct: 0 }, { category: '4', limitPct: 10 }];
const ALLERGEN = [{ name: 'Limonene', cas: '138-86-3', natural: 1, synthetic: 3, total: 4 }];

test('pull + emit: one event per certificate per product, the contract payload, no formula id', async () => {
  const formulaId = randomUUID();
  const code = await product(formulaId);
  vault.certs.push(cert(1, formulaId, 'ifra', IFRA), cert(2, formulaId, 'allergen', ALLERGEN));

  const r = await sync.sync();
  assert.ok(r !== 'disabled' && r.pulled >= 2);
  const rows = await emitted(code);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const p = row.payload as contracts.ComplianceCertificatePayload;
    assert.deepEqual(contracts.validateComplianceCertificate(p), []);
    assert.doesNotThrow(() => contracts.assertNoFormulaContent(p));
    assert.ok(!JSON.stringify(p).includes(formulaId), 'the formula id must never cross the bridge');
    assert.equal(p.productRef, code);
    assert.deepEqual(p.skuCodes, [`${code}-1KG`]);
  }
  const ifra = rows.map((x) => x.payload as contracts.ComplianceCertificatePayload).find((p) => p.kind === 'ifra')!;
  assert.deepEqual(ifra.values, IFRA);
  assert.equal(ifra.amendment, '51');
  assert.equal(ifra.formulaVersionRef, FVR(1));

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

  vault.certs.push(cert(4, formulaId, 'ifra', [{ category: '1', limitPct: 0 }, { category: '4', limitPct: 8.5 }], FVR(4)));
  await sync.sync();
  const rows = await emitted(code);
  assert.equal(rows.length, 2);
  assert.equal((rows[1]!.payload as contracts.ComplianceCertificatePayload).formulaVersionRef, FVR(4));

  const late = await product(formulaId);
  await sync.sync();
  const lateRows = await emitted(late);
  assert.equal(lateRows.length, 1, 'only the latest certificate, not the superseded one');
  assert.equal((lateRows[0]!.payload as contracts.ComplianceCertificatePayload).formulaVersionRef, FVR(4));
});

test('disabled without the Vault channel configured', async () => {
  const off = new ComplianceCertificateSyncService(bridgeDb(), vault as never,
    new ConfigService({ DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32) }));
  const calls = vault.calls;
  assert.equal(await off.sync(), 'disabled');
  assert.equal(vault.calls, calls);
});

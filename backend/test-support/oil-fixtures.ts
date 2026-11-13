/**
 * STOCK-FIX-RP (STK-10, STK-11): since the oil became a stock that moves, a package order needs oil
 * with a measured mass and a SKU whose pack has a net content. Tests that open package orders against
 * a bare `oil_batch_master` row and a made-up SKU id now get both from here: the oil's MADE row on the
 * ledger, and a real SKU row. What they assert about package orders is unchanged.
 */
import { randomUUID } from 'node:crypto';
import { testClient } from './db.js';

/** Record that this oil batch was made of `mg` (the MADE row the produce path writes). */
export async function measureOil(oilBatchId: string, mg = 100_000_000): Promise<void> {
  await testClient()`insert into production.oil_batch_movement (oil_batch_movement_id, oil_batch_id, kind, delta_mg, recorded_by, recorded_role)
    values (${randomUUID()}, ${oilBatchId}, 'MADE', ${mg}, 'test-fixture', 'system')`;
}

/** A SKU on file whose pack holds `netContentMg` (default 1 g, so 100 packs are 100 g). */
export async function skuWithNetContent(netContentMg = 1_000): Promise<string> {
  const id = randomUUID();
  await testClient()`insert into packaging.product_sku (product_sku_id, sku_code, pack_size, net_content_mg, status)
    values (${id}, ${'TEST-' + id.slice(0, 12)}, ${`${netContentMg / 1000} g`}, ${netContentMg}, 'ACTIVE')`;
  return id;
}

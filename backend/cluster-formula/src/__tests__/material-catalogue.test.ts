/**
 * The Vault box's material catalogue (lane fread-rp, design (b)): what the main box pushes over the
 * signed main -> Vault channel and the Vault console's picker searches (`MASTERDATA_LOOKUP` in
 * vault mode). Pure, in memory — the end-to-end path (main worker -> Vault -> picker, two processes,
 * two databases) is vault-isolation-harness.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  MATERIAL_CATALOGUE_PART_SIZE,
  MaterialCatalogue,
  catalogueParts,
  materialCatalogueDigest,
  type MaterialCatalogueEntry,
} from '../facts-bridge/material-catalogue.js';

const entry = (code: string | null, name: string | null): MaterialCatalogueEntry => ({ materialId: randomUUID(), materialCode: code, materialName: name });

/** Push `entries` the way MaterialCatalogueSyncService does; returns the last reply. */
function push(cat: MaterialCatalogue, entries: MaterialCatalogueEntry[]) {
  const digest = materialCatalogueDigest(entries);
  const parts = catalogueParts(entries);
  let last = { current: false };
  parts.forEach((materials, part) => (last = cat.receive({ digest, part, parts: parts.length, materials })));
  return { digest, last };
}

test('the digest is order-independent and changes with any field', () => {
  const a = entry('RM-1', 'Bergamot'), b = entry('RM-2', 'Vetiver');
  assert.equal(materialCatalogueDigest([a, b]), materialCatalogueDigest([b, a]));
  assert.notEqual(materialCatalogueDigest([a, b]), materialCatalogueDigest([a, { ...b, materialName: 'Vetiver Haiti' }]));
  assert.notEqual(materialCatalogueDigest([a, b]), materialCatalogueDigest([a]));
});

test('before any catalogue arrives, a search says so (503), never an empty "no such material"', async () => {
  const cat = new MaterialCatalogue();
  assert.equal(cat.size(), null);
  await assert.rejects(() => cat.searchMaterials('berg', 20), ServiceUnavailableException);
  assert.deepEqual(cat.receive({ digest: materialCatalogueDigest([]) }), { current: false });
});

test('a pushed catalogue is searchable like the main box\'s search: code or name, case-insensitive, code order, capped', async () => {
  const cat = new MaterialCatalogue();
  const rows = [entry('RM-3', 'Lemon Oil'), entry('RM-1', 'Bergamot FCF'), entry('PK-9', 'Bottle 50ml'), entry(null, 'bergamot absolute')];
  const { digest, last } = push(cat, rows);
  assert.deepEqual(last, { current: true });
  assert.equal(cat.size(), 4);
  assert.deepEqual(cat.receive({ digest }), { current: true }, 'the probe now says current');

  const hits = await cat.searchMaterials('BERGAMOT', 20);
  assert.deepEqual(hits.map((h) => h.materialCode), ['RM-1', null], 'nulls last, like Postgres');
  assert.deepEqual(Object.keys(hits[0]!).sort(), ['materialCode', 'materialId', 'materialName', 'uomId']);
  assert.equal(hits[0]!.uomId, null);
  assert.deepEqual((await cat.searchMaterials('rm-', 20)).map((h) => h.materialCode), ['RM-1', 'RM-3']);
  assert.equal((await cat.searchMaterials('rm-', 1)).length, 1);
  assert.deepEqual(await cat.searchMaterials('   ', 20), []);
  const one = rows[2]!;
  assert.deepEqual(await cat.findMaterial(one.materialId.toUpperCase()), { ...one, uomId: null });
});

test('a catalogue larger than one part is assembled from its parts and swapped in only when complete', async () => {
  const cat = new MaterialCatalogue();
  push(cat, [entry('OLD-1', 'Old material')]);
  const rows = Array.from({ length: MATERIAL_CATALOGUE_PART_SIZE + 7 }, (_, i) => entry(`RM-${String(i).padStart(4, '0')}`, `Material ${i}`));
  const digest = materialCatalogueDigest(rows);
  const parts = catalogueParts(rows);
  assert.equal(parts.length, 2);
  assert.deepEqual(cat.receive({ digest, part: 1, parts: 2, materials: parts[1]! }), { current: false });
  assert.equal(cat.size(), 1, 'the previous catalogue is served until every part has arrived');
  assert.equal((await cat.searchMaterials('OLD', 5)).length, 1);
  assert.deepEqual(cat.receive({ digest, part: 0, parts: 2, materials: parts[0]! }), { current: true });
  assert.equal(cat.size(), rows.length);
  assert.equal((await cat.searchMaterials('OLD', 5)).length, 0);
});

test('parts that do not add up to their digest are refused and the previous catalogue is kept', async () => {
  const cat = new MaterialCatalogue();
  push(cat, [entry('KEEP-1', 'Kept')]);
  const rows = [entry('RM-1', 'A'), entry('RM-2', 'B')];
  assert.throws(() => cat.receive({ digest: materialCatalogueDigest(rows), part: 0, parts: 1, materials: [rows[0]!] }), ConflictException);
  assert.equal((await cat.searchMaterials('KEEP', 5)).length, 1);
  assert.throws(() => cat.receive({ digest: materialCatalogueDigest(rows), part: 2, parts: 2, materials: rows }), BadRequestException);
});

test('an empty material master is a valid (empty) catalogue', async () => {
  const cat = new MaterialCatalogue();
  assert.deepEqual(push(cat, []).last, { current: true });
  assert.deepEqual(await cat.searchMaterials('x', 5), []);
});

test('floor codes are not held on the Vault: alias lookups refuse instead of answering "no alias"', async () => {
  const cat = new MaterialCatalogue();
  push(cat, [entry('RM-1', 'A')]);
  await assert.rejects(() => cat.findAliasForMaterial(randomUUID()), ServiceUnavailableException);
  await assert.rejects(() => cat.findAliasesForMaterials([randomUUID()]), ServiceUnavailableException);
});

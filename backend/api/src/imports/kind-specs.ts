/**
 * IMPORT-RP — the factory's import kinds, as data: the columns of each template, what identifies a
 * row, what is created, and what is refused. The Instructions sheet of every template is written from
 * this file, so the sheet a person fills in and the rules that judge it cannot drift apart.
 *
 * `permission` is the import's own permission; `mirrors` is the single-record permission whose
 * holders it must match exactly (scripts/imp-grants.ts, asserted by imports-permissions.test.ts).
 */
import type { ImportColumn, ImportKindSpec } from '@core/backend-kernel';

const col = (key: string, header: string, required: boolean, help: string, example: string, aliases: string[] = []): ImportColumn =>
  ({ key, header, aliases, required, help, example });

export const INGREDIENTS: ImportKindSpec = {
  kind: 'ingredients', title: 'Ingredients',
  // The permission the materials import has had since STOCK-FIX-RP (STK-17): procurement and the owner.
  permission: 'masterdata:material_import:write', mirrors: ['masterdata:floor_code:write'],
  exampleKey: 'name',
  columns: [
    col('code', 'Code', false, 'Your code for the ingredient. Leave it empty and the next RM- number is given in order.', '', ['Material code', 'Ingredient code']),
    col('name', 'Name', true, 'The ingredient as you buy it. One material, one name: the same name twice is refused.', 'Example ingredient (delete this row)', ['Material name', 'Ingredient', 'Material']),
    col('family', 'Family', false, 'The floor family, which gives the colour and the floor code: citrus, woody, musk, floral, aldehydic, spicy, amber, aquatic or solvent.', 'citrus', ['Floor family']),
    col('cas', 'CAS number', false, 'As printed on the SDS, with its dashes. Checked by its check digit.', '5989-27-5', ['CAS', 'CAS no']),
    col('unit', 'Unit', false, 'The unit it is stocked in: kg, g, l, ml. Must be in the unit list.', 'kg', ['UOM']),
    col('supplier', 'Default supplier', false, 'The supplier\'s code or exact name. The supplier must already be on file.', '', ['Supplier', 'Preferred supplier']),
    col('hazardClass', 'Hazard class', false, 'The UN dangerous-goods class as printed on the SDS (3, 6.1, 9 ...) or NOT_REGULATED. Leave it empty if you do not hold it: it is never worked out for you.', '', ['UN class', 'DG class']),
    col('hazardSource', 'Hazard source', false, 'Where the class was read: the SDS and its date, or the supplier\'s declaration. Required with a hazard class.', ''),
    col('density', 'Density (g per ml)', false, 'Only a measured figure, in grams per millilitre (0.3 to 2.5). Leave it empty if it was not measured.', '', ['Density']),
    col('densitySource', 'Density source', false, 'Where the density came from: the CoA, the SDS, or who measured it. Required with a density.', ''),
  ],
  instructions: [
    'A hazard class and a density are recorded only with their source. An empty cell stays empty: nothing is derived from a name, a CAS number or a family.',
    'A row whose name is already on file is skipped, so a corrected file can be uploaded without making anything twice.',
  ],
  naturalKey: 'The name (case and spaces aside), and the code when one is given.',
  rule: 'Create only. A material already on file is skipped and nothing on it is changed; change one material on its own screen.',
  refuses: ['a name twice in the file', 'a sheet\'s total row', 'a code already used by another material', 'a family not on file', 'a CAS number whose check digit does not match', 'a hazard class with no source', 'a density with no source or outside 0.3 to 2.5 g per ml', 'a unit or supplier not on file'],
};

export const SUPPLIERS: ImportKindSpec = {
  kind: 'suppliers', title: 'Suppliers',
  permission: 'procurement:vendor_import:write', mirrors: ['procurement:vendor_details:write'],
  exampleKey: 'name',
  columns: [
    col('code', 'Supplier code', false, 'Your code for the supplier. Leave it empty and one is given.', '', ['Vendor code', 'Code']),
    col('name', 'Name', true, 'The supplier\'s registered name.', 'Example supplier (delete this row)', ['Supplier name', 'Vendor name', 'Supplier', 'Vendor']),
    col('gstin', 'GSTIN', false, '15 characters, as on their invoice. Its check character is verified.', '', ['GST number', 'GST no']),
    col('pan', 'PAN', false, '10 characters.', '', ['PAN number']),
    col('paymentTerms', 'Payment terms', false, 'As agreed, in words: "Net 30", "Advance".', 'Net 30', ['Terms']),
    col('email', 'Email', false, 'The address purchase orders go to.', '', ['Contact email']),
    col('phone', 'Phone', false, 'With the country code for a number outside India.', '', ['Contact phone', 'Mobile']),
  ],
  instructions: ['A supplier already on file (the same code, or the same name) is skipped. Bank details are not taken from a sheet: add them on the supplier\'s own screen.'],
  naturalKey: 'The supplier code when given, otherwise the name (case and spaces aside).',
  rule: 'Create only. A supplier already on file is skipped and nothing on it is changed.',
  refuses: ['no name', 'a code or name twice in the file', 'a code that belongs to a supplier of another name', 'a GSTIN whose check character does not match', 'a PAN that is not 10 characters in the PAN pattern', 'an email with no @'],
};

export const SUPPLIER_LOTS: ImportKindSpec = {
  kind: 'supplier-lots', title: 'Supplier lots (goods receipts)',
  permission: 'inventory:grn_import:write', mirrors: ['inventory:grn_master:write'],
  exampleKey: 'supplierLot',
  columns: [
    col('ingredient', 'Ingredient code', true, 'The ingredient\'s code, as on file.', 'RM-00001', ['Material code', 'Code']),
    col('supplier', 'Supplier', true, 'The supplier\'s code or exact name.', 'Example supplier', ['Vendor', 'Supplier code']),
    col('supplierLot', 'Supplier lot', true, 'The lot or batch number printed on the supplier\'s container or CoA. This is what a recall names.', 'EXAMPLE-LOT-001', ['Supplier lot number', 'Supplier batch', 'Batch number', 'Lot']),
    col('quantity', 'Quantity', true, 'How much was received, as a number.', '25', ['Qty', 'Received quantity']),
    col('unit', 'Unit', true, 'The unit of that quantity: kg, g, l, ml.', 'kg', ['UOM']),
    col('receivedDate', 'Received date', true, 'The day it arrived. Day first: 22/09/2026.', '22/09/2026', ['Received', 'Receipt date', 'GRN date']),
    col('mfgDate', 'Manufacture date', false, 'As printed by the supplier. Leave it empty if it is not printed.', '', ['Manufacturing date', 'Mfg date', 'Manufactured']),
    col('expiryDate', 'Expiry date', false, 'As printed by the supplier. Leave it empty if it is not printed: it is never worked out from a shelf life.', '', ['Expiry', 'Best before', 'Retest date']),
    col('certificate', 'Certificate reference', false, 'The number of the CoA that came with the lot.', '', ['CoA', 'CoA reference', 'Certificate']),
  ],
  instructions: [
    'Every lot lands in quarantine, exactly as a receipt typed by hand does. QC releases it; an import never does.',
    'Rows of one supplier received on one day become one goods receipt with a line for each row.',
  ],
  naturalKey: 'Ingredient, supplier and supplier lot.',
  rule: 'Create only. A supplier lot already received from that supplier for that ingredient is skipped.',
  refuses: ['an ingredient or a supplier not on file', 'a quantity of zero or less', 'a unit not on file, or one that does not convert to the ingredient\'s own unit', 'a received date in the future', 'an expiry or a manufacture date that contradicts the received date', 'the same ingredient, supplier and lot twice in the file'],
};

export const DILUTIONS: ImportKindSpec = {
  kind: 'dilutions', title: 'Dilutions',
  permission: 'masterdata:material_dilution_import:write', mirrors: ['masterdata:material_dilution:write'],
  exampleKey: 'dilution',
  columns: [
    col('dilution', 'Dilution code', true, 'The code of the dilution itself. A dilution is an ingredient of its own, so it must already be on file.', 'EXAMPLE-DIL-10', ['Dilution', 'Code']),
    col('base', 'Base ingredient', true, 'The code of the material that is diluted.', 'RM-00001', ['Base', 'Base code', 'Base ingredient code']),
    col('solvent', 'Solvent', true, 'The code of the solvent it is diluted in.', 'RM-00002', ['Solvent code', 'Solvent ingredient', 'Solvent ingredient code']),
    col('basePercent', 'Base percent', true, 'The share of the base by weight: 10 for a 10% dilution.', '10', ['Base pct', 'Percent', 'Ratio', 'Base share']),
    col('solventPercent', 'Solvent percent', true, 'The share of the solvent by weight. The two must add up to exactly 100.', '90', ['Solvent pct', 'Solvent share']),
  ],
  instructions: ['Add the dilution, its base and its solvent as ingredients first. This sheet records only what each dilution is made of.'],
  naturalKey: 'The dilution code.',
  rule: 'Create only. A dilution on file with the same base, solvent and shares is skipped. A different ratio is a different material and needs its own code.',
  refuses: ['a dilution, base or solvent not on file', 'a base that is also the solvent', 'shares that do not add up to exactly 100', 'a dilution already on file with another composition', 'a dilution code twice in the file'],
};

export const RAW_STOCK_OPENING: ImportKindSpec = {
  kind: 'raw-stock-opening', title: 'Opening raw stock',
  permission: 'inventory:rm_batch_import:write', mirrors: ['inventory:rm_batch_master:write'],
  exampleKey: 'lot',
  columns: [
    col('ingredient', 'Ingredient code', true, 'The ingredient\'s code, as on file.', 'RM-00001', ['Material code', 'Code']),
    col('lot', 'Lot', true, 'Your own lot number for what is on the shelf. Each lot number is used once.', 'EXAMPLE-OPEN-001', ['Lot number', 'Batch', 'Batch number']),
    col('quantity', 'Quantity', true, 'How much is on the shelf, as a number more than zero.', '12.5', ['Qty']),
    col('unit', 'Unit', true, 'The unit of that quantity: kg, g, l, ml.', 'kg', ['UOM']),
    col('reason', 'Reason', true, 'Why this stock is being opened here: "Opening balance at go-live, count of 12 Nov".', 'Opening balance at go-live', ['Remarks', 'Note']),
    col('location', 'Location', false, 'The storage location code, when the lot already has its place.', '', ['Storage location', 'Bin']),
    col('supplierLot', 'Supplier lot', false, 'The supplier\'s own lot number, if it is still on the container.', '', ['Supplier lot number', 'Supplier batch']),
    col('mfgDate', 'Manufacture date', false, 'As printed. Leave it empty if it is not.', '', ['Manufacturing date', 'Mfg date']),
    col('expiryDate', 'Expiry date', false, 'As printed. Leave it empty if it is not.', '', ['Expiry', 'Best before', 'Retest date']),
  ],
  instructions: ['An opening lot lands in quarantine like any raw lot. QC releases it to stock; an import never does. The reason is kept on the import\'s history.'],
  naturalKey: 'The lot number.',
  rule: 'Create only. A lot number already on file for that ingredient is skipped.',
  refuses: ['an ingredient not on file', 'a lot number already used for another ingredient', 'a quantity of zero or less', 'a unit not on file, or one that does not convert to the ingredient\'s own unit', 'no reason', 'a location not on file', 'a manufacture date in the future, or an expiry that is not after it'],
};

export const RAW_STOCK_ADJUSTMENT: ImportKindSpec = {
  kind: 'raw-stock-adjustment', title: 'Raw stock adjustments',
  permission: 'inventory:stock_adjustment_import:write', mirrors: ['inventory:stock_adjustment:write'],
  exampleKey: 'reference',
  columns: [
    col('ingredient', 'Ingredient code', true, 'The ingredient\'s code, as on file.', 'RM-00001', ['Material code', 'Code']),
    col('lot', 'Lot', true, 'Our lot number, as on the lot\'s label.', 'RMB-EXAMPLE', ['Lot number', 'Batch', 'Batch number']),
    col('change', 'Change', true, 'The change, with a minus sign for a decrease: -0.25 or 1.5. Not the new figure.', '-0.25', ['Adjustment', 'Quantity', 'Qty', 'Difference']),
    col('unit', 'Unit', true, 'The unit of the change: kg, g, l, ml.', 'kg', ['UOM']),
    col('reason', 'Reason', true, 'Why: "Count of 12 Nov found less than the ledger".', 'Stock count difference', ['Remarks', 'Note']),
    col('reference', 'Reference', true, 'The count sheet or note number. A change already posted under this reference for this lot is skipped.', 'EXAMPLE-COUNT-001', ['Count sheet', 'Document', 'Ref']),
    col('location', 'Location', false, 'The storage location code. Needed only when the lot sits in more than one place.', '', ['Storage location', 'Bin']),
  ],
  instructions: ['Each row adds a line to the adjustment ledger and moves the lot\'s figure by the change. Nothing is overwritten, and a lot still held for QC cannot be adjusted (it has no stock figure yet).'],
  naturalKey: 'The lot and the reference.',
  rule: 'Appends to the ledger. A change already posted for that lot under that reference is skipped.',
  refuses: ['an ingredient or a lot not on file', 'a lot that is not of that ingredient', 'a lot not yet released to stock', 'a change of zero', 'a unit that does not convert to the lot\'s own unit', 'a decrease that would take the lot below zero', 'a decrease that cuts into stock reserved for production', 'no reason or no reference'],
};

export const PACKAGING_MATERIALS: ImportKindSpec = {
  kind: 'packaging-materials', title: 'Packaging materials',
  permission: 'packaging:packaging_material_import:write', mirrors: ['packaging:packaging_material_master:write'],
  exampleKey: 'code',
  columns: [
    col('code', 'Code', true, 'Your code for the bottle, cap, label or carton.', 'EXAMPLE-PKG-001', ['Packaging code', 'Packaging material code']),
    col('name', 'Name', true, 'What it is, as you order it.', 'Example bottle 100 ml (delete this row)', ['Packaging name', 'Packaging material', 'Description']),
    col('unit', 'Unit', false, 'The unit it is counted in. Must be in the unit list.', '', ['UOM']),
  ],
  instructions: [],
  naturalKey: 'The code.',
  rule: 'Create only. A code already on file under the same name is skipped.',
  refuses: ['a code twice in the file', 'a code on file under another name', 'a unit not on file'],
};

/* IMPORT-RP-COST (LD-156). One permission for the sheet and for the single price typed on screen: the
   same people do both (purchasing and finance), through the same function. */
export const MATERIAL_PURCHASE_PRICES: ImportKindSpec = {
  kind: 'material-purchase-prices', title: 'Material purchase prices',
  permission: 'procurement:material_purchase_price:write', mirrors: ['procurement:material_purchase_price:write'],
  exampleKey: 'material',
  columns: [
    col('material', 'Material code', true, 'The material\'s code, as on file. This is what identifies the row.', 'EXAMPLE-RM', ['Code', 'Ingredient code']),
    col('name', 'Material name', false, 'For you to read. It is not imported and changes nothing.', 'Example material (delete this row)', ['Name']),
    col('unit', 'Unit', false, 'What the price is per: kg, g, L, ml or unit. Empty means the material\'s own unit.', 'kg', ['UOM', 'Per']),
    col('supplier', 'Supplier code', false, 'The supplier this price is from: their code or exact name. Empty means no supplier is named.', '', ['Supplier', 'Vendor', 'Vendor code']),
    col('listPrice', 'List purchase price (Rs per unit)', false, 'The supplier\'s price in rupees, before discount: 1250 or 1,250.50. LEAVE IT EMPTY FOR "NO CHANGE": an empty cell is never read as zero.', '1250.00', ['List price', 'Purchase price', 'Price', 'Rate']),
    col('discount', 'Purchase discount %', false, 'The discount off the list price: 5 or 7.5. Empty means none.', '5', ['Discount', 'Discount %', 'Purchase discount']),
    col('gst', 'GST rate %', false, 'Only if you hold it: 18. Empty stays empty.', '', ['GST', 'GST rate', 'GST %']),
    col('hsn', 'HSN code', false, 'Only if you hold it: 4, 6 or 8 digits. Empty stays empty.', '', ['HSN']),
    col('effectiveFrom', 'Effective from', false, 'The day this price starts. Day first: 01/12/2026. Needed with a price.', '01/12/2026', ['Effective date', 'From', 'Valid from']),
    col('note', 'Note', false, 'Anything worth keeping with the price: the quotation number, who agreed it.', '', ['Remarks', 'Notes']),
  ],
  instructions: [
    'Use "Export what is on file" to get this sheet with every material already in it. Fill in the prices you have and upload it back; rows you leave without a price are passed over.',
    'The net price (list less discount) is worked out once when the price is recorded, rounded to the paisa, and kept beside the two figures you gave.',
    'A price on file is never rewritten. To change a price, give the new one a later "Effective from"; the earlier one stays in the history.',
    'A row that moves a price by more than the limit set for large changes is listed in the preview for you to check. It is not refused.',
    'Every price recorded is sent to Books (the finance console) as it is recorded.',
  ],
  naturalKey: 'Material, supplier and effective date.',
  rule: 'Adds to the price history. The same price from the same date is skipped; a later date supersedes; an empty price cell changes nothing.',
  refuses: ['a material or supplier not on file', 'a price of zero or below, or with more than two decimals', 'a discount or GST rate over 100%', 'an HSN code that is not 4, 6 or 8 digits', 'a price with no effective date, or one more than 90 days ahead', 'a different price for a material, supplier and date already on file', 'a unit a price cannot be per'],
};

export const FACTORY_IMPORT_SPECS = [INGREDIENTS, SUPPLIERS, SUPPLIER_LOTS, DILUTIONS, RAW_STOCK_OPENING, RAW_STOCK_ADJUSTMENT, PACKAGING_MATERIALS, MATERIAL_PURCHASE_PRICES] as const;

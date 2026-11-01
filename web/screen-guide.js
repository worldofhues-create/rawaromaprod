/* RAW AROMA — Factory console screen guide (web/screen-guide.js): the plain words every screen uses.
 * One table per question a new person asks — "what is this screen called", "what is it for", "where
 * do these rows come from", "what does this button do", "what does this status mean" — so no screen
 * needs training. Keyed by data source (the endpoint, or a workspace view's sentinel), the same key
 * web/routes.js turns into the address. Pure data + small helpers; no DOM (tested in a vm).
 */
(function (g) {
  'use strict';

  /** One name per screen, the same in every workspace (the rail, the dock, the palette, the title). */
  var LABEL = {
    '/v1/production-plan-items': 'Plan lines', '/v1/production-orders': 'Production orders', '/v1/material-categories': 'Material categories',
    '/v1/material-subcategories': 'Material sub-categories', '/v1/material-qc-specifications': 'Material test specs',
    '/v1/rm-aliases': 'Material code names', '/v1/batch-container-mappings': 'Batch containers', '/v1/geo-region-types': 'Region levels',
    '/v1/geo-regions': 'Regions', '/v1/dispatch-documents': 'Dispatch documents', '/v1/fg-stock': 'Finished stock',
    '/v1/finished-good-batches': 'Finished batches', '/v1/notifications': 'Notifications sent', '/v1/formula-event-hist': 'Formula history',
    '/v1/audit-events': 'Change history', '/v1/bridge/requirements': 'Sales requirements', '/v1/fg-labels': 'Product labels',
    '/v1/approval-matrix': 'Approval rules', '/v1/batch-coas': 'Batch certificates', '/v1/product-qc-specs': 'Product test specs',
    '/v1/login-history': 'Sign-in history', '/v1/rfqs': 'Quote requests', '/v1/quotations': 'Supplier quotes', '/v1/quotation-items': 'Quote lines',
    '/v1/vendor-negotiations': 'Price negotiation', '/v1/vendor-contacts': 'Supplier contacts', '/v1/vendor-rm-mappings': 'Supplier materials',
    '/v1/vendor-rate-history': 'Supplier price history', '/v1/vendor-performance': 'Supplier performance', '/v1/vendor-credit-notes': 'Supplier credit notes',
    '/v1/qc-rejected-grns': 'Rejected deliveries', '/v1/vendor-ledger': 'Supplier ledger', '/v1/vendor-dispatches': 'Supplier shipments',
    '/v1/grns': 'Goods receipts', '/v1/grn-items': 'Received quantities', '/v1/rm-batches': 'Raw material batches',
    '/v1/qc-result-details': 'Test results', '/v1/qc-sample-retentions': 'Retained samples', '/v1/qc-parameters': 'Test parameters',
    '/v1/material-pick-list-items': 'Pick list lines', '/v1/qc-capas': 'Corrective actions', '/v1/inventory-availability': 'Stock on hand',
    '/v1/inventory-transactions': 'Stock movements', '/v1/stock-adjustments': 'Stock adjustments', '/v1/stock-reservations': 'Stock reservations',
    '/v1/stock-transfers': 'Stock transfers', '/v1/package-orders': 'Packing orders', '/v1/fg-reservations': 'Reserved finished stock',
    '/v1/product-skus': 'Pack sizes', '/v1/packaging-boms': 'Packaging materials', '/v1/oil-batches': 'Oil batches',
    '/v1/production-order-ingredients': 'Order ingredients'
  };
  /** Where one workspace means something different by the same rows, it keeps its own word. */
  var ROLE_LABEL = { compounding: { '/v1/production-order-ingredients': 'Worksheets' }, superadmin: { '/v1/finished-good-batches': 'Trace a batch' } };

  /** What the screen is for — one line under the title, in the words of the person doing the work. */
  var HELP = {
    __dash__: 'Your queues that need action, and today\'s figures. Tap a tile to open the screen that clears it.',
    __produce__: 'Sales orders in the order to make them. Plan a run, then follow it to QC and the shelf.',
    __shelftasks__: 'Batches to put on a shelf and orders to pick. Scan or tap a task to finish it.',
    __racklayout__: 'Your racks, shelves and bins, and what sits in each bin.',
    __shelfdisplay__: 'A live board for the floor: what to put away and what to pick, bin by bin.',
    __factorysetup__: 'The checklist that gets the factory ready. Approve Ruh\'s drafts one row at a time or together.',
    __formulasetup__: 'Which formula each product is made from. The recipe itself stays in the Vault.',
    __tutorial__: 'Short guided tours of this workspace. Each one walks you through a real task.',
    '/v1/production-plans': 'Plans group the orders you mean to make in a period.',
    '/v1/production-plan-items': 'Each line is one product and quantity inside a production plan.',
    '/v1/production-orders': 'One row per production run: how much, which formula version, and how far it has got.',
    '/v1/production-order-ingredients': 'The ingredients each run needs, by code name. Real names stay in the Vault.',
    '/v1/material-pick-lists': 'What the store has to pick for each production run.',
    '/v1/material-pick-list-items': 'Each line is one material to pick, and how much.',
    '/v1/material-issues': 'Materials handed from the store to the production floor.',
    '/v1/mixing-sessions': 'Open a mixing session, record each weighing, then end the session.',
    '/v1/weighing-records': 'Every weighing on the balance, with its target and tolerance.',
    '/v1/oil-batches': 'Finished oil from each run. Move it through maturing, release or hold.',
    '/v1/production-qc': 'Tests on oil from production, before it can be packed.',
    '/v1/qc-capas': 'Problems found in QC and what is being done to stop them happening again.',
    '/v1/batch-coas': 'The certificate of analysis for each finished batch. Release it when it passes.',
    '/v1/product-qc-specs': 'The pass limits for each product (specific gravity, flash point, shelf life).',
    '/v1/qc-inspections': 'Incoming batches waiting to be tested. Record results, then accept, hold or reject.',
    '/v1/qc-result-details': 'Every test reading recorded, parameter by parameter.',
    '/v1/qc-sample-retentions': 'Samples kept back from each batch, and until when.',
    '/v1/qc-parameters': 'The tests your lab runs (density, colour, odour …).',
    '/v1/material-qc-specifications': 'The pass limits for each raw material.',
    '/v1/packaging-qc': 'Checks on packed goods: leaks, labels and cartons.',
    '/v1/stock-requirements': 'Materials you need and by when. Raise one here or from the reorder plan.',
    '/v1/reorder-suggestions': 'Materials below their reorder level. Raise a requirement for any shortage.',
    '/v1/purchase-requests': 'Requests to buy. Submit, then someone else approves.',
    '/v1/rfqs': 'Requests for quotes sent to suppliers.',
    '/v1/quotations': 'Prices suppliers sent back. Select the one to buy from.',
    '/v1/quotation-items': 'Each quoted material and price.',
    '/v1/vendor-negotiations': 'Price changes agreed with a supplier after the first quote.',
    '/v1/purchase-orders': 'Orders to suppliers. Approve, issue, amend or cancel them here.',
    '/v1/po-advance-payments': 'Money paid to a supplier before delivery.',
    '/v1/vendors': 'The suppliers you buy from.',
    '/v1/vendor-contacts': 'People to contact at each supplier.',
    '/v1/vendor-rm-mappings': 'Which supplier sells which material, lead time and minimum order.',
    '/v1/vendor-rate-history': 'Prices paid to each supplier over time.',
    '/v1/vendor-performance': 'How each supplier is doing: orders, receipts and QC pass rate.',
    '/v1/vendor-credit-notes': 'Credit notes from suppliers, for returns and short deliveries.',
    '/v1/qc-rejected-grns': 'Deliveries that failed QC. Raise a replacement order from here.',
    '/v1/vendor-ledger': 'What you owe each supplier, net of credit notes.',
    '/v1/vendor-dispatches': 'Shipments suppliers have told you are on the way.',
    '/v1/gate-entries': 'Vehicles arriving at the gate with deliveries.',
    '/v1/grns': 'Goods received against a purchase order. Record what arrived and in what state.',
    '/v1/grn-items': 'Ordered against received quantities, line by line.',
    '/v1/rm-batches': 'Each raw material batch received. Print its label or release it to stock.',
    '/v1/grn-containers': 'The drums and cans each delivery came in. Print a label for each.',
    '/v1/batch-container-mappings': 'Which containers hold which batch, when a batch is split.',
    '/v1/inventory-availability': 'What is in stock and free to use, first-expiring first.',
    '/v1/inventory-transactions': 'Every movement of stock in and out.',
    '/v1/stock-adjustments': 'Corrections to stock, with the reason.',
    '/v1/stock-reservations': 'Stock held back for an order. Release it if it is no longer needed.',
    '/v1/stock-audits': 'Physical stock counts and what they found.',
    '/v1/stock-transfers': 'Stock moved between locations.',
    '/v1/warehouses': 'Your warehouses. Floors, zones, racks and bins sit inside them.', '/v1/floors': 'Floors in each warehouse.', '/v1/zones': 'Storage zones on each floor.',
    '/v1/racks': 'Racks in each storage zone.', '/v1/shelves': 'Shelves on each rack.', '/v1/bins': 'Bins on each shelf, where batches are stored.',
    '/v1/filling-sessions': 'Filling runs on the line. End the fill when it is done.',
    '/v1/package-orders': 'Orders to pack oil into bottles for a pack size.',
    '/v1/finished-good-batches': 'Packed batches ready for sale. Apply labels, or trace a batch back to its materials.',
    '/v1/fg-stock': 'Finished stock: made, dispatched, reserved and still free to sell.',
    '/v1/fg-reservations': 'Finished stock held for an order. Release it if the order changes.',
    '/v1/fg-labels': 'Labels applied to each finished batch.',
    '/v1/products': 'The products you make.', '/v1/product-skus': 'Each product\'s pack sizes (the SKUs you sell).',
    '/v1/packaging-boms': 'The bottles, caps and cartons each pack size uses.',
    '/v1/sales-orders': 'Orders from customers, normally sent in by the sales system. Dispatch them when confirmed.',
    '/v1/customers': 'The customers you sell to.', '/v1/transporters': 'Transport companies that carry your dispatches.',
    '/v1/dispatches': 'Goods sent to customers. Mark each one delivered when it arrives.',
    '/v1/dispatch-documents': 'Invoices, delivery notes and e-way bills for each dispatch.',
    '/v1/bridge/requirements': 'What the sales system has asked the factory to make, and how far each order has got.',
    '/v1/materials': 'Every raw material, with its unit, reorder level and whether it needs QC.',
    '/v1/uoms': 'Units of measure (kg, L, units …).', '/v1/material-types': 'Kinds of material (natural, aroma chemical, solvent …).',
    '/v1/material-categories': 'Groups materials are filed under.', '/v1/material-subcategories': 'Finer groups inside each category.',
    '/v1/material-groups': 'Material groups used in reports.', '/v1/material-storage-rules': 'How each material must be stored (temperature, conditions).',
    '/v1/rm-aliases': 'The code names the floor sees instead of real material names.',
    '/v1/geo-region-types': 'Levels of your region tree (country, state, city …).', '/v1/geo-regions': 'Places used in addresses.',
    '/v1/users': 'Everyone who can sign in. Give each person a role.', '/v1/roles': 'Roles decide what each person can do.',
    '/v1/permissions': 'Every permission a role can hold.', '/v1/approval-matrix': 'Which documents need approval, and above what amount.',
    '/v1/orgs': 'Your company and its group companies.', '/v1/business-units': 'Business units inside the company.',
    '/v1/location-types': 'Kinds of location (factory, office, store).', '/v1/locations': 'Your sites: factory, offices and stores.',
    '/v1/contacts': 'People you deal with, and how they like to be reached.', '/v1/countries': 'Countries, their currency and time zone.',
    '/v1/document-registry': 'Licences, certificates and other documents, with expiry dates.',
    '/v1/login-history': 'Every sign-in attempt, newest first, including refused ones.',
    '/v1/audit-events': 'Every change made in the factory, who made it and when.',
    '/v1/formula-event-hist': 'Every time a formula was created, changed or approved.',
    '/v1/notifications': 'Messages the factory has sent (email alerts).'
  };

  /** Where rows on a screen come from, for screens nobody fills by hand (said when it is empty). */
  var COMES_FROM = {
    '/v1/production-orders': 'Production orders are made from Produce next when you plan a run.',
    '/v1/production-order-ingredients': 'Ingredients appear when a production order is planned.',
    '/v1/material-pick-lists': 'Pick lists are made from a production order (Generate pick list).',
    '/v1/material-pick-list-items': 'Lines appear when a pick list is generated.',
    '/v1/mixing-sessions': 'A mixing session starts from a production order on Produce next.',
    '/v1/weighing-records': 'Weighings are recorded inside a mixing session.',
    '/v1/oil-batches': 'Oil batches appear when a mixing session ends.',
    '/v1/production-qc': 'Production QC rows appear when an oil batch is tested.',
    '/v1/batch-coas': 'A certificate is started when a finished batch is tested.',
    '/v1/qc-inspections': 'Batches arrive here when Receiving books goods in.',
    '/v1/qc-result-details': 'Readings appear when QC records results on the test queue.',
    '/v1/rm-batches': 'Batches are created when a goods receipt is saved.',
    '/v1/grn-containers': 'Containers are recorded with each goods receipt.',
    '/v1/grn-items': 'Lines appear when a goods receipt is saved.',
    '/v1/inventory-availability': 'Stock appears once received batches pass QC and are released.',
    '/v1/inventory-transactions': 'Every receipt, issue and adjustment is listed here as it happens.',
    '/v1/reorder-suggestions': 'Nothing is below its reorder level.',
    '/v1/qc-rejected-grns': 'No delivery has failed QC.',
    '/v1/vendor-performance': 'Figures appear once suppliers have orders and deliveries.',
    '/v1/vendor-ledger': 'Balances appear once purchase orders are issued.',
    '/v1/vendor-rate-history': 'Prices appear as quotes and orders are recorded.',
    '/v1/finished-good-batches': 'Finished batches appear when a packing order is completed.',
    '/v1/fg-stock': 'Finished stock appears when finished batches pass packaging QC.',
    '/v1/fg-reservations': 'Reservations are made when a sales order is confirmed.',
    '/v1/fg-labels': 'Labels are recorded from Finished batches (Apply labels).',
    '/v1/dispatches': 'Dispatches are made from a confirmed sales order (Dispatch).',
    '/v1/dispatch-documents': 'Documents are created with each dispatch.',
    '/v1/sales-orders': 'Sales orders arrive from the sales system.',
    '/v1/bridge/requirements': 'Orders arrive here when the sales system sends them.',
    '/v1/audit-events': 'Changes are recorded here as people work.',
    '/v1/formula-event-hist': 'Formula events are recorded as formulas change in the Vault.',
    '/v1/login-history': 'Sign-ins are recorded as people open the console.',
    '/v1/notifications': 'Messages are listed here as they are sent.',
    '/v1/filling-sessions': 'Fill tickets start from a packing order.',
    '/v1/packaging-qc': 'Checks are recorded when a finished batch is inspected.',
    '/v1/stock-reservations': 'Reservations are made when stock is held for a production order.',
    '/v1/vendor-dispatches': 'Suppliers\' shipment notices appear here.'
  };

  /** Rail groups, in this order. A workspace with more than nine screens shows them under these. */
  var GROUPS = ['Start here', 'Production', 'Quality', 'Buying', 'Receiving', 'Stock and storage', 'Packing and sales', 'Setup', 'Records', 'Help'];
  var GROUP_OF = {
    __dash__: 0, __produce__: 0, __shelftasks__: 0, __factorysetup__: 0, '/v1/bridge/requirements': 0,
    '/v1/production-plans': 1, '/v1/production-plan-items': 1, '/v1/production-orders': 1, '/v1/production-order-ingredients': 1,
    '/v1/material-pick-lists': 1, '/v1/material-pick-list-items': 1, '/v1/material-issues': 1, '/v1/mixing-sessions': 1,
    '/v1/weighing-records': 1, '/v1/oil-batches': 1,
    '/v1/qc-inspections': 2, '/v1/qc-result-details': 2, '/v1/production-qc': 2, '/v1/qc-sample-retentions': 2, '/v1/qc-parameters': 2,
    '/v1/qc-capas': 2, '/v1/batch-coas': 2, '/v1/product-qc-specs': 2, '/v1/material-qc-specifications': 2, '/v1/packaging-qc': 2,
    '/v1/stock-requirements': 3, '/v1/reorder-suggestions': 3, '/v1/purchase-requests': 3, '/v1/rfqs': 3, '/v1/quotations': 3,
    '/v1/quotation-items': 3, '/v1/vendor-negotiations': 3, '/v1/purchase-orders': 3, '/v1/po-advance-payments': 3, '/v1/vendors': 3,
    '/v1/vendor-contacts': 3, '/v1/vendor-rm-mappings': 3, '/v1/vendor-rate-history': 3, '/v1/vendor-performance': 3,
    '/v1/vendor-credit-notes': 3, '/v1/qc-rejected-grns': 3, '/v1/vendor-ledger': 3,
    '/v1/vendor-dispatches': 4, '/v1/gate-entries': 4, '/v1/grns': 4, '/v1/grn-items': 4, '/v1/rm-batches': 4, '/v1/grn-containers': 4,
    '/v1/batch-container-mappings': 4,
    '/v1/inventory-availability': 5, '/v1/inventory-transactions': 5, '/v1/stock-adjustments': 5, '/v1/stock-reservations': 5,
    '/v1/stock-audits': 5, '/v1/stock-transfers': 5, __racklayout__: 5, __shelfdisplay__: 5, '/v1/warehouses': 5, '/v1/floors': 5,
    '/v1/zones': 5, '/v1/racks': 5, '/v1/shelves': 5, '/v1/bins': 5,
    '/v1/filling-sessions': 6, '/v1/package-orders': 6, '/v1/finished-good-batches': 6, '/v1/fg-stock': 6, '/v1/fg-reservations': 6,
    '/v1/fg-labels': 6, '/v1/products': 6, '/v1/product-skus': 6, '/v1/packaging-boms': 6, '/v1/sales-orders': 6, '/v1/customers': 6,
    '/v1/transporters': 6, '/v1/dispatches': 6, '/v1/dispatch-documents': 6,
    __formulasetup__: 7, '/v1/materials': 7, '/v1/uoms': 7, '/v1/material-types': 7, '/v1/material-categories': 7,
    '/v1/material-subcategories': 7, '/v1/material-groups': 7, '/v1/material-storage-rules': 7, '/v1/rm-aliases': 7,
    '/v1/geo-region-types': 7, '/v1/geo-regions': 7, '/v1/orgs': 7, '/v1/business-units': 7, '/v1/location-types': 7,
    '/v1/locations': 7, '/v1/contacts': 7, '/v1/countries': 7, '/v1/users': 7, '/v1/roles': 7, '/v1/permissions': 7, '/v1/approval-matrix': 7,
    '/v1/notifications': 8, '/v1/document-registry': 8, '/v1/formula-event-hist': 8, '/v1/audit-events': 8, '/v1/login-history': 8,
    __tutorial__: 9
  };

  /** Status words as a person says them (the database keeps its codes; only the chip changes). */
  var STATUS_WORD = {
    INPROGRESS: 'In progress', IN_PROGRESS: 'In progress', PENDING_APPROVAL: 'Waiting for approval', MATERIALS_ISSUED: 'Materials issued',
    IN_MATURATION: 'Maturing', QC_PENDING: 'Waiting for QC', QC_FAILED: 'Failed QC', NO_SPEC: 'No spec yet', OUT_OF_TOLERANCE: 'Out of tolerance',
    ACCEPT: 'Accepted', REJECT: 'Rejected', REWORK: 'Rework', HOLD: 'On hold', PASS: 'Passed', FAIL: 'Failed', DONE: 'Done', OPEN: 'Open',
    DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', ISSUED: 'Issued', ACKNOWLEDGED: 'Acknowledged by supplier',
    RELEASED: 'Released', PLANNING: 'Planning', COMPLETED: 'Completed', CANCELLED: 'Cancelled', AMENDED: 'Replaced by an amendment',
    SENT: 'Sent to suppliers', SELECTED: 'Selected', TESTED: 'Tested', MANUAL_CONTINUITY: 'Entered by hand', DELIVERED: 'Delivered'
  };
  function statusWord(v) {
    var s = String(v == null ? '' : v).trim(); if (!s) return s;
    var up = s.toUpperCase();
    if (STATUS_WORD[up]) return STATUS_WORD[up];
    if (s !== up) return s; // already in words
    var w = up.replace(/_/g, ' ').toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  /** Column headings where the field name says nothing to a person. */
  var COLUMN = {
    fefoFlag: 'Use first', formulaVersionId: 'Formula version', productionOrderId: 'Production order', actualStartDt: 'Started',
    planDate: 'Plan date', plannedStartDt: 'Planned start', plannedEndDt: 'Planned end', sessionStartDt: 'Started', sessionEndDt: 'Ended',
    producedDt: 'Made on', inspectionDt: 'Inspected on', retainedDt: 'Kept on', weighedDt: 'Weighed at', appliedDt: 'Applied on',
    issuedDt: 'Issued on', reservedDt: 'Reserved on', transferDt: 'Moved on', pickListDate: 'Pick date', uom: 'Unit', tolerancePct: 'Tolerance %',
    sequenceNo: 'Line', targetQty: 'Target', netQty: 'Net weight', mappedSku: 'Pack size (SKU)', lifecycleStatus: 'Stage', neededBy: 'Needed by',
    orderRef: 'Sales order', occurredAt: 'When', actor: 'Who', cluster: 'Area', entityType: 'Record', resultStatus: 'Result',
    reraNo: 'Registration no.', gstin: 'GSTIN', sgMin: 'Specific gravity min', sgMax: 'Specific gravity max', flashPointMinC: 'Flash point min (°C)',
    flashPointMaxC: 'Flash point max (°C)', sgResult: 'Specific gravity', flashPointResultC: 'Flash point (°C)', overallResult: 'Result',
    qcPassPct: 'QC pass %', qcPass: 'Passed QC', qcFail: 'Failed QC', poCount: 'Orders', grnCount: 'Deliveries',
    finishedGoodBatchId: 'Finished batch', reservedForDocumentId: 'Reserved for', available: 'Free to use', onHand: 'On hand', reserved: 'Reserved',
    daysToExpiry: 'Days to expiry', isPreferred: 'Preferred', leadTimeDays: 'Lead time (days)', minOrderQty: 'Minimum order', isActive: 'Active',
    mobileNumber: 'Mobile', when: 'When', who: 'Who', how: 'How', ip: 'IP address', aliasName: 'Code name', aliasType: 'Kind',
    requiredQty: 'Required', issuedQty: 'Issued', replacementOfPo: 'Replaces PO', varianceType: 'Difference', orderQty: 'Quantity',
    producedQty: 'Made', dispatchedQty: 'Dispatched', reservedQty: 'Reserved', availableQty: 'Free to sell', packSize: 'Pack size',
    skuCode: 'Pack size (SKU)', grnNumber: 'Receipt no.', grnDate: 'Received on', poNumber: 'PO no.', prNumber: 'Request no.', soNumber: 'Order no.',
    rfqNumber: 'Quote request no.', quotationNumber: 'Quote no.', batchNumber: 'Batch', expiryDate: 'Expires', manufacturingDate: 'Made on',
    observedValue: 'Reading', observedText: 'Notes', parameterName: 'Test', containerQty: 'Quantity', containerCode: 'Container',
    gateEntryNumber: 'Gate entry no.', vehicleNumber: 'Vehicle', thresholdAmount: 'Above amount', policyType: 'Document',
    organizationName: 'Company', isEnabled: 'On', labelCount: 'Labels', receivedQty: 'Received', acceptedQty: 'Accepted', rejectedQty: 'Rejected',
    damagedQty: 'Damaged', orderedQty: 'Ordered', quotedQty: 'Quoted qty', quotedRate: 'Quoted price', originalRate: 'First price',
    revisedRate: 'Agreed price', recommendation: 'Advice', creditNotes: 'Credit notes', creditTotal: 'Credit total', netBalance: 'Balance',
    poTotal: 'Order total', qcResult: 'QC result', submissionDeadline: 'Reply by', validUntilDate: 'Valid until', rfqDate: 'Sent on',
    quotationDate: 'Quoted on', expectedDeliveryDate: 'Expected on', paymentTerms: 'Payment terms', origin: 'Came from', requiredByDate: 'Needed by',
    leakageCheck: 'Leak check', labelCheck: 'Label check', cartonCheck: 'Carton check', eventType: 'What happened', eventDt: 'When',
    formulaId: 'Formula', remarks: 'Notes', createdDt: 'Created', shelfLifeMonths: 'Shelf life (months)', bestBefore: 'Best before',
    productionDate: 'Made on', fefo: 'Use first'
  };

  /** What a row button does, said before it is pressed (shown on hover and to screen readers). */
  var ACTION_HELP = {
    'Set spec': 'Set the pass limits this product is tested against.',
    'Re-test': 'Record new test readings for this batch.',
    'Release': 'Release it so it can be used or sold.',
    'Raise requirement': 'Ask Procurement to buy this material.',
    'Assign perms': 'Choose what people with this role can do.',
    'Assign role': 'Give this person a role.',
    'Revoke': 'Take this away. It applies from the person\'s next sign-in.',
    'Mark delivered': 'Record that the customer received this dispatch.',
    'Submit': 'Send for approval. Someone else must approve it.',
    'Approve': 'Approve it so it can go ahead.',
    'Reject': 'Send it back. It cannot go ahead.',
    'Issue': 'Send this purchase order to the supplier.',
    'Acknowledge': 'Record that the supplier accepted the order.',
    'Amend': 'Make a changed copy. The copy needs approval again.',
    'Cancel': 'Cancel this order. The supplier is told why.',
    'QR label': 'Print a QR label to stick on it.',
    'Release to stock': 'Make this batch available to use (after QC).',
    'Replacement PO': 'Raise a new purchase order for the rejected goods.',
    'Send to vendors': 'Send this quote request to the suppliers on it.',
    'Select as final vendor': 'Buy from this supplier at this price.',
    'Record results': 'Enter the test readings for this batch.',
    'Accept': 'Passed: the batch can be used.',
    'Hold': 'Put on hold: it cannot be used until someone decides.',
    'Rework': 'Send it back to be fixed.',
    'Fail': 'Mark it failed: it will not be used.',
    'Record weighing': 'Enter a reading from the balance for one ingredient line.',
    'End session': 'Finish mixing. Every line must be weighed first.',
    'End fill': 'Finish this filling run.',
    'Generate pick list': 'Make the list of materials the store must pick for this run.',
    'Confirm': 'Confirm this order by hand (only when the sales system cannot send it).',
    'Dispatch': 'Send this order to the customer.',
    'Trace': 'See which oil, materials and suppliers went into this batch.',
    'Apply labels': 'Record how many labels were put on this batch.',
    'Start maturation': 'Start the maturing period for this oil.',
    'Edit': 'Change this record.', 'Deactivate': 'Stop offering it in pickers. It can be turned back on.',
    'Activate': 'Offer it in pickers again.', 'Print': 'Open a printable copy.'
  };
  /** What to say once a row button has worked. */
  var DONE = {
    'Submit': 'Submitted for approval', 'Approve': 'Approved', 'Issue': 'Sent to the supplier', 'Acknowledge': 'Marked acknowledged',
    'Release': 'Released', 'Release to stock': 'Released to stock', 'Accept': 'Accepted', 'Reject': 'Rejected', 'Hold': 'Put on hold',
    'Rework': 'Sent for rework', 'Fail': 'Marked failed', 'End session': 'Mixing session ended', 'End fill': 'Fill ended',
    'Generate pick list': 'Pick list made', 'Start maturation': 'Maturing started', 'Mark delivered': 'Marked delivered'
  };

  function label(endpoint, role, fallback) {
    var r = ROLE_LABEL[role]; if (r && r[endpoint]) return r[endpoint];
    return LABEL[endpoint] || fallback;
  }
  function group(endpoint) { var i = GROUP_OF[endpoint]; return GROUPS[i == null ? 7 : i]; }

  g.RaGuide = { LABEL: LABEL, ROLE_LABEL: ROLE_LABEL, HELP: HELP, COMES_FROM: COMES_FROM, GROUPS: GROUPS, GROUP_OF: GROUP_OF,
    STATUS_WORD: STATUS_WORD, COLUMN: COLUMN, ACTION_HELP: ACTION_HELP, DONE: DONE,
    label: label, group: group, statusWord: statusWord,
    help: function (endpoint) { return HELP[endpoint] || ''; },
    comesFrom: function (endpoint) { return COMES_FROM[endpoint] || ''; },
    column: function (k) { return COLUMN[k] || ''; } };
})(typeof window !== 'undefined' ? window : this);

/* RAW AROMA — Factory console routes (web/routes.js): the one place that decides what the address
 * bar says, in plain words, and what an address opens. A pure model like web/dock.js — no DOM, no
 * network — so backend/api/src/__tests__/console-routes.test.ts runs it in a `vm` as the page does.
 *
 *   #/<workspace>/<screen>[/<record>]
 *   #/production/production-orders                 a screen
 *   #/qc/batch-certificates/FG-2026-0012           one record on it, by its own code (batch number,
 *                                                   PO number, SKU …); a record with no code keeps its id
 *
 * Workspace = the role's workspace (owner, production, qc …). Screen = a stable slug per data source
 * (never the label, which may be reworded). Older addresses keep working and are rewritten to these:
 *   #/go/<key>[|<key>…][/<record>]    Ruh notes and ALEMBIC links (stored in the database)
 *   #/<key>                           a bare section key
 *   #assertion=…                      the ALEMBIC sign-in hand-off (not a route; the shell consumes it)
 */
(function (g) {
  'use strict';

  /** Role key (as ROLES names it) → the workspace word in the address. */
  var WORKSPACE = {
    superadmin: 'owner', admin: 'admin', procurement: 'procurement', receiving: 'receiving', qc: 'qc',
    production: 'production', warehouse: 'warehouse', compounding: 'compounding', filling: 'filling',
    packaging: 'packaging', sales: 'sales'
  };

  /** Data source (endpoint or a workspace view's sentinel) → screen slug, where the endpoint's own
   *  name is not plain enough. Everything else is the endpoint without /v1/ (production-orders …). */
  var SLUG = {
    __dash__: 'home', __tutorial__: 'tutorials', __produce__: 'produce-next', __shelftasks__: 'put-away-and-pick',
    __racklayout__: 'rack-layout', __shelfdisplay__: 'shelf-display', __factorysetup__: 'factory-setup', __formulasetup__: 'formula-setup',
    '/v1/bridge/requirements': 'alembic-orders', '/v1/formula-event-hist': 'formula-history', '/v1/audit-events': 'change-history',
    '/v1/uoms': 'units', '/v1/rm-aliases': 'material-code-names', '/v1/batch-container-mappings': 'batch-containers',
    '/v1/geo-region-types': 'region-levels', '/v1/fg-stock': 'finished-stock', '/v1/fg-reservations': 'reserved-finished-stock',
    '/v1/fg-labels': 'product-labels', '/v1/grns': 'goods-receipts', '/v1/grn-items': 'received-quantities', '/v1/grn-containers': 'containers',
    '/v1/rm-batches': 'raw-material-batches', '/v1/rfqs': 'quote-requests', '/v1/quotations': 'supplier-quotes', '/v1/quotation-items': 'quote-lines',
    '/v1/vendor-negotiations': 'negotiations', '/v1/qc-capas': 'corrective-actions', '/v1/batch-coas': 'batch-certificates',
    '/v1/product-qc-specs': 'product-test-specs', '/v1/po-advance-payments': 'advance-payments', '/v1/vendor-credit-notes': 'supplier-credit-notes',
    '/v1/qc-rejected-grns': 'rejected-receipts', '/v1/vendors': 'suppliers', '/v1/vendor-contacts': 'supplier-contacts',
    '/v1/vendor-rm-mappings': 'supplier-materials', '/v1/vendor-rate-history': 'supplier-rates', '/v1/vendor-performance': 'supplier-performance',
    '/v1/vendor-ledger': 'supplier-ledger', '/v1/vendor-dispatches': 'supplier-shipments', '/v1/inventory-availability': 'stock',
    '/v1/inventory-transactions': 'stock-movements', '/v1/stock-audits': 'stock-counts', '/v1/material-pick-lists': 'pick-lists',
    '/v1/material-pick-list-items': 'pick-list-lines', '/v1/production-order-ingredients': 'order-ingredients',
    '/v1/production-plan-items': 'plan-lines', '/v1/weighing-records': 'weighing', '/v1/filling-sessions': 'fill-tickets',
    '/v1/package-orders': 'packing-orders', '/v1/finished-good-batches': 'finished-batches', '/v1/packaging-boms': 'packaging-materials',
    '/v1/product-skus': 'pack-sizes', '/v1/qc-result-details': 'test-results', '/v1/qc-sample-retentions': 'retained-samples',
    '/v1/material-qc-specifications': 'material-test-specs', '/v1/material-storage-rules': 'storage-rules',
    '/v1/document-registry': 'documents', '/v1/reorder-suggestions': 'reorder-plan', '/v1/stock-requirements': 'stock-planning',
    '/v1/approval-matrix': 'approval-rules', '/v1/qc-inspections': 'test-queue', '/v1/production-qc': 'production-qc',
    '/v1/stock-adjustments': 'stock-adjustments', '/v1/stock-reservations': 'stock-reservations'
  };

  /** A record's own code, in this order — what a person reads on the row and on the label. */
  var REF_FIELDS = ['batchNumber', 'poNumber', 'prNumber', 'grnNumber', 'soNumber', 'rfqNumber', 'quotationNumber', 'gateEntryNumber',
    'documentNumber', 'orderRef', 'sampleCode', 'containerCode', 'skuCode', 'materialCode', 'productCode', 'vendorCode', 'customerCode',
    'transporterCode', 'binCode', 'shelfCode', 'rackCode', 'zoneCode', 'floorCode', 'warehouseCode', 'locationCode', 'parameterCode',
    'roleCode', 'permissionCode', 'employeeCode', 'uomCode', 'countryCode', 'businessUnitCode', 'groupCode', 'subCategoryCode',
    'categoryCode', 'typeCode', 'organizationCode', 'email'];
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function slugOf(endpoint) {
    var e = String(endpoint || '');
    if (SLUG[e]) return SLUG[e];
    return e.replace(/^\/v1\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'home';
  }
  function roleOfWorkspace(ws) {
    for (var r in WORKSPACE) if (WORKSPACE[r] === ws) return r;
    return WORKSPACE[ws] ? ws : null; // a role key typed by hand (superadmin) still resolves
  }
  /** The code a person would use for this row, else its id. */
  function refOf(row) {
    if (!row) return '';
    for (var i = 0; i < REF_FIELDS.length; i++) { var v = row[REF_FIELDS[i]]; if (v != null && String(v).trim() !== '' && !UUID.test(String(v))) return String(v).trim(); }
    for (var k in row) { if (/Id$/.test(k) && UUID.test(String(row[k]))) return String(row[k]); }
    return '';
  }
  /** Does `row` answer to `ref` (its own code, or its id)? */
  function rowMatches(row, ref) {
    if (!row || !ref) return false;
    var want = String(ref).toLowerCase();
    for (var i = 0; i < REF_FIELDS.length; i++) { var v = row[REF_FIELDS[i]]; if (v != null && String(v).toLowerCase() === want) return true; }
    for (var k in row) {
      if (!/Id$/.test(k)) continue;
      var id = String(row[k] || '').toLowerCase();
      if (id && id === want) return true;
    }
    return false;
  }
  function enc(s) { return encodeURIComponent(String(s)); }
  /** '#/<workspace>/<screen>[/<record>]' for a role key + nav tuple ([key, label, icon, endpoint]). */
  function build(role, nav, ref) {
    var ws = WORKSPACE[role] || role;
    return '#/' + ws + '/' + slugOf(nav[3]) + (ref ? '/' + enc(ref) : '');
  }
  function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /** Read an address. Returns {kind:'route', workspace, screen, ref} | {kind:'legacy', keys, ref} |
   *  {kind:'assertion'} | {kind:'none'}. */
  function parse(hash) {
    var h = String(hash || '').replace(/^#/, '');
    if (!h || h === '/') return { kind: 'none' };
    if (/(?:^|&)assertion=/.test(h)) return { kind: 'assertion' };
    // Only '#/…' is an address; '#shelf=ZONE' (the shelf TV hand-off) and the like belong to their screens.
    if (h.charAt(0) !== '/') return { kind: 'none' };
    var go = /^\/go\/([^/?#]+)(?:\/(.+))?$/.exec(h);
    if (go) return { kind: 'legacy', keys: go[1].split('|').filter(Boolean), ref: go[2] ? dec(go[2]) : '' };
    var parts = h.replace(/^\//, '').split('/');
    if (parts.length === 1 && parts[0]) return { kind: 'legacy', keys: [dec(parts[0])], ref: '' };
    if (parts.length >= 2 && parts[0] && parts[1]) return { kind: 'route', workspace: dec(parts[0]).toLowerCase(), screen: dec(parts[1]).toLowerCase(), ref: parts.length > 2 ? dec(parts.slice(2).join('/')) : '' };
    return { kind: 'none' };
  }

  function navOf(roles, role) { return (roles[role] && roles[role].nav) || []; }
  /** The nav tuple on `role` that a screen word names: its slug, or its section key. */
  function findScreen(roles, role, screen) {
    var nav = navOf(roles, role), s = String(screen || '').toLowerCase();
    for (var i = 0; i < nav.length; i++) if (slugOf(nav[i][3]) === s) return nav[i];
    for (var j = 0; j < nav.length; j++) if (String(nav[j][0]).toLowerCase() === s) return nav[j];
    return null;
  }

  /** Where an address should take this person: {role, key, ref, canonical, moved} or null when no
   *  workspace they hold has that screen. `held` = the workspaces (role keys) the session holds,
   *  `current` = the open one. A screen named for a workspace they do not hold opens in one they do
   *  (moved: true), so a colleague's link still lands. */
  function resolve(parsed, roles, held, current) {
    held = (held || []).filter(function (r) { return roles[r]; });
    if (!parsed || !held.length) return null;
    function out(role, nav, ref, moved) { return { role: role, key: nav[0], ref: ref || '', canonical: build(role, nav, ref), moved: !!moved }; }
    var order = [current].concat(held).filter(function (r, i, a) { return r && roles[r] && held.indexOf(r) >= 0 && a.indexOf(r) === i; });
    if (parsed.kind === 'route') {
      var want = roleOfWorkspace(parsed.workspace);
      if (want && held.indexOf(want) >= 0) { var n0 = findScreen(roles, want, parsed.screen); if (n0) return out(want, n0, parsed.ref, false); }
      for (var i = 0; i < order.length; i++) { var n1 = findScreen(roles, order[i], parsed.screen); if (n1) return out(order[i], n1, parsed.ref, true); }
      return null;
    }
    if (parsed.kind === 'legacy') {
      for (var k = 0; k < parsed.keys.length; k++) {
        for (var j = 0; j < order.length; j++) { var n2 = findScreen(roles, order[j], parsed.keys[k]); if (n2) return out(order[j], n2, parsed.ref, j > 0); }
      }
      return null;
    }
    return null;
  }

  g.RaRoutes = { WORKSPACE: WORKSPACE, SLUG: SLUG, REF_FIELDS: REF_FIELDS, slugOf: slugOf, refOf: refOf, rowMatches: rowMatches,
    build: build, parse: parse, resolve: resolve, findScreen: findScreen, roleOfWorkspace: roleOfWorkspace };
})(typeof window !== 'undefined' ? window : this);

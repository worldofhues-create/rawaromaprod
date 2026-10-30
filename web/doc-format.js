/* RAW AROMA — doc-format (web/doc-format.js): the house print layout for a Factory Documents record
 * (CRM point 32, "Standard Format" = the house IFRA, COA, Allergen and MSDS documents). A pure model
 * like routes.js: no DOM, no network, so backend/api/src/__tests__/doc-format.test.ts runs it in a vm.
 *
 * A registry record says a document exists and when it expires. It holds no limits, results or
 * hazard data, and this console does not read the Vault. So a layout's value fields print
 * "Not on file", and the house documents' conformity wording is NOT reproduced: a statement that a
 * material complies, or is not hazardous, is a regulatory fact, and absence of data must not read as
 * reassurance.
 * IFRA does not certify products: a house declares conformity, hence the title.
 */
(function (g) {
  'use strict';
  var NOF = 'Not on file';
  /** The letterhead, from the house documents. Phone by owner decision (the greeting text); the two
   *  numbers on the MSDS conflict. Address comes only from the company record, never from here. */
  var HOUSE = { name: 'Raw Aromachem', phone: '+91 86299 12883', email: 'rawaromachem@gmail.com', web: 'www.rawaromachem.com' };

  /** documentType → layout. Anything else keeps the plain record under the letterhead. */
  var KIND = {
    'IFRA Certificate': 'ifra', 'IFRA Conformity Certificate': 'ifra', 'COA': 'coa',
    'Allergen Declaration': 'allergen', 'MSDS': 'msds'
  };
  var TITLE = {
    ifra: 'IFRA Statement of Conformity', coa: 'CERTIFICATE OF ANALYSIS',
    allergen: 'Allergen Analysis', msds: 'Material Safety Data Sheet', other: 'DOCUMENT RECORD'
  };
  /** The fields each house document carries that a registry record does not. */
  var ABSENT = {
    ifra: ['Category limits', 'Statement of conformity'],
    coa: ['Order number', 'Batch No', 'Supplied quantity', 'Odour description', 'Colour and appearance', 'Measurements and specification', 'Production date', 'Best before'],
    allergen: ['Allergen concentrations'],
    msds: ['Molecular formula', 'Molecular weight', 'CAS No.', 'Composition', 'Hazard identification', 'First aid, fire, handling and disposal data']
  };

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function held(v) { return v != null && String(v).trim() !== ''; }
  function val(v) { return held(v) ? esc(v) : NOF; }
  function kindOf(row) { return KIND[row && row.documentType] || 'other'; }

  /** The active COMPANY's address from the organizations list, else null: no record, no address. */
  function companyAddress(orgs) {
    var list = (orgs || []).filter(function (o) { return o && o.type === 'COMPANY' && (!o.status || o.status === 'ACTIVE'); });
    if (list.length !== 1) return null; // two companies: which letterhead is not ours to guess
    var o = list[0], parts = [o.address, o.addressLine1, o.addressLine2, o.city, o.state, o.pincode || o.pinCode].filter(held);
    return parts.length ? parts.join(', ') : null;
  }
  function kv(label, value) { return '<tr><td class="k">' + esc(label) + '</td><td class="v">' + val(value) + '</td></tr>'; }

  /** The whole print page for a registry row. `address` is companyAddress()'s answer. */
  function render(row, address) {
    row = row || {};
    var kind = kindOf(row), title = TITLE[kind];
    var head = [HOUSE.phone].concat(held(address) ? [address] : []).concat([HOUSE.email, HOUSE.web]).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    var centred = kind === 'ifra' || kind === 'allergen' || kind === 'msds';
    var letter = kind === 'ifra'
      ? '<h1 class="c">' + title + '</h1><div class="lh c"><div>' + HOUSE.name + '</div>' + head + '</div>'
      : '<div class="lh r"><div>' + HOUSE.name + '</div>' + head + '</div><h1' + (centred ? ' class="c"' : '') + '>' + title + '</h1>';
    var product = val(row.title);
    var record = kv('Reference no.', row.referenceNo) + kv('Relates to', row.entityType) + kv('Version', row.version) +
      kv(kind === 'ifra' ? 'Date prepared' : 'Issue date', row.issueDate) + kv('Expires', row.expiryDate) +
      kv('Status', row.status) + kv('Document link', row.sourceUrl) + kv('Notes', row.notes);
    var body = kind === 'other'
      ? '<table>' + kv('Title', row.title) + kv('Document type', row.documentType) + record + '</table>'
      : '<h2' + (centred ? ' class="c"' : '') + '>' + product + '</h2><table>' + record +
        ABSENT[kind].map(function (l) { return kv(l, null); }).join('') + '</table>';
    var foot = kind === 'ifra' ? '<p class="foot">' + HOUSE.name + ', Regulatory Affairs</p>' : '';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#141413;padding:40px;max-width:720px;margin:auto;font-size:13px}' +
      '.c{text-align:center}.r{text-align:right}.lh{font-size:12px;line-height:1.5;margin-bottom:18px}' +
      'h1{font-size:20px;margin:0 0 8px;font-weight:600}h2{font-size:16px;margin:4px 0 14px;font-weight:600}' +
      'table{width:100%;border-collapse:collapse}td{padding:7px 10px;border:1px solid #D6D6D2}.k{width:42%;font-weight:600}' +
      '.foot{margin-top:24px}@media print{.noprint{display:none}}</style></head><body>' + letter + body + foot +
      '<div class="noprint" style="margin-top:30px;text-align:center"><button onclick="window.print()" style="padding:10px 26px;background:#E9F260;color:#141413;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-size:14px">Print</button></div>' +
      '</body></html>';
  }
  g.RaDocFormat = { NOT_ON_FILE: NOF, HOUSE: HOUSE, TITLE: TITLE, kindOf: kindOf, companyAddress: companyAddress, render: render };
})(typeof window !== 'undefined' ? window : this);

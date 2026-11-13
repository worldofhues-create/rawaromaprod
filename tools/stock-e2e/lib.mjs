/* STOCK-E2E-1 rehearsal helpers. NO DATA IN THIS FILE: the formula sheet is read at run time from
 * the path given, and nothing read from it is ever written to stdout except counts and row numbers. */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/* ── the sheet ──────────────────────────────────────────────────────────────────────────── */

/** A one-sheet .xlsx read with the Python standard library only (no new dependency). */
const PY = String.raw`
import sys, json, zipfile, re
import xml.etree.ElementTree as ET
M='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
z=zipfile.ZipFile(sys.argv[1]); shared=[]
if 'xl/sharedStrings.xml' in z.namelist():
    for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(M+'si'):
        shared.append(''.join(t.text or '' for t in si.iter(M+'t')))
sheets=sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n))
out=[]
for row in ET.fromstring(z.read(sheets[0])).iter(M+'row'):
    rec={'r':int(row.get('r'))}
    for c in row.findall(M+'c'):
        col=re.match(r'[A-Z]+', c.get('r')).group(0).lower(); t=c.get('t'); v=c.find(M+'v'); f=c.find(M+'f')
        if t=='s' and v is not None: val=shared[int(v.text)]
        elif t=='inlineStr': val=''.join(x.text or '' for x in c.iter(M+'t'))
        else: val=v.text if v is not None else None
        rec[col]=val
        if f is not None: rec[col+'_f']=f.text
    out.append(rec)
json.dump({'sheets':len(sheets),'rows':out}, sys.stdout)
`;

export function readSheet(path) {
  if (!existsSync(path)) throw new Error('no such file: give the path to the formula sheet');
  return JSON.parse(execFileSync('python3', ['-I', '-c', PY, path], { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

const DEC = /^\d+(\.\d+)?$/;
/** grams text -> integer milligrams, exactly (the sheet holds at most 3 decimals of a gram). */
export function gToMg(t) {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(t).trim());
  if (!m) throw new Error(`not grams to the mg: row value with ${String(t).split('.')[1]?.length ?? 0} decimals`);
  return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
}
export const normName = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

/** Formulas: a header row has B = "gram"; a total row's A is exactly "total"; blank rows are skipped. */
export function formulasOf(sheet) {
  const out = [];
  let cur = null;
  const notes = { blankInsideBlock: [], totalRows: [], colC: { rows: 0, formula: 0, tenTimesB: 0, other: 0 } };
  for (const r of sheet.rows) {
    const a = r.a == null ? '' : String(r.a);
    const b = r.b == null ? '' : String(r.b).trim();
    if (b.toLowerCase() === 'gram') { cur = { id: `F${out.length + 1}`, headRow: r.r, lines: [], totalRows: [] }; out.push(cur); continue; }
    if (!cur) continue;
    if (!a.trim() && !b) { notes.blankInsideBlock.push(r.r); continue; }
    if (/^\s*total\s*(\([^)]*\))?\s*$/i.test(a)) { cur.totalRows.push({ row: r.r, b, c: r.c ?? null }); continue; }
    if (!DEC.test(b)) throw new Error(`row ${r.r}: column B is not a number of grams`);
    const c = r.c == null ? null : String(r.c);
    if (c !== null) {
      notes.colC.rows++;
      if (r.c_f) notes.colC.formula++;
      if (gToMg(b) * 10 === Math.round(Number(c) * 1000)) notes.colC.tenTimesB++; else notes.colC.other++;
    }
    cur.lines.push({ row: r.r, name: a, mg: gToMg(b) });
  }
  for (const f of out) f.totalMg = f.lines.reduce((s, l) => s + l.mg, 0);
  return { formulas: out, notes };
}

/* ── the APIs ───────────────────────────────────────────────────────────────────────────── */

export const EMAIL = {
  owner: 'owner@rawaroma.local', admin: 'admin@rawaroma.local', procurement: 'procurement@rawaroma.local',
  receiving: 'receiving@rawaroma.local', qc: 'qc@rawaroma.local', warehouse: 'warehouse@rawaroma.local',
  compounding: 'compounding@rawaroma.local', production: 'production@rawaroma.local', filling: 'filling@rawaroma.local',
  packaging: 'packaging@rawaroma.local', sales: 'sales@rawaroma.local', formulator: 'formulator@rawaroma.local',
  vault_approver: 'vault.approver@rawaroma.local', picker: 'picker@rawaroma.local', verifier: 'verifier@rawaroma.local',
  mixer: 'mixer@rawaroma.local', packing: 'packing@rawaroma.local', logistics: 'logistics@rawaroma.local', finance: 'finance@rawaroma.local',
};
const b64u = (v) => Buffer.from(v).toString('base64url');
function subjectOf(email) {
  const h = createHash('sha256').update(email).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function client({ api, vault, keysFile }) {
  const { signingKey } = JSON.parse(readFileSync(keysFile, 'utf8'));
  const key = createPrivateKey({ key: Buffer.from(signingKey, 'base64'), format: 'der', type: 'pkcs8' });
  const mint = (email, target) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'alembic', aud: 'rawprod', sub: subjectOf(email), tenant_id: process.env.ASSERT_TENANT ?? 'rac', org_id: process.env.ASSERT_TENANT ?? 'rac', email, roles: ['admin'],
      target, auth_time: now, iat: now, exp: now + 45, jti: randomUUID(), env: 'production' };
    const input = `${b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${b64u(sign(null, Buffer.from(input), key))}`;
  };
  const tokens = new Map();
  async function tokenFor(role, target) {
    const k = `${role}|${target}`; const hit = tokens.get(k);
    if (hit && Date.now() - hit.at < 200_000) return hit.token;
    const res = await fetch(`${api}/auth/alembic-assertion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assertion: mint(EMAIL[role], target) }) });
    const j = await res.json();
    if (!j?.data?.accessToken) throw new Error(`sign-in for ${role} failed: ${res.status} ${JSON.stringify(j?.error)}`);
    tokens.set(k, { token: j.data.accessToken, at: Date.now() });
    return j.data.accessToken;
  }
  async function rp(role, method, path, body, opts = {}) {
    const res = await fetch(`${opts.vault ? vault : api}${path}`, { method,
      headers: { authorization: `Bearer ${await tokenFor(role, opts.vault ? 'vault' : 'factory')}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let j = {}; try { j = JSON.parse(text); } catch { j = { data: text }; }
    return { status: res.status, body: j.data, error: j.error, meta: j.meta };
  }
  async function must(role, method, path, body, opts) {
    const r = await rp(role, method, path, body, opts);
    if (r.status >= 300) throw new Error(`${role} ${method} ${path} -> ${r.status} ${JSON.stringify(r.error)}`);
    return r.body;
  }
  /** Every page of a list route. */
  async function all(role, path, opts) {
    const out = []; let cursor = null;
    for (let i = 0; i < 200; i++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await rp(role, 'GET', `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, opts);
      if (r.status >= 300) throw new Error(`${role} GET ${path} -> ${r.status} ${JSON.stringify(r.error)}`);
      out.push(...(Array.isArray(r.body) ? r.body : r.body?.items ?? []));
      cursor = r.meta?.cursor?.next ?? r.meta?.cursor ?? r.body?.nextCursor ?? null;
      if (!cursor || typeof cursor !== 'string') break;
    }
    return out;
  }
  return { rp, must, all, tokens };
}

export async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function stateFile(path) {
  const load = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  return { load, save: (s) => writeFileSync(path, JSON.stringify(s, null, 1), { mode: 0o600 }) };
}

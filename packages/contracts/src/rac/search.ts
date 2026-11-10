/* RAC-CODES-2: ONE normaliser and ONE ranking for every RAC catalogue search.
 *
 * Used by the storefront, every console (admin, agent, Sales Desk) through the
 * API, and by RawProd's search through the same rules ported verbatim. Two
 * surfaces that rank differently is how a customer finds a product the agent
 * on the phone cannot.
 *
 * WHAT MATCHES (RAC_CODE_RULES.md "Search"): product name, reference
 * fragrance, each accord, category and shop label, the full code in any
 * spacing (`RAC 27 / 1150`, `RAC271150`), the bare number (`1150`), grade word,
 * percentage or letter, old grade words (`identical` -> ALIKE), the old RAC
 * code in either form (`RAC / 40 · 01437`, `RAC40-01437`), old RAC SKUs, the
 * Shopify SKU and the Shopify handle.
 *
 * CODES ARE EXACT AND RANK FIRST. A code-shaped query is normalised (spaces,
 * slashes, dots, middle dots, hyphens removed; upper-cased) and looked up by
 * equality. Text is matched by token: exact, then prefix, then a bounded edit
 * distance (typo tolerance) -- never fuzzy on codes, where a one-character
 * difference is a different product.
 *
 * WHAT THE STOREFRONT DOES NOT SEE. Drafts are excluded. A reference fragrance
 * matches only where the caller says it is visible (the clearance gate, by
 * product and market): a customer must not get a result whose only reason is
 * a trademark the page will not show. Legacy keys still MATCH there -- old
 * links and old order slips must keep working -- but are never returned for
 * display; that is the caller's rendering rule, see line.ts.
 *
 * Pure and deterministic: equal scores break on live-before-draft, then code.
 */
import { RAC_GRADES, normaliseCode, type RacGrade } from "./code.ts";

export interface RacSearchVariant {
  readonly code: string;
  readonly pack?: string | null;
  readonly grade: string;
  readonly old_grade?: string | null;
  readonly shopify_sku?: string | null;
  readonly old_rac_sku?: string | null;
  readonly default?: boolean;
}

export interface RacSearchProduct {
  readonly code: string;
  readonly family_code?: string;
  readonly category: string;
  readonly shop_label?: string | null;
  readonly name: string;
  readonly reference_fragrance?: string | null;
  readonly accords?: readonly string[];
  readonly accords_unverified?: readonly string[];
  readonly family?: string | null;
  readonly grades?: readonly string[];
  readonly old_rac_code?: string | null;
  readonly old_primary?: string | null;
  readonly shopify_handle?: string | null;
  readonly draft?: boolean;
  readonly variants?: readonly RacSearchVariant[];
}

export type RacSearchScope = "storefront" | "console";

export interface RacIndexOptions {
  readonly scope: RacSearchScope;
  /* Storefront only: is this product's reference fragrance cleared for the
     market being served? Absent means "not cleared" -- fail closed. */
  readonly referenceVisible?: (code: string) => boolean;
}

export interface RacSearchHit {
  readonly code: string;
  readonly score: number;
  readonly draft: boolean;
  /* The grade the query asked for, in NEW words, when it asked for one. */
  readonly grade?: RacGrade;
  /* The variant an exact variant-level key (variant code, Shopify SKU, old RAC SKU) named. */
  readonly variant?: string;
  readonly matched: readonly string[];
}

/* Lower-case, diacritics off, everything that is not a letter or digit is a
   word break. `Frédéric Malle` -> `frederic malle`. */
export function normaliseText(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

const tokens = (s: unknown): string[] => normaliseText(s).split(" ").filter(Boolean);

/* Every name starts "RAC ", so the word carries no information. */
const STOP = new Set(["rac", "the", "of", "and", "for", "by"]);

/* Grade aliases, in both directions, from the one grade table. */
const GRADE_ALIAS = new Map<string, RacGrade>();
for (const g of RAC_GRADES) {
  if (g.grade === "MATERIAL") { GRADE_ALIAS.set("material", "MATERIAL"); continue; }
  GRADE_ALIAS.set(g.grade.toLowerCase(), g.grade);
  GRADE_ALIAS.set(String(g.pct), g.grade);
  for (const o of g.old) GRADE_ALIAS.set(o.toLowerCase(), g.grade);
}
const GRADE_LETTER = new Map(RAC_GRADES.map((g) => [g.letter.toLowerCase(), g.grade] as const));

/* Weights. Codes outrank any text; within text, the name outranks the
   reference, which outranks facets. */
const W = {
  code: 1000, ffnumber: 950, variant: 950, oldCode: 900, oldSku: 880, shopifySku: 870, handle: 860, number: 700,
  name: 10, reference: 8, accord: 6, accordUnverified: 5, category: 9, family: 5, grade: 4, oldGrade: 4, handleWord: 2,
} as const;

interface Posting { readonly doc: number; readonly w: number; readonly field: string; readonly grade?: RacGrade | undefined; readonly variant?: string | undefined }

export interface RacSearchIndex {
  readonly scope: RacSearchScope;
  readonly docs: readonly RacSearchProduct[];
  readonly codes: ReadonlyMap<string, readonly Posting[]>;
  readonly vocab: ReadonlyMap<string, readonly Posting[]>;
  readonly vocabByLen: ReadonlyMap<number, readonly string[]>;
}

function push<K>(m: Map<K, Posting[]>, k: K, p: Posting): void {
  const a = m.get(k);
  if (!a) { m.set(k, [p]); return; }
  /* One posting per doc+field+grade is enough; keep the heavier. */
  const i = a.findIndex((x) => x.doc === p.doc && x.field === p.field && x.grade === p.grade && x.variant === p.variant);
  if (i < 0) a.push(p); else if (a[i]!.w < p.w) a[i] = p;
}

export function buildRacSearchIndex(products: readonly RacSearchProduct[], opts: RacIndexOptions): RacSearchIndex {
  const docs = opts.scope === "storefront" ? products.filter((p) => !p.draft) : products.slice();
  const codes = new Map<string, Posting[]>();
  const vocab = new Map<string, Posting[]>();
  const word = (doc: number, text: unknown, w: number, field: string, grade?: RacGrade): void => {
    for (const t of tokens(text)) if (!STOP.has(t)) push(vocab, t, { doc, w, field, grade });
  };
  const code = (doc: number, key: unknown, w: number, field: string, grade?: RacGrade, variant?: string): void => {
    const k = normaliseCode(key);
    if (k) push(codes, k, { doc, w, field, grade, variant });
  };

  docs.forEach((p, doc) => {
    const m = /^RAC (\d{2}) \/ (\d{4})$/.exec(p.code);
    code(doc, p.code, W.code, "code");
    if (m) { code(doc, m[1]! + m[2]!, W.ffnumber, "code"); code(doc, m[2]!, W.number, "number"); }
    code(doc, p.old_primary, W.oldCode, "old_code");
    code(doc, p.old_rac_code, W.oldCode, "old_code");
    code(doc, p.shopify_handle, W.handle, "handle");
    for (const v of p.variants ?? []) {
      const g = GRADE_ALIAS.get(String(v.grade).toLowerCase()) ?? (v.grade === "MATERIAL" ? "MATERIAL" : undefined);
      code(doc, v.code, W.variant, "variant", g, v.code);
      code(doc, v.old_rac_sku, W.oldSku, "old_sku", g, v.code);
      code(doc, v.shopify_sku, W.shopifySku, "shopify_sku", g, v.code);
    }

    word(doc, p.name, W.name, "name");
    const refShown = opts.scope === "console" || (opts.referenceVisible?.(p.code) ?? false);
    if (refShown && p.reference_fragrance) word(doc, p.reference_fragrance, W.reference, "reference");
    for (const a of p.accords ?? []) word(doc, a, W.accord, "accord");
    for (const a of p.accords_unverified ?? []) word(doc, a, W.accordUnverified, "accord");
    word(doc, p.category, W.category, "category");
    if (p.shop_label) word(doc, p.shop_label, W.category, "category");
    if (p.family) word(doc, p.family, W.family, "family");
    /* Handle WORDS only in consoles: `creed-aventus` would otherwise let a
       storefront search for the uncleared trademark through the back door.
       The exact handle still matches everywhere (old links), above. */
    if (opts.scope === "console") word(doc, p.shopify_handle, W.handleWord, "handle");
    const grades = new Set<string>(p.grades?.length ? p.grades : (p.variants ?? []).map((v) => v.grade));
    for (const g of RAC_GRADES) {
      if (!grades.has(g.grade)) continue;
      if (g.grade === "MATERIAL") { push(vocab, "material", { doc, w: W.grade, field: "grade", grade: "MATERIAL" }); continue; }
      push(vocab, g.grade.toLowerCase(), { doc, w: W.grade, field: "grade", grade: g.grade });
      push(vocab, String(g.pct), { doc, w: W.grade, field: "grade", grade: g.grade });
      for (const o of g.old) push(vocab, o.toLowerCase(), { doc, w: W.oldGrade, field: "old_grade", grade: g.grade });
    }
  });

  const vocabByLen = new Map<number, string[]>();
  for (const t of vocab.keys()) {
    const a = vocabByLen.get(t.length);
    if (a) a.push(t); else vocabByLen.set(t.length, [t]);
  }
  return { scope: opts.scope, docs, codes, vocab, vocabByLen };
}

/* Optimal string alignment distance, abandoned past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n]!;
}

/* How far a query word may be from an indexed word and still count as a typo. */
const allowedEdits = (len: number): number => (len < 4 ? 0 : len <= 7 ? 1 : 2);

interface Acc { score: number; tokens: Set<number>; matched: Set<string>; grade?: RacGrade; variant?: string; codeHit: number; gradeWordInText?: boolean }

export interface RacSearchOptions { readonly limit?: number }

export function searchRac(index: RacSearchIndex, query: string, opts: RacSearchOptions = {}): RacSearchHit[] {
  const limit = opts.limit ?? 50;
  const acc = new Map<number, Acc>();
  const get = (doc: number): Acc => {
    let a = acc.get(doc);
    if (!a) { a = { score: 0, tokens: new Set(), matched: new Set(), codeHit: 0 }; acc.set(doc, a); }
    return a;
  };

  /* 1. The whole query as a code. */
  const qc = normaliseCode(query);
  const codeHits = qc ? index.codes.get(qc) : undefined;
  for (const p of codeHits ?? []) {
    const a = get(p.doc);
    if (p.w > a.codeHit) { a.codeHit = p.w; a.matched.add(p.field); if (p.grade) a.grade = p.grade; if (p.variant) a.variant = p.variant; }
  }

  /* 2. Word by word. */
  const qt = tokens(query).filter((t) => !STOP.has(t));
  const askedGrade = qt.map((t) => GRADE_ALIAS.get(t)).find(Boolean)
    ?? (qt.length === 1 && GRADE_LETTER.has(qt[0]!) ? GRADE_LETTER.get(qt[0]!) : undefined);
  if (qt.length === 1 && GRADE_LETTER.has(qt[0]!) && !GRADE_ALIAS.has(qt[0]!)) {
    /* OQ-RAC-7: a single letter is a grade only when it is the whole query. */
    const g = GRADE_LETTER.get(qt[0]!)!;
    for (const p of index.vocab.get(g.toLowerCase()) ?? []) {
      const a = get(p.doc); a.score += p.w; a.tokens.add(0); a.matched.add("grade"); a.grade = g;
    }
  }

  qt.forEach((t, ti) => {
    const best = new Map<number, Posting & { s: number }>();
    const consider = (list: readonly Posting[] | undefined, factor: number): void => {
      for (const p of list ?? []) {
        const s = p.w * factor;
        const b = best.get(p.doc);
        if (!b || s > b.s) best.set(p.doc, { ...p, s });
      }
    };
    consider(index.vocab.get(t), 1);
    if (t.length >= 3 && !/^\d+$/.test(t)) {
      for (const [v, list] of index.vocab) if (v !== t && v.startsWith(t)) consider(list, 0.75);
    }
    const k = /^\d+$/.test(t) ? 0 : allowedEdits(t.length);
    if (k > 0) {
      for (let len = t.length - k; len <= t.length + k; len++) {
        for (const v of index.vocabByLen.get(len) ?? []) {
          if (v === t || v.startsWith(t)) continue;
          const d = editDistance(t, v, k);
          if (d <= k) consider(index.vocab.get(v), d === 1 ? 0.5 : 0.35);
        }
      }
    }
    for (const [doc, p] of best) {
      const a = get(doc);
      a.score += p.s; a.tokens.add(ti); a.matched.add(p.field);
      if (p.grade && GRADE_ALIAS.get(t) === p.grade) a.grade = p.grade;
      /* "klone" in a kit's NAME is a name match, not a grade request. */
      if (GRADE_ALIAS.has(t) && p.field !== "grade" && p.field !== "old_grade") a.gradeWordInText = true;
    }
  });

  /* 3. Phrase: the whole normalised query inside the name or reference. */
  const phrase = qt.join(" ");
  const out: RacSearchHit[] = [];
  for (const [doc, a] of acc) {
    const p = index.docs[doc]!;
    /* A grade asked for is a filter: "aventus identical" is not a request for
       an Aventus that has no ALIKE. */
    if (askedGrade && !a.codeHit && !a.gradeWordInText) {
      const has = (p.grades?.length ? p.grades : (p.variants ?? []).map((v) => v.grade)).includes(askedGrade);
      if (!has) continue;
      a.grade = askedGrade;
    }
    let score = a.score;
    if (qt.length) {
      const coverage = a.tokens.size / qt.length;
      score *= coverage * coverage;
      if (a.tokens.size === qt.length && qt.length > 1) score += 5;
      const nameT = tokens(p.name).filter((t) => !STOP.has(t));
      const nameStr = nameT.join(" ");
      const refStr = a.matched.has("reference") ? normaliseText(p.reference_fragrance) : "";
      if (phrase.length > 2) {
        /* Exact name or exact reference outranks "contains". */
        if (nameStr === phrase) score += 20;
        else if (refStr === phrase) score += 18;
        else if (qt.length > 1 && nameStr.includes(phrase)) score += 12;
        else if (qt.length > 1 && refStr.includes(phrase)) score += 10;
        /* The query IS a category or shop label: "bond", "solvent". */
        if ([p.category, p.shop_label].some((c) => c && normaliseText(c) === phrase)) score += 12;
      }
      /* How much of the NAME the query accounts for: "aventus identical"
         prefers RAC Aventus to RAC Aventus Absolu. */
      if (nameT.length && a.matched.has("name")) {
        const hit = nameT.filter((n) => qt.some((q) => n === q || (q.length >= 3 && n.startsWith(q)) || (allowedEdits(q.length) > 0 && editDistance(q, n, allowedEdits(q.length)) <= allowedEdits(q.length)))).length;
        score += 4 * (hit / nameT.length);
      }
    }
    score += a.codeHit;
    if (score <= 0) continue;
    out.push({
      code: p.code, score: Math.round(score * 100) / 100, draft: !!p.draft,
      ...(a.grade ? { grade: a.grade } : {}), ...(a.variant ? { variant: a.variant } : {}),
      matched: [...a.matched].sort(),
    });
  }
  out.sort((x, y) => y.score - x.score || Number(x.draft) - Number(y.draft) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
  return out.slice(0, limit);
}

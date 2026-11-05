/**
 * PROD-A-1 — the rules engine behind the admin Rules screen (production-floor plan §12.0).
 *
 * One evaluator for every policy (`receiving.shortfall`, `floor.queue`, `procurement.payment_terms`,
 * `planning.cover`, `qc.rework`): an ordered list of IF … THEN rules, ELSE IF …, OTHERWISE the
 * default. Pure: no I/O, no clock, no randomness, so the same rules and the same case always give
 * the same answer — which is what lets a decision made yesterday be re-explained today from the
 * version it recorded.
 *
 * Precedence is the SCOPE LADDER first and list order second. A rule keyed to one record (a single
 * PO) beats a vendor rule, which beats a material-family rule, which beats a general rule. Inside
 * one rung the first matching rule in the list wins (that is the "else if"). So an admin cannot
 * make a general rule silently outrank a vendor rule by dragging it to the top: the screen says
 * which rule won and why.
 *
 * Safe failure: when nothing matches and the policy has no default, `evaluateRules` returns
 * `{ resolved: false }` and the service throws `PolicyUnresolved`; the caller must HOLD and ask.
 * It never guesses.
 */

/** Most specific first. `record` = a rule written for one record (e.g. one PO). */
export const SCOPE_LADDER = ['record', 'vendor', 'material_family', 'global'] as const;
export type RuleScope = (typeof SCOPE_LADDER)[number];

export const OPS = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists'] as const;
export type ConditionOp = (typeof OPS)[number];

export interface Condition {
  /** A field of the case, e.g. `vendor`, `material_family`, `days_late`, `channel`. */
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface Rule {
  /** Stable id inside the policy (shown as "Rule 2"). */
  id: string;
  label?: string;
  scope: RuleScope;
  /** ALL must hold. An empty list matches every case (an unconditional rule on that rung). */
  when: Condition[];
  then: unknown;
}

export interface PolicyBody {
  rules: Rule[];
  /** false → OTHERWISE is "hold and ask". */
  hasDefault: boolean;
  defaultValue?: unknown;
}

export type Evaluation =
  | { resolved: true; value: unknown; ruleId: string | null; explain: string }
  | { resolved: false; explain: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function show(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function holds(c: Condition, ctx: Record<string, unknown>): boolean {
  const have = ctx[c.field];
  switch (c.op) {
    case 'exists':
      return have !== undefined && have !== null && have !== '';
    case 'eq':
      return have !== undefined && have !== null && String(have).toLowerCase() === String(c.value).toLowerCase();
    case 'neq':
      return have === undefined || have === null || String(have).toLowerCase() !== String(c.value).toLowerCase();
    case 'in':
    case 'not_in': {
      const list = Array.isArray(c.value) ? c.value.map((x) => String(x).toLowerCase()) : [];
      const inList = have !== undefined && have !== null && list.includes(String(have).toLowerCase());
      return c.op === 'in' ? inList : !inList;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // A missing or non-numeric field never satisfies a comparison: "days late > 3" is not true
      // of an order whose lateness we do not know.
      const a = typeof have === 'string' && have.trim() !== '' ? Number(have) : have;
      const b = c.value;
      if (!isNum(a) || !isNum(b)) return false;
      return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b;
    }
    default:
      return false;
  }
}

const OP_WORD: Record<ConditionOp, string> = {
  eq: '=', neq: '≠', in: 'in', not_in: 'not in', gt: '>', gte: '≥', lt: '<', lte: '≤', exists: 'is set',
};

export function describeCondition(c: Condition): string {
  return c.op === 'exists' ? `${c.field} is set` : `${c.field} ${OP_WORD[c.op]} ${show(c.value)}`;
}

export function describeRule(r: Rule, index: number): string {
  const head = `Rule ${index + 1}${r.label ? ` (${r.label})` : ''}`;
  const cond = r.when.length ? r.when.map(describeCondition).join(' AND ') : 'always';
  return `${head}: ${cond}`;
}

/** Evaluate a policy body against one case. Pure. */
export function evaluateRules(body: PolicyBody, ctx: Record<string, unknown>): Evaluation {
  const rules = body.rules ?? [];
  for (const scope of SCOPE_LADDER) {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      if (r.scope !== scope) continue;
      if (r.when.every((c) => holds(c, ctx))) {
        return { resolved: true, value: r.then, ruleId: r.id, explain: `${describeRule(r, i)} → ${show(r.then)}` };
      }
    }
  }
  if (body.hasDefault) {
    return { resolved: true, value: body.defaultValue ?? null, ruleId: null, explain: `No rule matched → otherwise ${show(body.defaultValue ?? null)}` };
  }
  return { resolved: false, explain: 'No rule matched and there is no default: hold and ask' };
}

/** Reasons a body cannot be published (empty = valid). The screen shows these verbatim. */
export function validateBody(body: unknown): string[] {
  const out: string[] = [];
  const b = body as Partial<PolicyBody> | null;
  if (!b || typeof b !== 'object') return ['The policy is empty.'];
  if (!Array.isArray(b.rules)) return ['Rules must be a list.'];
  if (typeof b.hasDefault !== 'boolean') out.push('Say whether there is an "otherwise" value.');
  if (b.hasDefault && b.defaultValue === undefined) out.push('The "otherwise" value is missing.');
  const ids = new Set<string>();
  b.rules.forEach((r, i) => {
    const n = `Rule ${i + 1}`;
    if (!r || typeof r !== 'object') return void out.push(`${n} is not a rule.`);
    if (typeof r.id !== 'string' || !r.id.trim()) out.push(`${n} has no id.`);
    else if (ids.has(r.id)) out.push(`${n} repeats the id "${r.id}".`);
    else ids.add(r.id);
    if (!SCOPE_LADDER.includes(r.scope as RuleScope)) out.push(`${n} has an unknown scope "${String(r.scope)}".`);
    if (!Array.isArray(r.when)) out.push(`${n} has no conditions list.`);
    else
      r.when.forEach((c, j) => {
        if (!c || typeof c.field !== 'string' || !c.field.trim()) out.push(`${n}, condition ${j + 1} names no field.`);
        if (!OPS.includes(c?.op as ConditionOp)) out.push(`${n}, condition ${j + 1} has an unknown test "${String(c?.op)}".`);
        if (['gt', 'gte', 'lt', 'lte'].includes(String(c?.op)) && !isNum(c?.value)) out.push(`${n}, condition ${j + 1} compares with something that is not a number.`);
        if (['in', 'not_in'].includes(String(c?.op)) && !Array.isArray(c?.value)) out.push(`${n}, condition ${j + 1} needs a list.`);
      });
    if (r.then === undefined) out.push(`${n} has no THEN value.`);
    // A record rule must name its record, or it would apply to every record on the top rung.
    if (r.scope === 'record' && !(Array.isArray(r.when) && r.when.some((c) => c && c.field === 'record_id' && c.op === 'eq'))) {
      out.push(`${n} is for one record but does not name it (record_id = …).`);
    }
  });
  return out;
}
